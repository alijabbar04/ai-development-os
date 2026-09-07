import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { canonicalPlanningDirectory, inspectPlanningRepository, planningPathWithin } from "../src/planning-repository.js";
import { openPlanningStorage } from "../src/planning-storage.js";

const owned: string[] = [], at = "2026-09-07T19:00:00.000Z";
afterEach(async () => { for (const root of owned.splice(0)) { if (!resolve(root).startsWith(join(resolve(tmpdir()), "planning-boundary-"))) throw new Error("UNOWNED_FIXTURE"); await rm(root, { recursive: true, force: true }); } });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "planning-boundary-")); owned.push(root); const repo = join(root, "repo"); await mkdir(join(repo, ".git", "refs", "heads"), { recursive: true }); return { root, repo }; }
const headOf = (result: Awaited<ReturnType<typeof inspectPlanningRepository>>) => result.report.facts.find((fact) => fact.kind === "git-head")?.value;
it("observes bounded loose and packed references, detached HEAD, and manifest metadata without running repository configuration", async () => {
  const { repo } = await fixture();
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/topic/local\n");
  await writeFile(join(repo, ".git", "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${"b".repeat(40)} refs/heads/topic/local\n`);
  await writeFile(join(repo, "package.json"), '{"name":"owned-fixture"}');
  await writeFile(join(repo, ".git", "config"), "[core]\n fsmonitor = !echo invoked > canary-was-executed\n");
  const first = await inspectPlanningRepository(repo, at);
  expect(first.report.state).toBe("partial"); expect(headOf(first)).toBe("b".repeat(40));
  expect(first.report.facts).toContainEqual({ kind: "git-branch", value: "topic/local" });
  expect(first.report.unavailable.some((item) => item.source === "git")).toBe(true);
  await writeFile(join(repo, ".git", "HEAD"), `${"c".repeat(64)}\n`);
  expect(headOf(await inspectPlanningRepository(repo, at))).toBe("c".repeat(64));
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(repo, ".git", "refs", "heads", "main"), `${"d".repeat(40)}\n`);
  expect(headOf(await inspectPlanningRepository(repo, at))).toBe("d".repeat(40));
  await expect(access(join(repo, "canary-was-executed"))).rejects.toMatchObject({ code: "ENOENT" });
});
it.each([
  ["escape", "ref: refs/heads/../../outside\n", ""],
  ["invalid branch", "ref: refs/heads/topic.lock\n", ""],
  ["duplicate packed ref", "ref: refs/heads/main\n", `${"a".repeat(40)} refs/heads/main\n${"b".repeat(40)} refs/heads/main\n`],
  ["oversized packed refs", "ref: refs/heads/main\n", "x".repeat(65537)],
  ["invalid HEAD", "not-a-reference", ""],
] as const)("leaves an unsafe or ambiguous %s unknown", async (_name, head, packed) => {
  const { repo } = await fixture(); await writeFile(join(repo, ".git", "HEAD"), head); await writeFile(join(repo, ".git", "packed-refs"), packed);
  expect(headOf(await inspectPlanningRepository(repo, at))).toBeUndefined();
});
it("refuses selected junctions and linked Git metadata; never follows worktree gitdir pointers", async () => {
  const { root, repo } = await fixture(), outside = join(root, "outside"); await mkdir(outside);
  await writeFile(join(outside, "HEAD"), "e".repeat(40));
  await link(join(outside, "HEAD"), join(repo, ".git", "HEAD"));
  expect(headOf(await inspectPlanningRepository(repo, at))).toBeUndefined();
  const junction = join(root, "selected-link"); await symlink(repo, junction, "junction");
  await expect(inspectPlanningRepository(junction, at)).rejects.toMatchObject({ reason: "repository.link-refused" });
  const worktree = join(root, "worktree"); await mkdir(worktree); await writeFile(join(worktree, ".git"), `gitdir: ${outside}\n`);
  expect(headOf(await inspectPlanningRepository(worktree, at))).toBeUndefined();
  const linked = join(root, "linked"); await mkdir(linked); await symlink(outside, join(linked, ".git"), "junction");
  expect(headOf(await inspectPlanningRepository(linked, at))).toBeUndefined();
  expect(await readFile(join(outside, "HEAD"), "utf8")).toBe("e".repeat(40));
});
it("refuses invalid UTF-8 and oversized reference metadata and treats linked manifests as unavailable", async () => {
  const { root, repo } = await fixture();
  await writeFile(join(repo, ".git", "HEAD"), Buffer.from([255, 254, 0]));
  expect(headOf(await inspectPlanningRepository(repo, at))).toBeUndefined();
  await writeFile(join(repo, ".git", "HEAD"), "f".repeat(513));
  expect(headOf(await inspectPlanningRepository(repo, at))).toBeUndefined();
  await writeFile(join(root, "outside.json"), '{"secret":"owned-marker-not-read"}');
  await link(join(root, "outside.json"), join(repo, "package.json"));
  await expect(inspectPlanningRepository(repo, at)).rejects.toThrow("crossed a link or reparse boundary");
});
it("enforces local canonical roots, containment, and an already exhausted inspection deadline", async () => {
  const { root, repo } = await fixture();
  expect(planningPathWithin(root, repo)).toBe(true); expect(planningPathWithin(repo, root)).toBe(false);
  expect(planningPathWithin(repo, `${repo}-sibling`)).toBe(false);
  await expect(canonicalPlanningDirectory("relative/path")).rejects.toMatchObject({ reason: "repository.root-invalid" });
  await expect(canonicalPlanningDirectory(repo, performance.now() - 1)).rejects.toMatchObject({ reason: "repository.inspection-bound" });
  if (process.platform === "win32") await expect(canonicalPlanningDirectory("\\\\server\\share")).rejects.toMatchObject({ reason: "repository.local-drive-required" });
});
it("holds one OS-owned SQLite writer until close, and refuses database hard links", async () => {
  const { root } = await fixture(), data = join(root, "saved"), store = await openPlanningStorage(data);
  try { await expect(openPlanningStorage(data)).rejects.toMatchObject({ code: "EADDRINUSE" }); }
  finally { await store.close(); await store.close(); }
  const next = await openPlanningStorage(data); await next.close();
  await link(join(data, "planning.sqlite"), join(root, "unknown-database-link"));
  await expect(openPlanningStorage(data)).rejects.toThrow("PLANNING_DATABASE_LINK_REFUSED");
  await expect(openPlanningStorage("relative-root")).rejects.toThrow("PLANNING_DATA_ROOT_INVALID");
});
