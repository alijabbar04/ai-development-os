/**
 * Workspace audit records.
 *
 * Records say what was attempted and how it ended. They carry identifiers,
 * fingerprints, counts, byte totals, and stable outcome codes — never file
 * content, source, diffs, command output, absolute paths, or Git's own error
 * text.
 */

export const WORKSPACE_AUDIT_EVENTS = Object.freeze([
  "discovery",
  "snapshot-attempt",
  "snapshot-result",
  "workspace-created",
  "workspace-leased",
  "workspace-read",
  "workspace-write",
  "git-operation",
  "diff-captured",
  "commit-created",
  "target-inspected",
  "conflict-detected",
  "cleanup",
] as const);
export type WorkspaceAuditEvent = (typeof WORKSPACE_AUDIT_EVENTS)[number];

export interface WorkspaceAuditRecord {
  readonly schemaVersion: 1;
  readonly event: WorkspaceAuditEvent;
  readonly occurredAt: string;
  readonly projectId: string;
  readonly workspaceId: string | null;
  readonly snapshotId: string | null;
  readonly attemptId: string | null;
  readonly outcome: string;
  readonly reasons: readonly string[];
  readonly fileCount: number | null;
  readonly byteCount: number | null;
  readonly fingerprint: string | null;
  readonly policyFingerprint: string | null;
  readonly durationMs: number | null;
}

export type WorkspaceObserver = (record: WorkspaceAuditRecord) => void;

export function createWorkspaceAuditRecord(
  input: Omit<WorkspaceAuditRecord, "schemaVersion">,
): WorkspaceAuditRecord {
  return Object.freeze({
    schemaVersion: 1 as const,
    ...input,
    reasons: Object.freeze([...input.reasons]),
  });
}

/** An observer failure must never change the outcome of the operation. */
export function notifyWorkspaceObserver(
  observer: WorkspaceObserver | undefined,
  record: WorkspaceAuditRecord,
): void {
  if (observer === undefined) {
    return;
  }
  try {
    observer(record);
  } catch {
    // Best effort at this layer; the caller owns the durable journal.
  }
}
