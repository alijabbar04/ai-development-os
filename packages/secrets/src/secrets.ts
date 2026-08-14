import { createHash } from "node:crypto";
import { types } from "node:util";
import { toCanonicalJson, validation, type DataClassification } from "@ai-dev-os/domain";
import { DATA_CLASSIFICATIONS } from "@ai-dev-os/domain";
import { parseExecutionTraceMetadata, type AbortSignalLike, type ExecutionTraceMetadata } from "@ai-dev-os/providers";
import { parsePolicyRequest, type PolicyBroker, type PolicyRequest } from "@ai-dev-os/policy";

const { ensureArray, ensureEnum, ensureExactKeys, ensureNullable, ensureRecord, ensureSafeInteger, ensureSchemaVersion, ensureString, ensureTimestamp, fail } = validation;
export const SECRET_REF_SCHEMA_VERSION = 1 as const;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const SECRET_REF_TYPES = Object.freeze(["named", "environment", "keychain", "encrypted-file", "external-vault"] as const);
export type SecretRefType = (typeof SECRET_REF_TYPES)[number];
export const SECRET_KINDS = Object.freeze(["text", "bytes"] as const);
export type SecretKind = (typeof SECRET_KINDS)[number];

interface SecretRefBase {
  readonly schemaVersion: typeof SECRET_REF_SCHEMA_VERSION;
  readonly type: SecretRefType;
  readonly namespace: string;
  readonly version: string | null;
  readonly expectedKind: SecretKind;
  readonly providerInstanceId: string | null;
}
export type SecretRef =
  | (SecretRefBase & { readonly type: "named"; readonly name: string })
  | (SecretRefBase & { readonly type: "environment"; readonly variableName: string })
  | (SecretRefBase & { readonly type: "keychain"; readonly service: string; readonly account: string })
  | (SecretRefBase & { readonly type: "encrypted-file"; readonly containerId: string; readonly entryName: string })
  | (SecretRefBase & { readonly type: "external-vault"; readonly vaultNamespace: string; readonly pathSegments: readonly string[]; readonly entryName: string });

function commonRef(record: Record<string, unknown>, path: string): Omit<SecretRefBase, "type"> {
  return {
    schemaVersion: SECRET_REF_SCHEMA_VERSION,
    namespace: ensureString(record["namespace"], `${path}.namespace`, { maxLength: 32, pattern: NAMESPACE_PATTERN, patternName: "secret namespace" }),
    version: ensureNullable(record["version"], (raw) => ensureString(raw, `${path}.version`, { maxLength: 64, pattern: ID_PATTERN, patternName: "secret version" })),
    expectedKind: ensureEnum(record["expectedKind"], `${path}.expectedKind`, SECRET_KINDS),
    providerInstanceId: ensureNullable(record["providerInstanceId"], (raw) => ensureString(raw, `${path}.providerInstanceId`, { maxLength: 128, pattern: ID_PATTERN, patternName: "provider instance id" })),
  };
}

