/**
 * Sanitized Git invocation.
 *
 * Git reads configuration from the system file, the global file, the
 * repository's own `.git/config`, and the environment — and several
 * configuration keys name a program that Git will execute. A repository is
 * untrusted content, so its configuration is untrusted input, and the
 * environment we inherited may point at the operator's credentials.
 *
 * Two mechanisms handle this:
 *
 *   1. The environment is constructed from empty. Every variable that
 *      redirects repository state, configuration, credentials, or transport is
 *      simply absent, and the ones we need are set to controlled values.
 *   2. Command-line `-c` overrides are passed on every invocation. These have
 *      the highest precedence in Git's configuration order, so a hostile
 *      `.git/config` cannot re-enable what they disable.
 *
 * The one thing configuration cannot neutralize generically is a content
 * filter, because a filter driver is named by `.gitattributes` (repository
 * content) while its command comes from configuration under a name we cannot
 * predict. The answer is not to fight it: the snapshot path never runs a
 * command that applies filters. Working-tree bytes are read by this process
 * and hashed with `--no-filters`, and the index is populated with
 * `--cacheinfo`, which touches no file. This is verified by a hostile fixture
 * that arms a clean filter, a smudge filter, and a textconv driver.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { invalidConfiguration } from "./errors.js";

/**
 * Environment names that must never reach a Git child process, because each
 * one either redirects which repository Git operates on, where it reads
 * configuration, or how it obtains credentials.
 */
export const STRIPPED_GIT_ENVIRONMENT: readonly string[] = Object.freeze([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CEILING_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_TEMPLATE_DIR",
  "GIT_EXEC_PATH",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_ALLOW_PROTOCOL",
  "GIT_PROTOCOL_FROM_USER",
  "GIT_EDITOR",
  "GIT_PAGER",
  "GIT_EXTERNAL_DIFF",
  "GIT_TEXTCONV",
  "GIT_LFS_SKIP_SMUDGE",
  "GIT_TRACE",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
]);

/**
 * Configuration keys whose values Git executes as a program, or which change
 * where Git looks for one. Every invocation overrides all of them.
 *
 * `credential.helper=` with an empty value is meaningful: it resets the
 * accumulated helper list rather than appending to it.
 */
export function sanitizingConfigArguments(options: {
  readonly emptyHooksDir: string;
  /** Set only for the one managed, local operation that needs it. */
  readonly allowLocalFileProtocol?: boolean;
}): readonly string[] {
  const hooks = options.emptyHooksDir.replace(/\\/g, "/");
  const args = [
    // Hooks: point at a directory we own and keep empty.
    "-c",
    `core.hooksPath=${hooks}`,
    // A filesystem monitor is a long-lived child process started by index reads.
    "-c",
    "core.fsmonitor=false",
    // Credential acquisition of every kind.
    "-c",
    "credential.helper=",
    "-c",
    "credential.interactive=false",
    "-c",
    "core.askPass=",
    // Signing, editing, and paging all launch programs.
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    "-c",
    "gpg.program=",
    "-c",
    "core.editor=",
    "-c",
    "core.pager=",
    // Diff generation must never call out to a program.
    "-c",
    "diff.external=",
    "-c",
    "diff.noprefix=false",
    // Submodules are captured as gitlinks and never entered.
    "-c",
    "submodule.recurse=false",
    "-c",
    "fetch.recurseSubmodules=false",
    "-c",
    "push.recurseSubmodules=false",
    // Background maintenance would mutate the repository we are reading.
    "-c",
    "maintenance.auto=false",
    "-c",
    "gc.auto=0",
    // Deterministic, locale-independent, machine-readable output.
    "-c",
    "core.quotePath=false",
    "-c",
    "color.ui=false",
    "-c",
    "advice.detachedHead=false",
    // Line endings must not be rewritten during snapshot or checkout.
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.eol=lf",
  ];
  // Transport is denied by default. Only the internal local protocol is
  // enabled, and only for the operations that genuinely need it.
  if (options.allowLocalFileProtocol === true) {
    args.push("-c", "protocol.allow=never", "-c", "protocol.file.allow=always");
  } else {
    args.push("-c", "protocol.allow=never");
  }
  return Object.freeze(args);
}

