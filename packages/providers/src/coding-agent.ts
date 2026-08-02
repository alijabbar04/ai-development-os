import {
  parseAggregateBudget,
  validation,
  type AggregateBudget,
  type ArtifactId,
  type ModelId,
  type WorkspaceId,
} from "@ai-dev-os/domain";
import { ARTIFACT_KINDS, parseSafeRelativePath, type ArtifactKind } from "@ai-dev-os/artifacts";
import { ProviderError } from "./errors.js";
import {
  parseDeadline,
  parseDisclosureContext,
  parseExecutionTraceMetadata,
  parseProviderExtensions,
  parseProviderOperationId,
  parseProviderRequestId,
  PROVIDER_CONTRACT_SCHEMA_VERSION,
  type DisclosureContext,
  type ExecutionTraceMetadata,
  type ProviderExtension,
  type ProviderOperationId,
  type ProviderRequestId,
} from "./common.js";
import {
  parseEstimatedUsage,
  parseProviderCost,
  parseProviderLatency,
  parseProviderUsage,
  type EstimatedUsage,
  type ProviderCost,
  type ProviderLatency,
  type ProviderUsage,
} from "./usage.js";

const {
  ensureArray,
  ensureEnum,
  ensureEnumArray,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
} = validation;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const MAX_INSTRUCTIONS_LENGTH = 100_000;
export const MAX_INPUT_ARTIFACTS = 64;
export const MAX_CHANGED_FILES = 4_096;

/** Operations a coding agent may be granted. Grants describe intent; a later
 * execution sandbox enforces them — this contract conveys no actual access. */
export const CODING_CAPABILITIES = Object.freeze([
  "read-files",
  "edit-files",
  "run-commands",
  "run-tests",
  "git-commit",
] as const);

export type CodingCapability = (typeof CODING_CAPABILITIES)[number];

export const COMMAND_POLICY_MODES = Object.freeze(["none", "allow-listed", "sandboxed"] as const);
export type CommandPolicyMode = (typeof COMMAND_POLICY_MODES)[number];

export interface CommandPolicy {
  readonly mode: CommandPolicyMode;
  /** Executable names permitted under "allow-listed"; empty otherwise. */
  readonly allowedCommands: readonly string[];
}

export function parseCommandPolicy(value: unknown, path = "commandPolicy"): CommandPolicy {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["mode", "allowedCommands"], path);
  const mode = ensureEnum(record["mode"], `${path}.mode`, COMMAND_POLICY_MODES);
  const allowedCommands = Object.freeze(
    ensureArray(record["allowedCommands"] ?? [], `${path}.allowedCommands`, 64).map(
      (command, index) =>
        ensureString(command, `${path}.allowedCommands[${index}]`, {
          maxLength: 64,
          pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/,
          patternName: "command name",
        }),
    ),
  );
  if (mode !== "allow-listed" && allowedCommands.length > 0) {
    throw new ProviderError("INVALID_REQUEST", "allowedCommands requires allow-listed mode.", {
      path,
    });
  }
  return Object.freeze({ mode, allowedCommands });
}

export const NETWORK_POLICIES = Object.freeze(["denied", "proxied"] as const);
export type NetworkPolicy = (typeof NETWORK_POLICIES)[number];

export const APPROVAL_MODES = Object.freeze(["never", "on-risk", "always"] as const);
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Workspace-relative path prefixes the agent may touch; empty = whole workspace. */
export interface FileAccessPolicy {
  readonly allowedPathPrefixes: readonly string[];
}

export function parseFileAccessPolicy(value: unknown, path = "fileAccess"): FileAccessPolicy {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["allowedPathPrefixes"], path);
  return Object.freeze({
    allowedPathPrefixes: Object.freeze(
      ensureArray(record["allowedPathPrefixes"] ?? [], `${path}.allowedPathPrefixes`, 64).map(
        (prefix, index) =>
          parseSafeRelativePath(prefix, `${path}.allowedPathPrefixes[${index}]`) as string,
      ),
    ),
  });
}

export interface CodingAgentRequest {
  readonly schemaVersion: typeof PROVIDER_CONTRACT_SCHEMA_VERSION;
  readonly requestId: ProviderRequestId;
  /** The underlying model, when the agent exposes a choice; else null. */
  readonly modelId: ModelId | null;
  /** Later resolved to a managed worktree by the workspace layer (Stage 8). */
  readonly workspaceId: WorkspaceId;
  readonly baseRevision: string | null;
  readonly instructions: string;
  readonly capabilities: readonly CodingCapability[];
  readonly fileAccess: FileAccessPolicy;
  readonly commandPolicy: CommandPolicy;
  readonly networkPolicy: NetworkPolicy;
  readonly approvalMode: ApprovalMode;
  readonly maxChangedFiles: number;
  readonly maxProducedBytes: number;
  readonly budget: AggregateBudget | null;
  readonly estimatedUsage: EstimatedUsage | null;
  readonly deadline: string | null;
  readonly disclosure: DisclosureContext;
  readonly inputArtifacts: readonly ArtifactId[];
  readonly expectedOutputKinds: readonly ArtifactKind[];
  /** Opaque provider-issued marker to resume prior work, when supported. */
  readonly resumeToken: string | null;
  readonly trace: ExecutionTraceMetadata;
  readonly extensions: readonly ProviderExtension[];
}

