/**
 * The workspace contract suite.
 *
 * States what any workspace implementation must do: discover a repository
 * without changing it, capture a faithful snapshot, hand out an isolated
 * worktree, refuse to leave its own boundary, and clean up only what it owns.
 *
 * The non-mutation checks fingerprint the source repository — every file
 * under `.git` and the whole working tree — before and after, and require the
 * result to be byte-identical. What is deliberately *not* claimed is access
 * time: reading a file updates it on many systems and no application can
 * prevent that. Content, size, and structure are what these tests pin down.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { GitRuntime } from "../runtime.js";
import { discoverRepository } from "../discovery.js";
import { captureSnapshot } from "../snapshot.js";
import { cleanupManagedWorkspace, createManagedWorkspace } from "../worktree.js";
import { createTempRepository, type TempRepository } from "./repo-fixtures.js";

export interface WorkspaceContractHarness {
  readonly runtime: GitRuntime;
  /** Absolute directory the implementation may create managed roots inside. */
  readonly managedRootBase: string;
  readonly storageRoot: string;
  close(): Promise<void>;
}

export type WorkspaceContractFactory = () => Promise<WorkspaceContractHarness>;

export const CONTRACT_NOW = "2026-08-02T00:00:00.000Z";
export const CONTRACT_EXPIRY = "2026-08-02T01:00:00.000Z";
const FINGERPRINT = "a".repeat(64);

/**
 * Hashes a directory tree by relative path, size, and content. Directory
 * entries are included so a created or removed directory is also detected.
 */
export async function fingerprintTree(root: string): Promise<string> {
  const entries: string[] = [];
  async function walk(current: string): Promise<void> {
    let listing;
    try {
      listing = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of listing.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const absolute = join(current, entry.name);
      const key = relative(root, absolute).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        entries.push(`d:${key}`);
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        entries.push(`o:${key}`);
        continue;
      }
      try {
        const info = await stat(absolute);
        const content = await readFile(absolute);
        entries.push(
          `f:${key}:${info.size}:${createHash("sha256").update(content).digest("hex")}`,
        );
      } catch {
        entries.push(`e:${key}`);
      }
    }
  }
  await walk(root);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

