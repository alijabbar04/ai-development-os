import {
  parseModelCapabilities,
  toCanonicalJson,
  validation,
  type Branded,
  type DataClassification,
  type JsonValue,
  type ModelCapabilities,
  type ModelId,
  type ProviderId,
  type RunId,
  type TaskId,
  type TaskRunId,
  type TraceId,
} from "@ai-dev-os/domain";
import { DATA_CLASSIFICATIONS } from "@ai-dev-os/domain";
import { canonicalizeJson } from "@ai-dev-os/domain";
import { ProviderError } from "./errors.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureEnumArray,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  ensureTimestamp,
} = validation;

export const PROVIDER_CONTRACT_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Identifiers (extend the established branded-id conventions)
// ---------------------------------------------------------------------------

export type ProviderInstanceId = string & Branded<"ProviderInstanceId">;
export type ProviderRequestId = string & Branded<"ProviderRequestId">;
export type ProviderOperationId = string & Branded<"ProviderOperationId">;
export type ToolCallId = string & Branded<"ToolCallId">;
/** Machine tool name; kind-shaped (lowercase, dot/dash separated). */
export type ToolName = string & Branded<"ToolName">;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KIND_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

function idParser<T extends string>(label: string) {
  return (value: unknown, path = label): T =>
    ensureString(value, path, { maxLength: 128, pattern: ID_PATTERN, patternName: label }) as T;
}

export const parseProviderInstanceId = idParser<ProviderInstanceId>("ProviderInstanceId");
export const parseProviderRequestId = idParser<ProviderRequestId>("ProviderRequestId");
export const parseProviderOperationId = idParser<ProviderOperationId>("ProviderOperationId");
export const parseToolCallId = idParser<ToolCallId>("ToolCallId");

export function parseToolName(value: unknown, path = "toolName"): ToolName {
  return ensureString(value, path, {
    maxLength: 64,
    pattern: KIND_PATTERN,
    patternName: "tool name",
  }) as ToolName;
}

// ---------------------------------------------------------------------------
// Trace metadata, deadlines, cancellation
// ---------------------------------------------------------------------------

/** Correlation identifiers every operation and event carries. */
export interface ExecutionTraceMetadata {
  readonly traceId: TraceId;
  readonly runId: RunId | null;
  readonly taskId: TaskId | null;
  readonly taskRunId: TaskRunId | null;
}

export function parseExecutionTraceMetadata(
  value: unknown,
  path = "trace",
): ExecutionTraceMetadata {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["traceId", "runId", "taskId", "taskRunId"], path);
  const parseId = (raw: unknown, field: string): string =>
    ensureString(raw, `${path}.${field}`, {
      maxLength: 128,
      pattern: ID_PATTERN,
      patternName: field,
    });
  return Object.freeze({
    traceId: parseId(record["traceId"], "traceId") as TraceId,
    runId: ensureNullable(record["runId"], (raw) => parseId(raw, "runId") as RunId),
    taskId: ensureNullable(record["taskId"], (raw) => parseId(raw, "taskId") as TaskId),
    taskRunId: ensureNullable(record["taskRunId"], (raw) => parseId(raw, "taskRunId") as TaskRunId),
  });
}

export function createTrace(
  traceId: string,
  scope: Partial<Pick<ExecutionTraceMetadata, "runId" | "taskId" | "taskRunId">> = {},
): ExecutionTraceMetadata {
  return parseExecutionTraceMetadata({
    traceId,
    runId: scope.runId ?? null,
    taskId: scope.taskId ?? null,
    taskRunId: scope.taskRunId ?? null,
  });
}

/** Absolute instant (canonical ISO-8601 UTC) after which work must stop. */
export function parseDeadline(value: unknown, path = "deadline"): string {
  return ensureTimestamp(value, path);
}

export function isDeadlineExpired(deadline: string | null, now: Date): boolean {
  return deadline !== null && now.toISOString() >= deadline;
}

