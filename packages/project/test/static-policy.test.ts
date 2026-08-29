import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.js";

const packageRoot = resolve(import.meta.dirname, "..");

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

const forbiddenPatterns: readonly RegExp[] = [
  /from\s+["']node:/iu, /import\s*\(/u, /\brequire\s*\(/u,
  /\bfetch\s*\(/u, /\bXMLHttpRequest\b/u, /\bWebSocket\b/u,
  /\bprocess\s*\./u, /\bchild_process\b/u, /\bsetTimeout\s*\(/u,
  /\bsetInterval\s*\(/u, /\bqueueMicrotask\s*\(/u, /\bMath\.random\s*\(/u,
  /\bDate\.now\s*\(/u, /new\s+Date\s*\(\s*\)/u, /\beval\s*\(/u,
  /\bFastify\b/u, /\bElectron\b/u, /\bbetter-sqlite3\b/u, /\bpostgres\b/iu,
  /from\s+["'](?:node:)?(?:fs|http|https|net|tls|dns|child_process|worker_threads|crypto)["']/iu,
];

function scan(source: string): readonly string[] {
  return forbiddenPatterns.filter((pattern) => pattern.test(source)).map((pattern) => pattern.source);
}

describe("project package purity and static policy", () => {
  it("recursively scans every production source and finds no I/O, ambient clock, timer, process, or runtime import capability", () => {
    const files = sourceFiles(resolve(packageRoot, "src"));
    expect(files.map((file) => file.slice(packageRoot.length).replaceAll("\\", "/")).sort()).toEqual([
      "/src/canonical.ts", "/src/contracts.ts", "/src/copy.ts", "/src/errors.ts", "/src/index.ts",
      "/src/invariants.ts", "/src/parsers.ts", "/src/projections.ts", "/src/state-machines.ts", "/src/validation.ts",
    ]);
    for (const file of files) expect(scan(readFileSync(file, "utf8")), file).toEqual([]);
  });

  it("keeps every external package import type-only and runtime imports local", () => {
    for (const file of sourceFiles(resolve(packageRoot, "src"))) {
      const source = readFileSync(file, "utf8");
      const externalImports = [...source.matchAll(/^import(?!\s+type\b)[^;]+from\s+["']([^"']+)["'];/gmu)]
        .map((match) => match[1]).filter((specifier) => specifier !== undefined && !specifier.startsWith("."));
      expect(externalImports, file).toEqual([]);
    }
  });

  it("uses a dependency-free packed runtime with bounded exports and files", () => {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest["dependencies"]).toBeUndefined();
    expect(Object.keys(manifest["devDependencies"] as object).sort()).toEqual(["@ai-dev-os/domain", "@ai-dev-os/policy", "@ai-dev-os/process-broker", "@ai-dev-os/scheduler", "@ai-dev-os/secrets"]);
    expect(manifest["files"]).toEqual(["dist", "README.md"]);
    expect(Object.keys(manifest["exports"] as object)).toEqual(["."]);
    expect(publicApi.PROJECT_PRODUCTION_ENABLED).toBe(false);
    expect(publicApi.PROJECT_RUNTIME_CAPABILITIES).toEqual([]);
  });

  it("does not define or export the deferred C9 scheduling decision surface", () => {
    const forbiddenSchedulingClaim = /\b(?:isPlanStateSchedulingAuthorized|isPlanSchedulingEligible|PlanSchedulingEligibilityProof)\b/u;
    const productionSource = sourceFiles(resolve(packageRoot, "src"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(productionSource).not.toMatch(forbiddenSchedulingClaim);
    expect(Object.hasOwn(publicApi, "isPlanStateSchedulingAuthorized")).toBe(false);
    expect(Object.hasOwn(publicApi, "isPlanSchedulingEligible")).toBe(false);
    expect(forbiddenSchedulingClaim.test("export function isPlanSchedulingEligible() {}"), "positive control").toBe(true);
  });

  it("proves the forbidden-import and runtime-capability guard has planted positive controls", () => {
    const controls = [
      'import { readFileSync } from "node:fs";', "fetch('https://example.invalid')",
      "process.env.SECRET", "setTimeout(() => {}, 1)", "new Date()", "Math.random()",
    ];
    for (const control of controls) expect(scan(control).length, control).toBeGreaterThan(0);
    expect(scan("const deterministic = new Date(milliseconds); Date.parse(timestamp);")).toEqual([]);
  });
});
