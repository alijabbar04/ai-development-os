/**
 * Audit records.
 *
 * A record answers "what was attempted, under whose authority, and how did it
 * end" without ever answering "what did it say". Records carry identifiers,
 * fingerprints, counts, byte totals, stable codes, and injected timestamps.
 * They never carry command output, environment values, secrets, repository
 * content, absolute paths, or raw platform errors.
 */

export const PROCESS_AUDIT_EVENTS = Object.freeze([
  "admission",
  "production-refusal",
  "sandbox-prepared",
  "process-start",
  "process-terminal",
  "cancellation",
  "quota-outcome",
  "sandbox-disposed",
] as const);
export type ProcessAuditEvent = (typeof PROCESS_AUDIT_EVENTS)[number];

export interface ProcessAuditRecord {
  readonly schemaVersion: 1;
  readonly event: ProcessAuditEvent;
  readonly occurredAt: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly traceId: string;
  readonly backendId: string;
  readonly securityClass: string;
  readonly mode: string;
  readonly toolId: string;
  readonly argumentCount: number;
  readonly policyFingerprint: string;
  readonly grantFingerprint: string;
  /** Terminal state or refusal category. Never a platform message. */
  readonly outcome: string;
  readonly reasons: readonly string[];
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly environmentNameCount: number;
}

export type ProcessObserver = (record: ProcessAuditRecord) => void;

export function createAuditRecord(
  input: Omit<ProcessAuditRecord, "schemaVersion">,
): ProcessAuditRecord {
  return Object.freeze({
    schemaVersion: 1 as const,
    ...input,
    reasons: Object.freeze([...input.reasons]),
  });
}

/**
 * Runs an observer without letting its failure change execution. An observer
 * that throws must not leak a running process or mask a terminal result.
 */
export function notifyObserver(
  observer: ProcessObserver | undefined,
  record: ProcessAuditRecord,
): void {
  if (observer === undefined) {
    return;
  }
  try {
    observer(record);
  } catch {
    // Deliberately swallowed: audit delivery is best effort at this layer and
    // the caller already owns the durable journal.
  }
}