export function parseSecretRef(value: unknown, path = "secretRef"): SecretRef {
  const record = ensureRecord(value, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, SECRET_REF_SCHEMA_VERSION);
  const type = ensureEnum(record["type"], `${path}.type`, SECRET_REF_TYPES);
  const shared = commonRef(record, path);
  switch (type) {
    case "named":
      ensureExactKeys(record, ["schemaVersion", "type", "namespace", "version", "expectedKind", "providerInstanceId", "name"], path);
      return Object.freeze({ ...shared, type, name: ensureString(record["name"], `${path}.name`, { maxLength: 128, pattern: NAME_PATTERN, patternName: "secret name" }) });
    case "environment":
      ensureExactKeys(record, ["schemaVersion", "type", "namespace", "version", "expectedKind", "providerInstanceId", "variableName"], path);
      if (shared.expectedKind !== "text") fail(`${path}.expectedKind`, "environment_text_only", "environment references support text secrets only.");
      return Object.freeze({ ...shared, type, variableName: ensureString(record["variableName"], `${path}.variableName`, { maxLength: 128, pattern: ENV_PATTERN, patternName: "environment variable name" }) });
    case "keychain":
      ensureExactKeys(record, ["schemaVersion", "type", "namespace", "version", "expectedKind", "providerInstanceId", "service", "account"], path);
      return Object.freeze({ ...shared, type, service: ensureString(record["service"], `${path}.service`, { maxLength: 128, pattern: NAME_PATTERN, patternName: "keychain service" }), account: ensureString(record["account"], `${path}.account`, { maxLength: 128, pattern: NAME_PATTERN, patternName: "keychain account" }) });
    case "encrypted-file":
      ensureExactKeys(record, ["schemaVersion", "type", "namespace", "version", "expectedKind", "providerInstanceId", "containerId", "entryName"], path);
      return Object.freeze({ ...shared, type, containerId: ensureString(record["containerId"], `${path}.containerId`, { maxLength: 128, pattern: ID_PATTERN, patternName: "container id" }), entryName: ensureString(record["entryName"], `${path}.entryName`, { maxLength: 128, pattern: NAME_PATTERN, patternName: "entry name" }) });
    case "external-vault": {
      ensureExactKeys(record, ["schemaVersion", "type", "namespace", "version", "expectedKind", "providerInstanceId", "vaultNamespace", "pathSegments", "entryName"], path);
      const segments = ensureArray(record["pathSegments"], `${path}.pathSegments`, 16).map((item, index) => ensureString(item, `${path}.pathSegments[${index}]`, { maxLength: 64, pattern: NAME_PATTERN, patternName: "vault path segment" }));
      if (segments.length === 0) fail(`${path}.pathSegments`, "empty_path", "must contain at least one logical path segment.");
      return Object.freeze({ ...shared, type, vaultNamespace: ensureString(record["vaultNamespace"], `${path}.vaultNamespace`, { maxLength: 64, pattern: NAMESPACE_PATTERN, patternName: "vault namespace" }), pathSegments: Object.freeze(segments), entryName: ensureString(record["entryName"], `${path}.entryName`, { maxLength: 128, pattern: NAME_PATTERN, patternName: "vault entry" }) });
    }
  }
}

export function secretRefDisplay(ref: SecretRef): string {
  const parsed = parseSecretRef(ref);
  const suffix = parsed.type === "named" ? parsed.name : parsed.type === "environment" ? parsed.variableName : parsed.type === "keychain" ? `${parsed.service}/${parsed.account}` : parsed.type === "encrypted-file" ? `${parsed.containerId}/${parsed.entryName}` : `${parsed.vaultNamespace}/${parsed.pathSegments.join("/")}/${parsed.entryName}`;
  return `${parsed.type}:${parsed.namespace}:${suffix}${parsed.version === null ? "" : `@${parsed.version}`}:[${parsed.expectedKind}]`;
}
export function serializeSecretRef(ref: SecretRef): string { return toCanonicalJson(parseSecretRef(ref)); }
export function secretRefFingerprint(ref: SecretRef): string { return createHash("sha256").update(serializeSecretRef(ref)).digest("hex"); }

export const SECRET_BROKER_ERROR_CODES = Object.freeze(["INVALID_REFERENCE", "NOT_FOUND", "UNAVAILABLE", "ACCESS_DENIED", "VERSION_UNAVAILABLE", "UNSUPPORTED_OPERATION", "EXPIRED", "REVOKED", "BROKER_CLOSED", "RESOLUTION_TIMEOUT", "BACKEND_FAILURE", "MALFORMED_BACKEND_RESPONSE", "CONSUMER_FAILURE", "KIND_MISMATCH", "MATERIAL_DISPOSED", "AUDIT_FAILURE"] as const);
export type SecretBrokerErrorCode = (typeof SECRET_BROKER_ERROR_CODES)[number];
export class SecretBrokerError extends Error {
  readonly code: SecretBrokerErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
  readonly causeCategory: string | null;
  constructor(code: SecretBrokerErrorCode, message: string, details: SecretBrokerError["details"] = {}, causeCategory: string | null = null) { super(message); this.name = "SecretBrokerError"; this.code = code; this.details = Object.freeze({ ...details }); this.causeCategory = causeCategory; }
  toJSON(): object { return { name: this.name, code: this.code, message: this.message, details: this.details, causeCategory: this.causeCategory }; }
}

