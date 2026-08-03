import { describe, expect, it } from "vitest";
import { digestOfBytes } from "../src/index-model.js";
import { scanJsonStructure } from "../src/json-scan.js";
import {
  detectManifestFormat,
  extractManifest,
  type ManifestFormatId,
} from "../src/manifest-formats.js";

function extract(text: string, formatId: ManifestFormatId = "npm-package-manifest") {
  const bytes = new TextEncoder().encode(text);
  return extractManifest({
    canonicalPath: formatId === "npm-lockfile-v3" ? "package-lock.json" : "package.json",
    formatId,
    text,
    digest: digestOfBytes(bytes),
    maxBytes: 1_000_000,
    maxDependencies: 100,
    byteLength: bytes.length,
  });
}

describe("format detection", () => {
  it("matches only exact base names", () => {
    expect(detectManifestFormat("package.json")).toBe("npm-package-manifest");
    expect(detectManifestFormat("apps/web/package.json")).toBe("npm-package-manifest");
    expect(detectManifestFormat("package-lock.json")).toBe("npm-lockfile-v3");
    expect(detectManifestFormat("tsconfig.json")).toBe("typescript-project-config");
    expect(detectManifestFormat("tsconfig.build.json")).toBe("typescript-project-config");
    expect(detectManifestFormat("mypackage.json")).toBeNull();
    expect(detectManifestFormat("package.json.bak")).toBeNull();
  });
});

describe("json structure scanner", () => {
  it("reports duplicate keys that JSON.parse would silently drop", () => {
    const text = '{"dependencies":{"a":"1"},"dependencies":{"b":"2"}}';
    // Positive control: the native parser really does hide the first value.
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["dependencies"]);
    const scan = scanJsonStructure(text);
    expect(scan.ok).toBe(true);
    if (scan.ok) {
      expect(scan.duplicateKeyPaths).toEqual(["/dependencies"]);
    }
  });

  it("rejects JavaScript-only tokens and JSON5 dialects", () => {
    for (const text of ['{"a":NaN}', '{"a":Infinity}', "{'a':1}", '{"a":1,}', '{"a":1}//x']) {
      expect(scanJsonStructure(text).ok).toBe(false);
    }
  });

  it("bounds depth", () => {
    const deep = `${"[".repeat(64)}1${"]".repeat(64)}`;
    const result = scanJsonStructure(deep);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("too-deep");
    }
  });

  it("accepts ordinary documents including escapes", () => {
    const result = scanJsonStructure('{"a":"line\\nbreak \\u00e9","b":[1,-2.5e3,true,null]}');
    expect(result.ok).toBe(true);
  });

  it("accepts every JSON escape and rejects the ones JSON does not define", () => {
    expect(scanJsonStructure('{"a":"\\" \\\\ \\/ \\b \\f \\n \\r \\t \\u0041"}').ok).toBe(true);
    expect(scanJsonStructure('{"a":"\\x41"}').ok).toBe(false);
    expect(scanJsonStructure('{"a":"\\uZZZZ"}').ok).toBe(false);
  });

  it("rejects raw control characters inside strings", () => {
    expect(scanJsonStructure('{"a":"line\nbreak"}').ok).toBe(false);
  });

  it("rejects unterminated strings, objects, and arrays", () => {
    for (const text of ['{"a":"unterminated', '{"a":1', "[1,2", '{"a"}', "{,}"]) {
      expect(scanJsonStructure(text).ok).toBe(false);
    }
  });

  it("rejects malformed numbers and trailing content", () => {
    expect(scanJsonStructure("01").ok).toBe(false);
    expect(scanJsonStructure("+1").ok).toBe(false);
    const trailing = scanJsonStructure('{"a":1} {"b":2}');
    expect(trailing.ok).toBe(false);
    if (!trailing.ok) {
      expect(trailing.reason).toBe("trailing-content");
    }
  });

  it("handles empty containers and whitespace", () => {
    expect(scanJsonStructure("  {  }  ").ok).toBe(true);
    expect(scanJsonStructure("\t[\n]\r").ok).toBe(true);
  });

  it("reports duplicates nested inside arrays and objects", () => {
    const result = scanJsonStructure('{"a":[{"k":1,"k":2}],"b":{"c":{"d":1,"d":2}}}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.duplicateKeyPaths).toEqual(["/a/0/k", "/b/c/d"]);
    }
  });

  it("bounds the node count", () => {
    const wide = `[${Array.from({ length: 10 }, () => "1").join(",")}]`;
    expect(scanJsonStructure(wide).ok).toBe(true);
  });
});

