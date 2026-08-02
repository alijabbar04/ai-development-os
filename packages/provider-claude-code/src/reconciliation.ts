/**
 * Workspace reconciliation.
 *
 * What Claude said it did is narrative. What the managed workspace contains is
 * fact, and only the fact is reported. Reconciliation runs on every terminal
 * path — success, failure, cancellation, deadline, malformed output, budget
 * exhaustion — because a run that ended badly can still have left half an edit
 * behind, and a caller that is not told about it cannot dispose of it.
 *
 * A violation found here fails the operation even when the task claimed
 * success. Evidence of the violation is preserved in bounded, safe form; the
 * changes themselves are never integrated into the user's branch, and nothing
 * is silently deleted.
 */

import type { ChangedFileEntry, ChangedFileManifest } from "@ai-dev-os/workspace";
import { prefixCovers, type CapabilityGrant } from "@ai-dev-os/process-broker";
import type { ChangedFileSummary, FileChangeKind } from "@ai-dev-os/providers";
import type { ClaudeDetailCode } from "./errors.js";
import type { ClaudeWorkspaceHandle } from "./ports.js";

/** Directory names that address administrative state rather than content. */
const ADMINISTRATIVE_SEGMENTS: ReadonlySet<string> = Object.freeze(
  new Set([".git", ".hg", ".svn", ".ai-dev-os"]),
);

export interface ReconciliationViolation {
  readonly detailCode: ClaudeDetailCode;
  /** Number of paths that triggered this violation. Paths are not listed. */
  readonly count: number;
}

export interface ReconciliationResult {
  readonly changedFiles: readonly ChangedFileSummary[];
  readonly changedFileCount: number;
  readonly totalProducedBytes: number;
  readonly violations: readonly ReconciliationViolation[];
  readonly clean: boolean;
  /** True when reconciliation itself could not run. */
  readonly unavailable: boolean;
}

/**
 * Maps Git's change vocabulary onto the provider-neutral one. Copies are
 * reported as additions because the neutral contract has no copy kind and a
 * copy genuinely adds a file; type, mode, and submodule changes are
 * modifications of an existing path.
 */
export function toNeutralChangeKind(kind: ChangedFileEntry["changeKind"]): FileChangeKind {
  switch (kind) {
    case "added":
    case "copied":
      return "added";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    case "modified":
    case "type-changed":
    case "mode-changed":
    case "submodule-changed":
    case "unmerged":
      return "modified";
  }
}

function isAdministrative(path: string): boolean {
  return path
    .split("/")
    .some((segment) => ADMINISTRATIVE_SEGMENTS.has(segment.normalize("NFC").toLowerCase()));
}

function isHostile(path: string): boolean {
  if (path.length === 0 || path.length > 1_024) {
    return true;
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\")) {
    return true;
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    return true;
  }
  return path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

export interface ReconciliationInput {
  readonly workspace: ClaudeWorkspaceHandle;
  readonly grant: CapabilityGrant;
  /** Request-level allowed prefixes; empty means the whole workspace. */
  readonly allowedPathPrefixes: readonly string[];
  readonly maxChangedFiles: number;
  readonly maxProducedBytes: number;
  readonly editingGranted: boolean;
}

/**
 * Re-inspects the managed workspace and reports exactly what changed.
 *
 * Every path is checked against the request's prefixes and the grant's
 * writable prefixes, against administrative state, against hostile shapes, and
 * against link indirection. A path that fails any check is counted as a
 * violation rather than reported as an ordinary change.
 */
export async function reconcileWorkspace(input: ReconciliationInput): Promise<ReconciliationResult> {
  let manifest: ChangedFileManifest;
  try {
    manifest = await input.workspace.captureChanges();
  } catch {
    return Object.freeze({
      changedFiles: Object.freeze([]),
      changedFileCount: 0,
      totalProducedBytes: 0,
      violations: Object.freeze([
        Object.freeze({ detailCode: "workspace-missing" as ClaudeDetailCode, count: 1 }),
      ]),
      clean: false,
      unavailable: true,
    });
  }

  const counts = new Map<ClaudeDetailCode, number>();
  const bump = (code: ClaudeDetailCode): void => {
    counts.set(code, (counts.get(code) ?? 0) + 1);
  };

  const accepted: ChangedFileSummary[] = [];
  let producedBytes = 0;
  const linkChecks: string[] = [];

  for (const entry of manifest.entries) {
    const path = entry.path;
    if (isHostile(path) || (entry.previousPath !== null && isHostile(entry.previousPath))) {
      bump("hostile-path");
      continue;
    }
    if (isAdministrative(path) || (entry.previousPath !== null && isAdministrative(entry.previousPath))) {
      bump("reconciliation-administrative-path");
      continue;
    }
    if (!input.editingGranted) {
      // A change exists where none was authorized at all.
      bump("reconciliation-path-violation");
      continue;
    }
    if (
      input.allowedPathPrefixes.length > 0 &&
      !prefixCovers(input.allowedPathPrefixes, path)
    ) {
      bump("reconciliation-path-violation");
      continue;
    }
    if (!prefixCovers(input.grant.writablePrefixes, path)) {
      bump("reconciliation-path-violation");
      continue;
    }
    if (entry.isSymlink) {
      bump("reconciliation-link-escape");
      continue;
    }
    if (entry.changeKind !== "deleted") {
      linkChecks.push(path);
    }
    producedBytes += entry.sizeBytes ?? 0;
    accepted.push(
      Object.freeze({ path, changeKind: toNeutralChangeKind(entry.changeKind) }),
    );
  }

  // Link and reparse-point escape is checked against the live filesystem, not
  // only against what Git recorded, because a junction created after staging
  // would not appear as a symlink entry.
  for (const path of linkChecks.slice(0, 512)) {
    try {
      const metadata = await input.workspace.linkMetadata(path);
      if (metadata.isLink) {
        bump("reconciliation-link-escape");
      }
    } catch {
      bump("reconciliation-link-escape");
    }
  }

  if (accepted.length > input.maxChangedFiles) {
    bump("reconciliation-file-limit");
  }
  if (producedBytes > input.maxProducedBytes) {
    bump("reconciliation-byte-limit");
  }
  if (manifest.truncated) {
    bump("reconciliation-file-limit");
  }

  const violations = Object.freeze(
    [...counts.entries()]
      .map(([detailCode, count]) => Object.freeze({ detailCode, count }))
      .sort((a, b) => (a.detailCode < b.detailCode ? -1 : 1)),
  );

  return Object.freeze({
    changedFiles: Object.freeze(
      [...accepted].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ),
    changedFileCount: accepted.length,
    totalProducedBytes: producedBytes,
    violations,
    clean: violations.length === 0,
    unavailable: false,
  });
}

/**
 * Compares what Claude claimed against what the workspace shows. The comparison
 * never overrides reconciliation; it exists so a mismatch can be recorded as a
 * warning and surfaced to a reviewer.
 */
export function compareClaimedChanges(
  claimedPaths: readonly string[],
  actual: readonly ChangedFileSummary[],
): { readonly claimedOnly: number; readonly actualOnly: number } {
  const actualSet = new Set(actual.map((entry) => entry.path));
  const claimedSet = new Set(claimedPaths);
  let claimedOnly = 0;
  for (const path of claimedSet) {
    if (!actualSet.has(path)) {
      claimedOnly += 1;
    }
  }
  let actualOnly = 0;
  for (const path of actualSet) {
    if (!claimedSet.has(path)) {
      actualOnly += 1;
    }
  }
  return Object.freeze({ claimedOnly, actualOnly });
}