interface MaterialState { readonly kind: SecretKind; readonly bytes: Uint8Array; disposed: boolean }
const materialState = new WeakMap<object, MaterialState>();
export interface SecretMaterial {
  readonly kind: SecretKind;
  useText<T>(consumer: (text: string) => T | Promise<T>): Promise<T>;
  useBytes<T>(consumer: (bytes: Uint8Array) => T | Promise<T>): Promise<T>;
  toString(): string;
  toJSON(): string;
}

export function createSecretMaterial(kind: SecretKind, ownedBytes: Uint8Array): SecretMaterial & { dispose(): void } {
  const bytes = new Uint8Array(ownedBytes);
  const view = {
    get kind(): SecretKind { return state().kind; },
    async useText<T>(consumer: (text: string) => T | Promise<T>): Promise<T> {
      const current = state();
      if (current.kind !== "text") throw new SecretBrokerError("KIND_MISMATCH", "Secret material is not text.");
      const copy = new Uint8Array(current.bytes);
      try { return await consumer(new TextDecoder("utf-8", { fatal: true }).decode(copy)); }
      finally { copy.fill(0); }
    },
    async useBytes<T>(consumer: (value: Uint8Array) => T | Promise<T>): Promise<T> {
      const current = state();
      if (current.kind !== "bytes") throw new SecretBrokerError("KIND_MISMATCH", "Secret material is not bytes.");
      const copy = new Uint8Array(current.bytes);
      try { return await consumer(copy); }
      finally { copy.fill(0); }
    },
    dispose(): void { const current = materialState.get(view); if (current !== undefined && !current.disposed) { current.bytes.fill(0); current.disposed = true; } },
    toString(): string { return "[REDACTED SECRET]"; },
    toJSON(): string { return "[REDACTED SECRET]"; },
    [Symbol.for("nodejs.util.inspect.custom")](): string { return "[REDACTED SECRET]"; },
  };
  function state(): MaterialState { const current = materialState.get(view); if (current === undefined || current.disposed) throw new SecretBrokerError("MATERIAL_DISPOSED", "Secret material is no longer accessible."); return current; }
  materialState.set(view, { kind, bytes, disposed: false });
  return Object.freeze(view);
}

const SECRET_KEY_PATTERN = /^(?:api[-_]?key|password|passphrase|token|access[-_]?token|secret|secret[-_]?value|credential)$/i;
export function containsSecretLikeKey(value: unknown, maxDepth = 12): boolean {
  const seen = new WeakSet<object>();
  function walk(item: unknown, depth: number): boolean {
    if (depth > maxDepth) return true;
    if (typeof item !== "object" || item === null) return false;
    if (seen.has(item)) return true;
    seen.add(item);
    try {
      if (Array.isArray(item)) return item.some((entry) => walk(entry, depth + 1));
      const record = ensureRecord(item, "configuration");
      return Object.keys(record).some((key) => SECRET_KEY_PATTERN.test(key) || walk(record[key], depth + 1));
    } finally { seen.delete(item); }
  }
  return walk(value, 0);
}

export function redactSecretText(value: unknown): string { return typeof value === "string" && value.length === 0 ? "[REDACTED SECRET:EMPTY]" : "[REDACTED SECRET]"; }

export const SECRET_PURPOSES = Object.freeze(["provider-authentication", "tool-authentication", "artifact-encryption", "persistence-encryption", "plugin-authentication"] as const);
export type SecretPurpose = (typeof SECRET_PURPOSES)[number];
export const SECRET_ACCESS_FORMS = Object.freeze(["text", "bytes"] as const);
export type SecretAccessForm = (typeof SECRET_ACCESS_FORMS)[number];
export interface SecretAccessContext {
  readonly operationId: string;
  readonly providerInstanceId: string | null;
  readonly purpose: SecretPurpose;
  readonly requestedLifetimeMs: number;
  readonly accessForm: SecretAccessForm;
  readonly classification: DataClassification;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly approvalEvidenceRefs: readonly string[];
  readonly disclosureDecisionFingerprint: string | null;
  readonly locality: "local" | "cloud";
  readonly trace: ExecutionTraceMetadata;
  readonly deadline: string | null;
  readonly signal?: AbortSignalLike;
}

