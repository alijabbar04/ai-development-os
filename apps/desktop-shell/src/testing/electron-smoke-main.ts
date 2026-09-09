import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { app, BrowserWindow, protocol } from "electron";
import type { PlanningProjectView, PlanningWorkspaceView } from "@ai-dev-os/application/planning-contracts";
import { launchDesktopApplication, type DesktopApplicationHandle } from "../main/application.js";
import { nativePlanningDialog } from "../main/planning-dialog.js";
import { nativeConfirmationResult } from "./native-confirmation-result.js";
import { registerDesktopProtocolScheme } from "../main/protocol.js";
import type { NativePlanningReply, NativePlanningRequest } from "../shared/planning-ipc.js";
import { runRendererHandoverViewerCheck, runRendererHistoricalJourney, runRendererSavedJourney, type RendererSavedJourneyDriver } from "./renderer-saved-journey.js";

type SmokeMode = "default" | "reduced" | "forced";
type SmokePhase = "create" | "reopen" | "history";

interface DurableBaseline {
  readonly projectIds: readonly string[];
  readonly selectedProjectId: string;
  readonly projectVersion: number;
  readonly stopped: boolean;
  readonly brief: Readonly<{ briefId: string; version: number; digest: string }>;
  readonly plan: Readonly<{ planId: string; version: number; revision: number; digest: string; state: string; sealedByApprovalId: string | null }>;
  readonly approvalCount: number;
  readonly approvalIds: readonly string[];
  readonly approvalStates: readonly string[];
  readonly handoverCount: number;
  readonly handoverIds: readonly string[];
  readonly handoverResultAttributions: readonly (string | null)[];
  readonly historyCount: number;
  readonly historyEventIds: readonly string[];
}

interface SmokeReport {
  readonly schemaVersion: 2;
  readonly phase: SmokePhase;
  readonly mode: SmokeMode;
  readonly provenance: string;
  readonly assertions: Readonly<Record<string, boolean>>;
  readonly baseline: DurableBaseline | null;
  readonly historicalFixtureProvenance: string | null;
  readonly historyReconciled: Readonly<{ approvalId: string; projectId: string; spendingState: string; stillStopped: boolean; planUnchanged: boolean }> | null;
  readonly nativeReviewActions: readonly string[];
  readonly diagnostics: Readonly<{ lastJourneyStep: string | null; partialJourneyAssertions: Readonly<Record<string, boolean>>; errorMessage: string | null; errorStack: string | null; rendererState: string | null; planningState: string | null }>;
  readonly shutdown: Readonly<{ requested: boolean; handleCloseResolved: boolean; ownedProcessEnded: boolean; runtimeRootCleared: boolean; explicitReceipt: boolean }>;
  readonly failures: readonly string[];
}

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
function phaseOf(value: string | null): SmokePhase {
  if (value === "create" || value === "reopen" || value === "history") return value;
  throw new Error("SMOKE_PHASE_INVALID");
}
function scrubDiagnostic(value: string, maximum: number): string {
  if (/(?:bearerToken|startNonce|Authorization:\s*Bearer)/iu.test(value)) return "BOUNDARY_MATERIAL_REFUSED";
  return value.slice(0, maximum);
}
function safeFailure(error: unknown): string {
  return scrubDiagnostic(error instanceof Error ? error.message : String(error), 1_000) || "UNCLASSIFIED_SMOKE_FAILURE";
}

const smokeRoot = resolve(requiredArgument("smoke-root"));
const reportPath = resolve(requiredArgument("smoke-report"));
const evidenceRoot = resolve(requiredArgument("evidence-root"));
const repositoryRoot = resolve(requiredArgument("repository-root"));
const baselineReportPath = argument("baseline-report");
const mode = modeOf(argument("smoke-mode"));
const phase = phaseOf(argument("smoke-phase"));
const provenance = "native folder/result selections are synthetic; actual main-owned confirmation window/preload/IPC/application/child/SQLite real, confirmation buttons automated";

app.commandLine.appendSwitch("user-data-dir", resolve(smokeRoot, "chromium-user-data"));
if (mode === "reduced") app.commandLine.appendSwitch("force-prefers-reduced-motion", "reduce");
if (mode === "forced") app.commandLine.appendSwitch("force-high-contrast");
app.on("window-all-closed", () => { /* The report is written after explicit owned shutdown. */ });
registerDesktopProtocolScheme(protocol);

const assertions: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
const failures: string[] = [];
const nativeReviewActions: string[] = [];
const selectedCaptures = new Set(["01-saved-project", "03-sealed-plan", "04-unknown-export", "05-untrusted-result", "08-large-text"]);
let evidenceBytes = 0;
let evidenceFiles = 0;
let nativeRepositorySelections = 0;
let nativeResultSelections = 0;
let nativeConfirmationCaptured = false;
let handle: DesktopApplicationHandle | null = null;
let restartPriorPid: number | null = null;
let baseline: DurableBaseline | null = null;
let historicalFixtureProvenance: string | null = null;
let historyReconciled: SmokeReport["historyReconciled"] = null;
let shutdown = { requested: false, handleCloseResolved: false, ownedProcessEnded: false, runtimeRootCleared: false, explicitReceipt: false };
let lastJourneyStep: string | null = null;
let partialJourneyAssertions: Readonly<Record<string, boolean>> = Object.freeze({});
let errorMessage: string | null = null;
let errorStack: string | null = null;
let failureRendererState: string | null = null;
let failurePlanningState: string | null = null;

