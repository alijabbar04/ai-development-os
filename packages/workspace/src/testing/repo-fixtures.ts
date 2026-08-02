/**
 * Temporary-repository fixtures.
 *
 * Every fixture is created in a controlled temporary directory outside the
 * project source tree, and every hostile fixture is a positive control: it
 * arms a real attack — a hook that writes a marker outside the workspace, a
 * filter that reads a canary, a submodule, a remote — so that a test proving
 * "no marker appeared" is proving the defence worked rather than that the
 * attack was never wired up.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface TempRepository {
  readonly root: string;
  /** Directory holding markers a hostile fixture would try to create. */
  readonly markerDir: string;
  readonly hookMarker: string;
  readonly filterMarker: string;
  readonly baseCommit: string;
  cleanup(): Promise<void>;
}

const created: string[] = [];

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  if (result.status !== 0) {
    throw new Error(`fixture git ${args[0] ?? ""} failed: ${result.stderr ?? ""}`);
  }
  return (result.stdout ?? "").trim();
}

export interface RepositoryShape {
  /** Leave uncommitted modifications in the working tree. */
  readonly dirty?: boolean;
  readonly withUntracked?: boolean;
  readonly withStaged?: boolean;
  readonly withDeletion?: boolean;
  readonly withHostileHooks?: boolean;
  readonly withHostileFilters?: boolean;
  readonly withSubmodule?: boolean;
  readonly withRemote?: boolean;
  readonly withIndexLock?: boolean;
  readonly detachedHead?: boolean;
  readonly withSymlink?: boolean;
  readonly extraCommits?: number;
}