export function parseSecretAccessContext(value: unknown, path = "secretAccessContext"): SecretAccessContext {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["operationId", "providerInstanceId", "purpose", "requestedLifetimeMs", "accessForm", "classification", "projectId", "taskId", "approvalEvidenceRefs", "disclosureDecisionFingerprint", "locality", "trace", "deadline", "signal"], path);
  const refs = ensureArray(record["approvalEvidenceRefs"], `${path}.approvalEvidenceRefs`, 32).map((item, index) => ensureString(item, `${path}.approvalEvidenceRefs[${index}]`, { maxLength: 128, pattern: ID_PATTERN, patternName: "approval evidence reference" })).sort();
  if (new Set(refs).size !== refs.length) fail(`${path}.approvalEvidenceRefs`, "duplicate_reference", "must not contain duplicates.");
  const signal = record["signal"];
  if (signal !== undefined && (typeof signal !== "object" || signal === null || !("aborted" in signal) || !("addEventListener" in signal) || typeof (signal as { addEventListener?: unknown }).addEventListener !== "function")) {
    fail(`${path}.signal`, "invalid_signal", "must be an AbortSignal-compatible object.");
  }
  const parsed: SecretAccessContext = {
    operationId: ensureString(record["operationId"], `${path}.operationId`, { maxLength: 128, pattern: ID_PATTERN, patternName: "operation id" }),
    providerInstanceId: ensureNullable(record["providerInstanceId"], (raw) => ensureString(raw, `${path}.providerInstanceId`, { maxLength: 128, pattern: ID_PATTERN, patternName: "provider instance id" })),
    purpose: ensureEnum(record["purpose"], `${path}.purpose`, SECRET_PURPOSES),
    requestedLifetimeMs: ensureSafeInteger(record["requestedLifetimeMs"], `${path}.requestedLifetimeMs`, 1, 3_600_000),
    accessForm: ensureEnum(record["accessForm"], `${path}.accessForm`, SECRET_ACCESS_FORMS),
    classification: ensureEnum(record["classification"], `${path}.classification`, DATA_CLASSIFICATIONS),
    projectId: ensureNullable(record["projectId"], (raw) => ensureString(raw, `${path}.projectId`, { maxLength: 128, pattern: ID_PATTERN, patternName: "project id" })),
    taskId: ensureNullable(record["taskId"], (raw) => ensureString(raw, `${path}.taskId`, { maxLength: 128, pattern: ID_PATTERN, patternName: "task id" })),
    approvalEvidenceRefs: Object.freeze(refs),
    disclosureDecisionFingerprint: ensureNullable(record["disclosureDecisionFingerprint"], (raw) => ensureString(raw, `${path}.disclosureDecisionFingerprint`, { maxLength: 64, pattern: /^[a-f0-9]{64}$/, patternName: "decision fingerprint" })),
    locality: ensureEnum(record["locality"], `${path}.locality`, ["local", "cloud"] as const),
    trace: parseExecutionTraceMetadata(record["trace"], `${path}.trace`),
    deadline: ensureNullable(record["deadline"], (raw) => ensureTimestamp(raw, `${path}.deadline`)),
    ...(signal === undefined ? {} : { signal: signal as AbortSignalLike }),
  };
  return Object.freeze(parsed);
}

