import { canonicalizeJson, toCanonicalJson, validation, type JsonValue } from "@ai-dev-os/domain";
import { parseSuccessEnvelope, serializeApiEnvelope } from "@ai-dev-os/api";
import { controlFail } from "./errors.js";

export const CONTROL_LIMITS = Object.freeze({
  maxHeaderBytes: 8_192,
  maxOwnedHeaderBytes: 4_096,
  maxHeaders: 32,
  maxHeaderNameBytes: 64,
  maxHeaderValueBytes: 1_024,
  maxUrlBytes: 512,
  maxQueryKeys: 4,
  maxQueryComponentBytes: 128,
  maxBodyBytes: 1_024,
  maxJsonDepth: 10,
  maxJsonNodes: 2_048,
  maxConcurrentRequests: 8,
  rateWindowMs: 10_000,
  maxRequestsPerWindow: 30,
  requestDeadlineMs: 500,
  maxResponseBytes: 64 * 1_024,
  maxRequestsPerSocket: 64,
});

export const CONTROL_ALLOWED_ORIGINS: readonly never[] = Object.freeze([]);

export const TRANSPORT_REFUSAL_CODES = Object.freeze([
  "AUTHENTICATION_REFUSED",
  "ORIGIN_REFUSED",
  "HOST_REFUSED",
  "BODY_REFUSED",
  "QUERY_REFUSED",
  "REQUEST_LIMIT_REFUSED",
  "RATE_REFUSED",
  "METHOD_NOT_ALLOWED",
  "ROUTE_NOT_FOUND",
  "DEADLINE_EXCEEDED",
  "SERVICE_UNAVAILABLE",
  "RESPONSE_LIMIT_REFUSED",
] as const);
export type TransportRefusalCode = (typeof TRANSPORT_REFUSAL_CODES)[number];

export interface TransportRefusalEnvelope {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly serverNow: string;
  readonly productionEnabled: false;
  readonly ok: false;
  readonly kind: "transport-refusal";
  readonly transportRefusal: Readonly<{
    readonly code: TransportRefusalCode;
    readonly details: null;
  }>;
}

export function serializeTransportRefusal(
  code: TransportRefusalCode,
  sequence: number,
  serverNow: string,
): string {
  if (!TRANSPORT_REFUSAL_CODES.includes(code)) controlFail("INVALID_INPUT");
  const envelope: TransportRefusalEnvelope = Object.freeze({
    schemaVersion: 1,
    sequence: validation.ensureSafeInteger(sequence, "sequence", 1, Number.MAX_SAFE_INTEGER),
    serverNow: validation.ensureTimestamp(serverNow, "serverNow"),
    productionEnabled: false,
    ok: false,
    kind: "transport-refusal",
    transportRefusal: Object.freeze({ code, details: null }),
  });
  return toCanonicalJson(envelope, "transportRefusalEnvelope");
}

export function serializeSuccess(
  payload: JsonValue,
  sequence: number,
  serverNow: string,
): string {
  const envelope = parseSuccessEnvelope({
    schemaVersion: 1,
    sequence,
    serverNow,
    productionEnabled: false,
    ok: true,
    kind: "success",
    payload,
  }, (value) => canonicalizeJson(value, "payload"));
  return serializeApiEnvelope(envelope);
}

export function assertResponseBound(payload: string): string {
  if (Buffer.byteLength(payload, "utf8") > CONTROL_LIMITS.maxResponseBytes) {
    controlFail("RESPONSE_REFUSED");
  }
  return payload;
}

export interface SessionRateLimiter {
  consume(serverNow: string): boolean;
}

export function createSessionRateLimiter(): SessionRateLimiter {
  let windowStartedAt = Number.NaN;
  let count = 0;
  return Object.freeze({
    consume(serverNow: string) {
      const now = new Date(validation.ensureTimestamp(serverNow, "serverNow")).valueOf();
      if (!Number.isFinite(windowStartedAt) || now < windowStartedAt || now - windowStartedAt >= CONTROL_LIMITS.rateWindowMs) {
        windowStartedAt = now;
        count = 0;
      }
      count += 1;
      return count <= CONTROL_LIMITS.maxRequestsPerWindow;
    },
  });
}

export function parseBoundedQuery(rawUrl: string, expectedKeys: readonly string[]): Readonly<Record<string, string>> {
  const question = rawUrl.indexOf("?");
  if (question < 0) {
    if (expectedKeys.length !== 0) controlFail("INVALID_INPUT");
    return Object.freeze(Object.create(null) as Record<string, string>);
  }
  const query = rawUrl.slice(question + 1);
  if (query.length === 0 || query.includes("#") || query.includes("%") || query.includes("+")) controlFail("INVALID_INPUT");
  const pairs = query.split("&");
  if (pairs.length > CONTROL_LIMITS.maxQueryKeys) controlFail("INVALID_INPUT");
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const pair of pairs) {
    const pieces = pair.split("=");
    if (pieces.length !== 2) controlFail("INVALID_INPUT");
    const key = pieces[0] ?? "";
    const value = pieces[1] ?? "";
    if (
      !expectedKeys.includes(key) || Object.hasOwn(output, key) ||
      key.length === 0 || value.length === 0 ||
      Buffer.byteLength(key, "utf8") > CONTROL_LIMITS.maxQueryComponentBytes ||
      Buffer.byteLength(value, "utf8") > CONTROL_LIMITS.maxQueryComponentBytes ||
      !/^[A-Za-z0-9._-]+$/u.test(value)
    ) controlFail("INVALID_INPUT");
    output[key] = value;
  }
  if (Object.keys(output).length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(output, key))) {
    controlFail("INVALID_INPUT");
  }
  return Object.freeze(output);
}
