import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import {
  SecretBrokerError,
  createSecretMaterial,
  parseSecretAccessContext,
  secretRefFingerprint,
  type SecretAccessContext,
  type SecretAuditOperation,
  type SecretAuditOutcome,
  type SecretAuditPhase,
  type SecretAuditRecord,
  type SecretBrokerCapabilities,
  type SecretMaterial,
  type SecretRef,
} from "@ai-dev-os/secrets";
import {
  WINDOWS_CREDENTIAL_BROKER_SCHEMA_VERSION,
  WINDOWS_CREDENTIAL_MAX_SECRET_BYTES,
  type WindowsCredentialBrokerOptions,
  type WindowsCredentialAbortSignal,
  type WindowsCredentialNativePort,
  type WindowsCredentialNativeReadResult,
  type WindowsCredentialNativeStatus,
  type WindowsCredentialSecretBroker,
  type WindowsCredentialTestingOptions,
} from "./contracts.js";
import {
  exactWindowsCredentialReference,
  parseWindowsCredentialReference,
  windowsCredentialTargetBinding,
} from "./target.js";

interface InternalOptions extends WindowsCredentialBrokerOptions {
  readonly native: WindowsCredentialNativePort;
  readonly onZero?: WindowsCredentialTestingOptions["onZero"];
}

const CAPABILITIES: SecretBrokerCapabilities = Object.freeze({
  resolve: true,
  availability: true,
  replace: false,
  revoke: false,
  versions: false,
  kinds: Object.freeze(["text"] as const),
});

function safeDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  path: string,
): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value)) {
      throw new SecretBrokerError("INVALID_REFERENCE", `${path} must be a plain data object.`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SecretBrokerError("INVALID_REFERENCE", `${path} must be a plain data object.`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string") || keys.length > allowedKeys.length) {
      throw new SecretBrokerError("INVALID_REFERENCE", `${path} has an invalid key set.`);
    }
    const names = keys as string[];
    if (names.some((key) => !allowedKeys.includes(key)) || requiredKeys.some((key) => !names.includes(key))) {
      throw new SecretBrokerError("INVALID_REFERENCE", `${path} has an invalid key set.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of names) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new SecretBrokerError("INVALID_REFERENCE", `${path} must contain data properties only.`);
      }
      output[key] = descriptor.value;
    }
    return Object.freeze(output);
  } catch (error) {
    if (error instanceof SecretBrokerError) throw error;
    throw new SecretBrokerError("INVALID_REFERENCE", `${path} could not be inspected safely.`);
  }
}

function callable(value: unknown, path: string): (...args: never[]) => unknown {
  if (typeof value !== "function") {
    throw new SecretBrokerError("INVALID_REFERENCE", `${path} must be a function.`);
  }
  return value as (...args: never[]) => unknown;
}

function dataMethod(value: object, name: string, path: string, allowPrototype: boolean): (...args: never[]) => unknown {
  try {
    const own = Object.getOwnPropertyDescriptor(value, name);
    if (own !== undefined) {
      if (!("value" in own)) throw new SecretBrokerError("INVALID_REFERENCE", `${path} must be a data method.`);
      return callable(own.value, path);
    }
    if (!allowPrototype) throw new SecretBrokerError("INVALID_REFERENCE", `${path} must be an own data method.`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null || types.isProxy(prototype)) throw new SecretBrokerError("INVALID_REFERENCE", `${path} is unavailable.`);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor === undefined || !("value" in descriptor)) throw new SecretBrokerError("INVALID_REFERENCE", `${path} must be a data method.`);
    return callable(descriptor.value, path);
  } catch (error) {
    if (error instanceof SecretBrokerError) throw error;
    throw new SecretBrokerError("INVALID_REFERENCE", `${path} could not be inspected safely.`);
  }
}

function parseClock(value: unknown): { now(): Date } {
  if (typeof value !== "object" || value === null || types.isProxy(value)) {
    throw new SecretBrokerError("INVALID_REFERENCE", "clock must be an exact clock object.");
  }
  const method = dataMethod(value, "now", "clock.now", true);
  return Object.freeze({ now: () => Reflect.apply(method, value, []) as Date });
}

function parseNative(value: unknown): WindowsCredentialNativePort {
  if (typeof value !== "object" || value === null || types.isProxy(value)) {
    throw new SecretBrokerError("INVALID_REFERENCE", "native must be an exact native port.");
  }
  const availabilityMethod = dataMethod(value, "availability", "native.availability", false) as unknown as WindowsCredentialNativePort["availability"];
  const readMethod = dataMethod(value, "read", "native.read", false) as unknown as WindowsCredentialNativePort["read"];
  return Object.freeze({
    availability: (targetName: string, signal?: WindowsCredentialAbortSignal) => Reflect.apply(availabilityMethod, value, [targetName, signal]) as ReturnType<WindowsCredentialNativePort["availability"]>,
    read: (targetName: string, signal?: WindowsCredentialAbortSignal) => Reflect.apply(readMethod, value, [targetName, signal]) as ReturnType<WindowsCredentialNativePort["read"]>,
  });
}

export function parseProductionOptions(value: unknown): WindowsCredentialBrokerOptions {
  const record = safeDataRecord(value, ["schemaVersion", "reference", "clock", "audit"], ["schemaVersion", "reference", "clock"], "options");
  if (record["schemaVersion"] !== WINDOWS_CREDENTIAL_BROKER_SCHEMA_VERSION) {
    throw new SecretBrokerError("INVALID_REFERENCE", "options.schemaVersion is unsupported.");
  }
  const reference = parseWindowsCredentialReference(record["reference"], "options.reference");
  const clock = parseClock(record["clock"]);
  const audit = record["audit"] === undefined ? undefined : callable(record["audit"], "options.audit") as WindowsCredentialBrokerOptions["audit"];
  return Object.freeze({ schemaVersion: WINDOWS_CREDENTIAL_BROKER_SCHEMA_VERSION, reference, clock, ...(audit === undefined ? {} : { audit }) });
}

export function parseTestingOptions(value: unknown): InternalOptions {
  const record = safeDataRecord(value, ["schemaVersion", "reference", "clock", "audit", "native", "onZero"], ["schemaVersion", "reference", "clock", "native"], "options");
  const base = parseProductionOptions(Object.freeze({
    schemaVersion: record["schemaVersion"],
    reference: record["reference"],
    clock: record["clock"],
    ...(record["audit"] === undefined ? {} : { audit: record["audit"] }),
  }));
  const native = parseNative(record["native"]);
  const onZero = record["onZero"] === undefined ? undefined : callable(record["onZero"], "options.onZero") as WindowsCredentialTestingOptions["onZero"];
  return Object.freeze({ ...base, native, ...(onZero === undefined ? {} : { onZero }) });
}

function finiteNow(clock: InternalOptions["clock"]): string {
  try {
    const value = clock.now();
    if (!(value instanceof Date) || types.isProxy(value) || Object.getPrototypeOf(value) !== Date.prototype || Object.getOwnPropertyDescriptor(value, "valueOf") !== undefined || Object.getOwnPropertyDescriptor(value, "toISOString") !== undefined) throw new Error("invalid-clock");
    const milliseconds = Reflect.apply(Date.prototype.valueOf, value, []) as number;
    if (!Number.isFinite(milliseconds)) throw new Error("invalid-clock");
    return Reflect.apply(Date.prototype.toISOString, value, []) as string;
  } catch {
    throw new SecretBrokerError("AUDIT_FAILURE", "The secret clock failed.");
  }
}

function isCancelled(signal: SecretAccessContext["signal"]): boolean {
  try { return signal?.aborted === true; }
  catch { throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The secret resolution cancellation state is unavailable."); }
}

function parseContext(value: SecretAccessContext, clock: InternalOptions["clock"]): SecretAccessContext {
  let context: SecretAccessContext;
  try { context = parseSecretAccessContext(value); }
  catch { throw new SecretBrokerError("INVALID_REFERENCE", "The secret access context is invalid."); }
  const now = finiteNow(clock);
  if (context.deadline !== null && now >= context.deadline) {
    throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The secret resolution deadline expired.");
  }
  if (isCancelled(context.signal)) {
    throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The secret resolution was cancelled.");
  }
  return context;
}

function validateUtf8(bytes: Uint8Array, length: number): boolean {
  let index = 0;
  while (index < length) {
    const first = bytes[index]!;
    if (first <= 0x7f) { index += 1; continue; }
    if (first >= 0xc2 && first <= 0xdf && index + 1 < length && (bytes[index + 1]! & 0xc0) === 0x80) { index += 2; continue; }
    if (first === 0xe0 && index + 2 < length && bytes[index + 1]! >= 0xa0 && bytes[index + 1]! <= 0xbf && (bytes[index + 2]! & 0xc0) === 0x80) { index += 3; continue; }
    if (((first >= 0xe1 && first <= 0xec) || (first >= 0xee && first <= 0xef)) && index + 2 < length && (bytes[index + 1]! & 0xc0) === 0x80 && (bytes[index + 2]! & 0xc0) === 0x80) { index += 3; continue; }
    if (first === 0xed && index + 2 < length && bytes[index + 1]! >= 0x80 && bytes[index + 1]! <= 0x9f && (bytes[index + 2]! & 0xc0) === 0x80) { index += 3; continue; }
    if (first === 0xf0 && index + 3 < length && bytes[index + 1]! >= 0x90 && bytes[index + 1]! <= 0xbf && (bytes[index + 2]! & 0xc0) === 0x80 && (bytes[index + 3]! & 0xc0) === 0x80) { index += 4; continue; }
    if (first >= 0xf1 && first <= 0xf3 && index + 3 < length && (bytes[index + 1]! & 0xc0) === 0x80 && (bytes[index + 2]! & 0xc0) === 0x80 && (bytes[index + 3]! & 0xc0) === 0x80) { index += 4; continue; }
    if (first === 0xf4 && index + 3 < length && bytes[index + 1]! >= 0x80 && bytes[index + 1]! <= 0x8f && (bytes[index + 2]! & 0xc0) === 0x80 && (bytes[index + 3]! & 0xc0) === 0x80) { index += 4; continue; }
    return false;
  }
  return true;
}

type ParsedAvailabilityResult = Readonly<{ status: WindowsCredentialNativeStatus }>;

const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  "byteLength",
)?.get;

function isZeroableByteView(value: unknown): value is Uint8Array {
  try { return typeof value === "object" && value !== null && !types.isProxy(value) && value instanceof Uint8Array; }
  catch { return false; }
}

function isSafeByteView(value: unknown): value is Uint8Array {
  try { return isZeroableByteView(value) && Object.getOwnPropertyDescriptor(value, "length") === undefined; }
  catch { return false; }
}

function byteLengthOf(value: Uint8Array): number {
  if (TYPED_ARRAY_BYTE_LENGTH === undefined) throw new Error("typed-array-byte-length-unavailable");
  return Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []) as number;
}

function zeroPossibleBytes(value: unknown): void {
  if (!isZeroableByteView(value)) return;
  try { Reflect.apply(Uint8Array.prototype.fill, value, [0]); }
  catch { /* an untrusted or detached view never reaches the caller */ }
}

function allBytesZero(value: Uint8Array): boolean {
  try { return Reflect.apply(Uint8Array.prototype.every, value, [(byte: number) => byte === 0]) as boolean; }
  catch { return false; }
}

function copyOwnedBytes(value: Uint8Array): Uint8Array {
  const owned = new Uint8Array(byteLengthOf(value));
  try {
    Reflect.apply(Uint8Array.prototype.set, owned, [value]);
    return owned;
  } catch (error) {
    zeroPossibleBytes(owned);
    throw error;
  }
}

function zeroOwnNativeBytes(value: unknown): void {
  zeroPossibleBytes(value);
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value)) return;
    const descriptor = Object.getOwnPropertyDescriptor(value, "bytes");
    if (descriptor === undefined || !("value" in descriptor) || types.isProxy(descriptor.value)) return;
    zeroPossibleBytes(descriptor.value);
  } catch { /* no untrusted reflection error may retain an accessible owned data buffer */ }
}

function nativeStatus(value: unknown, allowBytes: true): WindowsCredentialNativeReadResult;
function nativeStatus(value: unknown, allowBytes: false): ParsedAvailabilityResult;
function nativeStatus(value: unknown, allowBytes: boolean): WindowsCredentialNativeReadResult | ParsedAvailabilityResult {
  let record: Readonly<Record<string, unknown>>;
  try { record = safeDataRecord(value, ["status", "bytes"], ["status"], "nativeResult"); }
  catch {
    zeroOwnNativeBytes(value);
    throw new SecretBrokerError("MALFORMED_BACKEND_RESPONSE", "The Windows credential backend returned a malformed result.");
  }
  const status = record["status"];
  if (status !== "ok" && status !== "not-found" && status !== "access-denied" && status !== "unavailable" && status !== "malformed" && status !== "failure") {
    zeroPossibleBytes(record["bytes"]);
    throw new SecretBrokerError("MALFORMED_BACKEND_RESPONSE", "The Windows credential backend returned an invalid status.");
  }
  if (status === "ok") {
    if (!allowBytes) {
      if (record["bytes"] !== undefined) {
        zeroPossibleBytes(record["bytes"]);
        throw new SecretBrokerError("MALFORMED_BACKEND_RESPONSE", "The Windows credential availability backend returned unexpected material.");
      }
      return Object.freeze({ status });
    }
    const bytes = record["bytes"];
    if (!isSafeByteView(bytes)) {
      zeroPossibleBytes(bytes);
      throw new SecretBrokerError("MALFORMED_BACKEND_RESPONSE", "The Windows credential backend returned invalid secret material.");
    }
    let byteLength: number;
    try { byteLength = byteLengthOf(bytes); }
    catch {
      zeroPossibleBytes(bytes);
      throw new SecretBrokerError("MALFORMED_BACKEND_RESPONSE", "The Windows credential backend returned invalid secret material.");
    }
    if (byteLength < 1 || byteLength > WINDOWS_CREDENTIAL_MAX_SECRET_BYTES || !validateUtf8(bytes, byteLength)) {
      zeroPossibleBytes(bytes);
      throw new SecretBrokerError("MALFORMED_BACKEND_RESPONSE", "The Windows credential backend returned invalid secret material.");
    }
    return Object.freeze({ status, bytes });
  }
  if (record["bytes"] !== undefined) {
    zeroPossibleBytes(record["bytes"]);
    throw new SecretBrokerError("MALFORMED_BACKEND_RESPONSE", "The Windows credential backend returned unexpected material.");
  }
  return Object.freeze({ status });
}

function errorFor(status: Exclude<WindowsCredentialNativeStatus, "ok">): SecretBrokerError {
  switch (status) {
    case "not-found": return new SecretBrokerError("NOT_FOUND", "The Windows credential was not found.");
    case "access-denied": return new SecretBrokerError("ACCESS_DENIED", "Windows denied access to the credential.");
    case "unavailable": return new SecretBrokerError("UNAVAILABLE", "Windows Credential Manager is unavailable.");
    case "malformed": return new SecretBrokerError("MALFORMED_BACKEND_RESPONSE", "Windows Credential Manager returned malformed material.");
    case "failure": return new SecretBrokerError("BACKEND_FAILURE", "The Windows credential backend failed.");
  }
}

const BOUNDARY_ERROR_MESSAGES = Object.freeze({
  NOT_FOUND: "The Windows credential was not found.",
  UNAVAILABLE: "Windows Credential Manager is unavailable.",
  ACCESS_DENIED: "Windows denied access to the credential.",
  BROKER_CLOSED: "The Windows secret broker is closed.",
  RESOLUTION_TIMEOUT: "The Windows credential operation timed out or was cancelled.",
  BACKEND_FAILURE: "The Windows credential backend failed.",
  MALFORMED_BACKEND_RESPONSE: "The Windows credential backend returned malformed material.",
  KIND_MISMATCH: "The Windows credential kind did not match.",
  AUDIT_FAILURE: "The Windows credential audit or clock boundary failed.",
} as const);

type BoundaryErrorCode = keyof typeof BOUNDARY_ERROR_MESSAGES;

function finiteBoundaryError(error: unknown): SecretBrokerError {
  try {
    if (types.isProxy(error) || !(error instanceof SecretBrokerError)) throw new Error("untrusted-error");
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string" || !Object.hasOwn(BOUNDARY_ERROR_MESSAGES, descriptor.value)) {
      throw new Error("untrusted-error");
    }
    const code = descriptor.value as BoundaryErrorCode;
    return new SecretBrokerError(code, BOUNDARY_ERROR_MESSAGES[code]);
  } catch {
    return new SecretBrokerError("BACKEND_FAILURE", BOUNDARY_ERROR_MESSAGES.BACKEND_FAILURE);
  }
}

export function createWindowsCredentialSecretBrokerInternal(options: InternalOptions): WindowsCredentialSecretBroker {
  const allowedReference = parseWindowsCredentialReference(options.reference);
  const binding = windowsCredentialTargetBinding(allowedReference);
  const referenceAudit = `sha256:${binding.referenceFingerprint}`;
  let closed = false;
  let active = 0;
  let closePromise: Promise<void> | null = null;
  let waiters: Array<() => void> = [];
  const callbackScope = new AsyncLocalStorage<{ active: boolean }>();
  const auditHook = options.audit;
  const zeroHook = options.onZero;

  function notifyZero(stage: "native-copy" | "material-copy", bytes: Uint8Array): void {
    try {
      if (zeroHook !== undefined) Reflect.apply(zeroHook, undefined, [Object.freeze({ stage, byteLength: byteLengthOf(bytes), allZero: allBytesZero(bytes) })]);
    }
    catch { throw new SecretBrokerError("BACKEND_FAILURE", "The Windows credential testing zero hook failed."); }
  }

  function audit(operation: SecretAuditOperation, phase: SecretAuditPhase, outcome: SecretAuditOutcome | null, context: SecretAccessContext | null): SecretAuditRecord {
    const record = Object.freeze({
      schemaVersion: 1 as const,
      operation,
      phase,
      outcome,
      occurredAt: finiteNow(options.clock),
      reference: operation === "close" ? null : referenceAudit,
      operationId: context?.operationId ?? null,
      providerInstanceId: context?.providerInstanceId ?? null,
      purpose: context?.purpose ?? null,
      traceId: context?.trace.traceId ?? null,
    });
    try { if (auditHook !== undefined) Reflect.apply(auditHook, undefined, [record]); }
    catch { throw new SecretBrokerError("AUDIT_FAILURE", "The secret audit hook failed.", { operation }); }
    return record;
  }

  function assertOpen(): void {
    if (closed) throw new SecretBrokerError("BROKER_CLOSED", "The Windows secret broker is closed.");
  }

  function bind(rawRef: SecretRef, rawContext: SecretAccessContext): { reference: typeof allowedReference; context: SecretAccessContext } {
    let reference: typeof allowedReference;
    try { reference = parseWindowsCredentialReference(rawRef); }
    catch (error) { if (error instanceof SecretBrokerError) throw error; throw new SecretBrokerError("INVALID_REFERENCE", "The secret reference is invalid."); }
    if (!exactWindowsCredentialReference(reference, allowedReference)) {
      throw new SecretBrokerError("ACCESS_DENIED", "The secret reference is not allowlisted.");
    }
    const context = parseContext(rawContext, options.clock);
    if (context.accessForm !== "text" || context.providerInstanceId !== reference.providerInstanceId) {
      throw new SecretBrokerError("ACCESS_DENIED", "The secret access context does not match the allowlisted reference.");
    }
    return { reference, context };
  }

  function enter(): void { active += 1; }
  function leave(): void {
    active -= 1;
    if (active === 0) { const current = waiters; waiters = []; for (const resolve of current) resolve(); }
  }
  async function awaitIdle(): Promise<void> {
    if (active === 0) return;
    await new Promise<void>((resolve) => { waiters.push(resolve); });
  }
  function postBoundary(context: SecretAccessContext): void {
    const now = finiteNow(options.clock);
    if (context.deadline !== null && now >= context.deadline) throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The secret resolution deadline expired.");
    if (isCancelled(context.signal)) throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The secret resolution was cancelled.");
  }
  function assertBoundaryEntry(context: SecretAccessContext): void {
    assertOpen();
    postBoundary(context);
  }
  function auditFailure(operation: "availability" | "resolve", context: SecretAccessContext, error: unknown): never {
    const finite = finiteBoundaryError(error);
    const outcome: SecretAuditOutcome = finite.code === "NOT_FOUND" ? "not-found" : finite.code === "ACCESS_DENIED" || finite.code === "KIND_MISMATCH" ? "denied" : "failure";
    audit(operation, "outcome", outcome, context);
    throw finite;
  }

  const broker: WindowsCredentialSecretBroker = {
    describeCapabilities: () => CAPABILITIES,
    describeTargetBinding: () => binding,
    async availability(rawRef, rawContext) {
      assertOpen();
      enter();
      try {
        const { context } = bind(rawRef, rawContext);
        audit("availability", "attempt", null, context);
        let raw: unknown;
        try { assertBoundaryEntry(context); raw = await options.native.availability(binding.targetName, context.signal); postBoundary(context); }
        catch (error) { zeroOwnNativeBytes(raw); zeroOwnNativeBytes(error); return auditFailure("availability", context, error); }
        let result: ParsedAvailabilityResult;
        try { result = nativeStatus(raw, false); }
        catch (error) { return auditFailure("availability", context, error); }
        const outcome: SecretAuditOutcome = result.status === "ok" ? "success" : result.status === "not-found" ? "not-found" : result.status === "access-denied" ? "denied" : "failure";
        const auditRecord = audit("availability", "outcome", outcome, context);
        return Object.freeze({ available: result.status === "ok", reason: result.status === "ok" ? "available" as const : result.status === "not-found" ? "not-found" as const : "unavailable" as const, audit: auditRecord });
      } finally { leave(); }
    },
    async withSecret<T>(rawRef: SecretRef, rawContext: SecretAccessContext, callback: (secret: SecretMaterial) => T | Promise<T>) {
      assertOpen();
      if (typeof callback !== "function") throw new SecretBrokerError("INVALID_REFERENCE", "The secret consumer callback is invalid.");
      enter();
      let material: ReturnType<typeof createSecretMaterial> | null = null;
      let result: WindowsCredentialNativeReadResult | null = null;
      try {
        const { context } = bind(rawRef, rawContext);
        audit("resolve", "attempt", null, context);
        try { assertBoundaryEntry(context); result = nativeStatus(await options.native.read(binding.targetName, context.signal), true); postBoundary(context); }
        catch (error) {
          zeroOwnNativeBytes(error);
          if (result?.status === "ok") {
            zeroPossibleBytes(result.bytes);
            try { notifyZero("native-copy", result.bytes); }
            catch { /* preserve the primary boundary failure and still audit it */ }
          }
          return auditFailure("resolve", context, error);
        }
        if (result.status !== "ok") return auditFailure("resolve", context, errorFor(result.status));
        const nativeBytes = result.bytes;
        let owned: Uint8Array | null = null;
        let acquisitionError: unknown = null;
        try {
          owned = copyOwnedBytes(nativeBytes);
        } catch (error) {
          acquisitionError = error;
        }
        finally {
          zeroPossibleBytes(nativeBytes);
          try { notifyZero("native-copy", nativeBytes); }
          catch (error) { acquisitionError ??= error; }
        }
        if (acquisitionError !== null) {
          if (owned !== null) {
            zeroPossibleBytes(owned);
            try { notifyZero("material-copy", owned); }
            catch { /* retain the first finite acquisition failure */ }
          }
          return auditFailure("resolve", context, acquisitionError);
        }
        try {
          material = createSecretMaterial("text", owned!);
        } catch (error) {
          zeroPossibleBytes(owned!);
          try { notifyZero("material-copy", owned!); }
          catch { /* retain the material-construction failure */ }
          return auditFailure("resolve", context, error);
        }
        try {
          zeroPossibleBytes(owned!);
          notifyZero("material-copy", owned!);
        } catch (error) {
          return auditFailure("resolve", context, error);
        }
        let value: T;
        const scope = { active: true };
        try { value = await callbackScope.run(scope, async () => callback(material!)); }
        catch {
          material.dispose();
          material = null;
          audit("resolve", "outcome", "failure", context);
          throw new SecretBrokerError("CONSUMER_FAILURE", "The secret consumer callback failed.");
        } finally { scope.active = false; }
        material.dispose();
        material = null;
        audit("resolve", "outcome", "success", context);
        return value;
      } finally { material?.dispose(); leave(); }
    },
    async replace(rawRef, _material, rawContext) {
      assertOpen(); enter();
      try {
        const { context } = bind(rawRef, rawContext);
        audit("replace", "attempt", null, context); audit("replace", "outcome", "unsupported", context);
        throw new SecretBrokerError("UNSUPPORTED_OPERATION", "The Windows broker does not replace credentials.");
      } finally { leave(); }
    },
    async revoke(rawRef, rawContext) {
      assertOpen(); enter();
      try {
        const { context } = bind(rawRef, rawContext);
        audit("revoke", "attempt", null, context); audit("revoke", "outcome", "unsupported", context);
        throw new SecretBrokerError("UNSUPPORTED_OPERATION", "The Windows broker does not revoke credentials.");
      } finally { leave(); }
    },
    async close() {
      if (callbackScope.getStore()?.active === true) {
        throw new SecretBrokerError("UNSUPPORTED_OPERATION", "The Windows secret broker cannot close from inside an active secret callback.");
      }
      if (closePromise !== null) return closePromise;
      closed = true;
      let resolveClose!: () => void;
      let rejectClose!: (error: unknown) => void;
      closePromise = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
      void (async () => {
        let closeError: unknown = null;
        try { audit("close", "attempt", null, null); }
        catch (error) { closeError = error; }
        try { await awaitIdle(); }
        catch (error) { closeError ??= error; }
        if (closeError === null) {
          try { audit("close", "outcome", "closed", null); }
          catch (error) { closeError = error; }
        }
        if (closeError === null) resolveClose();
        else rejectClose(closeError);
      })();
      return closePromise;
    },
    toString: () => "[WindowsCredentialSecretBroker]",
    toJSON: () => Object.freeze({ broker: "windows-credential", reference: referenceAudit, capabilities: CAPABILITIES }),
    [Symbol.for("nodejs.util.inspect.custom")]: () => "[WindowsCredentialSecretBroker]",
  } as WindowsCredentialSecretBroker;
  return Object.freeze(broker);
}

export function createWindowsCredentialSecretBrokerForTesting(rawOptions: unknown): WindowsCredentialSecretBroker {
  return createWindowsCredentialSecretBrokerInternal(parseTestingOptions(rawOptions));
}
