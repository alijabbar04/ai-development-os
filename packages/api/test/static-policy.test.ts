import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "..", "..");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function importSpecifiers(source: string): readonly string[] {
  const trivia = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*`;
  const fromPattern = new RegExp(String.raw`\bfrom${trivia}["']([^"']+)["']`, "gu");
  const sideEffectPattern = new RegExp(String.raw`\bimport${trivia}["']([^"']+)["']`, "gu");
  const dynamicPattern = new RegExp(String.raw`\bimport${trivia}\(${trivia}["']([^"']+)["']${trivia}\)`, "gu");
  const requirePattern = new RegExp(String.raw`\brequire${trivia}\(${trivia}["']([^"']+)["']${trivia}\)`, "gu");
  const matches = [
    ...source.matchAll(fromPattern),
    ...source.matchAll(sideEffectPattern),
    ...source.matchAll(dynamicPattern),
    ...source.matchAll(requirePattern),
  ];
  const specifiers = matches.map((match) => match[1]).filter((value): value is string => value !== undefined);

  const dynamicStarts = [...source.matchAll(new RegExp(String.raw`\bimport${trivia}\(`, "gu"))].length;
  const requireStarts = [...source.matchAll(new RegExp(String.raw`\brequire${trivia}\(`, "gu"))].length;
  const dynamicLiterals = [...source.matchAll(dynamicPattern)].length;
  const requireLiterals = [...source.matchAll(requirePattern)].length;
  return [
    ...specifiers,
    ...Array.from({ length: dynamicStarts - dynamicLiterals }, () => "<dynamic-import>"),
    ...Array.from({ length: requireStarts - requireLiterals }, () => "<dynamic-require>"),
  ];
}

const ALLOWED_PRODUCTION_IMPORTS = new Set(["@ai-dev-os/domain", "node:util"]);

function forbiddenImports(source: string): readonly string[] {
  return importSpecifiers(source).filter((specifier) =>
    !specifier.startsWith(".") && !ALLOWED_PRODUCTION_IMPORTS.has(specifier));
}

function productionSources(): readonly string[] {
  return [
    ...sourceFiles(resolve(packageRoot, "src")),
    ...sourceFiles(resolve(repositoryRoot, "packages", "domain", "src")),
  ];
}

function workspaceManifest(packageName: string): string {
  for (const directory of readdirSync(resolve(repositoryRoot, "packages"), { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const manifestPath = resolve(repositoryRoot, "packages", directory.name, "package.json");
    const manifest = JSON.parse(read(manifestPath)) as { readonly name?: string };
    if (manifest.name === packageName) return manifestPath;
  }
  throw new Error(`Workspace manifest missing for ${packageName}.`);
}

function runtimeDependencyClosure(rootManifest: string): readonly string[] {
  const pending = [rootManifest];
  const visited = new Set<string>();
  const names = new Set<string>();
  while (pending.length > 0) {
    const manifestPath = pending.pop();
    if (manifestPath === undefined || visited.has(manifestPath)) continue;
    visited.add(manifestPath);
    const manifest = JSON.parse(read(manifestPath)) as {
      readonly name: string;
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    names.add(manifest.name);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!dependency.startsWith("@ai-dev-os/")) throw new Error(`External runtime dependency: ${dependency}`);
      pending.push(workspaceManifest(dependency));
    }
  }
  return [...names].sort();
}

describe("Stage 20A API static import and authority policy", () => {
  it("allows only domain validation and pure proxy introspection across the runtime source closure", () => {
    const sources = productionSources();
    expect(sources.length).toBeGreaterThan(sourceFiles(resolve(packageRoot, "src")).length);
    for (const path of sources) expect(forbiddenImports(read(path)), path).toEqual([]);
  });

  it("keeps the complete runtime dependency closure repository-owned and pure", () => {
    const manifest = JSON.parse(read(resolve(packageRoot, "package.json"))) as {
      readonly dependencies: Readonly<Record<string, string>>;
      readonly files: readonly string[];
    };
    expect(manifest.dependencies).toEqual({ "@ai-dev-os/domain": "0.1.0" });
    expect(manifest.files).toEqual(["dist", "README.md"]);
    expect(runtimeDependencyClosure(resolve(packageRoot, "package.json"))).toEqual([
      "@ai-dev-os/api", "@ai-dev-os/domain",
    ]);
  });

  it("contains no provider, process, workspace, Git, secret, Electron, native, network, persistence, or launch authority", () => {
    const source = productionSources().map(read).join("\n").toLowerCase();
    for (const forbidden of [
      "@ai-dev-os/provider", "@ai-dev-os/process-broker", "@ai-dev-os/workspace",
      "@ai-dev-os/integrator", "@ai-dev-os/secrets", "node:http", "node:https", "node:dns",
      "node:net", "node:tls", "node:dgram", "node:fs", "node:child_process", "node:worker_threads",
      "better-sqlite3", "electron", "fastify", "node-gyp", "process.env",
      "fetch(", "websocket", "xmlhttprequest", ".listen(", ".bind(", "spawn(",
      "exec(", "execfile(", "usage.refresh", "dynamic import",
    ]) expect(source, forbidden).not.toContain(forbidden);
  });

  it("proves the import guard detects synthetic direct and transitive violations", () => {
    expect(forbiddenImports('import { createServer } from "node:http";')).toEqual(["node:http"]);
    expect(forbiddenImports('import "node:dns";')).toEqual(["node:dns"]);
    expect(forbiddenImports('import/*comment*/"node:worker_threads";')).toEqual(["node:worker_threads"]);
    expect(forbiddenImports('import//comment\n"node:dns";')).toEqual(["node:dns"]);
    expect(forbiddenImports('export/*comment*/{ readFile }from/*comment*/"node:fs";')).toEqual(["node:fs"]);
    expect(forbiddenImports('const provider = await import("@ai-dev-os/provider-codex");')).toEqual(["@ai-dev-os/provider-codex"]);
    expect(forbiddenImports('const network = await import(/*comment*/"node:net");')).toEqual(["node:net"]);
    expect(forbiddenImports('const unknown = await import(specifier);')).toEqual(["<dynamic-import>"]);
    expect(forbiddenImports('const unknown = require(specifier);')).toEqual(["<dynamic-require>"]);
    expect(forbiddenImports('import { validation } from "@ai-dev-os/domain";')).toEqual([]);
    const syntheticTransitiveClosure = [
      'import { validation } from "@ai-dev-os/domain";',
      'import "node:dns";',
    ];
    expect(syntheticTransitiveClosure.flatMap(forbiddenImports)).toEqual(["node:dns"]);
  });
});