const REQUEST_KEYS = [
  "schemaVersion",
  "requestId",
  "modelId",
  "workspaceId",
  "baseRevision",
  "instructions",
  "capabilities",
  "fileAccess",
  "commandPolicy",
  "networkPolicy",
  "approvalMode",
  "maxChangedFiles",
  "maxProducedBytes",
  "budget",
  "estimatedUsage",
  "deadline",
  "disclosure",
  "inputArtifacts",
  "expectedOutputKinds",
  "resumeToken",
  "trace",
  "extensions",
] as const;

export function parseCodingAgentRequest(
  value: unknown,
  path = "codingAgentRequest",
): CodingAgentRequest {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, REQUEST_KEYS, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, PROVIDER_CONTRACT_SCHEMA_VERSION);

  const capabilities = ensureEnumArray(
    record["capabilities"],
    `${path}.capabilities`,
    CODING_CAPABILITIES,
    CODING_CAPABILITIES.length,
  );
  const commandPolicy = parseCommandPolicy(record["commandPolicy"], `${path}.commandPolicy`);
  if (commandPolicy.mode !== "none" && !capabilities.includes("run-commands")) {
    throw new ProviderError(
      "INVALID_REQUEST",
      "A command policy other than none requires the run-commands capability.",
      { path },
    );
  }

  return Object.freeze({
    schemaVersion: PROVIDER_CONTRACT_SCHEMA_VERSION,
    requestId: parseProviderRequestId(record["requestId"], `${path}.requestId`),
    modelId: ensureNullable(record["modelId"], (raw) =>
      ensureString(raw, `${path}.modelId`, { maxLength: 128, pattern: ID_PATTERN, patternName: "ModelId" }) as ModelId,
    ),
    workspaceId: ensureString(record["workspaceId"], `${path}.workspaceId`, {
      maxLength: 128,
      pattern: ID_PATTERN,
      patternName: "WorkspaceId",
    }) as WorkspaceId,
    baseRevision: ensureNullable(record["baseRevision"], (raw) =>
      ensureString(raw, `${path}.baseRevision`, {
        maxLength: 128,
        pattern: REVISION_PATTERN,
        patternName: "revision",
      }),
    ),
    instructions: ensureString(record["instructions"], `${path}.instructions`, {
      maxLength: MAX_INSTRUCTIONS_LENGTH,
    }),
    capabilities,
    fileAccess: parseFileAccessPolicy(record["fileAccess"], `${path}.fileAccess`),
    commandPolicy,
    networkPolicy: ensureEnum(record["networkPolicy"], `${path}.networkPolicy`, NETWORK_POLICIES),
    approvalMode: ensureEnum(record["approvalMode"], `${path}.approvalMode`, APPROVAL_MODES),
    maxChangedFiles: ensureSafeInteger(record["maxChangedFiles"], `${path}.maxChangedFiles`, 0, MAX_CHANGED_FILES),
    maxProducedBytes: ensureSafeInteger(
      record["maxProducedBytes"],
      `${path}.maxProducedBytes`,
      1,
      1_000_000_000_000,
    ),
    budget: ensureNullable(record["budget"], (raw) => parseAggregateBudget(raw, `${path}.budget`)),
    estimatedUsage: ensureNullable(record["estimatedUsage"], (raw) =>
      parseEstimatedUsage(raw, `${path}.estimatedUsage`),
    ),
    deadline: ensureNullable(record["deadline"], (raw) => parseDeadline(raw, `${path}.deadline`)),
    disclosure: parseDisclosureContext(record["disclosure"], `${path}.disclosure`),
    inputArtifacts: Object.freeze(
      ensureArray(record["inputArtifacts"] ?? [], `${path}.inputArtifacts`, MAX_INPUT_ARTIFACTS).map(
        (artifact, index) =>
          ensureString(artifact, `${path}.inputArtifacts[${index}]`, {
            maxLength: 128,
            pattern: ID_PATTERN,
            patternName: "ArtifactId",
          }) as ArtifactId,
      ),
    ),
    expectedOutputKinds: ensureEnumArray(
      record["expectedOutputKinds"] ?? [],
      `${path}.expectedOutputKinds`,
      ARTIFACT_KINDS,
      ARTIFACT_KINDS.length,
    ),
    resumeToken: ensureNullable(record["resumeToken"], (raw) =>
      ensureString(raw, `${path}.resumeToken`, { maxLength: 256 }),
    ),
    trace: parseExecutionTraceMetadata(record["trace"], `${path}.trace`),
    extensions: parseProviderExtensions(record["extensions"], `${path}.extensions`),
  });
}

