import {
  canonicalizeJson,
  toCanonicalJson,
  validation,
  type JsonValue,
} from "@ai-dev-os/domain";
import { ProviderError } from "./errors.js";
import {
  parseCancellationReason,
  parseExecutionTraceMetadata,
  parseProviderOperationId,
  PROVIDER_CONTRACT_SCHEMA_VERSION,
  type CancellationReason,
  type ExecutionTraceMetadata,
  type ProviderOperationId,
} from "./common.js";
import { parseToolInvocation, type ToolInvocation } from "./tools.js";
import { parseProviderUsage, totalOfUsage, type ProviderUsage } from "./usage.js";
import { parseChangedFileSummary, type ChangedFileSummary } from "./coding-agent.js";

const {
  ensureEnum,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  ensureTimestamp,
} = validation;

const KIND_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_DELTA_TEXT = 65_536;
const MAX_EVENT_JSON_TEXT = 65_536;

/** Fields shared by every provider stream event. Sequences start at 1 and
 * increase by exactly 1; timestamps come from the adapter's injected clock
 * and are non-decreasing. */
export interface ProviderEventBase {
  readonly schemaVersion: typeof PROVIDER_CONTRACT_SCHEMA_VERSION;
  readonly operationId: ProviderOperationId;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly trace: ExecutionTraceMetadata;
}

export const FIRST_EVENT_SEQUENCE = 1;

export const INFERENCE_EVENT_KINDS = Object.freeze([
  "operation-started",
  "message-started",
  "text-delta",
  "reasoning-delta",
  "structured-output-delta",
  "structured-output-completed",
  "tool-call-started",
  "tool-call-delta",
  "tool-call-completed",
  "usage-update",
  "warning",
  "message-completed",
  "operation-completed",
  "operation-failed",
  "operation-cancelled",
] as const);

export type InferenceEventKind = (typeof INFERENCE_EVENT_KINDS)[number];

export const CODING_AGENT_EVENT_KINDS = Object.freeze([
  "operation-started",
  "status-update",
  "workspace-read",
  "tool-call-proposed",
  "tool-call-started",
  "output-chunk",
  "file-change-proposed",
  "file-change-applied",
  "patch-produced",
  "test-started",
  "test-completed",
  "approval-requested",
  "usage-update",
  "warning",
  "operation-completed",
  "operation-failed",
  "operation-cancelled",
] as const);

export type CodingAgentEventKind = (typeof CODING_AGENT_EVENT_KINDS)[number];

/** Terminal kinds shared by both event vocabularies. Exactly one terminal
 * event ends every stream; nothing may follow it. */
export const TERMINAL_EVENT_KINDS = Object.freeze([
  "operation-completed",
  "operation-failed",
  "operation-cancelled",
] as const);

export type TerminalEventKind = (typeof TERMINAL_EVENT_KINDS)[number];

export function isTerminalEventKind(kind: string): kind is TerminalEventKind {
  return (TERMINAL_EVENT_KINDS as readonly string[]).includes(kind);
}

export interface OperationFailurePayload {
  readonly code: string;
  readonly message: string;
  readonly retryStrategy: string;
}

export type InferenceEvent = ProviderEventBase &
  (
    | { readonly kind: "operation-started"; readonly payload: { readonly modelId: string } }
    | { readonly kind: "message-started"; readonly payload: { readonly messageIndex: number } }
    | { readonly kind: "text-delta"; readonly payload: { readonly text: string } }
    | { readonly kind: "reasoning-delta"; readonly payload: { readonly text: string } }
    | { readonly kind: "structured-output-delta"; readonly payload: { readonly textDelta: string } }
    | { readonly kind: "structured-output-completed"; readonly payload: { readonly value: JsonValue } }
    | { readonly kind: "tool-call-started"; readonly payload: { readonly toolCallId: string; readonly toolName: string } }
    | { readonly kind: "tool-call-delta"; readonly payload: { readonly toolCallId: string; readonly argumentsDelta: string } }
    | { readonly kind: "tool-call-completed"; readonly payload: { readonly invocation: ToolInvocation } }
    | { readonly kind: "usage-update"; readonly payload: { readonly usage: ProviderUsage } }
    | { readonly kind: "warning"; readonly payload: { readonly message: string } }
    | { readonly kind: "message-completed"; readonly payload: { readonly messageIndex: number } }
    | { readonly kind: "operation-completed"; readonly payload: Record<string, never> }
    | { readonly kind: "operation-failed"; readonly payload: OperationFailurePayload }
    | { readonly kind: "operation-cancelled"; readonly payload: { readonly reason: CancellationReason } }
  );

