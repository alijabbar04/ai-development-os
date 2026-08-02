import { ensureString } from "./internal/guards.js";

declare const brandSymbol: unique symbol;

/** Nominal branding helper shared by every branded domain value. */
export type Branded<TBrand extends string> = { readonly [brandSymbol]: TBrand };

/**
 * All identifiers share one canonical shape: 1-128 characters drawn from
 * letters, digits, and `._:-`, starting with a letter or digit. IDs are
 * opaque; no routing or policy behavior may be inferred from their content.
 */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ProjectId = string & Branded<"ProjectId">;
export type RunId = string & Branded<"RunId">;
export type TaskId = string & Branded<"TaskId">;
/** One leased execution of a task (the technical design's "Attempt"). */
export type TaskRunId = string & Branded<"TaskRunId">;
export type LeaseId = string & Branded<"LeaseId">;
export type ApprovalId = string & Branded<"ApprovalId">;
export type EventId = string & Branded<"EventId">;
export type AgentId = string & Branded<"AgentId">;
export type ProviderId = string & Branded<"ProviderId">;
export type ModelId = string & Branded<"ModelId">;
export type ArtifactId = string & Branded<"ArtifactId">;
export type WorkspaceId = string & Branded<"WorkspaceId">;
export type TraceId = string & Branded<"TraceId">;

function createIdParser<TId extends string>(label: string): {
  readonly parse: (value: unknown, path?: string) => TId;
  readonly is: (value: unknown) => value is TId;
} {
  return {
    parse: (value: unknown, path = label): TId =>
      ensureString(value, path, {
        maxLength: 128,
        pattern: ID_PATTERN,
        patternName: label,
      }) as TId,
    is: (value: unknown): value is TId =>
      typeof value === "string" && ID_PATTERN.test(value),
  };
}

const projectIdParser = createIdParser<ProjectId>("ProjectId");
const runIdParser = createIdParser<RunId>("RunId");
const taskIdParser = createIdParser<TaskId>("TaskId");
const taskRunIdParser = createIdParser<TaskRunId>("TaskRunId");
const leaseIdParser = createIdParser<LeaseId>("LeaseId");
const approvalIdParser = createIdParser<ApprovalId>("ApprovalId");
const eventIdParser = createIdParser<EventId>("EventId");
const agentIdParser = createIdParser<AgentId>("AgentId");
const providerIdParser = createIdParser<ProviderId>("ProviderId");
const modelIdParser = createIdParser<ModelId>("ModelId");
const artifactIdParser = createIdParser<ArtifactId>("ArtifactId");
const workspaceIdParser = createIdParser<WorkspaceId>("WorkspaceId");
const traceIdParser = createIdParser<TraceId>("TraceId");

export const parseProjectId = projectIdParser.parse;
export const isProjectId = projectIdParser.is;
export const parseRunId = runIdParser.parse;
export const isRunId = runIdParser.is;
export const parseTaskId = taskIdParser.parse;
export const isTaskId = taskIdParser.is;
export const parseTaskRunId = taskRunIdParser.parse;
export const isTaskRunId = taskRunIdParser.is;
export const parseLeaseId = leaseIdParser.parse;
export const isLeaseId = leaseIdParser.is;
export const parseApprovalId = approvalIdParser.parse;
export const isApprovalId = approvalIdParser.is;
export const parseEventId = eventIdParser.parse;
export const isEventId = eventIdParser.is;
export const parseAgentId = agentIdParser.parse;
export const isAgentId = agentIdParser.is;
export const parseProviderId = providerIdParser.parse;
export const isProviderId = providerIdParser.is;
export const parseModelId = modelIdParser.parse;
export const isModelId = modelIdParser.is;
export const parseArtifactId = artifactIdParser.parse;
export const isArtifactId = artifactIdParser.is;
export const parseWorkspaceId = workspaceIdParser.parse;
export const isWorkspaceId = workspaceIdParser.is;
export const parseTraceId = traceIdParser.parse;
export const isTraceId = traceIdParser.is;
