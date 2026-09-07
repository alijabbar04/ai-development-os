import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type EnvironmentBuilder = (source: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;

describe("desktop Electron launcher", () => {
  it("removes inherited Node mode and credential-like environment values", async () => {
    const module = await import("../scripts/electron-environment.mjs") as { desktopElectronEnvironment: EnvironmentBuilder };
    const result = module.desktopElectronEnvironment({
      PATH: "C:\\Windows\\System32",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--inspect",
      ANTHROPIC_API_KEY: "must-not-cross",
      INTERNAL_TOKEN: "must-not-cross",
    });
    expect(result).toMatchObject({ PATH: "C:\\Windows\\System32", NODE_ENV: "production" });
    expect(result).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(result).not.toHaveProperty("NODE_OPTIONS");
    expect(result).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(result).not.toHaveProperty("INTERNAL_TOKEN");
  });

  it("routes the documented start command through the sanitized launcher", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { scripts?: Record<string, string> };
    const launcher = await readFile(new URL("../scripts/launch-desktop.mjs", import.meta.url), "utf8");
    expect(manifest.scripts?.["start"]).toBe("node scripts/launch-desktop.mjs");
    expect(launcher).toContain("windowsHide: false");
  });
});