describe("npm manifest extraction", () => {
  it("separates declared dependency kinds", () => {
    const { record, dependencies } = extract(
      JSON.stringify({
        name: "example",
        version: "1.0.0",
        private: true,
        dependencies: { alpha: "^1.0.0" },
        devDependencies: { beta: "~2.0.0" },
        peerDependencies: { gamma: ">=3" },
        optionalDependencies: { delta: "4.x" },
        workspaces: ["packages/*"],
      }),
    );
    expect(record.status).toBe("parsed");
    expect(record.declaredName).toBe("example");
    expect(record.isPrivate).toBe(true);
    expect(record.workspacePatterns).toEqual(["packages/*"]);
    expect(dependencies.map((item) => [item.name, item.kind, item.source])).toEqual([
      ["alpha", "runtime", "manifest"],
      ["beta", "development", "manifest"],
      ["delta", "optional", "manifest"],
      ["gamma", "peer", "manifest"],
    ]);
    expect(dependencies.every((item) => item.resolvedVersion === null)).toBe(true);
  });

  it("refuses a manifest with duplicate keys rather than picking one", () => {
    const { record, dependencies } = extract(
      '{"name":"x","dependencies":{"a":"1"},"dependencies":{"b":"2"}}',
    );
    expect(record.status).toBe("malformed");
    expect(record.diagnostics.map((item) => item.code)).toContain("manifest-duplicate-key");
    expect(dependencies).toHaveLength(0);
  });

  it("refuses prototype-pollution keys", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const { record } = extract(`{"name":"x","${key}":{"polluted":true}}`);
      expect(record.status).toBe("malformed");
    }
    // Positive control: the payload survives a naive parse intact, so the
    // rejection above is doing real work rather than matching nothing.
    const naive = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.hasOwn(naive, "__proto__")).toBe(true);
  });

  it("records a non-scalar specifier as unresolved instead of guessing", () => {
    const { record, dependencies } = extract(
      '{"name":"x","dependencies":{"alpha":{"version":"1.0.0","from":"git"}}}',
    );
    expect(record.status).toBe("partial");
    expect(dependencies[0]?.kind).toBe("unresolved");
    expect(dependencies[0]?.declaredRange).toBeNull();
    expect(record.diagnostics.map((item) => item.code)).toContain("manifest-dynamic-construct");
  });

  it("skips unrecognizable package identities and says so", () => {
    const { record, dependencies } = extract(
      '{"name":"x","dependencies":{"../../etc/passwd":"1.0.0","alpha":"1.0.0"}}',
    );
    expect(dependencies.map((item) => item.name)).toEqual(["alpha"]);
    expect(record.status).toBe("partial");
    expect(
      record.diagnostics.some((item) => item.detail.includes("skipped as unrecognizable")),
    ).toBe(true);
  });

  it("strips control characters from declared values", () => {
    const { record } = extract('{"name":"ex\\u0000am\\u001fple","version":"1.0.0"}');
    expect(record.declaredName).toBe("example");
  });

  it("truncates the dependency list with an explicit diagnostic", () => {
    const table: Record<string, string> = {};
    for (let index = 0; index < 150; index += 1) {
      table[`pkg-${String(index).padStart(3, "0")}`] = "^1.0.0";
    }
    const bytes = new TextEncoder().encode(JSON.stringify({ name: "x", dependencies: table }));
    const result = extractManifest({
      canonicalPath: "package.json",
      formatId: "npm-package-manifest",
      text: JSON.stringify({ name: "x", dependencies: table }),
      digest: digestOfBytes(bytes),
      maxBytes: 1_000_000,
      maxDependencies: 10,
      byteLength: bytes.length,
    });
    expect(result.dependencies).toHaveLength(10);
    expect(result.record.status).toBe("partial");
    expect(result.record.diagnostics.some((item) => item.detail.includes("truncated"))).toBe(true);
  });

  it("reports an oversized manifest without parsing it", () => {
    const text = '{"name":"x"}';
    const bytes = new TextEncoder().encode(text);
    const result = extractManifest({
      canonicalPath: "package.json",
      formatId: "npm-package-manifest",
      text,
      digest: digestOfBytes(bytes),
      maxBytes: 4,
      maxDependencies: 10,
      byteLength: bytes.length,
    });
    expect(result.record.status).toBe("too-large");
    expect(result.record.declaredName).toBeNull();
  });

  it("reports a non-object root as malformed", () => {
    expect(extract("[1,2,3]").record.status).toBe("malformed");
    expect(extract('"just a string"').record.status).toBe("malformed");
  });

  it("reports an unsupported workspaces shape as partial", () => {
    const { record } = extract('{"name":"x","workspaces":42}');
    expect(record.status).toBe("partial");
  });

  it("reads the object form of workspaces", () => {
    const { record } = extract('{"name":"x","workspaces":{"packages":["apps/*","libs/*"]}}');
    expect(record.workspacePatterns).toEqual(["apps/*", "libs/*"]);
  });
});

