import { codexProtocolViolation } from "./errors.js";

export type CodexWireId = number | string;
export interface CodexWireResponse { readonly kind: "response"; readonly id: CodexWireId; readonly result?: unknown; readonly error?: CodexWireError }
export interface CodexWireRequest { readonly kind: "request"; readonly id: CodexWireId; readonly method: string; readonly params: unknown }
export interface CodexWireNotification { readonly kind: "notification"; readonly method: string; readonly params: unknown }
export interface CodexWireError { readonly code: number; readonly message: string; readonly data?: unknown }
export type CodexWireMessage = CodexWireResponse | CodexWireRequest | CodexWireNotification;

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
function id(value: unknown): CodexWireId {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return value;
  throw codexProtocolViolation("malformed-json");
}
function method(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._/-]{0,127}$/.test(value)) throw codexProtocolViolation("malformed-json");
  return value;
}
function exact(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) throw codexProtocolViolation("malformed-json");
}

export function parseCodexWireMessage(text: string): CodexWireMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (key, value: unknown) => {
      if (FORBIDDEN.has(key)) throw codexProtocolViolation("prototype-pollution");
      if (typeof value === "number" && !Number.isSafeInteger(value)) throw codexProtocolViolation("unsafe-number");
      return value;
    }) as unknown;
  } catch (error) {
    if (error instanceof Error && error.name === "ProviderError") throw error;
    throw codexProtocolViolation("malformed-json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw codexProtocolViolation("malformed-json");
  const record = parsed as Record<string, unknown>;
  if ("jsonrpc" in record) throw codexProtocolViolation("malformed-json");
  if ("method" in record && "id" in record) {
    exact(record, ["method", "id", "params"]);
    return Object.freeze({ kind: "request", id: id(record["id"]), method: method(record["method"]), params: record["params"] });
  }
  if ("method" in record) {
    const expected = "emittedAtMs" in record
      ? ["method", "params", "emittedAtMs"]
      : ["method", "params"];
    exact(record, expected);
    if (
      "emittedAtMs" in record &&
      (!Number.isSafeInteger(record["emittedAtMs"]) || (record["emittedAtMs"] as number) < 0)
    ) {
      throw codexProtocolViolation("malformed-json");
    }
    return Object.freeze({ kind: "notification", method: method(record["method"]), params: record["params"] });
  }
  if ("id" in record && "result" in record && !("error" in record)) {
    exact(record, ["id", "result"]);
    return Object.freeze({ kind: "response", id: id(record["id"]), result: record["result"] });
  }
  if ("id" in record && "error" in record && !("result" in record)) {
    exact(record, ["id", "error"]);
    const raw = record["error"];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw codexProtocolViolation("malformed-json");
    const failure = raw as Record<string, unknown>;
    const allowed = "data" in failure ? ["code", "message", "data"] : ["code", "message"];
    exact(failure, allowed);
    if (typeof failure["code"] !== "number" || !Number.isSafeInteger(failure["code"]) || typeof failure["message"] !== "string" || failure["message"].length > 2_000) throw codexProtocolViolation("malformed-json");
    return Object.freeze({ kind: "response", id: id(record["id"]), error: Object.freeze({ code: failure["code"], message: failure["message"], ...(failure["data"] === undefined ? {} : { data: failure["data"] }) }) });
  }
  throw codexProtocolViolation("malformed-json");
}

export const KNOWN_CODEX_SERVER_REQUESTS: ReadonlySet<string> = Object.freeze(new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput",
  "mcpServer/elicitation/request", "item/permissions/requestApproval", "item/tool/call",
  "account/chatgptAuthTokens/refresh", "attestation/generate", "applyPatchApproval", "execCommandApproval",
]));
export const KNOWN_CODEX_NOTIFICATIONS: ReadonlySet<string> = Object.freeze(new Set([
  "error", "thread/started", "thread/status/changed", "thread/closed", "thread/tokenUsage/updated",
  "turn/started", "turn/completed", "turn/diff/updated", "turn/plan/updated", "item/started",
  "item/completed", "item/agentMessage/delta", "item/plan/delta", "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta", "item/fileChange/patchUpdated", "serverRequest/resolved", "account/updated",
  "account/rateLimits/updated", "warning", "guardianWarning", "configWarning", "deprecationNotice",
  "model/rerouted", "model/safetyBuffering/updated", "model/verification", "hook/started", "hook/completed",
  "remoteControl/status/changed",
]));