export const CANCELLATION_REASONS = Object.freeze([
  "caller-requested",
  "caller-aborted",
  "provider-closed",
  "budget-exhausted",
  "superseded",
] as const);

export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export function parseCancellationReason(
  value: unknown,
  path = "cancellationReason",
): CancellationReason {
  return ensureEnum(value, path, CANCELLATION_REASONS);
}

// ---------------------------------------------------------------------------
// Extensions (namespaced, bounded, validated — no open metadata maps)
// ---------------------------------------------------------------------------

const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
export const MAX_EXTENSIONS = 16;
const MAX_EXTENSION_VALUE_TEXT = 4_096;

/**
 * The only extensibility mechanism: versioned, bounded, validated records
 * under an explicit provider namespace. Providers must reject extensions in
 * namespaces they do not understand rather than silently ignoring them.
 */
export interface ProviderExtension {
  readonly namespace: string;
  readonly key: string;
  readonly value: JsonValue;
}

export function parseProviderExtensions(
  value: unknown,
  path = "extensions",
): readonly ProviderExtension[] {
  if (value === undefined || value === null) {
    return Object.freeze([]);
  }
  const items = ensureArray(value, path, MAX_EXTENSIONS);
  const seen = new Set<string>();
  return Object.freeze(
    items.map((item, index) => {
      const record = ensureRecord(item, `${path}[${index}]`);
      ensureExactKeys(record, ["namespace", "key", "value"], `${path}[${index}]`);
      const namespace = ensureString(record["namespace"], `${path}[${index}].namespace`, {
        maxLength: 32,
        pattern: NAMESPACE_PATTERN,
        patternName: "extension namespace",
      });
      const key = ensureString(record["key"], `${path}[${index}].key`, {
        maxLength: 64,
        pattern: KIND_PATTERN,
        patternName: "extension key",
      });
      const canonical = canonicalizeJson(record["value"], `${path}[${index}].value`);
      if (toCanonicalJson(canonical).length > MAX_EXTENSION_VALUE_TEXT) {
        throw new ProviderError("INVALID_REQUEST", "An extension value is oversized.", {
          namespace,
          key,
          maximum: MAX_EXTENSION_VALUE_TEXT,
        });
      }
      const dedupeKey = `${namespace}/${key}`;
      if (seen.has(dedupeKey)) {
        throw new ProviderError("INVALID_REQUEST", "Duplicate extension key.", {
          namespace,
          key,
        });
      }
      seen.add(dedupeKey);
      return Object.freeze({ namespace, key, value: canonical });
    }),
  );
}

// ---------------------------------------------------------------------------
// Disclosure block (Stage 2 data-policy integration)
// ---------------------------------------------------------------------------

export const DISCLOSURE_LOCALITY_REQUIREMENTS = Object.freeze(["local-only", "any"] as const);
export type DisclosureLocalityRequirement =
  (typeof DISCLOSURE_LOCALITY_REQUIREMENTS)[number];

/**
 * Structured data-policy facts a router/scheduler needs to enforce Stage 2
 * disclosure decisions. Stage 5 never sends content anywhere; providers
 * (including fakes) must reject classifications they do not support.
 */
export interface DisclosureContext {
  readonly classification: DataClassification;
  readonly requiredLocality: DisclosureLocalityRequirement;
  readonly redactionApplied: boolean;
  /** Reference to the recorded policy decision, when one exists. */
  readonly decisionRef: string | null;
  readonly retentionAllowed: boolean;
  readonly loggingAllowed: boolean;
}

