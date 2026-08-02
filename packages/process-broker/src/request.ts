/**
 * The process request.
 *
 * A request names an executable and an argument array. There is no
 * command-string form, and no option anywhere turns one on: a string handed to
 * a shell is a different and materially more dangerous action than an
 * executable plus arguments, and the two are not interchangeable.
 *
 * Shell execution is therefore not represented in this package at all. If it
 * is ever added it must arrive as its own finite action category, denied by
 * default, separately approved, supported only by a backend that can contain
 * it, and separately tested. Deferring it is the honest option today.
 */

import { validation } from "@ai-dev-os/domain";
import type { SafeRelativePath } from "@ai-dev-os/artifacts";
import { invalidRequest } from "./errors.js";
import { parseWorkspaceRelativePath } from "./paths.js";
import {
  parseEnvironmentBindings,
  type EnvironmentBinding,
} from "./environment.js";
import { DEFAULT_OUTPUT_LIMITS, parseOutputLimits, type OutputLimits } from "./output.js";
import {
  DENY_ALL_NETWORK,
  parseNetworkPolicy,
  parseProcessQuotas,
  type NetworkPolicy,
  type ProcessQuotas,
} from "./quota.js";
import {
  applyArgumentPolicy,
  parseTrustedToolDescriptor,
  type TrustedToolDescriptor,
} from "./tool.js";

const { ensureArray, ensureExactKeys, ensureRecord, ensureString, ensureTimestamp } = validation;

export const PROCESS_REQUEST_SCHEMA_VERSION = 1 as const;

export const MAX_STDIN_BYTES = 1_048_576;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function ensureId(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 128,
    pattern: ID_PATTERN,
    patternName: "identifier",
  });
}

function ensureNullableId(value: unknown, path: string): string | null {
  return value === undefined || value === null ? null : ensureId(value, path);
}

function ensureDigest(value: unknown, path: string): string {
  return ensureString(value, path, {
    minLength: 64,
    maxLength: 64,
    pattern: DIGEST_PATTERN,
    patternName: "sha-256 digest",
  });
}

export type StdinMode =
  | { readonly kind: "none" }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array };

export interface ExecutionTrace {
  readonly traceId: string;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly taskRunId: string | null;
}

export interface ProcessRequest {
  readonly schemaVersion: typeof PROCESS_REQUEST_SCHEMA_VERSION;
  readonly requestId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly workspaceLeaseId: string;
  readonly attemptId: string;
  readonly grantId: string;
  readonly policyDecisionFingerprint: string;
  readonly approvalEvidenceRefs: readonly string[];
  readonly tool: TrustedToolDescriptor;
  /** Caller arguments. The tool's pinned prefix is prepended at spawn time. */
  readonly args: readonly string[];
  /** Working directory relative to the workspace root. Never ambient. */
  readonly workingSubdirectory: SafeRelativePath | null;
  readonly stdin: StdinMode;
  readonly quotas: ProcessQuotas;
  readonly network: NetworkPolicy;
  readonly outputLimits: OutputLimits;
  readonly environment: readonly EnvironmentBinding[];
  /** Exit codes treated as success. Empty means "zero only". */
  readonly successExitCodes: readonly number[];
  readonly deadline: string | null;
  readonly trace: ExecutionTrace;
}

const REQUEST_KEYS = [
  "schemaVersion",
  "requestId",
  "projectId",
  "workspaceId",
  "workspaceLeaseId",
  "attemptId",
  "grantId",
  "policyDecisionFingerprint",
  "approvalEvidenceRefs",
  "tool",
  "args",
  "workingSubdirectory",
  "stdin",
  "quotas",
  "network",
  "outputLimits",
  "environment",
  "successExitCodes",
  "deadline",
  "trace",
] as const;

const TRACE_KEYS = ["traceId", "runId", "taskId", "taskRunId"] as const;

