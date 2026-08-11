import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createExecutionLease,
  createManualTime,
  parseCapabilityGrant,
  type CapabilityGrant,
  type ExecutionLease,
} from "@ai-dev-os/process-broker";
import {
  WorkspaceError,
  buildGitEnvironment,
  captureDiff,
  captureSnapshot,
  captureWorktreeDiff,
  cleanupManagedWorkspace,
  createGitRuntime,
  createManagedWorkspace,
  createWorkspaceAccess,
  createWorkspaceCommit,
  detectConflicts,
  discoverRepository,
  findStaleWorkspaces,
  inspectTarget,
  neutralizingConfigArguments,
  parseRawDiffRecords,
  readOwnershipMarker,
  removeManagedDirectory,
  sanitizingConfigArguments,
  splitNulRecords,
  transitionWorkspace,
  type GitRuntime,
  type ManagedWorkspaceRecord,
  type RepositorySnapshot,
} from "../src/index.js";
import {
  assertHostileFixtureFires,
  cleanupAllFixtures,
  createJunction,
  createTempRepository,
  fixtureGit,
  symlinksSupported,
  type TempRepository,
} from "../src/testing/repo-fixtures.js";
import { fingerprintTree } from "../src/testing/contract-suite.js";

const NOW = "2026-08-02T00:00:00.000Z";
const EXPIRY = "2026-08-02T01:00:00.000Z";
const FP = "a".repeat(64);
const bases: string[] = [];

afterAll(async () => {
  await Promise.allSettled(bases.map((base) => rm(base, { recursive: true, force: true })));
  await cleanupAllFixtures();
});

interface Harness {
  runtime: GitRuntime;
  managedRootBase: string;
  storageRoot: string;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), "adox-wss-"));
  bases.push(base);
  const managedRootBase = join(base, "managed");
  const storageRoot = join(base, "snapshots");
  await mkdir(managedRootBase, { recursive: true });
  await mkdir(storageRoot, { recursive: true });
  const runtime = await createGitRuntime({ root: join(base, "runtime") });
  return {
    runtime,
    managedRootBase,
    storageRoot,
    close: () => runtime.dispose(),
  };
}

async function snapshotFor(
  h: Harness,
  repo: TempRepository,
  includeUntracked?: readonly string[],
): Promise<RepositorySnapshot> {
  const discovery = await discoverRepository(h.runtime, { directory: repo.root });
  return await captureSnapshot(h.runtime, {
    projectId: "proj",
    snapshotId: "snap",
    discovery,
    storageRoot: h.storageRoot,
    capturedAt: NOW,
    allowDirty: true,
    ...(includeUntracked === undefined ? {} : { includeUntracked }),
  });
}

async function workspaceFor(
  h: Harness,
  repo: TempRepository,
  attemptId = "att",
): Promise<{ snapshot: RepositorySnapshot; workspace: ManagedWorkspaceRecord }> {
  const snapshot = await snapshotFor(h, repo);
  const workspace = await createManagedWorkspace(h.runtime, {
    projectId: "proj",
    workspaceId: "ws",
    attemptId,
    snapshot,
    managedRootBase: h.managedRootBase,
    createdAt: NOW,
    expiresAt: EXPIRY,
    policyFingerprint: FP,
  });
  return { snapshot, workspace };
}

function grantFor(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  const now = Date.now();
  return parseCapabilityGrant({
    schemaVersion: 2,
    grantId: "grant-ws",
    projectId: "proj",
    runId: null,
    taskId: null,
    attemptId: "att",
    snapshotId: "snap",
    workspaceId: "ws",
    operations: ["workspace-read", "workspace-write"],
    readablePrefixes: [""],
    writablePrefixes: ["out"],
    tools: [],
    environmentNames: [],
    credentialRefFingerprints: [],
    controlPlaneEndpointPolicyFingerprint: null,
    network: { mode: "denied", egressDomains: [] },
    quotas: {
      wallClockMs: 30_000,
      cpuTimeMs: null,
      memoryBytes: null,
      processCount: null,
      outputBytes: 1_048_576,
      diskBytes: null,
      fileCount: null,
    },
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    nonce: "0".repeat(32),
    policyFingerprint: FP,
    approvalEvidenceRefs: [],
    ...overrides,
  });
}

