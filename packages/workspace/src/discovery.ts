/**
 * Repository discovery.
 *
 * Reads the identity and working-tree state of a source repository without
 * writing anything to it. Every command is plumbing with a machine-readable
 * NUL-delimited format, so nothing depends on Git's localized prose, and
 * `GIT_OPTIONAL_LOCKS=0` keeps a read from taking the index lock and
 * opportunistically rewriting it.
 *
 * `git status` is deliberately not used: it is localized, it quotes paths, and
 * it does more work than is needed. `diff-index --cached` plus `diff-files
 * --raw` answers the same question from recorded object identifiers.
 *
 * One caveat, found by an adversarial fixture rather than by reading the
 * documentation: `diff-files` does not always avoid hashing. When a
 * working-tree entry looks racily clean — its stat information matches the
 * index but the timestamps are too close to trust — Git re-hashes the file to
 * decide whether it really changed, and re-hashing applies the clean filter.
 * A hostile repository can therefore get a program executed through what
 * looks like a pure read. The defence is to enumerate the repository's own
 * filter, textconv, and merge drivers first (listing configuration keys
 * executes nothing) and pass an empty command-line override for each, which
 * outranks the repository's configuration.
 */

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { WorkspaceError, causeCategory, invalidRequest } from "./errors.js";
import { neutralizingConfigArguments } from "./git-environment.js";
import { decodeTrimmed, runGitChecked, splitNulRecords } from "./git-runner.js";
import { parseRawDiffRecords, type ChangedFileEntry } from "./manifest.js";
import type { GitRuntime } from "./runtime.js";

export const OBJECT_FORMATS = Object.freeze(["sha1", "sha256"] as const);
export type ObjectFormat = (typeof OBJECT_FORMATS)[number];

export const WORKTREE_STATES = Object.freeze(["clean", "dirty"] as const);
export type WorktreeState = (typeof WORKTREE_STATES)[number];

export interface SubmoduleEntry {
  readonly path: string;
  readonly objectId: string;
}

export interface RepositoryDiscovery {
  readonly root: string;
  readonly gitDir: string;
  readonly commonGitDir: string;
  readonly objectFormat: ObjectFormat;
  readonly headCommit: string | null;
  /** Null when HEAD is detached or the repository has no commits yet. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly worktreeState: WorktreeState;
  readonly stagedChanges: readonly ChangedFileEntry[];
  readonly unstagedChanges: readonly ChangedFileEntry[];
  readonly untrackedPaths: readonly string[];
  readonly submodules: readonly SubmoduleEntry[];
  /** Remote names only. URLs are not resolved and no remote is contacted. */
  readonly remoteNames: readonly string[];
  readonly hasUncommittedHistory: boolean;
  /**
   * Command-line overrides that disable the filter, textconv, and merge
   * drivers this repository configured. Every later command against this
   * repository must include them.
   */
  readonly programConfigOverrides: readonly string[];
}

export interface DiscoveryOptions {
  /** Absolute path expected to be inside the project scope. */
  readonly directory: string;
  /** Directories the repository root must be inside, when configured. */
  readonly allowedRoots?: readonly string[];
  readonly maxUntrackedPaths?: number;
  readonly timeoutMs?: number;
}

const MAX_UNTRACKED_DEFAULT = 10_000;

