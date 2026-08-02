/**
 * Diff capture and commit creation inside a managed workspace.
 *
 * Commits are created with plumbing (`write-tree` plus `commit-tree`) rather
 * than `git commit`. Plumbing runs no hook at all, so there is no
 * `--no-verify` to remember and no path by which a repository's own
 * `pre-commit` or `commit-msg` script executes. It also updates no reference,
 * so nothing can move a branch as a side effect.
 *
 * A zero exit code is not treated as success. The created objects are read
 * back and checked: the commit must exist, its tree must be the tree that was
 * written, and its parent must be the commit that was expected.
 */

import { createHash } from "node:crypto";
import { toCanonicalJson } from "@ai-dev-os/domain";
import { WorkspaceError } from "./errors.js";
import { decodeTrimmed, runGitChecked, splitNulRecords } from "./git-runner.js";
import {
  createChangedFileManifest,
  parseRawDiffRecords,
  type ChangedFileManifest,
} from "./manifest.js";
import type { GitRuntime } from "./runtime.js";
import type { ManagedWorkspaceRecord } from "./worktree.js";

export const COMMIT_MANIFEST_SCHEMA_VERSION = 1 as const;

export const AUTHOR_CATEGORIES = Object.freeze(["agent", "system", "user"] as const);
export type AuthorCategory = (typeof AUTHOR_CATEGORIES)[number];

export interface CommitManifest {
  readonly schemaVersion: typeof COMMIT_MANIFEST_SCHEMA_VERSION;
  readonly commitId: string;
  readonly treeId: string;
  readonly parentIds: readonly string[];
  readonly snapshotId: string;
  readonly baseCommit: string;
  readonly workspaceId: string;
  readonly attemptId: string;
  readonly changedFileFingerprint: string;
  readonly changedFileCount: number;
  readonly authorCategory: AuthorCategory;
  readonly timestampSource: "injected";
  readonly committedAt: string;
  readonly policyFingerprint: string;
  readonly messageByteLength: number;
  readonly fingerprint: string;
}

export const MAX_COMMIT_MESSAGE_BYTES = 16_384;

export interface CaptureDiffOptions {
  readonly workspace: ManagedWorkspaceRecord;
  /** Compare against this commit. Defaults to the snapshot the workspace began at. */
  readonly fromCommit?: string;
  readonly toCommit?: string;
  readonly detectRenames?: boolean;
  readonly timeoutMs?: number;
}

/**
 * Produces a changed-file manifest between two commits in the managed
 * repository. External diff programs, textconv, colour, and paging are all
 * disabled by the sanitizing configuration, and the NUL-delimited raw format
 * is parsed rather than any human-readable output.
 */
