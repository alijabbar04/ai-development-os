/**
 * Target-ref movement and conflict detection.
 *
 * Both are read-only. Movement is reported, never resolved: nothing here
 * merges, rebases, moves a branch, or touches the user's repository. The
 * output is evidence for the later integration stage to act on.
 */

import { WorkspaceError } from "./errors.js";
import { decodeTrimmed, runGitChecked } from "./git-runner.js";
import type { GitRuntime } from "./runtime.js";
import type { RepositorySnapshot } from "./snapshot.js";

export const TARGET_MOVEMENTS = Object.freeze([
  "unchanged",
  "advanced",
  "rewound",
  "deleted",
  "replaced",
  "unavailable",
  "unrelated-history",
] as const);
export type TargetMovement = (typeof TARGET_MOVEMENTS)[number];

export interface TargetStatus {
  readonly ref: string | null;
  readonly observedCommit: string | null;
  readonly currentCommit: string | null;
  readonly movement: TargetMovement;
  /** True when the snapshot could still fast-forward onto the target. */
  readonly fastForwardPossible: boolean;
  readonly checkedAt: string;
}

export interface InspectTargetOptions {
  readonly snapshot: RepositorySnapshot;
  /** The source repository directory. Inspected read-only. */
  readonly repositoryRoot: string;
  readonly gitDir: string;
  readonly checkedAt: string;
  readonly timeoutMs?: number;
}

export async function inspectTarget(
  runtime: GitRuntime,
  options: InspectTargetOptions,
): Promise<TargetStatus> {
  const { snapshot } = options;
  const ref = snapshot.targetRef;
  const observed = snapshot.targetRefCommit;
  const config = runtime.configArguments();
  const base = {
    cwd: options.repositoryRoot,
    env: runtime.environment({ gitDir: options.gitDir, workTree: options.repositoryRoot }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  if (ref === null) {
    return frozenStatus({
      ref,
      observedCommit: observed,
      currentCommit: null,
      movement: "unavailable",
      fastForwardPossible: false,
      checkedAt: options.checkedAt,
    });
  }

  const resolved = await runtime.runner.run(
    [...config, "rev-parse", "--verify", "--quiet", `refs/heads/${ref}`],
    base,
  );
  if (resolved.exitCode !== 0) {
    return frozenStatus({
      ref,
      observedCommit: observed,
      currentCommit: null,
      movement: "deleted",
      fastForwardPossible: false,
      checkedAt: options.checkedAt,
    });
  }
  const current = decodeTrimmed(resolved.stdout);
  if (current === observed) {
    return frozenStatus({
      ref,
      observedCommit: observed,
      currentCommit: current,
      movement: "unchanged",
      fastForwardPossible: true,
      checkedAt: options.checkedAt,
    });
  }
  if (observed === null) {
    return frozenStatus({
      ref,
      observedCommit: observed,
      currentCommit: current,
      movement: "replaced",
      fastForwardPossible: false,
      checkedAt: options.checkedAt,
    });
  }

  const forward = await runtime.runner.run(
    [...config, "merge-base", "--is-ancestor", observed, current],
    base,
  );
  if (forward.exitCode === 0) {
    return frozenStatus({
      ref,
      observedCommit: observed,
      currentCommit: current,
      movement: "advanced",
      fastForwardPossible: true,
      checkedAt: options.checkedAt,
    });
  }
  const backward = await runtime.runner.run(
    [...config, "merge-base", "--is-ancestor", current, observed],
    base,
  );
  if (backward.exitCode === 0) {
    return frozenStatus({
      ref,
      observedCommit: observed,
      currentCommit: current,
      movement: "rewound",
      fastForwardPossible: false,
      checkedAt: options.checkedAt,
    });
  }

  const shared = await runtime.runner.run([...config, "merge-base", observed, current], base);
  return frozenStatus({
    ref,
    observedCommit: observed,
    currentCommit: current,
    movement: shared.exitCode === 0 ? "replaced" : "unrelated-history",
    fastForwardPossible: false,
    checkedAt: options.checkedAt,
  });
}

function frozenStatus(status: TargetStatus): TargetStatus {
  return Object.freeze(status);
}

export interface ConflictReport {
  readonly conflicted: boolean;
  readonly conflictingPaths: readonly string[];
  readonly mergeBase: string | null;
}

/**
 * Detects whether a candidate commit would conflict with a target commit,
 * using a purely in-memory three-way merge.
 *
 * `merge-tree` computes the result without an index, a working tree, or any
 * reference update, so neither the source repository nor the managed worktree
 * is modified. Semantic arbitration and actual integration belong to a later
 * stage; this answers only "would this collide".
 */
export async function detectConflicts(
  runtime: GitRuntime,
  options: {
    readonly repositoryDir: string;
    readonly managedRoot: string;
    readonly candidateCommit: string;
    readonly targetCommit: string;
    readonly timeoutMs?: number;
  },
): Promise<ConflictReport> {
  const config = runtime.configArguments();
  const base = {
    cwd: options.managedRoot,
    env: runtime.environment(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  const mergeBaseResult = await runtime.runner.run(
    [...config, "-C", options.repositoryDir, "merge-base", options.candidateCommit, options.targetCommit],
    base,
  );
  const mergeBase = mergeBaseResult.exitCode === 0 ? decodeTrimmed(mergeBaseResult.stdout) : null;

  const merge = await runtime.runner.run(
    [
      ...config,
      "-C",
      options.repositoryDir,
      "merge-tree",
      "--write-tree",
      "--name-only",
      options.targetCommit,
      options.candidateCommit,
    ],
    base,
  );

  // merge-tree exits 0 for a clean merge and 1 when there are conflicts.
  // Anything else is a real failure rather than an answer.
  if (merge.exitCode === 0) {
    return Object.freeze({ conflicted: false, conflictingPaths: Object.freeze([]), mergeBase });
  }
  if (merge.exitCode !== 1) {
    throw new WorkspaceError("GIT_BACKEND_FAILURE", "Conflict detection failed.", {
      exitCode: merge.exitCode,
    });
  }

  // On conflict the output is: the tree object id, then the conflicting paths
  // one per line, then a blank line, then human-readable messages such as
  // "Auto-merging <path>" and "CONFLICT (content): ...". Only the section
  // between the object id and the blank line is machine-readable, so the
  // informational tail is dropped rather than reported as file names.
  const lines = decodeTrimmed(merge.stdout).split("\n").map((line) => line.trim());
  const blank = lines.indexOf("");
  const paths = lines
    .slice(1, blank === -1 ? lines.length : blank)
    .filter((line) => line.length > 0);

  return Object.freeze({
    conflicted: true,
    conflictingPaths: Object.freeze([...new Set(paths)].sort()),
    mergeBase,
  });
}

/** Ensures a moved target is surfaced rather than silently worked around. */
export function assertTargetUnchanged(status: TargetStatus): void {
  if (status.movement !== "unchanged") {
    throw new WorkspaceError("TARGET_MOVED", "The target reference moved since the snapshot.", {
      movement: status.movement,
      ref: status.ref ?? "",
    });
  }
}
