import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { app, protocol } from "electron";
import { launchDesktopApplication } from "../main/application.js";
import { registerDesktopProtocolScheme } from "../main/protocol.js";

type SmokeMode = "default" | "reduced" | "forced";

function argument(name: string): string | null {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (value === null) throw new Error("SMOKE_ARGUMENT_MISSING");
  return value;
}

function modeOf(value: string | null): SmokeMode {
  if (value === "default" || value === "reduced" || value === "forced") return value;
  throw new Error("SMOKE_MODE_INVALID");
}

async function rendererValue<T>(script: string): Promise<T> {
  return await handle.window.webContents.executeJavaScript(script, true) as T;
}

async function settle(): Promise<void> { await new Promise((resolveWait) => setTimeout(resolveWait, 80)); }
function progress(value: string): void { process.stdout.write(`smoke:${mode}:${value}\n`); }

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("SMOKE_CONDITION_TIMEOUT");
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
}

async function waitForRenderer(predicate: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await rendererValue<boolean>(predicate))) {
    if (Date.now() >= deadline) throw new Error("SMOKE_RENDERER_CONDITION_TIMEOUT");
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
}

async function captureEvidence(name: string): Promise<void> {
  handle.window.setContentProtection(false);
  try {
    const screenshot = await handle.window.webContents.capturePage();
    const size = screenshot.getSize();
    assertions[`screenshot-${name}`] = !screenshot.isEmpty() && size.width >= 1_000 && size.height >= 650;
    await writeFile(join(evidenceRoot!, name), screenshot.toPNG());
  } finally {
    handle.window.setContentProtection(true);
  }
}

const smokeRoot = requiredArgument("smoke-root");
const reportPath = requiredArgument("smoke-report");
const evidenceRoot = requiredArgument("evidence-root");
const mode = modeOf(argument("smoke-mode"));
app.commandLine.appendSwitch("user-data-dir", resolve(smokeRoot, "chromium-user-data"));
if (mode === "reduced") app.commandLine.appendSwitch("force-prefers-reduced-motion", "reduce");
if (mode === "forced") app.commandLine.appendSwitch("force-high-contrast");
app.on("window-all-closed", () => { /* The smoke writes shutdown assertions after closing the window. */ });
registerDesktopProtocolScheme(protocol);

const failures: string[] = [];
const assertions: Record<string, boolean | number | string> = Object.create(null) as Record<string, boolean | number | string>;
let handle!: Awaited<ReturnType<typeof launchDesktopApplication>>;