export interface SecretBrokerCapabilities { readonly resolve: boolean; readonly availability: boolean; readonly replace: boolean; readonly revoke: boolean; readonly versions: boolean; readonly kinds: readonly SecretKind[] }
export interface SecretAvailability { readonly available: boolean; readonly reason: "available" | "not-found" | "revoked" | "version-unavailable" | "unavailable"; readonly audit: SecretAuditRecord }
export const SECRET_AUDIT_OPERATIONS = Object.freeze(["availability", "resolve", "replace", "revoke", "close"] as const);
export type SecretAuditOperation = (typeof SECRET_AUDIT_OPERATIONS)[number];
export const SECRET_AUDIT_PHASES = Object.freeze(["attempt", "outcome"] as const);
export type SecretAuditPhase = (typeof SECRET_AUDIT_PHASES)[number];
export const SECRET_AUDIT_OUTCOMES = Object.freeze(["success", "not-found", "denied", "revoked", "unsupported", "failure", "closed"] as const);
export type SecretAuditOutcome = (typeof SECRET_AUDIT_OUTCOMES)[number];
export interface SecretAuditRecord { readonly schemaVersion: 1; readonly operation: SecretAuditOperation; readonly phase: SecretAuditPhase; readonly outcome: SecretAuditOutcome | null; readonly occurredAt: string; readonly reference: string | null; readonly operationId: string | null; readonly providerInstanceId: string | null; readonly purpose: SecretPurpose | null; readonly traceId: string | null }
export type SecretAuditHook = (record: SecretAuditRecord) => void;
export interface SecretClock { now(): Date }
export interface SecretBroker {
  describeCapabilities(): SecretBrokerCapabilities;
  availability(ref: SecretRef, context: SecretAccessContext): Promise<SecretAvailability>;
  withSecret<T>(ref: SecretRef, context: SecretAccessContext, callback: (secret: SecretMaterial) => T | Promise<T>): Promise<T>;
  replace(ref: SecretRef, material: { readonly kind: SecretKind; readonly text?: string; readonly bytes?: Uint8Array }, context: SecretAccessContext): Promise<SecretAuditRecord>;
  revoke(ref: SecretRef, context: SecretAccessContext): Promise<SecretAuditRecord>;
  close(): Promise<void>;
}

export interface PolicyAwareSecretResolver { withSecret<T>(input: { readonly ref: SecretRef; readonly context: SecretAccessContext; readonly policyRequest: PolicyRequest }, callback: (secret: SecretMaterial, decisionFingerprint: string) => T | Promise<T>): Promise<{ readonly value: T; readonly decisionFingerprint: string }> }
function captureResolverMethod<T extends (...args: never[]) => unknown>(value: unknown, name: string): T {
  if (typeof value !== "object" || value === null || types.isProxy(value)) throw new SecretBrokerError("INVALID_REFERENCE", `Secret resolver ${name} port is invalid.`);
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") throw new SecretBrokerError("INVALID_REFERENCE", `Secret resolver ${name} method is invalid.`);
  const method = descriptor.value as (...args: unknown[]) => unknown;
  return ((...args: unknown[]) => Reflect.apply(method, value, args)) as unknown as T;
}

function policyDecisionProjection(value: unknown): Readonly<{ outcome: "allowed" | "conditional" | "denied"; code: string; fingerprint: string }> {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value)) throw new Error("invalid-decision");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid-decision");
    const outcomeDescriptor = Object.getOwnPropertyDescriptor(value, "outcome");
    const codeDescriptor = Object.getOwnPropertyDescriptor(value, "code");
    const fingerprintDescriptor = Object.getOwnPropertyDescriptor(value, "fingerprint");
    if (outcomeDescriptor === undefined || !("value" in outcomeDescriptor) || codeDescriptor === undefined || !("value" in codeDescriptor) || fingerprintDescriptor === undefined || !("value" in fingerprintDescriptor)) throw new Error("invalid-decision");
    const outcome = outcomeDescriptor.value;
    const code = codeDescriptor.value;
    const fingerprint = fingerprintDescriptor.value;
    const expectedCode = outcome === "allowed" ? "POLICY_ALLOWED" : outcome === "conditional" ? "POLICY_CONDITIONS_REQUIRED" : outcome === "denied" ? "POLICY_DENIED" : null;
    if (expectedCode === null || code !== expectedCode || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("invalid-decision");
    return Object.freeze({ outcome, code, fingerprint });
  } catch {
    throw new SecretBrokerError("ACCESS_DENIED", "The secret access policy decision is invalid.");
  }
}

function resolverInputProjection(value: unknown): Readonly<{ ref: unknown; context: unknown; policyRequest: unknown }> {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("invalid-input");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || keys.some((key) => typeof key !== "string" || (key !== "ref" && key !== "context" && key !== "policyRequest"))) throw new Error("invalid-input");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ref = descriptors["ref"];
    const context = descriptors["context"];
    const policyRequest = descriptors["policyRequest"];
    if (ref === undefined || !("value" in ref) || context === undefined || !("value" in context) || policyRequest === undefined || !("value" in policyRequest)) throw new Error("invalid-input");
    return Object.freeze({ ref: ref.value, context: context.value, policyRequest: policyRequest.value });
  } catch {
    throw new SecretBrokerError("INVALID_REFERENCE", "The secret resolver input is invalid.");
  }
}

