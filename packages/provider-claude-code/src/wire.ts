/**
 * Claude Code `stream-json` record validation.
 *
 * Records arriving from the CLI are untrusted input. Each line is parsed into
 * a small closed union of records this adapter understands; anything that
 * could change completion, permission, usage, tool, file, or cancellation
 * semantics and is not understood fails closed rather than being skipped.
 *
 * Raw payloads never leave this module. Callers receive bounded, validated
 * values, and no error carries the offending line.
 */

import { validation } from "@ai-dev-os/domain";
import type { ClaudeDetailCode } from "./errors.js";

const { ensureRecord } = validation;

export const MAX_SESSION_ID_LENGTH = 128;
export const MAX_TOOL_NAME_LENGTH = 64;
export const MAX_TOOL_USE_ID_LENGTH = 128;
export const MAX_MODEL_NAME_LENGTH = 128;
export const MAX_TEXT_LENGTH = 16_384;
export const MAX_TOOL_ARGUMENT_KEYS = 32;
export const MAX_PERMISSION_DENIALS = 256;
export const MAX_MODEL_USAGE_ENTRIES = 16;
export const MAX_VALUE_DEPTH = 12;

/**
 * `system` subtypes that prove an ambient customization source ran despite
 * safe mode and the adapter's explicit disabling. Their presence is a hard
 * failure: the session was not the session that was authorized.
 */
const AMBIENT_SUBTYPES: ReadonlySet<string> = Object.freeze(
  new Set(["plugin_install", "hook_started", "hook_progress", "hook_response"]),
);

/** `system` subtypes that are informational and safe to ignore. */
const IGNORABLE_SUBTYPES: ReadonlySet<string> = Object.freeze(
  new Set(["status", "info", "notice", "compact", "warning", "commands_changed"]),
);

export interface ClaudeUsageCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

export interface ClaudePerModelUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly costMicros: number | null;
}

export interface ClaudePermissionDenial {
  readonly toolName: string;
  readonly toolUseId: string | null;
  /** Argument key names only. Argument values are never retained. */
  readonly argumentKeys: readonly string[];
}

export type ClaudeWireRecord =
  | {
      readonly type: "init";
      readonly sessionId: string;
      readonly model: string | null;
      readonly permissionMode: string | null;
      readonly tools: readonly string[];
      readonly mcpServerNames: readonly string[];
      readonly pluginNames: readonly string[];
      readonly apiKeySource: string | null;
    }
  | {
      readonly type: "retry";
      readonly attempt: number;
      readonly maxRetries: number;
      readonly retryDelayMs: number;
      readonly errorStatus: number | null;
      readonly errorCategory: string;
    }
  | { readonly type: "assistant-text"; readonly text: string }
  | { readonly type: "assistant-thinking" }
  | {
      readonly type: "tool-use";
      readonly toolUseId: string;
      readonly toolName: string;
      readonly argumentKeys: readonly string[];
      /** Workspace-relative path the tool names, when it names exactly one. */
      readonly targetPath: string | null;
    }
  | {
      readonly type: "tool-result";
      readonly toolUseId: string;
      readonly isError: boolean;
    }
  | { readonly type: "partial" }
  | { readonly type: "compact-boundary" }
  | {
      readonly type: "result";
      readonly subtype: string;
      readonly isError: boolean;
      readonly sessionId: string | null;
      readonly numTurns: number | null;
      readonly durationMs: number | null;
      readonly usage: ClaudeUsageCounts | null;
      readonly modelUsage: readonly ClaudePerModelUsage[];
      readonly totalCostMicros: number | null;
      readonly permissionDenials: readonly ClaudePermissionDenial[];
    }
  | { readonly type: "ignorable"; readonly subtype: string }
  | { readonly type: "unknown-compatible"; readonly subtype: string };

export type ClaudeWireOutcome =
  | { readonly ok: true; readonly records: readonly ClaudeWireRecord[] }
  | { readonly ok: false; readonly detailCode: ClaudeDetailCode };

