import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.js";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "..", "..");

const EXPECTED_PRODUCTION_FILES = [
  "/src/assembly.ts", "/src/constants.ts", "/src/contracts.ts", "/src/errors.ts",
  "/src/index.ts", "/src/lifecycle.ts", "/src/observation.ts", "/src/order.ts", "/src/persistence-boundary.ts", "/src/persistence.ts",
  "/src/projections.ts", "/src/seal.ts", "/src/specification.ts", "/src/validation.ts",
] as const;

const EXPECTED_PLAN_REFUSALS = [
  "PLAN_VALIDATION_REFUSED", "PLAN_PRECONDITION_REFUSED", "PLAN_BOUND_EXCEEDED",
  "PLAN_SEAL_CONDITION_FAILED", "PLAN_PROVENANCE_REFUSED", "PLAN_AUTHORITY_VIOLATION",
  "PLAN_STORE_CONFLICT", "PLAN_STORE_UNAVAILABLE", "PLAN_STORE_CORRUPT", "PLAN_OUT_OF_SCOPE",
] as const;

const forbiddenPatterns: readonly RegExp[] = [
  /from\s+["']node:/iu, /\bimport\s*\(/u, /\brequire\s*\(/u,
  /\bfetch\s*\(/u, /\bXMLHttpRequest\b/u, /\bWebSocket\b/u,
  /\bprocess\s*\./u, /\bchild_process\b/u, /\bsetTimeout\s*\(/u,
  /\bsetInterval\s*\(/u, /\bqueueMicrotask\s*\(/u, /\bMath\.random\s*\(/u,
  /\bDate\.now\s*\(/u, /new\s+Date\s*\(\s*\)/u, /\beval\s*\(/u,
  /\bFastify\b/u, /\bElectron\b/u, /\bbetter-sqlite3\b/u, /\bpostgres\b/iu,
  /@anthropic-ai\//u, /\bdispatch-first-task\b/u, /\bblocking-questions-found\b/u,
  /\bisPlanSchedulingEligible\b/u, /\bisPlanStateSchedulingAuthorized\b/u,
  /\bPlanSchedulingEligibilityProof\b/u,
];

function read(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function source(path: string): string {
  return readFileSync(resolve(packageRoot, path), "utf8");
}

function productionFiles(directory = resolve(packageRoot, "src")): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "testing" ? [] : productionFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function scanForbidden(text: string): readonly string[] {
  return forbiddenPatterns.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
}

function workspaceImports(text: string): readonly Readonly<{ specifier: string; typeOnly: boolean }>[] {
  const fromImports = [...text.matchAll(/^import\s+(type\s+)?[\s\S]*?\s+from\s+["'](@ai-dev-os\/[^"']+)["'];/gmu)]
    .map((match) => Object.freeze({ specifier: match[2]!, typeOnly: match[1] !== undefined }));
  const sideEffects = [...text.matchAll(/^import\s+["'](@ai-dev-os\/[^"']+)["'];/gmu)]
    .map((match) => Object.freeze({ specifier: match[1]!, typeOnly: false }));
  return Object.freeze([...fromImports, ...sideEffects]);
}

function importBoundaryViolations(text: string, persistenceBoundary = false): readonly string[] {
  return workspaceImports(text)
    .filter((entry) => !entry.typeOnly && !["@ai-dev-os/project", ...(persistenceBoundary ? ["@ai-dev-os/domain", "@ai-dev-os/intake", "@ai-dev-os/persistence"] : [])].includes(entry.specifier))
    .map((entry) => entry.specifier);
}

function mainSourceGraph(): readonly string[] {
  const pending = [resolve(packageRoot, "src", "index.ts")];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/gu)) {
      const specifier = match[1]!;
      const target = resolve(dirname(file), specifier.endsWith(".js")
        ? `${specifier.slice(0, -3)}.ts`
        : `${specifier}.ts`);
      pending.push(target);
    }
  }
  return Object.freeze([...visited].sort());
}

function numericProperty(text: string, property: string): number {
  const match = text.match(new RegExp(`\\b${property}:\\s*([0-9][0-9_]*)`, "u"));
  if (match?.[1] === undefined) throw new Error(`Missing numeric property ${property}.`);
  return Number(match[1].replaceAll("_", ""));
}

function containsWrongAggregate(text: string): boolean {
  return /["']product-plan["']/u.test(text);
}

describe("SP-1..SP-12 production boundary", () => {
  it("SP-1 keeps production, runtime capabilities, commands, and registries closed", () => {
    expect(publicApi.PLAN_PRODUCTION_ENABLED).toBe(false);
    expect(publicApi.PLAN_RUNTIME_CAPABILITIES).toEqual([]);
    expect(publicApi.PLAN_AVAILABLE_COMMANDS).toEqual([]);
    expect(Object.isFrozen(publicApi.PLAN_RUNTIME_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(publicApi.PLAN_AVAILABLE_COMMANDS)).toBe(true);
    expect(read("packages/api/src/routes.ts")).toMatch(/API_COMMAND_REGISTRY: readonly never\[\] = Object\.freeze\(\[\]\)/u);
    expect(read("packages/control-service/src/routes.ts")).toMatch(/CONTROL_COMMAND_REGISTRY: readonly never\[\] = Object\.freeze\(\[\]\)/u);
    expect(read("packages/application/src/index.ts")).not.toContain("@ai-dev-os/plan/testing");
    expect(read("packages/application/src/planning.ts")).not.toContain("/testing");
  });

  it("SP-2 pins the exact production source inventory and scans every file", () => {
    const files = productionFiles();
    expect(files.map((file) => file.slice(packageRoot.length).replaceAll("\\", "/")).sort())
      .toEqual(EXPECTED_PRODUCTION_FILES);
    for (const file of files) expect(scanForbidden(readFileSync(file, "utf8")), file).toEqual([]);
  });

  it("SP-3 permits only the real project runtime surface and keeps every other workspace import type-only", () => {
    const combined = productionFiles().map((file) => readFileSync(file, "utf8")).join("\n");
    const imports = workspaceImports(combined);
    const runtimeTargets = [...new Set(imports.filter((entry) => !entry.typeOnly).map((entry) => entry.specifier))];
    expect(runtimeTargets.sort()).toEqual(["@ai-dev-os/domain", "@ai-dev-os/intake", "@ai-dev-os/persistence", "@ai-dev-os/project"]);
    for (const file of productionFiles()) expect(importBoundaryViolations(readFileSync(file, "utf8"), file.endsWith("persistence-boundary.ts")), file).toEqual([]);
    expect(combined).toMatch(/\bparseProjectPlan\s*\(/u);
    expect(combined).toMatch(/\bassertPlanDigest\s*\(/u);

    expect(importBoundaryViolations('import { parseProject } from "@ai-dev-os/project";')).toEqual([]);
    expect(importBoundaryViolations('import type { ProductSpecification } from "@ai-dev-os/product-planning";')).toEqual([]);
    expect(importBoundaryViolations('import { createProductPlan } from "@ai-dev-os/product-planning";'))
      .toEqual(["@ai-dev-os/product-planning"]);
    expect(importBoundaryViolations('import "@ai-dev-os/scheduler";')).toEqual(["@ai-dev-os/scheduler"]);
  });

  it("SP-4 pins the production and isolated test-composition package graph", () => {
    const manifest = JSON.parse(source("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      exports: Record<string, unknown>;
      files: readonly string[];
    };
    expect(manifest.dependencies).toEqual({ "@ai-dev-os/project": "^0.1.0", "@ai-dev-os/domain": "^0.1.0", "@ai-dev-os/intake": "^0.1.0", "@ai-dev-os/persistence": "^0.1.0" });
    expect(Object.keys(manifest.devDependencies).sort()).toEqual([
      "@ai-dev-os/persistence-memory", "@ai-dev-os/persistence-sqlite", "@ai-dev-os/product-planning",
    ]);
    expect(manifest.files).toEqual(["dist", "README.md"]);
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./persistence-boundary", "./testing"]);
    for (const forbidden of [
      "@ai-dev-os/context", "@ai-dev-os/artifact-store", "@ai-dev-os/artifacts",
      "@ai-dev-os/repository-index", "@ai-dev-os/memory", "@ai-dev-os/product-planning",
      "@ai-dev-os/scheduler", "@ai-dev-os/evaluation",
    ]) expect(Object.hasOwn(manifest.dependencies, forbidden), forbidden).toBe(false);
  });

  it("SP-5 pins the bounded packed-consumer gate and its explicit package closure", () => {
    const manifest = JSON.parse(source("package.json")) as { scripts: Record<string, string> };
    const root = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const script = source("scripts/verify-packed-consumer.mjs");
    expect(manifest.scripts["verify:packed-consumer"]).toBe("node scripts/verify-packed-consumer.mjs");
    expect(root.scripts["verify:plan-packed-consumer"]).toBe("npm run verify:packed-consumer --workspace @ai-dev-os/plan");
    expect(read(".github/workflows/ci.yml")).toContain("npm run verify:plan-packed-consumer");
    for (const dependency of [
      "domain", "artifacts", "persistence", "providers", "scheduler", "task-graph", "project",
      "intake", "product-planning", "persistence-memory", "persistence-sqlite", "plan",
    ]) expect(script).toContain(`@ai-dev-os/${dependency}`);
    expect(script).toContain("mkdtempSync");
    expect(script).toContain('"--ignore-scripts"');
    expect(script).toContain('/"link"\\s*:\\s*true/u');
  });

  it("SP-6 proves the main export graph cannot reach the testing subpath", () => {
    const graph = mainSourceGraph();
    expect(graph.map((file) => file.slice(packageRoot.length).replaceAll("\\", "/")))
      .toEqual(EXPECTED_PRODUCTION_FILES.filter((file) => file !== "/src/persistence-boundary.ts"));
    expect(graph.some((file) => file.includes(resolve(packageRoot, "src", "testing")))).toBe(false);
    expect(source("src/index.ts")).not.toContain("./testing");
  });

  it("SP-7 exports no attachment, pack, context-pack, upload, or ingest symbol", () => {
    const forbidden = ["attachment", "pack", "contextPack", "upload", "ingest"];
    const runtimeNames = Object.keys(publicApi).map((name) => name.toLowerCase());
    const combined = productionFiles().map((file) => readFileSync(file, "utf8")).join("\n");
    for (const name of forbidden) {
      expect(runtimeNames, name).not.toContain(name.toLowerCase());
      expect(combined, name).not.toMatch(new RegExp(`\\b${name}\\b`, "u"));
    }
  });

  it("SP-8 pins the closed ten-member refusal code union in exact order", () => {
    expect(publicApi.PLAN_REFUSAL_CODES).toEqual(EXPECTED_PLAN_REFUSALS);
    expect(new Set(publicApi.PLAN_REFUSAL_CODES).size).toBe(10);
  });

  it("SP-9 enforces every graph bound against the real C6 and task-graph ceilings", () => {
    const c6 = numericProperty(read("packages/project/src/validation.ts"), "items");
    const taskGraphSource = read("packages/task-graph/src/types.ts");
    const taskGraph = {
      maxTasks: numericProperty(taskGraphSource, "maxTasks"),
      maxDependenciesPerTask: numericProperty(taskGraphSource, "maxDependenciesPerTask"),
      maxEdges: numericProperty(taskGraphSource, "maxEdges"),
      maxDepth: numericProperty(taskGraphSource, "maxDepth"),
    };
    for (const name of [
      "maxStages", "maxTasks", "maxTasksPerStage", "maxDependencies", "maxDepth", "maxFanIn", "maxFanOut",
    ] as const) expect(publicApi.PLAN_LIMITS[name], name).toBeLessThanOrEqual(c6);
    expect(publicApi.PLAN_LIMITS.maxTasks).toBeLessThanOrEqual(taskGraph.maxTasks);
    expect(publicApi.PLAN_LIMITS.maxDepth).toBeLessThanOrEqual(taskGraph.maxDepth);
    expect(publicApi.PLAN_LIMITS.maxDependencies).toBeLessThanOrEqual(taskGraph.maxEdges);
    expect(publicApi.PLAN_LIMITS.maxFanIn).toBeLessThanOrEqual(taskGraph.maxDependenciesPerTask);
    expect(publicApi.PLAN_LIMITS.maxFanOut).toBeLessThanOrEqual(taskGraph.maxDependenciesPerTask);
  });

  it("SP-11 independently pins payload and persistence-envelope schema version 1", () => {
    const contracts = source("src/contracts.ts");
    const persistence = source("src/persistence.ts");
    const composition = source("src/persistence-boundary.ts");
    const commitImplementation = composition.slice(composition.indexOf("async function commit("));
    const appendCalls = [...commitImplementation.matchAll(/\.events\.append\s*\(\{/gu)];
    const envelopeVersions = [...commitImplementation.matchAll(/^\s+eventSchemaVersion:\s*(\d+),$/gmu)]
      .map((match) => Number(match[1]));
    expect(publicApi.PLAN_SCHEMA_VERSION).toBe(1);
    expect(contracts).toContain("readonly schemaVersion: 1;");
    expect(contracts).toContain("readonly eventSchemaVersion: 1;");
    expect(persistence).toContain('literal(input["schemaVersion"], 1, "planStore")');
    expect(appendCalls).toHaveLength(2);
    expect(envelopeVersions).toEqual([1, 1]);
  });

  it("SP-12 excludes the wrong aggregate from production and positively requires project-plan in composition", () => {
    const combined = productionFiles().map((file) => readFileSync(file, "utf8")).join("\n");
    expect(containsWrongAggregate(combined)).toBe(false);
    expect(containsWrongAggregate('const aggregateType = "product-plan";'), "positive control").toBe(true);
    expect(source("src/persistence-boundary.ts")).toContain('aggregateType: "project-plan"');
  });

  it("proves every ambient-capability detector with planted controls", () => {
    const controls = [
      'import { readFile } from "node:fs";', "fetch('https://example.invalid')",
      "process.env.SECRET", "setTimeout(() => {}, 1)", "new Date()", "Math.random()",
      'import("./dynamic.js")', 'require("module")', "dispatch-first-task",
      'const transition = "blocking-questions-found";',
      "function isPlanSchedulingEligible() { return true; }",
      "function isPlanStateSchedulingAuthorized() { return true; }",
      "interface PlanSchedulingEligibilityProof { readonly forged: true }",
    ];
    for (const control of controls) expect(scanForbidden(control).length, control).toBeGreaterThan(0);
    const production = productionFiles().map((file) => readFileSync(file, "utf8")).join("\n");
    expect(scanForbidden(`${production}\nconst planted = "blocking-questions-found";`)).not.toEqual([]);
    expect(scanForbidden(`${production}\ninterface PlanSchedulingEligibilityProof {}`)).not.toEqual([]);
    expect(scanForbidden("const deterministic = new Date(milliseconds); Date.parse(timestamp);")).toEqual([]);
  });
});
