/**
 * The unsafe development backend.
 *
 * This backend runs the workload as the current user, in the current session,
 * with the current user's access to the filesystem and the network. It is not
 * a sandbox. Its name says so, its descriptor says so, and the production gate
 * refuses it.
 *
 * What it does NOT provide:
 *   - filesystem isolation: the child can read and write anything the user can
 *   - network isolation: the child can reach anything the user can reach
 *   - credential protection: the child can read the user's key material on disk
 *   - reliable escape prevention: a child can detach, re-exec, or outlive us
 *   - CPU, memory, disk, or process-count enforcement
 *
 * What it does provide, because these are contract obligations rather than
 * security claims: structured argument arrays, a constructed environment,
 * bounded output, wall-clock deadlines, best-effort process-tree termination,
 * lease integration, audit records, and idempotent close.
 *
 * It exists so the process contract can be exercised deterministically and so
 * trusted local development works on a machine with no sandbox installed.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ProcessBrokerError, errorCategory } from "./errors.js";
import {
  noQuotaSupport,
  parseBackendDescriptor,
  type BackendAvailability,
  type BackendDescriptor,
  type BackendExit,
  type BackendOutputEvent,
  type BackendProcess,
  type BackendSpawnInput,
  type BackendTermination,
  type SandboxBackend,
  type SandboxBinding,
  type SandboxSession,
} from "./backend.js";
import type { CapabilityGrant } from "./grant.js";

/**
 * The identifier is deliberately explicit. It is never `local`, `default`, or
 * `native`, because those names invite an operator to assume containment.
 */
export const UNSAFE_BACKEND_ID = "unsafe-development-current-user";

export const UNSAFE_BACKEND_LIMITATIONS: readonly string[] = Object.freeze([
  "Executes as the invoking operating-system user.",
  "Does not isolate the filesystem; the workload can reach any path the user can.",
  "Does not isolate the network; the workload can reach any host the user can.",
  "Does not prevent access to the user's credentials, keys, or profile data.",
  "Cannot guarantee process-tree containment; a determined child may escape.",
  "Does not enforce CPU, memory, disk, or process-count quotas.",
  "Is not a security boundary for a hostile repository and is refused in production.",
]);

export interface UnsafeBackendOptions {
  /** Absolute directory the backend may create per-session scratch space in. */
  readonly sessionRoot: string;
  readonly platform?: NodeJS.Platform;
}

const SESSION_REMOVE_MAX_RETRIES = 5;
const SESSION_REMOVE_RETRY_DELAY_MS = 50;

/**
 * Node copies omitted values from its own environment into a Windows child even
 * when spawn receives a complete custom block. Suppress every parent name not
 * present in the broker block only for the synchronous native spawn call, then
 * restore the parent exactly. JavaScript callbacks cannot interleave with this
 * section, and any native value copied from the parent is therefore one the
 * broker explicitly supplied as well.
 */
function withoutAmbientWindowsEnvironment<T>(
  platform: NodeJS.Platform,
  childEnvironment: Readonly<Record<string, string>>,
  action: () => T,
): T {
  if (platform !== "win32") {
    return action();
  }
  const childNames = new Set(Object.keys(childEnvironment).map((name) => name.toUpperCase()));
  const removed: Array<{ readonly name: string; readonly value: string }> = [];
  for (const actualName of Object.keys(process.env)) {
    if (childNames.has(actualName.toUpperCase())) {
      continue;
    }
    const value = process.env[actualName];
    if (value !== undefined) {
      removed.push({ name: actualName, value });
    }
    delete process.env[actualName];
  }
  try {
    return action();
  } finally {
    for (const entry of removed) {
      process.env[entry.name] = entry.value;
    }
  }
}

function descriptorFor(platform: NodeJS.Platform): BackendDescriptor {
  return parseBackendDescriptor({
    backendId: UNSAFE_BACKEND_ID,
    kind: "same-user-subprocess",
    platform,
    securityClass: "unsafe-development",
    capabilities: {
      filesystemIsolation: false,
      processTreeControl: false,
      networkDenial: false,
      identityIsolation: false,
      profileIsolation: false,
      // The broker measures output and wall-clock itself, so those are
      // honestly "observed" here rather than enforced by the platform.
      quotas: noQuotaSupport({ "wall-clock": "observed", "output-bytes": "observed" }),
    },
    versionEvidence: `node ${process.versions.node}`,
  });
}

