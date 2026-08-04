export const TELEMETRY_ERROR_CODES = Object.freeze([
  "INVALID_OBSERVATION",
  "UNSUPPORTED_SCHEMA",
  "INTEGRITY_FAILURE",
  "IDENTITY_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "NON_MONOTONIC_USAGE",
  "TERMINAL_CONTRADICTION",
  "OVERFLOW",
  "PARTITION_FULL",
  "ACCESS_DENIED",
  "AUDIT_FAILURE",
  "CONCURRENCY_EXHAUSTED",
  "STORE_CLOSED",
] as const);

export type TelemetryErrorCode = (typeof TELEMETRY_ERROR_CODES)[number];

/** Bounded, content-free error used at the ledger boundary. */
export class TelemetryError extends Error {
  readonly code: TelemetryErrorCode;
  readonly detailCode: string;

  constructor(code: TelemetryErrorCode, detailCode: string) {
    super(`Telemetry operation failed (${code}).`);
    this.name = "TelemetryError";
    this.code = code;
    this.detailCode = detailCode.slice(0, 64);
  }
}

export function isTelemetryError(value: unknown): value is TelemetryError {
  return value instanceof TelemetryError;
}
