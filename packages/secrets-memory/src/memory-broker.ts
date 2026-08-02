import {
  SecretBrokerError,
  createSecretMaterial,
  parseSecretAccessContext,
  parseSecretRef,
  secretRefDisplay,
  serializeSecretRef,
  type SecretAccessContext,
  type SecretAuditHook,
  type SecretAuditOperation,
  type SecretAuditOutcome,
  type SecretAuditPhase,
  type SecretAuditRecord,
  type SecretBroker,
  type SecretBrokerCapabilities,
  type SecretClock,
  type SecretKind,
  type SecretRef,
} from "@ai-dev-os/secrets";

export interface MemorySecretSeed {
  readonly ref: SecretRef;
  readonly material: { readonly kind: "text"; readonly text: string } | { readonly kind: "bytes"; readonly bytes: Uint8Array };
  readonly access?: "allowed" | "denied";
  readonly revoked?: boolean;
}
export interface MemorySecretBrokerOptions {
  readonly entries?: readonly MemorySecretSeed[];
  readonly clock: SecretClock;
  readonly audit?: SecretAuditHook;
  readonly onZero?: (record: { readonly reason: "replace" | "revoke" | "close"; readonly byteLength: number; readonly allZero: boolean }) => void;
}
export interface MemorySecretBroker extends SecretBroker {
  readonly operationCounts: Readonly<Record<"availability" | "resolve" | "replace" | "revoke" | "close", number>>;
}
interface StoredEntry { readonly ref: SecretRef; readonly kind: SecretKind; readonly bytes: Uint8Array; readonly access: "allowed" | "denied"; revoked: boolean }

function identity(ref: SecretRef): string { return serializeSecretRef({ ...ref, version: null, expectedKind: "text", providerInstanceId: null } as SecretRef); }
function ownedBytes(seed: MemorySecretSeed["material"]): Uint8Array { return seed.kind === "text" ? new TextEncoder().encode(seed.text) : new Uint8Array(seed.bytes); }
function validateReplacement(material: { readonly kind: SecretKind; readonly text?: string; readonly bytes?: Uint8Array }): Uint8Array {
  if (material.kind === "text" && typeof material.text === "string" && material.bytes === undefined) return new TextEncoder().encode(material.text);
  if (material.kind === "bytes" && material.bytes instanceof Uint8Array && material.text === undefined) return new Uint8Array(material.bytes);
  throw new SecretBrokerError("MALFORMED_BACKEND_RESPONSE", "Replacement material does not match its declared kind.");
}

