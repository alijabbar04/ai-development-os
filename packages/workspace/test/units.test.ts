import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createExecutionLease, parseCapabilityGrant } from "@ai-dev-os/process-broker";
import {
  DEFAULT_SNAPSHOT_LIMITS,
  WorkspaceError,
  assertSnapshotUsable,
  assertTargetUnchanged,
  captureSnapshot,
  causeCategory,
  createChangedFileManifest,
  createGitRuntime,
  createGitRunner,
  createManagedWorkspace,
  createWorkspaceAccess,
  createWorkspaceCommit,
  decodeTrimmed,
  findStaleWorkspaces,
  readOwnershipMarker,
  detectConflicts,
  discoverRepository,
  inspectTarget,
  invalidConfiguration,
  invalidRequest,
  isWorkspaceError,
  createWorkspaceAuditRecord,
  notifyWorkspaceObserver,
  parseChangedFileEntry,
  processGroupProbeConfirmsGone,
  readGitmodulesMetadata,
  resolveGitExecutable,
  runGitChecked,
  workspaceRootFor,
  type WorkspaceAuditRecord,
} from "../src/index.js";
import { cleanupAllFixtures, createTempRepository, fixtureGit } from "../src/testing/repo-fixtures.js";

const NOW = "2026-08-02T00:00:00.000Z";
const FP = "a".repeat(64);
const bases: string[] = [];

async function scratch(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "adox-wu-"));
  bases.push(base);
  return base;
}

afterAll(async () => {
  await Promise.allSettled(bases.map((base) => rm(base, { recursive: true, force: true })));
  await cleanupAllFixtures();
});

describe("errors", () => {
  it("identifies its own errors and serializes safely", () => {
    const error = new WorkspaceError("CONFLICT", "clash", { count: 2 });
    expect(isWorkspaceError(error)).toBe(true);
    expect(isWorkspaceError(new Error("x"))).toBe(false);
    expect(error.toJSON()).toEqual({
      name: "WorkspaceError",
      code: "CONFLICT",
      message: "clash",
      details: { count: 2 },
    });
    expect(Object.isFrozen(error)).toBe(true);
  });

  it("builds request and configuration errors", () => {
    expect(invalidRequest("bad").code).toBe("INVALID_REQUEST");
    expect(invalidConfiguration("bad").code).toBe("INVALID_CONFIGURATION");
  });

  it("summarizes a cause as a category, never a payload", () => {
    expect(causeCategory(new WorkspaceError("CONFLICT", "x"))).toBe("CONFLICT");
    expect(causeCategory({ code: "ENOENT" })).toBe("ENOENT");
    expect(causeCategory({ code: "!!!invalid!!!" })).toBe("unknown");
    expect(causeCategory(new TypeError("secret"))).toBe("TypeError");
    expect(causeCategory("raw secret string")).toBe("unknown");
    expect(causeCategory(undefined)).toBe("unknown");
  });
});

describe("audit records", () => {
  it("freezes a record and its reason list", () => {
    const record = createWorkspaceAuditRecord({
      event: "snapshot-result",
      occurredAt: NOW,
      projectId: "proj",
      workspaceId: "ws",
      snapshotId: "snap",
      attemptId: "att",
      outcome: "captured",
      reasons: ["dirty"],
      fileCount: 3,
      byteCount: 100,
      fingerprint: FP,
      policyFingerprint: FP,
      durationMs: 12,
    });
    expect(record.schemaVersion).toBe(1);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.reasons)).toBe(true);
  });

  it("delivers to an observer and survives one that throws", () => {
    const seen: WorkspaceAuditRecord[] = [];
    const record = createWorkspaceAuditRecord({
      event: "cleanup",
      occurredAt: NOW,
      projectId: "proj",
      workspaceId: null,
      snapshotId: null,
      attemptId: null,
      outcome: "removed",
      reasons: [],
      fileCount: null,
      byteCount: null,
      fingerprint: null,
      policyFingerprint: null,
      durationMs: null,
    });
    notifyWorkspaceObserver((entry) => seen.push(entry), record);
    expect(seen).toHaveLength(1);
    expect(() =>
      notifyWorkspaceObserver(() => {
        throw new Error("observer failed");
      }, record),
    ).not.toThrow();
    expect(() => notifyWorkspaceObserver(undefined, record)).not.toThrow();
  });
});

