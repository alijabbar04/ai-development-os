export const SCHEDULER_ERROR_CODES = Object.freeze([
  "INVALID_TASK",
  "INVALID_EVENT",
  "INVALID_TRANSITION",
  "IDEMPOTENCY_CONFLICT",
  "DUPLICATE_TERMINAL",
  "STATE_CORRUPTION",
  "NOT_FOUND",
  "CONCURRENCY_LIMIT",
  "BACKPRESSURE",
  "CAPACITY_UNAVAILABLE",
  "LEASE_CONFLICT",
  "FENCING_REJECTED",
  "USAGE_REFUSED",
  "CIRCUIT_OPEN",
  "PRODUCTION_DISABLED",
  "POLICY_BLOCKED",
  "PROVIDER_UNAVAILABLE",
  "RETRY_EXHAUSTED",
] as const);

export type SchedulerErrorCode = (typeof SCHEDULER_ERROR_CODES)[number];

export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: SchedulerErrorCode,
    message: string,
    details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
    this.name = "SchedulerError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function isSchedulerError(value: unknown): value is SchedulerError {
  return value instanceof SchedulerError;
}