export function parseDisclosureContext(value: unknown, path = "disclosure"): DisclosureContext {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "classification",
      "requiredLocality",
      "redactionApplied",
      "decisionRef",
      "retentionAllowed",
      "loggingAllowed",
    ],
    path,
  );
  return Object.freeze({
    classification: ensureEnum(record["classification"], `${path}.classification`, DATA_CLASSIFICATIONS),
    requiredLocality: ensureEnum(
      record["requiredLocality"],
      `${path}.requiredLocality`,
      DISCLOSURE_LOCALITY_REQUIREMENTS,
    ),
    redactionApplied: ensureBoolean(record["redactionApplied"], `${path}.redactionApplied`),
    decisionRef: ensureNullable(record["decisionRef"], (raw) =>
      ensureString(raw, `${path}.decisionRef`, { maxLength: 128, pattern: ID_PATTERN, patternName: "decision reference" }),
    ),
    retentionAllowed: ensureBoolean(record["retentionAllowed"], `${path}.retentionAllowed`),
    loggingAllowed: ensureBoolean(record["loggingAllowed"], `${path}.loggingAllowed`),
  });
}

// ---------------------------------------------------------------------------
// Provider descriptor, capabilities, health, model descriptors
// ---------------------------------------------------------------------------

export const PROVIDER_KINDS = Object.freeze(["inference", "coding-agent"] as const);
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_STATUSES = Object.freeze([
  "ready",
  "degraded",
  "unavailable",
  "closed",
] as const);
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const MODEL_AVAILABILITIES = Object.freeze([
  "available",
  "degraded",
  "unavailable",
] as const);
export type ModelAvailability = (typeof MODEL_AVAILABILITIES)[number];

export const CANCELLATION_SUPPORT = Object.freeze([
  "guaranteed",
  "best-effort",
  "none",
] as const);
export type CancellationSupport = (typeof CANCELLATION_SUPPORT)[number];

/** Instance-level capabilities; model-level limits come from ModelCapabilities. */
export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly structuredOutput: boolean;
  readonly toolCalling: boolean;
  readonly imageInput: boolean;
  readonly repositoryEditing: boolean;
  readonly commandExecution: boolean;
  readonly networkAccess: boolean;
  readonly resumability: boolean;
  readonly cancellation: CancellationSupport;
  readonly deadlineEnforcement: boolean;
  readonly usageReporting: boolean;
  readonly pricingAvailable: boolean;
}

const CAPABILITY_KEYS = [
  "streaming",
  "structuredOutput",
  "toolCalling",
  "imageInput",
  "repositoryEditing",
  "commandExecution",
  "networkAccess",
  "resumability",
  "cancellation",
  "deadlineEnforcement",
  "usageReporting",
  "pricingAvailable",
] as const;

export function parseProviderCapabilities(
  value: unknown,
  path = "capabilities",
): ProviderCapabilities {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, CAPABILITY_KEYS, path);
  const flag = (key: (typeof CAPABILITY_KEYS)[number]): boolean =>
    ensureBoolean(record[key], `${path}.${key}`);
  return Object.freeze({
    streaming: flag("streaming"),
    structuredOutput: flag("structuredOutput"),
    toolCalling: flag("toolCalling"),
    imageInput: flag("imageInput"),
    repositoryEditing: flag("repositoryEditing"),
    commandExecution: flag("commandExecution"),
    networkAccess: flag("networkAccess"),
    resumability: flag("resumability"),
    cancellation: ensureEnum(record["cancellation"], `${path}.cancellation`, CANCELLATION_SUPPORT),
    deadlineEnforcement: flag("deadlineEnforcement"),
    usageReporting: flag("usageReporting"),
    pricingAvailable: flag("pricingAvailable"),
  });
}

/** Immutable identity and policy-relevant behavior of one provider instance. */
export interface ProviderDescriptor {
  readonly schemaVersion: typeof PROVIDER_CONTRACT_SCHEMA_VERSION;
  readonly providerId: ProviderId;
  readonly instanceId: ProviderInstanceId;
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly locality: "local" | "cloud";
  readonly retainsData: boolean;
  readonly trainsOnInputs: boolean;
  readonly supportedClassifications: readonly DataClassification[];
  readonly capabilities: ProviderCapabilities;
}