function progress(value: string): void { process.stdout.write(`smoke:${phase}:${mode}:${value}\n`); }
async function rendererValue<T>(script: string): Promise<T> {
  if (handle === null) throw new Error("SMOKE_HANDLE_UNAVAILABLE");
  return await handle.window.webContents.executeJavaScript(script, true) as T;
}
async function waitFor(predicate: () => boolean, timeoutMs: number, code = "SMOKE_CONDITION_TIMEOUT"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(code);
}
async function waitForRenderer(predicate: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await rendererValue<boolean>(predicate)) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("SMOKE_RENDERER_CONDITION_TIMEOUT");
}
async function settle(): Promise<void> { await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100)); }
function accumulateAssertion(name: string, passed: boolean): void { assertions[name] = (assertions[name] ?? true) && passed; }
async function boundedOperation<T>(operation: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(code)), timeoutMs); })]);
  } finally { if (timer !== null) clearTimeout(timer); }
}
async function waitForConfirmationDocument(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // A newly created modal can still be hidden/loading. Never drive its initial
    // document, or let an unresolved script outlive this existing readiness bound.
    if (window.isDestroyed()) throw new Error("SMOKE_CONFIRMATION_CLOSED");
    if (window.isVisible() && !window.webContents.isLoadingMainFrame()
      && await boundedOperation(window.webContents.executeJavaScript("document.querySelector('#native-confirm') instanceof HTMLButtonElement && document.querySelector('#native-review-content') instanceof HTMLElement && document.activeElement?.id === 'native-cancel'", true), deadline - Date.now(), "SMOKE_CONFIRMATION_DOCUMENT_SCRIPT_TIMEOUT") as boolean) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 40));
  }
  throw new Error("SMOKE_CONFIRMATION_DOCUMENT_TIMEOUT");
}
async function waitForConfirmationWindow(parent: BrowserWindow): Promise<BrowserWindow> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const child = BrowserWindow.getAllWindows().find((candidate) => candidate.getParentWindow() === parent);
    if (child !== undefined) return child;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 40));
  }
  throw new Error("SMOKE_CONFIRMATION_WINDOW_TIMEOUT");
}
function boundedFixtureDiagnostic(value: unknown): string {
  const encoded = JSON.stringify(value) ?? "null";
  return scrubDiagnostic(encoded, 20_000);
}
async function captureFailureDiagnostics(): Promise<void> {
  if (handle === null) return;
  try {
    const state = await boundedOperation(rendererValue<unknown>(`(() => ({
      route: Array.from(document.querySelectorAll("[data-route]" )).find((item) => item.getAttribute("aria-current") === "page")?.getAttribute("data-route") ?? null,
      mainBusy: document.querySelector("main")?.getAttribute("aria-busy") ?? null,
      commandStatus: document.querySelector(".command-status")?.textContent?.slice(0, 2000) ?? null,
      briefObjective: document.querySelector("#brief-objective") instanceof HTMLTextAreaElement ? document.querySelector("#brief-objective").value : null,
      candidateCards: Array.from(document.querySelectorAll(".card")).filter((card) => card.querySelector("h2")?.textContent?.trim() === "Brief candidate").map((card) => ({ heading: card.querySelector("h3")?.textContent?.trim() ?? null, text: card.textContent?.slice(0, 3000) ?? "", buttons: Array.from(card.querySelectorAll("button")).map((button) => ({ text: button.textContent?.trim() ?? "", disabled: button.disabled, allowed: button.dataset.planningAllowed ?? null, title: button.title })) })),
    }))()`), 3_000, "SMOKE_FAILURE_RENDERER_DIAGNOSTIC_TIMEOUT");
    failureRendererState = boundedFixtureDiagnostic(state);
  } catch (error) { failureRendererState = boundedFixtureDiagnostic({ diagnosticError: safeFailure(error) }); }
  try {
    const listed = await boundedOperation(workspace(null), 3_000, "SMOKE_FAILURE_PLANNING_DIAGNOSTIC_TIMEOUT"), projectId = listed.projects[0]?.projectId ?? null;
    const selected = projectId === null ? null : (await boundedOperation(workspace(projectId), 3_000, "SMOKE_FAILURE_PROJECT_DIAGNOSTIC_TIMEOUT")).selected;
    failurePlanningState = boundedFixtureDiagnostic({ projectCount: listed.projects.length, projectId, projectName: selected?.name ?? null, stopped: selected?.stopped ?? null,
      candidate: selected?.candidate === null || selected?.candidate === undefined ? null : { objective: selected.candidate.objective, ready: selected.candidate.ready, questionCount: selected.candidate.questions.length, questions: selected.candidate.questions.map((question) => question.question).slice(0, 8) },
      briefVersion: selected?.brief?.version ?? 0, planState: selected?.plan?.state ?? null });
  } catch (error) { failurePlanningState = boundedFixtureDiagnostic({ diagnosticError: safeFailure(error) }); }
}

