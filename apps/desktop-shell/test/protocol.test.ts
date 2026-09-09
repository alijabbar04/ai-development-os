import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ImportType, init, parse } from "es-module-lexer";
import { DESKTOP_PROTOCOL_ORIGIN, DESKTOP_RENDERER_FILES } from "../src/main/constants.js";
import { resolveDesktopProtocolRequest } from "../src/main/protocol.js";

// The maintained pretest builds dist. Follow the actual compiled modules that
// the browser loads, rather than iterating only the server's own allowlist.
async function compiledRendererGraph(applicationRoot: string, source = (target: string): Promise<string> => readFile(target, "utf8")): Promise<ReadonlySet<string>> {
  await init;
  const seen = new Set<string>(), pending = [`${DESKTOP_PROTOCOL_ORIGIN}/renderer/entry.js`];
  while (pending.length > 0) {
    const url = pending.shift()!;
    if (seen.has(url)) continue;
    const result = resolveDesktopProtocolRequest(url, applicationRoot);
    if (result.status !== 200 || result.target === null || result.contentType !== "text/javascript; charset=utf-8") throw new Error(`COMPILED_RENDERER_MODULE_UNAVAILABLE:${new URL(url).pathname}`);
    const [imports] = parse(await source(result.target), result.target);
    seen.add(url);
    for (const imported of imports) {
      if (imported.t === ImportType.ImportMeta) continue;
      if (imported.n === undefined || !/^\.{1,2}\//u.test(imported.n)) throw new Error(`COMPILED_RENDERER_IMPORT_NOT_LOCAL_LITERAL:${new URL(url).pathname}`);
      pending.push(new URL(imported.n, url).href);
    }
  }
  return seen;
}

describe("desktop protocol", () => {
  const root = resolve("desktop-shell-protocol-fixture");

  it("resolves every exact allowlisted renderer asset", () => {
    for (const name of DESKTOP_RENDERER_FILES) {
      const result = resolveDesktopProtocolRequest(`app-ai-powerhouse://workspace/${name}`, root);
      expect(result.status, name).toBe(200);
      expect(result.target, name).toBe(resolve(root, "dist", name));
      expect(result.contentType, name).toMatch(/^(?:text\/html|text\/css|text\/javascript)/u);
    }
  });

  it("serves the actual compiled entry and complete local import graph as JavaScript", async () => {
    const applicationRoot = fileURLToPath(new URL("..", import.meta.url));
    const modules = await compiledRendererGraph(applicationRoot);
    expect(modules.has(`${DESKTOP_PROTOCOL_ORIGIN}/renderer/ai-planning.js`)).toBe(true);
    expect(modules.has(`${DESKTOP_PROTOCOL_ORIGIN}/renderer/planning-edit-buffer.js`)).toBe(true);
    expect(modules.has(`${DESKTOP_PROTOCOL_ORIGIN}/presentation/adapter.js`)).toBe(true);
  });

  it("detects a planted missing transitive module without modifying built assets or the allowlist", async () => {
    const applicationRoot = fileURLToPath(new URL("..", import.meta.url)), nestedModule = resolve(applicationRoot, "dist", "renderer", "ai-planning.js");
    await expect(compiledRendererGraph(applicationRoot, async target => {
      const original = await readFile(target, "utf8");
      return target === nestedModule ? `${original}\nexport { sentinel } from './missing-protocol-control.js';\n` : original;
    })).rejects.toThrow("COMPILED_RENDERER_MODULE_UNAVAILABLE:/renderer/missing-protocol-control.js");
  });

  it.each(["renderer/unlisted.js", "main/startup.js", "service/child.js", "testing/ai-planning-child.js"])("keeps non-allowlisted compiled paths inaccessible: %s", name => {
    expect(resolveDesktopProtocolRequest(`${DESKTOP_PROTOCOL_ORIGIN}/${name}`, root)).toEqual({ status: 404, target: null, contentType: null });
  });

  it.each([
    "app-ai-powerhouse://workspace/renderer/../main/startup.js",
    "app-ai-powerhouse://workspace/renderer/%2e%2e/main/startup.js",
    "app-ai-powerhouse://workspace/renderer/%5c..%5cmain%5cstartup.js",
  ])("refuses traversal: %s", (url) => {
    expect(resolveDesktopProtocolRequest(url, root).status).not.toBe(200);
  });

  it.each([
    "app-ai-powerhouse://other/renderer/index.html",
    "app-ai-powerhouse://workspace/renderer/index.html?debug=1",
    "app-ai-powerhouse://workspace/renderer/index.html#fragment",
    "app-ai-powerhouse://user@workspace/renderer/index.html",
    "https://workspace/renderer/index.html",
    "not a url",
  ])("refuses an unexpected protocol envelope: %s", (url) => {
    expect(resolveDesktopProtocolRequest(url, root).status).toBe(404);
  });

  it("has a planted traversal control", () => {
    const brokenAllowlist = (url: string): number => url.includes("main/startup.js") ? 200 : 404;
    expect(brokenAllowlist("app-ai-powerhouse://workspace/renderer/../main/startup.js")).toBe(200);
    expect(resolveDesktopProtocolRequest("app-ai-powerhouse://workspace/renderer/../main/startup.js", root).status).not.toBe(200);
  });
});
