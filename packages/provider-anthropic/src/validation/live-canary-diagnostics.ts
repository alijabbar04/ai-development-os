/**
 * Bounded, nonsecret failure diagnostics for the one-attempt Anthropic live
 * canary.
 *
 * The canary's finite `code`/`failurePhase` pair records *where* an attempt
 * stopped. It cannot record *why*: every non-200 response — an expired key, a
 * spend cap, a rate limit, a provider outage — collapses into
 * `TRANSPORT_FAILURE` at `response-received`. This module derives an additive,
 * separately versioned envelope that answers "why" from stable protocol
 * evidence alone.
 *
 * Classification uses HTTP status, an allowlisted structured `error.type`,
 * allowlisted transport error codes, and allowlisted stop reasons. It never
 * inspects provider prose: an error message is untrusted attacker-influenced
 * text, and a classifier that reads it can be steered by it. Everything this
 * module returns is an enum member, a bounded integer, or a boolean, so no
 * credential, header, body, prompt, completion, request identifier, or
 * exception text can survive classification.
 */

import { validation } from "@ai-dev-os/domain";

const { ensureRecord } = validation;

export const ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;

/**
 * Normalized failure causes. `unknown` is a first-class answer: an honest
 * refusal to classify is more useful than a confident wrong category, and the
 * envelope's `httpStatus` still carries the raw fact when one exists.
 */
export const ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_CATEGORIES = Object.freeze([
  "local-precondition",
  "broker-unavailable",
  "network-transport",
  "local-timeout",
  "credential-unauthenticated",
  "billing-unavailable",
  "permission-denied",
  "model-or-resource-unavailable",
  "request-invalid",
  "request-conflict",
  "request-too-large",
  "rate-limited",
  "provider-internal-error",
  "provider-timeout",
  "provider-overloaded",
  "provider-refusal",
  "response-unusable",
  "unknown",
] as const);
export type AnthropicLiveCanaryDiagnosticCategory =
  (typeof ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_CATEGORIES)[number];

/** The documented Anthropic error taxonomy. Unlisted values normalize to `unknown`. */
export const ANTHROPIC_PROVIDER_ERROR_TYPES = Object.freeze([
  "invalid_request_error",
  "authentication_error",
  "billing_error",
  "permission_error",
  "not_found_error",
  "conflict_error",
  "request_too_large",
  "rate_limit_error",
  "api_error",
  "timeout_error",
  "overloaded_error",
] as const);
export type AnthropicProviderErrorType =
  (typeof ANTHROPIC_PROVIDER_ERROR_TYPES)[number];

/** Documented terminal stop reasons. Unlisted values normalize to `unknown`. */
export const ANTHROPIC_PROVIDER_STOP_REASONS = Object.freeze([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
  "model_context_window_exceeded",
] as const);
export type AnthropicProviderStopReason =
  (typeof ANTHROPIC_PROVIDER_STOP_REASONS)[number];

/** Local transport failure families, derived from stable runtime error codes. */
export const ANTHROPIC_LIVE_CANARY_TRANSPORT_ERROR_KINDS = Object.freeze([
  "dns",
  "connection-refused",
  "connection-reset",
  "tls",
  "socket-timeout",
  "unreachable",
  "other",
] as const);
export type AnthropicLiveCanaryTransportErrorKind =
  (typeof ANTHROPIC_LIVE_CANARY_TRANSPORT_ERROR_KINDS)[number];

export interface AnthropicLiveCanaryDiagnostics {
  readonly schemaVersion: typeof ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_SCHEMA_VERSION;
  readonly category: AnthropicLiveCanaryDiagnosticCategory;
  readonly httpStatus: number | null;
  readonly providerErrorType: AnthropicProviderErrorType | "unknown" | null;
  readonly providerErrorEnvelopeObserved: boolean;
  /** Presence only. The identifier itself is never read into the envelope. */
  readonly requestIdPresent: boolean;
  readonly retryAfterSeconds: number | null;
  readonly responseStreamBegan: boolean;
  readonly stopReason: AnthropicProviderStopReason | "unknown" | null;
  /**
   * Whether the payload echoed the pinned model. `null` means no model field
   * was observed at all, which is distinct from an observed mismatch.
   */
  readonly modelEcho: boolean | null;
  readonly transportErrorKind: AnthropicLiveCanaryTransportErrorKind | null;
}

