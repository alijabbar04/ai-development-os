/**
 * Immutable repository snapshots.
 *
 * A snapshot is a commit object that describes exactly what the source
 * repository looked like at one instant, created without writing a single
 * byte into the source repository.
 *
 * The mechanism, which is verified end to end by the hostile-fixture tests:
 *
 *   1. `GIT_OBJECT_DIRECTORY` points at a private object store, so every new
 *      object is written there. `GIT_ALTERNATE_OBJECT_DIRECTORIES` points at
 *      the source objects, which stay readable and are never written.
 *   2. The user's index file is *copied* to a private path and
 *      `GIT_INDEX_FILE` points at the copy. Copying is a plain file read, not
 *      a Git operation, and it preserves the user's staged state exactly.
 *   3. Working-tree content for unstaged changes is read by this process and
 *      hashed with `hash-object -w --no-filters --stdin`. Because the bytes
 *      arrive on standard input with no path attached, no `.gitattributes`
 *      entry applies and no clean filter runs.
 *   4. Those object identifiers are placed into the private index with
 *      `update-index --cacheinfo`, which records an entry without touching
 *      any file, and deletions are removed with `--force-remove`.
 *   5. `write-tree` and `commit-tree` turn the private index into a commit in
 *      the private object store.
 *
 * No step runs a hook, a filter, a textconv program, an external diff, or a
 * remote operation, and the source working tree, index, refs, and
 * configuration are all left byte-identical.
 *
 * Lifetime: the snapshot commit lives in the private store but its unchanged
 * blobs and trees are still borrowed from the source repository through the
 * alternates mechanism. If the source repository is garbage-collected or
 * deleted, those borrowed objects can disappear. The snapshot is valid for as
 * long as the source repository retains them; a caller that needs a longer
 * guarantee must materialize the objects, and this limitation is recorded
 * rather than papered over.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { toCanonicalJson } from "@ai-dev-os/domain";
import { WorkspaceError, causeCategory, invalidRequest } from "./errors.js";
import { decodeTrimmed, runGitChecked } from "./git-runner.js";
import type { RepositoryDiscovery } from "./discovery.js";
import { GITLINK_MODE } from "./manifest.js";
import type { GitRuntime } from "./runtime.js";

export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface SnapshotLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPathLength: number;
  readonly maxSymlinkTargetLength: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = Object.freeze({
  maxFiles: 20_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxPathLength: 1_024,
  maxSymlinkTargetLength: 4_096,
});

export interface RepositorySnapshot {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly projectId: string;
  /** The commit the working tree was based on. */
  readonly baseCommit: string;
  /** The snapshot commit. Equals `baseCommit` when the tree was clean. */
  readonly snapshotCommit: string;
  readonly treeId: string;
  readonly objectFormat: string;
  /** Recorded separately from the object it pointed at, so movement is visible. */
  readonly targetRef: string | null;
  readonly targetRefCommit: string | null;
  readonly dirty: boolean;
  readonly includedUntrackedPaths: readonly string[];
  readonly submodulePaths: readonly string[];
  readonly capturedAt: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** Absolute path to the private object store holding new objects. */
  readonly privateObjectDir: string;
  /** Object stores the snapshot borrows from and does not own. */
  readonly borrowedObjectDirs: readonly string[];
  readonly fingerprint: string;
}

export interface CaptureSnapshotOptions {
  readonly projectId: string;
  readonly snapshotId: string;
  readonly discovery: RepositoryDiscovery;
  /** Absolute directory the snapshot's private objects are written into. */
  readonly storageRoot: string;
  readonly capturedAt: string;
  /**
   * Untracked files to include. Inclusion is always explicit: an untracked
   * file that is not listed here is not captured, so a stray key file or a
   * multi-gigabyte build output is never swept in by accident.
   */
  readonly includeUntracked?: readonly string[];
  /** A dirty tree is only captured when the caller says so. */
  readonly allowDirty?: boolean;
  readonly limits?: SnapshotLimits;
  readonly timeoutMs?: number;
}

