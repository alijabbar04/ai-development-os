import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { collectRepositoryInspection, INTAKE_GIT_QUERIES, type IntakeFilesystemPort, type IntakeGitPort, type RepositoryInspectionReport } from "@ai-dev-os/intake";
import { refusePlanning } from "./planning-validation.js";

export interface PlanningRepositoryObservation {
  readonly schemaVersion: 1;
  readonly canonicalRoot: string;
  readonly observedAt: string;
  readonly grant: "native-folder-selection-read-only";
  readonly report: RepositoryInspectionReport;
}
const FILES = Object.freeze(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.toml", "pyproject.toml", "requirements.txt", "go.mod", "tsconfig.json"]);
function key(path: string): string { return process.platform === "win32" ? path.toLowerCase() : path; }
export function planningPathWithin(root: string, value: string): boolean {
  const part = relative(key(resolve(root)), key(resolve(value)));
  return part === "" || part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(part);
}
/** Reject links before resolving aliases; a Windows short-name alias may be
 * canonicalized, but a junction cannot enlarge the native folder's read grant. */
export async function canonicalPlanningDirectory(value: string, deadline = performance.now() + 10_000): Promise<string> {
  if (!isAbsolute(value) || value.includes("\0")) return refusePlanning("repository.root-invalid");
  if (process.platform === "win32" && (!/^[A-Za-z]:[\\/]/u.test(value) || value.slice(2).includes(":"))) return refusePlanning("repository.local-drive-required");
  let cursor = resolve(value), depth = 0;
  for (;;) {
    if (++depth > 128 || performance.now() >= deadline) return refusePlanning("repository.inspection-bound");
    const entry = await lstat(cursor);
    if (entry.isSymbolicLink() || !entry.isDirectory()) return refusePlanning("repository.link-refused");
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return await realpath(value);
}
export async function inspectPlanningRepository(selectedRoot: string, now: string): Promise<PlanningRepositoryObservation> {
  const deadline = performance.now() + 10_000, root = await canonicalPlanningDirectory(selectedRoot, deadline);
  const filesystem: IntakeFilesystemPort = { async inspect(input) {
    if (input.approvedRoot !== root) return refusePlanning("repository.grant-mismatch");
    return await Promise.all(input.relativePaths.map(async (relativePath) => {
      const path = join(root, relativePath);
      try {
        if (!FILES.includes(relativePath) || !planningPathWithin(root, path)) return refusePlanning("repository.path-refused");
        const stat = await lstat(path);
        const canonicalPath = await realpath(path);
        return Object.freeze({ relativePath, canonicalPath, kind: stat.isFile() ? "file" as const : "directory" as const, byteLength: stat.size,
          reparsePoint: stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1 || !planningPathWithin(root, canonicalPath), failureCode: null });
      } catch (error) {
        const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
        return Object.freeze({ relativePath, canonicalPath: null, kind: missing ? "missing" as const : "unavailable" as const, byteLength: 0, reparsePoint: false, failureCode: missing ? "not-found" as const : "io" as const });
      }
    }));
  } };
  // Read only bounded Git reference metadata. No Git executable, repository
  // configuration, hooks, index, object store, remote or credential file is read.
  // Work-tree status requires more authority/IO and is explicitly unavailable.
  async function readReference(relativePath: string, maximum: number): Promise<string> {
    const path = join(root, ".git", ...relativePath.split("/"));
    if (!planningPathWithin(join(root, ".git"), path)) return refusePlanning("repository.reference-escape");
    const parent = await canonicalPlanningDirectory(dirname(path), deadline);
    if (!planningPathWithin(root, parent)) return refusePlanning("repository.reference-escape");
    const before = await lstat(path), canonical = await realpath(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum || !planningPathWithin(root, canonical)) return refusePlanning("repository.reference-refused");
    const handle = await open(canonical, "r");
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.nlink !== 1) return refusePlanning("repository.reference-changed");
      const bytes = Buffer.alloc(maximum + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0), after = await handle.stat();
      if (bytesRead > maximum || after.size !== before.size || after.mtimeMs !== before.mtimeMs || await realpath(path) !== canonical || await canonicalPlanningDirectory(dirname(path), deadline) !== parent) return refusePlanning("repository.reference-changed");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)).trim();
    } finally { await handle.close(); }
  }
  let gitRoot: string | null = null, head: string | null = null, branch: string | null = null;
  try {
    const dotgit = await canonicalPlanningDirectory(join(root, ".git"), deadline);
    if (!planningPathWithin(root, dotgit)) return refusePlanning("repository.reference-escape");
    gitRoot = root;
    const sourceHead = await readReference("HEAD", 512);
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceHead)) head = sourceHead;
    else if (/^ref: refs\/heads\/[A-Za-z0-9_-][A-Za-z0-9._/-]{0,198}$/u.test(sourceHead)) {
      const reference = sourceHead.slice(5), leaf = reference.slice(11);
      if (reference.includes("..") || reference.includes("//") || reference.endsWith("/") || reference.split("/").some((part) => part.endsWith(".lock") || part.endsWith("."))) throw new Error();
      branch = leaf;
      try { const value = await readReference(reference, 128); if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) head = value; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const packed = await readReference("packed-refs", 65_536);
        const matches = packed.split(/\r?\n/u).filter((line) => line.endsWith(" " + reference));
        if (matches.length === 1 && /^(?:[a-f0-9]{40}|[a-f0-9]{64}) refs\/heads\//u.test(matches[0]!)) head = matches[0]!.split(" ")[0]!;
      }
    }
    if (await readReference("HEAD", 512) !== sourceHead) { head = null; branch = null; }
  } catch { head = null; /* A missing/unborn or unsafe reference remains unknown. */ }
  const git: IntakeGitPort = { async run(input) {
    const query = INTAKE_GIT_QUERIES.find((q) => JSON.stringify(q.args) === JSON.stringify(input.args));
    if (query === undefined || input.root !== root) return refusePlanning("repository.git-query-refused");
    const value = query.kind === "root" ? gitRoot : query.kind === "head" ? head : query.kind === "branch" ? branch : null;
    if (performance.now() >= input.deadlineAtMs) return { kind: query.kind, status: "unavailable", value: null, failureCode: "deadline" };
    return value === null ? { kind: query.kind, status: "unavailable", value: null, failureCode: gitRoot === null ? "not-repository" : query.kind === "head" ? "unborn-head" : query.kind === "branch" ? "detached" : "io" }
      : { kind: query.kind, status: "ok", value, failureCode: null };
  } };
  if (performance.now() >= deadline) return refusePlanning("repository.inspection-bound");
  const report = await collectRepositoryInspection({ approvedRoot: root, pathFlavor: process.platform === "win32" ? "windows" : "posix", relativePaths: FILES, maximumFiles: FILES.length, maximumBytes: 1_048_576, deadlineMs: Math.max(1, Math.floor(deadline - performance.now())), includeGit: true },
    { filesystem, git, clock: { nowMs: () => performance.now() } });
  if (report.rootLeaf !== basename(root)) return refusePlanning("repository.root-mismatch");
  return Object.freeze({ schemaVersion: 1, canonicalRoot: root, observedAt: now, grant: "native-folder-selection-read-only", report });
}