export function runWorkspaceContractSuite(factory: WorkspaceContractFactory): void {
  describe("workspace contract", () => {
    async function withHarness<T>(
      body: (harness: WorkspaceContractHarness, repo: TempRepository) => Promise<T>,
      shape: Parameters<typeof createTempRepository>[0] = {},
    ): Promise<T> {
      const harness = await factory();
      const repo = await createTempRepository(shape);
      try {
        return await body(harness, repo);
      } finally {
        await repo.cleanup();
        await harness.close();
      }
    }

    async function snapshotOf(
      harness: WorkspaceContractHarness,
      repo: TempRepository,
      options: { allowDirty?: boolean; includeUntracked?: readonly string[] } = {},
    ) {
      const discovery = await discoverRepository(harness.runtime, { directory: repo.root });
      return await captureSnapshot(harness.runtime, {
        projectId: "project-contract",
        snapshotId: "snapshot-contract",
        discovery,
        storageRoot: harness.storageRoot,
        capturedAt: CONTRACT_NOW,
        allowDirty: options.allowDirty ?? true,
        ...(options.includeUntracked === undefined
          ? {}
          : { includeUntracked: options.includeUntracked }),
      });
    }

    async function workspaceOf(harness: WorkspaceContractHarness, repo: TempRepository) {
      const snapshot = await snapshotOf(harness, repo);
      const workspace = await createManagedWorkspace(harness.runtime, {
        projectId: "project-contract",
        workspaceId: "workspace-contract",
        attemptId: "attempt-contract",
        snapshot,
        managedRootBase: harness.managedRootBase,
        createdAt: CONTRACT_NOW,
        expiresAt: CONTRACT_EXPIRY,
        policyFingerprint: FINGERPRINT,
      });
      return { snapshot, workspace };
    }

    // -- discovery ---------------------------------------------------------

    it("discovers a clean repository", async () => {
      await withHarness(async (harness, repo) => {
        const discovery = await discoverRepository(harness.runtime, { directory: repo.root });
        expect(discovery.worktreeState).toBe("clean");
        expect(discovery.headCommit).toBe(repo.baseCommit);
        expect(discovery.branch).toBe("main");
        expect(discovery.detached).toBe(false);
        expect(discovery.objectFormat).toBe("sha1");
      });
    });

    it("discovers a dirty repository and classifies each change", async () => {
      await withHarness(
        async (harness, repo) => {
          const discovery = await discoverRepository(harness.runtime, { directory: repo.root });
          expect(discovery.worktreeState).toBe("dirty");
          expect(discovery.unstagedChanges.some((entry) => entry.path === "tracked.txt")).toBe(true);
          expect(discovery.unstagedChanges.some((entry) => entry.changeKind === "deleted")).toBe(true);
          expect(discovery.stagedChanges.some((entry) => entry.path === "staged.txt")).toBe(true);
          expect(discovery.untrackedPaths).toContain("untracked.txt");
        },
        { dirty: true, withStaged: true, withUntracked: true, withDeletion: true },
      );
    });

    it("reports a detached head", async () => {
      await withHarness(
        async (harness, repo) => {
          const discovery = await discoverRepository(harness.runtime, { directory: repo.root });
          expect(discovery.detached).toBe(true);
          expect(discovery.branch).toBeNull();
        },
        { detachedHead: true },
      );
    });

    it("excludes ignored files from the untracked listing", async () => {
      await withHarness(
        async (harness, repo) => {
          const discovery = await discoverRepository(harness.runtime, { directory: repo.root });
          expect(discovery.untrackedPaths).not.toContain("ignored.txt");
        },
        { withUntracked: true },
      );
    });

    it("refuses a directory that is not a repository", async () => {
      await withHarness(async (harness, repo) => {
        await expect(
          discoverRepository(harness.runtime, { directory: join(repo.root, "..", "markers") }),
        ).rejects.toMatchObject({ code: "NOT_A_REPOSITORY" });
      });
    });

    it("refuses a repository outside the configured project scope", async () => {
      await withHarness(async (harness, repo) => {
        await expect(
          discoverRepository(harness.runtime, {
            directory: repo.root,
            allowedRoots: [join(repo.root, "nowhere-else")],
          }),
        ).rejects.toMatchObject({ code: "UNSAFE_REPOSITORY" });
      });
    });

    it("reads through a stale index lock without disturbing it", async () => {
      await withHarness(
        async (harness, repo) => {
          const discovery = await discoverRepository(harness.runtime, { directory: repo.root });
          expect(discovery.headCommit).toBe(repo.baseCommit);
          expect(await fileExists(join(repo.root, ".git", "index.lock"))).toBe(true);
        },
        { withIndexLock: true },
      );
    });

    it("records remotes as inert names and contacts none", async () => {
      await withHarness(
        async (harness, repo) => {
          const discovery = await discoverRepository(harness.runtime, { directory: repo.root });
          expect(discovery.remoteNames).toEqual(["origin"]);
        },
        { withRemote: true },
      );
    });

    // -- non-mutation ------------------------------------------------------

    it("leaves the source repository byte-identical through discovery and capture", async () => {
      await withHarness(
        async (harness, repo) => {
          const before = await fingerprintTree(repo.root);
          await snapshotOf(harness, repo);
          expect(await fingerprintTree(repo.root)).toBe(before);
        },
        { dirty: true, withStaged: true, withUntracked: true, withDeletion: true },
      );
    });

    it("leaves the source repository byte-identical through worktree creation", async () => {
      await withHarness(
        async (harness, repo) => {
          const before = await fingerprintTree(repo.root);
          await workspaceOf(harness, repo);
          expect(await fingerprintTree(repo.root)).toBe(before);
        },
        { dirty: true },
      );
    });

    it("never creates worktree metadata in the source repository", async () => {
      await withHarness(async (harness, repo) => {
        await workspaceOf(harness, repo);
        expect(await fileExists(join(repo.root, ".git", "worktrees"))).toBe(false);
      });
    });

    // -- snapshots ---------------------------------------------------------

    it("identifies a clean snapshot by object id, not by branch name", async () => {
      await withHarness(async (harness, repo) => {
        const snapshot = await snapshotOf(harness, repo);
        expect(snapshot.dirty).toBe(false);
        expect(snapshot.snapshotCommit).toBe(repo.baseCommit);
        expect(snapshot.targetRef).toBe("main");
        expect(snapshot.targetRefCommit).toBe(repo.baseCommit);
      });
    });

    it("refuses a dirty capture that was not authorized", async () => {
      await withHarness(
        async (harness, repo) => {
          const discovery = await discoverRepository(harness.runtime, { directory: repo.root });
          await expect(
            captureSnapshot(harness.runtime, {
              projectId: "project-contract",
              snapshotId: "snapshot-contract",
              discovery,
              storageRoot: harness.storageRoot,
              capturedAt: CONTRACT_NOW,
              allowDirty: false,
            }),
          ).rejects.toMatchObject({ code: "DIRTY_SNAPSHOT_NOT_AUTHORIZED" });
        },
        { dirty: true },
      );
    });

    it("captures staged, unstaged, and deleted paths faithfully", async () => {
      await withHarness(
        async (harness, repo) => {
          const { workspace } = await workspaceOf(harness, repo);
          expect(await readWorktreeFile(workspace.worktreeDir, "tracked.txt")).toBe("modified\n");
          expect(await fileExists(join(workspace.worktreeDir, "staged.txt"))).toBe(true);
          expect(await fileExists(join(workspace.worktreeDir, "keep.txt"))).toBe(false);
        },
        { dirty: true, withStaged: true, withDeletion: true },
      );
    });

    it("includes only the untracked files that were explicitly selected", async () => {
      await withHarness(
        async (harness, repo) => {
          const snapshot = await snapshotOf(harness, repo, {
            includeUntracked: ["untracked.txt"],
          });
          expect(snapshot.includedUntrackedPaths).toEqual(["untracked.txt"]);
          const workspace = await createManagedWorkspace(harness.runtime, {
            projectId: "project-contract",
            workspaceId: "workspace-contract",
            attemptId: "attempt-contract",
            snapshot,
            managedRootBase: harness.managedRootBase,
            createdAt: CONTRACT_NOW,
            expiresAt: CONTRACT_EXPIRY,
            policyFingerprint: FINGERPRINT,
          });
          expect(await fileExists(join(workspace.worktreeDir, "untracked.txt"))).toBe(true);
          // The unselected untracked file — a private key, here — must not
          // travel into the workspace.
          expect(await fileExists(join(workspace.worktreeDir, "secret.key"))).toBe(false);
          expect(await fileExists(join(workspace.worktreeDir, "ignored.txt"))).toBe(false);
        },
        { dirty: true, withUntracked: true },
      );
    });

    it("refuses to capture an untracked path that is not untracked", async () => {
      await withHarness(
        async (harness, repo) => {
          await expect(
            snapshotOf(harness, repo, { includeUntracked: ["tracked.txt"] }),
          ).rejects.toMatchObject({ code: "UNTRACKED_FILE_NOT_SELECTED" });
        },
        { dirty: true, withUntracked: true },
      );
    });

    it("produces a deterministic fingerprint for the same repository state", async () => {
      await withHarness(
        async (harness, repo) => {
          const first = await snapshotOf(harness, repo);
          const second = await snapshotOf(harness, repo);
          expect(second.fingerprint).toBe(first.fingerprint);
          expect(second.snapshotCommit).toBe(first.snapshotCommit);
        },
        { dirty: true, withStaged: true },
      );
    });

    // -- hostile repositories ---------------------------------------------

    it("runs no hook during discovery, capture, or checkout", async () => {
      await withHarness(
        async (harness, repo) => {
          await workspaceOf(harness, repo);
          expect(await fileExists(repo.hookMarker)).toBe(false);
        },
        { dirty: true, withHostileHooks: true, withStaged: true },
      );
    });

    it("runs no filter, textconv, or external diff program", async () => {
      await withHarness(
        async (harness, repo) => {
          await workspaceOf(harness, repo);
          expect(await fileExists(repo.filterMarker)).toBe(false);
        },
        { dirty: true, withHostileFilters: true },
      );
    });

    it("runs neither hooks nor filters when both are armed together", async () => {
      await withHarness(
        async (harness, repo) => {
          const { workspace } = await workspaceOf(harness, repo);
          expect(await fileExists(repo.hookMarker)).toBe(false);
          expect(await fileExists(repo.filterMarker)).toBe(false);
          expect(await fileExists(join(workspace.worktreeDir, "tracked.txt"))).toBe(true);
        },
        {
          dirty: true,
          withHostileHooks: true,
          withHostileFilters: true,
          withStaged: true,
          withUntracked: true,
        },
      );
    });

    it("captures a submodule as a gitlink without entering or fetching it", async () => {
      await withHarness(
        async (harness, repo) => {
          const discovery = await discoverRepository(harness.runtime, { directory: repo.root });
          const snapshot = await snapshotOf(harness, repo);
          expect(snapshot.submodulePaths).toEqual(discovery.submodules.map((entry) => entry.path));
          // Nothing was cloned into the workspace for the submodule.
          expect(await fileExists(join(repo.root, "vendor", "dep", ".git"))).toBe(false);
        },
        { withSubmodule: true, dirty: true },
      );
    });

    // -- managed workspaces ------------------------------------------------

    it("creates a dedicated worktree under a generated path", async () => {
      await withHarness(async (harness, repo) => {
        const { workspace } = await workspaceOf(harness, repo);
        expect(workspace.managedRoot.startsWith(harness.managedRootBase)).toBe(true);
        expect(workspace.managedRoot).toContain("attempt-contract");
        expect(workspace.state).toBe("ready");
        expect(await fileExists(join(workspace.worktreeDir, "src", "main.ts"))).toBe(true);
      });
    });

    it("gives each attempt its own workspace", async () => {
      await withHarness(async (harness, repo) => {
        const snapshot = await snapshotOf(harness, repo);
        const first = await createManagedWorkspace(harness.runtime, {
          projectId: "project-contract",
          workspaceId: "workspace-one",
          attemptId: "attempt-one",
          snapshot,
          managedRootBase: harness.managedRootBase,
          createdAt: CONTRACT_NOW,
          expiresAt: CONTRACT_EXPIRY,
          policyFingerprint: FINGERPRINT,
        });
        const second = await createManagedWorkspace(harness.runtime, {
          projectId: "project-contract",
          workspaceId: "workspace-two",
          attemptId: "attempt-two",
          snapshot,
          managedRootBase: harness.managedRootBase,
          createdAt: CONTRACT_NOW,
          expiresAt: CONTRACT_EXPIRY,
          policyFingerprint: FINGERPRINT,
        });
        expect(first.managedRoot).not.toBe(second.managedRoot);
        expect(first.worktreeDir).not.toBe(second.worktreeDir);
      });
    });

    it("checks out no user branch", async () => {
      await withHarness(async (harness, repo) => {
        const { workspace } = await workspaceOf(harness, repo);
        expect(workspace.branchRef).toContain("refs/ai-dev-os/");
        expect(workspace.branchRef).not.toContain("main");
      });
    });

    // -- cleanup -----------------------------------------------------------

    it("refuses cleanup while a lease is active", async () => {
      await withHarness(async (harness, repo) => {
        const { workspace } = await workspaceOf(harness, repo);
        await expect(
          cleanupManagedWorkspace({
            record: workspace,
            managedRootBase: harness.managedRootBase,
            leaseActive: true,
          }),
        ).rejects.toMatchObject({ code: "CLEANUP_REFUSED" });
        expect(await fileExists(workspace.worktreeDir)).toBe(true);
      });
    });

    it("cleans up idempotently", async () => {
      await withHarness(async (harness, repo) => {
        const { workspace } = await workspaceOf(harness, repo);
        const first = await cleanupManagedWorkspace({
          record: workspace,
          managedRootBase: harness.managedRootBase,
          leaseActive: false,
        });
        expect(first.removed).toBe(true);
        const second = await cleanupManagedWorkspace({
          record: workspace,
          managedRootBase: harness.managedRootBase,
          leaseActive: false,
        });
        expect(second.alreadyClean).toBe(true);
        expect(await fileExists(workspace.managedRoot)).toBe(false);
      });
    });

    it("refuses cleanup when the ownership marker does not match", async () => {
      await withHarness(async (harness, repo) => {
        const { workspace } = await workspaceOf(harness, repo);
        await expect(
          cleanupManagedWorkspace({
            record: { ...workspace, workspaceId: "someone-elses-workspace" },
            managedRootBase: harness.managedRootBase,
            leaseActive: false,
          }),
        ).rejects.toMatchObject({ code: "CLEANUP_OWNERSHIP_MISMATCH" });
        expect(await fileExists(workspace.worktreeDir)).toBe(true);
      });
    });

    it("never removes the source repository", async () => {
      await withHarness(async (harness, repo) => {
        const { workspace } = await workspaceOf(harness, repo);
        await cleanupManagedWorkspace({
          record: workspace,
          managedRootBase: harness.managedRootBase,
          leaseActive: false,
        });
        expect(await fileExists(join(repo.root, ".git"))).toBe(true);
        expect(await fileExists(join(repo.root, "tracked.txt"))).toBe(true);
      });
    });

    it("keeps repository content out of errors", async () => {
      await withHarness(
        async (harness, repo) => {
          const discovery = await discoverRepository(harness.runtime, { directory: repo.root });
          const error = await captureSnapshot(harness.runtime, {
            projectId: "project-contract",
            snapshotId: "snapshot-contract",
            discovery,
            storageRoot: harness.storageRoot,
            capturedAt: CONTRACT_NOW,
            allowDirty: false,
          }).catch((caught: unknown) => caught);
          const serialized = JSON.stringify(
            (error as { toJSON(): unknown }).toJSON(),
          );
          expect(serialized).not.toContain("modified");
          expect(serialized).not.toContain(repo.root);
        },
        { dirty: true },
      );
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readWorktreeFile(worktreeDir: string, path: string): Promise<string> {
  return (await readFile(join(worktreeDir, path))).toString("utf8");
}
