"use strict";

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmExecPath = process.env["npm_execpath"];
if (typeof npmExecPath !== "string" || !/npm-cli\.js$/u.test(npmExecPath.replaceAll("\\", "/"))) {
  throw new Error("Invoke the packed-consumer gate through the package npm script.");
}

function npm(args, cwd) {
  const result = spawnSync(process.execPath, [npmExecPath, ...args], { cwd, shell: false, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`npm command failed with status ${String(result.status)}: ${String(result.stderr).slice(-2000)}`);
  return result.stdout;
}

const workRoot = mkdtempSync(join(tmpdir(), "ai-dev-os-project-packed-consumer-"));
try {
  const packRoot = join(workRoot, "pack");
  const consumerRoot = join(workRoot, "consumer");
  mkdirSync(packRoot); mkdirSync(consumerRoot);
  const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", packRoot], packageRoot));
  if (!Array.isArray(packed) || packed.length !== 1) throw new Error("npm pack did not describe exactly one package.");
  const description = packed[0];
  const paths = description.files.map((entry) => String(entry.path));
  const unexpected = paths.filter((path) => path !== "package.json" && path !== "README.md" && !path.startsWith("dist/"));
  if (unexpected.length !== 0 || !paths.includes("dist/index.js") || !paths.includes("dist/index.d.ts")) throw new Error("The tarball file inventory violates the package boundary.");
  const tarball = join(packRoot, description.filename);
  if (!existsSync(tarball)) throw new Error("The described tarball does not exist.");
  writeFileSync(join(consumerRoot, "package.json"), `${JSON.stringify({ name: "project-packed-consumer", version: "1.0.0", private: true, type: "module", dependencies: { "@ai-dev-os/project": `file:${tarball.replaceAll("\\", "/")}` } }, null, 2)}\n`);
  writeFileSync(join(consumerRoot, "probe.mjs"), `
    import { PROJECT_PRODUCTION_ENABLED, PROJECT_RUNTIME_CAPABILITIES, parseProject } from "@ai-dev-os/project";
    const project = parseProject({schemaVersion:1,projectId:"prj:packed",revision:1,displayName:"Packed",repositoryRoots:["C:\\\\Projects\\\\Packed"],defaultBranch:null,dataClassification:"internal",permissionMode:"contained-default",budgetAccountId:"budget:packed",effectiveConfigDigest:"${"a".repeat(64)}",status:"active",createdAt:"2026-08-29T10:00:00.000Z",updatedAt:"2026-08-29T10:00:00.000Z"});
    if (PROJECT_PRODUCTION_ENABLED !== false || PROJECT_RUNTIME_CAPABILITIES.length !== 0 || project.projectId !== "prj:packed") process.exit(1);
  `);
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumerRoot);
  npm(["ls", "--all"], consumerRoot);
  const probe = spawnSync(process.execPath, [join(consumerRoot, "probe.mjs")], { cwd: consumerRoot, shell: false, encoding: "utf8" });
  if (probe.status !== 0) throw new Error(`Packed consumer probe failed with status ${String(probe.status)}.`);
  process.stdout.write(`PROJECT-PACKED-CONSUMER: PASS\nfiles=${String(paths.length)}\nruntimeDependencies=0\n`);
} finally {
  const resolved = resolve(workRoot);
  const expectedPrefix = resolve(tmpdir(), "ai-dev-os-project-packed-consumer-");
  if (!resolved.startsWith(expectedPrefix)) throw new Error("Refusing to clean an unowned temporary root.");
  rmSync(resolved, { recursive: true, force: true });
}