function reject(detailCode: ClaudeDetailCode): ClaudeWireOutcome {
  return Object.freeze({ ok: false, detailCode });
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  try {
    return ensureRecord(value, "record");
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects `__proto__`, `constructor`, and `prototype` at any depth. */
function hasPollutingKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_VALUE_DEPTH) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasPollutingKey(entry, depth + 1));
  }
  if (!isPlainObject(value)) {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return true;
    }
    if (hasPollutingKey(value[key], depth + 1)) {
      return true;
    }
  }
  return false;
}

function optionalCount(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "invalid";
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return "invalid";
  }
  return value;
}

function requiredCount(value: unknown): number | "invalid" {
  const parsed = optionalCount(value);
  if (parsed === "invalid" || parsed === null) {
    return "invalid";
  }
  return parsed;
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return null;
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    return null;
  }
  return value;
}

function boundedStringList(value: unknown, maxItems: number, maxLength: number): readonly string[] {
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }
  const out: string[] = [];
  for (const entry of value.slice(0, maxItems)) {
    const text = typeof entry === "string" ? entry : namedEntry(entry);
    const bounded = text === null ? null : boundedString(text, maxLength);
    if (bounded !== null) {
      out.push(bounded);
    }
  }
  return Object.freeze(out);
}

function namedEntry(value: unknown): string | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const name = value["name"];
  return typeof name === "string" ? name : null;
}

/** Dollars reported as a JSON number, converted to integer micro-dollars. */
function costMicros(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "invalid";
  }
  const micros = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(micros)) {
    return "invalid";
  }
  return micros;
}

/**
 * Extracts the single workspace-relative path a documented file tool names.
 * Anything absolute, traversing, or ambiguous yields null, and the caller then
 * treats the tool call as unlocated rather than guessing.
 */
function toolTargetPath(toolName: string, input: unknown): string | null {
  if (!isPlainObject(input)) {
    return null;
  }
  const candidate = input["file_path"] ?? input["path"] ?? input["notebook_path"];
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 1_024) {
    return null;
  }
  if (toolName.length === 0) {
    return null;
  }
  const normalized = candidate.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    return null;
  }
  if (normalized.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
    return null;
  }
  return normalized;
}

function argumentKeys(input: unknown): readonly string[] {
  if (!isPlainObject(input)) {
    return Object.freeze([]);
  }
  return Object.freeze(
    Object.keys(input)
      .slice(0, MAX_TOOL_ARGUMENT_KEYS)
      .filter((key) => key.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(key))
      .sort(),
  );
}

function parseUsage(value: unknown): ClaudeUsageCounts | null | "invalid" {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    return "invalid";
  }
  const input = optionalCount(value["input_tokens"]);
  const output = optionalCount(value["output_tokens"]);
  const cacheCreate = optionalCount(value["cache_creation_input_tokens"]);
  const cacheRead = optionalCount(value["cache_read_input_tokens"]);
  if (input === "invalid" || output === "invalid" || cacheCreate === "invalid" || cacheRead === "invalid") {
    return "invalid";
  }
  return Object.freeze({
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheCreationInputTokens: cacheCreate ?? 0,
    cacheReadInputTokens: cacheRead ?? 0,
  });
}