export const ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_KEYS = Object.freeze([
  "schemaVersion",
  "category",
  "httpStatus",
  "providerErrorType",
  "providerErrorEnvelopeObserved",
  "requestIdPresent",
  "retryAfterSeconds",
  "responseStreamBegan",
  "stopReason",
  "modelEcho",
  "transportErrorKind",
] as const);

/** Upper bound on a `retry-after` value the envelope will represent (24 hours). */
export const ANTHROPIC_LIVE_CANARY_MAX_RETRY_AFTER_SECONDS = 86_400;
const MAX_DIAGNOSTIC_BODY_BYTES = 64 * 1024;
const MAX_STREAM_DATA_LINES = 32;
const MAX_STREAM_LINE_LENGTH = 8_192;
const MAX_ERROR_CODE_LENGTH = 64;

/**
 * Length is read through the intrinsic accessor. A payload can shadow
 * `byteLength` with an own property, and a diagnostic path that trusted it
 * could be steered past this module's size bound.
 */
const UINT8_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  "byteLength",
)!.get!;

function intrinsicByteLength(bytes: Uint8Array): number {
  return Reflect.apply(UINT8_ARRAY_BYTE_LENGTH, bytes, []) as number;
}

const ERROR_TYPES = new Set<string>(ANTHROPIC_PROVIDER_ERROR_TYPES);
const STOP_REASONS = new Set<string>(ANTHROPIC_PROVIDER_STOP_REASONS);
const CATEGORIES = new Set<string>(ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_CATEGORIES);
const TRANSPORT_ERROR_KINDS = new Set<string>(
  ANTHROPIC_LIVE_CANARY_TRANSPORT_ERROR_KINDS,
);

/**
 * Status is the classification authority for a received response. It is set by
 * the transport layer rather than the response body, so a body that disagrees
 * with it cannot promote a failure into a more specific claim.
 */
const STATUS_CATEGORIES: ReadonlyMap<number, AnthropicLiveCanaryDiagnosticCategory> =
  new Map([
    [400, "request-invalid"],
    [401, "credential-unauthenticated"],
    [402, "billing-unavailable"],
    [403, "permission-denied"],
    [404, "model-or-resource-unavailable"],
    [409, "request-conflict"],
    [413, "request-too-large"],
    [429, "rate-limited"],
    [500, "provider-internal-error"],
    [504, "provider-timeout"],
    [529, "provider-overloaded"],
  ] as const);

const ERROR_TYPE_CATEGORIES: ReadonlyMap<
  AnthropicProviderErrorType,
  AnthropicLiveCanaryDiagnosticCategory
> = new Map([
  ["invalid_request_error", "request-invalid"],
  ["authentication_error", "credential-unauthenticated"],
  ["billing_error", "billing-unavailable"],
  ["permission_error", "permission-denied"],
  ["not_found_error", "model-or-resource-unavailable"],
  ["conflict_error", "request-conflict"],
  ["request_too_large", "request-too-large"],
  ["rate_limit_error", "rate-limited"],
  ["api_error", "provider-internal-error"],
  ["timeout_error", "provider-timeout"],
  ["overloaded_error", "provider-overloaded"],
] as const);

const TRANSPORT_ERROR_CODES: ReadonlyMap<
  string,
  AnthropicLiveCanaryTransportErrorKind
