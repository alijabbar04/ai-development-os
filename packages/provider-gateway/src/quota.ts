import { validation } from "@ai-dev-os/domain";
import { PROVIDER_GATEWAY_SCHEMA_VERSION, type RuntimeQuotaObservation, type RuntimeQuotaPort } from "./types.js";
const { ensureEnum, ensureExactKeys, ensureNullable, ensureRecord, ensureSafeInteger, ensureString, ensureTimestamp } = validation;

export function parseRuntimeQuotaObservation(value: unknown): RuntimeQuotaObservation {
  const input = ensureRecord(value, "quota"); ensureExactKeys(input, ["schemaVersion", "state", "checkedAt", "source", "requestsRemaining", "tokensRemaining", "resetsAt", "detailCode"], "quota");
  if (input["schemaVersion"] !== PROVIDER_GATEWAY_SCHEMA_VERSION) throw new Error("quota.schemaVersion: unsupported schema");
  return Object.freeze({ schemaVersion: PROVIDER_GATEWAY_SCHEMA_VERSION, state: ensureEnum(input["state"], "quota.state", ["unknown", "available", "limited", "exhausted"] as const), checkedAt: ensureTimestamp(input["checkedAt"], "quota.checkedAt"), source: ensureEnum(input["source"], "quota.source", ["response-headers", "provider-api", "operator", "unobserved"] as const), requestsRemaining: ensureNullable(input["requestsRemaining"], (item) => ensureSafeInteger(item, "quota.requestsRemaining", 0, 1_000_000_000_000)), tokensRemaining: ensureNullable(input["tokensRemaining"], (item) => ensureSafeInteger(item, "quota.tokensRemaining", 0, 1_000_000_000_000)), resetsAt: ensureNullable(input["resetsAt"], (item) => ensureTimestamp(item, "quota.resetsAt")), detailCode: ensureNullable(input["detailCode"], (item) => ensureString(item, "quota.detailCode", { maxLength: 64, pattern: /^[a-z][a-z0-9._-]{0,63}$/u, patternName: "detail code" })) });
}

export function createUnknownQuotaPort(clock: { now(): Date }): RuntimeQuotaPort {
  return Object.freeze({ async observe() { return parseRuntimeQuotaObservation({ schemaVersion: 1, state: "unknown", checkedAt: clock.now().toISOString(), source: "unobserved", requestsRemaining: null, tokensRemaining: null, resetsAt: null, detailCode: null }); } });
}
