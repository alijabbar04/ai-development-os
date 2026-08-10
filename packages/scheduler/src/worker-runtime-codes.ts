export const INTERNAL_WORKER_FAILURE_CODES: ReadonlySet<string> = new Set([
  "lease-expired-before-dispatch",
  "lease-expired-reconciliation-required",
  "retry-exhausted",
  "usage-budget-exceeded",
  "usage-cost-unknown",
]);

export const INTERNAL_WORKER_CANCELLATION_CODES: ReadonlySet<string> = new Set([
  "cancellation-reconciliation-required",
  "deadline-expired",
]);

export function isInternalWorkerFailureCode(value: string): boolean {
  return INTERNAL_WORKER_FAILURE_CODES.has(value);
}

export function isInternalWorkerCancellationCode(value: string): boolean {
  return INTERNAL_WORKER_CANCELLATION_CODES.has(value);
}