> = new Map([
  ["ENOTFOUND", "dns"],
  ["EAI_AGAIN", "dns"],
  ["ECONNREFUSED", "connection-refused"],
  ["ECONNRESET", "connection-reset"],
  ["EPIPE", "connection-reset"],
  ["ECONNABORTED", "connection-reset"],
  ["EPROTO", "tls"],
  ["CERT_HAS_EXPIRED", "tls"],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"],
  ["SELF_SIGNED_CERT_IN_CHAIN", "tls"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
  ["ETIMEDOUT", "socket-timeout"],
  ["ESOCKETTIMEDOUT", "socket-timeout"],
  ["EHOSTUNREACH", "unreachable"],
  ["ENETUNREACH", "unreachable"],
  ["ENETDOWN", "unreachable"],
] as const);

const TLS_ERROR_CODE_PREFIXES = Object.freeze(["ERR_TLS_", "ERR_SSL_"] as const);

/** Normalizes an HTTP status to a plausible status or `null`. */
export function normalizeHttpStatus(value: unknown): number | null {
  if (!Number.isSafeInteger(value)) return null;
  const status = value as number;
  return status >= 100 && status <= 599 ? status : null;
}

/**
 * Normalizes a `retry-after` value. Negative, fractional, oversized, and
 * non-numeric values are rejected rather than clamped: a clamped value would
 * present attacker-chosen input as a measurement.
 */
export function normalizeRetryAfterSeconds(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return null;
    return value >= 0 && value <= ANTHROPIC_LIVE_CANARY_MAX_RETRY_AFTER_SECONDS
      ? value
      : null;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 16) {
    return null;
  }
  if (!/^[0-9]{1,16}$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed >= 0 && parsed <= ANTHROPIC_LIVE_CANARY_MAX_RETRY_AFTER_SECONDS
    ? parsed
    : null;
}

/**
 * Maps a runtime error to a transport family using only its `code` property,
 * read as a plain data property. Message, stack, cause, and any accessor are
 * never touched.
 */
export function transportErrorKindOf(
  error: unknown,
): AnthropicLiveCanaryTransportErrorKind | null {
  try {
    if (typeof error !== "object" || error === null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (descriptor === undefined || !("value" in descriptor)) return null;
    const code = descriptor.value;
    if (typeof code !== "string" || code.length === 0) return null;
    if (code.length > MAX_ERROR_CODE_LENGTH) return "other";
    const mapped = TRANSPORT_ERROR_CODES.get(code);
    if (mapped !== undefined) return mapped;
    for (const prefix of TLS_ERROR_CODE_PREFIXES) {
      if (code.startsWith(prefix)) return "tls";
    }
    return "other";
  } catch {
    // A hostile error object cannot widen the fixed diagnostic surface.
    return "other";
  }
}

export interface AnthropicProviderResponseFacts {
  readonly providerErrorType: AnthropicProviderErrorType | "unknown" | null;
  readonly providerErrorEnvelopeObserved: boolean;
  readonly responseStreamBegan: boolean;
  readonly stopReason: AnthropicProviderStopReason | "unknown" | null;
  readonly modelEcho: boolean | null;
}

const NO_RESPONSE_FACTS: AnthropicProviderResponseFacts = Object.freeze({
  providerErrorType: null,
  providerErrorEnvelopeObserved: false,
  responseStreamBegan: false,
  stopReason: null,
  modelEcho: null,
});

function safeParseRecord(text: string): Record<string, unknown> | null {
  try {
    return ensureRecord(JSON.parse(text), "canary.diagnosticBody");
  } catch {
    // Unparseable, exotic, accessor-bearing, and prototype-poisoned payloads
    // all yield "no envelope observed" rather than a classification.
    return null;
  }
}

/** Extracts an allowlisted `error.type` from one already-parsed envelope. */
function errorTypeFromEnvelope(
  record: Record<string, unknown>,
): AnthropicProviderErrorType | "unknown" | null {
  if (record["type"] !== "error") return null;
  let nested: Record<string, unknown>;
  try {
    nested = ensureRecord(record["error"], "canary.diagnosticBody.error");
  } catch {
    return null;
  }
  const type = nested["type"];
  if (typeof type !== "string" || type.length === 0 || type.length > 128) {
    return null;
  }
  return ERROR_TYPES.has(type) ? (type as AnthropicProviderErrorType) : "unknown";
}

function stopReasonFromMessage(
  record: Record<string, unknown>,
): AnthropicProviderStopReason | "unknown" | null {
  if (record["type"] !== "message") return null;
  const reason = record["stop_reason"];
  if (typeof reason !== "string" || reason.length === 0 || reason.length > 128) {
    return null;
  }
  return STOP_REASONS.has(reason)
    ? (reason as AnthropicProviderStopReason)
    : "unknown";
}

/**
 * Compares an observed model field against the pinned identifier. Only the
 * equality result is retained, so an unexpected model identifier is never
 * copied into the envelope.
 */
function modelEchoFromRecord(
  record: Record<string, unknown>,
  expectedModelId: string,
): boolean | null {
  const model = record["model"];
  if (typeof model !== "string" || model.length === 0 || model.length > 256) {
    return null;
  }
  return model === expectedModelId;
}

function looksLikeEventStream(contentType: string | null, text: string): boolean {
  if (
    typeof contentType === "string" &&
    contentType.toLowerCase().trimStart().startsWith("text/event-stream")
  ) {
    return true;
  }
  return /^(event|data):/m.test(text.slice(0, MAX_STREAM_LINE_LENGTH));
}

/**
 * Reads a bounded server-sent-event payload for an error envelope or a
 * terminal stop reason. The canary's fixed request is not a streaming request;
 * this exists so that a stream arriving anyway is classified rather than
 * collapsed into an unusable response.
 */
function readStreamFacts(text: string, expectedModelId: string): {
  readonly providerErrorType: AnthropicProviderErrorType | "unknown" | null;
  readonly envelopeObserved: boolean;
  readonly stopReason: AnthropicProviderStopReason | "unknown" | null;
  readonly modelEcho: boolean | null;
} {
  let providerErrorType: AnthropicProviderErrorType | "unknown" | null = null;
  let envelopeObserved = false;
  let stopReason: AnthropicProviderStopReason | "unknown" | null = null;
  let modelEcho: boolean | null = null;
  let examined = 0;
  for (const rawLine of text.split("\n")) {
    if (examined >= MAX_STREAM_DATA_LINES) break;
    const line = rawLine.trimEnd();
    if (!line.startsWith("data:")) continue;
    examined += 1;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload.length > MAX_STREAM_LINE_LENGTH) continue;
    const record = safeParseRecord(payload);
    if (record === null) continue;
    if (providerErrorType === null) {
      const type = errorTypeFromEnvelope(record);
      if (type !== null) {
        providerErrorType = type;
        envelopeObserved = true;
      }
    }
    if (modelEcho === null && record["type"] === "message_start") {
      try {
        modelEcho = modelEchoFromRecord(
          ensureRecord(record["message"], "canary.diagnosticBody.message"),
          expectedModelId,
        );
      } catch {
        // A malformed message_start contributes no model echo.
      }
    }
    if (modelEcho === null) {
      modelEcho = modelEchoFromRecord(record, expectedModelId);
    }
    if (stopReason === null) {
      const direct = stopReasonFromMessage(record);
      if (direct !== null) {
        stopReason = direct;
        continue;
      }
      if (record["type"] === "message_delta") {
        try {
          const delta = ensureRecord(record["delta"], "canary.diagnosticBody.delta");
          const reason = delta["stop_reason"];
          if (
            typeof reason === "string" &&
            reason.length > 0 &&
            reason.length <= 128
          ) {
            stopReason = STOP_REASONS.has(reason)
              ? (reason as AnthropicProviderStopReason)
              : "unknown";
          }
        } catch {
          // A malformed delta contributes no stop reason.
        }
      }
    }
  }
  return { providerErrorType, envelopeObserved, stopReason, modelEcho };
}

/**
 * Projects an untrusted response payload into allowlisted enum facts. The
 * decoded text is confined to this function: nothing derived from it escapes
 * except enum members and booleans.
 */
export function readProviderResponseFacts(
  body: unknown,
  contentType: unknown,
  expectedModelId: string,
): AnthropicProviderResponseFacts {
  try {
    if (!(body instanceof Uint8Array)) return NO_RESPONSE_FACTS;
    const length = intrinsicByteLength(body);
    if (
      !Number.isSafeInteger(length) ||
      length === 0 ||
      length > MAX_DIAGNOSTIC_BODY_BYTES
    ) {
      return NO_RESPONSE_FACTS;
    }
    const declaredContentType = typeof contentType === "string" &&
        contentType.length <= 256
      ? contentType
      : null;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
    const streamBegan = looksLikeEventStream(declaredContentType, text);
    if (streamBegan) {
      const stream = readStreamFacts(text, expectedModelId);
      return Object.freeze({
        providerErrorType: stream.providerErrorType,
        providerErrorEnvelopeObserved: stream.envelopeObserved,
        responseStreamBegan: true,
        stopReason: stream.stopReason,
        modelEcho: stream.modelEcho,
      });
    }
    const record = safeParseRecord(text);
    if (record === null) return NO_RESPONSE_FACTS;
    const providerErrorType = errorTypeFromEnvelope(record);
    return Object.freeze({
      providerErrorType,
      providerErrorEnvelopeObserved: providerErrorType !== null,
      responseStreamBegan: false,
      stopReason: stopReasonFromMessage(record),
      modelEcho: modelEchoFromRecord(record, expectedModelId),
    });
  } catch {
    // Diagnostic enrichment is best-effort and must never itself throw.
    return NO_RESPONSE_FACTS;
  }
}

export interface AnthropicLiveCanaryDiagnosticFacts {
  /**
   * A locally determined cause that outranks response evidence: an unmet
   * precondition, a broker failure, or the canary's own wall-clock bound.
   */
  readonly localCategory?:
    | "local-precondition"
    | "broker-unavailable"
    | "local-timeout"
    | null;
  readonly transportErrorKind?: AnthropicLiveCanaryTransportErrorKind | null;
  readonly httpStatus?: number | null;
  readonly requestIdPresent?: boolean;
  readonly retryAfterSeconds?: number | null;
  readonly responseFacts?: AnthropicProviderResponseFacts | null;
  /** True once the strict success projection has rejected the payload. */
  readonly responseRejected?: boolean;
}

/**
 * Derives the normalized category. Precedence is deliberate: local causes
 * outrank transport, transport outranks status, and status outranks the body,
 * because each earlier signal is produced closer to this process and is less
 * susceptible to influence by the payload being classified.
 */
export function classifyAnthropicLiveCanaryDiagnostics(
  facts: AnthropicLiveCanaryDiagnosticFacts,
): AnthropicLiveCanaryDiagnostics {
  // Every field is re-checked against its allowlist even though all current
  // producers are internal. The constructor is the last place an unallowlisted
  // value could enter the envelope, so it does not rely on its callers.
  const rawFacts = facts.responseFacts ?? NO_RESPONSE_FACTS;
  const providerErrorType = rawFacts.providerErrorType === "unknown" ||
      (typeof rawFacts.providerErrorType === "string" &&
        ERROR_TYPES.has(rawFacts.providerErrorType))
    ? rawFacts.providerErrorType
    : null;
  const stopReason = rawFacts.stopReason === "unknown" ||
      (typeof rawFacts.stopReason === "string" &&
        STOP_REASONS.has(rawFacts.stopReason))
    ? rawFacts.stopReason
    : null;
  const responseFacts: AnthropicProviderResponseFacts = Object.freeze({
    providerErrorType,
    providerErrorEnvelopeObserved:
      rawFacts.providerErrorEnvelopeObserved === true,
    responseStreamBegan: rawFacts.responseStreamBegan === true,
    stopReason,
    modelEcho: typeof rawFacts.modelEcho === "boolean"
      ? rawFacts.modelEcho
      : null,
  });
  const httpStatus = normalizeHttpStatus(facts.httpStatus ?? null);
  const rawKind = facts.transportErrorKind ?? null;
  const transportErrorKind = typeof rawKind === "string" &&
      TRANSPORT_ERROR_KINDS.has(rawKind)
    ? rawKind
    : null;
  const rawLocal = facts.localCategory ?? null;
  const localCategory = rawLocal === "local-precondition" ||
      rawLocal === "broker-unavailable" ||
      rawLocal === "local-timeout"
    ? rawLocal
    : null;

  let category: AnthropicLiveCanaryDiagnosticCategory;
  if (localCategory !== null) {
    category = localCategory;
  } else if (transportErrorKind !== null) {
    category = "network-transport";
  } else if (httpStatus !== null && httpStatus !== 200) {
    category = STATUS_CATEGORIES.get(httpStatus) ?? "unknown";
  } else if (httpStatus === 200) {
    const errorType = responseFacts.providerErrorType;
    if (errorType !== null && errorType !== "unknown") {
      category = ERROR_TYPE_CATEGORIES.get(errorType) ?? "unknown";
    } else if (responseFacts.providerErrorEnvelopeObserved) {
      category = "unknown";
    } else if (responseFacts.stopReason === "refusal") {
      category = "provider-refusal";
    } else if (facts.responseRejected === true) {
      category = "response-unusable";
    } else {
      category = "unknown";
    }
  } else if (facts.responseRejected === true) {
    category = "response-unusable";
  } else {
    category = "unknown";
  }

  return Object.freeze({
    schemaVersion: ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_SCHEMA_VERSION,
    category,
    httpStatus,
    providerErrorType: responseFacts.providerErrorType,
    providerErrorEnvelopeObserved: responseFacts.providerErrorEnvelopeObserved,
    requestIdPresent: facts.requestIdPresent === true,
    retryAfterSeconds: normalizeRetryAfterSeconds(facts.retryAfterSeconds ?? null),
    responseStreamBegan: responseFacts.responseStreamBegan === true,
    stopReason: responseFacts.stopReason,
    modelEcho: responseFacts.modelEcho,
    transportErrorKind,
  });
}

/** The envelope used when no evidence at all could be gathered. */
export function unknownAnthropicLiveCanaryDiagnostics(
  localCategory: AnthropicLiveCanaryDiagnosticFacts["localCategory"] = null,
): AnthropicLiveCanaryDiagnostics {
  return classifyAnthropicLiveCanaryDiagnostics({ localCategory });
}

/**
 * Re-validates an envelope that has crossed an untrusted boundary. The secret
 * broker may substitute or reshape a consumer's return value, so an envelope
 * arriving from that direction is treated exactly like provider input.
 */
export function projectAnthropicLiveCanaryDiagnostics(
  value: unknown,
): AnthropicLiveCanaryDiagnostics | null {
  try {
    const record = ensureRecord(value, "canary.diagnostics");
    const keys = Object.keys(record);
    if (keys.length !== ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_KEYS.length) return null;
    for (const key of ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) return null;
    }
    if (
      record["schemaVersion"] !== ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_SCHEMA_VERSION
    ) {
      return null;
    }
    const category = record["category"];
    if (typeof category !== "string" || !CATEGORIES.has(category)) return null;

    const httpStatus = record["httpStatus"];
    if (httpStatus !== null && normalizeHttpStatus(httpStatus) === null) {
      return null;
    }

    const providerErrorType = record["providerErrorType"];
    if (
      providerErrorType !== null &&
      (typeof providerErrorType !== "string" ||
        (providerErrorType !== "unknown" && !ERROR_TYPES.has(providerErrorType)))
    ) {
      return null;
    }

    const stopReason = record["stopReason"];
    if (
      stopReason !== null &&
      (typeof stopReason !== "string" ||
        (stopReason !== "unknown" && !STOP_REASONS.has(stopReason)))
    ) {
      return null;
    }

    const transportErrorKind = record["transportErrorKind"];
    if (
      transportErrorKind !== null &&
      (typeof transportErrorKind !== "string" ||
        !TRANSPORT_ERROR_KINDS.has(transportErrorKind))
    ) {
      return null;
    }

    const retryAfterSeconds = record["retryAfterSeconds"];
    if (
      retryAfterSeconds !== null &&
      normalizeRetryAfterSeconds(retryAfterSeconds) !== retryAfterSeconds
    ) {
      return null;
    }

    const envelopeObserved = record["providerErrorEnvelopeObserved"];
    const requestIdPresent = record["requestIdPresent"];
    const responseStreamBegan = record["responseStreamBegan"];
    const modelEcho = record["modelEcho"];
    if (
      typeof envelopeObserved !== "boolean" ||
      typeof requestIdPresent !== "boolean" ||
      typeof responseStreamBegan !== "boolean" ||
      (modelEcho !== null && typeof modelEcho !== "boolean")
    ) {
      return null;
    }

    return Object.freeze({
      schemaVersion: ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_SCHEMA_VERSION,
      category: category as AnthropicLiveCanaryDiagnosticCategory,
      httpStatus: httpStatus as number | null,
      providerErrorType: providerErrorType as
        | AnthropicProviderErrorType
        | "unknown"
        | null,
      providerErrorEnvelopeObserved: envelopeObserved,
      requestIdPresent,
      retryAfterSeconds: retryAfterSeconds as number | null,
      responseStreamBegan,
      stopReason: stopReason as AnthropicProviderStopReason | "unknown" | null,
      modelEcho: modelEcho as boolean | null,
      transportErrorKind: transportErrorKind as
        | AnthropicLiveCanaryTransportErrorKind
        | null,
    });
  } catch {
    return null;
  }
}

export function anthropicLiveCanaryDiagnosticsEqual(
  left: AnthropicLiveCanaryDiagnostics,
  right: AnthropicLiveCanaryDiagnostics,
): boolean {
  return ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_KEYS.every(
    (key) => left[key] === right[key],
  );
}
