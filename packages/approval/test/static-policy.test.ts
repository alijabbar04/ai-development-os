import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { importEdges, inspectProductionGraph } from "../scripts/import-graph.mjs";
import * as root from "../src/index.js";
import * as testing from "../src/testing/index.js";

describe("approval authority/export boundary", () => {
  it("keeps the sole runtime dependency and synthetic issuer separate", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.dependencies).toEqual({ "@ai-dev-os/project": "^0.1.0" });
    expect(Object.keys(manifest.exports)).toEqual([".", "./testing"]);
    expect(root.APPROVAL_PRODUCTION_ENABLED).toBe(false);
    expect(root.APPROVAL_AVAILABLE_COMMANDS).toEqual([]);
    expect(root.APPROVAL_RUNTIME_CAPABILITIES).toEqual([]);
    expect(root).not.toHaveProperty("issueSyntheticApprovalAuthorization");
    expect(root).not.toHaveProperty("createC7ApprovalStore");
    expect(testing.issueSyntheticApprovalAuthorization).toBeTypeOf("function");
  });
  it("parses static and dynamic syntax without mistaking comments or text for imports", () => {
    expect(importEdges('export * from "./a.js"; import "./b.js"; import("./c.js"); require("./d.js"); // import("./ignored.js")')).toEqual([
      { specifier: "./a.js", kind: "static" }, { specifier: "./b.js", kind: "static" },
      { specifier: "./c.js", kind: "dynamic" }, { specifier: "./d.js", kind: "dynamic" },
    ]);
    expect(() => importEdges("import(computed);")).toThrow("Computed import");
    expect(() => importEdges("require(computed);")).toThrow("Computed import");
    expect(() => importEdges('eval("arbitrary code")')).toThrow("Runtime-generated");
  });
  it.each(['export * from "./testing/index.js";', 'import("./testing/index.js");', 'import("./bridge.js");'])("detects planted forbidden reachability: %s", (planted) => {
    const approvalRoot = resolve("synthetic-approval"), projectRoot = resolve("synthetic-project");
    expect(() => inspectProductionGraph(approvalRoot, projectRoot, (file: string) =>
      file === resolve(approvalRoot, "dist/index.js") ? planted : 'import("./testing/index.js");')).toThrow("Forbidden testing reachability");
  });
  it("walks an allowed multi-hop graph and refuses external or escaping imports", () => {
    const a = resolve("synthetic-approval"), p = resolve("synthetic-project");
    const graph = inspectProductionGraph(a, p, (file: string) => file === resolve(a, "dist/index.js")
      ? 'export * from "./next.js"' : file === resolve(a, "dist/next.js") ? 'import("@ai-dev-os/project")' : "export const pure = true;");
    expect(graph.files).toHaveLength(3); expect(graph.dynamicEdges).toBe(1); expect(graph.staticEdges).toBe(1);
    expect(() => inspectProductionGraph(a, p, () => 'import "@ai-dev-os/approval/testing"')).toThrow("Forbidden production dependency");
    expect(() => inspectProductionGraph(a, p, () => 'import "../outside.js"')).toThrow("escaped");
  });
});
