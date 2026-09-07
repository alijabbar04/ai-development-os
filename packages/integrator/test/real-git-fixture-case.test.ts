import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceError } from "@ai-dev-os/workspace";
import { describe, expect, it, vi } from "vitest";
import { RealGitFixtureCase } from "./real-git-fixture-case.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("real-Git fixture case lifetime", () => {
  it("joins a timed-out body before deletion and cannot collect a later owner's root", async () => {
    const controller = new AbortController();
    const ready = deferred<string>();
    const resume = deferred();
    const laterReady = deferred<string>();
    const laterResume = deferred();
    const timeout = new Error("controlled outer test timeout");
    const first = new RealGitFixtureCase(controller.signal).run(async (owner) => {
      const root = await owner.createRoot();
      owner.ownPersistence({ async close() {
        expect(await readFile(join(root, "late-write"), "utf8")).toBe("body finished");
      } });
      ready.resolve(root);
      await resume.promise;
      await writeFile(join(root, "late-write"), "body finished");
    });
    const firstResult = first.catch((error: unknown) => error);
    const root = await ready.promise;
    controller.abort(timeout);
    const later = new RealGitFixtureCase().run(async (owner) => {
      const owned = await owner.createRoot();
      laterReady.resolve(owned);
      await laterResume.promise;
      await writeFile(join(owned, "still-owned"), "later body");
    });
    const laterRoot = await laterReady.promise;
    try {
      await access(root);
      await access(laterRoot);
      resume.resolve();
      expect(await firstResult).toBe(timeout);
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
      await access(laterRoot);
    } finally {
      resume.resolve();
      laterResume.resolve();
      await Promise.allSettled([first, later]);
    }
    await expect(access(laterRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("joins pending partial provisioning after a body rejection and keeps the original error", async () => {
    const ready = deferred<string>();
    const provision = deferred();
    const primary = new Error("original assertion failure");
    const phases: string[] = [];
    const running = new RealGitFixtureCase().run(async (owner) => {
      const root = await owner.createRoot();
      owner.ownPersistence({ async close() {
        expect(await readFile(join(root, "partial"), "utf8")).toBe("created after rejection");
        phases.push("closed");
      } });
      const pending = owner.track(async () => {
        await provision.promise;
        await writeFile(join(root, "partial"), "created after rejection");
        phases.push("provisioned");
      });
      void pending.catch(() => undefined);
      ready.resolve(root);
      throw primary;
    });
    const result = running.catch((error: unknown) => error);
    const root = await ready.promise;
    try {
      await access(root);
      expect(phases).toEqual([]);
    } finally {
      provision.resolve();
    }
    expect(await result).toBe(primary);
    expect(phases).toEqual(["provisioned", "closed"]);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("owns failed runtime creation before any Git child or returned fixture exists", async () => {
    let root = "";
    await expect(new RealGitFixtureCase().run(async (owner) => {
      root = await owner.createRoot();
      await owner.createRuntime(root, { gitExecutablePath: join(root, "absent-git-executable") });
    })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves evidence for a caught termination-unconfirmed result instead of trusting settlement", async () => {
    let root = "";
    const unconfirmed = new WorkspaceError("GIT_BACKEND_FAILURE", "controlled drain refusal", { reason: "termination-unconfirmed" });
    const closed = vi.fn(async () => undefined);
    try {
      await expect(new RealGitFixtureCase().run(async (owner) => {
        root = await owner.createRoot();
        await writeFile(join(root, "evidence"), "retain");
        owner.ownPersistence({ close: closed });
        await expect(owner.observeGit(async () => { throw unconfirmed; })).rejects.toBe(unconfirmed);
      })).rejects.toThrow("Fixture cleanup refused");
      expect(closed).not.toHaveBeenCalled();
      expect(await readFile(join(root, "evidence"), "utf8")).toBe("retain");
    } finally {
      // This controlled result launched no process; only this test owns root.
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  it("reports both the original assertion and failed handle cleanup without deleting evidence", async () => {
    const primary = new Error("original bad-ref assertion");
    const closeError = new Error("controlled handle close failure");
    let root = "";
    try {
      const error = await new RealGitFixtureCase().run(async (owner) => {
        root = await owner.createRoot();
        owner.ownPersistence({ async close() { throw closeError; } });
        throw primary;
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).cause).toBe(primary);
      expect((error as AggregateError).errors[0]).toBe(primary);
      expect((error as AggregateError).errors[1].cause).toBe(closeError);
      await access(root);
    } finally {
      // The controlled close failure has no real open handle.
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds the join of an unresponsive body and retains its root", async () => {
    const ready = deferred<string>();
    const resume = deferred();
    const controller = new AbortController();
    const owner = new RealGitFixtureCase(controller.signal);
    const bodyFinished = deferred();
    const running = owner.run(async () => {
      const root = await owner.createRoot();
      ready.resolve(root);
      await resume.promise;
      bodyFinished.resolve();
    });
    const result = running.catch((error: unknown) => error);
    const root = await ready.promise;
    try {
      vi.useFakeTimers();
      controller.abort(new Error("controlled timeout"));
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await result).toBeInstanceOf(AggregateError);
      await access(root);
      expect(() => owner.createRoot()).toThrow();
    } finally {
      vi.useRealTimers();
      resume.resolve();
      await bodyFinished.promise;
      await result;
      await rm(root, { recursive: true, force: true });
    }
  });
});