export type CodingAgentEvent = ProviderEventBase &
  (
    | { readonly kind: "operation-started"; readonly payload: { readonly workspaceId: string } }
    | { readonly kind: "status-update"; readonly payload: { readonly message: string } }
    | { readonly kind: "workspace-read"; readonly payload: { readonly path: string } }
    | { readonly kind: "tool-call-proposed"; readonly payload: { readonly invocation: ToolInvocation } }
    | { readonly kind: "tool-call-started"; readonly payload: { readonly toolCallId: string; readonly toolName: string } }
    | {
        readonly kind: "output-chunk";
        readonly payload: {
          readonly channel: "stdout" | "stderr";
          readonly text: string;
          readonly artifactId: string | null;
        };
      }
    | { readonly kind: "file-change-proposed"; readonly payload: { readonly change: ChangedFileSummary } }
    | { readonly kind: "file-change-applied"; readonly payload: { readonly change: ChangedFileSummary } }
    | { readonly kind: "patch-produced"; readonly payload: { readonly artifactId: string } }
    | { readonly kind: "test-started"; readonly payload: { readonly suite: string } }
    | {
        readonly kind: "test-completed";
        readonly payload: {
          readonly suite: string;
          readonly passed: number;
          readonly failed: number;
          readonly skipped: number;
        };
      }
    | {
        readonly kind: "approval-requested";
        readonly payload: {
          readonly approvalId: string;
          readonly summary: string;
          readonly risk: "read-only" | "mutating" | "destructive";
        };
      }
    | { readonly kind: "usage-update"; readonly payload: { readonly usage: ProviderUsage } }
    | { readonly kind: "warning"; readonly payload: { readonly message: string } }
    | { readonly kind: "operation-completed"; readonly payload: Record<string, never> }
    | { readonly kind: "operation-failed"; readonly payload: OperationFailurePayload }
    | { readonly kind: "operation-cancelled"; readonly payload: { readonly reason: CancellationReason } }
  );

function protocolViolation(message: string, details: Record<string, string | number | null> = {}): ProviderError {
  return new ProviderError("PROTOCOL_VIOLATION", message, details);
}

function parseEnvelope(value: unknown, path: string): {
  readonly record: Record<string, unknown>;
  readonly base: ProviderEventBase;
} {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["schemaVersion", "operationId", "sequence", "occurredAt", "trace", "kind", "payload"], path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, PROVIDER_CONTRACT_SCHEMA_VERSION);
  return {
    record,
    base: Object.freeze({
      schemaVersion: PROVIDER_CONTRACT_SCHEMA_VERSION,
      operationId: parseProviderOperationId(record["operationId"], `${path}.operationId`),
      sequence: ensureSafeInteger(record["sequence"], `${path}.sequence`, FIRST_EVENT_SEQUENCE, Number.MAX_SAFE_INTEGER),
      occurredAt: ensureTimestamp(record["occurredAt"], `${path}.occurredAt`),
      trace: parseExecutionTraceMetadata(record["trace"], `${path}.trace`),
    }),
  };
}

function parseBoundedText(value: unknown, path: string, minLength = 0): string {
  return ensureString(value, path, { minLength, maxLength: MAX_DELTA_TEXT });
}