describe("changed-file manifests", () => {
  const entry = {
    path: "src/main.ts",
    previousPath: null,
    changeKind: "modified",
    oldObjectId: "a".repeat(40),
    newObjectId: "b".repeat(40),
    oldMode: "100644",
    newMode: "100644",
    similarityPercent: null,
    isSubmodule: false,
    isSymlink: false,
    sizeBytes: 12,
    binary: false,
    diffArtifactDigest: null,
  };

  it("validates a well-formed entry", () => {
    const parsed = parseChangedFileEntry(entry);
    expect(parsed.path).toBe("src/main.ts");
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("accepts a sha-256 object identifier", () => {
    expect(
      parseChangedFileEntry({ ...entry, oldObjectId: "c".repeat(64), newObjectId: null }).oldObjectId,
    ).toBe("c".repeat(64));
  });

  it("rejects malformed identifiers, modes, and kinds", () => {
    expect(() => parseChangedFileEntry({ ...entry, oldObjectId: "zz" })).toThrow();
    expect(() => parseChangedFileEntry({ ...entry, oldMode: "99999" })).toThrow();
    expect(() => parseChangedFileEntry({ ...entry, changeKind: "invented" })).toThrow();
    expect(() => parseChangedFileEntry({ ...entry, extra: true })).toThrow();
    expect(() => parseChangedFileEntry(null)).toThrow();
  });

  it("accepts an artifact-referenced diff and a rename", () => {
    const parsed = parseChangedFileEntry({
      ...entry,
      changeKind: "renamed",
      previousPath: "old.ts",
      similarityPercent: 88,
      binary: true,
      diffArtifactDigest: FP,
    });
    expect(parsed.previousPath).toBe("old.ts");
    expect(parsed.similarityPercent).toBe(88);
    expect(parsed.diffArtifactDigest).toBe(FP);
  });

  it("sorts entries and produces an order-independent fingerprint", () => {
    const a = parseChangedFileEntry({ ...entry, path: "a.ts" });
    const b = parseChangedFileEntry({ ...entry, path: "b.ts" });
    const first = createChangedFileManifest([b, a]);
    const second = createChangedFileManifest([a, b]);
    expect(first.entries.map((item) => item.path)).toEqual(["a.ts", "b.ts"]);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.truncated).toBe(false);
  });
});

describe("git runner", () => {
  it("treats only ESRCH as proof that a POSIX process group is gone", () => {
    expect(processGroupProbeConfirmsGone(Object.assign(new Error("missing"), { code: "ESRCH" }))).toBe(true);
    expect(processGroupProbeConfirmsGone(Object.assign(new Error("forbidden"), { code: "EPERM" }))).toBe(false);
    expect(processGroupProbeConfirmsGone(new Error("unclassified"))).toBe(false);
  });

  it("fails a checked command with a stable code and no Git text", async () => {
    const base = await scratch();
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    const error = await runGitChecked(
      runtime.runner,
      [...runtime.configArguments(), "rev-parse", "--verify", "refs/heads/definitely-missing"],
      { cwd: base, env: runtime.environment(), operation: "verify-missing" },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).code).toBe("GIT_BACKEND_FAILURE");
    expect((error as WorkspaceError).details["operation"]).toBe("verify-missing");
    expect(JSON.stringify((error as WorkspaceError).toJSON())).not.toContain("fatal");
    await runtime.dispose();
  });

  it("accepts a tolerated non-zero exit code", async () => {
    const base = await scratch();
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    const result = await runGitChecked(
      runtime.runner,
      [...runtime.configArguments(), "rev-parse", "--verify", "--quiet", "refs/heads/missing"],
      {
        cwd: base,
        env: runtime.environment(),
        operation: "tolerated",
        toleratedExitCodes: [1, 128],
      },
    );
    expect(result.exitCode).not.toBe(0);
    await runtime.dispose();
  });

  it("enforces a deadline and terminates the command", async () => {
    const repo = await createTempRepository({ extraCommits: 3 });
    const base = await scratch();
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    await expect(
      runtime.runner.run([...runtime.configArguments(), "log", "--all"], {
        cwd: repo.root,
        env: runtime.environment(),
        timeoutMs: 1,
      }),
    ).rejects.toBeInstanceOf(WorkspaceError);
    await runtime.dispose();
    await repo.cleanup();
  });

  it("cancels an already-running Git process through the caller signal", async () => {
    const runner = createGitRunner(process.execPath);
    const controller = new AbortController();
    const running = runner.run(["-e", "setInterval(() => undefined, 1000)"], {
      cwd: process.cwd(),
      env: process.env as Readonly<Record<string, string>>,
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    setTimeout(() => controller.abort(), 20).unref?.();
    await expect(running).rejects.toMatchObject({
      code: "GIT_BACKEND_FAILURE",
      details: { reason: "aborted" },
    });
  });

  it("refuses a signal that was already aborted before process creation", async () => {
    const runner = createGitRunner(process.execPath);
    const controller = new AbortController();
    controller.abort();
    await expect(runner.run(["--version"], {
      cwd: process.cwd(),
      env: process.env as Readonly<Record<string, string>>,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "GIT_BACKEND_FAILURE", details: { reason: "aborted" } });
  });

  it("settles cancellation only after a nested descendant stops writing", async () => {
    const base = await scratch();
    const heartbeat = join(base, "descendant-heartbeat.txt");
    const childScript = `const fs=require("node:fs");const p=${JSON.stringify(heartbeat)};fs.writeFileSync(p,"started\\n");setInterval(()=>fs.appendFileSync(p,"tick\\n"),10);`;
    const parentScript = `require("node:child_process").spawn(${JSON.stringify(process.execPath)},["-e",${JSON.stringify(childScript)}],{stdio:"ignore"});setInterval(()=>{},1000);`;
    const runner = createGitRunner(process.execPath);
    const controller = new AbortController();
    const running = runner.run(["-e", parentScript], {
      cwd: base,
      env: process.env as Readonly<Record<string, string>>,
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await access(heartbeat).then(() => true).catch(() => false)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    await expect(access(heartbeat)).resolves.toBeUndefined();
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "GIT_BACKEND_FAILURE", details: { reason: "aborted" } });
    const stoppedLength = (await readFile(heartbeat)).byteLength;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    expect((await readFile(heartbeat)).byteLength).toBe(stoppedLength);
  }, 15_000);

  it.runIf(process.platform === "win32")("refuses to spawn when the trusted Windows tree killer is unavailable", async () => {
    const base = await scratch();
    const heartbeat = join(base, "heartbeat.txt");
    const originalSystemRoot = process.env["SystemRoot"];
    try {
      process.env["SystemRoot"] = "relative-untrusted-root";
      const runner = createGitRunner(process.execPath);
      await expect(runner.run([
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(heartbeat)},"unexpected")`,
      ], {
        cwd: base,
        env: process.env as Readonly<Record<string, string>>,
        timeoutMs: 60_000,
      })).rejects.toMatchObject({ code: "GIT_UNAVAILABLE" });
    } finally {
      if (originalSystemRoot === undefined) delete process.env["SystemRoot"];
      else process.env["SystemRoot"] = originalSystemRoot;
    }
    await expect(access(heartbeat)).rejects.toBeDefined();
  });

  it.runIf(process.platform === "win32")("fails closed after a trusted-path tree killer returns failure", async () => {
    const base = await scratch();
    const fakeSystemRoot = join(base, "fake-system-root");
    const fakeSystem32 = join(fakeSystemRoot, "System32");
    await mkdir(fakeSystem32, { recursive: true });
    await copyFile(process.execPath, join(fakeSystem32, "taskkill.exe"));
    const originalSystemRoot = process.env["SystemRoot"];
    try {
      process.env["SystemRoot"] = fakeSystemRoot;
      const runner = createGitRunner(process.execPath);
      const controller = new AbortController();
      const running = runner.run(["-e", "setInterval(() => undefined, 1000)"], {
        cwd: base,
        env: process.env as Readonly<Record<string, string>>,
        signal: controller.signal,
        timeoutMs: 60_000,
      });
      setTimeout(() => controller.abort(), 20).unref?.();
      await expect(running).rejects.toMatchObject({ code: "GIT_BACKEND_FAILURE", details: { reason: "termination-unconfirmed" } });
    } finally {
      if (originalSystemRoot === undefined) delete process.env["SystemRoot"];
      else process.env["SystemRoot"] = originalSystemRoot;
    }
  }, 15_000);

  it("refuses output beyond the configured bound", async () => {
    const repo = await createTempRepository({ extraCommits: 5 });
    const base = await scratch();
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    const error = await runtime.runner.run([...runtime.configArguments(), "log", "--format=%H%n%B"], {
        cwd: repo.root,
        env: runtime.environment(),
        maxOutputBytes: 8,
      }).catch((failure: unknown) => failure);
    if (process.platform === "win32") {
      expect(error).toMatchObject({ code: "GIT_BACKEND_FAILURE", details: { reason: "termination-unconfirmed" } });
    } else {
      expect(error).toMatchObject({ code: "OUTPUT_TRUNCATED" });
    }
    await runtime.dispose();
    await repo.cleanup();
  });

  it("reports a missing executable rather than throwing raw", async () => {
    const base = await scratch();
    const runner = createGitRunner(join(base, "no-such-git.exe"));
    await expect(
      runner.run(["--version"], { cwd: base, env: {} }),
    ).rejects.toMatchObject({ code: "GIT_UNAVAILABLE" });
  });

  it("maps a synchronous spawn argument refusal to a finite unavailable error", async () => {
    const runner = createGitRunner(process.execPath);
    await expect(runner.run(["\u0000"], { cwd: process.cwd(), env: {} })).rejects.toMatchObject({ code: "GIT_UNAVAILABLE" });
  });

  it("locates git and rejects a configured path that does not exist", async () => {
    expect(resolveGitExecutable()).toMatch(/git(\.exe)?$/i);
    expect(() => resolveGitExecutable({ explicitPath: "C:/definitely/not/git.exe" })).toThrow(
      WorkspaceError,
    );
    expect(() => resolveGitExecutable({ hostEnvironment: { PATH: "" }, platform: "linux" })).toThrow(
      WorkspaceError,
    );
  });

  it("decodes and trims command output", () => {
    expect(decodeTrimmed(Buffer.from("  value \n"))).toBe("value");
  });
});

describe("runtime", () => {
  it("refuses a relative root", async () => {
    await expect(createGitRuntime({ root: "relative/path" })).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
  });

  it("exposes a temp directory and disposes only its own root", async () => {
    const base = await scratch();
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    expect(runtime.tempDir.startsWith(join(base, "runtime"))).toBe(true);
    expect(runtime.executablePath.length).toBeGreaterThan(0);
    await runtime.dispose();
    await runtime.dispose();
    // Disposal is bounded to the runtime root; the parent survives.
    const { access } = await import("node:fs/promises");
    await expect(access(base)).resolves.toBeUndefined();
  });
});

describe("discovery edge cases", () => {
  it("refuses a bare repository", async () => {
    const base = await scratch();
    const bare = join(base, "bare.git");
    await mkdir(bare, { recursive: true });
    fixtureGit(base, ["init", "--bare", "--quiet", bare]);
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    await expect(discoverRepository(runtime, { directory: bare })).rejects.toMatchObject({
      code: "UNSUPPORTED_REPOSITORY",
    });
    await runtime.dispose();
  });

  it("refuses a relative directory and a file", async () => {
    const base = await scratch();
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    await expect(discoverRepository(runtime, { directory: "not-absolute" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    const file = join(base, "a-file.txt");
    await writeFile(file, "x");
    await expect(discoverRepository(runtime, { directory: file })).rejects.toMatchObject({
      code: "NOT_A_REPOSITORY",
    });
    await expect(
      discoverRepository(runtime, { directory: join(base, "missing-dir") }),
    ).rejects.toMatchObject({ code: "NOT_A_REPOSITORY" });
    await runtime.dispose();
  });

  it("refuses more untracked files than the configured bound", async () => {
    const repo = await createTempRepository({ withUntracked: true, dirty: true });
    const base = await scratch();
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    await expect(
      discoverRepository(runtime, { directory: repo.root, maxUntrackedPaths: 1 }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_TOO_LARGE" });
    await runtime.dispose();
    await repo.cleanup();
  });

  it("reads .gitmodules as inert bounded metadata", async () => {
    const repo = await createTempRepository({ withSubmodule: true });
    const content = await readGitmodulesMetadata(repo.root);
    expect(content).toContain("submodule");
    // The dangerous update command is present as text and never executed.
    expect(content).toContain("update = !touch");
    expect(await readGitmodulesMetadata(repo.root, 4)).toBeNull();
    expect(await readGitmodulesMetadata(join(repo.root, "nowhere"))).toBeNull();
    await repo.cleanup();
  });

  it("discovers submodule gitlinks without entering them", async () => {
    const repo = await createTempRepository({ withSubmodule: true });
    const base = await scratch();
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    const discovery = await discoverRepository(runtime, { directory: repo.root });
    expect(discovery.programConfigOverrides).toBeDefined();
    for (const entry of discovery.submodules) {
      expect(entry.objectId).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.path).not.toContain("..");
    }
    await runtime.dispose();
    await repo.cleanup();
  });
});

describe("snapshot edge cases", () => {
  it("refuses a repository with no commits", async () => {
    const base = await scratch();
    const empty = join(base, "empty");
    await mkdir(empty, { recursive: true });
    fixtureGit(base, ["init", "--quiet", "--initial-branch=main", empty]);
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    const discovery = await discoverRepository(runtime, { directory: empty });
    expect(discovery.hasUncommittedHistory).toBe(true);
    await expect(
      captureSnapshot(runtime, {
        projectId: "proj",
        snapshotId: "snap",
        discovery,
        storageRoot: join(base, "store"),
        capturedAt: NOW,
        allowDirty: true,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_REPOSITORY" });
    await runtime.dispose();
  });

  it("refuses a file larger than the per-file bound", async () => {
    const repo = await createTempRepository({ dirty: true });
    const base = await scratch();
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    const discovery = await discoverRepository(runtime, { directory: repo.root });
    await expect(
      captureSnapshot(runtime, {
        projectId: "proj",
        snapshotId: "snap",
        discovery,
        storageRoot: join(base, "store"),
        capturedAt: NOW,
        allowDirty: true,
        limits: { ...DEFAULT_SNAPSHOT_LIMITS, maxFileBytes: 1 },
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_TOO_LARGE" });
    await runtime.dispose();
    await repo.cleanup();
  });

  it("refuses a snapshot that exceeds the file-count bound", async () => {
    const repo = await createTempRepository({ dirty: true, withUntracked: true });
    const base = await scratch();
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    const discovery = await discoverRepository(runtime, { directory: repo.root });
    await expect(
      captureSnapshot(runtime, {
        projectId: "proj",
        snapshotId: "snap",
        discovery,
        storageRoot: join(base, "store"),
        capturedAt: NOW,
        allowDirty: true,
        includeUntracked: ["untracked.txt", "secret.key"],
        limits: { ...DEFAULT_SNAPSHOT_LIMITS, maxFiles: 1 },
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_TOO_LARGE" });
    await runtime.dispose();
    await repo.cleanup();
  });

  it("accepts a supported snapshot and rejects an unknown schema version", async () => {
    const repo = await createTempRepository();
    const base = await scratch();
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    const discovery = await discoverRepository(runtime, { directory: repo.root });
    const snapshot = await captureSnapshot(runtime, {
      projectId: "proj",
      snapshotId: "snap",
      discovery,
      storageRoot: join(base, "store"),
      capturedAt: NOW,
    });
    expect(() => assertSnapshotUsable(snapshot)).not.toThrow();
    expect(() =>
      assertSnapshotUsable({ ...snapshot, schemaVersion: 99 as unknown as 1 }),
    ).toThrow(WorkspaceError);
    expect(Object.isFrozen(snapshot)).toBe(true);
    await runtime.dispose();
    await repo.cleanup();
  });
});

describe("target helpers", () => {
  it("asserts an unchanged target and rejects a moved one", () => {
    const unchanged = {
      ref: "main",
      observedCommit: "a".repeat(40),
      currentCommit: "a".repeat(40),
      movement: "unchanged" as const,
      fastForwardPossible: true,
      checkedAt: NOW,
    };
    expect(() => assertTargetUnchanged(unchanged)).not.toThrow();
    expect(() =>
      assertTargetUnchanged({ ...unchanged, movement: "advanced" }),
    ).toThrow(WorkspaceError);
  });

  it("reports an unavailable target when the snapshot had no branch", async () => {
    const repo = await createTempRepository({ detachedHead: true });
    const base = await scratch();
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    const discovery = await discoverRepository(runtime, { directory: repo.root });
    const snapshot = await captureSnapshot(runtime, {
      projectId: "proj",
      snapshotId: "snap",
      discovery,
      storageRoot: join(base, "store"),
      capturedAt: NOW,
      allowDirty: true,
    });
    const status = await inspectTarget(runtime, {
      snapshot,
      repositoryRoot: repo.root,
      gitDir: discovery.gitDir,
      checkedAt: NOW,
    });
    expect(status.movement).toBe("unavailable");
    await runtime.dispose();
    await repo.cleanup();
  });

  it("detects a real textual conflict between two candidates", async () => {
    const repo = await createTempRepository();
    const base = await scratch();
    const managedRootBase = join(base, "managed");
    await mkdir(managedRootBase, { recursive: true });
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    const discovery = await discoverRepository(runtime, { directory: repo.root });
    const snapshot = await captureSnapshot(runtime, {
      projectId: "proj",
      snapshotId: "snap",
      discovery,
      storageRoot: join(base, "store"),
      capturedAt: NOW,
    });
    const workspace = await createManagedWorkspace(runtime, {
      projectId: "proj",
      workspaceId: "ws",
      attemptId: "att",
      snapshot,
      managedRootBase,
      createdAt: NOW,
      expiresAt: "2026-08-02T01:00:00.000Z",
      policyFingerprint: FP,
    });

    // Two commits on the same base changing the same line differently.
    const makeCommit = (content: string, message: string): string => {
      const blob = fixtureGit(workspace.repositoryDir, [
        "--git-dir",
        workspace.repositoryDir,
        "hash-object",
        "-w",
        "--stdin",
      ]);
      void blob;
      void content;
      void message;
      return "";
    };
    void makeCommit;

    await writeFile(join(workspace.worktreeDir, "tracked.txt"), "left side\n");
    fixtureGit(workspace.worktreeDir, ["add", "tracked.txt"]);
    const leftTree = fixtureGit(workspace.worktreeDir, ["write-tree"]);
    const left = fixtureGit(workspace.worktreeDir, [
      "commit-tree",
      leftTree,
      "-p",
      snapshot.snapshotCommit,
      "-m",
      "left",
    ]);
    await writeFile(join(workspace.worktreeDir, "tracked.txt"), "right side\n");
    fixtureGit(workspace.worktreeDir, ["add", "tracked.txt"]);
    const rightTree = fixtureGit(workspace.worktreeDir, ["write-tree"]);
    const right = fixtureGit(workspace.worktreeDir, [
      "commit-tree",
      rightTree,
      "-p",
      snapshot.snapshotCommit,
      "-m",
      "right",
    ]);

    const report = await detectConflicts(runtime, {
      repositoryDir: workspace.repositoryDir,
      managedRoot: workspace.managedRoot,
      candidateCommit: left,
      targetCommit: right,
    });
    expect(report.conflicted).toBe(true);
    expect(report.conflictingPaths).toContain("tracked.txt");
    expect(report.mergeBase).toBe(snapshot.snapshotCommit);
    await runtime.dispose();
    await repo.cleanup();
  });
});

describe("more snapshot and worktree edges", () => {
  it("refuses a path longer than the configured bound", async () => {
    const repo = await createTempRepository({ dirty: true });
    const base = await scratch();
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    const discovery = await discoverRepository(runtime, { directory: repo.root });
    await expect(
      captureSnapshot(runtime, {
        projectId: "proj",
        snapshotId: "snap",
        discovery,
        storageRoot: join(base, "store"),
        capturedAt: NOW,
        allowDirty: true,
        limits: { ...DEFAULT_SNAPSHOT_LIMITS, maxPathLength: 2 },
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await runtime.dispose();
    await repo.cleanup();
  });

  it("refuses a snapshot whose total bytes exceed the bound", async () => {
    const repo = await createTempRepository({ dirty: true, withUntracked: true });
    const base = await scratch();
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    const discovery = await discoverRepository(runtime, { directory: repo.root });
    await expect(
      captureSnapshot(runtime, {
        projectId: "proj",
        snapshotId: "snap",
        discovery,
        storageRoot: join(base, "store"),
        capturedAt: NOW,
        allowDirty: true,
        includeUntracked: ["untracked.txt"],
        limits: { ...DEFAULT_SNAPSHOT_LIMITS, maxTotalBytes: 1 },
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_TOO_LARGE" });
    await runtime.dispose();
    await repo.cleanup();
  });

  it("rejects a malformed or foreign ownership marker", async () => {
    const base = await scratch();
    const dir = join(base, "candidate");
    await mkdir(dir, { recursive: true });
    const marker = join(dir, ".ai-dev-os-workspace.json");
    expect(await readOwnershipMarker(dir)).toBeNull();
    await writeFile(marker, "{not json");
    expect(await readOwnershipMarker(dir)).toBeNull();
    await writeFile(marker, JSON.stringify({ schemaVersion: 99 }));
    expect(await readOwnershipMarker(dir)).toBeNull();
    await writeFile(marker, JSON.stringify("a string"));
    expect(await readOwnershipMarker(dir)).toBeNull();
    await writeFile(marker, "x".repeat(5_000));
    expect(await readOwnershipMarker(dir)).toBeNull();
    await writeFile(marker, JSON.stringify({ schemaVersion: 1, workspaceId: 42 }));
    expect((await readOwnershipMarker(dir))?.workspaceId).toBe("");
  });

  it("returns nothing when the managed root cannot be listed", async () => {
    const base = await scratch();
    const stale = await findStaleWorkspaces({
      managedRootBase: join(base, "never-created"),
      now: new Date(NOW),
      olderThanMs: 0,
    });
    expect(stale).toEqual([]);
  });

  it("honours an explicit author identity and timeout on commit", async () => {
    const repo = await createTempRepository();
    const base = await scratch();
    const managedRootBase = join(base, "managed");
    await mkdir(managedRootBase, { recursive: true });
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    const discovery = await discoverRepository(runtime, {
      directory: repo.root,
      timeoutMs: 60_000,
    });
    const snapshot = await captureSnapshot(runtime, {
      projectId: "proj",
      snapshotId: "snap",
      discovery,
      storageRoot: join(base, "store"),
      capturedAt: NOW,
      timeoutMs: 60_000,
    });
    const workspace = await createManagedWorkspace(runtime, {
      projectId: "proj",
      workspaceId: "ws",
      attemptId: "att",
      snapshot,
      managedRootBase,
      createdAt: NOW,
      expiresAt: "2026-08-02T01:00:00.000Z",
      policyFingerprint: FP,
      timeoutMs: 60_000,
    });
    await writeFile(join(workspace.worktreeDir, "tracked.txt"), "authored\n");
    const manifest = await createWorkspaceCommit(runtime, {
      workspace,
      message: "authored change",
      committedAt: NOW,
      authorCategory: "system",
      policyFingerprint: FP,
      authorName: "Explicit Author",
      authorEmail: "explicit@example.invalid",
      timeoutMs: 60_000,
    });
    expect(manifest.authorCategory).toBe("system");
    expect(manifest.messageByteLength).toBe("authored change".length);
    await runtime.dispose();
    await repo.cleanup();
  });
});

describe("access helpers", () => {
  it("resolves a managed root", () => {
    expect(workspaceRootFor("/a/b")).toContain("b");
  });

  it("removes a granted path and reports a missing one", async () => {
    const repo = await createTempRepository();
    const base = await scratch();
    const managedRootBase = join(base, "managed");
    await mkdir(managedRootBase, { recursive: true });
    const runtime = await createGitRuntime({ root: join(base, "runtime") });
    const discovery = await discoverRepository(runtime, { directory: repo.root });
    const snapshot = await captureSnapshot(runtime, {
      projectId: "proj",
      snapshotId: "snap",
      discovery,
      storageRoot: join(base, "store"),
      capturedAt: NOW,
    });
    const workspace = await createManagedWorkspace(runtime, {
      projectId: "proj",
      workspaceId: "ws",
      attemptId: "att",
      snapshot,
      managedRootBase,
      createdAt: NOW,
      expiresAt: "2026-08-02T01:00:00.000Z",
      policyFingerprint: FP,
    });
    const now = Date.now();
    const grant = parseCapabilityGrant({
      schemaVersion: 2,
      grantId: "g",
      projectId: "proj",
      runId: null,
      taskId: null,
      attemptId: "att",
      snapshotId: "snap",
      workspaceId: "ws",
      operations: ["workspace-read", "workspace-write"],
      readablePrefixes: [""],
      writablePrefixes: [""],
      tools: [],
      environmentNames: [],
      credentialRefFingerprints: [],
      controlPlaneEndpointPolicyFingerprint: null,
      network: { mode: "denied", egressDomains: [] },
      quotas: {
        wallClockMs: 1_000,
        cpuTimeMs: null,
        memoryBytes: null,
        processCount: null,
        outputBytes: 1_024,
        diskBytes: null,
        fileCount: null,
      },
      issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      nonce: "0".repeat(32),
      policyFingerprint: FP,
      approvalEvidenceRefs: [],
    });
    const access = createWorkspaceAccess({
      worktreeDir: workspace.worktreeDir,
      grant,
      lease: createExecutionLease({ leaseId: "l", grant, clock: { now: () => new Date() } }),
    });

    expect(await access.remove("missing.txt")).toBe(false);
    await access.createExclusive("temp.txt", new TextEncoder().encode("x"));
    expect(await access.remove("temp.txt")).toBe(true);
    await expect(
      access.createExclusive("tracked.txt", new TextEncoder().encode("y")),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(access.read("src")).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(access.list("does-not-exist")).rejects.toMatchObject({ code: "UNSAFE_PATH" });

    const stat = await access.stat("tracked.txt");
    expect(stat?.kind).toBe("file");

    // A directory cannot be created where a file already sits, a write into a
    // missing parent fails, and metadata for a missing path is an error
    // rather than a silent null.
    await expect(access.createDirectory("tracked.txt")).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
    await expect(
      access.replace("missing-parent/child.txt", new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(access.linkMetadata("not-here.txt")).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });

    await runtime.dispose();
    await repo.cleanup();
  });
});
