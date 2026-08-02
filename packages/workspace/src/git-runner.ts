/**
 * Running Git.
 *
 * Git is invoked here directly rather than through `@ai-dev-os/process-broker`.
 * That is a deliberate separation of two different things:
 *
 *   - The process broker exists to supervise *untrusted workload* — a coding
 *     agent operating on a repository — and demands a capability grant, a
 *     policy decision, and an isolation backend before anything starts.
 *   - This runner executes *trusted infrastructure plumbing* with fixed
 *     argument arrays that this package constructs itself. It reads
 *     repository state so that a grant can be issued in the first place.
 *
 * Routing the second through the first would be circular. What this runner
 * does share with the broker is every hard rule that matters: an argument
 * array with no shell, a constructed environment, bounded output, an enforced
 * deadline, and process-tree termination on timeout.
 */

import { spawn } from "node:child_process";
import { WorkspaceError, causeCategory } from "./errors.js";

export const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface GitRunOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Non-zero exit codes that are an expected answer rather than a failure. */
  readonly toleratedExitCodes?: readonly number[];
}

export interface GitRunner {
  run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult>;
}

/**
 * Creates a runner bound to one Git executable.
 *
 * Every argument reaches Git as a distinct element of `argv`. Nothing is
 * concatenated into a string, so a branch name, a path, or a ref containing
 * spaces, quotes, semicolons, or leading dashes cannot become a second
 * command or an unintended option. Callers additionally place `--` before
 * user-influenced operands.
 */
export function createGitRunner(executablePath: string): GitRunner {
  return Object.freeze({
    async run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult> {
      const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
      const maxBytes = options.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES;

      return await new Promise<GitCommandResult>((resolve, reject) => {
        let child;
        try {
          child = spawn(executablePath, [...args], {
            cwd: options.cwd,
            env: { ...options.env },
            shell: false,
            windowsHide: true,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (error) {
          reject(
            new WorkspaceError("GIT_UNAVAILABLE", "Git could not be started.", {
              cause: causeCategory(error),
            }),
          );
          return;
        }

        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let outBytes = 0;
        let errBytes = 0;
        let settled = false;
        let overflowed = false;

        const stopTree = (): void => {
          const pid = child.pid;
          if (pid === undefined) {
            return;
          }
          try {
            if (process.platform === "win32") {
              spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
                windowsHide: true,
                shell: false,
                stdio: "ignore",
              }).on("error", () => undefined);
            } else {
              process.kill(-pid, "SIGKILL");
            }
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {
              // Already gone.
            }
          }
        };

        const timer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          stopTree();
          reject(
            new WorkspaceError("GIT_BACKEND_FAILURE", "A Git command exceeded its deadline.", {
              timeoutMs,
            }),
          );
        }, timeoutMs);
        timer.unref?.();

        const collect = (target: Buffer[], chunk: Buffer, isStdout: boolean): void => {
          const total = isStdout ? outBytes : errBytes;
          if (total + chunk.byteLength > maxBytes) {
            if (!overflowed) {
              overflowed = true;
              stopTree();
            }
            return;
          }
          target.push(chunk);
          if (isStdout) {
            outBytes += chunk.byteLength;
          } else {
            errBytes += chunk.byteLength;
          }
        };

        child.stdout.on("data", (chunk: Buffer) => collect(out, chunk, true));
        child.stderr.on("data", (chunk: Buffer) => collect(err, chunk, false));
        child.stdin.on("error", () => undefined);

        child.on("error", (error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(
            new WorkspaceError("GIT_UNAVAILABLE", "Git could not be started.", {
              cause: causeCategory(error),
            }),
          );
        });

        child.on("close", (code) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (overflowed) {
            reject(
              new WorkspaceError(
                "OUTPUT_TRUNCATED",
                "A Git command produced more output than the configured bound.",
                { maxOutputBytes: maxBytes },
              ),
            );
            return;
          }
          resolve(
            Object.freeze({
              exitCode: code ?? -1,
              stdout: Buffer.concat(out),
              stderr: Buffer.concat(err),
            }),
          );
        });

        if (options.stdin !== undefined) {
          child.stdin.end(options.stdin);
        } else {
          child.stdin.end();
        }
      });
    },
  });
}

/**
 * Runs a command and fails unless it succeeded.
 *
 * Git's own stderr is deliberately not propagated: it interpolates branch
 * names, paths, and file content, all of which are untrusted repository data.
 * Only the exit code and a caller-supplied operation label travel outward.
 */
export async function runGitChecked(
  runner: GitRunner,
  args: readonly string[],
  options: GitRunOptions & { readonly operation: string },
): Promise<GitCommandResult> {
  const result = await runner.run(args, options);
  const tolerated = options.toleratedExitCodes ?? [];
  if (result.exitCode !== 0 && !tolerated.includes(result.exitCode)) {
    throw new WorkspaceError("GIT_BACKEND_FAILURE", "A Git command failed.", {
      operation: options.operation,
      exitCode: result.exitCode,
    });
  }
  return result;
}

/** Splits NUL-delimited output into records, dropping the trailing empty one. */
export function splitNulRecords(buffer: Buffer): readonly string[] {
  const text = buffer.toString("utf8");
  const records = text.split("\u0000");
  if (records.length > 0 && records[records.length - 1] === "") {
    records.pop();
  }
  return Object.freeze(records);
}

export function decodeTrimmed(buffer: Buffer): string {
  return buffer.toString("utf8").trim();
}
