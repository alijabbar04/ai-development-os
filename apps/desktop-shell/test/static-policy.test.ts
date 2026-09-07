import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function source(path: string): Promise<string> { return await readFile(join(root, path), "utf8"); }

function forbiddenRuntimeImport(text: string): boolean {
  return /from\s+["']@ai-dev-os\/(?:credential|secrets|provider|application|intake|plan|project)(?:[^"']*)["']/u.test(text.replaceAll("import type", "type-only"));
}

describe("desktop static policy", () => {
  it("contains no credential, provider, project-write, or effectful runtime composition", async () => {
    const files = [
      "src/main/application.ts", "src/main/ipc.ts", "src/service/controller.ts",
      "src/service/child.ts", "src/renderer/entry.ts", "src/renderer/components.ts",
    ];
    for (const file of files) expect(forbiddenRuntimeImport(await source(file)), file).toBe(false);
    expect(forbiddenRuntimeImport('import { revealSecret } from "@ai-dev-os/secrets";')).toBe(true);
  });

  it("keeps renderer networking and broad bridges structurally absent", async () => {
    const preload = await source("src/preload/desktop.cts");
    const renderer = `${await source("src/renderer/entry.ts")}\n${await source("src/renderer/components.ts")}`;
    const constants = await source("src/main/constants.ts");
    expect(constants).toContain('"connect-src \'none\'"');
    expect(preload).not.toMatch(/\b(?:openExternal|readFile|writeFile|exec|spawn|fetch)\s*\(/u);
    expect(preload).not.toMatch(/\{[^}]*\bshell\b[^}]*\}\s*=\s*require\(["']electron["']\)/u);
    expect(renderer).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/u);
    expect(preload).not.toContain("ipcRenderer.invoke(channel");
    expect(`${renderer}\nfetch('https://example.invalid')`).toMatch(/\bfetch\b/u);
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
