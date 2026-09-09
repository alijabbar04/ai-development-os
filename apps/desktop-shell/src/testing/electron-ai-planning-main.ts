import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { app, BrowserWindow, protocol } from "electron";
import type { PlanningProjectView, PlanningWorkspaceView } from "@ai-dev-os/application/planning-contracts";
import { launchDesktopApplication, type DesktopApplicationHandle } from "../main/application.js";
import { nativePlanningDialog } from "../main/planning-dialog.js";
import { registerDesktopProtocolScheme } from "../main/protocol.js";
import type { NativePlanningRequest } from "../shared/planning-ipc.js";
import { nativeConfirmationResult } from "./native-confirmation-result.js";
import { configureOwnedElectronProfile } from "./owned-electron-profile.js";

const argument = (name: string): string => { const value = process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3); if (!value) throw new Error("AI_SMOKE_ARGUMENT_MISSING"); return value; };
const root = resolve(argument("smoke-root")), phase = argument("ai-phase"), reportPath = resolve(argument("report")), evidenceRoot = resolve(argument("evidence-root"));
if (!basename(root).startsWith("ai-dev-os-desktop-saved-smoke-") || !["journey", "reopen"].includes(phase)) throw new Error("AI_SMOKE_FIXTURE_NOT_OWNED");
const userDataRoot = join(root, "owned-ai-planning-user-data"), baselinePath = join(userDataRoot, "ai-baseline.json"), dispatchPath = join(userDataRoot, "synthetic-dispatches.jsonl");
const ownedElectronProfile = configureOwnedElectronProfile(app, root, "ai-planning");
app.on("window-all-closed", () => { /* Record owned shutdown before terminating. */ });
registerDesktopProtocolScheme(protocol);
let handle: DesktopApplicationHandle | null = null, step = "startup", project: PlanningProjectView | null = null, failure: string | null = null, diagnostics: string | null = null, shutdown = false;
const assertions: Record<string, boolean> = {}, reviews: { action: string; detail: string; subjectDigest: string; confirmed: boolean }[] = [];
const cancelled = new Set<string>();
const check = (name: string, value: boolean): void => { assertions[name] = value; if (!value) throw new Error(`AI_SMOKE_ASSERTION:${name}`); };
const progress = (value: string): void => { step = value; process.stdout.write(`ai-planning:${phase}:${value}\n`); };
async function bounded<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`AI_SMOKE_TIMEOUT:${label}`)), 20_000); })]); }
  finally { clearTimeout(timer); }
}
const evaluate = <T>(script: string): Promise<T> => bounded(handle!.window.webContents.executeJavaScript(script, true) as Promise<T>, step);
async function wait(test: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await bounded(test(), label)) return; await new Promise<void>(done => setTimeout(done, 100)); }
  throw new Error(`AI_SMOKE_TIMEOUT:${label}`);
}
async function click(id: string): Promise<void> {
  await wait(() => evaluate<boolean>(`document.getElementById(${JSON.stringify(id)}) instanceof HTMLButtonElement && !document.getElementById(${JSON.stringify(id)}).disabled`), id);
  check(`control:${id}`, await evaluate<boolean>(`(() => { const button=document.getElementById(${JSON.stringify(id)}); button.focus(); button.click(); return true; })()`));
}
async function buttonText(text: string): Promise<void> {
  await wait(() => evaluate<boolean>(`[...document.querySelectorAll('button')].some(button => button.textContent?.trim() === ${JSON.stringify(text)} && !button.disabled)`), text);
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === ${JSON.stringify(text)} && !button.disabled).click(); true`);
}
async function visible(text: string): Promise<void> { await wait(() => evaluate<boolean>(`document.querySelector('main')?.getAttribute('aria-busy') === 'false' && document.querySelector('main')?.textContent?.includes(${JSON.stringify(text)}) === true`), text); }
async function route(name: string): Promise<void> { await evaluate(`document.querySelector('[data-route="${name}"]').click(); true`); }
async function set(id: string, value: string): Promise<void> { await evaluate(`(() => { const control=document.getElementById(${JSON.stringify(id)}); if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) throw new Error('AI_CONTROL_MISSING'); control.value=${JSON.stringify(value)}; control.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`); }
async function workspace(id: string | null = null): Promise<PlanningWorkspaceView> { return await bounded(handle!.service.planning({ kind: "snapshot", projectId: id }), "saved-snapshot") as PlanningWorkspaceView; }
async function selected(): Promise<PlanningProjectView> { const value = (await workspace(project!.projectId)).selected; if (value === null) throw new Error("AI_PROJECT_ABSENT"); return value; }
async function dispatches(): Promise<readonly Record<string, unknown>[]> {
  try { return (await readFile(dispatchPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function openProject(): Promise<void> {
  await route("home"); await wait(() => evaluate<boolean>("[...document.querySelectorAll('.project-row h3')].some(title=>title.textContent==='Garden journal AI planning')"), "saved-project-listed");
  await evaluate("[...document.querySelectorAll('.project-row')].find(row=>row.querySelector('h3')?.textContent==='Garden journal AI planning').querySelector('button').click(); true");
  await wait(() => evaluate<boolean>("document.querySelector('.project-title h2')?.textContent==='Garden journal AI planning'"), "saved-project-open"); await route("ai-planning");
}
async function changeMode(mode: "normal" | "developer"): Promise<void> {
  await route("settings"); await evaluate(`document.querySelector('#presentation-mode').value=${JSON.stringify(mode)}; true`); await buttonText("Save presentation settings");
  await wait(async () => handle!.snapshot().state === "ready" && handle!.snapshot().preferences.presentationMode === mode, "presentation-ready");
  await wait(() => evaluate<boolean>(`document.querySelector('#service-pill')?.dataset.status === 'ready' && document.querySelector('#mode-pill')?.textContent===${JSON.stringify(mode === "normal" ? "Normal" : "Developer")}`), "presentation-visible"); await route("ai-planning");
}
async function capture(name: string): Promise<void> {
  const context = name === "11-ai-clarification"
    ? "document.querySelector('[data-route=\"ai-planning\"][aria-current=\"page\"]') !== null && document.querySelector('#ai-clarification-history')?.querySelectorAll('[data-clarification-round]').length === 2"
    : "document.querySelector('[data-route=\"plan\"][aria-current=\"page\"]') !== null && document.querySelector('main h1')?.textContent === 'Plan the work' && document.querySelector('#plan-title')?.value === 'Garden journal planning proposal'";
  const window = handle!.window; window.setContentProtection(false);
  try {
    check(`capture-context-before-paint:${name}`, await evaluate<boolean>(context));
    // DOM/scroll completion can precede the displayed frame. Let the actual
    // renderer paint before taking evidence; retain the existing finite bound.
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
    check(`capture-context-after-paint:${name}`, await evaluate<boolean>(context));
    check(`synthetic-label-visible:${name}`, await evaluate<boolean>("(() => { const banner=document.querySelector('#planning-fixture-banner'); const box=banner.getBoundingClientRect(); return !banner.hidden && banner.textContent.includes('no live provider call') && box.top>=0 && box.bottom<=window.innerHeight; })()"));
    const bytes = (await bounded(window.webContents.capturePage(), `capture:${name}`)).toPNG(); check(`capture:${name}`, bytes.length > 1_000 && bytes.length < 2_000_000); await writeFile(join(evidenceRoot, `${name}.png`), bytes, { flag: "wx" });
  }
  finally { window.setContentProtection(true); }
}
async function terminal(purpose: "understanding" | "proposal", expectedCount: number): Promise<void> {
  await wait(async () => { const session = (await selected()).aiPlanning.currentSession; return session !== null && session.requestCount === expectedCount && session.activeRequestId === null && session.requests.at(-1)?.purpose === purpose && ["succeeded", "failed", "refused", "outcome-unknown", "stale"].includes(session.requests.at(-1)!.state); }, `${purpose}-${expectedCount}-terminal`);
  project = await selected(); const request = project.aiPlanning.currentSession!.requests.findLast(item => item.purpose === purpose)!;
  check(`${purpose}-${expectedCount}-succeeded-through-real-validation`, request.state === "succeeded" && request.contributionDigest !== null && request.usageState === "reported" && request.modelId === "synthetic-planning-model");
  await click("ai-refresh-status"); await visible("Latest saved project loaded.");
  await visible(request.requestId);
}
async function native(request: NativePlanningRequest) {
  if (request.kind === "repository") return join(root, "repository-fixture");
  if (request.kind === "result") return null;
  const pending = nativePlanningDialog(handle!.window, request); let dialog: BrowserWindow | undefined;
  try {
    await wait(async () => { dialog = BrowserWindow.getAllWindows().find(window => window.getParentWindow() === handle!.window && window.isModal()); return dialog !== undefined && dialog.isVisible() && !dialog.webContents.isLoadingMainFrame(); }, "native-dialog");
    await wait(async () => await dialog!.webContents.executeJavaScript("document.querySelector('#native-confirm') instanceof HTMLButtonElement", true) as boolean, "native-document");
    const inspected = await bounded(dialog!.webContents.executeJavaScript("({detail:document.querySelector('#native-review-content')?.textContent,focused:document.activeElement?.id,isolated:typeof process==='undefined' && typeof require==='undefined' && typeof window.aiPowerhouse==='undefined'})", true), "native-inspection") as { detail: string; focused: string; isolated: boolean };
    check(`native-exact:${reviews.length}`, inspected.detail === request.review.detail && inspected.focused === "native-cancel" && inspected.isolated && /^[a-f0-9]{64}$/u.test(request.review.subjectDigest));
    const cancellable = ["request-ai-understanding", "accept-ai-brief", "adopt-ai-proposal"].includes(request.review.action), confirm = !cancellable || cancelled.has(request.review.action);
    if (!confirm) cancelled.add(request.review.action);
    if (request.review.action === "request-ai-understanding" || request.review.action === "request-ai-proposal") check(`native-provider-disclosure:${reviews.length}`, inspected.detail.includes("synthetic-planning-model") && /subscription|synthetic/iu.test(inspected.detail));
    if (request.review.action === "adopt-ai-proposal") check(`native-adoption-edited-content:${reviews.length}`, inspected.detail.includes("Capture garden notes with dates"));
    reviews.push({ action: request.review.action, detail: request.review.detail, subjectDigest: request.review.subjectDigest, confirmed: confirm });
    const clicked = dialog!.webContents.executeJavaScript(`document.querySelector('${confirm ? "#native-confirm" : "#native-cancel"}').click(); true`, true) as Promise<boolean>;
    const actual = await bounded(nativeConfirmationResult(pending, clicked), "native-result"); check(`native-decision:${reviews.length}`, actual === confirm); return actual;
  } catch (error) { if (dialog !== undefined && !dialog.isDestroyed()) dialog.destroy(); await pending.catch(() => false); throw error; }
}

// Do not hold Electron's module evaluation on app.whenReady().
void (async () => {
  try {
    await mkdir(evidenceRoot, { recursive: true });
    handle = await launchDesktopApplication({ userDataRoot, aiPlanningFixtureForTest: true, nativePlanningForTest: native, onStartupPhase: value => { if (value === "app-configured" || value === "single-instance-owned") ownedElectronProfile.assertCurrent(); } });
    ownedElectronProfile.assertCurrent(); check("owned-electron-profile-isolated", true);
    await handle.waitForState("ready", 20_000); await wait(() => evaluate<boolean>("document.querySelector('#new-project-name') instanceof HTMLInputElement"), "initial-home");
    check("product-deadlines-and-minimum", handle.visibleElapsedMs < 30_000 && handle.window.getMinimumSize().join("x") === "1024x720");
    check("workspace-authority-none", handle.snapshot().authority === "none" && handle.snapshot().commands.length === 0);
    check("synthetic-source-honestly-projected", (await workspace()).aiPlanningConnection.source === "synthetic-fixture");
    if (phase === "journey") {
      progress("describe-existing-saved-project");
      for (const [id, value] of Object.entries({ "new-project-name": "Garden journal AI planning", "new-project-objective": "Create a garden journal for dated notes and weekly reminders", "new-project-outcomes": "Capture each garden note and retain it after reopening", "new-project-budget": "0" })) await set(id, value);
      await buttonText("Create project"); await wait(async () => (await workspace()).projects.length === 1, "project-created");
      const listed = await workspace(), created = listed.projects[0]!;
      project = (await workspace(created.projectId)).selected;
      check("created-project-observed-by-explicit-identity", listed.selected === null && project !== null && project.projectId === created.projectId && project.name === "Garden journal AI planning");
      await openProject(); await visible("Owned test fixture only.");
      await set("ai-new-description", "I would like a garden journal for dated notes and reminders. Keep notes after reopening.");
      await click("ai-start-session"); await visible("Planning session saved."); project = await selected();
      check("session-saves-before-any-provider-request", project.aiPlanning.currentSession !== null && project.aiPlanning.currentSession.requestCount === 0 && (await dispatches()).length === 0);
      progress("clarify-with-exact-consent");
      await click("ai-request-understanding"); await visible("Request AI understanding was cancelled.");
      check("cancelled-native-request-launches-nothing", (await dispatches()).length === 0 && (await selected()).aiPlanning.currentSession!.requestCount === 0);
      await click("ai-request-understanding"); await terminal("understanding", 1); project = await selected();
      const question = project.aiPlanning.currentSession!.questions[0]!;
      check("bounded-material-question", project.aiPlanning.currentSession!.questions.length === 1 && question.question.includes("reminder period"));
      check("saved-answer-required-before-clarification-or-acceptance", await evaluate<boolean>("document.querySelector('#ai-request-understanding').disabled === true && document.querySelector('#ai-accept-brief').disabled === true && document.querySelector('#ai-answer-guidance').textContent.includes('Defaults are never selected')"));
      const answerId = `ai-answer-${question.questionId}`;
      await set(answerId, "Weekly reminders, with no automatic actions.");
      await set("ai-understanding-summary", "Garden journal with dated notes and weekly reminders");
      await visible("Unsaved planning edits.");
      check("unsaved-answer-gates-exact-acceptance", await evaluate<boolean>("document.querySelector('#ai-accept-brief').disabled === true"));
      await click("ai-refresh-status"); await visible("Latest saved project loaded.");
      check("status-refresh-keeps-answer-and-focus", await evaluate<boolean>(`document.getElementById(${JSON.stringify(answerId)}).value==='Weekly reminders, with no automatic actions.' && document.activeElement?.id==='ai-refresh-status'`));
      await changeMode("developer");
      check("mode-change-keeps-answer-and-authority", await evaluate<boolean>(`document.getElementById(${JSON.stringify(answerId)}).value==='Weekly reminders, with no automatic actions.' && document.querySelector('#ai-accept-brief').disabled === true`));
      await click("ai-save-edits"); await visible("Planning edits saved.");
      check("explicit-saved-answer-enables-clarification-and-acceptance", await evaluate<boolean>("document.querySelector('#ai-request-understanding').disabled === false && document.querySelector('#ai-accept-brief').disabled === false"));
      progress("second-round-retains-first-answer");
      await click("ai-request-understanding"); await terminal("understanding", 2); project = await selected();
      const roundTwo = project.aiPlanning.currentSession!, secondQuestion = roundTwo.questions[0]!;
      check("second-round-is-material-and-preserves-first-round", roundTwo.clarificationRounds === 2 && roundTwo.clarificationHistory.length === 2 && secondQuestion.questionId !== question.questionId && secondQuestion.question.includes("Which day")
        && roundTwo.clarificationHistory[0]!.questions[0]!.questionId === question.questionId && roundTwo.clarificationHistory[0]!.answers[0]!.value === "Weekly reminders, with no automatic actions." && roundTwo.clarificationHistory[1]!.materialChangeReason !== null);
      const secondAnswerId = `ai-answer-${secondQuestion.questionId}`;
      await set(secondAnswerId, "Monday mornings, with no automatic actions."); await set("ai-understanding-summary", "Garden journal with dated notes and weekly reminders");
      await visible("Unsaved planning edits."); await click("ai-refresh-status"); await visible("Latest saved project loaded.");
      check("second-round-typing-and-first-round-history-survive-refresh", await evaluate<boolean>(`document.getElementById(${JSON.stringify(secondAnswerId)}).value==='Monday mornings, with no automatic actions.' && document.activeElement?.id==='ai-refresh-status' && document.querySelector('#ai-clarification-history').textContent.includes('Weekly reminders, with no automatic actions.') && document.querySelector('#ai-accept-brief').disabled === true`));
      await click("ai-save-edits"); await visible("Planning edits saved."); project = await selected();
      check("both-explicit-answers-retained-before-acceptance", project.aiPlanning.currentSession!.clarificationHistory[0]!.answers[0]!.value === "Weekly reminders, with no automatic actions." && project.aiPlanning.currentSession!.clarificationHistory[1]!.answers[0]!.questionId === secondQuestion.questionId && project.aiPlanning.currentSession!.clarificationHistory[1]!.answers[0]!.value === "Monday mornings, with no automatic actions.");
      check("second-round-cap-preserves-explicit-acceptance", await evaluate<boolean>("document.querySelector('#ai-request-understanding').disabled === true && document.querySelector('#ai-accept-brief').disabled === false"));
      await evaluate("document.querySelector('#ai-clarification-history').scrollIntoView({block:'center'}); true"); await capture("11-ai-clarification");
      await click("ai-accept-brief"); await visible("Accept this AI brief was cancelled.");
      check("cancelled-brief-not-accepted", (await selected()).brief === null && (await selected()).aiPlanning.currentSession!.acceptedBriefDigest === null);
      await click("ai-accept-brief"); await visible("AI brief explicitly accepted and saved."); project = await selected();
      check("accepted-brief-preserves-operator-objective-and-model-preview", project.brief?.objective === "I would like a garden journal for dated notes and reminders. Keep notes after reopening." && project.aiPlanning.currentSession!.draft.understanding?.summary === "Garden journal with dated notes and weekly reminders" && project.aiPlanning.currentSession!.acceptedBriefDigest === project.brief?.digest);
      progress("propose-edit-and-adopt");
      await click("ai-request-proposal"); await terminal("proposal", 3); project = await selected();
      check("proposal-keeps-dependencies", project.aiPlanning.currentSession!.draft.proposal!.tasks.length === 2 && project.aiPlanning.currentSession!.draft.proposal!.tasks[1]!.dependsOn.length === 1);
      await set("ai-task-0-title", "Capture garden notes with dates"); await set("ai-task-0-criterion-0", "Saved notes retain their date after reopening");
      check("edits-gate-adoption", await evaluate<boolean>("document.querySelector('#ai-adopt-proposal').disabled === true"));
      await click("ai-save-edits"); await visible("Planning edits saved.");
      await click("ai-adopt-proposal"); await visible("Adopt this proposed draft was cancelled.");
      check("cancelled-adoption-keeps-plan-unwritten", (await selected()).plan === null && (await selected()).aiPlanning.currentSession!.adoptedPlanDigest === null);
      await click("ai-adopt-proposal"); await visible("Proposed plan explicitly adopted as a saved draft."); project = await selected();
      const editedTasks = project.plan?.tasks.filter(task => task.title === "Capture garden notes with dates") ?? [];
      check("explicit-model-draft-adoption", project.plan?.state === "drafting" && project.plan.tasks.length === 2 && editedTasks.length === 1
        && editedTasks[0]!.objective === "Record dated garden observations" && JSON.stringify(editedTasks[0]!.acceptanceCriteria) === JSON.stringify(["Saved notes retain their date after reopening"])
        && project.aiPlanning.currentSession!.adoptedPlanDigest === project.plan.digest);
      check("no-scope-or-execution-approval-invented", project.approvals.length === 0 && project.plan?.sealedByApprovalId === null);
      const records = await dispatches(); check("exactly-three-synthetic-requests", records.length === 3 && records.map(record => record["purpose"]).join(",") === "understanding,understanding,proposal" && records.every(record => record["source"] === "synthetic-owned-fixture" && record["liveInvocation"] === false));
      check("request-attribution-and-usage-retained", project.aiPlanning.currentSession!.requests.every(request => request.modelId === "synthetic-planning-model" && request.usageState === "reported" && request.state === "succeeded" && request.contributionDigest !== null));
      await click("ai-open-adopted-plan"); await visible("Plan the work");
      check("separate-prepare-still-required", await evaluate<boolean>("[...document.querySelectorAll('button')].some(button=>button.textContent==='Prepare plan' && !button.disabled)"));
      await evaluate("window.scrollTo(0,0); document.querySelector('main').scrollTop=0; true"); await capture("12-ai-adopted-plan");
      await writeFile(baselinePath, JSON.stringify({ project, records, reviews }) + "\n", { flag: "wx" });
    } else {
      progress("full-reopen-preserves-planning-journey");
      const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as { project: PlanningProjectView; records: readonly Record<string, unknown>[] };
      project = baseline.project; await openProject(); project = await selected();
      check("full-sessions-questions-drafts-and-attempts-reopen", JSON.stringify(project.aiPlanning.sessions) === JSON.stringify(baseline.project.aiPlanning.sessions));
      check("accepted-brief-and-adopted-plan-reopen", JSON.stringify(project.brief) === JSON.stringify(baseline.project.brief) && JSON.stringify(project.plan) === JSON.stringify(baseline.project.plan));
      for (const mode of ["normal", "developer"] as const) {
        await changeMode(mode); await visible("Proposed plan explicitly adopted as a saved draft.");
        check(`authority-parity-after-reopen:${mode}`, await evaluate<boolean>("document.querySelector('#ai-adopt-proposal').disabled === true && document.querySelector('#ai-task-0-title').value==='Capture garden notes with dates' && document.querySelector('main').textContent.includes('synthetic-planning-model')"));
        check(`complete-clarification-history-after-reopen:${mode}`, await evaluate<boolean>("(() => { const history=document.querySelector('#ai-clarification-history'); return history.querySelectorAll('[data-clarification-round]').length===2 && ['Which reminder period should the garden journal support?', 'Which day should the weekly garden reminder appear?', 'Weekly reminders, with no automatic actions.', 'Monday mornings, with no automatic actions.'].every(text=>history.textContent.includes(text)) && history.querySelector('input,textarea')===null; })()"));
      }
      await evaluate("for (const saved of document.querySelectorAll('main details')) if (saved.querySelector('summary')?.textContent?.startsWith('Session ')) saved.querySelector('summary').click(); true");
      check("archived-session-exposes-both-rounds-and-saved-answers", await evaluate<boolean>("(() => { const histories=[...document.querySelectorAll('.ai-clarification-history')].filter(history=>history.id!=='ai-clarification-history'); return histories.length===1 && histories.every(history=>history.closest('details').open && history.querySelectorAll('[data-clarification-round]').length===2 && ['Weekly reminders, with no automatic actions.','Monday mornings, with no automatic actions.'].every(answer=>history.textContent.includes(answer))); })()"));
      check("reopen-does-not-dispatch-or-confirm", reviews.length === 0 && JSON.stringify(await dispatches()) === JSON.stringify(baseline.records));
      check("saved-edits-not-mislabeled-dirty", await evaluate<boolean>("document.querySelector('#ai-edit-status').textContent.includes('Planning edits saved')"));
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (handle !== null && !handle.window.isDestroyed()) try { diagnostics = (await evaluate<string>("document.body.innerText")).slice(-16_000); } catch { /* Original causal failure remains primary. */ }
  } finally {
    if (handle !== null) {
      const pid = handle.service.ownedProcessIdForTest(), runtimeRoot = handle.service.ownedRuntimeRootForTest();
      try { await handle.close(); let ended = pid === null; if (pid !== null) try { process.kill(pid, 0); } catch { ended = true; }
        shutdown = ended && handle.service.ownedProcessIdForTest() === null && (runtimeRoot === null || !existsSync(runtimeRoot));
      } catch { failure ??= "AI_SMOKE_SHUTDOWN_UNCONFIRMED"; }
    }
    if (!shutdown) failure ??= "AI_SMOKE_SHUTDOWN_UNCONFIRMED";
    await writeFile(reportPath, JSON.stringify({ schemaVersion: 1, phase, providerEvidence: "synthetic-owned-fixture", liveInvocations: 0,
      provenance: "Real Windows renderer, native confirmation, IPC, application, child and SQLite; provider responses and folder selection are owned synthetic fixtures. No live AI connection is claimed.", assertions, reviews, project, lastStep: step, failure, diagnostics, shutdown: { explicitReceipt: shutdown } }, null, 2) + "\n", { flag: "wx" });
    app.exit(failure === null ? 0 : 1);
  }
})().catch(() => { process.stderr.write("AI_SMOKE_REPORT_UNAVAILABLE\n"); app.exit(1); });