export interface CodingAgentRequestInput
  extends Omit<
    Partial<CodingAgentRequest>,
    "schemaVersion" | "requestId" | "workspaceId" | "instructions" | "disclosure" | "trace"
  > {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly instructions: string;
  readonly disclosure: DisclosureContext | unknown;
  readonly trace: ExecutionTraceMetadata | unknown;
}

export function createCodingAgentRequest(input: CodingAgentRequestInput): CodingAgentRequest {
  return parseCodingAgentRequest({
    schemaVersion: PROVIDER_CONTRACT_SCHEMA_VERSION,
    requestId: input.requestId,
    modelId: input.modelId ?? null,
    workspaceId: input.workspaceId,
    baseRevision: input.baseRevision ?? null,
    instructions: input.instructions,
    capabilities: input.capabilities ?? ["read-files"],
    fileAccess: input.fileAccess ?? { allowedPathPrefixes: [] },
    commandPolicy: input.commandPolicy ?? { mode: "none", allowedCommands: [] },
    networkPolicy: input.networkPolicy ?? "denied",
    approvalMode: input.approvalMode ?? "on-risk",
    maxChangedFiles: input.maxChangedFiles ?? 256,
    maxProducedBytes: input.maxProducedBytes ?? 100_000_000,
    budget: input.budget ?? null,
    estimatedUsage: input.estimatedUsage ?? null,
    deadline: input.deadline ?? null,
    disclosure: input.disclosure,
    inputArtifacts: input.inputArtifacts ?? [],
    expectedOutputKinds: input.expectedOutputKinds ?? [],
    resumeToken: input.resumeToken ?? null,
    trace: input.trace,
    extensions: input.extensions ?? [],
  });
}

export const FILE_CHANGE_KINDS = Object.freeze(["added", "modified", "deleted", "renamed"] as const);
export type FileChangeKind = (typeof FILE_CHANGE_KINDS)[number];

export interface ChangedFileSummary {
  readonly path: string;
  readonly changeKind: FileChangeKind;
}

export function parseChangedFileSummary(value: unknown, path = "changedFile"): ChangedFileSummary {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["path", "changeKind"], path);
  return Object.freeze({
    path: parseSafeRelativePath(record["path"], `${path}.path`) as string,
    changeKind: ensureEnum(record["changeKind"], `${path}.changeKind`, FILE_CHANGE_KINDS),
  });
}

export const COMPLETION_CLASSIFICATIONS = Object.freeze([
  "completed",
  "completed-no-changes",
  "partial",
] as const);
export type CompletionClassification = (typeof COMPLETION_CLASSIFICATIONS)[number];

export interface TestResultSummary {
  readonly artifactId: ArtifactId | null;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface ApprovalDecision {
  readonly approvalId: string;
  readonly decision: "approved" | "denied";
}

/**
 * Coding-agent terminal result. Large outputs (patches, logs, diagnostics,
 * test reports) are Stage 4 artifact references — never inline bytes.
 */
export interface CodingAgentResult {
  readonly schemaVersion: typeof PROVIDER_CONTRACT_SCHEMA_VERSION;
  readonly operationId: ProviderOperationId;
  readonly requestId: ProviderRequestId;
  readonly completion: CompletionClassification;
  readonly patchArtifactId: ArtifactId | null;
  readonly changedFiles: readonly ChangedFileSummary[];
  readonly testResults: TestResultSummary | null;
  readonly commandLogArtifactId: ArtifactId | null;
  readonly diagnosticsArtifactId: ArtifactId | null;
  readonly producedArtifacts: readonly ArtifactId[];
  readonly baseRevision: string | null;
  readonly resultRevision: string | null;
  readonly approvalDecisions: readonly ApprovalDecision[];
  readonly usage: ProviderUsage;
  readonly cost: ProviderCost;
  readonly latency: ProviderLatency;
  readonly warnings: readonly string[];
  readonly resumeToken: string | null;
}

const RESULT_KEYS = [
  "schemaVersion",
  "operationId",
  "requestId",
  "completion",
  "patchArtifactId",
  "changedFiles",
  "testResults",
  "commandLogArtifactId",
  "diagnosticsArtifactId",
  "producedArtifacts",
  "baseRevision",
  "resultRevision",
  "approvalDecisions",
  "usage",
  "cost",
  "latency",
  "warnings",
  "resumeToken",
] as const;

export function parseCodingAgentResult(
  value: unknown,
  path = "codingAgentResult",
): CodingAgentResult {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, RESULT_KEYS, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, PROVIDER_CONTRACT_SCHEMA_VERSION);

