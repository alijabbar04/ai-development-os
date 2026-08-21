import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { app, BrowserWindow } from "electron";

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (value === undefined || value.length === 0) throw new Error(`PACKED_ARGUMENT_MISSING_${name.toUpperCase().replaceAll("-", "_")}`);
  return resolve(value);
}

function withinTemporary(path) {
  const temporary = resolve(tmpdir());
  const rel = relative(temporary, path);
  return rel !== "" && !rel.startsWith("..") && resolve(temporary, rel) === path;
}

const root = argument("packed-root");
const reportPath = argument("packed-report");
if (!withinTemporary(root) || !withinTemporary(reportPath)) throw new Error("PACKED_PATH_OUTSIDE_TEMP");
app.setPath("appData", resolve(root, "app-data"));
app.setPath("userData", resolve(root, "user-data"));

async function waitForWindow() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (window !== undefined) return window;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("PACKED_WINDOW_TIMEOUT");
}

async function run() {
  let result = { ok: false, code: "PACKED_RUNTIME_FAILED" };
  try {
    await import("./dist/main/main.js");
    await app.whenReady();
    const window = await waitForWindow();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const ready = await window.webContents.executeJavaScript(`document.querySelectorAll(".provider-card").length === 4`, true).catch(() => false);
      if (ready === true) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    const renderer = await window.webContents.executeJavaScript(`(() => ({
      url: location.href,
      providerCards: document.querySelectorAll(".provider-card").length,
      passwordInputs: document.querySelectorAll('input[type="password"]').length,
      productionDisabled: document.body.textContent?.includes("tasks do not run against providers") ?? false,
      bridge: Object.keys(window.credentialVault ?? {}).sort(),
      nodeGlobals: [typeof process, typeof require, typeof module]
    }))()`, true);
    result = {
      ok: renderer.url === "app-credential://entry/index.html"
        && renderer.providerCards === 4
        && renderer.passwordInputs === 0
        && renderer.productionDisabled === true
        && JSON.stringify(renderer.bridge) === JSON.stringify(["cancel", "describe", "remove", "rotate", "save", "setEnabled", "validate"])
        && JSON.stringify(renderer.nodeGlobals) === JSON.stringify(["undefined", "undefined", "undefined"]),
      electronVersion: process.versions.electron,
      appDataPath: app.getPath("appData"),
      userDataPath: app.getPath("userData"),
      renderer,
    };
  } catch {
    result = { ok: false, code: "PACKED_RUNTIME_FAILED" };
  } finally {
    await writeFile(reportPath, JSON.stringify(result, null, 2), "utf8");
    if (result.ok && app.isReady()) {
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.close();
      setTimeout(() => app.exit(0), 5_000);
    } else if (app.isReady()) app.exit(1);
    else process.exitCode = 1;
  }
}

void run();