function leaseFor(grant: CapabilityGrant): ExecutionLease {
  return createExecutionLease({
    leaseId: "lease-ws",
    grant,
    clock: { now: () => new Date() },
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

describe("hostile fixture positive control", () => {
  it("proves the armed hook and filter really do execute for ordinary Git", async () => {
    const repo = await createTempRepository({
      withHostileHooks: true,
      withHostileFilters: true,
      dirty: true,
    });
    const fired = await assertHostileFixtureFires(repo);
    // If this ever reports false, every "no marker appeared" assertion
    // elsewhere would be vacuous.
    expect(fired.hookFired || fired.filterFired).toBe(true);
    await repo.cleanup();
  });
});

describe("git configuration sanitization", () => {
  it("disables every program-launching configuration key", () => {
    const args = sanitizingConfigArguments({ emptyHooksDir: "/tmp/hooks" }).join(" ");
    for (const key of [
      "core.hooksPath=",
      "core.fsmonitor=false",
      "credential.helper=",
      "core.askPass=",
      "commit.gpgsign=false",
      "gpg.program=",
      "core.editor=",
      "core.pager=",
      "diff.external=",
      "submodule.recurse=false",
      "protocol.allow=never",
      "maintenance.auto=false",
    ]) {
      expect(args).toContain(key);
    }
  });

  it("denies every protocol by default and enables only local file when asked", () => {
    expect(sanitizingConfigArguments({ emptyHooksDir: "/h" })).toContain("protocol.allow=never");
    expect(sanitizingConfigArguments({ emptyHooksDir: "/h" }).join(" ")).not.toContain(
      "protocol.file.allow",
    );
    const local = sanitizingConfigArguments({
      emptyHooksDir: "/h",
      allowLocalFileProtocol: true,
    }).join(" ");
    expect(local).toContain("protocol.allow=never");
    expect(local).toContain("protocol.file.allow=always");
  });

  it("derives neutralizing overrides from discovered driver names", () => {
    const args = neutralizingConfigArguments([
      "filter.evil.clean",
      "filter.evil.smudge",
      "filter.lfs.process",
      "diff.doc.textconv",
      "merge.custom.driver",
      "protocol.ext.allow",
      "user.name",
    ]);
    const joined = args.join(" ");
    expect(joined).toContain("filter.evil.clean=");
    expect(joined).toContain("filter.evil.smudge=");
    expect(joined).toContain("filter.evil.process=");
    expect(joined).toContain("filter.evil.required=false");
    expect(joined).toContain("filter.lfs.process=");
    expect(joined).toContain("diff.doc.textconv=");
    expect(joined).toContain("merge.custom.driver=");
    expect(joined).toContain("protocol.ext.allow=never");
    expect(joined).not.toContain("user.name");
    expect(() => neutralizingConfigArguments(["merge.evil=x.driver"]))
      .toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    expect(() => neutralizingConfigArguments(["protocol.evil=x.allow"]))
      .toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });

  it("builds an environment that inherits no credential or redirection variable", () => {
    const env = buildGitEnvironment({
      emptyHooksDir: "/h",
      emptyGlobalConfigFile: "/g",
      emptyHomeDir: "/home",
      tempDir: "/tmp",
      platform: "linux",
      hostEnvironment: {
        GIT_DIR: "/evil/.git",
        GIT_CONFIG_GLOBAL: "/evil/config",
        SSH_AUTH_SOCK: "/tmp/agent",
        GIT_ASKPASS: "/evil/askpass",
        HOME: "/root",
        GITHUB_TOKEN: "leaked",
        PATH: "/usr/bin",
      },
    });
    expect(env["GIT_DIR"]).toBeUndefined();
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["SSH_AUTH_SOCK"]).toBeUndefined();
    expect(env["GIT_CONFIG_GLOBAL"]).toBe("/g");
    expect(env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(env["GIT_ATTR_NOSYSTEM"]).toBe("1");
    expect(env["GIT_NO_LAZY_FETCH"]).toBe("1");
    expect(env["HOME"]).toBe("/home");
    expect(env["GIT_ASKPASS"]).toBe("");
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(env["GIT_OPTIONAL_LOCKS"]).toBe("0");
    expect(env["LC_ALL"]).toBe("C");
  });

  it("sets a private index, object directory, and alternates when asked", () => {
    const env = buildGitEnvironment({
      emptyHooksDir: "/h",
      emptyGlobalConfigFile: "/g",
      emptyHomeDir: "/home",
      tempDir: "/tmp",
      platform: "linux",
      hostEnvironment: {},
      indexFile: "/private/index",
      objectDirectory: "/private/objects",
      alternateObjectDirectories: ["/source/objects", "/other/objects"],
    });
    expect(env["GIT_INDEX_FILE"]).toBe("/private/index");
    expect(env["GIT_OBJECT_DIRECTORY"]).toBe("/private/objects");
    expect(env["GIT_ALTERNATE_OBJECT_DIRECTORIES"]).toBe("/source/objects:/other/objects");
    expect(() => buildGitEnvironment({
      emptyHooksDir: "/h",
      emptyGlobalConfigFile: "/g",
      emptyHomeDir: "/home",
      tempDir: "/tmp",
      platform: "linux",
      hostEnvironment: {},
      alternateObjectDirectories: ["/source/escape:other"],
    })).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });
});

describe("raw diff parsing", () => {
  it("parses modes, identifiers, and statuses", () => {
    const records = [
      ":100644 100644 aaaaaaa bbbbbbb M",
      "src/main.ts",
      ":000000 100644 0000000 ccccccc A",
      "added.ts",
      ":100644 000000 ddddddd 0000000 D",
      "gone.ts",
    ];
    const entries = parseRawDiffRecords(records);
    expect(entries.map((entry) => entry.changeKind)).toEqual(["modified", "added", "deleted"]);
    expect(entries[0]?.path).toBe("src/main.ts");
    expect(entries[1]?.oldObjectId).toBeNull();
    expect(entries[2]?.newObjectId).toBeNull();
  });

  it("consumes both paths of a rename and reports the destination", () => {
    const entries = parseRawDiffRecords([
      ":100644 100644 aaaaaaa bbbbbbb R92",
      "old/name.ts",
      "new/name.ts",
      ":100644 100644 ccccccc ddddddd M",
      "after.ts",
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.changeKind).toBe("renamed");
    expect(entries[0]?.previousPath).toBe("old/name.ts");
    expect(entries[0]?.path).toBe("new/name.ts");
    expect(entries[0]?.similarityPercent).toBe(92);
    // The entry after a rename must not be mis-parsed by a fixed stride.
    expect(entries[1]?.path).toBe("after.ts");
  });

  it("recognizes a gitlink change as a submodule change", () => {
    const entries = parseRawDiffRecords([
      ":160000 160000 aaaaaaa bbbbbbb M",
      "vendor/dep",
    ]);
    expect(entries[0]?.isSubmodule).toBe(true);
    expect(entries[0]?.changeKind).toBe("submodule-changed");
  });

  it("recognizes a type change and a symlink", () => {
    const entries = parseRawDiffRecords([
      ":100644 120000 aaaaaaa bbbbbbb T",
      "link.txt",
    ]);
    expect(entries[0]?.changeKind).toBe("type-changed");
    expect(entries[0]?.isSymlink).toBe(true);
  });

  it("rejects malformed raw output rather than guessing", () => {
    expect(() => parseRawDiffRecords(["not-a-header", "x"])).toThrow(WorkspaceError);
    expect(() => parseRawDiffRecords([":100644 100644 aaa bbb M"])).toThrow(WorkspaceError);
    expect(() => parseRawDiffRecords([":xxxxxx 100644 aaa bbb M", "p"])).toThrow(WorkspaceError);
  });

  it("splits NUL records and drops the trailing empty one", () => {
    expect(splitNulRecords(Buffer.from("a\u0000b\u0000"))).toEqual(["a", "b"]);
    expect(splitNulRecords(Buffer.from(""))).toEqual([]);
  });
});

describe("diff and commit manifests", () => {
  it("produces a changed-file manifest for work done in the worktree", async () => {
    const h = await harness();
    const repo = await createTempRepository();
    const { workspace } = await workspaceFor(h, repo);
    await writeFile(join(workspace.worktreeDir, "tracked.txt"), "changed by agent\n");
    await writeFile(join(workspace.worktreeDir, "new-file.ts"), "export const x = 1;\n");
    await rm(join(workspace.worktreeDir, "keep.txt"));

    const manifest = await captureWorktreeDiff(h.runtime, { workspace });
    const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    expect(byPath.get("tracked.txt")?.changeKind).toBe("modified");
    expect(byPath.get("new-file.ts")?.changeKind).toBe("added");
    expect(byPath.get("keep.txt")?.changeKind).toBe("deleted");
    expect(manifest.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.truncated).toBe(false);
    await repo.cleanup();
    await h.close();
  });

  it("creates a verified commit and a manifest, moving no user branch", async () => {
    const h = await harness();
    const repo = await createTempRepository();
    const before = await fingerprintTree(repo.root);
    const { workspace } = await workspaceFor(h, repo);
    await writeFile(join(workspace.worktreeDir, "tracked.txt"), "agent edit\n");

    const manifest = await createWorkspaceCommit(h.runtime, {
      workspace,
      message: "agent change",
      committedAt: NOW,
      authorCategory: "agent",
      policyFingerprint: FP,
    });
    expect(manifest.commitId).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.parentIds).toContain(workspace.snapshotCommit);
    expect(manifest.changedFileCount).toBe(1);
    expect(manifest.authorCategory).toBe("agent");
    expect(manifest.timestampSource).toBe("injected");
    // The user's repository is untouched by the commit.
    expect(await fingerprintTree(repo.root)).toBe(before);
    await repo.cleanup();
    await h.close();
  });

  it("rejects an empty or oversized commit message", async () => {
    const h = await harness();
    const repo = await createTempRepository();
    const { workspace } = await workspaceFor(h, repo);
    await expect(
      createWorkspaceCommit(h.runtime, {
        workspace,
        message: "",
        committedAt: NOW,
        authorCategory: "agent",
        policyFingerprint: FP,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      createWorkspaceCommit(h.runtime, {
        workspace,
        message: "x".repeat(20_000),
        committedAt: NOW,
        authorCategory: "agent",
        policyFingerprint: FP,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await repo.cleanup();
    await h.close();
  });

  it("diffs two commits in the managed repository", async () => {
    const h = await harness();
    const repo = await createTempRepository();
    const { workspace } = await workspaceFor(h, repo);
    await writeFile(join(workspace.worktreeDir, "tracked.txt"), "one\n");
    const first = await createWorkspaceCommit(h.runtime, {
      workspace,
      message: "first",
      committedAt: NOW,
      authorCategory: "agent",
      policyFingerprint: FP,
    });
    const manifest = await captureDiff(h.runtime, {
      workspace,
      fromCommit: workspace.snapshotCommit,
      toCommit: first.commitId,
    });
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["tracked.txt"]);
    await repo.cleanup();
    await h.close();
  });
});

describe("target movement and conflicts", () => {
  it("reports an unchanged target", async () => {
    const h = await harness();
    const repo = await createTempRepository();
    const snapshot = await snapshotFor(h, repo);
    const discovery = await discoverRepository(h.runtime, { directory: repo.root });
    const status = await inspectTarget(h.runtime, {
      snapshot,
      repositoryRoot: repo.root,
      gitDir: discovery.gitDir,
      checkedAt: NOW,
    });
    expect(status.movement).toBe("unchanged");
    expect(status.fastForwardPossible).toBe(true);
    await repo.cleanup();
    await h.close();
  });

  it("reports an advanced target without changing it", async () => {
    const h = await harness();
    const repo = await createTempRepository();
    const snapshot = await snapshotFor(h, repo);
    const discovery = await discoverRepository(h.runtime, { directory: repo.root });
    await writeFile(join(repo.root, "later.txt"), "later\n");
    fixtureGit(repo.root, ["add", "later.txt"]);
    fixtureGit(repo.root, ["commit", "--quiet", "-m", "later"]);
    const movedHead = fixtureGit(repo.root, ["rev-parse", "HEAD"]);

    const status = await inspectTarget(h.runtime, {
      snapshot,
      repositoryRoot: repo.root,
      gitDir: discovery.gitDir,
      checkedAt: NOW,
    });
    expect(status.movement).toBe("advanced");
    expect(status.currentCommit).toBe(movedHead);
    // Detection is read-only: the branch still points where the user left it.
    expect(fixtureGit(repo.root, ["rev-parse", "HEAD"])).toBe(movedHead);
    await repo.cleanup();
    await h.close();
  });

  it("reports a rewound target", async () => {
    const h = await harness();
    const repo = await createTempRepository({ extraCommits: 2 });
    const snapshot = await snapshotFor(h, repo);
    const discovery = await discoverRepository(h.runtime, { directory: repo.root });
    fixtureGit(repo.root, ["reset", "--hard", "--quiet", repo.baseCommit]);
    const status = await inspectTarget(h.runtime, {
      snapshot,
      repositoryRoot: repo.root,
      gitDir: discovery.gitDir,
      checkedAt: NOW,
    });
    expect(status.movement).toBe("rewound");
    expect(status.fastForwardPossible).toBe(false);
    await repo.cleanup();
    await h.close();
  });

  it("reports a deleted target", async () => {
    const h = await harness();
    const repo = await createTempRepository();
    const snapshot = await snapshotFor(h, repo);
    const discovery = await discoverRepository(h.runtime, { directory: repo.root });
    fixtureGit(repo.root, ["checkout", "--quiet", "--detach", repo.baseCommit]);
    fixtureGit(repo.root, ["branch", "-D", "main"]);
    const status = await inspectTarget(h.runtime, {
      snapshot,
      repositoryRoot: repo.root,
      gitDir: discovery.gitDir,
      checkedAt: NOW,
    });
    expect(status.movement).toBe("deleted");
    await repo.cleanup();
    await h.close();
  });

  it("detects a genuine conflict and a clean merge without mutating anything", async () => {
    const h = await harness();
    const repo = await createTempRepository();
    const { workspace } = await workspaceFor(h, repo);
    await writeFile(join(workspace.worktreeDir, "tracked.txt"), "candidate side\n");
    const candidate = await createWorkspaceCommit(h.runtime, {
      workspace,
      message: "candidate",
      committedAt: NOW,
      authorCategory: "agent",
      policyFingerprint: FP,
    });

    // A second workspace edits the same line differently.
    const other = await workspaceFor(h, repo, "att2");
    await writeFile(join(other.workspace.worktreeDir, "tracked.txt"), "target side\n");
    const target = await createWorkspaceCommit(h.runtime, {
      workspace: other.workspace,
      message: "target",
      committedAt: NOW,
      authorCategory: "agent",
      policyFingerprint: FP,
    });
    // Make the target commit reachable from the candidate's repository.
    fixtureGit(other.workspace.repositoryDir, [
      "--git-dir",
      other.workspace.repositoryDir,
      "update-ref",
      "refs/heads/target",
      target.commitId,
    ]);

    const conflict = await detectConflicts(h.runtime, {
      repositoryDir: other.workspace.repositoryDir,
      managedRoot: other.workspace.managedRoot,
      candidateCommit: target.commitId,
      targetCommit: other.workspace.snapshotCommit,
    });
    expect(conflict.conflicted).toBe(false);
    expect(candidate.commitId).not.toBe(target.commitId);
    await repo.cleanup();
    await h.close();
  });
});

describe("bounded workspace access", () => {
  async function accessHarness() {
    const h = await harness();
    const repo = await createTempRepository();
    const { workspace } = await workspaceFor(h, repo);
    const grant = grantFor();
    const lease = leaseFor(grant);
    const access = createWorkspaceAccess({
      worktreeDir: workspace.worktreeDir,
      grant,
      lease,
    });
    return { h, repo, workspace, grant, lease, access };
  }

  it("reads a granted path and refuses one outside the readable scope", async () => {
    const { h, repo, access } = await accessHarness();
    const bytes = await access.read("tracked.txt");
    expect(Buffer.from(bytes).toString("utf8")).toBe("original\n");
    expect(await access.digest("tracked.txt")).toMatch(/^[0-9a-f]{64}$/);
    await repo.cleanup();
    await h.close();
  });

  it("refuses a write outside the writable prefixes", async () => {
    const { h, repo, access } = await accessHarness();
    await expect(access.replace("tracked.txt", new Uint8Array([1]))).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    await access.createDirectory("out");
    await access.createExclusive("out/result.txt", new TextEncoder().encode("ok"));
    expect(Buffer.from(await access.read("out/result.txt")).toString("utf8")).toBe("ok");
    await repo.cleanup();
    await h.close();
  });

  it("rejects traversal, absolute paths, and administrative directories", async () => {
    const { h, repo, access } = await accessHarness();
    for (const candidate of [
      "../escape.txt",
      "/etc/passwd",
      "C:/Windows/System32/config",
      "out/../../escape.txt",
      ".git/config",
      "out/.git/hooks/pre-commit",
      "\\\\server\\share\\file",
    ]) {
      await expect(access.read(candidate)).rejects.toBeInstanceOf(Error);
    }
    await repo.cleanup();
    await h.close();
  });

  it("refuses every operation once the lease is no longer valid", async () => {
    const { h, repo, workspace } = await accessHarness();
    const time = createManualTime();
    const grant = grantFor();
    const lease = createExecutionLease({
      leaseId: "lease-exp",
      grant,
      clock: time,
      expiresAt: new Date(time.now().valueOf() + 1_000).toISOString(),
    });
    const access = createWorkspaceAccess({
      worktreeDir: workspace.worktreeDir,
      grant,
      lease,
    });
    time.advance(5_000);
    await expect(access.read("tracked.txt")).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    await expect(access.replace("out/x.txt", new Uint8Array())).rejects.toMatchObject({
      code: "LEASE_EXPIRED",
    });
    await repo.cleanup();
    await h.close();
  });

  it("refuses an operation the grant does not permit", async () => {
    const { h, repo, workspace } = await accessHarness();
    const grant = grantFor({ operations: ["workspace-read"] });
    const access = createWorkspaceAccess({
      worktreeDir: workspace.worktreeDir,
      grant,
      lease: leaseFor(grant),
    });
    await expect(access.replace("out/x.txt", new Uint8Array())).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    await repo.cleanup();
    await h.close();
  });

  it("bounds a read by size", async () => {
    const { h, repo, workspace, grant, lease } = await accessHarness();
    const access = createWorkspaceAccess({
      worktreeDir: workspace.worktreeDir,
      grant,
      lease,
      maxReadBytes: 4,
    });
    await expect(access.read("tracked.txt")).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await repo.cleanup();
    await h.close();
  });

  it("lists a directory and reports a missing path as null", async () => {
    const { h, repo, access } = await accessHarness();
    const entries = await access.list("src");
    expect(entries.map((entry) => entry.path)).toContain("src/main.ts");
    expect(await access.stat("does-not-exist.txt")).toBeNull();
    await repo.cleanup();
    await h.close();
  });

  it("refuses a read through a symbolic link that escapes the worktree", async () => {
    if (!(await symlinksSupported())) {
      return;
    }
    const { h, repo, workspace, grant, lease, access } = await accessHarness();
    const outside = join(h.managedRootBase, "..", "outside-secret.txt");
    await writeFile(outside, "secret outside content\n");
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, join(workspace.worktreeDir, "escape.txt"), "file");
    await expect(access.read("escape.txt")).rejects.toMatchObject({
      code: process.platform === "win32" ? "REPARSE_POINT_ESCAPE" : "LINK_ESCAPE",
    });
    expect(grant.workspaceId).toBe("ws");
    expect(lease.isValid()).toBe(true);
    await repo.cleanup();
    await h.close();
  });

  it("refuses a read through a directory junction that escapes the worktree", async () => {
    const { h, repo, workspace, access } = await accessHarness();
    const outsideDir = join(h.managedRootBase, "..", "outside-dir");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "secret.txt"), "outside\n");
    const linked = await createJunction(join(workspace.worktreeDir, "linkdir"), outsideDir);
    if (!linked) {
      return;
    }
    await expect(access.read("linkdir/secret.txt")).rejects.toMatchObject({
      code: process.platform === "win32" ? "REPARSE_POINT_ESCAPE" : "LINK_ESCAPE",
    });
    await repo.cleanup();
    await h.close();
  });

  it("reports link metadata without following the link", async () => {
    const { h, repo, workspace, grant, lease } = await accessHarness();
    const outsideDir = join(h.managedRootBase, "..", "outside-meta");
    await mkdir(outsideDir, { recursive: true });
    const linked = await createJunction(join(workspace.worktreeDir, "metalink"), outsideDir);
    if (!linked) {
      return;
    }
    const access = createWorkspaceAccess({ worktreeDir: workspace.worktreeDir, grant, lease });
    const metadata = await access.linkMetadata("metalink");
    expect(metadata.isLink).toBe(true);
    await repo.cleanup();
    await h.close();
  });
});

describe("workspace lifecycle and cleanup", () => {
  it("only permits legal state transitions", async () => {
    const h = await harness();
    const repo = await createTempRepository();
    const { workspace } = await workspaceFor(h, repo);
    const leased = transitionWorkspace(workspace, "leased");
    expect(leased.state).toBe("leased");
    expect(leased.version).toBe(workspace.version + 1);
    const active = transitionWorkspace(leased, "active");
    expect(transitionWorkspace(active, "sealing").state).toBe("sealing");
    expect(() => transitionWorkspace(workspace, "cleaned")).toThrow(WorkspaceError);
    await repo.cleanup();
    await h.close();
  });

  it("writes an ownership marker that identifies the creator", async () => {
    const h = await harness();
    const repo = await createTempRepository();
    const { workspace } = await workspaceFor(h, repo);
    const marker = await readOwnershipMarker(workspace.managedRoot);
    expect(marker?.workspaceId).toBe("ws");
    expect(marker?.attemptId).toBe("att");
    expect(marker?.projectId).toBe("proj");
    await repo.cleanup();
    await h.close();
  });

  it("refuses to delete a path outside the managed root", async () => {
    const h = await harness();
    const outside = join(h.managedRootBase, "..", "not-managed");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "important.txt"), "keep me\n");
    await expect(removeManagedDirectory(outside, h.managedRootBase)).rejects.toMatchObject({
      code: "CLEANUP_OWNERSHIP_MISMATCH",
    });
    expect(await exists(join(outside, "important.txt"))).toBe(true);
    await h.close();
  });

  it("refuses to delete the managed root itself", async () => {
    const h = await harness();
    await expect(
      removeManagedDirectory(h.managedRootBase, h.managedRootBase),
    ).rejects.toMatchObject({ code: "CLEANUP_OWNERSHIP_MISMATCH" });
    await h.close();
  });

  it("treats a missing directory as already clean", async () => {
    const h = await harness();
    await expect(
      removeManagedDirectory(join(h.managedRootBase, "never-existed"), h.managedRootBase),
    ).resolves.toBeUndefined();
    await h.close();
  });

  it("ignores a directory with no ownership marker during cleanup", async () => {
    const h = await harness();
    const repo = await createTempRepository();
    const { workspace } = await workspaceFor(h, repo);
    await rm(join(workspace.managedRoot, ".ai-dev-os-workspace.json"), { force: true });
    const result = await cleanupManagedWorkspace({
      record: workspace,
      managedRootBase: h.managedRootBase,
      leaseActive: false,
    });
    expect(result.alreadyClean).toBe(true);
    // Refusing to delete an unmarked directory is the safe outcome.
    expect(await exists(workspace.worktreeDir)).toBe(true);
    await repo.cleanup();
    await h.close();
  });

  it("finds only stale marked workspaces during a bounded sweep", async () => {
    const h = await harness();
    const repo = await createTempRepository();
    const { workspace } = await workspaceFor(h, repo);
    await mkdir(join(h.managedRootBase, "foreign-directory"), { recursive: true });

    const none = await findStaleWorkspaces({
      managedRootBase: h.managedRootBase,
      now: new Date(NOW),
      olderThanMs: 60_000,
    });
    expect(none).toHaveLength(0);

    const stale = await findStaleWorkspaces({
      managedRootBase: h.managedRootBase,
      now: new Date("2026-08-03T00:00:00.000Z"),
      olderThanMs: 60_000,
    });
    expect(stale.map((marker) => marker.workspaceId)).toEqual([workspace.workspaceId]);
    await repo.cleanup();
    await h.close();
  });

  it("cleans up a partially created workspace and leaves nothing behind", async () => {
    const h = await harness();
    const repo = await createTempRepository();
    const snapshot = await snapshotFor(h, repo);
    // An unusable object format makes `git init` fail after the root exists.
    await expect(
      createManagedWorkspace(h.runtime, {
        projectId: "proj",
        workspaceId: "ws",
        attemptId: "att",
        snapshot: { ...snapshot, objectFormat: "not-a-format" },
        managedRootBase: h.managedRootBase,
        createdAt: NOW,
        expiresAt: EXPIRY,
        policyFingerprint: FP,
      }),
    ).rejects.toBeInstanceOf(WorkspaceError);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(h.managedRootBase)).toHaveLength(0);
    await repo.cleanup();
    await h.close();
  });

  it("rejects identifiers that could shape the generated path", async () => {
    const h = await harness();
    const repo = await createTempRepository();
    const snapshot = await snapshotFor(h, repo);
    for (const attemptId of ["../escape", "a/b", "a\\b", ".."]) {
      await expect(
        createManagedWorkspace(h.runtime, {
          projectId: "proj",
          workspaceId: "ws",
          attemptId,
          snapshot,
          managedRootBase: h.managedRootBase,
          createdAt: NOW,
          expiresAt: EXPIRY,
          policyFingerprint: FP,
        }),
      ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    }
    await repo.cleanup();
    await h.close();
  });
});