export async function createTempRepository(shape: RepositoryShape = {}): Promise<TempRepository> {
  const base = await mkdtemp(join(tmpdir(), "adox-repo-"));
  created.push(base);
  const root = join(base, "source");
  const markerDir = join(base, "markers");
  await mkdir(root, { recursive: true });
  await mkdir(markerDir, { recursive: true });

  const hookMarker = join(markerDir, "hook-ran.txt");
  const filterMarker = join(markerDir, "filter-ran.txt");

  git(root, ["init", "--quiet", "--initial-branch=main", "."]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "core.autocrlf", "false"]);

  await writeFile(join(root, "tracked.txt"), "original\n");
  await writeFile(join(root, "keep.txt"), "keep\n");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.ts"), "export const value = 1;\n");
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  const baseCommit = git(root, ["rev-parse", "HEAD"]);

  for (let index = 0; index < (shape.extraCommits ?? 0); index += 1) {
    await writeFile(join(root, `extra-${index}.txt`), `extra ${index}\n`);
    git(root, ["add", "--all"]);
    git(root, ["commit", "--quiet", "-m", `extra ${index}`]);
  }

  if (shape.withHostileHooks === true) {
    await armHostileHooks(root, hookMarker);
  }
  if (shape.withHostileFilters === true) {
    await armHostileFilters(root, filterMarker);
  }
  if (shape.withRemote === true) {
    // A remote that would fail loudly if anything ever tried to contact it.
    git(root, ["remote", "add", "origin", "https://127.0.0.1:1/nonexistent.git"]);
  }
  if (shape.withSubmodule === true) {
    await armSubmodule(root);
  }
  if (shape.withSymlink === true) {
    await armSymlink(root, base);
  }
  if (shape.withStaged === true) {
    await writeFile(join(root, "staged.txt"), "staged\n");
    git(root, ["add", "staged.txt"]);
  }
  if (shape.dirty === true) {
    await writeFile(join(root, "tracked.txt"), "modified\n");
  }
  if (shape.withDeletion === true) {
    await rm(join(root, "keep.txt"));
  }
  if (shape.withUntracked === true) {
    await writeFile(join(root, "untracked.txt"), "untracked\n");
    await writeFile(join(root, "secret.key"), "PRIVATE KEY MATERIAL\n");
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "ignored\n");
  }
  if (shape.detachedHead === true) {
    git(root, ["checkout", "--quiet", "--detach", baseCommit]);
  }
  if (shape.withIndexLock === true) {
    // A stale lock left behind by a crashed Git. Reads must not care.
    await writeFile(join(root, ".git", "index.lock"), "");
  }

  // Building the fixture uses ordinary Git, which legitimately triggers the
  // hooks and filters that were just armed. Clearing the markers here means a
  // marker found later was written by the code under test, not by setup.
  // `assertHostileFixtureFires` is the positive control proving the armed
  // fixture still works after this reset.
  //
  // A helper spawned by setup can outlive the Git command that started it, so
  // the markers are cleared repeatedly until they stay absent. Without this
  // the tests are racy: a late write looks like a defence failure.
  await settleMarkers([hookMarker, filterMarker]);

  return {
    root,
    markerDir,
    hookMarker,
    filterMarker,
    baseCommit,
    async cleanup(): Promise<void> {
      await rm(base, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * Installs hooks for every event a snapshot or checkout could plausibly
 * trigger. Each writes a marker outside the repository.
 */
async function armHostileHooks(root: string, marker: string): Promise<void> {
  const hooks = join(root, ".git", "hooks");
  await mkdir(hooks, { recursive: true });
  const target = marker.replace(/\\/g, "/");
  const names = [
    "pre-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "post-checkout",
    "post-merge",
    "post-index-change",
    "pre-applypatch",
    "reference-transaction",
  ];
  for (const name of names) {
    // Both a shell form and a Windows form: whichever the platform honours,
    // the marker gets written if the hook ever runs.
    await writeFile(
      join(hooks, name),
      `#!/bin/sh\necho hook-executed > "${target}"\nexit 0\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(hooks, `${name}.cmd`),
      `@echo off\r\necho hook-executed > "${marker}"\r\n`,
    );
  }
}

/**
 * Arms clean, smudge, and textconv drivers plus a `.gitattributes` that
 * applies them to every path, and a fsmonitor and pager for good measure.
 */
async function armHostileFilters(root: string, marker: string): Promise<void> {
  const command =
    process.platform === "win32"
      ? `cmd /c echo filter-executed > "${marker}"`
      : `sh -c 'echo filter-executed > "${marker.replace(/\\/g, "/")}"'`;
  git(root, ["config", "filter.evil.clean", command]);
  git(root, ["config", "filter.evil.smudge", command]);
  git(root, ["config", "filter.evil.required", "false"]);
  git(root, ["config", "diff.evil.textconv", command]);
  git(root, ["config", "diff.external", command]);
  git(root, ["config", "core.fsmonitor", command]);
  git(root, ["config", "core.pager", command]);
  git(root, ["config", "core.editor", command]);
  git(root, ["config", "credential.helper", command]);
  git(root, ["config", "gpg.program", command]);
  git(root, ["config", "core.sshCommand", command]);
  git(root, ["config", "uploadpack.packObjectsHook", command]);
  await writeFile(join(root, ".gitattributes"), "* filter=evil diff=evil\n");
  git(root, ["add", ".gitattributes"]);
  git(root, ["commit", "--quiet", "-m", "attributes"]);
}

/** A real gitlink plus a hostile `.gitmodules`, without initializing it. */
async function armSubmodule(root: string): Promise<void> {
  const treeEntry = "160000 commit 0000000000000000000000000000000000000001\tvendor/dep";
  const tree = spawnSync("git", ["mktree"], {
    cwd: root,
    input: `${treeEntry}\n`,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (tree.status === 0) {
    git(root, ["read-tree", "--prefix=", (tree.stdout ?? "").trim()]);
  }
  await writeFile(
    join(root, ".gitmodules"),
    [
      '[submodule "dep"]',
      "\tpath = vendor/dep",
      "\turl = ../../../etc/passwd",
      "\tupdate = !touch /tmp/submodule-command-ran",
      "",
      '[submodule "escape"]',
      "\tpath = ../outside",
      "\turl = https://127.0.0.1:1/x.git",
      "",
    ].join("\n"),
  );
}

async function armSymlink(root: string, base: string): Promise<void> {
  const outside = join(base, "outside-target.txt");
  await writeFile(outside, "content outside the repository\n");
  const { symlink } = await import("node:fs/promises");
  try {
    await symlink(outside, join(root, "escape-link.txt"), "file");
  } catch {
    // Creating a symbolic link needs a privilege or developer mode on
    // Windows. Tests that require one skip when it is unavailable.
  }
}

/** True when this host can create symbolic links at all. */
export async function symlinksSupported(): Promise<boolean> {
  const base = await mkdtemp(join(tmpdir(), "adox-symlink-"));
  created.push(base);
  try {
    const { symlink, writeFile: write } = await import("node:fs/promises");
    await write(join(base, "target.txt"), "x");
    await symlink(join(base, "target.txt"), join(base, "link.txt"), "file");
    return true;
  } catch {
    return false;
  }
}

/** Creates a Windows directory junction. Returns false where unsupported. */
export async function createJunction(linkPath: string, targetPath: string): Promise<boolean> {
  if (process.platform !== "win32") {
    const { symlink } = await import("node:fs/promises");
    try {
      await symlink(targetPath, linkPath, "dir");
      return true;
    } catch {
      return false;
    }
  }
  const { symlink } = await import("node:fs/promises");
  try {
    // A junction needs no elevated privilege, unlike a symbolic link.
    await symlink(targetPath, linkPath, "junction");
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes marker files until they stop reappearing.
 *
 * A helper process started during setup may still be writing when the setup
 * call returns. Clearing once would leave a marker that a later assertion
 * would wrongly attribute to the code under test.
 */
async function settleMarkers(paths: readonly string[], attempts = 8): Promise<void> {
  let quietRounds = 0;
  for (let attempt = 0; attempt < attempts && quietRounds < 2; attempt += 1) {
    let sawAny = false;
    for (const path of paths) {
      try {
        const { access } = await import("node:fs/promises");
        await access(path);
        sawAny = true;
      } catch {
        // Absent, which is what we want.
      }
      await rm(path, { force: true });
    }
    quietRounds = sawAny ? 0 : quietRounds + 1;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  for (const path of paths) {
    await rm(path, { force: true });
  }
}

/**
 * Positive control for the hostile fixture.
 *
 * Runs an ordinary, unsanitized Git command against the repository and reports
 * whether the armed hook and filter actually executed. A suite that asserts
 * "no marker appeared" is only meaningful if this returns true, because
 * otherwise the attack was never live in the first place.
 */
export async function assertHostileFixtureFires(
  repository: TempRepository,
): Promise<{ readonly hookFired: boolean; readonly filterFired: boolean }> {
  await writeFile(join(repository.root, "control.txt"), "control\n");
  // Plain `git` with the ambient environment: nothing sanitized.
  try {
    git(repository.root, ["add", "control.txt"]);
    git(repository.root, ["commit", "--quiet", "-m", "control"]);
  } catch {
    // A hook that fails the commit is itself evidence the hook ran.
  }
  const { access } = await import("node:fs/promises");
  const exists = async (path: string): Promise<boolean> => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  };
  const result = {
    hookFired: await exists(repository.hookMarker),
    filterFired: await exists(repository.filterMarker),
  };
  await rm(repository.hookMarker, { force: true });
  await rm(repository.filterMarker, { force: true });
  return Object.freeze(result);
}

export async function cleanupAllFixtures(): Promise<void> {
  await Promise.allSettled(created.map((dir) => rm(dir, { recursive: true, force: true })));
  created.length = 0;
}

export { git as fixtureGit };
