"use strict";

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const npmExecPath = process.env["npm_execpath"];
if (typeof npmExecPath !== "string" || !/npm-cli\.js$/u.test(npmExecPath.replaceAll("\\", "/"))) {
  throw new Error("Invoke the intake packed-consumer gate through its npm script.");
}

function npm(args, cwd) {
  const result = spawnSync(process.execPath, [npmExecPath, ...args], {
    cwd,
    shell: false,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`npm command exited ${String(result.status)}: ${String(result.stderr).slice(-2_000)}`);
  }
  return result.stdout;
}

const packages = Object.freeze([
  Object.freeze({ name: "@ai-dev-os/domain", directory: "packages/domain" }),
  Object.freeze({ name: "@ai-dev-os/artifacts", directory: "packages/artifacts" }),
  Object.freeze({ name: "@ai-dev-os/persistence", directory: "packages/persistence" }),
  Object.freeze({ name: "@ai-dev-os/project", directory: "packages/project" }),
  Object.freeze({ name: "@ai-dev-os/intake", directory: "packages/intake" }),
]);

const workRoot = mkdtempSync(join(tmpdir(), "ai-dev-os-intake-packed-consumer-"));
try {
  const packRoot = join(workRoot, "pack");
  const consumerRoot = join(workRoot, "consumer");
  mkdirSync(packRoot);
  mkdirSync(consumerRoot);
  const dependencies = {};
  let totalFiles = 0;
  for (const definition of packages) {
    const root = resolve(repositoryRoot, definition.directory);
    if (!existsSync(join(root, "dist", "index.js"))) throw new Error(`${definition.name} has no built entry.`);
    const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", packRoot], root));
    if (!Array.isArray(packed) || packed.length !== 1) throw new Error(`Unexpected pack result for ${definition.name}.`);
    const description = packed[0];
    if (description.name !== definition.name || typeof description.filename !== "string") {
      throw new Error(`Unexpected package identity for ${definition.name}.`);
    }
    const paths = description.files.map((entry) => String(entry.path));
    const unexpected = paths.filter((path) => path !== "package.json" && path !== "README.md" && !path.startsWith("dist/"));
    if (unexpected.length !== 0 || !paths.includes("dist/index.js") || !paths.includes("dist/index.d.ts")) {
      throw new Error(`${definition.name} tarball violates the bounded file policy.`);
    }
    const tarball = resolve(packRoot, description.filename);
    if (!existsSync(tarball)) throw new Error(`Missing tarball for ${definition.name}.`);
    dependencies[definition.name] = `file:${tarball.replaceAll("\\", "/")}`;
    totalFiles += paths.length;
  }
  writeFileSync(join(consumerRoot, "package.json"), `${JSON.stringify({
    name: "intake-packed-consumer",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies,
  }, null, 2)}\n`);
  writeFileSync(join(consumerRoot, "probe.mjs"), `
    import {
      INTAKE_AVAILABLE_COMMANDS,
      INTAKE_PRODUCTION_ENABLED,
      INTAKE_RUNTIME_CAPABILITIES,
      assembleCandidate,
      intakeSha256,
      intakeStateView,
    } from "@ai-dev-os/intake";
    const operator = Object.freeze({source:"operator-supplied",acceptedByOperator:true});
    const text = (value) => Object.freeze({value,provenance:operator});
    const candidate = assembleCandidate({
      projectId:"prj:packed-intake",
      objective:text("Build the packed intake probe."),
      outcomes:[text("Return a valid candidate.")],
      nonGoals:[],
      audiences:[text("Packed consumers.")],
      constraints:[],
      assumptions:[],
      openQuestions:[],
      sourceThreadId:null,
    }, intakeSha256);
    const view = intakeStateView({state:"ready",questionCount:0,blockingCount:0,candidateDigest:candidate.candidateDigest,diagnosticRule:null,canonicalRoot:null}, "normal");
    if (!candidate.ready || !/^[a-f0-9]{64}$/.test(candidate.candidateDigest)) process.exit(1);
    if (INTAKE_PRODUCTION_ENABLED !== false || INTAKE_AVAILABLE_COMMANDS.length !== 0 || INTAKE_RUNTIME_CAPABILITIES.length !== 0) process.exit(1);
    if (view.authority !== "none" || view.commands.length !== 0 || "developer" in view) process.exit(1);
  `);
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumerRoot);
  npm(["ls", "--all"], consumerRoot);
  const probe = spawnSync(process.execPath, [join(consumerRoot, "probe.mjs")], {
    cwd: consumerRoot,
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (probe.status !== 0) throw new Error(`Packed intake probe exited ${String(probe.status)}.`);
  process.stdout.write(`INTAKE-PACKED-CONSUMER: PASS\npackages=${String(packages.length)}\nfiles=${String(totalFiles)}\nruntimeDependencies=2\n`);
} finally {
  const resolved = resolve(workRoot);
  const expectedPrefix = resolve(tmpdir(), "ai-dev-os-intake-packed-consumer-");
  if (!resolved.startsWith(expectedPrefix)) throw new Error("Refusing to clean an unowned intake consumer root.");
  rmSync(resolved, { recursive: true, force: true });
}
