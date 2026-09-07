import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Packs the production dependency closure and starts the installed child with
// the installed, hash-pinned Node executable. No source-workspace imports or
// Electron ABI rebuild can satisfy this proof.
const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url))), repository = resolve(appRoot, "../..");
const pin = JSON.parse(await readFile(join(appRoot, "runtime-pin.json"), "utf8"));
if (process.platform !== pin.platform || process.arch !== pin.arch || process.versions.node !== pin.nodeVersion) throw new Error("PACKED_RUNTIME_REQUIRES_PINNED_WINDOWS_NODE");
const npm = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
await access(npm);
const fixture = await mkdtemp(join(tmpdir(), "saved-packed-runtime-")), tarballs = join(fixture, "tarballs"), consumer = join(fixture, "consumer");
await mkdir(tarballs); await mkdir(consumer);
let controller = null, drained = true, totalBytes = 0;
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function run(args, cwd, timeoutMs = 180000) {
  const child = spawn(process.execPath, [npm, ...args], { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "", timedOut = false;
  child.stdout.on("data", (chunk) => { out += chunk; if (out.length > 2_000_000) child.kill(); });
  child.stderr.on("data", (chunk) => { err = `${err}${chunk}`.slice(-16000); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  const code = await new Promise((finish, fail) => { child.once("error", fail); child.once("close", finish); }).finally(() => clearTimeout(timer));
  if (code !== 0 || timedOut) { drained = false; throw new Error(`PACKED_NPM_FAILED ${args[0]}: ${err.slice(-4000)}`); }
  return out;
}
async function size(root) {
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name), stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error("PACKED_FIXTURE_LINK_REFUSED");
    bytes += stat.isDirectory() ? await size(path) : stat.size;
  }
  return bytes;
}
try {
  const manifests = new Map();
  for (const group of ["packages", "apps"]) for (const entry of await readdir(join(repository, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(repository, group, entry.name);
    try { const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8")); manifests.set(manifest.name, { manifest, path }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const closure = new Map();
  function include(name) {
    if (closure.has(name)) return;
    const item = manifests.get(name); if (item === undefined) throw new Error("PACKED_FIRST_PARTY_MISSING");
    closure.set(name, item);
    for (const dependency of Object.keys(item.manifest.dependencies ?? {})) if (dependency.startsWith("@ai-dev-os/")) include(dependency);
  }
  include("@ai-dev-os/desktop-shell");
  const dependencies = {}, packed = [];
  for (const [name] of [...closure].sort(([a], [b]) => a.localeCompare(b))) {
    const [report] = JSON.parse(await run(["pack", "--workspace", name, "--ignore-scripts", "--json", "--pack-destination", tarballs], repository));
    if (report.name !== name || !report.files.some((file) => file.path.startsWith("dist/"))) throw new Error("PACKED_CONTENT_MISSING");
    if (name === "@ai-dev-os/desktop-shell" && !report.files.some((file) => file.path === `.runtime/node-${pin.nodeVersion}-${pin.platform}-${pin.arch}/node.exe`)) throw new Error("PACKED_RUNTIME_BINARY_MISSING");
    const path = join(tarballs, report.filename);
    dependencies[name] = `file:${path.replaceAll("\\", "/")}`;
    packed.push({ name, bytes: (await lstat(path)).size, sha256: sha(await readFile(path)) });
  }
  const lock = JSON.parse(await readFile(join(repository, "package-lock.json"), "utf8"));
  const overrides = {};
  for (const { manifest, path: workspacePath } of closure.values()) for (const name of Object.keys(manifest.dependencies ?? {})) if (!name.startsWith("@ai-dev-os/")) {
    const workspace = relative(repository, workspacePath).replaceAll("\\", "/");
    const version = lock.packages[`${workspace}/node_modules/${name}`]?.version ?? lock.packages[`node_modules/${name}`]?.version;
    if (version === undefined) throw new Error(`PACKED_REGISTRY_PIN_MISSING:${manifest.name}:${name}`);
    if (overrides[name] !== undefined && overrides[name] !== version) throw new Error(`PACKED_REGISTRY_PIN_CONFLICT:${name}`);
    overrides[name] = version;
  }
  overrides.electron = "43.4.1";
  await writeFile(join(consumer, "package.json"), `${JSON.stringify({ name: "owned-saved-workflow-consumer", version: "0.0.0", private: true, type: "module", dependencies, overrides }, null, 2)}\n`, { flag: "wx" });
  await run(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"], consumer);
  await run(["rebuild", "better-sqlite3"], consumer);
  await run(["ls", "--all", "--json"], consumer);
  const installed = join(consumer, "node_modules", "@ai-dev-os", "desktop-shell");
  const { resolveOwnedNodeRuntime } = await import(pathToFileURL(join(installed, "dist/main/owned-runtime.js")).href);
  const { createOwnedServiceController } = await import(pathToFileURL(join(installed, "dist/service/controller.js")).href);
  const runtime = await resolveOwnedNodeRuntime(installed);
  assert.equal(sha(await readFile(runtime)), pin.sha256);
  assert.ok((await realpath(runtime)).startsWith(await realpath(consumer)));
  const repo = join(fixture, "reference-repository"); await mkdir(repo);
  const reviews = [];
  controller = createOwnedServiceController({ childPath: join(installed, "dist/service/child.js"), execPath: runtime, storageParent: join(fixture, "transport"), dataRoot: join(fixture, "saved"), initialMode: "normal",
    nativePlanning: async (request) => request.kind === "repository" ? repo : request.kind === "confirm" ? (reviews.push(request.review.action), true) : null });
  drained = false;
  await controller.start();
  const command = async (value) => { const result = await controller.planning({ kind: "command", command: value }); assert.equal(result.kind, "committed", result.reason ?? "unconfirmed"); return result.workspace.selected; };
  let project = await command({ kind: "create-project", commandId: "packed:create", name: "Packed saved project", objective: "Keep a local planning record", outcomes: ["Reopen the same planning record"], budgetMinorUnits: 0, currency: "GBP" });
  project = await command({ kind: "accept-brief", commandId: "packed:accept", projectId: project.projectId, candidateId: project.candidate.candidateId, candidateDigest: project.candidate.digest, expectedBriefVersion: 0 });
  project = await command({ kind: "save-plan", commandId: "packed:draft", projectId: project.projectId, expectedPlanVersion: 0, title: "Packed manual plan", tasks: [{ title: "Record a plan", objective: "Review an additional local report", acceptanceCriteria: ["The plan remains after reopening"] }], scope: "scope-expansion" });
  project = await command({ kind: "prepare-plan", commandId: "packed:prepare", projectId: project.projectId, expectedPlanVersion: project.plan.version });
  project = await command({ kind: "approve-scope", commandId: "packed:seal", projectId: project.projectId, expectedPlanVersion: project.plan.version });
  assert.equal(project.plan.state, "sealed"); assert.equal(project.approvals[0].state, "consumed");
  const priorPid = controller.ownedProcessIdForTest();
  await controller.terminateOwnedChildForTest(); await controller.retry();
  const reopened = await controller.planning({ kind: "snapshot", projectId: project.projectId });
  assert.deepEqual(reopened.selected, project); assert.notEqual(controller.ownedProcessIdForTest(), priorPid);
  await controller.stop(); drained = controller.ownedProcessIdForTest() === null;
  assert.equal(drained, true); assert.ok((await lstat(join(fixture, "saved", "planning.sqlite"))).size > 0);
  totalBytes = await size(fixture);
  if (totalBytes > 512 * 1024 * 1024) throw new Error("PACKED_FIXTURE_EXCEEDS_512_MIB_BOUND");
  process.stdout.write(`${JSON.stringify({ ok: true, packed, fixtureBytes: totalBytes, runtime: { node: pin.nodeVersion, abi: pin.modulesAbi, sha256: pin.sha256 }, proof: "installed pinned child: create/accept/draft/atomic scope seal/restart/exact durable state", confirmations: reviews.length, credentials: false, taskExecution: false }, null, 2)}\n`);
} finally {
  if (controller !== null) { try { await controller.stop(); drained = controller.ownedProcessIdForTest() === null; } catch { drained = false; } }
  const exact = await realpath(fixture), parent = await realpath(tmpdir());
  if (drained && dirname(exact).toLowerCase() === parent.toLowerCase() && exact.toLowerCase().startsWith(join(parent, "saved-packed-runtime-").toLowerCase()) && !(await lstat(fixture)).isSymbolicLink()) await rm(exact, { recursive: true });
  else process.stderr.write(`PACKED_FIXTURE_PRESERVED ${exact}\n`);
}
