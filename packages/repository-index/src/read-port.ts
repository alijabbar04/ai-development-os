/**
 * The snapshot read port.
 *
 * Stage 14 never touches a filesystem, never runs Git, and never walks a
 * checkout. Everything it can see arrives through this injected port, which
 * the caller wires to a Stage 8 immutable snapshot (or, in tests, to a
 * deterministic in-memory fixture).
 *
 * Why a port rather than a direct dependency on `@ai-dev-os/workspace`: the
 * Stage 8 workspace abstraction exposes *mutable* worktree access bound to a
 * process-broker capability grant. Indexing needs the opposite — an immutable,
 * already-authorized listing of a fixed revision, with no ability to write,
 * to watch, or to widen its own scope. Expressing that as a narrow port keeps
 * the hostile-repository protections of Stage 8 on the adapter side of the
 * boundary, where they belong, and keeps this package free of ambient
 * filesystem, process, and environment access.
 *
 * Contract for adapters:
 *
 * - `list()` returns only entries the caller is already authorized to read.
 *   The indexer applies configured exclusions on top; it never widens.
 * - `read()` must not follow a symbolic link or reparse point. Link entries
 *   are reported as metadata by `list()` and are never read as content.
 * - Neither method may mutate the source repository.
 */

import type { ProjectId, WorkspaceId } from "@ai-dev-os/domain";

export const FILESYSTEM_CASE_SENSITIVITIES = Object.freeze([
  "case-sensitive",
  "case-insensitive",
] as const);

export type FilesystemCaseSensitivity = (typeof FILESYSTEM_CASE_SENSITIVITIES)[number];

export const UNICODE_PATH_FORMS = Object.freeze(["nfc", "preserve"] as const);

export type UnicodePathForm = (typeof UNICODE_PATH_FORMS)[number];

/**
 * How the snapshot's originating filesystem treats names. Declared by the
 * adapter, not sniffed from the host, so the same snapshot indexes identically
 * everywhere.
 */
export interface FilesystemSemantics {
  readonly caseSensitivity: FilesystemCaseSensitivity;
  readonly unicodeForm: UnicodePathForm;
}

/**
 * The exact source revision, or an explicit statement that there is none.
 * "No revision" is a first-class state, never an empty string.
 */
export type SourceRevision =
  | {
      readonly type: "commit";
      readonly commitId: string;
      readonly treeId: string;
      readonly objectFormat: string;
    }
  | { readonly type: "no-revision"; readonly reason: string };

export interface SnapshotIdentity {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly snapshotId: string;
  readonly revision: SourceRevision;
  readonly filesystemSemantics: FilesystemSemantics;
}

export const SNAPSHOT_ENTRY_KINDS = Object.freeze([
  "file",
  "directory",
  "symlink",
  "submodule",
  "other",
] as const);

export type SnapshotEntryKind = (typeof SNAPSHOT_ENTRY_KINDS)[number];

export interface SnapshotEntry {
  /** Raw repository-relative path exactly as the snapshot records it. */
  readonly path: string;
  readonly kind: SnapshotEntryKind;
  readonly sizeBytes: number;
  readonly executable: boolean;
  /**
   * Link target text for `symlink` entries, recorded as metadata only. The
   * indexer never resolves it.
   */
  readonly linkTarget: string | null;
  /**
   * True only when the workspace abstraction has itself verified that the
   * link resolves inside the snapshot. The indexer treats `false` as
   * "unverified" and refuses to read through the link either way.
   */
  readonly linkTargetVerifiedSafe: boolean;
}

export interface SnapshotReadPort {
  /** Stable identity of the snapshot being indexed. Pure; no I/O. */
  identity(): SnapshotIdentity;
  /** Every authorized entry. Order is irrelevant: the indexer re-sorts. */
  list(): Promise<readonly SnapshotEntry[]>;
  /**
   * Reads at most `maxBytes` of one file entry. Adapters must reject
   * directories, links, and anything `list()` did not report as a file.
   */
  read(path: string, maxBytes: number): Promise<Uint8Array>;
}

/** Injectable time source; the indexer never reads the system clock. */
export interface IndexClock {
  now(): Date;
}

/** Minimal cancellation surface, structurally compatible with `AbortSignal`. */
export interface CancellationSignal {
  readonly aborted: boolean;
}