function parseFailurePayload(value: unknown, path: string): OperationFailurePayload {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["code", "message", "retryStrategy"], path);
  return Object.freeze({
    code: ensureString(record["code"], `${path}.code`, {
      maxLength: 64,
      pattern: /^[A-Z][A-Z0-9_]{0,63}$/,
      patternName: "error code",
    }),
    message: ensureString(record["message"], `${path}.message`, { maxLength: 2_000 }),
    retryStrategy: ensureString(record["retryStrategy"], `${path}.retryStrategy`, {
      maxLength: 32,
      pattern: KIND_PATTERN,
      patternName: "retry strategy",
    }),
  });
}

function boundedEventJson(value: unknown, path: string): JsonValue {
  const canonical = canonicalizeJson(value, path);
  if (toCanonicalJson(canonical).length > MAX_EVENT_JSON_TEXT) {
    throw protocolViolation("An event JSON payload is oversized.", { path });
  }
  return canonical;
}

export function parseInferenceEvent(value: unknown, path = "inferenceEvent"): InferenceEvent {
  const { record, base } = parseEnvelope(value, path);
  const kind = ensureEnum(record["kind"], `${path}.kind`, INFERENCE_EVENT_KINDS);
  const payloadPath = `${path}.payload`;
  const payload = ensureRecord(record["payload"], payloadPath);

  switch (kind) {
    case "operation-started":
      ensureExactKeys(payload, ["modelId"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          modelId: ensureString(payload["modelId"], `${payloadPath}.modelId`, {
            maxLength: 128,
            pattern: ID_PATTERN,
            patternName: "ModelId",
          }),
        }),
      });
    case "message-started":
    case "message-completed":
      ensureExactKeys(payload, ["messageIndex"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          messageIndex: ensureSafeInteger(payload["messageIndex"], `${payloadPath}.messageIndex`, 0, 1_000),
        }),
      });
    case "text-delta":
    case "reasoning-delta":
      ensureExactKeys(payload, ["text"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({ text: parseBoundedText(payload["text"], `${payloadPath}.text`) }),
      });
    case "structured-output-delta":
      ensureExactKeys(payload, ["textDelta"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          textDelta: parseBoundedText(payload["textDelta"], `${payloadPath}.textDelta`),
        }),
      });
    case "structured-output-completed":
      ensureExactKeys(payload, ["value"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({ value: boundedEventJson(payload["value"], `${payloadPath}.value`) }),
      });
    case "tool-call-started":
      ensureExactKeys(payload, ["toolCallId", "toolName"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          toolCallId: ensureString(payload["toolCallId"], `${payloadPath}.toolCallId`, {
            maxLength: 128,
            pattern: ID_PATTERN,
            patternName: "ToolCallId",
          }),
          toolName: ensureString(payload["toolName"], `${payloadPath}.toolName`, {
            maxLength: 64,
            pattern: KIND_PATTERN,
            patternName: "tool name",
          }),
        }),
      });
    case "tool-call-delta":
      ensureExactKeys(payload, ["toolCallId", "argumentsDelta"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          toolCallId: ensureString(payload["toolCallId"], `${payloadPath}.toolCallId`, {
            maxLength: 128,
            pattern: ID_PATTERN,
            patternName: "ToolCallId",
          }),
          argumentsDelta: parseBoundedText(payload["argumentsDelta"], `${payloadPath}.argumentsDelta`),
        }),
      });
    case "tool-call-completed":
      ensureExactKeys(payload, ["invocation"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          invocation: parseToolInvocation(payload["invocation"], `${payloadPath}.invocation`),
        }),
      });
    case "usage-update":
      ensureExactKeys(payload, ["usage"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({ usage: parseProviderUsage(payload["usage"], `${payloadPath}.usage`) }),
      });
    case "warning":
      ensureExactKeys(payload, ["message"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          message: ensureString(payload["message"], `${payloadPath}.message`, { maxLength: 1_000 }),
        }),
      });
    case "operation-completed":
      ensureExactKeys(payload, [], payloadPath);
      return Object.freeze({ ...base, kind, payload: Object.freeze({}) });
    case "operation-failed":
      return Object.freeze({ ...base, kind, payload: parseFailurePayload(payload, payloadPath) });
    case "operation-cancelled":
      ensureExactKeys(payload, ["reason"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          reason: parseCancellationReason(payload["reason"], `${payloadPath}.reason`),
        }),
      });
  }
}