function parseModelUsage(value: unknown): readonly ClaudePerModelUsage[] | "invalid" {
  if (value === undefined || value === null) {
    return Object.freeze([]);
  }
  if (!isPlainObject(value)) {
    return "invalid";
  }
  const entries = Object.entries(value).slice(0, MAX_MODEL_USAGE_ENTRIES);
  const out: ClaudePerModelUsage[] = [];
  for (const [model, raw] of entries) {
    const name = boundedString(model, MAX_MODEL_NAME_LENGTH);
    if (name === null || !isPlainObject(raw)) {
      return "invalid";
    }
    const input = optionalCount(raw["inputTokens"]);
    const output = optionalCount(raw["outputTokens"]);
    const cacheRead = optionalCount(raw["cacheReadInputTokens"]);
    const cacheCreate = optionalCount(raw["cacheCreationInputTokens"]);
    const cost = costMicros(raw["costUSD"]);
    if (
      input === "invalid" ||
      output === "invalid" ||
      cacheRead === "invalid" ||
      cacheCreate === "invalid" ||
      cost === "invalid"
    ) {
      return "invalid";
    }
    out.push(
      Object.freeze({
        model: name,
        inputTokens: input ?? 0,
        outputTokens: output ?? 0,
        cacheReadInputTokens: cacheRead ?? 0,
        cacheCreationInputTokens: cacheCreate ?? 0,
        costMicros: cost,
      }),
    );
  }
  return Object.freeze(out.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0)));
}

function parseDenials(value: unknown): readonly ClaudePermissionDenial[] | "invalid" {
  if (value === undefined || value === null) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) {
    return "invalid";
  }
  const out: ClaudePermissionDenial[] = [];
  for (const entry of value.slice(0, MAX_PERMISSION_DENIALS)) {
    if (!isPlainObject(entry)) {
      return "invalid";
    }
    const toolName = boundedString(entry["tool_name"], MAX_TOOL_NAME_LENGTH);
    if (toolName === null) {
      return "invalid";
    }
    const rawId = entry["tool_use_id"];
    out.push(
      Object.freeze({
        toolName,
        toolUseId: rawId === undefined || rawId === null ? null : boundedString(rawId, MAX_TOOL_USE_ID_LENGTH),
        argumentKeys: argumentKeys(entry["tool_input"]),
      }),
    );
  }
  return Object.freeze(out);
}

/**
 * Parses one NDJSON line into zero or more records. A single assistant message
 * yields one record per content block, so ordering is preserved.
 */
export function parseWireLine(line: string): ClaudeWireOutcome {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return reject("malformed-json");
  }
  if (!isPlainObject(value)) {
    return reject("non-object-record");
  }
  if (hasPollutingKey(value)) {
    return reject("prototype-pollution");
  }
  const record = safeRecord(value);
  if (record === null) {
    return reject("prototype-pollution");
  }

  const type = record["type"];
  if (typeof type !== "string" || type.length === 0 || type.length > 64) {
    return reject("non-object-record");
  }

  switch (type) {
    case "system":
      return parseSystem(record);
    case "assistant":
      return parseAssistant(record);
    case "user":
      return parseUser(record);
    case "result":
      return parseResult(record);
    case "stream_event":
    case "partial_assistant":
      return ok([Object.freeze({ type: "partial" as const })]);
    case "compact_boundary":
      return ok([Object.freeze({ type: "compact-boundary" as const })]);
    default:
      // An unrecognized top-level record could carry completion, permission,
      // usage, tool, or file semantics. There is no way to prove it does not,
      // so it fails closed.
      return reject("unknown-state-changing-record");
  }
}

function ok(records: readonly ClaudeWireRecord[]): ClaudeWireOutcome {
  return Object.freeze({ ok: true, records: Object.freeze([...records]) });
}

