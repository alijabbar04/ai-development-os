"use strict";

/**
 * AM-02 first-party hosted packed-consumer gate (orchestrator).
 *
 * Invoked by the dedicated `packed-consumer` CI job (and runnable the same
 * way in any future authorized environment) via the root npm script
 * `verify:packed-consumer`, AFTER `npm ci --ignore-scripts` and
 * `npm run build` have produced every workspace's `dist/`.
 *
 * What it proves, at the exact checked-out head:
 *   1. `npm pack` over the seven consumer-relevant workspaces yields tarballs
 *      containing ONLY `package.json`, `README.md`, and `dist/**` — no tests,
 *      no fixtures, no sources.
 *   2. A fresh, task-owned consumer directory can install exactly those
 *      tarballs with lifecycle scripts disabled, plus the lockfile-pinned
 *      registry dependencies, into a coherent dependency graph with zero
 *      high-severity audit findings.
 *   3. The documented production entry points import and behave correctly in
 *      the packed layout (see `probe.mjs`), including the pinned Account
 *      Manager reader protocol v2, explicit inactive-window semantics, the
 *      50%/70% borrowed hard caps, the Fable exclusion, and the fail-closed
 *      matrix — against bounded synthetic stores only.
 *
 * Deliberate boundaries: network use only through the npm CLI — the registry
 * fetch of the pinned dependencies plus the sanctioned better-sqlite3 rebuild,
 * whose install hook fetches that dependency's prebuilt native binding (the
 * same documented exception the `check` job carries); no secrets; no installed
 * Account Manager state; no publication (tarballs stay in the runner's
 * task-owned temp directory); no retry logic. Any mismatch or ambiguity exits
 * non-zero.
 *
 * The single lifecycle-script exception mirrors the repository's documented
 * CI policy: after the scripts-disabled install, exactly one explicit
 * `npm rebuild better-sqlite3` provisions that dependency's native binding,
 * because `@ai-dev-os/application` eagerly composes the SQLite adapter and a
 * real consumer cannot import the production root without it.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_SUPPORTED_READER_SHA256,
  NPM_AUDIT_ARGS,
  NPM_INSTALL_ARGS,
  NPM_LS_ARGS,
  NPM_REBUILD_BETTER_SQLITE3_ARGS,
  REPOSITORY_PACKAGES,
  buildConsumerManifest,
  normalizedReaderIdentity,
  npmPackArgs,
  renderEvidence,
  sha256Hex,
  validateTarballFileList,
} from "./lib.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..", "..", "..", "..");
const evidence = [];

function fail(message) {
  process.stderr.write(`AM02-PACKED-CONSUMER: FAIL — ${message}\n`);
  process.exit(1);
}

function boundedTail(text, limit = 4_000) {
  const value = String(text ?? "");
  return value.length <= limit ? value : value.slice(value.length - limit);
}

const rootManifestPath = join(repositoryRoot, "package.json");
if (!existsSync(rootManifestPath)) fail("repository root manifest not found");
const rootManifest = JSON.parse(readFileSync(rootManifestPath, "utf8"));
if (rootManifest.name !== "ai-dev-os") {
  fail("this script must run from the ai-dev-os repository root scripts entry");
}

const npmExecPath = process.env["npm_execpath"];
if (typeof npmExecPath !== "string" || !/npm-cli\.js$/.test(npmExecPath.replaceAll("\\", "/"))) {
  fail(
    "npm_execpath is not an npm CLI entry; invoke this gate via the root " +
      "`npm run verify:packed-consumer` script so npm is pinned to the runner's toolchain",
  );
}

function npm(args, cwd, { allowNonZero = false } = {}) {
  const result = spawnSync(process.execPath, [npmExecPath, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  if (result.error) {
    fail(`npm ${args.join(" ")} failed to spawn: ${String(result.error.message).slice(0, 200)}`);
  }
  if (!allowNonZero && result.status !== 0) {
    process.stderr.write(`--- npm ${args.join(" ")} (exit ${String(result.status)}) stderr tail ---\n`);
    process.stderr.write(`${boundedTail(result.stderr)}\n`);
    process.stderr.write(`--- stdout tail ---\n${boundedTail(result.stdout)}\n`);
    fail(`npm ${args.join(" ")} exited ${String(result.status)}`);
  }
  return result;
}

evidence.push(["environment.node", process.version]);
evidence.push(["environment.platform", `${process.platform}-${process.arch}`]);
evidence.push(["environment.npm", npm(["--version"], repositoryRoot).stdout.trim()]);

const workRoot = mkdtempSync(
  join(process.env["RUNNER_TEMP"] ?? tmpdir(), "ai-dev-os-packed-consumer-"),
);
const packDirectory = join(workRoot, "tarballs-out");
const consumerDirectory = join(workRoot, "consumer");
mkdirSync(packDirectory, { recursive: true });
mkdirSync(join(consumerDirectory, "tarballs"), { recursive: true });
mkdirSync(join(consumerDirectory, "reader"), { recursive: true });
evidence.push(["consumer.workRootKind", process.env["RUNNER_TEMP"] ? "runner-temp" : "os-temp"]);

// --------------------------------------------------------------------------
// 1. Pack the seven workspaces from the exact checked-out head.
// --------------------------------------------------------------------------

const tarballRelativePaths = {};
for (const definition of REPOSITORY_PACKAGES) {
  const distPath = join(repositoryRoot, definition.directory, "dist");
  if (!existsSync(distPath)) {
    fail(`${definition.name} has no dist/ — run \`npm run build\` before this gate`);
  }
  const packResult = npm(npmPackArgs(definition.name, packDirectory), repositoryRoot);
  let parsed;
  try {
    parsed = JSON.parse(packResult.stdout);
  } catch {
    fail(`npm pack for ${definition.name} did not produce JSON output`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    fail(`npm pack for ${definition.name} must describe exactly one tarball`);
  }
  const record = parsed[0];
  if (record.name !== definition.name || typeof record.filename !== "string") {
    fail(`npm pack for ${definition.name} described an unexpected package`);
  }
  const filePaths = Array.isArray(record.files)
    ? record.files.map((entry) => String(entry.path))
    : [];
  const policy = validateTarballFileList(filePaths);
  if (!policy.ok) {
    fail(
      `${definition.name} tarball contains undeclared payload: ` +
        policy.offending.slice(0, 10).join(", "),
    );
  }
  const tarballPath = join(packDirectory, record.filename);
  if (!existsSync(tarballPath)) fail(`packed tarball missing on disk: ${record.filename}`);
  const tarballBytes = readFileSync(tarballPath);
  const consumerRelative = `tarballs/${record.filename}`;
  copyFileSync(tarballPath, join(consumerDirectory, "tarballs", record.filename));
  tarballRelativePaths[definition.name] = consumerRelative;
  const shortName = definition.name.replace("@ai-dev-os/", "");
  evidence.push([`tarball.${shortName}.filename`, record.filename]);
  evidence.push([`tarball.${shortName}.entryCount`, String(record.entryCount ?? filePaths.length)]);
  evidence.push([`tarball.${shortName}.packedBytes`, String(record.size)]);
  evidence.push([`tarball.${shortName}.unpackedBytes`, String(record.unpackedSize)]);
  evidence.push([`tarball.${shortName}.shasum`, String(record.shasum)]);
  evidence.push([`tarball.${shortName}.sha256`, sha256Hex(tarballBytes)]);
}

// --------------------------------------------------------------------------
// 2. Assemble the fresh consumer (manifest, probe, pinned reader artifact).
// --------------------------------------------------------------------------

const manifest = buildConsumerManifest(tarballRelativePaths);
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(join(consumerDirectory, "package.json"), manifestText);
evidence.push(["consumer.manifest.sha256", sha256Hex(manifestText)]);

for (const fileName of ["probe.mjs", "lib.mjs"]) {
  copyFileSync(join(scriptDirectory, fileName), join(consumerDirectory, fileName));
}

const readerSourcePath = join(
  repositoryRoot,
  "packages",
  "application",
  "test",
  "fixtures",
  "account-manager-usage-reader.cjs",
);
const readerTargetPath = join(consumerDirectory, "reader", "account-manager-usage-reader.cjs");
copyFileSync(readerSourcePath, readerTargetPath);
const readerIdentity = normalizedReaderIdentity(readFileSync(readerTargetPath, "utf8"));
if (readerIdentity.sha256 !== EXPECTED_SUPPORTED_READER_SHA256) {
  fail(
    "the repository reader artifact does not match the pinned published reader " +
      `digest (${readerIdentity.sha256} != ${EXPECTED_SUPPORTED_READER_SHA256})`,
  );
}
evidence.push(["reader.normalizedBytes", String(readerIdentity.normalizedBytes)]);
evidence.push(["reader.sha256", readerIdentity.sha256]);

// --------------------------------------------------------------------------
// 3. Scripts-disabled install, single sanctioned rebuild, graph, audit.
// --------------------------------------------------------------------------

npm(NPM_INSTALL_ARGS, consumerDirectory);
const sqliteBindingPath = join(
  consumerDirectory,
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);
if (existsSync(sqliteBindingPath)) {
  fail("lifecycle scripts ran during the consumer install despite --ignore-scripts");
}
evidence.push(["consumer.install.lifecycleScriptsDisabled", "true"]);

npm(NPM_REBUILD_BETTER_SQLITE3_ARGS, consumerDirectory);
if (!existsSync(sqliteBindingPath)) {
  fail("the explicit better-sqlite3 rebuild did not produce its native binding");
}
evidence.push(["consumer.rebuild.betterSqlite3Binding", "present"]);

const lsResult = npm(NPM_LS_ARGS, consumerDirectory);
let lsParsed;
try {
  lsParsed = JSON.parse(lsResult.stdout);
} catch {
  fail("npm ls --all did not produce JSON output");
}
const declaredDependencyCount = Object.keys(lsParsed.dependencies ?? {}).length;
if (declaredDependencyCount !== Object.keys(manifest.dependencies).length) {
  fail(
    `npm ls reports ${String(declaredDependencyCount)} top-level dependencies; expected ` +
      String(Object.keys(manifest.dependencies).length),
  );
}
evidence.push(["consumer.ls.topLevelDependencies", String(declaredDependencyCount)]);

npm(NPM_AUDIT_ARGS, consumerDirectory);
evidence.push(["consumer.audit.highSeverity", "zero (exit 0)"]);

const lockPath = join(consumerDirectory, "package-lock.json");
if (!existsSync(lockPath)) fail("the consumer install produced no package-lock.json");
evidence.push(["consumer.lock.sha256", sha256Hex(readFileSync(lockPath))]);

// --------------------------------------------------------------------------
// 4. Run the probe inside the consumer.
// --------------------------------------------------------------------------

const probeResult = spawnSync(process.execPath, [join(consumerDirectory, "probe.mjs")], {
  cwd: consumerDirectory,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
});
if (probeResult.error) {
  fail(`the consumer probe failed to spawn: ${String(probeResult.error.message).slice(0, 200)}`);
}
let probeReport = null;
try {
  probeReport = JSON.parse(probeResult.stdout);
} catch {
  probeReport = null;
}
if (probeReport === null || !Array.isArray(probeReport.assertions)) {
  process.stderr.write(`--- probe stdout tail ---\n${boundedTail(probeResult.stdout)}\n`);
  process.stderr.write(`--- probe stderr tail ---\n${boundedTail(probeResult.stderr)}\n`);
  fail("the consumer probe did not produce its structured report");
}
for (const assertion of probeReport.assertions) {
  const detail = String(assertion.detail ?? "").replaceAll(/[\r\n]+/g, " ");
  evidence.push([
    `probe.${assertion.id}`,
    assertion.ok === true ? "ok" : `FAILED (${detail})`,
  ]);
}
evidence.push(["probe.total", String(probeReport.total)]);
evidence.push(["probe.failed", String(probeReport.failed)]);
if (probeResult.status !== 0 || probeReport.failed !== 0) {
  process.stderr.write(`${renderEvidence(evidence)}\n`);
  process.stderr.write(`--- probe stderr tail ---\n${boundedTail(probeResult.stderr)}\n`);
  fail(`the consumer probe reported ${String(probeReport.failed)} failed assertion(s)`);
}

// --------------------------------------------------------------------------
// 5. Deterministic evidence block.
// --------------------------------------------------------------------------

process.stdout.write("AM02-PACKED-CONSUMER-EVIDENCE\n");
process.stdout.write(`${renderEvidence(evidence)}\n`);
process.stdout.write("AM02-PACKED-CONSUMER: PASS\n");
process.exit(0);
