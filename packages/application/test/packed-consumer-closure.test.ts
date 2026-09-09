import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REGISTRY_PINS,
  REPOSITORY_PACKAGES,
  validateConsumerRuntimeClosure,
  validateTarballExportTargets,
  validateTarballFileList,
} from "../scripts/packed-consumer/lib.mjs";

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const workspaces = new Map<string, { directory: string; manifest: Manifest }>();
for (const group of ["packages", "apps"]) {
  for (const entry of readdirSync(resolve(repositoryRoot, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = `${group}/${entry.name}`, path = resolve(repositoryRoot, directory, "package.json");
    if (existsSync(path)) {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
      workspaces.set(manifest.name, { directory, manifest });
    }
  }
}
const manifests = Object.fromEntries([...workspaces].map(([name, item]) => [name, item.manifest]));
const lockfile = JSON.parse(readFileSync(resolve(repositoryRoot, "package-lock.json"), "utf8")) as {
  packages: Record<string, { version?: string }>;
};

describe("packed application consumer runtime closure", () => {
  it("supplies the complete real manifest graph and preserves the established task-graph consumer", () => {
    const expected = new Set<string>();
    const pending = ["@ai-dev-os/application", "@ai-dev-os/task-graph"];
    while (pending.length > 0) {
      const name = pending.pop()!;
      if (expected.has(name)) continue;
      const workspace = workspaces.get(name);
      if (workspace === undefined) throw new Error(`Unresolved first-party dependency ${name}`);
      expected.add(name);
      const manifest = workspace.manifest;
      const dependencies = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}).filter(peer => manifest.peerDependenciesMeta?.[peer]?.optional !== true),
      ]);
      for (const dependency of dependencies) if (dependency.startsWith("@ai-dev-os/")) pending.push(dependency);
    }
    expect(REPOSITORY_PACKAGES.map(definition => definition.name).sort()).toEqual([...expected].sort());
    for (const definition of REPOSITORY_PACKAGES) {
      expect(definition.directory).toBe(workspaces.get(definition.name)?.directory);
    }
  });

  it("pins every real registry edge to its workspace-resolved lockfile version", () => {
    expect(validateConsumerRuntimeClosure(manifests, lockfile)).toMatchObject({
      packageCount: REPOSITORY_PACKAGES.length,
      registryPackageCount: 3,
    });
    expect(REGISTRY_PINS).toEqual({ "better-sqlite3": "12.11.1", pg: "8.23.0", "pg-pool": "3.14.0" });
  });

  it("rejects a planted missing transitive tarball before registry installation", () => {
    const incomplete = REPOSITORY_PACKAGES.filter(definition => definition.name !== "@ai-dev-os/provider-gateway");
    expect(() => validateConsumerRuntimeClosure(manifests, lockfile, incomplete)).toThrowError(
      "Missing first-party tarball @ai-dev-os/provider-gateway required by @ai-dev-os/thinker.",
    );
  });

  it("rejects a newly declared registry dependency without an explicit reviewed pin", () => {
    const changed = {
      ...manifests,
      "@ai-dev-os/config": { ...manifests["@ai-dev-os/config"], dependencies: { ...manifests["@ai-dev-os/config"]!.dependencies, "new-registry-dependency": "^1.0.0" } },
    };
    const changedLock = { packages: { ...lockfile.packages, "node_modules/new-registry-dependency": { version: "1.2.3" } } };
    expect(() => validateConsumerRuntimeClosure(changed, changedLock)).toThrowError("Missing or mismatched registry pin for new-registry-dependency");
  });

  it("uses the workspace-specific native pin and rejects drift instead of falling back to another version", () => {
    const nativePath = "packages/persistence-sqlite/node_modules/better-sqlite3";
    const changedLock = { packages: { ...lockfile.packages, [nativePath]: { ...lockfile.packages[nativePath], version: "0.0.1" } } };
    expect(() => validateConsumerRuntimeClosure(manifests, changedLock)).toThrowError("Missing or mismatched registry pin for better-sqlite3");
  });

  it("requires optional runtime edges and non-optional peers while excluding development and optional test peers", () => {
    const definitions = [{ name: "@ai-dev-os/root", directory: "packages/root" }, { name: "@ai-dev-os/leaf", directory: "packages/leaf" }];
    const fixture = {
      "@ai-dev-os/root": {
        name: "@ai-dev-os/root", optionalDependencies: { "@ai-dev-os/leaf": "^0.1.0" },
        devDependencies: { "@ai-dev-os/development-only": "^0.1.0" },
        peerDependencies: { vitest: ">=4.0.0" }, peerDependenciesMeta: { vitest: { optional: true } },
      },
      "@ai-dev-os/leaf": { name: "@ai-dev-os/leaf", peerDependencies: { "@ai-dev-os/root": "^0.1.0" } },
    };
    expect(validateConsumerRuntimeClosure(fixture, { packages: {} }, definitions, {})).toEqual({ packageCount: 2, firstPartyEdges: 2, registryPackageCount: 0 });
    expect(() => validateConsumerRuntimeClosure(fixture, { packages: {} }, definitions.slice(0, 1), {})).toThrowError("Missing first-party tarball @ai-dev-os/leaf");
    expect(() => validateConsumerRuntimeClosure(fixture, { packages: {} }, definitions.slice(1), {})).toThrowError("Missing first-party tarball @ai-dev-os/root");
  });

  it("rejects a missing declared compiled testing entry while keeping source and fixture payloads excluded", () => {
    const exports = {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./testing": { types: "./dist/testing/contract-suite.d.ts", import: "./dist/testing/contract-suite.js" },
    };
    const files = ["package.json", "README.md", "dist/index.d.ts", "dist/index.js", "dist/testing/contract-suite.d.ts", "dist/testing/contract-suite.js"];
    expect(validateTarballFileList(files).ok).toBe(true);
    expect(validateTarballExportTargets(exports, files).ok).toBe(true);
    expect(validateTarballExportTargets(exports, files.filter(file => file !== "dist/testing/contract-suite.js"))).toEqual({ ok: false, missing: ["./dist/testing/contract-suite.js"] });
    expect(validateTarballFileList([...files, "src/index.ts", "test/fixtures/account.json"]).ok).toBe(false);
    expect(validateTarballExportTargets({ ".": "./src/index.ts" }, [...files, "src/index.ts"]).ok).toBe(false);
  });

  it("runs the manifest preflight before packing and retains the existing package and production-leak checks", () => {
    const verifier = readFileSync(resolve(import.meta.dirname, "../scripts/packed-consumer/verify-packed-consumer.mjs"), "utf8");
    const preflight = verifier.indexOf("validateConsumerRuntimeClosure(repositoryManifests, lockfile)");
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(verifier.indexOf("npm(npmPackArgs("));
    expect(verifier).toContain("validateTarballFileList(filePaths)");
    expect(verifier).toContain("validateTarballExportTargets(repositoryManifests[definition.name].exports, filePaths)");
    expect(verifier).toContain("npm(NPM_INSTALL_ARGS, consumerDirectory)");
    const probe = readFileSync(resolve(import.meta.dirname, "../scripts/packed-consumer/probe.mjs"), "utf8");
    expect(probe).toContain('await check("exports.testing-surface-absent"');
    expect(probe).toContain("for (const name of FORBIDDEN_PRODUCTION_EXPORTS)");
  });
});