export function createPolicyAwareSecretResolver(rawOptions: { readonly policy: PolicyBroker; readonly broker: SecretBroker }): PolicyAwareSecretResolver {
  if (typeof rawOptions !== "object" || rawOptions === null || types.isProxy(rawOptions) || Object.getPrototypeOf(rawOptions) !== Object.prototype) throw new SecretBrokerError("INVALID_REFERENCE", "Secret resolver options are invalid.");
  const keys = Reflect.ownKeys(rawOptions);
  const descriptors = Object.getOwnPropertyDescriptors(rawOptions);
  if (keys.length !== 2 || keys.some((key) => typeof key !== "string" || (key !== "policy" && key !== "broker")) || descriptors["policy"] === undefined || !("value" in descriptors["policy"]) || descriptors["broker"] === undefined || !("value" in descriptors["broker"])) throw new SecretBrokerError("INVALID_REFERENCE", "Secret resolver options are invalid.");
  const evaluate = captureResolverMethod<PolicyBroker["evaluate"]>(descriptors["policy"].value, "evaluate");
  const withSecret = captureResolverMethod<SecretBroker["withSecret"]>(descriptors["broker"].value, "withSecret");
  return Object.freeze({
    async withSecret<T>(input: { readonly ref: SecretRef; readonly context: SecretAccessContext; readonly policyRequest: PolicyRequest }, callback: (secret: SecretMaterial, decisionFingerprint: string) => T | Promise<T>): Promise<{ readonly value: T; readonly decisionFingerprint: string }> {
      if (typeof callback !== "function") throw new SecretBrokerError("INVALID_REFERENCE", "The secret resolver callback is invalid.");
      const projected = resolverInputProjection(input);
      let request: PolicyRequest;
      let context: SecretAccessContext;
      let ref: SecretRef;
      try {
        if (types.isProxy(projected.policyRequest) || types.isProxy(projected.context) || types.isProxy(projected.ref)) throw new Error("invalid-input");
        request = parsePolicyRequest(projected.policyRequest);
        context = parseSecretAccessContext(projected.context);
        ref = parseSecretRef(projected.ref);
      } catch {
        throw new SecretBrokerError("INVALID_REFERENCE", "The secret resolver input is invalid.");
      }
      if (request.action !== "secret-access") throw new SecretBrokerError("ACCESS_DENIED", "Secret access requires a secret-access policy decision.");
      if (toCanonicalJson(request.trace) !== toCanonicalJson(context.trace) || request.classification !== context.classification || request.locality !== context.locality || request.scope.operationId !== context.operationId || request.scope.providerInstanceId !== context.providerInstanceId || request.scope.projectId !== context.projectId || request.scope.taskId !== context.taskId || request.scope.taskId !== context.trace.taskId || request.scope.traceId !== context.trace.traceId || request.scope.workspaceId !== null || request.subjectDigest !== secretRefFingerprint(ref) || (ref.providerInstanceId !== null && ref.providerInstanceId !== context.providerInstanceId)) {
        throw new SecretBrokerError("ACCESS_DENIED", "Secret access policy scope does not match the broker context.");
      }
      const evidenceRefs = request.approvalEvidence.map((item) => item.evidenceRef).sort();
      if (toCanonicalJson(evidenceRefs) !== toCanonicalJson(context.approvalEvidenceRefs)) throw new SecretBrokerError("ACCESS_DENIED", "Secret access approval evidence does not match the broker context.");
      let rawDecision: unknown;
      try { rawDecision = evaluate(request); }
      catch { throw new SecretBrokerError("ACCESS_DENIED", "The secret access policy evaluation failed."); }
      const decision = policyDecisionProjection(rawDecision);
      if (decision.outcome !== "allowed") throw new SecretBrokerError("ACCESS_DENIED", decision.outcome === "conditional" ? "Secret access conditions are not satisfied." : "Secret access was denied.", { decisionCode: decision.code });
      const value = await withSecret(ref, context, (secret) => callback(secret, decision.fingerprint));
      return Object.freeze({ value, decisionFingerprint: decision.fingerprint });
    },
  });
}