function parseTrace(value: unknown, path: string): ExecutionTrace {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, TRACE_KEYS, path);
  return Object.freeze({
    traceId: ensureId(record["traceId"], `${path}.traceId`),
    runId: ensureNullableId(record["runId"], `${path}.runId`),
    taskId: ensureNullableId(record["taskId"], `${path}.taskId`),
    taskRunId: ensureNullableId(record["taskRunId"], `${path}.taskRunId`),
  });
}

function parseStdin(value: unknown, path: string): StdinMode {
  const record = ensureRecord(value, path);
  const kind = validation.ensureEnum(record["kind"], `${path}.kind`, ["none", "bytes"] as const);
  if (kind === "none") {
    ensureExactKeys(record, ["kind"], path);
    return Object.freeze({ kind });
  }
  ensureExactKeys(record, ["kind", "bytes"], path);
  const bytes = record["bytes"];
  if (!(bytes instanceof Uint8Array)) {
    throw invalidRequest("Standard input must be supplied as bytes.", { field: `${path}.bytes` });
  }
  if (bytes.byteLength > MAX_STDIN_BYTES) {
    throw invalidRequest("Standard input exceeds the byte limit.", {
      field: `${path}.bytes`,
      byteLength: bytes.byteLength,
      maxBytes: MAX_STDIN_BYTES,
    });
  }
  return Object.freeze({ kind, bytes: new Uint8Array(bytes) });
}

export function parseProcessRequest(value: unknown, path = "request"): ProcessRequest {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, REQUEST_KEYS, path);
  validation.ensureSchemaVersion(
    record["schemaVersion"],
    `${path}.schemaVersion`,
    PROCESS_REQUEST_SCHEMA_VERSION,
  );

  // A rejected field name is reported; a rejected value never is.
  if ("shell" in record || "command" in record || "commandLine" in record) {
    throw invalidRequest("Shell and command-string execution are not representable.", {
      field: path,
    });
  }

  const tool = parseTrustedToolDescriptor(record["tool"], `${path}.tool`);
  const rawArgs = ensureArray(record["args"], `${path}.args`, tool.argumentPolicy.maxArguments);
  const args = rawArgs.map((entry, index) =>
    ensureString(entry, `${path}.args[${index}]`, {
      minLength: 0,
      maxLength: tool.argumentPolicy.maxArgumentBytes,
    }),
  );
  // Validate now so an invalid command is rejected before admission, not at
  // spawn time when a lease and a sandbox may already be held.
  applyArgumentPolicy(tool, args);

  const workingValue = record["workingSubdirectory"];
  const workingSubdirectory =
    workingValue === undefined || workingValue === null
      ? null
      : parseWorkspaceRelativePath(workingValue, `${path}.workingSubdirectory`);

  const rawExitCodes = ensureArray(record["successExitCodes"], `${path}.successExitCodes`, 32);
  const successExitCodes = rawExitCodes.map((entry, index) =>
    validation.ensureSafeInteger(entry, `${path}.successExitCodes[${index}]`, 0, 255),
  );

  const evidenceRefs = ensureArray(record["approvalEvidenceRefs"], `${path}.approvalEvidenceRefs`, 32);
  const deadlineValue = record["deadline"];

  const quotas = parseProcessQuotas(record["quotas"], `${path}.quotas`);
  const outputLimits = parseOutputLimits(record["outputLimits"], `${path}.outputLimits`);
  if (outputLimits.maxCombinedBytes > quotas.outputBytes) {
    throw invalidRequest("The output limits exceed the requested output quota.", { field: path });
  }

  return Object.freeze({
    schemaVersion: PROCESS_REQUEST_SCHEMA_VERSION,
    requestId: ensureId(record["requestId"], `${path}.requestId`),
    projectId: ensureId(record["projectId"], `${path}.projectId`),
    workspaceId: ensureId(record["workspaceId"], `${path}.workspaceId`),
    workspaceLeaseId: ensureId(record["workspaceLeaseId"], `${path}.workspaceLeaseId`),
    attemptId: ensureId(record["attemptId"], `${path}.attemptId`),
    grantId: ensureId(record["grantId"], `${path}.grantId`),
    policyDecisionFingerprint: ensureDigest(
      record["policyDecisionFingerprint"],
      `${path}.policyDecisionFingerprint`,
    ),
    approvalEvidenceRefs: Object.freeze(
      [
        ...new Set(
          evidenceRefs.map((entry, index) => ensureId(entry, `${path}.approvalEvidenceRefs[${index}]`)),
        ),
      ].sort(),
    ),
    tool,
    args: Object.freeze([...args]),
    workingSubdirectory,
    stdin: parseStdin(record["stdin"], `${path}.stdin`),
    quotas,
    network: parseNetworkPolicy(record["network"], `${path}.network`),
    outputLimits,
    environment: parseEnvironmentBindings(record["environment"], `${path}.environment`),
    successExitCodes: Object.freeze([...new Set(successExitCodes)].sort((a, b) => a - b)),
    deadline:
      deadlineValue === undefined || deadlineValue === null
        ? null
        : ensureTimestamp(deadlineValue, `${path}.deadline`),
    trace: parseTrace(record["trace"], `${path}.trace`),
  });
}

