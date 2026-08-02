/**
 * Workspace-relative paths.
 *
 * `parseSafeRelativePath` from `@ai-dev-os/artifacts` provides the lexical
 * guarantee: no absolute paths, no drive letters, no traversal, no control
 * characters, no Windows reserved device names, no trailing dot or space.
 * This module adds the rules that only matter once a path addresses a real
 * managed workspace rather than an artifact name.
 *
 * Honest limitation: this is still lexical. A path that is safe when validated
 * can be replaced by a link a moment later, and no amount of string checking
 * closes that window against a process running as the same user. Callers
 * re-validate against the filesystem immediately before each side effect, and
 * production safety rests on a sandbox that makes out-of-scope paths
 * unreachable in the first place.
 */

import { parseSafeRelativePath, type SafeRelativePath } from "@ai-dev-os/artifacts";
import { invalidRequest } from "./errors.js";

/**
 * Directory names that address repository or workspace administrative state
 * rather than working-tree content. Comparison is case-insensitive because
 * Windows and macOS resolve `.GIT` and `.git` to the same directory.
 */
export const RESERVED_WORKSPACE_SEGMENTS: ReadonlySet<string> = Object.freeze(
  new Set([".git", ".hg", ".svn", ".ai-dev-os"]),
);

export const MAX_WORKSPACE_PATH_DEPTH = 64;

/**
 * Validates a path that will be resolved inside a managed workspace.
 *
 * Beyond the lexical rules, this rejects any component that addresses
 * administrative state, bounds nesting depth, and refuses Unicode forms that
 * would normalize onto a reserved name.
 */
export function parseWorkspaceRelativePath(
  value: unknown,
  path = "relativePath",
): SafeRelativePath {
  const candidate = parseSafeRelativePath(value, path);
  const segments = candidate.split("/");

  if (segments.length > MAX_WORKSPACE_PATH_DEPTH) {
    throw invalidRequest("A workspace path is nested more deeply than allowed.", {
      field: path,
      depth: segments.length,
      maxDepth: MAX_WORKSPACE_PATH_DEPTH,
    });
  }

  for (const segment of segments) {
    // NFC folding first: a decomposed form must not slip past a reserved name.
    const folded = segment.normalize("NFC").toLowerCase();
    if (RESERVED_WORKSPACE_SEGMENTS.has(folded)) {
      throw invalidRequest("A workspace path addresses administrative state.", {
        field: path,
        segment: folded,
      });
    }
    // An alternate data stream is addressed with a colon. The lexical parser
    // already rejects `:`; this keeps the intent explicit if that changes.
    if (segment.includes(":")) {
      throw invalidRequest("A workspace path names an alternate data stream.", { field: path });
    }
  }

  return candidate;
}

export function isReservedWorkspaceSegment(segment: string): boolean {
  return RESERVED_WORKSPACE_SEGMENTS.has(segment.normalize("NFC").toLowerCase());
}

export type { SafeRelativePath };
