/**
 * Changed-file manifests.
 *
 * Entries are parsed from Git's NUL-delimited raw diff format, never from the
 * human-readable status output, which is localized and quotes paths.
 *
 * A manifest describes *what* changed and carries digests and object
 * identifiers. It never embeds file content. A large or binary difference is
 * referenced by artifact instead, so a result envelope stays bounded whatever
 * the repository contains.
 */

import { createHash } from "node:crypto";
import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import { WorkspaceError, invalidRequest } from "./errors.js";

const { ensureEnum, ensureExactKeys, ensureRecord, ensureString } = validation;

export const CHANGE_MANIFEST_SCHEMA_VERSION = 1 as const;

export const CHANGE_KINDS = Object.freeze([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type-changed",
  "mode-changed",
  "submodule-changed",
  "unmerged",
] as const);
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const MAX_MANIFEST_ENTRIES = 50_000;

/** Git's file modes. `160000` is a gitlink: a submodule reference. */
export const GITLINK_MODE = "160000";
export const SYMLINK_MODE = "120000";

export interface ChangedFileEntry {
  readonly path: string;
  readonly previousPath: string | null;
  readonly changeKind: ChangeKind;
  readonly oldObjectId: string | null;
  readonly newObjectId: string | null;
  readonly oldMode: string | null;
  readonly newMode: string | null;
  readonly similarityPercent: number | null;
  readonly isSubmodule: boolean;
  readonly isSymlink: boolean;
  readonly sizeBytes: number | null;
  readonly binary: boolean;
  /** Set when the difference is retained as an artifact instead of inline. */
  readonly diffArtifactDigest: string | null;
}

export interface ChangedFileManifest {
  readonly schemaVersion: typeof CHANGE_MANIFEST_SCHEMA_VERSION;
  readonly entries: readonly ChangedFileEntry[];
  readonly truncated: boolean;
  /** Stable digest over the manifest's meaning. */
  readonly fingerprint: string;
}

const NULL_OID = /^0+$/;
const OID_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const MODE_PATTERN = /^[0-7]{6}$/;

function statusToChangeKind(status: string): ChangeKind {
  switch (status) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    case "U":
      return "unmerged";
    default:
      throw new WorkspaceError("GIT_BACKEND_FAILURE", "Git reported an unrecognized change status.", {
        status: status.slice(0, 4),
      });
  }
}

/**
 * Parses `git diff-tree`/`git diff-index --raw -z` output.
 *
 * Each record is `:<oldMode> <newMode> <oldOid> <newOid> <status>` followed by
 * a NUL, the path, a NUL, and — for a rename or a copy only — a second path
 * and NUL. The records and the paths share one NUL stream, so the parser
 * consumes a variable number of fields per entry and must not assume a fixed
 * stride.
 */
export function parseRawDiffRecords(records: readonly string[]): readonly ChangedFileEntry[] {
  const entries: ChangedFileEntry[] = [];
  let index = 0;

  while (index < records.length) {
    const header = records[index];
    index += 1;
    if (header === undefined || header.length === 0) {
      continue;
    }
    if (!header.startsWith(":")) {
      throw new WorkspaceError("GIT_BACKEND_FAILURE", "Git raw diff output was malformed.", {});
    }
    const fields = header.slice(1).split(" ");
    const [oldMode, newMode, oldOid, newOid, statusField] = fields;
    if (
      oldMode === undefined ||
      newMode === undefined ||
      oldOid === undefined ||
      newOid === undefined ||
      statusField === undefined
    ) {
      throw new WorkspaceError("GIT_BACKEND_FAILURE", "Git raw diff output was malformed.", {});
    }
    if (!MODE_PATTERN.test(oldMode) || !MODE_PATTERN.test(newMode)) {
      throw new WorkspaceError("GIT_BACKEND_FAILURE", "Git reported an invalid file mode.", {});
    }

    const statusLetter = statusField.slice(0, 1);
    const scoreText = statusField.slice(1);
    const similarityPercent = scoreText.length > 0 ? Number.parseInt(scoreText, 10) : null;
    const changeKind = statusToChangeKind(statusLetter);

    const path = records[index];
    index += 1;
    if (path === undefined) {
      throw new WorkspaceError("GIT_BACKEND_FAILURE", "Git raw diff output ended unexpectedly.", {});
    }

    // Only rename and copy carry a second path, and Git emits source first.
    let previousPath: string | null = null;
    let finalPath = path;
    if (changeKind === "renamed" || changeKind === "copied") {
      const destination = records[index];
      index += 1;
      if (destination === undefined) {
        throw new WorkspaceError(
          "GIT_BACKEND_FAILURE",
          "Git raw diff output ended unexpectedly.",
          {},
        );
      }
      previousPath = path;
      finalPath = destination;
    }

    const isSubmodule = oldMode === GITLINK_MODE || newMode === GITLINK_MODE;
    const isSymlink = oldMode === SYMLINK_MODE || newMode === SYMLINK_MODE;
    const effectiveKind: ChangeKind =
      isSubmodule && changeKind === "modified" ? "submodule-changed" : changeKind;

    entries.push(
      Object.freeze({
        path: finalPath,
        previousPath,
        changeKind: effectiveKind,
        oldObjectId: NULL_OID.test(oldOid) ? null : oldOid,
        newObjectId: NULL_OID.test(newOid) ? null : newOid,
        oldMode: oldMode === "000000" ? null : oldMode,
        newMode: newMode === "000000" ? null : newMode,
        similarityPercent:
          similarityPercent !== null && Number.isSafeInteger(similarityPercent)
            ? similarityPercent
            : null,
        isSubmodule,
        isSymlink,
        sizeBytes: null,
        binary: false,
        diffArtifactDigest: null,
      }),
    );

    if (entries.length > MAX_MANIFEST_ENTRIES) {
      break;
    }
  }

  return Object.freeze(entries);
}