export function parseCodingAgentEvent(value: unknown, path = "codingAgentEvent"): CodingAgentEvent {
  const { record, base } = parseEnvelope(value, path);
  const kind = ensureEnum(record["kind"], `${path}.kind`, CODING_AGENT_EVENT_KINDS);
  const payloadPath = `${path}.payload`;
  const payload = ensureRecord(record["payload"], payloadPath);

  switch (kind) {
    case "operation-started":
      ensureExactKeys(payload, ["workspaceId"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          workspaceId: ensureString(payload["workspaceId"], `${payloadPath}.workspaceId`, {
            maxLength: 128,
            pattern: ID_PATTERN,
            patternName: "WorkspaceId",
          }),
        }),
      });
    case "status-update":
    case "warning":
      ensureExactKeys(payload, ["message"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          message: ensureString(payload["message"], `${payloadPath}.message`, { maxLength: 2_000 }),
        }),
      });
    case "workspace-read":
      ensureExactKeys(payload, ["path"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          path: ensureString(payload["path"], `${payloadPath}.path`, { maxLength: 1_024 }),
        }),
      });
    case "tool-call-proposed":
      ensureExactKeys(payload, ["invocation"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          invocation: parseToolInvocation(payload["invocation"], `${payloadPath}.invocation`),
        }),
      });
    case "tool-call-started":
      ensureExactKeys(payload, ["toolCallId", "toolName"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          toolCallId: ensureString(payload["toolCallId"], `${payloadPath}.toolCallId`, {
            maxLength: 128,
            pattern: ID_PATTERN,
            patternName: "ToolCallId",
          }),
          toolName: ensureString(payload["toolName"], `${payloadPath}.toolName`, {
            maxLength: 64,
            pattern: KIND_PATTERN,
            patternName: "tool name",
          }),
        }),
      });
    case "output-chunk":
      ensureExactKeys(payload, ["channel", "text", "artifactId"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          channel: ensureEnum(payload["channel"], `${payloadPath}.channel`, ["stdout", "stderr"] as const),
          text: parseBoundedText(payload["text"], `${payloadPath}.text`),
          artifactId: ensureNullable(payload["artifactId"], (raw) =>
            ensureString(raw, `${payloadPath}.artifactId`, {
              maxLength: 128,
              pattern: ID_PATTERN,
              patternName: "ArtifactId",
            }),
          ),
        }),
      });
    case "file-change-proposed":
    case "file-change-applied":
      ensureExactKeys(payload, ["change"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          change: parseChangedFileSummary(payload["change"], `${payloadPath}.change`),
        }),
      });
    case "patch-produced":
      ensureExactKeys(payload, ["artifactId"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          artifactId: ensureString(payload["artifactId"], `${payloadPath}.artifactId`, {
            maxLength: 128,
            pattern: ID_PATTERN,
            patternName: "ArtifactId",
          }),
        }),
      });
    case "test-started":
      ensureExactKeys(payload, ["suite"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          suite: ensureString(payload["suite"], `${payloadPath}.suite`, { maxLength: 256 }),
        }),
      });
    case "test-completed":
      ensureExactKeys(payload, ["suite", "passed", "failed", "skipped"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          suite: ensureString(payload["suite"], `${payloadPath}.suite`, { maxLength: 256 }),
          passed: ensureSafeInteger(payload["passed"], `${payloadPath}.passed`, 0, 1_000_000),
          failed: ensureSafeInteger(payload["failed"], `${payloadPath}.failed`, 0, 1_000_000),
          skipped: ensureSafeInteger(payload["skipped"], `${payloadPath}.skipped`, 0, 1_000_000),
        }),
      });
    case "approval-requested":
      ensureExactKeys(payload, ["approvalId", "summary", "risk"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          approvalId: ensureString(payload["approvalId"], `${payloadPath}.approvalId`, {
            maxLength: 128,
            pattern: ID_PATTERN,
            patternName: "approval id",
          }),
          summary: ensureString(payload["summary"], `${payloadPath}.summary`, { maxLength: 2_000 }),
          risk: ensureEnum(payload["risk"], `${payloadPath}.risk`, ["read-only", "mutating", "destructive"] as const),
        }),
      });
    case "usage-update":
      ensureExactKeys(payload, ["usage"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({ usage: parseProviderUsage(payload["usage"], `${payloadPath}.usage`) }),
      });
    case "operation-completed":
      ensureExactKeys(payload, [], payloadPath);
      return Object.freeze({ ...base, kind, payload: Object.freeze({}) });
    case "operation-failed":
      return Object.freeze({ ...base, kind, payload: parseFailurePayload(payload, payloadPath) });
    case "operation-cancelled":
      ensureExactKeys(payload, ["reason"], payloadPath);
      return Object.freeze({
        ...base,
        kind,
        payload: Object.freeze({
          reason: parseCancellationReason(payload["reason"], `${payloadPath}.reason`),
        }),
      });
  }
}