export function createUnsafeDevelopmentBackend(options: UnsafeBackendOptions): SandboxBackend {
  const platform = options.platform ?? process.platform;
  const descriptor = descriptorFor(platform);
  const sessions = new Map<string, SandboxSession>();
  const live = new Set<UnsafeProcess>();
  let closed = false;

  function assertOpen(): void {
    if (closed) {
      throw new ProcessBrokerError("BROKER_CLOSED", "The sandbox backend is closed.", {
        backendId: UNSAFE_BACKEND_ID,
      });
    }
  }

  async function removeSession(session: SandboxSession): Promise<void> {
    const tracked = sessions.get(session.sessionId);
    if (tracked === undefined) {
      return;
    }
    const root = join(options.sessionRoot, tracked.sessionId);
    // Bounded and specific: only a session identifier generated and retained
    // by this backend can select a removal target. Keep failed removals tracked
    // so close() can retry them and callers never receive false cleanup proof.
    await rm(root, {
      recursive: true,
      force: true,
      // Windows can briefly retain a process or directory handle after the
      // child reports exit. Node retries only the documented transient
      // EPERM/EBUSY/ENOTEMPTY/EMFILE/ENFILE cases, with a finite linear delay.
      maxRetries: SESSION_REMOVE_MAX_RETRIES,
      retryDelay: SESSION_REMOVE_RETRY_DELAY_MS,
    });
    sessions.delete(tracked.sessionId);
  }

  return Object.freeze({
    describe: (): BackendDescriptor => descriptor,

    probe: async (): Promise<BackendAvailability> =>
      closed
        ? Object.freeze({
            available: false,
            reason: "not-implemented" as const,
            detail: "closed",
          })
        : Object.freeze({ available: true, reason: "available" as const, detail: null }),

    validateGrant(grant: CapabilityGrant): BackendAvailability {
      // This backend cannot deny egress, so a grant that requires denial is
      // refused rather than silently accepted.
      if (grant.network.mode !== "allowlist" && grant.network.egressDomains.length === 0) {
        return Object.freeze({
          available: false,
          reason: "not-implemented" as const,
          detail: "network-denial-unsupported",
        });
      }
      return Object.freeze({ available: true, reason: "available" as const, detail: null });
    },

    async prepare(binding: SandboxBinding): Promise<SandboxSession> {
      assertOpen();
      // The grant nonce identifies the authorization, not one particular
      // process creation. Add a backend-owned nonce so concurrent or replayed
      // executions cannot share a profile or delete each other's scratch data.
      const sessionId = `${binding.attemptId}-${binding.nonce}-${randomUUID().replaceAll("-", "")}`;
      const root = join(options.sessionRoot, sessionId);
      const tempDir = join(root, "tmp");
      const homeDir = join(root, "home");
      const session = Object.freeze({
        sessionId,
        backendId: UNSAFE_BACKEND_ID,
        tempDir,
        homeDir,
      });
      let rootCreated = false;
      try {
        await mkdir(options.sessionRoot, { recursive: true });
        // Fail closed on a collision or pre-seeded link/directory. A session
        // home is created as a new directory and is never reused.
        await mkdir(root);
        rootCreated = true;
        // Track as soon as this backend owns the root. If later preparation or
        // rollback fails, close() can still retry the exact bounded removal.
        sessions.set(sessionId, session);
        await mkdir(tempDir);
        await mkdir(homeDir);
      } catch (error) {
        let rollbackFailure: string | null = null;
        if (rootCreated) {
          try {
            await removeSession(session);
          } catch (cleanupError) {
            rollbackFailure = errorCategory(cleanupError);
          }
        }
        throw new ProcessBrokerError(
          "SPAWN_FAILED",
          "The session scratch directories could not be created.",
          {
            backendId: UNSAFE_BACKEND_ID,
            cause: errorCategory(error),
            rollback: rollbackFailure === null ? "completed-or-not-required" : "retry-pending",
            ...(rollbackFailure === null ? {} : { rollbackCause: rollbackFailure }),
          },
        );
      }
      return session;
    },

    async spawn(input: BackendSpawnInput): Promise<BackendProcess> {
      assertOpen();
      const process_ = new UnsafeProcess(input, platform);
      live.add(process_);
      void process_.wait().finally(() => live.delete(process_));
      return process_;
    },

    async dispose(session: SandboxSession): Promise<void> {
      await removeSession(session);
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        await Promise.allSettled([...live].map((entry) => entry.terminateTree(0)));
      }
      const cleanup = await Promise.allSettled([...sessions.values()].map(removeSession));
      const failed = cleanup.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed !== undefined) {
        throw failed.reason;
      }
    },
  });
}

