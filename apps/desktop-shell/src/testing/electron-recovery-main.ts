import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { app, BrowserWindow, protocol } from "electron";
import type { PlanningProjectView, PlanningWorkspaceView } from "@ai-dev-os/application/planning-contracts";
import { launchDesktopApplication, type DesktopApplicationHandle } from "../main/application.js";
import { nativePlanningDialog } from "../main/planning-dialog.js";
import { registerDesktopProtocolScheme } from "../main/protocol.js";
import type { NativePlanningRequest } from "../shared/planning-ipc.js";

const argument = (name: string): string => {
  const value = process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!value) throw new Error("RECOVERY_ARGUMENT_MISSING"); return value;
};
const root = resolve(argument("smoke-root")), phase = argument("recovery-phase"), reportPath = resolve(argument("report")), evidenceRoot = resolve(argument("evidence-root"));
if (!basename(root).startsWith("ai-dev-os-desktop-saved-smoke-") || !["prepare", "recover", "reopen"].includes(phase)) throw new Error("RECOVERY_FIXTURE_NOT_OWNED");
const userDataRoot = join(root, "owned-saved-recovery-user-data"), baselinePath = join(userDataRoot, "recovery-baseline.json");
app.commandLine.appendSwitch("user-data-dir", join(userDataRoot, "chromium"));
app.on("window-all-closed", () => { /* Owned shutdown is recorded before exit. */ });
registerDesktopProtocolScheme(protocol);
let handle: DesktopApplicationHandle | null = null, step = "startup", renewalDecisions = 0;
const assertions: Record<string, boolean> = {}, reviews: { action: string; detail: string; confirmed: boolean }[] = [];
let project: PlanningProjectView | null = null, failure: string | null = null, diagnostics: string | null = null, shutdown = false;
const check = (name: string, value: boolean): void => { assertions[name] = value; if (!value) throw new Error(`RECOVERY_ASSERTION:${name}`); };
const progress = (value: string): void => { step = value; process.stdout.write(`recovery:${phase}:${step}\n`); };
async function bounded<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`RECOVERY_TIMEOUT:${label}`)), 20_000); })]); }
  finally { clearTimeout(timer); }
}
const evaluate = <T>(script: string): Promise<T> => bounded(handle!.window.webContents.executeJavaScript(script, true) as Promise<T>, step);
async function wait(test: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await bounded(test(), label)) return; await new Promise<void>((done) => setTimeout(done, 100)); }
  throw new Error(`RECOVERY_TIMEOUT:${label}`);
}
const available = (label: string): string => `Array.from(document.querySelectorAll('button')).some(b => b.textContent?.trim() === ${JSON.stringify(label)} && !b.disabled)`;
async function click(label: string): Promise<void> {
  await wait(() => evaluate<boolean>(available(label)), label);
  check(`control:${label}`, await evaluate<boolean>(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === ${JSON.stringify(label)} && !b.disabled); if (!b) return false; b.focus(); b.click(); return true; })()`));
}
async function route(name: string): Promise<void> { await evaluate(`document.querySelector('[data-route=${name}]').click(); true`); }
async function textVisible(text: string): Promise<void> { await wait(() => evaluate<boolean>(`document.querySelector('main')?.textContent?.includes(${JSON.stringify(text)}) === true`), text); }
async function workspace(id: string | null = null): Promise<PlanningWorkspaceView> { return await bounded(handle!.service.planning({ kind: "snapshot", projectId: id }), "saved-snapshot") as PlanningWorkspaceView; }
async function selected(): Promise<PlanningProjectView> { const p = (await workspace(project!.projectId)).selected; if (p === null) throw new Error("RECOVERY_PROJECT_ABSENT"); return p; }
async function openProject(name: string): Promise<void> {
  await route("home");
  await wait(() => evaluate<boolean>(`Array.from(document.querySelectorAll('.project-row h3')).some(h => h.textContent === ${JSON.stringify(name)})`), "project-listed");
  await evaluate(`Array.from(document.querySelectorAll('.project-row')).find(r => r.querySelector('h3')?.textContent === ${JSON.stringify(name)}).querySelector('button').click(); true`);
  await wait(() => evaluate<boolean>(`document.querySelector('.project-title h2')?.textContent === ${JSON.stringify(name)}`), "project-open");
}
async function capture(name: string): Promise<void> {
  const window = handle!.window; window.setContentProtection(false);
  try { const bytes = (await window.webContents.capturePage()).toPNG(); check(`capture:${name}`, bytes.length > 1_000 && bytes.length < 2_000_000); await writeFile(join(evidenceRoot, name + ".png"), bytes, { flag: "wx" }); }
  finally { window.setContentProtection(true); }
}
async function native(request: NativePlanningRequest) {
  if (request.kind === "repository") return join(root, "repository-fixture");
  if (request.kind === "result") return null;
  const pending = nativePlanningDialog(handle!.window, request);
  let dialog: BrowserWindow | undefined;
  try {
    await wait(async () => { dialog = BrowserWindow.getAllWindows().find(w => w.getParentWindow() === handle!.window && w.isModal()); return dialog !== undefined && !dialog.webContents.isLoading(); }, "native-dialog");
    await wait(async () => await dialog!.webContents.executeJavaScript("document.querySelector('#native-confirm') instanceof HTMLButtonElement", true) as boolean, "native-document");
    const inspected = await dialog!.webContents.executeJavaScript("({detail:document.querySelector('#native-review-content')?.textContent, focused:document.activeElement?.id, isolated:typeof process==='undefined' && typeof require==='undefined'})", true) as { detail: string; focused: string; isolated: boolean };
    check(`native-exact:${reviews.length}`, inspected.detail === request.review.detail && inspected.focused === "native-cancel" && inspected.isolated);
    const confirm = request.review.action !== "request-scope-again" || ++renewalDecisions !== 1;
    reviews.push({ action: request.review.action, detail: request.review.detail, confirmed: confirm });
    await dialog!.webContents.executeJavaScript(`document.querySelector('${confirm ? "#native-confirm" : "#native-cancel"}').click(); true`, true);
    const actual = await bounded(pending, "native-result"); check(`native-decision:${reviews.length}`, actual === confirm); return actual;
  } catch (error) { if (dialog !== undefined && !dialog.isDestroyed()) dialog.destroy(); await pending.catch(() => false); throw error; }
}
async function createProject(name: string): Promise<void> {
  await route("home"); await wait(() => evaluate<boolean>("document.querySelector('#new-project-name') instanceof HTMLInputElement"), "new-project");
  await evaluate(`(() => { const values = ${JSON.stringify({ "new-project-name": "PLACEHOLDER", "new-project-objective": "Preserve manual recovery field notes", "new-project-outcomes": "Reopen saved field notes", "new-project-budget": "20", "new-project-currency": "GBP" })}; values['new-project-name'] = ${JSON.stringify(name)}; for (const [id,value] of Object.entries(values)) { const c=document.getElementById(id); c.value=value; c.dispatchEvent(new Event('input',{bubbles:true})); } return true; })()`);
  await click("Create project"); await openProject(name);
}
async function mode(value: "normal" | "developer"): Promise<void> {
  await route("settings"); await evaluate(`document.querySelector('#presentation-mode').value=${JSON.stringify(value)}; true`); await click("Save presentation settings");
  await wait(async () => handle!.snapshot().state === "ready" && handle!.snapshot().preferences.presentationMode === value, "mode-ready");
  await wait(() => evaluate<boolean>(`document.querySelector('#mode-pill')?.textContent === ${JSON.stringify(value === "normal" ? "Normal" : "Developer")}`), "mode-visible");
}
async function viewer(expectedText: string, label: string): Promise<void> {
  await route("handovers");
  const id = (JSON.parse(expectedText) as { handoverId: string }).handoverId, fileName = project!.handovers.find(h => h.handoverId === id)!.fileName;
  await wait(() => evaluate<boolean>(available("Open saved handover")), "viewer-control");
  check(`viewer-focused-control:${label}`, await evaluate<boolean>(`(() => { const row = Array.from(document.querySelectorAll('article.record')).find(r => r.textContent?.includes(${JSON.stringify(fileName)})); const b=Array.from(row?.querySelectorAll('button')??[]).find(b=>b.textContent==='Open saved handover'); if(!b || b.disabled)return false; b.focus(); b.click(); return true; })()`));
  await wait(() => evaluate<boolean>("document.querySelector('#detail-dialog')?.open && !!document.querySelector('.handover-document')?.textContent"), "viewer-open");
  check(`saved-document:${label}`, await evaluate<boolean>(`document.querySelector('.handover-document').textContent === ${JSON.stringify(expectedText)}`));
  check(`file-warning:${label}`, await evaluate<boolean>("document.querySelector('#dialog-content')?.textContent?.includes('Export file differs') === true && document.querySelector('#dialog-content')?.textContent?.includes('separate JSON file') === true"));
  await evaluate("document.querySelector('#dialog-close').click(); true");
  await wait(() => evaluate<boolean>("document.activeElement?.textContent?.trim() === 'Open saved handover'"), "viewer-focus-restored"); assertions[`viewer-focus-restored:${label}`] = true;
}

// Electron must finish evaluating its ESM entry before app.whenReady resolves.
// Keep the asynchronous journey off the module's top-level await chain.
void (async () => {
try {
  await mkdir(evidenceRoot, { recursive: true });
  handle = await launchDesktopApplication({ userDataRoot, savedRecoveryFixtureForTest: true, nativePlanningForTest: native, onStartupPhase: value => process.stdout.write(`recovery:startup:${value}\n`) });
  await handle.waitForState("ready", 20_000);
  await wait(() => evaluate<boolean>("document.querySelector('#new-project-name') instanceof HTMLInputElement"), "initial-home");
  check("product-deadlines-and-minimum", handle.visibleElapsedMs < 30_000 && handle.window.getMinimumSize().join("x") === "1024x720");
  check("planning-authority-none", handle.snapshot().authority === "none" && handle.snapshot().commands.length === 0);
  if (phase === "prepare") {
    progress("prepare-owned-projects"); await createProject("Unaffected saved project"); await createProject("Scope and handover recovery");
    await click("Accept this exact brief"); await textVisible("Accepted brief"); await route("plan");
    await evaluate("(() => { document.querySelector('#plan-title').value='Recovery field plan'; document.querySelector('#plan-scope').value='scope-expansion'; const t=document.querySelector('.task-editor'); t.querySelector('[data-task-field=title]').value='Compare seasons'; t.querySelector('[data-task-field=objective]').value='Compare this season with earlier records'; t.querySelector('[data-task-field=criteria]').value='Saved comparisons reopen unchanged'; return true; })()");
    await click("Save plan draft"); await textVisible("Plan draft saved."); await click("Prepare plan"); await textVisible("Prepare plan saved.");
    const listed = await workspace(), id = listed.projects.find(p => p.name === "Scope and handover recovery")!.projectId; project = (await workspace(id)).selected!;
    check("original-validity-shown", reviews.find(r => r.action === "prepare-plan")!.detail.includes(project.plan!.scopeApproval!.expiresAt));
    check("scope-awaiting-unapproved", project.plan!.state === "awaiting_scope_approval" && project.approvals[0]!.state === "requested" && project.plan!.scopeApproval!.expiresAt === "2026-09-09T00:00:00.000Z");
    await route("handovers"); await click("Export handover"); await textVisible("Handover export saved."); project = await selected();
    const handover = project.handovers[0]!; check("initial-export-published", handover.artifactState === "published");
    await writeFile(baselinePath, JSON.stringify({ project, savedText: await readFile(handover.fileName, "utf8"), projectCount: listed.projects.length }) + "\n", { flag: "wx" });
  } else {
    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as { project: PlanningProjectView; savedText: string; projectCount: number };
    project = baseline.project; await openProject("Unaffected saved project"); check("unaffected-project-accessible", (await workspace()).projects.length === baseline.projectCount);
    await openProject(project.name); project = await selected();
    if (phase === "recover") {
      progress("exact-expiry-after-full-reopen");
      check("expired-plan-unchanged", project.plan!.version === baseline.project.plan!.version && project.plan!.digest === baseline.project.plan!.digest && project.plan!.state === "awaiting_scope_approval");
      check("no-automatic-renewal", project.approvals.length === 1 && project.plan!.scopeApproval!.subject.approvalId === baseline.project.plan!.scopeApproval!.subject.approvalId);
      for (const detail of ["normal", "developer"] as const) {
        await mode(detail); await route("plan"); await textVisible("Scope request expired");
        check(`renewal-action:${detail}`, await evaluate<boolean>(available("Request scope approval again")));
      }
      await click("Request scope approval again"); await textVisible("Request scope approval again was cancelled.");
      check("cancel-preserves-request", (await selected()).approvals.length === 1);
      await click("Request scope approval again"); await textVisible("Request scope approval again saved."); project = await selected();
      check("renewal-keeps-plan-and-history", project.plan!.version === baseline.project.plan!.version && project.plan!.digest === baseline.project.plan!.digest && project.plan!.state === "awaiting_scope_approval" && project.approvals.length === 2 && project.approvals.some(a => a.approvalId === baseline.project.approvals[0]!.approvalId && a.state === "expired") && project.plan!.scopeApproval!.state === "requested");
      check("new-validity-bound", reviews.filter(r => r.action === "request-scope-again").every(r => r.detail.includes("2026-09-10T00:00:00.000Z") && r.detail.includes("separate action")));
      await evaluate("Array.from(document.querySelectorAll('.card')).find(c=>c.querySelector('h2')?.textContent==='Plan actions').scrollIntoView({block:'end'}); true");
      await capture("09-scope-renewed"); await click("Review and approve scope"); await textVisible("Review and approve scope saved."); project = await selected();
      check("separate-seal", project.plan!.state === "sealed" && project.plan!.sealedByApprovalId !== baseline.project.approvals[0]!.approvalId && project.approvals.some(a => a.state === "consumed"));
      progress("edited-export-and-known-command");
      for (const detail of ["normal", "developer"] as const) { await mode(detail); await viewer(baseline.savedText, detail); }
      await route("approvals"); await click("Stop project"); await textVisible("Stop project saved.");
      check("edited-file-does-not-make-stop-unknown", !(await evaluate<boolean>(available("Observe outcome"))) && (await selected()).stopped);
      handle.service.loseNextPlanningReplyForTest(); await click("Resume project"); await textVisible("may already be saved");
      check("real-lost-reply-remains-pending", await evaluate<boolean>(available("Observe outcome")));
      // Reload must not resolve a truly uncertain command. Its exact Observe control remains.
      await route("plan"); await click("Refresh scope status"); await textVisible("Latest saved project loaded.");
      check("reload-keeps-pending", await evaluate<boolean>(available("Observe outcome")));
      await click("Observe outcome"); await textVisible("Resume project saved."); project = await selected();
      check("observation-recovers-real-lost-reply", !project.stopped && !(await evaluate<boolean>(available("Observe outcome"))));
      await route("handovers"); await click("Export handover"); await textVisible("Handover export saved."); project = await selected();
      check("healthy-export-still-publishes", project.handovers.length === 2 && project.handovers.some(h => h.artifactState === "published") && project.handovers.some(h => h.artifactState === "differs-on-disk"));
      await evaluate("Array.from(document.querySelectorAll('article.record')).find(r=>r.textContent?.includes('Export file differs')).scrollIntoView({block:'center'}); true");
      await capture("10-handover-file-warning");
      await writeFile(join(userDataRoot, "recovered.json"), JSON.stringify(project) + "\n", { flag: "wx" });
    } else {
      progress("final-full-reopen");
      const recovered = JSON.parse(await readFile(join(userDataRoot, "recovered.json"), "utf8")) as PlanningProjectView;
      check("saved-repaired-state-reopens", JSON.stringify(project) === JSON.stringify(recovered));
      await viewer(baseline.savedText, "reopened");
      check("conflicting-bytes-preserved", await readFile(baseline.project.handovers[0]!.fileName, "utf8") === baseline.savedText.replaceAll("\n", "\r\n"));
      check("no-extra-renewal-or-save-on-reopen", reviews.length === 0);
    }
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  if (handle !== null && !handle.window.isDestroyed()) try { diagnostics = (await evaluate<string>("document.body.innerText")).slice(-12_000); } catch { /* Keep the original failure. */ }
} finally {
  if (handle !== null) {
    const pid = handle.service.ownedProcessIdForTest(), runtimeRoot = handle.service.ownedRuntimeRootForTest();
    try { await handle.close(); let ended = pid === null; if (pid !== null) try { process.kill(pid, 0); } catch { ended = true; }
      shutdown = ended && handle.service.ownedProcessIdForTest() === null && (runtimeRoot === null || !existsSync(runtimeRoot));
    } catch { failure ??= "RECOVERY_SHUTDOWN_UNCONFIRMED"; }
  }
  if (!shutdown) failure ??= "RECOVERY_SHUTDOWN_UNCONFIRMED";
  await writeFile(reportPath, JSON.stringify({ schemaVersion: 1, phase, provenance: "Owned synthetic fixed test clock; real Windows app, native confirmation, renderer IPC, child, SQLite and files. Buttons and picker selections automated; no user data or AI execution.", assertions, reviews, project, lastStep: step, failure, diagnostics, shutdown: { explicitReceipt: shutdown } }, null, 2) + "\n", { flag: "wx" });
  app.exit(failure === null ? 0 : 1);
}
})().catch(() => { process.stderr.write("RECOVERY_REPORT_UNAVAILABLE\n"); app.exit(1); });
