import {
  DATA_CLASSIFICATIONS,
  ValidationError,
  validation,
  type DataClassification,
} from "@ai-dev-os/domain";
import { ProviderError } from "@ai-dev-os/providers";
import { containsSecretLikeKey, parseSecretRef, type SecretRef } from "@ai-dev-os/secrets";
import { invalidConfigurationError } from "./errors.js";
import {
  DEFAULT_OPENAI_ENDPOINT_PROFILE,
  parseOpenAiEndpoint,
  type OpenAiEndpoint,
} from "./endpoint.js";
import {
  OPENAI_REASONING_EFFORTS,
  OPENAI_REASONING_SUMMARIES,
  emptyOpenAiModelCatalog,
  parseOpenAiCapabilityOverride,
  parseOpenAiModelCatalog,
  type OpenAiCapabilityOverride,
  type OpenAiModelCatalog,
  type OpenAiReasoningEffort,
  type OpenAiReasoningSummary,
} from "./catalog.js";

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

export const OPENAI_ADAPTER_SCHEMA_VERSION = 1 as const;

/** Extension namespace this adapter owns in configuration and requests. */
export const OPENAI_EXTENSION_NAMESPACE = "openai";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ORGANIZATION_PATTERN = /^org-[A-Za-z0-9]{1,60}$/;
const PROJECT_PATTERN = /^proj_[A-Za-z0-9]{1,60}$/;
const SOURCE_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/;

/** `service_tier` vocabulary from the OpenAPI document. */
export const OPENAI_SERVICE_TIERS = Object.freeze([
  "auto",
  "default",
  "flex",
  "scale",
  "priority",
  "fast",
] as const);
export type OpenAiServiceTier = (typeof OPENAI_SERVICE_TIERS)[number];

/** `text.verbosity` vocabulary from the OpenAPI document. */
export const OPENAI_VERBOSITIES = Object.freeze(["low", "medium", "high"] as const);
export type OpenAiVerbosity = (typeof OPENAI_VERBOSITIES)[number];

/**
 * Background-mode policy.
 *
 * Background responses place request and output content in temporary
 * server-side storage — the guide states data is "temporarily stored to
 * disk for roughly 10 minutes to enable asynchronous execution and
 * polling", and that Zero Data Retention projects run background requests
 * with `store=false` while the data is still temporarily retained. Enabling
 * background mode is therefore a retention decision, not a transport
 * detail, and defaults to disabled.
 */
export const OPENAI_BACKGROUND_MODES = Object.freeze(["disabled", "allowed", "required"] as const);
export type OpenAiBackgroundMode = (typeof OPENAI_BACKGROUND_MODES)[number];

export interface OpenAiBackgroundPolicy {
  readonly mode: OpenAiBackgroundMode;
  readonly pollBaseDelayMs: number;
  readonly pollMaxDelayMs: number;
  readonly pollJitterRatio: number;
  readonly maxPollAttempts: number;
  /** Whether a disconnected background stream may be resumed by cursor. */
  readonly resumeStreamEnabled: boolean;
  readonly maxResumeAttempts: number;
  /** Whether cancellation calls the official cancel endpoint. */
  readonly cancelRemoteOnAbort: boolean;
}

/**
 * Storage and continuation policy.
 *
 * `store` defaults to `never`: the adapter sends `store: false` unless
 * policy explicitly authorizes persistence. `previous_response_id`
 * continuation is only legal when the referenced response was actually
 * stored, so it is gated on the same authorization.
 */
export const OPENAI_STORE_MODES = Object.freeze(["never", "when-authorized"] as const);
export type OpenAiStoreMode = (typeof OPENAI_STORE_MODES)[number];

export interface OpenAiStoragePolicy {
  readonly store: OpenAiStoreMode;
  readonly allowPreviousResponseContinuation: boolean;
  /** Maximum age of a resume/continuation token before it is refused. */
  readonly continuationTtlMs: number;
}

/**
 * Operator-declared, dated statement of what the upstream actually retains.
 * The adapter reports these facts verbatim in its descriptor and decisions
 * and never infers Zero Data Retention from having sent `store: false`.
 */