export function createProcessRequest(input: {
  readonly requestId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly workspaceLeaseId: string;
  readonly attemptId: string;
  readonly grantId: string;
  readonly policyDecisionFingerprint: string;
  readonly tool: TrustedToolDescriptor;
  readonly args: readonly string[];
  readonly quotas: ProcessQuotas;
  readonly trace: ExecutionTrace;
  readonly approvalEvidenceRefs?: readonly string[];
  readonly workingSubdirectory?: string | null;
  readonly stdin?: StdinMode;
  readonly network?: NetworkPolicy;
  readonly outputLimits?: OutputLimits;
  readonly environment?: readonly EnvironmentBinding[];
  readonly successExitCodes?: readonly number[];
  readonly deadline?: string | null;
}): ProcessRequest {
  // Output limits default to the request's own output quota, so lowering the
  // quota tightens buffering instead of producing a contradictory request.
  const quotaBytes = input.quotas.outputBytes;
  const defaultOutputLimits: OutputLimits = {
    maxStreamBytes: Math.min(DEFAULT_OUTPUT_LIMITS.maxStreamBytes, quotaBytes),
    maxCombinedBytes: Math.min(DEFAULT_OUTPUT_LIMITS.maxCombinedBytes, quotaBytes),
    maxLineBytes: DEFAULT_OUTPUT_LIMITS.maxLineBytes,
  };
  return parseProcessRequest({
    schemaVersion: PROCESS_REQUEST_SCHEMA_VERSION,
    requestId: input.requestId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    workspaceLeaseId: input.workspaceLeaseId,
    attemptId: input.attemptId,
    grantId: input.grantId,
    policyDecisionFingerprint: input.policyDecisionFingerprint,
    approvalEvidenceRefs: input.approvalEvidenceRefs ?? [],
    tool: input.tool,
    args: input.args,
    workingSubdirectory: input.workingSubdirectory ?? null,
    stdin: input.stdin ?? { kind: "none" },
    quotas: input.quotas,
    network: input.network ?? DENY_ALL_NETWORK,
    outputLimits: input.outputLimits ?? defaultOutputLimits,
    environment: input.environment ?? [],
    successExitCodes: input.successExitCodes ?? [],
    deadline: input.deadline ?? null,
    trace: input.trace,
  });
}

export function isSuccessExit(request: ProcessRequest, exitCode: number | null): boolean {
  if (exitCode === null) {
    return false;
  }
  if (request.successExitCodes.length === 0) {
    return exitCode === 0;
  }
  return request.successExitCodes.includes(exitCode);
}
