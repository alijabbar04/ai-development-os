import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGitRuntime, type GitRuntime } from "@ai-dev-os/workspace";
import type { TestContext } from "vitest";

// The existing Git runner allows two 5s termination observations. This is a
// cleanup observation bound, never an extension of a test or Git deadline.
const DRAIN_MS = 10_000;
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
const outcome = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then((value) => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }));

/** Lifetime of one real-Git case, including partial setup and a timed-out body. */
export class RealGitFixtureCase {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private readonly roots: { path: string; parent: string; created: boolean }[] = [];
  private readonly closers: (() => Promise<void>)[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  private terminationUnconfirmed = false;
  private preserved = false;

  constructor(signal: AbortSignal = new AbortController().signal) {
    this.signal = AbortSignal.any([signal, this.controller.signal]);
  }

  track<T>(operation: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    if (this.preserved) throw new Error("Fixture owner has preserved unresolved work.");
    const running = Promise.resolve().then(operation);
    this.pending.add(running);
    void running.then(
      () => { this.pending.delete(running); },
      () => { this.pending.delete(running); },
    );
    return running;
  }

  createRoot(): Promise<string> {
    // Match fs/promises.realpath during cleanup, including Windows 8.3 aliases.
    const parent = realpathSync.native(tmpdir());
    // Register the unique path before mkdir starts. A failed exclusive mkdir
    // does not confer ownership of a pre-existing directory.
    // Keep mkdtemp's original six-character suffix length: Git creates long
    // nested worktree paths on Windows. Exclusive mkdir still proves ownership.
    const suffix = randomBytes(5).toString("base64url").slice(0, 6);
    const root = { path: join(parent, `ai-dev-os-integrator-fixture-${suffix}`), parent, created: false };
    this.roots.push(root);
    return this.track(async () => {
      await mkdir(root.path);
      root.created = true;
      return root.path;
    });
  }

  createRuntime(root: string, options: { gitExecutablePath?: string } = {}): Promise<GitRuntime> {
    return this.track(async () => {
      const runtime = await createGitRuntime({ root: join(root, "git-runtime"), ...options });
      this.closers.push(() => runtime.dispose());
      return Object.freeze({
        ...runtime,
        runner: Object.freeze({
          run: (args: Parameters<GitRuntime["runner"]["run"]>[0], runOptions: Parameters<GitRuntime["runner"]["run"]>[1]) => this.observeGit(() => runtime.runner.run(args, {
            ...runOptions,
            signal: runOptions.signal === undefined ? this.signal : AbortSignal.any([this.signal, runOptions.signal]),
          })),
        }),
      });
    });
  }

  observeGit<T>(operation: () => Promise<T>): Promise<T> {
    return this.track(async () => {
      try {
        return await operation();
      } catch (error) {
        // Observe the runner's original result before the integration boundary
        // maps it to a path-free error or an expected EFFECT_UNCERTAIN.
        if (typeof error === "object" && error !== null && "details" in error) {
          const details = error.details;
          if (typeof details === "object" && details !== null && "reason" in details && details.reason === "termination-unconfirmed") {
            this.terminationUnconfirmed = true;
          }
        }
        throw error;
      }
    });
  }

  ownPersistence<T extends { close(): Promise<void> }>(adapter: T): T {
    this.closers.push(() => adapter.close());
    return adapter;
  }

  async run(body: (owner: RealGitFixtureCase) => Promise<void>): Promise<void> {
    const running = outcome(Promise.resolve().then(() => body(this)));
    let onAbort!: () => void;
    const cancelled = new Promise<Outcome<void>>((resolve) => {
      onAbort = () => resolve({ ok: false, error: this.signal.reason });
      this.signal.addEventListener("abort", onAbort, { once: true });
      if (this.signal.aborted) onAbort();
    });
    let result = await Promise.race([running, cancelled]);
    if (!result.ok) this.controller.abort(result.error);
    const deadline = performance.now() + DRAIN_MS;
    let cleanup: Outcome<void>;
    try {
      // Join the whole callback, not just whichever Git child exists now.
      const finished = await this.withinDrain(running, deadline);
      if (result.ok || !this.signal.aborted) result = finished;
      while (this.pending.size > 0) {
        await this.withinDrain(Promise.allSettled([...this.pending]), deadline);
      }
      if (this.terminationUnconfirmed) throw new Error("Git reported termination-unconfirmed.");
      // SQLite/memory handles and runtime ownership finish before any root rm.
      for (const close of [...this.closers].reverse()) await this.withinDrain(close(), deadline);
      for (const root of this.roots) {
        if (!root.created) continue;
        if (dirname(root.path) !== root.parent || (await lstat(root.path)).isSymbolicLink() || await realpath(root.path) !== root.path) {
          throw new Error(`Fixture root ownership changed: ${root.path}`);
        }
        await rm(root.path, { recursive: true, force: true });
      }
      cleanup = { ok: true, value: undefined };
    } catch (error) {
      this.preserved = true;
      cleanup = { ok: false, error: new Error(`Fixture cleanup refused; owner evidence retained at ${this.roots.map((root) => root.path).join(", ")}`, { cause: error }) };
    } finally {
      this.signal.removeEventListener("abort", onAbort);
    }
    if (!result.ok && !cleanup.ok) {
      throw new AggregateError([result.error, cleanup.error], "Fixture body and cleanup failed.", { cause: result.error });
    }
    if (!result.ok) throw result.error;
    if (!cleanup.ok) throw cleanup.error;
  }

  private async withinDrain<T>(work: Promise<T>, deadline: number): Promise<T> {
    let timer!: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Fixture work did not settle within the existing drain bound.")), Math.max(0, deadline - performance.now()));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function fixtureCase(body: (owner: RealGitFixtureCase) => Promise<void>): (context: TestContext) => Promise<void> {
  return (context) => {
    const owner = new RealGitFixtureCase(context.signal);
    const complete = owner.run(body);
    // Bound to this test's context; a late hook cannot collect a later owner.
    context.onTestFinished(() => complete);
    return complete;
  };
}