/**
 * Neutralizes the content-filter machinery a repository configured for itself.
 *
 * A filter driver is named by `.gitattributes` — repository content — while
 * the command it runs comes from configuration under a name that cannot be
 * predicted, so no fixed list of `-c` overrides can disable it in advance.
 *
 * The names *can* be discovered, though: listing configuration keys executes
 * nothing. Given the discovered driver names, this emits an explicit empty
 * override for each program-valued key. A command-line override outranks the
 * repository's own configuration, and an empty command means no filter.
 *
 * This matters because `git diff-files` re-hashes a working-tree entry whose
 * stat information looks racily clean, and re-hashing applies the clean
 * filter. That was found by an adversarial fixture rather than by reading the
 * documentation, and it is the reason this function exists.
 */
export function neutralizingConfigArguments(configKeys: readonly string[]): readonly string[] {
  const filterDrivers = new Set<string>();
  const textconvDrivers = new Set<string>();
  const mergeDrivers = new Set<string>();

  for (const key of configKeys) {
    const filter = /^filter\.(.+)\.(clean|smudge|process|required)$/.exec(key);
    if (filter?.[1] !== undefined) {
      filterDrivers.add(filter[1]);
      continue;
    }
    const textconv = /^diff\.(.+)\.textconv$/.exec(key);
    if (textconv?.[1] !== undefined) {
      textconvDrivers.add(textconv[1]);
      continue;
    }
    const merge = /^merge\.(.+)\.driver$/.exec(key);
    if (merge?.[1] !== undefined) {
      mergeDrivers.add(merge[1]);
    }
  }

  const args: string[] = [];
  for (const driver of [...filterDrivers].sort()) {
    args.push(
      "-c",
      `filter.${driver}.clean=`,
      "-c",
      `filter.${driver}.smudge=`,
      "-c",
      `filter.${driver}.process=`,
      // A required filter that cannot run would fail the command; making it
      // optional keeps the read working while the command stays empty.
      "-c",
      `filter.${driver}.required=false`,
    );
  }
  for (const driver of [...textconvDrivers].sort()) {
    args.push("-c", `diff.${driver}.textconv=`);
  }
  for (const driver of [...mergeDrivers].sort()) {
    args.push("-c", `merge.${driver}.driver=`);
  }
  return Object.freeze(args);
}

export interface GitEnvironmentInput {
  /** Directory we own; must exist and stay empty. */
  readonly emptyHooksDir: string;
  /** An empty file used as the global configuration. */
  readonly emptyGlobalConfigFile: string;
  /** An empty directory presented as the home/profile location. */
  readonly emptyHomeDir: string;
  readonly tempDir: string;
  /** Set when operating on a specific repository. */
  readonly gitDir?: string;
  readonly workTree?: string;
  /** A private index file, so the user's index is never written. */
  readonly indexFile?: string;
  /** New objects are written here instead of into the source repository. */
  readonly objectDirectory?: string;
  /** Read-only object sources. Never written to. */
  readonly alternateObjectDirectories?: readonly string[];
  /** Suppresses the opportunistic index refresh that would write to disk. */
  readonly optionalLocks?: boolean;
  readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  /** Deterministic identity used only for objects we create ourselves. */
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly authorDate?: string;
}

/**
 * Builds the complete environment for a Git child process. Anything not
 * returned here is absent for that process.
 */