function parseSystem(record: Record<string, unknown>): ClaudeWireOutcome {
  const subtypeRaw = record["subtype"];
  const subtype = typeof subtypeRaw === "string" ? subtypeRaw.slice(0, 64) : "";

  if (AMBIENT_SUBTYPES.has(subtype)) {
    return reject("unknown-state-changing-record");
  }

  if (subtype === "init") {
    // The documented shape nests session metadata under `system`; some
    // versions flatten it onto the record. Both are accepted, neither guessed.
    const nested = isPlainObject(record["system"]) ? (record["system"] as Record<string, unknown>) : record;
    const sessionId = boundedString(nested["session_id"], MAX_SESSION_ID_LENGTH);
    if (sessionId === null) {
      return reject("session-id-mismatch");
    }
    const modelRaw = nested["model"];
    const permissionRaw = nested["permissionMode"] ?? nested["permission_mode"];
    const apiKeySourceRaw = nested["apiKeySource"] ?? nested["api_key_source"];
    return ok([
      Object.freeze({
        type: "init" as const,
        sessionId,
        model: modelRaw === undefined || modelRaw === null ? null : boundedString(modelRaw, MAX_MODEL_NAME_LENGTH),
        permissionMode:
          permissionRaw === undefined || permissionRaw === null ? null : boundedString(permissionRaw, 32),
        tools: boundedStringList(nested["tools"], 128, MAX_TOOL_NAME_LENGTH),
        mcpServerNames: boundedStringList(nested["mcp_servers"], 32, 128),
        pluginNames: boundedStringList(nested["plugins"], 32, 128),
        apiKeySource:
          apiKeySourceRaw === undefined || apiKeySourceRaw === null
            ? null
            : boundedString(apiKeySourceRaw, 64),
      }),
    ]);
  }

  if (subtype === "api_retry") {
    const attempt = requiredCount(record["attempt"]);
    const maxRetries = requiredCount(record["max_retries"]);
    const delay = requiredCount(record["retry_delay_ms"]);
    const statusRaw = record["error_status"];
    const status = optionalCount(statusRaw);
    const category = typeof record["error"] === "string" ? record["error"].slice(0, 64) : "unknown";
    if (attempt === "invalid" || maxRetries === "invalid" || delay === "invalid" || status === "invalid") {
      return reject("unsafe-number");
    }
    return ok([
      Object.freeze({
        type: "retry" as const,
        attempt,
        maxRetries,
        retryDelayMs: Math.min(delay, 86_400_000),
        errorStatus: status,
        errorCategory: category,
      }),
    ]);
  }

  if (IGNORABLE_SUBTYPES.has(subtype)) {
    return ok([Object.freeze({ type: "ignorable" as const, subtype })]);
  }

  // An unknown `system` subtype is informational by construction: every
  // completion, permission, usage, tool, and file effect travels in the
  // assistant, user, or result envelopes, and the ambient-source subtypes are
  // rejected above. It produces a bounded compatibility warning.
  return ok([Object.freeze({ type: "unknown-compatible" as const, subtype: subtype || "unnamed" })]);
}

function contentBlocks(record: Record<string, unknown>): readonly unknown[] | null {
  const direct = record["content"];
  if (Array.isArray(direct)) {
    return direct;
  }
  const message = record["message"];
  if (isPlainObject(message) && Array.isArray(message["content"])) {
    return message["content"];
  }
  if (typeof direct === "string") {
    return [{ type: "text", text: direct }];
  }
  if (isPlainObject(message) && typeof message["content"] === "string") {
    return [{ type: "text", text: message["content"] }];
  }
  return null;
}

function parseAssistant(record: Record<string, unknown>): ClaudeWireOutcome {
  const blocks = contentBlocks(record);
  if (blocks === null) {
    return reject("unknown-state-changing-record");
  }
  const records: ClaudeWireRecord[] = [];
  for (const block of blocks.slice(0, 256)) {
    if (!isPlainObject(block)) {
      return reject("unknown-state-changing-record");
    }
    const blockType = block["type"];
    if (blockType === "text") {
      const text = typeof block["text"] === "string" ? block["text"].slice(0, MAX_TEXT_LENGTH) : "";
      if (text.length > 0) {
        records.push(Object.freeze({ type: "assistant-text" as const, text }));
      }
      continue;
    }
    if (blockType === "thinking" || blockType === "redacted_thinking") {
      // Hidden reasoning is acknowledged but never carried forward.
      records.push(Object.freeze({ type: "assistant-thinking" as const }));
      continue;
    }
    if (blockType === "tool_use" || blockType === "server_tool_use") {
      const toolUseId = boundedString(block["id"], MAX_TOOL_USE_ID_LENGTH);
      const toolName = boundedString(block["name"], MAX_TOOL_NAME_LENGTH);
      if (toolUseId === null || toolName === null) {
        return reject("unknown-state-changing-record");
      }
      records.push(
        Object.freeze({
          type: "tool-use" as const,
          toolUseId,
          toolName,
          argumentKeys: argumentKeys(block["input"]),
          targetPath: toolTargetPath(toolName, block["input"]),
        }),
      );
      continue;
    }
    // A content block the adapter does not recognize may be a tool or state
    // change in a newer form. It fails closed.
    return reject("unknown-state-changing-record");
  }
  return ok(records);
}

