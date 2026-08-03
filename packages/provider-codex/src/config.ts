import { createHash } from "node:crypto";
import { canonicalizeJson, toCanonicalJson, validation, type DataClassification } from "@ai-dev-os/domain";
import {
  parseTrustedToolDescriptor,
  type TrustedToolDescriptor,
} from "@ai-dev-os/process-broker";
import { ProviderError } from "@ai-dev-os/providers";

const {
  ensureArray,
  ensureEnum,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureString,
} = validation;

export const CODEX_ADAPTER_SCHEMA_VERSION = 1 as const;
export const CODEX_PROVIDER_ID = "codex";
export const PROBED_CODEX_VERSION = "0.146.0-alpha.9.2";
export const CODEX_EFFORTS = Object.freeze(["minimal", "low", "medium", "high", "xhigh"] as const);
export type CodexEffort = (typeof CODEX_EFFORTS)[number];
export const CODEX_SANDBOX_MAPPINGS = Object.freeze(["read-only", "workspace-write"] as const);
export type CodexSandboxMapping = (typeof CODEX_SANDBOX_MAPPINGS)[number];
export const CODEX_APPROVAL_MAPPINGS = Object.freeze(["never", "on-request"] as const);
export type CodexApprovalMapping = (typeof CODEX_APPROVAL_MAPPINGS)[number];
export const CODEX_AUTH_CLASSIFICATIONS = Object.freeze([
  "account-managed",
  "api-key-secret-ref",
  "external-provider",
  "observation-only",
] as const);
export type CodexAuthenticationClassification = (typeof CODEX_AUTH_CLASSIFICATIONS)[number];

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface CodexModelPolicy {
  readonly modelId: string;
  readonly efforts: readonly CodexEffort[];
}

export interface CodexCeilings {
  readonly maxTurns: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxProcessOutputBytes: number;
  readonly maxCostMicros: number;
}

export interface CodexDeadlines {
  readonly operationMs: number;
  readonly handshakeMs: number;
  readonly requestMs: number;
  readonly shutdownMs: number;
}

export interface CodexJsonlBounds {
  readonly maxRecordBytes: number;
  readonly maxRecords: number;
  readonly maxStreamBytes: number;
  readonly maxPendingRequests: number;
  readonly maxRequestId: number;
  readonly maxQueuedEvents: number;
  readonly maxQueuedEventBytes: number;
  readonly maxQueuedWriteBytes: number;
}

export interface CodexSessionPolicy {
  readonly persistence: "ephemeral-only" | "policy-controlled";
  readonly retentionMs: number;
}

export interface CodexCompatibilityRange {
  readonly minimum: string;
  readonly validatedMaximum: string;
}

export interface CodexAdapterConfiguration {
  readonly schemaVersion: typeof CODEX_ADAPTER_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly executable: TrustedToolDescriptor;
  readonly compatibility: CodexCompatibilityRange;
  readonly models: readonly CodexModelPolicy[];
  readonly defaultModel: string | null;
  readonly defaultEffort: CodexEffort | null;
  readonly ceilings: CodexCeilings;
  readonly deadlines: CodexDeadlines;
  readonly jsonl: CodexJsonlBounds;
  readonly sessions: CodexSessionPolicy;
  readonly sandboxMappings: readonly CodexSandboxMapping[];
  readonly approvalMappings: readonly CodexApprovalMapping[];
  readonly dataClassifications: readonly DataClassification[];
  readonly capacityStalenessMs: number;
  readonly authentication: CodexAuthenticationClassification;
}

const CONFIG_KEYS = [
  "schemaVersion", "instanceId", "executable", "compatibility", "models",
  "defaultModel", "defaultEffort", "ceilings", "deadlines", "jsonl", "sessions",
  "sandboxMappings", "approvalMappings", "dataClassifications", "capacityStalenessMs",
  "authentication",
] as const;