/**
 * Stateful per-stream validator enforcing the ordering invariants:
 * sequence starts at FIRST_EVENT_SEQUENCE and increments by exactly 1 with
 * no gaps or duplicates; timestamps are non-decreasing; usage snapshots are
 * cumulative (non-decreasing totals); exactly one terminal event; nothing
 * after it. Used by guardProviderOperation.
 */
export function createEventSequenceValidator(operationId: ProviderOperationId): {
  readonly check: (event: ProviderEventBase & { readonly kind: string }) => void;
  readonly finish: () => void;
  readonly terminalKind: () => TerminalEventKind | null;
} {
  let expectedSequence = FIRST_EVENT_SEQUENCE;
  let lastOccurredAt: string | null = null;
  let lastUsageTotal = 0;
  let terminal: TerminalEventKind | null = null;

  return {
    check(event) {
      if (terminal !== null) {
        throw protocolViolation("An event arrived after the terminal event.", {
          sequence: event.sequence,
        });
      }
      if (event.operationId !== operationId) {
        throw protocolViolation("An event carries a foreign operation id.", {
          expected: operationId,
        });
      }
      if (event.sequence !== expectedSequence) {
        throw protocolViolation("Event sequence numbers must increase by exactly one.", {
          expected: expectedSequence,
          received: event.sequence,
        });
      }
      expectedSequence += 1;
      if (lastOccurredAt !== null && event.occurredAt < lastOccurredAt) {
        throw protocolViolation("Event timestamps must be non-decreasing.", {
          sequence: event.sequence,
        });
      }
      lastOccurredAt = event.occurredAt;
      const usage = (event as { payload?: { usage?: ProviderUsage } }).payload?.usage;
      if (event.kind === "usage-update" && usage !== undefined) {
        const total = totalOfUsage(usage);
        if (total < lastUsageTotal) {
          throw protocolViolation("Usage snapshots must be cumulative and non-decreasing.", {
            sequence: event.sequence,
          });
        }
        lastUsageTotal = total;
      }
      if (isTerminalEventKind(event.kind)) {
        terminal = event.kind;
      }
    },
    finish() {
      if (terminal === null) {
        throw protocolViolation("The event stream ended without a terminal event.");
      }
    },
    terminalKind: () => terminal,
  };
}
