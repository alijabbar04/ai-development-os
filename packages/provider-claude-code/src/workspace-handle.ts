/**
 * The default managed-workspace handle.
 *
 * This is the composition helper that binds the adapter's narrow workspace port
 * to `@ai-dev-os/workspace`. Every fact about what changed comes from Git
 * plumbing run through the workspace package's own sanitized runtime, so hooks,
 * credential helpers, signing programs, editors, and user configuration are all
 * disabled on every invocation.
 *
 * The user's repository is never touched here. Diffs, patches, and commits all
 * address the managed private repository and its detached worktree; no ref in
 * the source repository moves, and no remote is contacted.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureWorktreeDiff,
  createWorkspaceAccess,
  createWorkspaceCommit,
  decodeTrimmed,
  runGitChecked,
  type ChangedFileManifest,
  type CommitManifest,
  type GitRuntime,
  type ManagedWorkspaceRecord,
} from "@ai-dev-os/workspace";
import type {
  CapabilityGrant,
  ExecutionLease,
  WorkspaceEnvironmentPaths,
} from "@ai-dev-os/process-broker";
import type { ClaudeCommitInput, ClaudeTestReport, ClaudeWorkspaceHandle } from "./ports.js";

export interface ClaudeWorkspaceHandleOptions {
  readonly runtime: GitRuntime;
  readonly record: ManagedWorkspaceRecord;
  readonly lease: ExecutionLease;
  readonly grant: CapabilityGrant;
  readonly paths: WorkspaceEnvironmentPaths;
  /**
   * The absolute root of the user's source repository, when known. The handle
   * refuses to operate if the managed worktree resolves to it.
   */
  readonly sourceRepositoryRoot?: string | null;
  readonly gitTimeoutMs?: number;
}

/**
 * Builds a workspace handle over a managed Stage 8 workspace record.
 *
 * The managed worktree is a `git worktree` of a private bare repository the
 * workspace package created; the source repository never receives a
 * `.git/worktrees` entry. That is what makes `isManagedPrivateWorktree` a fact
 * rather than an assertion.
 */
export function createClaudeWorkspaceHandle(
  options: ClaudeWorkspaceHandleOptions,
): ClaudeWorkspaceHandle {
  const { runtime, record, lease, grant, paths } = options;
  const timeoutMs = options.gitTimeoutMs ?? 120_000;
  const sourceRoot = options.sourceRepositoryRoot ?? null;
  const isManagedPrivateWorktree =
    sourceRoot === null || normalize(record.worktreeDir) !== normalize(sourceRoot);

  const access = createWorkspaceAccess({ worktreeDir: record.worktreeDir, grant, lease });

  return Object.freeze({
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    attemptId: record.attemptId,
    snapshotId: record.snapshotId,
    baseRevision: record.snapshotCommit,
    worktreeDir: record.worktreeDir,
    managedRoot: record.managedRoot,
    lease,
    grant,
    paths,
    isManagedPrivateWorktree,

    async captureChanges(): Promise<ChangedFileManifest> {
      return await captureWorktreeDiff(runtime, { workspace: record, timeoutMs });
    },

    async capturePatch(maxBytes: number): Promise<Uint8Array> {
      // `captureWorktreeDiff` has already staged the worktree, so the cached
      // diff against the snapshot commit is the reconciled change set.
      const result = await runGitChecked(
        runtime.runner,
        [
          ...runtime.configArguments(),
          "diff",
          "--cached",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "-M",
          "-C",
          record.snapshotCommit,
          "--",
        ],
        {
          cwd: record.worktreeDir,
          env: runtime.environment({
            gitDir: record.repositoryDir,
            workTree: record.worktreeDir,
          }),
          timeoutMs,
          maxOutputBytes: Math.max(1_024, maxBytes),
          operation: "capture-patch",
        },
      );
      const bytes = new Uint8Array(result.stdout);
      return bytes.byteLength > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
    },

    async commit(input: ClaudeCommitInput): Promise<CommitManifest> {
      return await createWorkspaceCommit(runtime, {
        workspace: record,
        message: input.message,
        committedAt: input.committedAt,
        authorCategory: "agent",
        policyFingerprint: input.policyFingerprint,
        timeoutMs,
      });
    },

    async readTestReport(relativePath: string, maxBytes: number): Promise<ClaudeTestReport | null> {
      let raw: Uint8Array;
      try {
        raw = await access.read(relativePath);
      } catch {
        return null;
      }
      if (raw.byteLength === 0 || raw.byteLength > maxBytes) {
        return null;
      }
      return parseTestReport(decodeTrimmed(Buffer.from(raw)));
    },

    async linkMetadata(relativePath: string): Promise<{ readonly isLink: boolean }> {
      const metadata = await access.linkMetadata(relativePath);
      return Object.freeze({ isLink: metadata.isLink });
    },
  });
}

function normalize(path: string): string {
  return join(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Parses the machine-readable test report the adapter reads from the managed
 * workspace. The schema is deliberately tiny and strict: it is evidence, not a
 * general report format, and anything that does not match exactly yields null
 * so structured test results stay absent rather than becoming a guess.
 */
export function parseTestReport(text: string): ClaudeTestReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return null;
    }
  }
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
      ? value
      : null;
  const passed = count(record["passed"]);
  const failed = count(record["failed"]);
  const skipped = count(record["skipped"]);
  if (passed === null || failed === null || skipped === null) {
    return null;
  }
  const suiteRaw = record["suite"];
  const suite =
    typeof suiteRaw === "string" && suiteRaw.length > 0 && suiteRaw.length <= 256
      ? suiteRaw
      : "workspace-test-report";
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
  if (/[\u0000-\u001f\u007f]/.test(suite)) {
    return null;
  }
  return Object.freeze({ suite, passed, failed, skipped });
}

/** Reads a bounded file directly from a managed worktree, for diagnostics. */
export async function readBoundedWorkspaceFile(
  worktreeDir: string,
  relativePath: string,
  maxBytes: number,
): Promise<Uint8Array | null> {
  try {
    const contents = await readFile(join(worktreeDir, relativePath));
    return contents.byteLength > maxBytes ? new Uint8Array(contents.subarray(0, maxBytes)) : new Uint8Array(contents);
  } catch {
    return null;
  }
}