function assertInsideAllowedRoots(root: string, allowed: readonly string[] | undefined): void {
  if (allowed === undefined || allowed.length === 0) {
    return;
  }
  const normalized = resolve(root);
  const inside = allowed.some((candidate) => {
    const base = resolve(candidate);
    return normalized === base || normalized.startsWith(base.endsWith("\\") || base.endsWith("/") ? base : `${base}${pathSeparator()}`);
  });
  if (!inside) {
    throw new WorkspaceError(
      "UNSAFE_REPOSITORY",
      "The repository lies outside the configured project scope.",
      {},
    );
  }
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

export async function discoverRepository(
  runtime: GitRuntime,
  options: DiscoveryOptions,
): Promise<RepositoryDiscovery> {
  const directory = options.directory;
  if (typeof directory !== "string" || directory.length === 0 || !isAbsolute(directory)) {
    throw invalidRequest("The discovery directory must be an absolute path.");
  }

  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    throw new WorkspaceError("NOT_A_REPOSITORY", "The directory could not be inspected.", {
      cause: causeCategory(error),
    });
  }
  if (!info.isDirectory()) {
    throw new WorkspaceError("NOT_A_REPOSITORY", "The discovery target is not a directory.", {});
  }

  const base = {
    cwd: directory,
    env: runtime.environment(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
  const config = runtime.configArguments();

  // Bare-ness is probed on its own first. `--show-toplevel` fails outright in
  // a bare repository, so asking for it in the same command would report
  // "not a repository" for something that is a repository but unusable here.
  const bareProbe = await runtime.runner.run([...config, "rev-parse", "--is-bare-repository"], base);
  if (bareProbe.exitCode !== 0) {
    throw new WorkspaceError("NOT_A_REPOSITORY", "The directory is not inside a Git repository.", {});
  }
  if (decodeTrimmed(bareProbe.stdout) === "true") {
    throw new WorkspaceError(
      "UNSUPPORTED_REPOSITORY",
      "A bare repository has no working tree to snapshot.",
      {},
    );
  }

  const probe = await runtime.runner.run(
    [...config, "rev-parse", "--show-toplevel", "--absolute-git-dir"],
    base,
  );
  if (probe.exitCode !== 0) {
    throw new WorkspaceError("NOT_A_REPOSITORY", "The directory is not inside a Git repository.", {});
  }
  const lines = decodeTrimmed(probe.stdout).split("\n").map((line) => line.trim());
  const [rootLine, gitDirLine] = lines;
  if (rootLine === undefined || gitDirLine === undefined) {
    throw new WorkspaceError("NOT_A_REPOSITORY", "Repository identity could not be determined.", {});
  }

  const root = resolve(rootLine);
  const gitDir = resolve(gitDirLine);
  assertInsideAllowedRoots(root, options.allowedRoots);

  // Discover the repository's own program-valued configuration before running
  // anything that could act on it. Listing keys executes nothing.
  const programConfigOverrides = await readProgramConfigOverrides(runtime, base, config);
  const config2 = [...config, ...programConfigOverrides];

  const commonResult = await runtime.runner.run([...config2, "rev-parse", "--git-common-dir"], base);
  const commonRaw = decodeTrimmed(commonResult.stdout);
  const commonGitDir =
    commonResult.exitCode === 0 && commonRaw.length > 0
      ? resolve(isAbsolute(commonRaw) ? commonRaw : join(root, commonRaw))
      : gitDir;

  const objectFormat = await readObjectFormat(runtime, base, config2);

  const headResult = await runtime.runner.run([...config2, "rev-parse", "--verify", "HEAD"], base);
  const headCommit = headResult.exitCode === 0 ? decodeTrimmed(headResult.stdout) : null;

  const branchResult = await runtime.runner.run(
    [...config2, "symbolic-ref", "--quiet", "--short", "HEAD"],
    base,
  );
  const branch = branchResult.exitCode === 0 ? decodeTrimmed(branchResult.stdout) : null;
  const detached = headCommit !== null && branch === null;

  // Staged changes: the index compared against HEAD. Only recorded object
  // identifiers are involved, so no working-tree content is hashed.
  const stagedChanges =
    headCommit === null
      ? []
      : parseRawDiffRecords(
          splitNulRecords(
            (
              await runGitChecked(
                runtime.runner,
                [...config2, "diff-index", "--cached", "--raw", "-z", "--ignore-submodules=dirty", headCommit],
                { ...base, operation: "diff-index-cached" },
              )
            ).stdout,
          ),
        );

  // Unstaged changes: the working tree compared against the index. The raw
  // format reports an all-zero identifier for the working-tree side, but a
  // racily-clean entry is still re-hashed, which is why the neutralizing
  // overrides computed above are part of `config2`.
  const unstagedChanges = parseRawDiffRecords(
    splitNulRecords(
      (
        await runGitChecked(
          runtime.runner,
          [...config2, "diff-files", "--raw", "-z", "--ignore-submodules=dirty"],
          { ...base, operation: "diff-files" },
        )
      ).stdout,
    ),
  );

  const maxUntracked = options.maxUntrackedPaths ?? MAX_UNTRACKED_DEFAULT;
  const untrackedAll = splitNulRecords(
    (
      await runGitChecked(
        runtime.runner,
        [...config2, "ls-files", "-z", "--others", "--exclude-standard"],
        { ...base, operation: "ls-files-others" },
      )
    ).stdout,
  );
  if (untrackedAll.length > maxUntracked) {
    throw new WorkspaceError(
      "SNAPSHOT_TOO_LARGE",
      "The repository has more untracked files than the configured bound.",
      { untrackedCount: untrackedAll.length, maxUntrackedPaths: maxUntracked },
    );
  }

  const submodules = await readSubmodules(runtime, base, config2);
  const remoteNames = await readRemoteNames(runtime, base, config2);

  const worktreeState: WorktreeState =
    stagedChanges.length === 0 && unstagedChanges.length === 0 && untrackedAll.length === 0
      ? "clean"
      : "dirty";

  return Object.freeze({
    root,
    gitDir,
    commonGitDir,
    objectFormat,
    headCommit,
    branch,
    detached,
    worktreeState,
    stagedChanges,
    unstagedChanges,
    untrackedPaths: Object.freeze([...untrackedAll].sort()),
    submodules,
    remoteNames,
    hasUncommittedHistory: headCommit === null,
    programConfigOverrides,
  });
}

/**
 * Lists the repository's program-valued configuration keys and turns them
 * into neutralizing overrides.
 *
 * `config --list --name-only` reads; it never runs a driver. Included files
 * are followed, so a driver hidden behind `include.path` is still found. Only
 * the local scope is consulted because the system and global scopes are
 * already replaced by empty controlled files.
 */
async function readProgramConfigOverrides(
  runtime: GitRuntime,
  base: { cwd: string; env: Readonly<Record<string, string>> },
  config: readonly string[],
): Promise<readonly string[]> {
  const result = await runtime.runner.run(
    [...config, "config", "--list", "--local", "-z", "--name-only"],
    base,
  );
  if (result.exitCode !== 0) {
    return Object.freeze([]);
  }
  return neutralizingConfigArguments(splitNulRecords(result.stdout));
}

async function readObjectFormat(
  runtime: GitRuntime,
  base: { cwd: string; env: Readonly<Record<string, string>> },
  config: readonly string[],
): Promise<ObjectFormat> {
  const result = await runtime.runner.run(
    [...config, "rev-parse", "--show-object-format"],
    base,
  );
  const value = decodeTrimmed(result.stdout);
  if (result.exitCode !== 0 || value.length === 0) {
    return "sha1";
  }
  if (value !== "sha1" && value !== "sha256") {
    throw new WorkspaceError("UNSUPPORTED_REPOSITORY", "The repository object format is unsupported.", {
      objectFormat: value.slice(0, 16),
    });
  }
  return value;
}

/**
 * Reads submodule gitlinks from the index.
 *
 * `.gitmodules` is repository content and therefore untrusted; it is not
 * parsed here, no submodule is initialized, no submodule is fetched, and no
 * `submodule.<name>.update` command can run. A submodule is recorded as a
 * path and the object identifier its gitlink points at, nothing more.
 */
async function readSubmodules(
  runtime: GitRuntime,
  base: { cwd: string; env: Readonly<Record<string, string>> },
  config: readonly string[],
): Promise<readonly SubmoduleEntry[]> {
  const result = await runtime.runner.run([...config, "ls-files", "-z", "--stage"], base);
  if (result.exitCode !== 0) {
    return Object.freeze([]);
  }
  const entries: SubmoduleEntry[] = [];
  for (const record of splitNulRecords(result.stdout)) {
    // "<mode> <oid> <stage>\t<path>"
    const tab = record.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const meta = record.slice(0, tab).split(" ");
    const mode = meta[0];
    const oid = meta[1];
    if (mode !== "160000" || oid === undefined) {
      continue;
    }
    const path = record.slice(tab + 1);
    if (path.length === 0 || path.includes("..")) {
      // A gitlink whose path tries to escape is quarantined rather than used.
      throw new WorkspaceError("UNSUPPORTED_SUBMODULE", "A submodule path is unsafe.", {});
    }
    entries.push(Object.freeze({ path, objectId: oid }));
  }
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw new WorkspaceError("UNSUPPORTED_SUBMODULE", "A submodule path is duplicated.", {});
  }
  return Object.freeze([...entries].sort((a, b) => (a.path < b.path ? -1 : 1)));
}

/** Remote names only: no URL is resolved and no remote is contacted. */
async function readRemoteNames(
  runtime: GitRuntime,
  base: { cwd: string; env: Readonly<Record<string, string>> },
  config: readonly string[],
): Promise<readonly string[]> {
  const result = await runtime.runner.run([...config, "remote"], base);
  if (result.exitCode !== 0) {
    return Object.freeze([]);
  }
  const names = decodeTrimmed(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.length <= 256);
  return Object.freeze([...new Set(names)].sort());
}

/** Reads `.gitmodules` as inert, bounded metadata. It is never executed. */
export async function readGitmodulesMetadata(
  repositoryRoot: string,
  maxBytes = 65_536,
): Promise<string | null> {
  try {
    const content = await readFile(join(repositoryRoot, ".gitmodules"));
    if (content.byteLength > maxBytes) {
      return null;
    }
    return content.toString("utf8");
  } catch {
    return null;
  }
}
