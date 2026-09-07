import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll } from "vitest";

interface CommittedBlobFixture {
  readonly root: string;
  readonly target: string;
  readonly baseCommit: string;
  readonly sourceCommit: string;
  readonly beforeStatus: string;
  readonly git: (...args: readonly string[]) => string;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Real Git provisioning has its own bounded hook; assertions keep Vitest's 5s test budget. */
export function committedBlobFixture(fileName: "tracked.txt" | "source.txt", dirtyBytes: string) {
  let root: string | undefined;
  let parent: string | undefined;
  let fixture: CommittedBlobFixture | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  const git = (...args: readonly string[]): string => {
    if (root === undefined) throw new Error("Git fixture is not provisioned.");
    return execFileSync("git", args, {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 5_000,
    }).trim();
  };
  const assertOwnedRoot = async (): Promise<void> => {
    if (root === undefined || parent === undefined || !samePath(dirname(root), parent)) {
      throw new Error("Git fixture root is outside its canonical temporary parent.");
    }
    const observed = await lstat(root);
    if (!observed.isDirectory() || observed.isSymbolicLink() || !samePath(await realpath(root), resolve(root))) {
      throw new Error("Git fixture root is not a direct canonical directory.");
    }
  };
  beforeAll(() => {
    pending = (async () => {
      parent = await realpath(tmpdir());
      root = await mkdtemp(join(parent, "ai-dev-os-committed-blob-"));
      await assertOwnedRoot();
      git("init", "--quiet");
      git("config", "user.email", "manifest-test@example.invalid");
      git("config", "user.name", "Manifest Test");
      const target = join(root, fileName);
      await writeFile(target, "base\n", "utf8");
      git("add", fileName);
      git("commit", "--quiet", "-m", "base");
      const baseCommit = git("rev-parse", "HEAD");
      await writeFile(target, "source\n", "utf8");
      git("add", fileName);
      git("commit", "--quiet", "-m", "source");
      const sourceCommit = git("rev-parse", "HEAD");
      await writeFile(target, dirtyBytes, "utf8");
      const beforeStatus = git("status", "--porcelain=v1", "--untracked-files=all");
      fixture = { root, target, baseCommit, sourceCommit, beforeStatus, git };
    })();
    return pending;
  }, 10_000);
  afterAll(async () => {
    // A Vitest timeout does not cancel an async callback. Join it before removing its paths.
    await pending.catch(() => undefined);
    if (root !== undefined) {
      await assertOwnedRoot();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
  return (assertions: (value: CommittedBlobFixture) => Promise<void>): Promise<void> => {
    const running = Promise.resolve().then(async () => {
      if (fixture === undefined) throw new Error("Git fixture setup did not finish.");
      await assertions(fixture);
    });
    pending = running;
    return running;
  };
}