function selectedWorkspace(value: unknown): PlanningWorkspaceView {
  if (value === null || typeof value !== "object" || (value as { source?: unknown }).source !== "saved-local-planning") throw new Error("SMOKE_WORKSPACE_INVALID");
  return value as PlanningWorkspaceView;
}
async function workspace(projectId: string | null): Promise<PlanningWorkspaceView> {
  if (handle === null) throw new Error("SMOKE_HANDLE_UNAVAILABLE");
  return selectedWorkspace(await handle.service.planning({ kind: "snapshot", projectId }));
}
function durableBaseline(value: PlanningWorkspaceView): DurableBaseline {
  const project = value.selected;
  if (project === null || project.brief === null || project.plan === null) throw new Error("SMOKE_DURABLE_BASELINE_INCOMPLETE");
  return Object.freeze({
    projectIds: Object.freeze(value.projects.map((item) => item.projectId)),
    selectedProjectId: project.projectId,
    projectVersion: project.version,
    stopped: project.stopped,
    brief: Object.freeze({ briefId: project.brief.briefId, version: project.brief.version, digest: project.brief.digest }),
    plan: Object.freeze({ planId: project.plan.planId, version: project.plan.version, revision: project.plan.revision, digest: project.plan.digest, state: project.plan.state, sealedByApprovalId: project.plan.sealedByApprovalId }),
    approvalCount: project.approvals.length,
    approvalIds: Object.freeze(project.approvals.map((item) => item.approvalId)),
    approvalStates: Object.freeze(project.approvals.map((item) => item.state)),
    handoverCount: project.handovers.length,
    handoverIds: Object.freeze(project.handovers.map((item) => item.handoverId)),
    handoverResultAttributions: Object.freeze(project.handovers.map((item) => item.result?.attribution ?? null)),
    historyCount: project.history.length,
    historyEventIds: Object.freeze(project.history.map((item) => item.eventId)),
  });
}
async function readExpectedBaseline(): Promise<DurableBaseline> {
  if (baselineReportPath === null) throw new Error("SMOKE_BASELINE_REPORT_MISSING");
  const parsed = JSON.parse(await readFile(resolve(baselineReportPath), "utf8")) as { baseline?: unknown };
  if (parsed.baseline === null || typeof parsed.baseline !== "object") throw new Error("SMOKE_BASELINE_INVALID");
  return parsed.baseline as DurableBaseline;
}

interface HistoricalFixture {
  readonly schemaVersion: 1;
  readonly approvalId: string;
  readonly approvalDigest: string;
  readonly consumptionCount: 1;
  readonly amountMinorUnits: 500;
  readonly currency: "GBP";
  readonly fixtureProvenance: string;
  readonly projectId: string;
  readonly project: PlanningProjectView;
  readonly originalPlan: PlanningProjectView["plan"];
  readonly originalScopeApproval: PlanningProjectView["approvals"][number];
}
async function readHistoricalFixture(): Promise<HistoricalFixture> {
  const path = join(smokeRoot, "historical-fixture.json"), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > 1_048_576) throw new Error("SMOKE_HISTORY_FIXTURE_INVALID");
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<HistoricalFixture>;
  if (parsed.schemaVersion !== 1 || typeof parsed.approvalId !== "string" || typeof parsed.approvalDigest !== "string" || parsed.consumptionCount !== 1 || parsed.amountMinorUnits !== 500 || parsed.currency !== "GBP"
    || parsed.fixtureProvenance !== "synthetic historical consumed pair and optional Project binding drift; no external activity" || typeof parsed.projectId !== "string" || parsed.project === null || typeof parsed.project !== "object"
    || parsed.originalPlan === null || typeof parsed.originalPlan !== "object" || parsed.originalScopeApproval === null || typeof parsed.originalScopeApproval !== "object") throw new Error("SMOKE_HISTORY_FIXTURE_CONTRACT_INVALID");
  return parsed as HistoricalFixture;
}