function rejected(message: string, field: string): never {
  throw new ProviderError("INVALID_REQUEST", message, { detailCode: "configuration-invalid", field });
}

function safeValue(value: unknown, path: string, maxLength = 128): string {
  const text = ensureString(value, path, { minLength: 1, maxLength });
  if (text.startsWith("-") || /[\u0000-\u001f\u007f]/.test(text)) {
    rejected("A Codex configuration string is unsafe.", path);
  }
  return text;
}

function parseVersion(value: unknown, path: string): string {
  return ensureString(value, path, { maxLength: 64, pattern: VERSION, patternName: "Codex version" });
}

function integer(record: Record<string, unknown>, key: string, path: string, min: number, max: number): number {
  return ensureSafeInteger(record[key], `${path}.${key}`, min, max);
}

export function parseCodexAdapterConfiguration(value: unknown, path = "codex"): CodexAdapterConfiguration {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, CONFIG_KEYS, path);
  if (record["schemaVersion"] !== CODEX_ADAPTER_SCHEMA_VERSION) rejected("Unsupported Codex adapter schema version.", `${path}.schemaVersion`);

  const executable = parseTrustedToolDescriptor(record["executable"], `${path}.executable`);
  if (executable.toolId !== "codex") rejected("The executable descriptor must identify Codex.", `${path}.executable.toolId`);
  if (/\.(?:cmd|bat)$/i.test(executable.executablePath)) rejected("Windows command shims are not trusted Codex images.", `${path}.executable.executablePath`);
  const pinned = executable.argumentPolicy.pinnedLeadingArguments;
  if (pinned !== null) {
    if (pinned.length === 0 || pinned.length > 4) rejected("The trusted Codex argument prefix is invalid.", `${path}.executable.argumentPolicy`);
    pinned.forEach((argument, index) => {
      if (argument.startsWith("-") || /[\u0000-\u001f\u007f]/.test(argument)) rejected("The trusted Codex argument prefix is unsafe.", `${path}.executable.argumentPolicy.pinnedLeadingArguments[${index}]`);
    });
  }

  const compatibilityRecord = ensureRecord(record["compatibility"], `${path}.compatibility`);
  ensureExactKeys(compatibilityRecord, ["minimum", "validatedMaximum"], `${path}.compatibility`);
  const compatibility = Object.freeze({
    minimum: parseVersion(compatibilityRecord["minimum"], `${path}.compatibility.minimum`),
    validatedMaximum: parseVersion(compatibilityRecord["validatedMaximum"], `${path}.compatibility.validatedMaximum`),
  });

  const models = Object.freeze(ensureArray(record["models"], `${path}.models`, 64).map((entry, index) => {
    const model = ensureRecord(entry, `${path}.models[${index}]`);
    ensureExactKeys(model, ["modelId", "efforts"], `${path}.models[${index}]`);
    return Object.freeze({
      modelId: safeValue(model["modelId"], `${path}.models[${index}].modelId`),
      efforts: Object.freeze([...new Set(ensureArray(model["efforts"], `${path}.models[${index}].efforts`, CODEX_EFFORTS.length).map((effort, effortIndex) => ensureEnum(effort, `${path}.models[${index}].efforts[${effortIndex}]`, CODEX_EFFORTS)))]),
    });
  }));
  if (models.length === 0 || new Set(models.map((model) => model.modelId)).size !== models.length) rejected("Permitted Codex models must be non-empty and unique.", `${path}.models`);

  const defaultModel = record["defaultModel"] === null ? null : safeValue(record["defaultModel"], `${path}.defaultModel`);
  const defaultEffort = record["defaultEffort"] === null ? null : ensureEnum(record["defaultEffort"], `${path}.defaultEffort`, CODEX_EFFORTS);
  if ((defaultModel === null) !== (defaultEffort === null)) rejected("Default model and effort must be configured together.", `${path}.defaultModel`);
  if (defaultModel !== null && !models.some((model) => model.modelId === defaultModel && model.efforts.includes(defaultEffort!))) rejected("The configured defaults are not permitted.", `${path}.defaultModel`);

  const ceilingsRecord = ensureRecord(record["ceilings"], `${path}.ceilings`);
  ensureExactKeys(ceilingsRecord, ["maxTurns", "maxInputTokens", "maxOutputTokens", "maxProcessOutputBytes", "maxCostMicros"], `${path}.ceilings`);
  const ceilings = Object.freeze({
    maxTurns: integer(ceilingsRecord, "maxTurns", `${path}.ceilings`, 1, 1_000),
    maxInputTokens: integer(ceilingsRecord, "maxInputTokens", `${path}.ceilings`, 1, 2_000_000_000),
    maxOutputTokens: integer(ceilingsRecord, "maxOutputTokens", `${path}.ceilings`, 1, 2_000_000_000),
    maxProcessOutputBytes: integer(ceilingsRecord, "maxProcessOutputBytes", `${path}.ceilings`, 1_024, 1_073_741_824),
    maxCostMicros: integer(ceilingsRecord, "maxCostMicros", `${path}.ceilings`, 0, 1_000_000_000_000),
  });

  const deadlinesRecord = ensureRecord(record["deadlines"], `${path}.deadlines`);
  ensureExactKeys(deadlinesRecord, ["operationMs", "handshakeMs", "requestMs", "shutdownMs"], `${path}.deadlines`);
  const deadlines = Object.freeze({
    operationMs: integer(deadlinesRecord, "operationMs", `${path}.deadlines`, 1, 86_400_000),
    handshakeMs: integer(deadlinesRecord, "handshakeMs", `${path}.deadlines`, 1, 120_000),
    requestMs: integer(deadlinesRecord, "requestMs", `${path}.deadlines`, 1, 3_600_000),
    shutdownMs: integer(deadlinesRecord, "shutdownMs", `${path}.deadlines`, 1, 120_000),
  });

  const jsonlRecord = ensureRecord(record["jsonl"], `${path}.jsonl`);
  ensureExactKeys(jsonlRecord, ["maxRecordBytes", "maxRecords", "maxStreamBytes", "maxPendingRequests", "maxRequestId", "maxQueuedEvents", "maxQueuedEventBytes", "maxQueuedWriteBytes"], `${path}.jsonl`);
  const jsonl = Object.freeze({
    maxRecordBytes: integer(jsonlRecord, "maxRecordBytes", `${path}.jsonl`, 128, 16_777_216),
    maxRecords: integer(jsonlRecord, "maxRecords", `${path}.jsonl`, 1, 1_000_000),
    maxStreamBytes: integer(jsonlRecord, "maxStreamBytes", `${path}.jsonl`, 1_024, 1_073_741_824),
    maxPendingRequests: integer(jsonlRecord, "maxPendingRequests", `${path}.jsonl`, 1, 65_536),
    maxRequestId: integer(jsonlRecord, "maxRequestId", `${path}.jsonl`, 1, Number.MAX_SAFE_INTEGER),
    maxQueuedEvents: integer(jsonlRecord, "maxQueuedEvents", `${path}.jsonl`, 1, 65_536),
    maxQueuedEventBytes: integer(jsonlRecord, "maxQueuedEventBytes", `${path}.jsonl`, 128, 67_108_864),
    maxQueuedWriteBytes: integer(jsonlRecord, "maxQueuedWriteBytes", `${path}.jsonl`, 128, 67_108_864),
  });
  if (jsonl.maxRecordBytes > jsonl.maxStreamBytes || jsonl.maxRecordBytes > jsonl.maxQueuedEventBytes || jsonl.maxRecordBytes > jsonl.maxQueuedWriteBytes) rejected("JSONL bounds must admit one complete record.", `${path}.jsonl`);

  const sessionsRecord = ensureRecord(record["sessions"], `${path}.sessions`);
  ensureExactKeys(sessionsRecord, ["persistence", "retentionMs"], `${path}.sessions`);
  const sessions = Object.freeze({
    persistence: ensureEnum(sessionsRecord["persistence"], `${path}.sessions.persistence`, ["ephemeral-only", "policy-controlled"] as const),
    retentionMs: integer(sessionsRecord, "retentionMs", `${path}.sessions`, 0, 31_536_000_000),
  });
  if (sessions.persistence === "ephemeral-only" && sessions.retentionMs !== 0) rejected("Ephemeral sessions cannot have retention.", `${path}.sessions.retentionMs`);

  const sandboxMappings = Object.freeze([...new Set(ensureArray(record["sandboxMappings"], `${path}.sandboxMappings`, 2).map((entry, index) => ensureEnum(entry, `${path}.sandboxMappings[${index}]`, CODEX_SANDBOX_MAPPINGS)))]);
  const approvalMappings = Object.freeze([...new Set(ensureArray(record["approvalMappings"], `${path}.approvalMappings`, 2).map((entry, index) => ensureEnum(entry, `${path}.approvalMappings[${index}]`, CODEX_APPROVAL_MAPPINGS)))]);
  const dataClassifications = Object.freeze([...new Set(ensureArray(record["dataClassifications"], `${path}.dataClassifications`, 16).map((entry, index) => ensureEnum(entry, `${path}.dataClassifications[${index}]`, ["public", "internal", "proprietary-source", "personal", "secret"] as const)))]);
  if (!sandboxMappings.includes("read-only") || !approvalMappings.includes("never") || dataClassifications.length === 0) rejected("Required conservative mappings are missing.", path);

  return Object.freeze({
    schemaVersion: CODEX_ADAPTER_SCHEMA_VERSION,
    instanceId: ensureString(record["instanceId"], `${path}.instanceId`, { maxLength: 128, pattern: ID, patternName: "instance id" }),
    executable,
    compatibility,
    models,
    defaultModel,
    defaultEffort,
    ceilings,
    deadlines,
    jsonl,
    sessions,
    sandboxMappings,
    approvalMappings,
    dataClassifications,
    capacityStalenessMs: ensureSafeInteger(record["capacityStalenessMs"], `${path}.capacityStalenessMs`, 1_000, 86_400_000),
    authentication: ensureEnum(record["authentication"], `${path}.authentication`, CODEX_AUTH_CLASSIFICATIONS),
  });
}