function parseUser(record: Record<string, unknown>): ClaudeWireOutcome {
  const blocks = contentBlocks(record);
  if (blocks === null) {
    return ok([]);
  }
  const records: ClaudeWireRecord[] = [];
  for (const block of blocks.slice(0, 256)) {
    if (!isPlainObject(block)) {
      return reject("unknown-state-changing-record");
    }
    if (block["type"] !== "tool_result") {
      // User-envelope blocks other than tool results carry no adapter meaning.
      continue;
    }
    const toolUseId = boundedString(block["tool_use_id"], MAX_TOOL_USE_ID_LENGTH);
    if (toolUseId === null) {
      return reject("unknown-state-changing-record");
    }
    records.push(
      Object.freeze({
        type: "tool-result" as const,
        toolUseId,
        isError: block["is_error"] === true,
      }),
    );
  }
  return ok(records);
}

function parseResult(record: Record<string, unknown>): ClaudeWireOutcome {
  const subtypeRaw = record["subtype"];
  const subtype = typeof subtypeRaw === "string" ? subtypeRaw.slice(0, 64) : "";
  if (subtype.length === 0) {
    return reject("result-contradiction");
  }
  const isErrorRaw = record["is_error"];
  if (isErrorRaw !== undefined && typeof isErrorRaw !== "boolean") {
    return reject("result-contradiction");
  }
  const isError = isErrorRaw === true || subtype !== "success";
  if (subtype === "success" && isErrorRaw === true) {
    return reject("result-contradiction");
  }

  const numTurns = optionalCount(record["num_turns"]);
  const durationMs = optionalCount(record["duration_ms"]);
  const usage = parseUsage(record["usage"]);
  const modelUsage = parseModelUsage(record["modelUsage"]);
  const cost = costMicros(record["total_cost_usd"]);
  const denials = parseDenials(record["permission_denials"]);
  if (
    numTurns === "invalid" ||
    durationMs === "invalid" ||
    usage === "invalid" ||
    modelUsage === "invalid" ||
    cost === "invalid" ||
    denials === "invalid"
  ) {
    return reject("unsafe-number");
  }
  const sessionRaw = record["session_id"];

  return ok([
    Object.freeze({
      type: "result" as const,
      subtype,
      isError,
      sessionId:
        sessionRaw === undefined || sessionRaw === null
          ? null
          : boundedString(sessionRaw, MAX_SESSION_ID_LENGTH),
      numTurns,
      durationMs,
      usage,
      modelUsage,
      totalCostMicros: cost,
      permissionDenials: denials,
    }),
  ]);
}

/**
 * Documented `result` subtypes and their meaning to the adapter. An unknown
 * subtype is still terminal, and is classified conservatively as a failure
 * rather than assumed to be a success in a new spelling.
 */
export const RESULT_SUBTYPE_TABLE_VERSION = 1 as const;

export const RESULT_SUBTYPES: ReadonlyMap<string, ClaudeDetailCode | null> = Object.freeze(
  new Map<string, ClaudeDetailCode | null>([
    ["success", null],
    ["error_max_turns", "turn-limit-reached"],
    ["error_max_budget", "budget-exhausted"],
    ["error_max_budget_usd", "budget-exhausted"],
    ["error_during_execution", "process-nonzero-exit"],
    ["error_max_tokens", "context-limit"],
  ]),
);