async function createManualResult(): Promise<Readonly<{ name: string; text: string }>> {
  const artifactRoot = resolve(smokeRoot, "user-data", "saved-workspace", "artifacts");
  const names = (await readdir(artifactRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^planning-handover-[a-f0-9]{24}\.json$/u.test(entry.name))
    .map((entry) => entry.name);
  if (names.length !== 1) throw new Error("SMOKE_HANDOVER_ARTIFACT_COUNT");
  const artifactPath = join(artifactRoot, names[0]!);
  const stat = await lstat(artifactPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > 262_144) throw new Error("SMOKE_HANDOVER_ARTIFACT_INVALID");
  const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as { kind?: unknown; authority?: unknown; returnTemplate?: unknown };
  if (artifact.kind !== "planning-handover" || artifact.authority !== "none" || artifact.returnTemplate === null || typeof artifact.returnTemplate !== "object" || Array.isArray(artifact.returnTemplate)) throw new Error("SMOKE_HANDOVER_TEMPLATE_INVALID");
  const document = { ...(artifact.returnTemplate as Record<string, unknown>), text: "Operator supplied smoke result. This is untrusted planning feedback; no task, provider, repository write, or payment was executed." };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > 65_536) throw new Error("SMOKE_RESULT_FIXTURE_TOO_LARGE");
  const fixtureRoot = join(smokeRoot, "owned-fixtures");
  await mkdir(fixtureRoot, { recursive: true });
  await writeFile(join(fixtureRoot, "manual-result.json"), text, { encoding: "utf8", flag: "wx" });
  return Object.freeze({ name: "manual-result.json", text });
}

async function captureNativeConfirmation(window: BrowserWindow): Promise<void> {
  if (nativeConfirmationCaptured) return;
  if (evidenceFiles >= 6) throw new Error("SMOKE_EVIDENCE_FILE_LIMIT");
  window.setContentProtection(false);
  try {
    const screenshot = await window.webContents.capturePage(), size = screenshot.getSize(), bytes = screenshot.toPNG();
    if (screenshot.isEmpty() || size.width < 640 || size.height < 480) throw new Error("SMOKE_CONFIRMATION_SCREENSHOT_INVALID");
    if (evidenceBytes + bytes.byteLength > 10_000_000) throw new Error("SMOKE_EVIDENCE_BYTE_LIMIT");
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(join(evidenceRoot, "06-native-scope-confirmation.png"), bytes, { flag: "wx" });
    evidenceBytes += bytes.byteLength; evidenceFiles += 1; nativeConfirmationCaptured = true;
  } finally { window.setContentProtection(true); }
}

async function automateNativeConfirmation(request: Extract<NativePlanningRequest, { kind: "confirm" }>): Promise<boolean> {
  const current = handle;
  if (current === null) throw new Error("SMOKE_HANDLE_UNAVAILABLE");
  let openedWindow: BrowserWindow | null = null;
  let stage = "opening";
  const advance = (value: string): void => { stage = value; progress(`native-${request.review.action}-${value}`); };
  advance("opening");
  const pending = nativePlanningDialog(current.window, request);
  void pending.then((accepted) => progress(`native-${request.review.action}-decision:${accepted === true}`));
  try {
    const dialog = await waitForConfirmationWindow(current.window);
    openedWindow = dialog;
    advance("window-created");
    accumulateAssertion("native-confirmation-parent-bound", dialog.getParentWindow() === current.window && dialog.isModal());
    await waitForConfirmationDocument(dialog);
    advance("document-ready");
    const inspected = await boundedOperation(dialog.webContents.executeJavaScript(`(() => ({
      detail: document.querySelector("#native-review-content")?.textContent ?? null,
      heading: document.querySelector("#review-title")?.textContent ?? null,
      documentTitle: document.title,
      cancelFocused: document.activeElement?.id === "native-cancel",
      isolated: typeof process === "undefined" && typeof require === "undefined" && typeof window.aiPowerhouse === "undefined",
    }))()`, true), 3_000, "SMOKE_CONFIRMATION_INSPECTION_TIMEOUT") as { detail: string | null; heading: string | null; documentTitle: string; cancelFocused: boolean; isolated: boolean };
    accumulateAssertion("native-confirmation-exact-content", inspected.detail === request.review.detail);
    accumulateAssertion("native-confirmation-title", inspected.heading === request.review.title && inspected.documentTitle === request.review.title && dialog.getTitle() === request.review.title);
    accumulateAssertion("native-confirmation-cancel-focused", inspected.cancelFocused);
    accumulateAssertion("native-confirmation-isolated", inspected.isolated);
    if (request.review.action === "approve-scope") await captureNativeConfirmation(dialog);
    advance("confirming");
    // The brief fixture deliberately delays the script reply beyond modal
    // destruction; only the separate real native IPC decision is authority.
    const clickScript = request.review.action === "accept-brief"
      ? "new Promise(resolve => { const control = document.querySelector('#native-confirm'); if (!(control instanceof HTMLButtonElement)) { resolve(false); return; } control.click(); setTimeout(() => resolve(true), 250); })"
      : "(() => { const control = document.querySelector('#native-confirm'); if (!(control instanceof HTMLButtonElement)) return false; control.click(); return true; })()";
    let scriptAcknowledged = false;
    const clicked = dialog.webContents.executeJavaScript(clickScript, true) as Promise<boolean>;
    void clicked.then(value => { scriptAcknowledged = value; }, () => { /* Native decision remains authoritative. */ });
    const accepted = await boundedOperation(nativeConfirmationResult(pending, clicked), 10_000, "SMOKE_CONFIRMATION_RESULT_TIMEOUT");
    accumulateAssertion("native-confirmation-accepted-through-real-ipc", accepted === true);
    if (request.review.action === "accept-brief") accumulateAssertion("native-decision-survives-lost-script-reply", accepted === true && dialog.isDestroyed() && !scriptAcknowledged);
    advance("resolved");
    return accepted === true;
  } catch (error) {
    const window = openedWindow;
    progress(`native-failure:${boundedFixtureDiagnostic({ action: request.review.action, stage, error: safeFailure(error), destroyed: window?.isDestroyed() ?? null,
      visible: window !== null && !window.isDestroyed() ? window.isVisible() : null, loading: window !== null && !window.isDestroyed() ? window.webContents.isLoadingMainFrame() : null })}`);
    if (openedWindow !== null && !openedWindow.isDestroyed()) openedWindow.destroy();
    await pending.catch(() => false);
    throw error;
  }
}

