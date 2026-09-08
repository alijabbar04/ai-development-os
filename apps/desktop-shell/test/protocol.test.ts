import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { DESKTOP_RENDERER_FILES } from "../src/main/constants.js";
import { resolveDesktopProtocolRequest } from "../src/main/protocol.js";

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
