import {
  canonicalizeJson,
  toCanonicalJson,
  validation,
  type JsonValue,
} from "@ai-dev-os/domain";
import { ProviderError } from "./errors.js";
import { parseToolCallId, parseToolName, type ToolCallId, type ToolName } from "./common.js";

const { ensureEnum, ensureExactKeys, ensureNullable, ensureRecord, ensureString } = validation;

export const TOOL_RISKS = Object.freeze(["read-only", "mutating", "destructive"] as const);
export type ToolRisk = (typeof TOOL_RISKS)[number];

export const TOOL_APPROVAL_REQUIREMENTS = Object.freeze(["never", "policy", "always"] as const);
export type ToolApprovalRequirement = (typeof TOOL_APPROVAL_REQUIREMENTS)[number];

/**
 * Where the tool actually executes. "caller": the orchestration layer runs
 * it and feeds a ToolResult back. "provider": the provider executes it
 * internally (e.g. a hosted interpreter). Nothing in this package executes
 * tools: an invocation is always an explicit request for a later,
 * policy-enforcing execution layer.
 */
export const TOOL_EXECUTION_LOCATIONS = Object.freeze(["caller", "provider"] as const);
export type ToolExecutionLocation = (typeof TOOL_EXECUTION_LOCATIONS)[number];

const MAX_SCHEMA_TEXT = 16_384;
const MAX_TOOL_VALUE_TEXT = 65_536;

function boundedCanonical(value: unknown, path: string, maxText: number): JsonValue {
  const canonical = canonicalizeJson(value, path);
  if (toCanonicalJson(canonical).length > maxText) {
    throw new ProviderError("INVALID_REQUEST", "A tool JSON value is oversized.", {
      path,
      maximum: maxText,
    });
  }
  return canonical;
}

/** Provider-neutral tool declaration offered to a model. */
export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  /** JSON-Schema-compatible object describing the tool's input. */
  readonly inputSchema: JsonValue;
  readonly risk: ToolRisk;
  readonly approval: ToolApprovalRequirement;
  readonly executionLocation: ToolExecutionLocation;
}

export function parseToolDefinition(value: unknown, path = "toolDefinition"): ToolDefinition {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["name", "description", "inputSchema", "risk", "approval", "executionLocation"],
    path,
  );
  const inputSchema = boundedCanonical(record["inputSchema"], `${path}.inputSchema`, MAX_SCHEMA_TEXT);
  if (typeof inputSchema !== "object" || inputSchema === null || Array.isArray(inputSchema)) {
    throw new ProviderError("INVALID_REQUEST", "A tool input schema must be a JSON object.", {
      path: `${path}.inputSchema`,
    });
  }
  return Object.freeze({
    name: parseToolName(record["name"], `${path}.name`),
    description: ensureString(record["description"], `${path}.description`, { maxLength: 2_000 }),
    inputSchema,
    risk: ensureEnum(record["risk"], `${path}.risk`, TOOL_RISKS),
    approval: ensureEnum(record["approval"], `${path}.approval`, TOOL_APPROVAL_REQUIREMENTS),
    executionLocation: ensureEnum(
      record["executionLocation"],
      `${path}.executionLocation`,
      TOOL_EXECUTION_LOCATIONS,
    ),
  });
}

/** Constraint on the model's freedom to call tools. */
export type ToolChoice =
  | { readonly mode: "auto" }
  | { readonly mode: "none" }
  | { readonly mode: "required" }
  | { readonly mode: "named"; readonly toolName: ToolName };

export function parseToolChoice(value: unknown, path = "toolChoice"): ToolChoice {
  const record = ensureRecord(value, path);
  const mode = ensureEnum(record["mode"], `${path}.mode`, ["auto", "none", "required", "named"] as const);
  if (mode === "named") {
    ensureExactKeys(record, ["mode", "toolName"], path);
    return Object.freeze({ mode, toolName: parseToolName(record["toolName"], `${path}.toolName`) });
  }
  ensureExactKeys(record, ["mode"], path);
  return Object.freeze({ mode });
}

/** A MODEL-GENERATED request that some tool be executed later. */
export interface ToolInvocation {
  readonly toolCallId: ToolCallId;
  readonly toolName: ToolName;
  readonly arguments: JsonValue;
}

export function parseToolInvocation(value: unknown, path = "toolInvocation"): ToolInvocation {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["toolCallId", "toolName", "arguments"], path);
  return Object.freeze({
    toolCallId: parseToolCallId(record["toolCallId"], `${path}.toolCallId`),
    toolName: parseToolName(record["toolName"], `${path}.toolName`),
    arguments: boundedCanonical(record["arguments"], `${path}.arguments`, MAX_TOOL_VALUE_TEXT),
  });
}

export interface ToolFailure {
  readonly code: string;
  readonly message: string;
}

/** A CALLER-PROVIDED outcome of executing a previously requested invocation. */
export interface ToolResult {
  readonly toolCallId: ToolCallId;
  readonly toolName: ToolName;
  readonly status: "succeeded" | "failed";
  readonly output: JsonValue | null;
  readonly failure: ToolFailure | null;
}

export function parseToolResult(value: unknown, path = "toolResult"): ToolResult {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["toolCallId", "toolName", "status", "output", "failure"], path);
  const status = ensureEnum(record["status"], `${path}.status`, ["succeeded", "failed"] as const);
  const failure = ensureNullable(record["failure"], (raw) => {
    const failureRecord = ensureRecord(raw, `${path}.failure`);
    ensureExactKeys(failureRecord, ["code", "message"], `${path}.failure`);
    return Object.freeze({
      code: ensureString(failureRecord["code"], `${path}.failure.code`, {
        maxLength: 64,
        pattern: /^[a-z][a-z0-9._-]{0,63}$/,
        patternName: "failure code",
      }),
      message: ensureString(failureRecord["message"], `${path}.failure.message`, { maxLength: 2_000 }),
    });
  });
  if (status === "failed" && failure === null) {
    throw new ProviderError("INVALID_REQUEST", "A failed tool result must carry a failure.", {
      path,
    });
  }
  if (status === "succeeded" && failure !== null) {
    throw new ProviderError("INVALID_REQUEST", "A succeeded tool result cannot carry a failure.", {
      path,
    });
  }
  return Object.freeze({
    toolCallId: parseToolCallId(record["toolCallId"], `${path}.toolCallId`),
    toolName: parseToolName(record["toolName"], `${path}.toolName`),
    status,
    output: ensureNullable(record["output"], (raw) =>
      boundedCanonical(raw, `${path}.output`, MAX_TOOL_VALUE_TEXT),
    ),
    failure,
  });
}