async function nativePlanningForTest(request: NativePlanningRequest): Promise<NativePlanningReply> {
  if (request.kind === "repository") { nativeRepositorySelections += 1; return repositoryRoot; }
  if (request.kind === "result") { nativeResultSelections += 1; return await createManualResult(); }
  nativeReviewActions.push(request.review.action);
  return await automateNativeConfirmation(request);
}

async function captureEvidence(name: string): Promise<void> {
  const selected = phase === "create" && mode === "default" && selectedCaptures.has(name) || phase === "history" && mode === "default" && name === "07-historical-stopped";
  if (!selected) return;
  if (handle === null || evidenceFiles >= 6) throw new Error("SMOKE_EVIDENCE_FILE_LIMIT");
  handle.window.setContentProtection(false);
  try {
    const screenshot = await handle.window.webContents.capturePage();
    const size = screenshot.getSize(), bytes = screenshot.toPNG();
    if (screenshot.isEmpty() || size.width < 1_000 || size.height < 650) throw new Error("SMOKE_SCREENSHOT_INVALID");
    if (evidenceBytes + bytes.byteLength > 10_000_000) throw new Error("SMOKE_EVIDENCE_BYTE_LIMIT");
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(join(evidenceRoot, `${name}.png`), bytes, { flag: "wx" });
    evidenceBytes += bytes.byteLength; evidenceFiles += 1;
  } finally { handle.window.setContentProtection(true); }
}

async function waitReady(): Promise<void> {
  if (handle === null) throw new Error("SMOKE_HANDLE_UNAVAILABLE");
  const ready = await handle.waitForState("ready", 20_000);
  assertions["service-ready"] = ready.state === "ready";
  await waitForRenderer("document.querySelector('#service-pill')?.dataset.status === 'ready'", 5_000);
  const planning = await handle.service.planning({ kind: "snapshot", projectId: null }) as PlanningWorkspaceView;
  assertions["production-ai-route-refuses-before-inference"] = planning.aiPlanningConnection.state === "LIVE_ROUTE_BLOCKED" && planning.aiPlanningConnection.source === "unqualified" && planning.aiPlanningConnection.modelId === null;
  if (restartPriorPid !== null) {
    assertions["service-retry-new-child"] = handle.service.ownedProcessIdForTest() !== restartPriorPid;
    restartPriorPid = null;
  }
}

function journeyDriver(): RendererSavedJourneyDriver {
  return Object.freeze({
    evaluate: async <T>(script: string): Promise<T> => await rendererValue<T>(script),
    capture: async (name: string): Promise<void> => await captureEvidence(name),
    loseNextReply: async (): Promise<void> => {
      if (handle === null) throw new Error("SMOKE_HANDLE_UNAVAILABLE");
      handle.service.loseNextPlanningReplyForTest();
    },
    restartService: async (): Promise<void> => {
      if (handle === null) throw new Error("SMOKE_HANDLE_UNAVAILABLE");
      restartPriorPid = handle.service.ownedProcessIdForTest();
      await handle.service.terminateOwnedChildForTest();
      const lost = await handle.waitForState("service-lost", 5_000);
      assertions["service-loss-visible"] = lost.observation?.freshness === "stale";
      const openedHome = await rendererValue<boolean>(`(() => {
        const route = document.querySelector('[data-route="home"]');
        if (!(route instanceof HTMLButtonElement)) return false; route.click(); return true;
      })()`);
      if (!openedHome) throw new Error("SMOKE_RECOVERY_ROUTE_UNAVAILABLE");
      await waitForRenderer("Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Retry' && !button.disabled)", 5_000);
      const clicked = await rendererValue<boolean>(`(() => {
        const control = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Retry" && !button.disabled);
        if (!(control instanceof HTMLButtonElement)) return false;
        control.click(); return true;
      })()`);
      if (!clicked) throw new Error("SMOKE_RETRY_CONTROL_UNAVAILABLE");
    },
    waitReady,
    progress: (step: string, partial: Readonly<Record<string, boolean>>) => {
      lastJourneyStep = step;
      partialJourneyAssertions = Object.freeze({ ...partial });
      progress(`journey-${step}`);
    },
  });
}