async function runSmoke(): Promise<void> {
try {
  progress("launching");
  handle = await launchDesktopApplication({
    userDataRoot: resolve(smokeRoot, "user-data"),
    serviceReadyDeadlineMs: 10_000,
    shutdownDeadlineMs: 3_000,
    onStartupPhase: (phase) => progress(`startup-${phase}`),
  });
  progress("visible");
  const ready = await handle.waitForState("ready", 12_000);
  progress("service-ready");
  assertions["visible-before-deadline"] = handle.visibleElapsedMs < 30_000;
  assertions["service-ready"] = ready.state === "ready";
  assertions["owned-synthetic-source"] = ready.observation?.dataSource === "owned-synthetic-development-service";
  assertions["verification-connection-closed"] = ready.observation?.verification === "identity-verified-connection-closed";
  assertions["authority-none"] = ready.authority === "none" && ready.commands.length === 0;
  assertions["window-minimum"] = handle.window.getMinimumSize().join("x") === "1024x720";
  assertions["renderer-node-absent"] = await rendererValue<boolean>("typeof process === 'undefined' && typeof require === 'undefined'");
  assertions["renderer-network-blocked"] = await rendererValue<boolean>("fetch('https://example.invalid/').then(() => false, () => true)");
  if (mode === "forced") {
    handle.window.webContents.debugger.attach("1.3");
    await handle.window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "forced-colors", value: "active" }],
    });
  }
  assertions["mode-media"] = mode === "reduced"
    ? await rendererValue<boolean>("matchMedia('(prefers-reduced-motion: reduce)').matches")
    : mode === "forced"
      ? await rendererValue<boolean>("matchMedia('(forced-colors: active)').matches")
      : true;
  if (mode === "forced" && handle.window.webContents.debugger.isAttached()) handle.window.webContents.debugger.detach();

  await mkdir(evidenceRoot, { recursive: true });
  if (mode === "default") {
    await settle();
    await captureEvidence("01-home-ready.png");

    handle.window.focus();
    handle.window.webContents.focus();
    await rendererValue("document.querySelector('[data-route=home]').focus(); true");
    handle.window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Down" });
    handle.window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Down" });
    await settle();
    assertions["keyboard-navigation"] = await rendererValue<string>("document.activeElement?.getAttribute('data-route') ?? ''") === "projects";

    await rendererValue("document.querySelector('[data-route=projects]').click(); true");
    await settle();
    const longText = "A long, bounded project description. ".repeat(45);
    await rendererValue(`(() => { const field = document.querySelector('#intake-description'); field.value = ${JSON.stringify(longText)}; field.dispatchEvent(new Event('input', { bubbles: true })); return field.getAttribute('aria-label') ?? document.querySelector('label[for=intake-description]')?.textContent ?? ''; })()`);
    handle.window.webContents.setZoomFactor(1.25);
    handle.window.setSize(1_024, 720);
    await settle();
    assertions["scaling-no-horizontal-overflow"] = await rendererValue<boolean>("document.documentElement.scrollWidth <= document.documentElement.clientWidth");
    assertions["intake-accessible-name"] = await rendererValue<string>("document.querySelector('label[for=intake-description]')?.textContent ?? ''") === "What would you like to build?";
    handle.window.webContents.setZoomFactor(1);
    handle.window.setSize(1_280, 800);
    await settle();
    await captureEvidence("02-projects-example.png");

    await rendererValue("document.querySelector('[data-route=approvals]').click(); [...document.querySelectorAll('button')].find((button) => button.textContent === 'Inspect example').click(); true");
    await settle();
    assertions["dialog-labelled"] = await rendererValue<boolean>("document.querySelector('#detail-dialog').open && document.querySelector('#detail-dialog').getAttribute('aria-labelledby') === 'dialog-title'");
    assertions["dialog-focus"] = await rendererValue<string>("document.activeElement?.id ?? ''") === "dialog-close";
    await captureEvidence("03-approval-dialog.png");
    handle.window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    handle.window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await settle();
    assertions["dialog-focus-restored"] = await rendererValue<string>("document.activeElement?.textContent ?? ''") === "Inspect example";

    const firstPid = handle.service.ownedProcessIdForTest();
    await handle.service.terminateOwnedChildForTest();
    const lost = await handle.waitForState("service-lost", 5_000);
    assertions["service-loss-visible"] = lost.observation?.freshness === "stale";
    await rendererValue("document.querySelector('[data-route=home]').click(); true");
    await settle();
    await captureEvidence("04-service-lost.png");
    await rendererValue("[...document.querySelectorAll('button')].find((button) => button.textContent === 'Retry service').click(); true");
    await handle.waitForState("ready", 10_000);
    assertions["service-retry-new-child"] = handle.service.ownedProcessIdForTest() !== firstPid;

    await rendererValue("document.querySelector('[data-route=settings]').click(); true");
    await settle();
    assertions["settings-no-secret-input"] = await rendererValue<number>("document.querySelectorAll('input[type=password], input[name*=secret i], textarea[name*=secret i]').length") === 0;
    await rendererValue("document.querySelector('#presentation-mode').value = 'developer'; [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save presentation settings').click(); true");
    await waitFor(() => handle.snapshot().preferences.presentationMode === "developer" && handle.snapshot().state === "ready", 12_000);
    await waitForRenderer("document.querySelector('#service-pill')?.dataset.status === 'ready' && document.querySelector('#mode-pill')?.textContent === 'Developer'", 5_000);
    assertions["developer-authority-parity"] = handle.snapshot().authority === "none" && handle.snapshot().commands.length === 0 && handle.snapshot().diagnostics !== null;
    await settle();
    await captureEvidence("05-settings.png");
    progress("journey-complete");
  }

  const rendererText = await rendererValue<string>("document.body.textContent");
  assertions["no-boundary-leak"] = !/(?:bearerToken|startNonce|Authorization: Bearer|owned-service-)/u.test(rendererText);
  for (const [name, passed] of Object.entries(assertions)) if (passed !== true) failures.push(name);
  const runtimeRoot = handle.service.ownedRuntimeRootForTest();
  const finalPid = handle.service.ownedProcessIdForTest();
  progress("closing");
  await handle.close();
  progress("closed");
  assertions["owned-shutdown"] = handle.service.ownedProcessIdForTest() === null;
  assertions["runtime-root-cleared"] = runtimeRoot === null || !(await import("node:fs")).existsSync(runtimeRoot);
  assertions["owned-process-ended"] = finalPid === null || (() => { try { process.kill(finalPid, 0); return false; } catch { return true; } })();
  for (const name of ["owned-shutdown", "runtime-root-cleared", "owned-process-ended"]) if (assertions[name] !== true) failures.push(name);
} catch (error) {
  failures.push(error instanceof Error && /^[A-Z0-9_-]{1,80}$/u.test(error.message) ? error.message : "UNCLASSIFIED_SMOKE_FAILURE");
  if (typeof handle !== "undefined") await handle.close().catch(() => undefined);
}

await mkdir(dirname(resolve(reportPath)), { recursive: true }).catch(() => undefined);
await writeFile(reportPath, `${JSON.stringify({ schemaVersion: 1, mode, assertions, failures }, null, 2)}\n`, "utf8");
progress("report-written");
app.exit(failures.length === 0 ? 0 : 1);
}

void runSmoke().catch(() => app.exit(1));