export function createChangedFileManifest(
  entries: readonly ChangedFileEntry[],
): ChangedFileManifest {
  const bounded = entries.slice(0, MAX_MANIFEST_ENTRIES);
  const sorted = Object.freeze(
    [...bounded].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
  return Object.freeze({
    schemaVersion: CHANGE_MANIFEST_SCHEMA_VERSION,
    entries: sorted,
    truncated: entries.length > MAX_MANIFEST_ENTRIES,
    fingerprint: createHash("sha256")
      .update(
        toCanonicalJson(
          sorted.map((entry) => ({
            path: entry.path,
            previousPath: entry.previousPath,
            changeKind: entry.changeKind,
            oldObjectId: entry.oldObjectId,
            newObjectId: entry.newObjectId,
            oldMode: entry.oldMode,
            newMode: entry.newMode,
          })),
        ),
        "utf8",
      )
      .digest("hex"),
  });
}

const ENTRY_KEYS = [
  "path",
  "previousPath",
  "changeKind",
  "oldObjectId",
  "newObjectId",
  "oldMode",
  "newMode",
  "similarityPercent",
  "isSubmodule",
  "isSymlink",
  "sizeBytes",
  "binary",
  "diffArtifactDigest",
] as const;

export function parseChangedFileEntry(value: unknown, path = "entry"): ChangedFileEntry {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ENTRY_KEYS, path);
  const optionalOid = (field: string): string | null => {
    const raw = record[field];
    if (raw === undefined || raw === null) {
      return null;
    }
    const text = ensureString(raw, `${path}.${field}`, { maxLength: 64 });
    if (!OID_PATTERN.test(text)) {
      throw invalidRequest("An object identifier is malformed.", { field });
    }
    return text;
  };
  const optionalMode = (field: string): string | null => {
    const raw = record[field];
    if (raw === undefined || raw === null) {
      return null;
    }
    const text = ensureString(raw, `${path}.${field}`, { minLength: 6, maxLength: 6 });
    if (!MODE_PATTERN.test(text)) {
      throw invalidRequest("A file mode is malformed.", { field });
    }
    return text;
  };
  return Object.freeze({
    path: ensureString(record["path"], `${path}.path`, { maxLength: 4_096 }),
    previousPath:
      record["previousPath"] === undefined || record["previousPath"] === null
        ? null
        : ensureString(record["previousPath"], `${path}.previousPath`, { maxLength: 4_096 }),
    changeKind: ensureEnum(record["changeKind"], `${path}.changeKind`, CHANGE_KINDS),
    oldObjectId: optionalOid("oldObjectId"),
    newObjectId: optionalOid("newObjectId"),
    oldMode: optionalMode("oldMode"),
    newMode: optionalMode("newMode"),
    similarityPercent:
      record["similarityPercent"] === undefined || record["similarityPercent"] === null
        ? null
        : validation.ensureSafeInteger(
            record["similarityPercent"],
            `${path}.similarityPercent`,
            0,
            100,
          ),
    isSubmodule: validation.ensureBoolean(record["isSubmodule"], `${path}.isSubmodule`),
    isSymlink: validation.ensureBoolean(record["isSymlink"], `${path}.isSymlink`),
    sizeBytes:
      record["sizeBytes"] === undefined || record["sizeBytes"] === null
        ? null
        : validation.ensureSafeInteger(record["sizeBytes"], `${path}.sizeBytes`, 0, Number.MAX_SAFE_INTEGER),
    binary: validation.ensureBoolean(record["binary"], `${path}.binary`),
    diffArtifactDigest:
      record["diffArtifactDigest"] === undefined || record["diffArtifactDigest"] === null
        ? null
        : ensureString(record["diffArtifactDigest"], `${path}.diffArtifactDigest`, {
            minLength: 64,
            maxLength: 64,
            pattern: /^[a-f0-9]{64}$/,
            patternName: "sha-256 digest",
          }),
  });
}