export interface OpenAiRetentionDeclaration {
  /**
   * Declared abuse-monitoring retention window in days, distinct from
   * application state. Null means "declared unknown".
   */
  readonly abuseMonitoringRetentionDays: number | null;
  /** True only when the operator has a contractual ZDR arrangement. */
  readonly zeroDataRetentionEnrolled: boolean;
  /**
   * Documented temporary server-side storage window for background
   * responses, in milliseconds. Applies even when `store` is false.
   */
  readonly backgroundTemporaryStorageMs: number;
  readonly source: string;
  readonly declaredAt: string;
}

export interface OpenAiDeadlines {
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly idleStreamTimeoutMs: number;
  readonly totalOperationTimeoutMs: number;
  readonly pollTimeoutMs: number;
  readonly cancellationTimeoutMs: number;
}

export interface OpenAiLimits {
  readonly maxResponseBytes: number;
  readonly maxErrorBodyBytes: number;
  readonly maxSseLineBytes: number;
  readonly maxSseEventBytes: number;
  readonly maxStreamBytes: number;
  readonly maxStreamEvents: number;
  readonly maxOutputItems: number;
  readonly maxToolCallArgumentsBytes: number;
  readonly maxStructuredOutputBytes: number;
  readonly maxImageArtifactBytes: number;
}

export interface OpenAiRetryPolicy {
  /** Total attempts including the first; 1 disables retrying. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export interface OpenAiReasoningControls {
  readonly effort: OpenAiReasoningEffort | null;
  readonly summary: OpenAiReasoningSummary | null;
  /**
   * Whether reasoning summaries may be surfaced as provider-neutral
   * reasoning deltas. Defaults to false: reasoning stays internal unless
   * policy explicitly allows disclosure.
   */
  readonly discloseReasoning: boolean;
}

export interface OpenAiAdapterConfiguration {
  readonly schemaVersion: typeof OPENAI_ADAPTER_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly endpoint: OpenAiEndpoint;
  readonly apiKeyRef: SecretRef;
  readonly organizationId: string | null;
  readonly projectId: string | null;
  readonly permittedModels: readonly string[];
  readonly reasoning: OpenAiReasoningControls;
  readonly verbosity: OpenAiVerbosity | null;
  readonly serviceTier: OpenAiServiceTier | null;
  /** Never enabled implicitly: parallel tool calls change tool semantics. */
  readonly parallelToolCallsEnabled: boolean;
  readonly deadlines: OpenAiDeadlines;
  readonly limits: OpenAiLimits;
  readonly background: OpenAiBackgroundPolicy;
  readonly storage: OpenAiStoragePolicy;
  readonly retry: OpenAiRetryPolicy;
  readonly catalog: OpenAiModelCatalog;
  readonly capabilityOverrides: readonly OpenAiCapabilityOverride[];
  readonly supportedClassifications: readonly DataClassification[];
  readonly retention: OpenAiRetentionDeclaration;
  /** When true, a request without a safety identifier is refused. */
  readonly safetyIdentifierRequired: boolean;
}

function uniqueStrings(items: readonly string[], label: string): readonly string[] {
  if (new Set(items).size !== items.length) {
    throw invalidConfigurationError(`duplicate-entry:${label}`);
  }
  return Object.freeze([...items]);
}

function parseRatio(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidConfigurationError(`bad-ratio:${path}`);
  }
  return value;
}

function parseDeadlines(value: unknown, path: string): OpenAiDeadlines {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "connectTimeoutMs",
      "requestTimeoutMs",
      "idleStreamTimeoutMs",
      "totalOperationTimeoutMs",
      "pollTimeoutMs",
      "cancellationTimeoutMs",
    ],
    path,
  );
  const ms = (key: string, min: number, max: number): number =>
    ensureSafeInteger(record[key], `${path}.${key}`, min, max);
  const deadlines = Object.freeze({
    connectTimeoutMs: ms("connectTimeoutMs", 100, 600_000),
    requestTimeoutMs: ms("requestTimeoutMs", 100, 3_600_000),
    idleStreamTimeoutMs: ms("idleStreamTimeoutMs", 100, 3_600_000),
    totalOperationTimeoutMs: ms("totalOperationTimeoutMs", 100, 86_400_000),
    pollTimeoutMs: ms("pollTimeoutMs", 100, 600_000),
    cancellationTimeoutMs: ms("cancellationTimeoutMs", 100, 600_000),
  });
  if (deadlines.connectTimeoutMs > deadlines.requestTimeoutMs) {
    throw invalidConfigurationError("connect-timeout-exceeds-request-timeout");
  }
  if (deadlines.requestTimeoutMs > deadlines.totalOperationTimeoutMs) {
    throw invalidConfigurationError("request-timeout-exceeds-total-operation-timeout");
  }
  return deadlines;
}