export async function captureDiff(
  runtime: GitRuntime,
  options: CaptureDiffOptions,
): Promise<ChangedFileManifest> {
  const from = options.fromCommit ?? options.workspace.snapshotCommit;
  const to = options.toCommit ?? "HEAD";
  const args = [
    ...runtime.configArguments(),
    "-C",
    options.workspace.repositoryDir,
    "diff-tree",
    "--raw",
    "-z",
    "-r",
    "--no-textconv",
    "--no-ext-diff",
  ];
  if (options.detectRenames !== false) {
    args.push("-M", "-C");
  }
  args.push(from, to, "--");

  const result = await runGitChecked(runtime.runner, args, {
    cwd: options.workspace.managedRoot,
    env: runtime.environment(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    operation: "diff-tree",
  });
  return createChangedFileManifest(parseRawDiffRecords(splitNulRecords(result.stdout)));
}

/** Captures the working-tree state of a managed worktree against its snapshot. */
export async function captureWorktreeDiff(
  runtime: GitRuntime,
  options: {
    readonly workspace: ManagedWorkspaceRecord;
    readonly timeoutMs?: number;
  },
): Promise<ChangedFileManifest> {
  const env = runtime.environment({
    gitDir: options.workspace.repositoryDir,
    workTree: options.workspace.worktreeDir,
  });
  const config = runtime.configArguments();
  const base = {
    cwd: options.workspace.worktreeDir,
    env,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  // Stage everything the agent produced into the worktree's own index, then
  // compare that index against the snapshot commit. `add` here operates on
  // the managed worktree, never on the user's repository.
  await runGitChecked(runtime.runner, [...config, "add", "--all", "--"], {
    ...base,
    operation: "add-worktree",
  });
  const result = await runGitChecked(
    runtime.runner,
    [
      ...config,
      "diff-index",
      "--cached",
      "--raw",
      "-z",
      "-M",
      "-C",
      "--no-textconv",
      "--no-ext-diff",
      options.workspace.snapshotCommit,
    ],
    { ...base, operation: "diff-index-worktree" },
  );
  return createChangedFileManifest(parseRawDiffRecords(splitNulRecords(result.stdout)));
}

export interface CreateCommitOptions {
  readonly workspace: ManagedWorkspaceRecord;
  readonly message: string;
  readonly committedAt: string;
  readonly authorCategory: AuthorCategory;
  readonly policyFingerprint: string;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly timeoutMs?: number;
}

export async function createWorkspaceCommit(
  runtime: GitRuntime,
  options: CreateCommitOptions,
): Promise<CommitManifest> {
  const messageBytes = Buffer.byteLength(options.message, "utf8");
  if (messageBytes === 0 || messageBytes > MAX_COMMIT_MESSAGE_BYTES) {
    throw new WorkspaceError("INVALID_REQUEST", "The commit message is empty or too large.", {
      messageByteLength: messageBytes,
      maxBytes: MAX_COMMIT_MESSAGE_BYTES,
    });
  }

  const workspace = options.workspace;
  const config = runtime.configArguments();
  const env = runtime.environment({
    gitDir: workspace.repositoryDir,
    workTree: workspace.worktreeDir,
    authorName: options.authorName ?? "AI Development OS",
    authorEmail: options.authorEmail ?? "attempt@ai-dev-os.invalid",
    authorDate: options.committedAt,
  });
  const base = {
    cwd: workspace.worktreeDir,
    env,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  await runGitChecked(runtime.runner, [...config, "add", "--all", "--"], {
    ...base,
    operation: "add-before-commit",
  });
  const treeId = decodeTrimmed(
    (
      await runGitChecked(runtime.runner, [...config, "write-tree"], {
        ...base,
        operation: "write-tree-commit",
      })
    ).stdout,
  );
  const commitId = decodeTrimmed(
    (
      await runGitChecked(
        runtime.runner,
        [...config, "commit-tree", treeId, "-p", workspace.snapshotCommit, "-m", options.message],
        { ...base, operation: "commit-tree" },
      )
    ).stdout,
  );

  // Exit zero is not proof. Read the object back and confirm what it is.
  const verified = await verifyCommit(runtime, {
    repositoryDir: workspace.repositoryDir,
    managedRoot: workspace.managedRoot,
    commitId,
    expectedTree: treeId,
    expectedParent: workspace.snapshotCommit,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  const manifest = await captureDiff(runtime, {
    workspace,
    fromCommit: workspace.snapshotCommit,
    toCommit: commitId,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  const identity = {
    schemaVersion: COMMIT_MANIFEST_SCHEMA_VERSION,
    commitId,
    treeId,
    parentIds: [...verified.parentIds],
    snapshotId: workspace.snapshotId,
    baseCommit: workspace.baseCommit,
    workspaceId: workspace.workspaceId,
    attemptId: workspace.attemptId,
    changedFileFingerprint: manifest.fingerprint,
  };

  return Object.freeze({
    schemaVersion: COMMIT_MANIFEST_SCHEMA_VERSION,
    commitId,
    treeId,
    parentIds: verified.parentIds,
    snapshotId: workspace.snapshotId,
    baseCommit: workspace.baseCommit,
    workspaceId: workspace.workspaceId,
    attemptId: workspace.attemptId,
    changedFileFingerprint: manifest.fingerprint,
    changedFileCount: manifest.entries.length,
    authorCategory: options.authorCategory,
    timestampSource: "injected" as const,
    committedAt: options.committedAt,
    policyFingerprint: options.policyFingerprint,
    messageByteLength: messageBytes,
    fingerprint: createHash("sha256").update(toCanonicalJson(identity), "utf8").digest("hex"),
  });
}

async function verifyCommit(
  runtime: GitRuntime,
  input: {
    readonly repositoryDir: string;
    readonly managedRoot: string;
    readonly commitId: string;
    readonly expectedTree: string;
    readonly expectedParent: string;
    readonly timeoutMs?: number;
  },
): Promise<{ readonly parentIds: readonly string[] }> {
  const config = runtime.configArguments();
  const base = {
    cwd: input.managedRoot,
    env: runtime.environment(),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  };

  const type = decodeTrimmed(
    (
      await runGitChecked(
        runtime.runner,
        [...config, "-C", input.repositoryDir, "cat-file", "-t", input.commitId],
        { ...base, operation: "cat-file-type" },
      )
    ).stdout,
  );
  if (type !== "commit") {
    throw new WorkspaceError("GIT_BACKEND_FAILURE", "The created object is not a commit.", {});
  }

  const tree = decodeTrimmed(
    (
      await runGitChecked(
        runtime.runner,
        [...config, "-C", input.repositoryDir, "rev-parse", `${input.commitId}^{tree}`],
        { ...base, operation: "verify-tree" },
      )
    ).stdout,
  );
  if (tree !== input.expectedTree) {
    throw new WorkspaceError("GIT_BACKEND_FAILURE", "The commit does not reference the written tree.", {});
  }

  const parents = decodeTrimmed(
    (
      await runGitChecked(
        runtime.runner,
        [...config, "-C", input.repositoryDir, "rev-list", "--parents", "-n", "1", input.commitId],
        { ...base, operation: "verify-parents" },
      )
    ).stdout,
  )
    .split(" ")
    .slice(1)
    .filter((value) => value.length > 0);

  if (!parents.includes(input.expectedParent)) {
    throw new WorkspaceError("GIT_BACKEND_FAILURE", "The commit does not have the expected parent.", {});
  }
  return { parentIds: Object.freeze(parents) };
}