class UnsafeProcess implements BackendProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #platform: NodeJS.Platform;
  readonly #listeners = new Set<(event: BackendOutputEvent) => void>();
  readonly #exit: Promise<BackendExit>;
  #settled = false;
  #terminating: Promise<BackendTermination> | null = null;

  constructor(input: BackendSpawnInput, platform: NodeJS.Platform) {
    this.#platform = platform;
    const [command, ...args] = input.argv;
    if (command === undefined) {
      throw new ProcessBrokerError("SPAWN_FAILED", "The argument vector was empty.", {
        backendId: UNSAFE_BACKEND_ID,
      });
    }
    try {
      this.#child = withoutAmbientWindowsEnvironment(
        platform,
        input.environment.variables,
        () =>
          spawn(command, args, {
            cwd: input.workingDirectory,
            // The constructed block is the complete environment. Nothing is
            // inherited: omitting `env` would inherit the parent's.
            env: { ...input.environment.variables },
            // Never a shell. A shell would reintroduce string parsing, quoting
            // bugs, and metacharacter injection through arguments.
            shell: false,
            windowsHide: true,
            // On POSIX a new process group lets us signal the whole tree with a
            // negative PID. On Windows this has no equivalent meaning and tree
            // termination goes through taskkill instead.
            detached: platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
          }) as ChildProcessWithoutNullStreams,
      );
    } catch (error) {
      throw new ProcessBrokerError("SPAWN_FAILED", "The process could not be created.", {
        backendId: UNSAFE_BACKEND_ID,
        cause: errorCategory(error),
      });
    }

    this.#child.stdout.on("data", (chunk: Buffer) => this.#emit("stdout", chunk));
    this.#child.stderr.on("data", (chunk: Buffer) => this.#emit("stderr", chunk));
    // An EPIPE on stdin is expected when a child exits early; it must not
    // become an unhandled error event.
    this.#child.stdin.on("error", () => undefined);

    this.#exit = new Promise<BackendExit>((resolve) => {
      const settle = (exitCode: number | null, signal: string | null): void => {
        if (this.#settled) {
          return;
        }
        this.#settled = true;
        resolve(Object.freeze({ exitCode, signal }));
      };
      // 'close' fires after the stdio streams are done, so no output is lost.
      this.#child.on("close", (code, signal) => settle(code, signal));
      this.#child.on("error", () => settle(null, null));
    });
  }

  get pid(): number | null {
    return this.#child.pid ?? null;
  }

  #emit(stream: "stdout" | "stderr", chunk: Buffer): void {
    const event = Object.freeze({ stream, chunk: new Uint8Array(chunk) });
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A consumer failure must not tear down the process plumbing; the
        // broker surfaces its own errors through the terminal result.
      }
    }
  }

  onOutput(listener: (event: BackendOutputEvent) => void): void {
    this.#listeners.add(listener);
  }

  wait(): Promise<BackendExit> {
    return this.#exit;
  }

  async writeStdin(bytes: Uint8Array): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#child.stdin.write(bytes, () => resolve());
    });
  }

  async closeStdin(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#child.stdin.end(() => resolve());
    });
  }

  /**
   * Best-effort tree termination.
   *
   * On Windows this shells out to `taskkill /T /F`, which walks the parent
   * chain the OS recorded. A child that broke that chain — by detaching, or by
   * being re-parented — survives. On POSIX the process group receives SIGTERM
   * and then SIGKILL; a child that called `setsid` leaves the group and
   * survives. Both are conveniences, not containment, and the returned
   * outcome says `termination-unconfirmed` when we cannot prove the tree is
   * gone.
   */
  terminateTree(graceMs: number): Promise<BackendTermination> {
    this.#terminating ??= this.#terminate(graceMs);
    return this.#terminating;
  }

  async #terminate(graceMs: number): Promise<BackendTermination> {
    if (this.#settled) {
      return Object.freeze({ outcome: "exited" as const, stoppedCount: null });
    }
    const pid = this.#child.pid;
    if (pid === undefined) {
      return Object.freeze({ outcome: "termination-unconfirmed" as const, stoppedCount: null });
    }

    if (this.#platform === "win32") {
      return await this.#terminateWindows(pid);
    }
    return await this.#terminatePosix(pid, graceMs);
  }

  async #terminateWindows(pid: number): Promise<BackendTermination> {
    const killed = await new Promise<boolean>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        shell: false,
        stdio: "ignore",
      });
      killer.on("error", () => resolve(false));
      killer.on("close", (code) => resolve(code === 0));
    });
    const exited = await this.#waitBriefly(2_000);
    if (exited) {
      return Object.freeze({ outcome: "terminated" as const, stoppedCount: null });
    }
    return Object.freeze({
      outcome: killed ? ("terminated" as const) : ("termination-unconfirmed" as const),
      stoppedCount: null,
    });
  }

  async #terminatePosix(pid: number, graceMs: number): Promise<BackendTermination> {
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        // The negative PID addresses the whole process group created by
        // `detached: true`.
        process.kill(-pid, signal);
      } catch {
        try {
          this.#child.kill(signal);
        } catch {
          // The process is already gone.
        }
      }
    };

    if (graceMs > 0) {
      signalGroup("SIGTERM");
      if (await this.#waitBriefly(graceMs)) {
        return Object.freeze({ outcome: "terminated" as const, stoppedCount: null });
      }
    }
    signalGroup("SIGKILL");
    const exited = await this.#waitBriefly(2_000);
    return Object.freeze({
      outcome: exited ? ("terminated" as const) : ("termination-unconfirmed" as const),
      stoppedCount: null,
    });
  }

  #waitBriefly(ms: number): Promise<boolean> {
    if (this.#settled) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(this.#settled), ms);
      timer.unref?.();
      void this.#exit.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