export function createMemorySecretBroker(options: MemorySecretBrokerOptions): MemorySecretBroker {
  const entries = new Map<string, StoredEntry>();
  for (const [index, seed] of (options.entries ?? []).entries()) {
    const ref = parseSecretRef(seed.ref, `entries[${index}].ref`);
    if (ref.expectedKind !== seed.material.kind) throw new SecretBrokerError("KIND_MISMATCH", "Seed material kind does not match its reference.", { entryIndex: index });
    const key = identity(ref);
    if (entries.has(key)) throw new SecretBrokerError("MALFORMED_BACKEND_RESPONSE", "Memory secret identifiers must be unique.", { entryIndex: index });
    entries.set(key, { ref, kind: seed.material.kind, bytes: ownedBytes(seed.material), access: seed.access ?? "allowed", revoked: seed.revoked ?? false });
  }
  const counts = { availability: 0, resolve: 0, replace: 0, revoke: 0, close: 0 };
  let closed = false;
  let active = 0;
  let closeWaiters: Array<() => void> = [];

  function audit(operation: SecretAuditOperation, phase: SecretAuditPhase, outcome: SecretAuditOutcome | null, ref: SecretRef | null, context: SecretAccessContext | null): SecretAuditRecord {
    const record = Object.freeze({ schemaVersion: 1 as const, operation, phase, outcome, occurredAt: options.clock.now().toISOString(), reference: ref === null ? null : secretRefDisplay(ref), operationId: context?.operationId ?? null, providerInstanceId: context?.providerInstanceId ?? null, purpose: context?.purpose ?? null, traceId: context?.trace.traceId ?? null });
    try { options.audit?.(record); }
    catch (error) { throw new SecretBrokerError("AUDIT_FAILURE", "The secret audit hook failed.", { operation }, error instanceof Error ? error.name : typeof error); }
    return record;
  }
  function assertOpen(): void { if (closed) throw new SecretBrokerError("BROKER_CLOSED", "The secret broker is closed."); }
  function zero(entry: StoredEntry, reason: "replace" | "revoke" | "close"): void { const length = entry.bytes.byteLength; entry.bytes.fill(0); options.onZero?.(Object.freeze({ reason, byteLength: length, allZero: entry.bytes.every((byte) => byte === 0) })); }
  function lookup(rawRef: SecretRef): { readonly ref: SecretRef; readonly entry: StoredEntry } {
    const ref = parseSecretRef(rawRef);
    const entry = entries.get(identity(ref));
    if (entry === undefined) throw new SecretBrokerError("NOT_FOUND", "The secret reference was not found.", { referenceType: ref.type });
    if (ref.version !== null && entry.ref.version !== ref.version) throw new SecretBrokerError("VERSION_UNAVAILABLE", "The requested secret version is unavailable.", { referenceType: ref.type });
    if (entry.revoked) throw new SecretBrokerError("REVOKED", "The secret reference is revoked.", { referenceType: ref.type });
    if (entry.access === "denied") throw new SecretBrokerError("ACCESS_DENIED", "Access to the secret reference was denied.", { referenceType: ref.type });
    if (entry.kind !== ref.expectedKind) throw new SecretBrokerError("KIND_MISMATCH", "The secret kind does not match the reference.", { referenceType: ref.type });
    return { ref, entry };
  }
  function contextOf(raw: SecretAccessContext): SecretAccessContext {
    const context = parseSecretAccessContext(raw);
    if (context.deadline !== null && options.clock.now().toISOString() >= context.deadline) throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The secret resolution deadline expired.");
    if (context.signal?.aborted === true) throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The secret resolution was cancelled.");
    return context;
  }
  function auditFailure(operation: SecretAuditOperation, ref: SecretRef, context: SecretAccessContext, error: unknown): void {
    const outcome: SecretAuditOutcome = error instanceof SecretBrokerError && error.code === "REVOKED" ? "revoked" : error instanceof SecretBrokerError && (error.code === "NOT_FOUND" || error.code === "VERSION_UNAVAILABLE") ? "not-found" : error instanceof SecretBrokerError && (error.code === "ACCESS_DENIED" || error.code === "KIND_MISMATCH") ? "denied" : "failure";
    audit(operation, "outcome", outcome, ref, context);
  }

  const capabilities: SecretBrokerCapabilities = Object.freeze({ resolve: true, availability: true, replace: true, revoke: true, versions: true, kinds: Object.freeze(["bytes", "text"] as const) });
  const broker: MemorySecretBroker = {
    get operationCounts() { return Object.freeze({ ...counts }); },
    describeCapabilities(): SecretBrokerCapabilities { return capabilities; },
    async availability(rawRef, rawContext) {
      assertOpen(); counts.availability += 1;
      const ref = parseSecretRef(rawRef); const context = contextOf(rawContext);
      audit("availability", "attempt", null, ref, context);
      try { lookup(ref); return Object.freeze({ available: true, reason: "available" as const, audit: audit("availability", "outcome", "success", ref, context) }); }
      catch (error) {
        if (!(error instanceof SecretBrokerError)) throw error;
        const reason = error.code === "NOT_FOUND" ? "not-found" : error.code === "REVOKED" ? "revoked" : error.code === "VERSION_UNAVAILABLE" ? "version-unavailable" : "unavailable";
        return Object.freeze({ available: false, reason, audit: audit("availability", "outcome", error.code === "REVOKED" ? "revoked" : error.code === "NOT_FOUND" || error.code === "VERSION_UNAVAILABLE" ? "not-found" : "failure", ref, context) });
      }
    },
    async withSecret<T>(rawRef: SecretRef, rawContext: SecretAccessContext, callback: (secret: import("@ai-dev-os/secrets").SecretMaterial) => T | Promise<T>): Promise<T> {
      assertOpen(); counts.resolve += 1;
      const context = contextOf(rawContext); const ref = parseSecretRef(rawRef);
      audit("resolve", "attempt", null, ref, context);
      let entry: StoredEntry;
      try { ({ entry } = lookup(ref)); }
      catch (error) { auditFailure("resolve", ref, context, error); throw error; }
      if (context.accessForm !== entry.kind || (ref.providerInstanceId !== null && ref.providerInstanceId !== context.providerInstanceId)) { audit("resolve", "outcome", "denied", ref, context); throw new SecretBrokerError("ACCESS_DENIED", "The secret access context does not match the reference."); }
      const material = createSecretMaterial(entry.kind, entry.bytes);
      active += 1;
      try {
        let value: T;
        try { value = await callback(material); }
        catch (error) {
          audit("resolve", "outcome", "failure", ref, context);
          throw new SecretBrokerError("CONSUMER_FAILURE", "The secret consumer callback failed.", {}, error instanceof Error ? error.name : typeof error);
        }
        audit("resolve", "outcome", "success", ref, context);
        return value;
      } finally {
        material.dispose(); active -= 1;
        if (active === 0) { const waiters = closeWaiters; closeWaiters = []; for (const wake of waiters) wake(); }
      }
    },
    async replace(rawRef, replacement, rawContext) {
      assertOpen(); counts.replace += 1;
      const context = contextOf(rawContext); const ref = parseSecretRef(rawRef); const key = identity(ref);
      audit("replace", "attempt", null, ref, context);
      let next: Uint8Array;
      try { next = validateReplacement(replacement); }
      catch (error) { auditFailure("replace", ref, context, error); throw error; }
      if (replacement.kind !== ref.expectedKind) { next.fill(0); audit("replace", "outcome", "denied", ref, context); throw new SecretBrokerError("KIND_MISMATCH", "Replacement kind does not match the reference."); }
      const previous = entries.get(key); if (previous !== undefined) zero(previous, "replace");
      entries.set(key, { ref, kind: replacement.kind, bytes: next, access: "allowed", revoked: false });
      return audit("replace", "outcome", "success", ref, context);
    },
    async revoke(rawRef, rawContext) {
      assertOpen(); counts.revoke += 1;
      const context = contextOf(rawContext); const ref = parseSecretRef(rawRef);
      audit("revoke", "attempt", null, ref, context);
      let entry: StoredEntry;
      try { ({ entry } = lookup(ref)); }
      catch (error) { auditFailure("revoke", ref, context, error); throw error; }
      zero(entry, "revoke"); entry.revoked = true;
      return audit("revoke", "outcome", "success", ref, context);
    },
    async close() {
      if (closed) return;
      audit("close", "attempt", null, null, null);
      closed = true; counts.close += 1;
      for (const entry of [...entries.values()].sort((a, b) => secretRefDisplay(a.ref).localeCompare(secretRefDisplay(b.ref)))) zero(entry, "close");
      entries.clear();
      if (active > 0) await new Promise<void>((resolve) => { closeWaiters.push(resolve); });
      audit("close", "outcome", "closed", null, null);
    },
  };
  return Object.freeze(broker);
}
