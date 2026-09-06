import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertForbiddenTestingControls, inspectProductionGraph } from "./import-graph.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const npmExecPath = process.env["npm_execpath"];
if (typeof npmExecPath !== "string" || !/npm-cli\.js$/u.test(npmExecPath.replaceAll("\\", "/"))) throw new Error("Invoke through npm.");
function npm(args, cwd) {
  const result = spawnSync(process.execPath, [npmExecPath, ...args], { cwd, shell: false, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`npm ${args[0]} exited ${result.status}: ${result.stderr.slice(-4000)}`);
  return result.stdout;
}
// Complete local runtime and declaration closure. Only pre-existing pinned
// third-party packages may be resolved; no unpublished package uses a registry.
const packages = ["domain", "artifacts", "persistence", "providers", "scheduler", "policy", "process-broker", "secrets", "project", "persistence-memory", "persistence-sqlite", "approval"];
const parent = realpathSync(tmpdir());
const workRoot = mkdtempSync(join(parent, "ai-dev-os-approval-packed-"));
try {
  const packRoot = join(workRoot, "pack"), consumerRoot = join(workRoot, "consumer");
  mkdirSync(packRoot); mkdirSync(consumerRoot);
  const dependencies = {}; let totalFiles = 0, totalBytes = 0;
  for (const directory of packages) {
    const name = `@ai-dev-os/${directory}`, root = join(repositoryRoot, "packages", directory);
    if (!existsSync(join(root, "dist/index.js"))) throw new Error(`${name} must be built first.`);
    const packed = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot], root));
    if (packed.length !== 1 || packed[0].name !== name) throw new Error("Unexpected tarball identity.");
    const description = packed[0], paths = description.files.map((entry) => entry.path);
    if (paths.some((p) => p !== "package.json" && p !== "README.md" && !p.startsWith("dist/"))
      || !paths.includes("dist/index.js") || !paths.includes("dist/index.d.ts")) throw new Error("Unbounded tarball inventory.");
    if (directory === "approval" && (!paths.includes("dist/testing/index.js") || !paths.includes("dist/testing/index.d.ts"))) throw new Error("Missing testing export.");
    const tarball = resolve(packRoot, description.filename);
    if (dirname(tarball) !== packRoot || !existsSync(tarball)) throw new Error("Tarball escaped its owned directory.");
    dependencies[name] = `file:${tarball.replaceAll("\\", "/")}`;
    totalFiles += paths.length; totalBytes += description.unpackedSize;
    if (totalFiles > 3000 || totalBytes > 50 * 1024 * 1024) throw new Error("Packed closure exceeds its bound.");
  }
  writeFileSync(join(consumerRoot, "package.json"), JSON.stringify({ name: "approval-packed-consumer", version: "1.0.0", private: true, type: "module", dependencies }, null, 2));
  writeFileSync(join(consumerRoot, "probe.mjs"), readFileSync(join(packageRoot, "scripts/packed-probe.mjs")));
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumerRoot);
  const lock = readFileSync(join(consumerRoot, "package-lock.json"), "utf8");
  if (/"link"\s*:\s*true|workspace:/u.test(lock)) throw new Error("Packed consumer has workspace links.");
  npm(["ls", "--all"], consumerRoot);
  const installed = join(consumerRoot, "node_modules/@ai-dev-os");
  const graph = inspectProductionGraph(join(installed, "approval"), join(installed, "project"));
  assertForbiddenTestingControls(join(installed, "approval"), join(installed, "project"));
  const native = join(consumerRoot, "node_modules/better-sqlite3/build/Release/better_sqlite3.node");
  if (existsSync(native)) throw new Error("Lifecycle ran despite scripts-disabled install.");
  npm(["rebuild", "better-sqlite3", "--foreground-scripts", "--ignore-scripts=false", "--no-audit", "--no-fund"], consumerRoot);
  if (!existsSync(native)) throw new Error("The explicit pinned SQLite lifecycle produced no binding.");
  const probe = spawnSync(process.execPath, [join(consumerRoot, "probe.mjs")], { cwd: consumerRoot, shell: false, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (probe.status !== 0) throw new Error(`Packed probe exited ${probe.status}: ${probe.stderr.slice(-4000)}`);
  process.stdout.write(probe.stdout);
  process.stdout.write(`APPROVAL-PACKED-CONSUMER: PASS\npackages=${packages.length}; files=${totalFiles}; bytes=${totalBytes}\nproductionGraphFiles=${graph.files.length}; staticEdges=${graph.staticEdges}; dynamicEdges=${graph.dynamicEdges}\nplantedControls=static,dynamic,indirect-dynamic\n`);
} finally {
  const target = realpathSync(workRoot), ownedName = relative(parent, target);
  if (dirname(target) !== parent || !/^ai-dev-os-approval-packed-[A-Za-z0-9]+$/u.test(ownedName)) throw new Error("Refusing cleanup outside the exact owned scratch directory.");
  rmSync(target, { recursive: true, force: true });
}