function parseLimits(value: unknown, path: string): OpenAiLimits {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "maxResponseBytes",
      "maxErrorBodyBytes",
      "maxSseLineBytes",
      "maxSseEventBytes",
      "maxStreamBytes",
      "maxStreamEvents",
      "maxOutputItems",
      "maxToolCallArgumentsBytes",
      "maxStructuredOutputBytes",
      "maxImageArtifactBytes",
    ],
    path,
  );
  const count = (key: string, min: number, max: number): number =>
    ensureSafeInteger(record[key], `${path}.${key}`, min, max);
  const limits = Object.freeze({
    maxResponseBytes: count("maxResponseBytes", 1_024, 64 * 1_024 * 1_024),
    maxErrorBodyBytes: count("maxErrorBodyBytes", 256, 1_024 * 1_024),
    maxSseLineBytes: count("maxSseLineBytes", 256, 8 * 1_024 * 1_024),
    maxSseEventBytes: count("maxSseEventBytes", 256, 16 * 1_024 * 1_024),
    maxStreamBytes: count("maxStreamBytes", 1_024, 512 * 1_024 * 1_024),
    maxStreamEvents: count("maxStreamEvents", 1, 1_000_000),
    maxOutputItems: count("maxOutputItems", 1, 10_000),
    maxToolCallArgumentsBytes: count("maxToolCallArgumentsBytes", 256, 1_024 * 1_024),
    maxStructuredOutputBytes: count("maxStructuredOutputBytes", 256, 8 * 1_024 * 1_024),
    maxImageArtifactBytes: count("maxImageArtifactBytes", 1_024, 32 * 1_024 * 1_024),
  });
  if (limits.maxSseLineBytes > limits.maxSseEventBytes) {
    throw invalidConfigurationError("sse-line-bound-exceeds-event-bound");
  }
  if (limits.maxSseEventBytes > limits.maxStreamBytes) {
    throw invalidConfigurationError("sse-event-bound-exceeds-stream-bound");
  }
  return limits;
}

function parseBackgroundPolicy(value: unknown, path: string): OpenAiBackgroundPolicy {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "mode",
      "pollBaseDelayMs",
      "pollMaxDelayMs",
      "pollJitterRatio",
      "maxPollAttempts",
      "resumeStreamEnabled",
      "maxResumeAttempts",
      "cancelRemoteOnAbort",
    ],
    path,
  );
  const pollBaseDelayMs = ensureSafeInteger(record["pollBaseDelayMs"], `${path}.pollBaseDelayMs`, 10, 600_000);
  const pollMaxDelayMs = ensureSafeInteger(record["pollMaxDelayMs"], `${path}.pollMaxDelayMs`, pollBaseDelayMs, 600_000);
  return Object.freeze({
    mode: ensureEnum(record["mode"], `${path}.mode`, OPENAI_BACKGROUND_MODES),
    pollBaseDelayMs,
    pollMaxDelayMs,
    pollJitterRatio: parseRatio(record["pollJitterRatio"], `${path}.pollJitterRatio`),
    maxPollAttempts: ensureSafeInteger(record["maxPollAttempts"], `${path}.maxPollAttempts`, 1, 10_000),
    resumeStreamEnabled: ensureBoolean(record["resumeStreamEnabled"], `${path}.resumeStreamEnabled`),
    maxResumeAttempts: ensureSafeInteger(record["maxResumeAttempts"], `${path}.maxResumeAttempts`, 0, 100),
    cancelRemoteOnAbort: ensureBoolean(record["cancelRemoteOnAbort"], `${path}.cancelRemoteOnAbort`),
  });
}