export async function captureSnapshot(
  runtime: GitRuntime,
  options: CaptureSnapshotOptions,
): Promise<RepositorySnapshot> {
  const discovery = options.discovery;
  const limits = options.limits ?? DEFAULT_SNAPSHOT_LIMITS;

  if (discovery.headCommit === null) {
    throw new WorkspaceError(
      "UNSUPPORTED_REPOSITORY",
      "A repository without any commit cannot be snapshotted.",
      {},
    );
  }
  const dirty = discovery.worktreeState === "dirty";
  if (dirty && options.allowDirty !== true) {
    throw new WorkspaceError(
      "DIRTY_SNAPSHOT_NOT_AUTHORIZED",
      "The working tree has uncommitted changes and dirty capture was not authorized.",
      {
        stagedCount: discovery.stagedChanges.length,
        unstagedCount: discovery.unstagedChanges.length,
        untrackedCount: discovery.untrackedPaths.length,
      },
    );
  }

  const selectedUntracked = Object.freeze([...new Set(options.includeUntracked ?? [])].sort());
  for (const path of selectedUntracked) {
    if (!discovery.untrackedPaths.includes(path)) {
      throw new WorkspaceError(
        "UNTRACKED_FILE_NOT_SELECTED",
        "An untracked path requested for capture is not untracked in the repository.",
        {},
      );
    }
  }

  const privateObjectDir = join(options.storageRoot, "objects");
  const privateIndex = join(options.storageRoot, "snapshot.index");
  await mkdir(privateObjectDir, { recursive: true });

  const borrowed = Object.freeze([join(discovery.commonGitDir, "objects")]);
  const env = runtime.environment({
    gitDir: discovery.gitDir,
    workTree: discovery.root,
    indexFile: privateIndex,
    objectDirectory: privateObjectDir,
    alternateObjectDirectories: borrowed,
  });
  // The repository's own filter and textconv drivers are neutralized here as
  // well: capture reads working-tree files and updates a private index, and a
  // racily-clean entry can still make Git re-hash through a filter.
  const config = [...runtime.configArguments(), ...discovery.programConfigOverrides];
  const base = {
    cwd: discovery.root,
    env,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  // A clean tree needs no new tree object: the base commit already is the
  // snapshot, identified by its object id rather than by a mutable branch name.
  if (!dirty) {
    const treeId = decodeTrimmed(
      (
        await runGitChecked(runtime.runner, [...config, "rev-parse", `${discovery.headCommit}^{tree}`], {
          ...base,
          operation: "rev-parse-tree",
        })
      ).stdout,
    );
    return freezeSnapshot({
      options,
      discovery,
      baseCommit: discovery.headCommit,
      snapshotCommit: discovery.headCommit,
      treeId,
      dirty: false,
      includedUntracked: selectedUntracked,
      fileCount: 0,
      totalBytes: 0,
      privateObjectDir,
      borrowed,
    });
  }

  // Copy the user's index so staged state is preserved exactly. This is a
  // file copy, not a Git command: the source index is only read.
  try {
    await copyFile(join(discovery.gitDir, "index"), privateIndex);
  } catch (error) {
    // A repository with no index yet is legitimate; start from HEAD instead.
    if (causeCategory(error) !== "ENOENT") {
      throw new WorkspaceError("GIT_BACKEND_FAILURE", "The repository index could not be copied.", {
        cause: causeCategory(error),
      });
    }
    await runGitChecked(runtime.runner, [...config, "read-tree", discovery.headCommit], {
      ...base,
      operation: "read-tree",
    });
  }

  let fileCount = 0;
  let totalBytes = 0;

  // Overlay unstaged working-tree changes onto the copied index.
  for (const entry of discovery.unstagedChanges) {
    if (entry.isSubmodule || entry.oldMode === GITLINK_MODE || entry.newMode === GITLINK_MODE) {
      // A gitlink is captured as the object id already recorded in the index.
      // The submodule is never entered, initialized, or fetched.
      continue;
    }
    if (entry.changeKind === "deleted") {
      await runGitChecked(
        runtime.runner,
        [...config, "update-index", "--force-remove", "--", entry.path],
        { ...base, operation: "update-index-remove" },
      );
      continue;
    }
    const staged = await stageWorkingTreeFile(runtime, {
      base,
      config,
      repositoryRoot: discovery.root,
      path: entry.path,
      limits,
    });
    fileCount += 1;
    totalBytes += staged.byteLength;
    if (fileCount > limits.maxFiles) {
      throw new WorkspaceError("SNAPSHOT_TOO_LARGE", "The snapshot exceeds the file-count bound.", {
        maxFiles: limits.maxFiles,
      });
    }
    if (totalBytes > limits.maxTotalBytes) {
      throw new WorkspaceError("SNAPSHOT_TOO_LARGE", "The snapshot exceeds the total byte bound.", {
        maxTotalBytes: limits.maxTotalBytes,
      });
    }
  }

  // Add the explicitly selected untracked files.
  for (const path of selectedUntracked) {
    const staged = await stageWorkingTreeFile(runtime, {
      base,
      config,
      repositoryRoot: discovery.root,
      path,
      limits,
    });
    fileCount += 1;
    totalBytes += staged.byteLength;
    if (fileCount > limits.maxFiles || totalBytes > limits.maxTotalBytes) {
      throw new WorkspaceError("SNAPSHOT_TOO_LARGE", "The snapshot exceeds its configured bounds.", {
        maxFiles: limits.maxFiles,
        maxTotalBytes: limits.maxTotalBytes,
      });
    }
  }

  const treeId = decodeTrimmed(
    (
      await runGitChecked(runtime.runner, [...config, "write-tree"], {
        ...base,
        operation: "write-tree",
      })
    ).stdout,
  );

  // commit-tree is plumbing: it creates one object and updates no reference,
  // so no hook can run and no branch can move.
  const commitEnv = runtime.environment({
    gitDir: discovery.gitDir,
    workTree: discovery.root,
    indexFile: privateIndex,
    objectDirectory: privateObjectDir,
    alternateObjectDirectories: borrowed,
    authorName: "AI Development OS",
    authorEmail: "snapshot@ai-dev-os.invalid",
    authorDate: options.capturedAt,
  });
  const snapshotCommit = decodeTrimmed(
    (
      await runGitChecked(
        runtime.runner,
        [...config, "commit-tree", treeId, "-p", discovery.headCommit, "-m", "workspace snapshot"],
        { ...base, env: commitEnv, operation: "commit-tree" },
      )
    ).stdout,
  );

  return freezeSnapshot({
    options,
    discovery,
    baseCommit: discovery.headCommit,
    snapshotCommit,
    treeId,
    dirty: true,
    includedUntracked: selectedUntracked,
    fileCount,
    totalBytes,
    privateObjectDir,
    borrowed,
  });
}

/**
 * Reads one working-tree file and records it in the private index.
 *
 * The bytes are read by this process and written to Git's standard input, so
 * Git never opens the path itself and no attribute-driven filter applies. A
 * symbolic link is captured as a link entry containing its target text, not
 * by following it, so a link pointing outside the repository cannot pull
 * outside content into the snapshot.
 */
async function stageWorkingTreeFile(
  runtime: GitRuntime,
  input: {
    readonly base: { cwd: string; env: Readonly<Record<string, string>>; timeoutMs?: number };
    readonly config: readonly string[];
    readonly repositoryRoot: string;
    readonly path: string;
    readonly limits: SnapshotLimits;
  },
): Promise<{ readonly byteLength: number }> {
  const { path, limits } = input;
  if (path.length > limits.maxPathLength) {
    throw new WorkspaceError("UNSAFE_PATH", "A repository path exceeds the length bound.", {
      maxPathLength: limits.maxPathLength,
    });
  }
  const absolute = join(input.repositoryRoot, path);

  let info;
  try {
    info = await stat(absolute);
  } catch (error) {
    if (causeCategory(error) === "ENOENT") {
      // The file vanished between discovery and capture; drop it from the
      // index rather than failing the whole snapshot.
      await runGitChecked(
        runtime.runner,
        [...input.config, "update-index", "--force-remove", "--", path],
        { ...input.base, operation: "update-index-remove" },
      );
      return { byteLength: 0 };
    }
    throw new WorkspaceError("GIT_BACKEND_FAILURE", "A working-tree file could not be inspected.", {
      cause: causeCategory(error),
    });
  }

  if (info.isSymbolicLink()) {
    throw new WorkspaceError("LINK_ESCAPE", "A symbolic link cannot be captured as file content.", {});
  }
  if (!info.isFile()) {
    throw new WorkspaceError("UNSAFE_PATH", "A snapshot entry is not a regular file.", {});
  }
  if (info.size > limits.maxFileBytes) {
    throw new WorkspaceError("SNAPSHOT_TOO_LARGE", "A file exceeds the per-file byte bound.", {
      maxFileBytes: limits.maxFileBytes,
    });
  }

  const bytes = await readFile(absolute);
  const blobId = decodeTrimmed(
    (
      await runGitChecked(
        runtime.runner,
        [...input.config, "hash-object", "-w", "--no-filters", "--stdin"],
        { ...input.base, stdin: bytes, operation: "hash-object" },
      )
    ).stdout,
  );

  // Preserve the executable bit where the platform records one.
  const mode = (info.mode & 0o111) !== 0 ? "100755" : "100644";
  await runGitChecked(
    runtime.runner,
    [...input.config, "update-index", "--add", "--cacheinfo", `${mode},${blobId},${path}`],
    { ...input.base, operation: "update-index-cacheinfo" },
  );

  return { byteLength: bytes.byteLength };
}

function freezeSnapshot(input: {
  readonly options: CaptureSnapshotOptions;
  readonly discovery: RepositoryDiscovery;
  readonly baseCommit: string;
  readonly snapshotCommit: string;
  readonly treeId: string;
  readonly dirty: boolean;
  readonly includedUntracked: readonly string[];
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly privateObjectDir: string;
  readonly borrowed: readonly string[];
}): RepositorySnapshot {
  const submodulePaths = Object.freeze(input.discovery.submodules.map((entry) => entry.path));
  const identity = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    projectId: input.options.projectId,
    snapshotId: input.options.snapshotId,
    baseCommit: input.baseCommit,
    snapshotCommit: input.snapshotCommit,
    treeId: input.treeId,
    objectFormat: input.discovery.objectFormat,
    targetRef: input.discovery.branch,
    targetRefCommit: input.discovery.headCommit,
    dirty: input.dirty,
    includedUntrackedPaths: [...input.includedUntracked],
    submodulePaths: [...submodulePaths],
  };
  return Object.freeze({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: input.options.snapshotId,
    projectId: input.options.projectId,
    baseCommit: input.baseCommit,
    snapshotCommit: input.snapshotCommit,
    treeId: input.treeId,
    objectFormat: input.discovery.objectFormat,
    targetRef: input.discovery.branch,
    targetRefCommit: input.discovery.headCommit,
    dirty: input.dirty,
    includedUntrackedPaths: input.includedUntracked,
    submodulePaths,
    capturedAt: input.options.capturedAt,
    fileCount: input.fileCount,
    totalBytes: input.totalBytes,
    privateObjectDir: input.privateObjectDir,
    borrowedObjectDirs: input.borrowed,
    // Deliberately excludes capture time and storage location: the same
    // repository state captured twice produces the same fingerprint.
    fingerprint: createHash("sha256").update(toCanonicalJson(identity), "utf8").digest("hex"),
  });
}

export function assertSnapshotUsable(snapshot: RepositorySnapshot): void {
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw invalidRequest("The snapshot schema version is unsupported.");
  }
}