export function buildGitEnvironment(input: GitEnvironmentInput): Readonly<Record<string, string>> {
  const platform = input.platform ?? process.platform;
  const host = input.hostEnvironment ?? process.env;
  const env: Record<string, string> = Object.create(null) as Record<string, string>;

  // Deterministic, parseable output regardless of the operator's locale.
  env["LANG"] = "C";
  env["LC_ALL"] = "C";

  // Git on Windows needs a small set of system values to start at all, and it
  // needs PATH to find its own helper executables inside the Git installation.
  if (platform === "win32") {
    for (const name of ["SystemRoot", "windir", "SystemDrive", "PATHEXT", "COMSPEC"]) {
      const value = host[name];
      if (typeof value === "string" && value.length > 0 && !value.includes("\u0000")) {
        env[name] = value;
      }
    }
  }
  const path = host["PATH"] ?? host["Path"];
  if (typeof path === "string" && path.length > 0) {
    env["PATH"] = path;
  }

  // Configuration comes only from files we control. The repository's own
  // config is still read by Git; the `-c` overrides above neutralize it.
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_CONFIG_GLOBAL"] = input.emptyGlobalConfigFile;
  env["GIT_CONFIG_SYSTEM"] = input.emptyGlobalConfigFile;
  env["HOME"] = input.emptyHomeDir;
  if (platform === "win32") {
    env["USERPROFILE"] = input.emptyHomeDir;
  }

  // Never prompt, never open a terminal, never ask for a credential.
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_ASKPASS"] = "";
  env["SSH_ASKPASS"] = "";
  env["GIT_PAGER"] = "";
  env["GIT_FLUSH"] = "1";
  env["TMPDIR"] = input.tempDir;
  env["TMP"] = input.tempDir;
  env["TEMP"] = input.tempDir;

  if (input.gitDir !== undefined) {
    env["GIT_DIR"] = input.gitDir;
  }
  if (input.workTree !== undefined) {
    env["GIT_WORK_TREE"] = input.workTree;
  }
  if (input.indexFile !== undefined) {
    env["GIT_INDEX_FILE"] = input.indexFile;
  }
  if (input.objectDirectory !== undefined) {
    env["GIT_OBJECT_DIRECTORY"] = input.objectDirectory;
  }
  if (input.alternateObjectDirectories !== undefined && input.alternateObjectDirectories.length > 0) {
    // The separator is platform specific: ';' on Windows, ':' elsewhere.
    env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = input.alternateObjectDirectories.join(
      platform === "win32" ? ";" : ":",
    );
  }
  // Reads never take the opportunistic index lock, so a read cannot write.
  env["GIT_OPTIONAL_LOCKS"] = input.optionalLocks === true ? "1" : "0";

  if (input.authorName !== undefined) {
    env["GIT_AUTHOR_NAME"] = input.authorName;
    env["GIT_COMMITTER_NAME"] = input.authorName;
  }
  if (input.authorEmail !== undefined) {
    env["GIT_AUTHOR_EMAIL"] = input.authorEmail;
    env["GIT_COMMITTER_EMAIL"] = input.authorEmail;
  }
  if (input.authorDate !== undefined) {
    env["GIT_AUTHOR_DATE"] = input.authorDate;
    env["GIT_COMMITTER_DATE"] = input.authorDate;
  }

  return Object.freeze({ ...env });
}

/**
 * Locates the Git executable without consulting a shell.
 *
 * `PATH` is searched explicitly here rather than delegated to `shell: true`,
 * because a shell would reintroduce quoting and metacharacter handling for
 * every argument we pass.
 */
export function resolveGitExecutable(
  options: {
    readonly explicitPath?: string;
    readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
    readonly platform?: NodeJS.Platform;
  } = {},
): string {
  if (options.explicitPath !== undefined) {
    if (!existsSync(options.explicitPath)) {
      throw invalidConfiguration("The configured Git executable does not exist.");
    }
    return options.explicitPath;
  }
  const platform = options.platform ?? process.platform;
  const host = options.hostEnvironment ?? process.env;
  const path = host["PATH"] ?? host["Path"] ?? "";
  const names = platform === "win32" ? ["git.exe"] : ["git"];
  for (const directory of path.split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    for (const name of names) {
      const candidate = join(directory, name);
      // Verified to exist here so a later spawn failure means something else.
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  throw invalidConfiguration("Git could not be located on this system.");
}