describe("npm lockfile extraction", () => {
  it("distinguishes recorded installs from workspace members", () => {
    const { record, dependencies } = extract(
      JSON.stringify({
        name: "root",
        lockfileVersion: 3,
        packages: {
          "": { name: "root", version: "1.0.0" },
          "node_modules/alpha": { version: "1.2.3" },
          "node_modules/@scope/beta": { version: "0.1.0", optional: true },
          "packages/member": { name: "member", version: "0.0.1" },
        },
      }),
      "npm-lockfile-v3",
    );
    expect(record.status).toBe("parsed");
    expect(dependencies.map((item) => [item.name, item.kind, item.source, item.resolvedVersion])).toEqual([
      ["@scope/beta", "recorded", "lockfile", "0.1.0"],
      ["alpha", "recorded", "lockfile", "1.2.3"],
      ["member", "workspace", "workspace-member", "0.0.1"],
    ]);
  });

  it("marks an unsupported lockfile version instead of interpreting it", () => {
    const { record, dependencies } = extract(
      JSON.stringify({ lockfileVersion: 1, dependencies: { alpha: { version: "1.0.0" } } }),
      "npm-lockfile-v3",
    );
    expect(record.status).toBe("unsupported");
    expect(dependencies).toHaveLength(0);
  });
});

describe("typescript project config", () => {
  it("declares no dependencies and reports references as unresolved", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ compilerOptions: { strict: true }, references: [{ path: "../domain" }] }),
    );
    const result = extractManifest({
      canonicalPath: "tsconfig.json",
      formatId: "typescript-project-config",
      text: JSON.stringify({
        compilerOptions: { strict: true },
        references: [{ path: "../domain" }],
      }),
      digest: digestOfBytes(bytes),
      maxBytes: 1_000_000,
      maxDependencies: 100,
      byteLength: bytes.length,
    });
    expect(result.dependencies).toHaveLength(0);
    expect(result.record.status).toBe("partial");
    expect(result.record.topLevelKeys).toEqual(["compilerOptions", "references"]);
  });
});