function parseStoragePolicy(value: unknown, path: string): OpenAiStoragePolicy {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["store", "allowPreviousResponseContinuation", "continuationTtlMs"], path);
  const policy = Object.freeze({
    store: ensureEnum(record["store"], `${path}.store`, OPENAI_STORE_MODES),
    allowPreviousResponseContinuation: ensureBoolean(
      record["allowPreviousResponseContinuation"],
      `${path}.allowPreviousResponseContinuation`,
    ),
    continuationTtlMs: ensureSafeInteger(record["continuationTtlMs"], `${path}.continuationTtlMs`, 1_000, 86_400_000),
  });
  if (policy.allowPreviousResponseContinuation && policy.store === "never") {
    // `previous_response_id` only resolves against a STORED response.
    throw invalidConfigurationError("continuation-requires-storage");
  }
  return policy;
}

function parseRetention(value: unknown, path: string): OpenAiRetentionDeclaration {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "abuseMonitoringRetentionDays",
      "zeroDataRetentionEnrolled",
      "backgroundTemporaryStorageMs",
      "source",
      "declaredAt",
    ],
    path,
  );
  return Object.freeze({
    abuseMonitoringRetentionDays: ensureNullable(record["abuseMonitoringRetentionDays"], (raw) =>
      ensureSafeInteger(raw, `${path}.abuseMonitoringRetentionDays`, 0, 36_500),
    ),
    zeroDataRetentionEnrolled: ensureBoolean(
      record["zeroDataRetentionEnrolled"],
      `${path}.zeroDataRetentionEnrolled`,
    ),
    backgroundTemporaryStorageMs: ensureSafeInteger(
      record["backgroundTemporaryStorageMs"],
      `${path}.backgroundTemporaryStorageMs`,
      0,
      86_400_000,
    ),
    source: ensureString(record["source"], `${path}.source`, {
      maxLength: 128,
      pattern: SOURCE_PATTERN,
      patternName: "retention source",
    }),
    declaredAt: ensureTimestamp(record["declaredAt"], `${path}.declaredAt`),
  });
}

function parseRetry(value: unknown, path: string): OpenAiRetryPolicy {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["maxAttempts", "baseDelayMs", "maxDelayMs", "jitterRatio"], path);
  const baseDelayMs = ensureSafeInteger(record["baseDelayMs"], `${path}.baseDelayMs`, 10, 600_000);
  return Object.freeze({
    maxAttempts: ensureSafeInteger(record["maxAttempts"], `${path}.maxAttempts`, 1, 10),
    baseDelayMs,
    maxDelayMs: ensureSafeInteger(record["maxDelayMs"], `${path}.maxDelayMs`, baseDelayMs, 600_000),
    jitterRatio: parseRatio(record["jitterRatio"], `${path}.jitterRatio`),
  });
}

function parseReasoningControls(value: unknown, path: string): OpenAiReasoningControls {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["effort", "summary", "discloseReasoning"], path);
  const summary = ensureNullable(record["summary"], (raw) =>
    ensureEnum(raw, `${path}.summary`, OPENAI_REASONING_SUMMARIES),
  );
  const discloseReasoning = ensureBoolean(record["discloseReasoning"], `${path}.discloseReasoning`);
  if (discloseReasoning && summary === null) {
    // Reasoning deltas can only come from a requested summary; disclosing
    // without asking for one would silently emit nothing.
    throw invalidConfigurationError("disclose-reasoning-requires-summary");
  }
  return Object.freeze({
    effort: ensureNullable(record["effort"], (raw) =>
      ensureEnum(raw, `${path}.effort`, OPENAI_REASONING_EFFORTS),
    ),
    summary,
    discloseReasoning,
  });
}

const CONFIGURATION_KEYS = [
  "schemaVersion",
  "instanceId",
  "endpoint",
  "apiKeyRef",
  "organizationId",
  "projectId",
  "permittedModels",
  "reasoning",
  "verbosity",
  "serviceTier",
  "parallelToolCallsEnabled",
  "deadlines",
  "limits",
  "background",
  "storage",
  "retry",
  "catalog",
  "capabilityOverrides",
  "supportedClassifications",
  "retention",
  "safetyIdentifierRequired",
] as const;