async function applyMediaMode(): Promise<void> {
  if (handle === null) throw new Error("SMOKE_HANDLE_UNAVAILABLE");
  if (mode === "forced") {
    handle.window.webContents.debugger.attach("1.3");
    try {
      await handle.window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
      assertions["mode-media"] = await rendererValue<boolean>("matchMedia('(forced-colors: active)').matches");
    } finally { if (handle.window.webContents.debugger.isAttached()) handle.window.webContents.debugger.detach(); }
  } else assertions["mode-media"] = mode === "reduced" ? await rendererValue<boolean>("matchMedia('(prefers-reduced-motion: reduce)').matches") : true;
}

async function assertFirstLight(): Promise<void> {
  if (handle === null) throw new Error("SMOKE_HANDLE_UNAVAILABLE");
  const ready = handle.snapshot();
  assertions["visible-before-deadline"] = handle.visibleElapsedMs < 30_000;
  assertions["owned-synthetic-control-observation"] = ready.observation?.dataSource === "owned-synthetic-development-service";
  assertions["verification-connection-closed"] = ready.observation?.verification === "identity-verified-connection-closed";
  assertions["authority-none"] = ready.authority === "none" && ready.commands.length === 0;
  assertions["window-minimum"] = handle.window.getMinimumSize().join("x") === "1024x720";
  assertions["renderer-node-absent"] = await rendererValue<boolean>("typeof process === 'undefined' && typeof require === 'undefined'");
  assertions["renderer-network-blocked"] = await rendererValue<boolean>("fetch('https://example.invalid/').then(() => false, () => true)");
  assertions["dialog-labelled"] = await rendererValue<boolean>("document.querySelector('#detail-dialog')?.getAttribute('aria-labelledby') === 'dialog-title'");
  assertions["settings-no-secret-input"] = await rendererValue<number>("document.querySelectorAll('input[type=password], input[name*=secret i], textarea[name*=secret i]').length") === 0;
  await applyMediaMode();
}

async function runCreate(): Promise<void> {
  if (handle === null) throw new Error("SMOKE_HANDLE_UNAVAILABLE");
  handle.window.focus(); handle.window.webContents.focus();
  await rendererValue("document.querySelector('[data-route=home]').focus(); true");
  handle.window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Down" });
  handle.window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Down" });
  await settle();
  assertions["keyboard-navigation"] = await rendererValue<string>("document.activeElement?.getAttribute('data-route') ?? ''") === "project";
  await rendererValue("document.querySelector('[data-route=home]').click(); true");
  Object.assign(assertions, await runRendererSavedJourney(journeyDriver()));
  assertions["native-repository-selection-used"] = nativeRepositorySelections === 1 && nativeReviewActions.includes("create-project");
  assertions["native-scope-confirmation-used"] = nativeReviewActions.includes("approve-scope");
  assertions["native-result-confirmation-used"] = nativeResultSelections === 1 && nativeReviewActions.includes("attach-result");
  assertions["native-scope-confirmation-captured"] = nativeConfirmationCaptured;
  assertions["six-or-fewer-evidence-files"] = evidenceFiles <= 6;
  assertions["evidence-under-ten-megabytes"] = evidenceBytes <= 10_000_000;

  assertions["settings-no-secret-input"] = await rendererValue<number>("document.querySelectorAll('input[type=password], input[name*=secret i], textarea[name*=secret i]').length") === 0;
  await rendererValue("document.querySelector('[data-route=plan]').click(); true");
  await waitForRenderer("document.querySelector('#plan-title') instanceof HTMLInputElement", 5_000);
  handle.window.webContents.setZoomFactor(1.25); handle.window.setSize(1_024, 720); await settle();
  assertions["long-plan-text-present"] = await rendererValue<boolean>("Array.from(document.querySelectorAll('[data-task-field=objective]')).some((field) => field.value.includes('garden-observation-'.repeat(60)))");
  assertions["scaling-no-horizontal-overflow"] = await rendererValue<boolean>("document.documentElement.scrollWidth <= document.documentElement.clientWidth && document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth");
  handle.window.webContents.setZoomFactor(1); handle.window.setSize(1_280, 800); await settle();

  await rendererValue("document.querySelector('[data-route=settings]').click(); document.querySelector('#presentation-mode').value = 'developer'; [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Save presentation settings' && !button.disabled).click(); true");
  const currentHandle = handle;
  await waitFor(() => currentHandle.snapshot().preferences.presentationMode === "developer" && currentHandle.snapshot().state === "ready", 20_000, "SMOKE_DEVELOPER_MODE_TIMEOUT");
  await waitForRenderer("document.querySelector('#mode-pill')?.textContent === 'Developer' && document.querySelector('#service-pill')?.dataset.status === 'ready'", 5_000);
  assertions["developer-authority-parity"] = handle.snapshot().authority === "none" && handle.snapshot().commands.length === 0 && handle.snapshot().diagnostics !== null;

  const listed = await workspace(null), projectId = listed.projects.find((item) => item.name === "Garden field journal")?.projectId;
  if (projectId === undefined) throw new Error("SMOKE_CREATED_PROJECT_MISSING");
  await rendererValue("document.querySelector('[data-route=approvals]').click(); true");
  await waitForRenderer("Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Stop project' && !button.disabled)", 5_000);
  const concurrentBasis = (await workspace(projectId)).selected;
  if (concurrentBasis === null) throw new Error("SMOKE_CONCURRENT_PROJECT_MISSING");
  const concurrentStop = await handle.service.planning({ kind: "command", command: { kind: "stop-project", commandId: `smoke-concurrent:${randomUUID()}`, projectId, expectedProjectVersion: concurrentBasis.version } });
  assertions["trusted-concurrent-change-committed"] = typeof concurrentStop === "object" && concurrentStop !== null && "kind" in concurrentStop && concurrentStop.kind === "committed";
  const staleClick = await rendererValue<boolean>(`(() => {
    const control = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Stop project" && !button.disabled);
    if (!(control instanceof HTMLButtonElement)) return false; control.click(); return true;
  })()`);
  assertions["stale-ui-action-submitted"] = staleClick;
  await waitForRenderer("document.body.textContent?.includes('was not saved because this project changed') === true && Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Reload saved project' && !button.disabled)", 10_000);
  assertions["stale-conflict-visible-without-retry"] = true;
  await rendererValue("Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Reload saved project' && !button.disabled).click(); true");
  await waitForRenderer("Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Resume project' && !button.disabled)", 10_000);
  await rendererValue("Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Resume project' && !button.disabled).click(); true");
  await waitForRenderer("Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Stop project' && !button.disabled)", 10_000);
  assertions["conflict-reloaded-and-project-restored"] = true;
  baseline = durableBaseline(await workspace(projectId));
  assertions["single-saved-project"] = baseline.projectIds.length === 1;
  assertions["scope-approval-persisted"] = baseline.approvalCount === 1 && baseline.approvalStates[0] === "consumed" && baseline.plan.sealedByApprovalId === baseline.approvalIds[0];
  assertions["manual-result-persisted"] = baseline.handoverCount === 1 && baseline.handoverResultAttributions[0] === "operator-supplied-untrusted";
  assertions["history-event-identities-unique"] = new Set(baseline.historyEventIds).size === baseline.historyEventIds.length;
}

