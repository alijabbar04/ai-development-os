/**
 * The Git runtime.
 *
 * Owns the controlled scratch locations every sanitized Git invocation needs:
 * an empty hooks directory, an empty global configuration file, an empty home
 * directory, and a private temporary directory. Creating these once and
 * pointing every child process at them is what makes the sanitization
 * consistent rather than per-call and forgettable.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { invalidConfiguration } from "./errors.js";
import {
  buildGitEnvironment,
  resolveGitExecutable,
  sanitizingConfigArguments,
  type GitEnvironmentInput,
} from "./git-environment.js";
import { createGitRunner, type GitRunner } from "./git-runner.js";

export interface GitRuntimeOptions {
  /** Absolute directory this runtime owns for its scratch state. */
  readonly root: string;
  readonly gitExecutablePath?: string;
  readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

export type GitEnvironmentOverrides = Omit<
  GitEnvironmentInput,
  "emptyHooksDir" | "emptyGlobalConfigFile" | "emptyHomeDir" | "tempDir" | "hostEnvironment" | "platform"
>;

export interface GitRuntime {
  readonly runner: GitRunner;
  readonly executablePath: string;
  readonly tempDir: string;
  /** Config overrides that neutralize program-launching configuration. */
  configArguments(options?: { readonly allowLocalFileProtocol?: boolean }): readonly string[];
  environment(overrides?: GitEnvironmentOverrides): Readonly<Record<string, string>>;
  dispose(): Promise<void>;
}

export async function createGitRuntime(options: GitRuntimeOptions): Promise<GitRuntime> {
  const root = options.root;
  if (typeof root !== "string" || root.length === 0 || !isAbsolute(root)) {
    throw invalidConfiguration("The Git runtime root must be an absolute path.");
  }
  const resolved = resolve(root);
  const hooksDir = join(resolved, "no-hooks");
  const homeDir = join(resolved, "empty-home");
  const tempDir = join(resolved, "tmp");
  const globalConfig = join(resolved, "empty.gitconfig");

  await mkdir(hooksDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  // An empty file, not a missing one: Git treats a missing global config as
  // "look elsewhere" on some platforms, an empty one as "there is nothing".
  await writeFile(globalConfig, "", { flag: "w" });

  const executablePath = resolveGitExecutable({
    ...(options.gitExecutablePath === undefined ? {} : { explicitPath: options.gitExecutablePath }),
    ...(options.hostEnvironment === undefined ? {} : { hostEnvironment: options.hostEnvironment }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
  const runner = createGitRunner(executablePath);

  return Object.freeze({
    runner,
    executablePath,
    tempDir,
    configArguments(config: { readonly allowLocalFileProtocol?: boolean } = {}): readonly string[] {
      return sanitizingConfigArguments({
        emptyHooksDir: hooksDir,
        ...(config.allowLocalFileProtocol === undefined
          ? {}
          : { allowLocalFileProtocol: config.allowLocalFileProtocol }),
      });
    },
    environment(overrides: GitEnvironmentOverrides = {}): Readonly<Record<string, string>> {
      return buildGitEnvironment({
        emptyHooksDir: hooksDir,
        emptyGlobalConfigFile: globalConfig,
        emptyHomeDir: homeDir,
        tempDir,
        ...(options.hostEnvironment === undefined ? {} : { hostEnvironment: options.hostEnvironment }),
        ...(options.platform === undefined ? {} : { platform: options.platform }),
        ...overrides,
      });
    },
    async dispose(): Promise<void> {
      // Bounded to the directory this runtime created.
      await rm(resolved, { recursive: true, force: true }).catch(() => undefined);
    },
  });
}