  const parseArtifactRef = (raw: unknown, field: string): ArtifactId =>
    ensureString(raw, `${path}.${field}`, {
      maxLength: 128,
      pattern: ID_PATTERN,
      patternName: "ArtifactId",
    }) as ArtifactId;

  const completion = ensureEnum(record["completion"], `${path}.completion`, COMPLETION_CLASSIFICATIONS);
  const changedFiles = Object.freeze(
    ensureArray(record["changedFiles"], `${path}.changedFiles`, MAX_CHANGED_FILES).map(
      (file, index) => parseChangedFileSummary(file, `${path}.changedFiles[${index}]`),
    ),
  );
  if (completion === "completed-no-changes" && changedFiles.length > 0) {
    throw new ProviderError("MALFORMED_RESPONSE", "A no-change completion cannot list changed files.", {
      path,
    });
  }

  return Object.freeze({
    schemaVersion: PROVIDER_CONTRACT_SCHEMA_VERSION,
    operationId: parseProviderOperationId(record["operationId"], `${path}.operationId`),
    requestId: parseProviderRequestId(record["requestId"], `${path}.requestId`),
    completion,
    patchArtifactId: ensureNullable(record["patchArtifactId"], (raw) =>
      parseArtifactRef(raw, "patchArtifactId"),
    ),
    changedFiles,
    testResults: ensureNullable(record["testResults"], (raw) => {
      const tests = ensureRecord(raw, `${path}.testResults`);
      ensureExactKeys(tests, ["artifactId", "passed", "failed", "skipped"], `${path}.testResults`);
      return Object.freeze({
        artifactId: ensureNullable(tests["artifactId"], (id) => parseArtifactRef(id, "testResults.artifactId")),
        passed: ensureSafeInteger(tests["passed"], `${path}.testResults.passed`, 0, 1_000_000),
        failed: ensureSafeInteger(tests["failed"], `${path}.testResults.failed`, 0, 1_000_000),
        skipped: ensureSafeInteger(tests["skipped"], `${path}.testResults.skipped`, 0, 1_000_000),
      });
    }),
    commandLogArtifactId: ensureNullable(record["commandLogArtifactId"], (raw) =>
      parseArtifactRef(raw, "commandLogArtifactId"),
    ),
    diagnosticsArtifactId: ensureNullable(record["diagnosticsArtifactId"], (raw) =>
      parseArtifactRef(raw, "diagnosticsArtifactId"),
    ),
    producedArtifacts: Object.freeze(
      ensureArray(record["producedArtifacts"], `${path}.producedArtifacts`, 256).map((raw, index) =>
        parseArtifactRef(raw, `producedArtifacts[${index}]`),
      ),
    ),
    baseRevision: ensureNullable(record["baseRevision"], (raw) =>
      ensureString(raw, `${path}.baseRevision`, { maxLength: 128, pattern: REVISION_PATTERN, patternName: "revision" }),
    ),
    resultRevision: ensureNullable(record["resultRevision"], (raw) =>
      ensureString(raw, `${path}.resultRevision`, { maxLength: 128, pattern: REVISION_PATTERN, patternName: "revision" }),
    ),
    approvalDecisions: Object.freeze(
      ensureArray(record["approvalDecisions"], `${path}.approvalDecisions`, 64).map((raw, index) => {
        const decision = ensureRecord(raw, `${path}.approvalDecisions[${index}]`);
        ensureExactKeys(decision, ["approvalId", "decision"], `${path}.approvalDecisions[${index}]`);
        return Object.freeze({
          approvalId: ensureString(decision["approvalId"], `${path}.approvalDecisions[${index}].approvalId`, {
            maxLength: 128,
            pattern: ID_PATTERN,
            patternName: "approval id",
          }),
          decision: ensureEnum(
            decision["decision"],
            `${path}.approvalDecisions[${index}].decision`,
            ["approved", "denied"] as const,
          ),
        });
      }),
    ),
    usage: parseProviderUsage(record["usage"], `${path}.usage`),
    cost: parseProviderCost(record["cost"], `${path}.cost`),
    latency: parseProviderLatency(record["latency"], `${path}.latency`),
    warnings: Object.freeze(
      ensureArray(record["warnings"], `${path}.warnings`, 32).map((warning, index) =>
        ensureString(warning, `${path}.warnings[${index}]`, { maxLength: 1_000 }),
      ),
    ),
    resumeToken: ensureNullable(record["resumeToken"], (raw) =>
      ensureString(raw, `${path}.resumeToken`, { maxLength: 256 }),
    ),
  });
}