async function runReopen(): Promise<void> {
  const expected = await readExpectedBaseline(), listed = await workspace(null);
  assertions["saved-project-listed-after-process-reopen"] = listed.projects.some((item) => item.projectId === expected.selectedProjectId && item.name === "Garden field journal");
  const actual = durableBaseline(await workspace(expected.selectedProjectId));
  baseline = actual;
  assertions["durable-identities-and-counts-unchanged"] = JSON.stringify(actual) === JSON.stringify(expected);
  assertions["no-duplicate-history-events"] = actual.historyEventIds.length === expected.historyEventIds.length && new Set(actual.historyEventIds).size === actual.historyEventIds.length;
  assertions["approval-identities-unchanged"] = actual.approvalIds.length === expected.approvalIds.length && actual.approvalIds.every((id, index) => id === expected.approvalIds[index]);
  assertions["native-port-unused-on-reopen"] = nativeReviewActions.length === 0;
  await waitForRenderer("Array.from(document.querySelectorAll('.project-row h3')).some((heading) => heading.textContent?.trim() === 'Garden field journal')", 5_000);
  const opened = await rendererValue<boolean>(`(() => {
    const row = Array.from(document.querySelectorAll(".project-row")).find((item) => item.querySelector("h3")?.textContent?.trim() === "Garden field journal");
    const control = row?.querySelector("button"); if (!(control instanceof HTMLButtonElement) || control.disabled) return false; control.click(); return true;
  })()`);
  assertions["saved-project-opened-in-renderer"] = opened;
  await waitForRenderer("Array.from(document.querySelectorAll('.digest')).some((item) => item.textContent?.startsWith('Accepted brief'))", 5_000);
  await rendererValue("document.querySelector('[data-route=plan]').click(); true");
  await waitForRenderer("document.body.textContent?.includes('This plan is sealed.') === true", 5_000);
  assertions["sealed-plan-rendered-after-reopen"] = true;
  await rendererValue("document.querySelector('[data-route=approvals]').click(); true");
  await waitForRenderer("Array.from(document.querySelectorAll('h2')).some((heading) => heading.textContent?.trim() === 'Project history')", 5_000);
  assertions["approval-and-history-rendered-after-reopen"] = true;
  await rendererValue("document.querySelector('[data-route=handovers]').click(); true");
  Object.assign(assertions, await runRendererHandoverViewerCheck(journeyDriver(), false));
  await waitForRenderer("document.querySelector('.manual-result') !== null", 5_000);
  assertions["untrusted-result-rendered-after-reopen"] = await rendererValue<boolean>("document.querySelector('.manual-result')?.previousElementSibling?.textContent?.includes('untrusted') === true");
}