export function parseProviderDescriptor(
  value: unknown,
  path = "providerDescriptor",
): ProviderDescriptor {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "providerId",
      "instanceId",
      "kind",
      "displayName",
      "locality",
      "retainsData",
      "trainsOnInputs",
      "supportedClassifications",
      "capabilities",
    ],
    path,
  );
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, PROVIDER_CONTRACT_SCHEMA_VERSION);
  return Object.freeze({
    schemaVersion: PROVIDER_CONTRACT_SCHEMA_VERSION,
    providerId: ensureString(record["providerId"], `${path}.providerId`, {
      maxLength: 128,
      pattern: ID_PATTERN,
      patternName: "ProviderId",
    }) as ProviderId,
    instanceId: parseProviderInstanceId(record["instanceId"], `${path}.instanceId`),
    kind: ensureEnum(record["kind"], `${path}.kind`, PROVIDER_KINDS),
    displayName: ensureString(record["displayName"], `${path}.displayName`, { maxLength: 120 }),
    locality: ensureEnum(record["locality"], `${path}.locality`, ["cloud", "local"] as const),
    retainsData: ensureBoolean(record["retainsData"], `${path}.retainsData`),
    trainsOnInputs: ensureBoolean(record["trainsOnInputs"], `${path}.trainsOnInputs`),
    supportedClassifications: ensureEnumArray(
      record["supportedClassifications"],
      `${path}.supportedClassifications`,
      DATA_CLASSIFICATIONS,
      DATA_CLASSIFICATIONS.length,
    ),
    capabilities: parseProviderCapabilities(record["capabilities"], `${path}.capabilities`),
  });
}

export interface ProviderHealth {
  readonly status: ProviderStatus;
  readonly checkedAt: string;
  /** Machine-safe detail code; never free-form provider output. */
  readonly detailCode: string | null;
  readonly activeOperations: number;
}

export function parseProviderHealth(value: unknown, path = "providerHealth"): ProviderHealth {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["status", "checkedAt", "detailCode", "activeOperations"], path);
  return Object.freeze({
    status: ensureEnum(record["status"], `${path}.status`, PROVIDER_STATUSES),
    checkedAt: ensureTimestamp(record["checkedAt"], `${path}.checkedAt`),
    detailCode: ensureNullable(record["detailCode"], (raw) =>
      ensureString(raw, `${path}.detailCode`, { maxLength: 64, pattern: KIND_PATTERN, patternName: "detail code" }),
    ),
    activeOperations: ensureSafeInteger(record["activeOperations"], `${path}.activeOperations`, 0, 1_000_000),
  });
}

/** A model offered by a provider instance: Stage 2 capabilities + availability. */
export interface ModelDescriptor {
  readonly model: ModelCapabilities;
  readonly availability: ModelAvailability;
}

export function parseModelDescriptor(value: unknown, path = "modelDescriptor"): ModelDescriptor {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["model", "availability"], path);
  return Object.freeze({
    model: parseModelCapabilities(record["model"], `${path}.model`),
    availability: ensureEnum(record["availability"], `${path}.availability`, MODEL_AVAILABILITIES),
  });
}

/**
 * Effective support = provider-instance capability AND model capability.
 * A feature is usable only when both layers support it; the router filters
 * on this combined view.
 */
export function combinedCapability(
  descriptor: ProviderDescriptor,
  model: ModelCapabilities,
): {
  readonly structuredOutput: boolean;
  readonly toolCalling: boolean;
  readonly imageInput: boolean;
  readonly localExecution: boolean;
} {
  return Object.freeze({
    structuredOutput: descriptor.capabilities.structuredOutput && model.supportsStructuredOutput,
    toolCalling: descriptor.capabilities.toolCalling && model.supportsToolUse,
    imageInput: descriptor.capabilities.imageInput && model.supportsVision,
    localExecution: descriptor.locality === "local" && model.locality === "local",
  });
}

export type { ModelId, ProviderId };
