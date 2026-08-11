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
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { WorkspaceError, causeCategory } from "./errors.js";

/** Testable classification for the POSIX process-group existence probe. */
export function processGroupProbeConfirmsGone(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH";
}

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
  readonly signal?: AbortSignal;
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
      if (options.signal?.aborted === true) {
        throw new WorkspaceError("GIT_BACKEND_FAILURE", "A Git command was cancelled.", {
          reason: "aborted",
        });
      }
      const windowsTreeKiller = (() => {
        if (process.platform !== "win32") return null;
        const systemRoot = process.env["SystemRoot"];
        if (systemRoot === undefined || !isAbsolute(systemRoot)) {
          throw new WorkspaceError("GIT_UNAVAILABLE", "A verified Windows process-tree terminator is unavailable.", { reason: "tree-termination-unavailable" });
        }
        const executable = join(systemRoot, "System32", "taskkill.exe");
        if (!existsSync(executable)) throw new WorkspaceError("GIT_UNAVAILABLE", "A verified Windows process-tree terminator is unavailable.", { reason: "tree-termination-unavailable" });
        return Object.freeze({ executable, systemRoot });
      })();

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
        let stopError: WorkspaceError | null = null;
        let windowsTreeUnconfirmed = false;
        let removeAbortListener = (): void => undefined;

        let timer: ReturnType<typeof setTimeout>;
        let drainTimer: ReturnType<typeof setTimeout> | undefined;

        const settleCleanup = (): void => {
          clearTimeout(timer);
          if (drainTimer !== undefined) clearTimeout(drainTimer);
          removeAbortListener();
        };

        const finishRejected = (error: WorkspaceError): void => {
          if (settled) return;
          settled = true;
          settleCleanup();
          reject(error);
        };

        const stopTree = async (): Promise<boolean> => {
          const pid = child.pid;
          if (pid === undefined) return child.exitCode !== null;
          const stopDirectChild = (): boolean => {
            if (child.exitCode !== null || child.signalCode !== null) return true;
            try {
              // A successful signal request is not yet proof of termination;
              // return false so requestStop waits for the child's close event.
              child.kill("SIGKILL");
            } catch { /* the bounded drain check below establishes the result */ }
            return child.exitCode !== null || child.signalCode !== null;
          };
          try {
            if (process.platform === "win32") {
              if (windowsTreeKiller === null) return false;
              const treeStopped = await new Promise<boolean>((resolveStop) => {
                const killer = spawn(windowsTreeKiller.executable, ["/PID", String(pid), "/T", "/F"], {
                  windowsHide: true,
                  shell: false,
                  stdio: "ignore",
                  cwd: windowsTreeKiller.systemRoot,
                  env: { SystemRoot: windowsTreeKiller.systemRoot, windir: windowsTreeKiller.systemRoot },
                });
                const killerTimer = setTimeout(() => {
                  try { killer.kill("SIGKILL"); } catch { /* already gone */ }
                  resolveStop(false);
                }, 5_000);
                killerTimer.unref?.();
                killer.once("error", () => { clearTimeout(killerTimer); resolveStop(false); });
                killer.once("close", (code) => { clearTimeout(killerTimer); resolveStop(code === 0); });
              });
              if (treeStopped) return true;
              windowsTreeUnconfirmed = true;
              stopDirectChild();
              return false;
            }
            /* v8 ignore start -- POSIX process-group termination is exercised by the POSIX CI job. */
            process.kill(-pid, "SIGKILL");
            return false;
          } catch {
            return stopDirectChild();
            /* v8 ignore stop */
          }
        };

        const requestStop = (error: WorkspaceError): void => {
          if (settled || stopError !== null) return;
          stopError = error;
          clearTimeout(timer);
          removeAbortListener();
          void stopTree().then((verified) => {
            if (settled) return;
            if (verified) {
              finishRejected(error);
              return;
            }
            if (windowsTreeUnconfirmed) {
              drainTimer = setTimeout(() => finishRejected(new WorkspaceError("GIT_BACKEND_FAILURE", "A cancelled Git process tree did not confirm termination within its drain bound.", { reason: "termination-unconfirmed" })), 5_000);
              return;
            }
            /* v8 ignore start -- the post-signal POSIX group probe is exercised by the POSIX CI job. */
            drainTimer = setTimeout(() => {
              if (settled) return;
              const pid = child.pid;
              let gone = child.exitCode !== null || child.signalCode !== null;
              if (pid !== undefined && process.platform !== "win32") {
                // The process-group leader may exit before one of its descendants.
                // Only ESRCH for the whole group confirms that the cancellation drain
                // reached every process that inherited the Git operation.
                gone = false;
                try { process.kill(-pid, 0); } catch (error) { gone = processGroupProbeConfirmsGone(error); }
              }
              finishRejected(gone ? error : new WorkspaceError("GIT_BACKEND_FAILURE", "A cancelled Git process tree did not confirm termination within its drain bound.", { reason: "termination-unconfirmed" }));
            }, 5_000);
            /* v8 ignore stop */
          });
        };

        timer = setTimeout(() => requestStop(new WorkspaceError("GIT_BACKEND_FAILURE", "A Git command exceeded its deadline.", { timeoutMs })), timeoutMs);
        timer.unref?.();

        const onAbort = (): void => requestStop(new WorkspaceError("GIT_BACKEND_FAILURE", "A Git command was cancelled.", { reason: "aborted" }));
        if (options.signal !== undefined) {
          options.signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = (): void => options.signal?.removeEventListener("abort", onAbort);
          if (options.signal.aborted) onAbort();
        }

        const collect = (target: Buffer[], chunk: Buffer, isStdout: boolean): void => {
          const total = isStdout ? outBytes : errBytes;
          if (total + chunk.byteLength > maxBytes) {
            requestStop(new WorkspaceError("OUTPUT_TRUNCATED", "A Git command produced more output than the configured bound.", { maxOutputBytes: maxBytes }));
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
          if (settled) return;
          if (stopError !== null) return;
          finishRejected(new WorkspaceError("GIT_UNAVAILABLE", "Git could not be started.", {
            cause: causeCategory(error),
          }));
        });

        child.on("close", (code) => {
          if (settled) return;
          if (stopError !== null) {
            return;
          }
          settled = true;
          settleCleanup();
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