export interface CodexAdapterConfigurationInput extends Omit<CodexAdapterConfiguration, "schemaVersion" | "executable"> {
  readonly executable: TrustedToolDescriptor | unknown;
}

export function createCodexAdapterConfiguration(input: CodexAdapterConfigurationInput): CodexAdapterConfiguration {
  return parseCodexAdapterConfiguration({ schemaVersion: CODEX_ADAPTER_SCHEMA_VERSION, ...input });
}

export function codexConfigurationFingerprint(configuration: CodexAdapterConfiguration): string {
  const safe = canonicalizeJson({
    schemaVersion: configuration.schemaVersion,
    instanceId: configuration.instanceId,
    executable: configuration.executable,
    compatibility: configuration.compatibility,
    models: configuration.models,
    defaultModel: configuration.defaultModel,
    defaultEffort: configuration.defaultEffort,
    ceilings: configuration.ceilings,
    deadlines: configuration.deadlines,
    jsonl: configuration.jsonl,
    sessions: configuration.sessions,
    sandboxMappings: configuration.sandboxMappings,
    approvalMappings: configuration.approvalMappings,
    dataClassifications: configuration.dataClassifications,
    capacityStalenessMs: configuration.capacityStalenessMs,
    authentication: configuration.authentication,
  });
  return createHash("sha256").update(toCanonicalJson(safe)).digest("hex");
}