async function runHistory(): Promise<void> {
  const fixture = await readHistoricalFixture();
  historicalFixtureProvenance = fixture.fixtureProvenance;
  const before = await workspace(fixture.projectId);
  assertions["historical-seed-stopped-with-drift"] = before.selected?.stopped === true && before.selected?.name === fixture.project.name
    && before.selected.approvals.some((approval) => approval.approvalId === fixture.approvalId && approval.actions.includes("report-executed") && approval.context.includes("bindings have changed"));
  Object.assign(assertions, await runRendererHistoricalJourney(journeyDriver(), fixture.project.name));
  const after = await workspace(fixture.projectId), project = after.selected;
  if (project === null) throw new Error("SMOKE_HISTORY_PROJECT_MISSING");
  const historical = project.approvals.find((approval) => approval.approvalId === fixture.approvalId);
  const scope = project.approvals.find((approval) => approval.approvalId === fixture.originalScopeApproval.approvalId);
  const planUnchanged = JSON.stringify(project.plan) === JSON.stringify(fixture.originalPlan);
  assertions["historical-approval-reconciled"] = historical?.state === "reconciled" && historical.actions.length === 0;
  assertions["historical-project-remains-stopped"] = project.stopped;
  assertions["historical-plan-unchanged"] = planUnchanged;
  assertions["historical-scope-approval-unchanged"] = JSON.stringify(scope) === JSON.stringify(fixture.originalScopeApproval);
  assertions["historical-confirmations-used-real-modal"] = nativeReviewActions.filter((action) => action === "historical-money").length === 2;
  assertions["historical-fixture-provenance-explicit"] = historicalFixtureProvenance === "synthetic historical consumed pair and optional Project binding drift; no external activity";
  historyReconciled = Object.freeze({ approvalId: fixture.approvalId, projectId: fixture.projectId, spendingState: historical?.state ?? "missing", stillStopped: project.stopped, planUnchanged });
}

async function closeOwnedApplication(): Promise<void> {
  const owned = handle;
  if (owned === null) return;
  const runtimeRoot = owned.service.ownedRuntimeRootForTest(), processId = owned.service.ownedProcessIdForTest();
  shutdown = { ...shutdown, requested: true };
  await owned.close();
  const ownedProcessEnded = processId === null || (() => { try { process.kill(processId, 0); return false; } catch { return true; } })();
  const runtimeRootCleared = runtimeRoot === null || !existsSync(runtimeRoot);
  shutdown = { requested: true, handleCloseResolved: true, ownedProcessEnded, runtimeRootCleared, explicitReceipt: ownedProcessEnded && runtimeRootCleared && owned.service.ownedProcessIdForTest() === null };
  assertions["owned-shutdown"] = shutdown.explicitReceipt;
  assertions["runtime-root-cleared"] = runtimeRootCleared;
  assertions["owned-process-ended"] = ownedProcessEnded;
}

async function runSmoke(): Promise<void> {
  try {
    progress("launching");
    handle = await launchDesktopApplication({ userDataRoot: resolve(smokeRoot, "user-data"), serviceReadyDeadlineMs: 20_000, shutdownDeadlineMs: 3_000, nativePlanningForTest, onStartupPhase: (value) => progress(`startup-${value}`) });
    progress("visible");
    await waitReady();
    progress("service-ready");
    await assertFirstLight();
    if (phase === "create") await runCreate(); else if (phase === "reopen") await runReopen(); else await runHistory();
    assertions["no-boundary-leak"] = !/(?:bearerToken|startNonce|Authorization: Bearer|owned-service-)/u.test(await rendererValue<string>("document.body.textContent"));
    progress("journey-complete");
  } catch (error) {
    errorMessage = safeFailure(error);
    errorStack = scrubDiagnostic(error instanceof Error ? (error.stack ?? error.message) : String(error), 6_000);
    await captureFailureDiagnostics();
    failures.push(errorMessage);
  }
  try { await closeOwnedApplication(); } catch (error) {
    const failure = safeFailure(error);
    errorMessage ??= failure;
    errorStack ??= scrubDiagnostic(error instanceof Error ? (error.stack ?? error.message) : String(error), 6_000);
    failures.push(failure);
  }
  for (const [name, passed] of Object.entries(assertions)) if (!passed && !failures.includes(name)) failures.push(name);
  await mkdir(dirname(reportPath), { recursive: true }).catch(() => undefined);
  const diagnostics = Object.freeze({ lastJourneyStep, partialJourneyAssertions, errorMessage, errorStack, rendererState: failureRendererState, planningState: failurePlanningState });
  const report: SmokeReport = { schemaVersion: 2, phase, mode, provenance, assertions, baseline, historicalFixtureProvenance, historyReconciled, nativeReviewActions: Object.freeze([...nativeReviewActions]), diagnostics, shutdown, failures };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  progress("report-written");
  app.exit(failures.length === 0 ? 0 : 1);
}

void runSmoke().catch(() => app.exit(1));
