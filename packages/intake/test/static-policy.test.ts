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
  /from\s+["'](?:node:)?(?:fs|http|https|net|tls|dns|child_process|worker_threads)["']/iu,
  /\bfetch\s*\(/u,
  /\bXMLHttpRequest\b/u,
  /\bWebSocket\b/u,
  /\bprocess\s*\./u,
  /\bchild_process\b/u,
  /\bsetTimeout\s*\(/u,
  /\bsetInterval\s*\(/u,
  /\bqueueMicrotask\s*\(/u,
  /\bMath\.random\s*\(/u,
  /\bDate\.now\s*\(/u,
  /new\s+Date\s*\(\s*\)/u,
  /\beval\s*\(/u,
  /\brequire\s*\(/u,
  /\bimport\s*\(/u,
  /@anthropic-ai\//u,
  /@ai-dev-os\/(?:application|scheduler|providers?|secrets?|control-service)/u,
  /\bElectron\b/u,
  /\bFastify\b/u,
  /\bbetter-sqlite3\b/u,
] as const;

function scan(source: string): readonly string[] {
  return forbiddenPatterns.filter((pattern) => pattern.test(source)).map((pattern) => pattern.source);
}

describe("intake package static authority boundary", () => {
  it("recursively inventories production source and finds no ambient effect surface", () => {
    const files = sourceFiles(resolve(packageRoot, "src"));
    expect(files.map((file) => file.slice(packageRoot.length).replaceAll("\\", "/")).sort()).toEqual([
      "/src/acceptance.ts",
      "/src/c7-store.ts",
      "/src/candidate.ts",
      "/src/clarification.ts",
      "/src/contracts.ts",
      "/src/digest.ts",
      "/src/errors.ts",
      "/src/index.ts",
      "/src/inspection.ts",
      "/src/projections.ts",
      "/src/text.ts",
    ]);
    for (const file of files) expect(scan(readFileSync(file, "utf8")), file).toEqual([]);
  });

  it("isolates path handling to the collector and persistence runtime to the digest/store bridges", () => {
    const files = sourceFiles(resolve(packageRoot, "src"));
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (source.includes('from "node:path"')) expect(file.endsWith("inspection.ts")).toBe(true);
      if (source.includes('from "@ai-dev-os/persistence"')) {
        expect(file.endsWith("digest.ts") || file.endsWith("c7-store.ts")).toBe(true);
      }
    }
    expect(readFileSync(resolve(packageRoot, "src", "inspection.ts"), "utf8")).not.toContain("node:fs");
  });

  it("keeps production, authority, commands, and runtime capabilities empty", () => {
    expect(publicApi.INTAKE_PRODUCTION_ENABLED).toBe(false);
    expect(publicApi.INTAKE_AUTHORITY).toBe("none");
    expect(publicApi.INTAKE_AVAILABLE_COMMANDS).toEqual([]);
    expect(publicApi.INTAKE_RUNTIME_CAPABILITIES).toEqual([]);
  });

  it("exports no route, scheduling, plan-sealing, provider, credential, or execution API", () => {
    for (const name of [
      "scheduleTask",
      "sealPlan",
      "isPlanSchedulingEligible",
      "registerRoute",
      "startServer",
      "executeProject",
      "contactProvider",
      "readCredential",
      "createAgent",
      "materializeCandidateBrief",
      "parsePreparedAcceptance",
      "candidateFieldProvenance",
      "clarificationQuestionSetDigest",
      "clarificationRoundDecisionMaterial",
      "containsAbsoluteLocalPath",
      "containsIntakeDisallowedFormatting",
      "containsIntakeSecretShape",
      "containsProtectedIdentifierShape",
      "parseProposedIntakeQuestion",
      "protectedBaseConfusableEquivalent",
      "protectedConfusableEquivalent",
      "protectedConfusableDataIdentity",
      "protectedDirectConfusableEquivalent",
      "validateClarificationResolutions",
      "validateIntakeText",
    ]) {
      expect(Object.hasOwn(publicApi, name), name).toBe(false);
    }
  });

  it("contains exactly one acceptance write-attempt call and no hidden write retry loop", () => {
    const acceptance = readFileSync(resolve(packageRoot, "src", "acceptance.ts"), "utf8");
    expect(acceptance.match(/\.store\.attempt\s*\(/gu)).toHaveLength(1);
    expect(acceptance).not.toMatch(/while\s*\([^)]*attempt/iu);
    expect(acceptance).not.toMatch(/for\s*\([^)]*attempt/iu);
    const store = readFileSync(resolve(packageRoot, "src", "c7-store.ts"), "utf8");
    expect(store.match(/aggregates\.(?:create|update)\s*\(/gu)).toHaveLength(2);
    expect(store).not.toContain("setTimeout");
  });

  it("pins a closed read-only Git command inventory with no mutation or network verb", () => {
    expect(publicApi.INTAKE_GIT_QUERIES).toEqual([
      { kind: "root", args: ["rev-parse", "--show-toplevel"] },
      { kind: "head", args: ["rev-parse", "--verify", "HEAD"] },
      { kind: "branch", args: ["symbolic-ref", "--quiet", "--short", "HEAD"] },
      { kind: "status", args: ["status", "--porcelain=v1", "--untracked-files=no"] },
    ]);
    const flat = publicApi.INTAKE_GIT_QUERIES.flatMap((query) => query.args);
    for (const forbidden of ["push", "fetch", "pull", "commit", "checkout", "reset", "clean", "config", "remote"]) {
      expect(flat).not.toContain(forbidden);
    }
  });

  it("declares only the reviewed first-party package graph and bounded tarball files", () => {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      files: readonly string[];
      exports: Record<string, unknown>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@ai-dev-os/persistence", "@ai-dev-os/project"]);
    expect(Object.keys(manifest.devDependencies).sort()).toEqual(["@ai-dev-os/persistence-memory", "@ai-dev-os/persistence-sqlite"]);
    expect(manifest.files).toEqual(["dist", "README.md"]);
    expect(Object.keys(manifest.exports)).toEqual(["."]);
  });

  it("proves every forbidden-import and ambient-capability detector with planted controls", () => {
    const controls = [
      'import { readFile } from "node:fs";',
      "fetch('https://example.invalid')",
      "process.env.SECRET",
      "setTimeout(() => {}, 1)",
      "new Date()",
      "Math.random()",
      'import "@ai-dev-os/scheduler";',
    ];
    for (const control of controls) expect(scan(control).length, control).toBeGreaterThan(0);
    expect(scan("const deterministic = new Date(milliseconds); Date.parse(timestamp);")).toEqual([]);
  });
});
