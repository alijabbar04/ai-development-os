import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function source(path: string): Promise<string> { return await readFile(join(root, path), "utf8"); }

type ImportPolicy = "none" | "renderer-planning-contracts" | "child-planning";

const RENDERER_PLANNING_CONTRACT_IMPORT = /import\s+type\s+\{[^}]+\}\s+from\s+["']@ai-dev-os\/application\/planning-contracts["']\s*;?/gu;
const NON_APPLICATION_TYPE_IMPORT = /import\s+type\s+\{[^}]+\}\s+from\s+["']@ai-dev-os\/(?:credential|secrets|provider|intake|plan|project)(?:[^"']*)["']\s*;?/gu;
const CHILD_PLANNING_IMPORT = /import\s+(?:type\s+)?\{[^}]+\}\s+from\s+["']@ai-dev-os\/application\/(?:planning|planning-storage)["']\s*;?/gu;
const GUARDED_PACKAGE_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']@ai-dev-os\/(?:credential|secrets|provider|application|intake|plan|project)(?:[^"']*)["']/u;

function forbiddenRuntimeImport(text: string, policy: ImportPolicy = "none"): boolean {
  const withoutNonExecutableTypes = text.replace(NON_APPLICATION_TYPE_IMPORT, "");
  const inspected = policy === "renderer-planning-contracts"
    ? withoutNonExecutableTypes.replace(RENDERER_PLANNING_CONTRACT_IMPORT, "")
    : policy === "child-planning"
      ? withoutNonExecutableTypes.replace(CHILD_PLANNING_IMPORT, "")
      : withoutNonExecutableTypes;
  return GUARDED_PACKAGE_IMPORT.test(inspected);
}

describe("desktop static policy", () => {
  it("contains no credential, provider, project-write, or effectful runtime composition", async () => {
    const executableFiles = ["src/main/application.ts", "src/main/ipc.ts", "src/service/controller.ts"];
    for (const file of executableFiles) expect(forbiddenRuntimeImport(await source(file)), file).toBe(false);
    expect(forbiddenRuntimeImport(await source("src/service/child.ts"), "child-planning"), "src/service/child.ts").toBe(false);
    const rendererFiles = ["src/renderer/entry.ts", "src/renderer/components.ts", "src/renderer/ai-planning.ts", "src/renderer/planning-edit-buffer.ts", "src/presentation/adapter.ts", "src/shared/planning-ipc.ts"];
    for (const file of rendererFiles) expect(forbiddenRuntimeImport(await source(file), "renderer-planning-contracts"), file).toBe(false);

    expect(forbiddenRuntimeImport('import type { PlanningCommand } from "@ai-dev-os/application/planning-contracts";', "renderer-planning-contracts")).toBe(false);
    expect(forbiddenRuntimeImport('import { PlanningCommand } from "@ai-dev-os/application/planning-contracts";', "renderer-planning-contracts")).toBe(true);
    expect(forbiddenRuntimeImport('import type { PlanningCommand } from "@ai-dev-os/application";', "renderer-planning-contracts")).toBe(true);
    expect(forbiddenRuntimeImport('import type { ProjectPlan } from "@ai-dev-os/plan";', "renderer-planning-contracts")).toBe(false);
    expect(forbiddenRuntimeImport('import { ProjectPlan } from "@ai-dev-os/plan";', "renderer-planning-contracts")).toBe(true);
    expect(forbiddenRuntimeImport('import { openPlanningStorage } from "@ai-dev-os/application/planning-storage";', "child-planning")).toBe(false);
    expect(forbiddenRuntimeImport('import { createPlanningWorkspace } from "@ai-dev-os/application/planning";', "child-planning")).toBe(false);
    expect(forbiddenRuntimeImport('import { createProductionDisabledApplication } from "@ai-dev-os/application";', "child-planning")).toBe(true);
    expect(forbiddenRuntimeImport('import { revealSecret } from "@ai-dev-os/secrets";')).toBe(true);
    expect(forbiddenRuntimeImport('const secret = await import("@ai-dev-os/secrets");')).toBe(true);
    expect(forbiddenRuntimeImport('const secret = require("@ai-dev-os/secrets");')).toBe(true);
  });

  it("keeps renderer networking and broad bridges structurally absent", async () => {
    const preload = await source("src/preload/desktop.cts");
    const renderer = `${await source("src/renderer/entry.ts")}\n${await source("src/renderer/components.ts")}\n${await source("src/renderer/ai-planning.ts")}\n${await source("src/renderer/planning-edit-buffer.ts")}\n${await source("src/presentation/adapter.ts")}`;
    const constants = await source("src/main/constants.ts");
    expect(constants).toContain('"connect-src \'none\'"');
    expect(preload).not.toMatch(/\b(?:openExternal|readFile|writeFile|exec|spawn|fetch)\s*\(/u);
    expect(preload).not.toMatch(/\{[^}]*\bshell\b[^}]*\}\s*=\s*require\(["']electron["']\)/u);
    expect(renderer).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/u);
    expect(renderer).not.toMatch(/\b(?:operatorConfirmed|approverClass|identityRef|repositoryPath|rootPath)\b/u);
    expect(preload).not.toContain("ipcRenderer.invoke(channel");
    expect(`${renderer}\nfetch('https://example.invalid')`).toMatch(/\bfetch\b/u);
    expect(`${renderer}\nconst operatorConfirmed = true;`).toMatch(/\boperatorConfirmed\b/u);
  });

  it("keeps the synthetic inference fixture outside production launch switches", async () => {
    const normal = `${await source("src/main/startup.ts")}\n${await source("scripts/launch-desktop.mjs")}`;
    expect(normal).not.toContain("aiPlanningFixtureForTest");
    expect(normal).not.toContain("ai-planning-child");
    const child = await source("src/service/child.ts");
    expect(child).toContain("runOwnedServiceChild();");
    expect(child).not.toMatch(/process\.env\[[^\]]*(?:AI|PLANNING|PROVIDER)/u);
    const fixture = await source("src/testing/ai-planning-child.ts");
    expect(fixture).toContain('"owned-ai-planning-user-data"');
    expect(fixture).toContain('"owned-synthetic-ai-planning"');
    expect(fixture).not.toMatch(/\b(?:spawn|execFile|fetch)\s*\(/u);
  });

  it("pins accessibility, scaling and non-animation contracts", async () => {
    const html = await source("src/renderer/index.html");
    const css = await source("src/renderer/styles.css");
    expect(html).toContain('aria-label="Workspace"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-labelledby="dialog-title"');
    expect(css).toContain(":focus-visible");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("forced-colors: active");
    expect(css).not.toMatch(/animation-name\s*:/u);
  });
});