/**
 * Strict full-record validation. Unknown fields, prototype-pollution
 * input, inline credentials, non-HTTPS or arbitrary endpoints, arbitrary
 * headers (unrepresentable by construction), unsafe numbers, duplicate
 * model rules, and model ids that could alter a request boundary are all
 * rejected. The returned configuration is deeply immutable.
 */
export function parseOpenAiAdapterConfiguration(value: unknown): OpenAiAdapterConfiguration {
  try {
    const record = ensureRecord(value, "openAiConfiguration");
    ensureExactKeys(record, CONFIGURATION_KEYS, "openAiConfiguration");
    ensureSchemaVersion(
      record["schemaVersion"],
      "openAiConfiguration.schemaVersion",
      OPENAI_ADAPTER_SCHEMA_VERSION,
    );

    // An API key must arrive as a SecretRef resolved at request time. A
    // configuration that carries key-shaped material is refused outright.
    if (containsSecretLikeKey(record)) {
      throw invalidConfigurationError("inline-secret-material");
    }

    // parseOpenAiEndpoint validates a profile name, the exact canonical
    // base URL, or an already-parsed endpoint, and rejects everything else.
    const endpoint = parseOpenAiEndpoint(record["endpoint"]);

    const apiKeyRef = parseSecretRef(record["apiKeyRef"], "openAiConfiguration.apiKeyRef");
    if (apiKeyRef.expectedKind !== "text") {
      throw invalidConfigurationError("api-key-must-be-text");
    }
    const permittedModels = uniqueStrings(
      ensureArray(record["permittedModels"], "openAiConfiguration.permittedModels", 256).map(
        (item, index) =>
          ensureString(item, `openAiConfiguration.permittedModels[${index}]`, {
            maxLength: 128,
            pattern: MODEL_ID_PATTERN,
            patternName: "OpenAI model id",
          }),
      ),
      "permittedModels",
    );
    if (permittedModels.length === 0) {
      throw invalidConfigurationError("no-permitted-models");
    }

    const catalog = parseOpenAiModelCatalog(record["catalog"], "openAiConfiguration.catalog");

    const capabilityOverrides = ensureArray(
      record["capabilityOverrides"],
      "openAiConfiguration.capabilityOverrides",
      256,
    ).map((item, index) =>
      parseOpenAiCapabilityOverride(item, `openAiConfiguration.capabilityOverrides[${index}]`),
    );
    uniqueStrings(
      capabilityOverrides.map((override) => override.modelId),
      "capabilityOverrides",
    );

    const background = parseBackgroundPolicy(record["background"], "openAiConfiguration.background");
    const storage = parseStoragePolicy(record["storage"], "openAiConfiguration.storage");
    const retention = parseRetention(record["retention"], "openAiConfiguration.retention");
    if (retention.zeroDataRetentionEnrolled && storage.store !== "never") {
      // A ZDR arrangement is incompatible with requesting persistence.
      throw invalidConfigurationError("zero-data-retention-conflicts-with-storage");
    }

    return Object.freeze({
      schemaVersion: OPENAI_ADAPTER_SCHEMA_VERSION,
      instanceId: ensureString(record["instanceId"], "openAiConfiguration.instanceId", {
        maxLength: 128,
        pattern: ID_PATTERN,
        patternName: "provider instance id",
      }),
      endpoint,
      apiKeyRef,
      organizationId: ensureNullable(record["organizationId"], (raw) =>
        ensureString(raw, "openAiConfiguration.organizationId", {
          maxLength: 64,
          pattern: ORGANIZATION_PATTERN,
          patternName: "OpenAI organization id",
        }),
      ),
      projectId: ensureNullable(record["projectId"], (raw) =>
        ensureString(raw, "openAiConfiguration.projectId", {
          maxLength: 64,
          pattern: PROJECT_PATTERN,
          patternName: "OpenAI project id",
        }),
      ),
      permittedModels,
      reasoning: parseReasoningControls(record["reasoning"], "openAiConfiguration.reasoning"),
      verbosity: ensureNullable(record["verbosity"], (raw) =>
        ensureEnum(raw, "openAiConfiguration.verbosity", OPENAI_VERBOSITIES),
      ),
      serviceTier: ensureNullable(record["serviceTier"], (raw) =>
        ensureEnum(raw, "openAiConfiguration.serviceTier", OPENAI_SERVICE_TIERS),
      ),
      parallelToolCallsEnabled: ensureBoolean(
        record["parallelToolCallsEnabled"],
        "openAiConfiguration.parallelToolCallsEnabled",
      ),
      deadlines: parseDeadlines(record["deadlines"], "openAiConfiguration.deadlines"),
      limits: parseLimits(record["limits"], "openAiConfiguration.limits"),
      background,
      storage,
      retry: parseRetry(record["retry"], "openAiConfiguration.retry"),
      catalog,
      capabilityOverrides: Object.freeze(capabilityOverrides),
      supportedClassifications: ensureEnumArray(
        record["supportedClassifications"],
        "openAiConfiguration.supportedClassifications",
        DATA_CLASSIFICATIONS,
        DATA_CLASSIFICATIONS.length,
      ),
      retention,
      safetyIdentifierRequired: ensureBoolean(
        record["safetyIdentifierRequired"],
        "openAiConfiguration.safetyIdentifierRequired",
      ),
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    if (error instanceof ValidationError) {
      const issue = error.issues[0];
      throw invalidConfigurationError(`${issue?.code ?? "invalid"}:${issue?.path ?? "configuration"}`);
    }
    throw error;
  }
}

export interface OpenAiAdapterConfigurationInput {
  readonly instanceId: string;
  readonly apiKeyRef: SecretRef;
  readonly permittedModels: readonly string[];
  readonly endpoint?: string;
  readonly organizationId?: string | null;
  readonly projectId?: string | null;
  readonly reasoning?: Partial<OpenAiReasoningControls>;
  readonly verbosity?: OpenAiVerbosity | null;
  readonly serviceTier?: OpenAiServiceTier | null;
  readonly parallelToolCallsEnabled?: boolean;
  readonly deadlines?: Partial<OpenAiDeadlines>;
  readonly limits?: Partial<OpenAiLimits>;
  readonly background?: Partial<OpenAiBackgroundPolicy>;
  readonly storage?: Partial<OpenAiStoragePolicy>;
  readonly retry?: Partial<OpenAiRetryPolicy>;
  readonly catalog?: OpenAiModelCatalog;
  readonly capabilityOverrides?: readonly Partial<OpenAiCapabilityOverride>[];
  readonly supportedClassifications?: readonly DataClassification[];
  readonly retention?: Partial<OpenAiRetentionDeclaration>;
  readonly safetyIdentifierRequired?: boolean;
}

/**
 * Documented conservative defaults, then full validation. Defaults are
 * deliberately restrictive: no persistence, no background mode, no
 * reasoning disclosure, no parallel tool calls.
 */
export function createOpenAiAdapterConfiguration(
  input: OpenAiAdapterConfigurationInput,
): OpenAiAdapterConfiguration {
  const reasoning = input.reasoning ?? {};
  const deadlines = input.deadlines ?? {};
  const limits = input.limits ?? {};
  const background = input.background ?? {};
  const storage = input.storage ?? {};
  const retry = input.retry ?? {};
  const retention = input.retention ?? {};

  return parseOpenAiAdapterConfiguration({
    schemaVersion: OPENAI_ADAPTER_SCHEMA_VERSION,
    instanceId: input.instanceId,
    endpoint: input.endpoint ?? DEFAULT_OPENAI_ENDPOINT_PROFILE,
    apiKeyRef: input.apiKeyRef,
    organizationId: input.organizationId ?? null,
    projectId: input.projectId ?? null,
    permittedModels: input.permittedModels,
    reasoning: {
      effort: reasoning.effort ?? null,
      summary: reasoning.summary ?? null,
      discloseReasoning: reasoning.discloseReasoning ?? false,
    },
    verbosity: input.verbosity ?? null,
    serviceTier: input.serviceTier ?? null,
    parallelToolCallsEnabled: input.parallelToolCallsEnabled ?? false,
    deadlines: {
      connectTimeoutMs: deadlines.connectTimeoutMs ?? 10_000,
      requestTimeoutMs: deadlines.requestTimeoutMs ?? 300_000,
      idleStreamTimeoutMs: deadlines.idleStreamTimeoutMs ?? 120_000,
      totalOperationTimeoutMs: deadlines.totalOperationTimeoutMs ?? 900_000,
      pollTimeoutMs: deadlines.pollTimeoutMs ?? 30_000,
      cancellationTimeoutMs: deadlines.cancellationTimeoutMs ?? 15_000,
    },
    limits: {
      maxResponseBytes: limits.maxResponseBytes ?? 8 * 1_024 * 1_024,
      maxErrorBodyBytes: limits.maxErrorBodyBytes ?? 16 * 1_024,
      maxSseLineBytes: limits.maxSseLineBytes ?? 1_024 * 1_024,
      maxSseEventBytes: limits.maxSseEventBytes ?? 2 * 1_024 * 1_024,
      maxStreamBytes: limits.maxStreamBytes ?? 128 * 1_024 * 1_024,
      maxStreamEvents: limits.maxStreamEvents ?? 200_000,
      maxOutputItems: limits.maxOutputItems ?? 512,
      maxToolCallArgumentsBytes: limits.maxToolCallArgumentsBytes ?? 64 * 1_024,
      maxStructuredOutputBytes: limits.maxStructuredOutputBytes ?? 256 * 1_024,
      maxImageArtifactBytes: limits.maxImageArtifactBytes ?? 8 * 1_024 * 1_024,
    },
    background: {
      mode: background.mode ?? "disabled",
      pollBaseDelayMs: background.pollBaseDelayMs ?? 500,
      pollMaxDelayMs: background.pollMaxDelayMs ?? 15_000,
      pollJitterRatio: background.pollJitterRatio ?? 0.2,
      maxPollAttempts: background.maxPollAttempts ?? 240,
      resumeStreamEnabled: background.resumeStreamEnabled ?? true,
      maxResumeAttempts: background.maxResumeAttempts ?? 3,
      cancelRemoteOnAbort: background.cancelRemoteOnAbort ?? true,
    },
    storage: {
      store: storage.store ?? "never",
      allowPreviousResponseContinuation: storage.allowPreviousResponseContinuation ?? false,
      continuationTtlMs: storage.continuationTtlMs ?? 3_600_000,
    },
    retry: {
      maxAttempts: retry.maxAttempts ?? 3,
      baseDelayMs: retry.baseDelayMs ?? 500,
      maxDelayMs: retry.maxDelayMs ?? 30_000,
      jitterRatio: retry.jitterRatio ?? 0.2,
    },
    catalog: input.catalog ?? emptyOpenAiModelCatalog(),
    capabilityOverrides: (input.capabilityOverrides ?? []).map((override) => ({
      modelId: override.modelId,
      denyStructuredOutput: override.denyStructuredOutput ?? false,
      denyToolCalling: override.denyToolCalling ?? false,
      denyVision: override.denyVision ?? false,
      denyReasoning: override.denyReasoning ?? false,
      denySampling: override.denySampling ?? false,
      maxContextWindowTokens: override.maxContextWindowTokens ?? null,
      maxOutputTokens: override.maxOutputTokens ?? null,
      allowedReasoningEfforts: override.allowedReasoningEfforts ?? null,
    })),
    supportedClassifications: input.supportedClassifications ?? ["public", "internal"],
    retention: {
      abuseMonitoringRetentionDays: retention.abuseMonitoringRetentionDays ?? null,
      zeroDataRetentionEnrolled: retention.zeroDataRetentionEnrolled ?? false,
      // The background guide documents roughly ten minutes of temporary
      // server-side storage for asynchronous execution and polling.
      backgroundTemporaryStorageMs: retention.backgroundTemporaryStorageMs ?? 600_000,
      source: retention.source ?? "operator",
      declaredAt: retention.declaredAt ?? "1970-01-01T00:00:00.000Z",
    },
    safetyIdentifierRequired: input.safetyIdentifierRequired ?? true,
  });
}

/** Looks up the restrictive override for a model, if any. */
export function findCapabilityOverride(
  configuration: OpenAiAdapterConfiguration,
  modelId: string,
): OpenAiCapabilityOverride | null {
  return configuration.capabilityOverrides.find((override) => override.modelId === modelId) ?? null;
}
