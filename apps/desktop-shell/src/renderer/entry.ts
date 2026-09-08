import type {
  PlanningCommand,
  PlanningCommandResult,
  PlanningHandoverView,
  PlanningWorkspaceView,
} from "@ai-dev-os/application/planning-contracts";
import { planningArtifactMessage, planningRecoveryDirective, planningResultMessage } from "../presentation/adapter.js";
import type { DesktopPreferences, DesktopResult, DesktopSnapshot } from "../shared/contracts.js";
import {
  createApprovalsPage,
  createCommandStatus,
  createHandoversPage,
  createHomePage,
  createPlanPage,
  createProjectPage,
  createSettingsPage,
  type CommandNotice,
  type PendingCommand,
  type RendererActions,
  type WorkflowUiState,
  type WorkspaceRoute,
} from "./components.js";

interface DesktopBridge {
  snapshot(): Promise<DesktopResult<DesktopSnapshot>>;
  retryService(): Promise<DesktopResult<DesktopSnapshot>>;
  openReadOnly(): Promise<DesktopResult<DesktopSnapshot>>;
  setPreferences(preferences: DesktopPreferences): Promise<DesktopResult<DesktopSnapshot>>;
  relaunch(): Promise<DesktopResult<Readonly<{ completed: true }>>>;
  quit(): Promise<DesktopResult<Readonly<{ completed: true }>>>;
  onStateChanged(listener: (snapshot: DesktopSnapshot) => void): () => void;
  planningSnapshot(projectId: string | null): Promise<PlanningWorkspaceView>;
  planningCommand(command: PlanningCommand): Promise<PlanningCommandResult>;
  planningObserve(commandId: string): Promise<PlanningCommandResult>;
  planningHandover(projectId: string, handoverId: string): Promise<PlanningHandoverView>;
}
declare global { interface Window { readonly aiPowerhouse: DesktopBridge; } }

let route: WorkspaceRoute = "home";
let snapshot: DesktopSnapshot | null = null;
let workspace: PlanningWorkspaceView | null = null;
let selectedProjectId: string | null = null;
let busy = false;
let pending: PendingCommand | null = null;
let reloadRequired = false;
let notice: CommandNotice | null = null;

function requiredElement<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (value === null) throw new Error("DESKTOP_RENDERER_SHELL_MISSING");
  return value;
}
const main = requiredElement<HTMLElement>("#workspace-main");
const servicePill = requiredElement<HTMLElement>("#service-pill");
const modePill = requiredElement<HTMLElement>("#mode-pill");
const announcer = requiredElement<HTMLElement>("#status-announcer");
const detailDialog = requiredElement<HTMLDialogElement>("#detail-dialog");
const detailTitle = requiredElement<HTMLElement>("#dialog-title");
const detailContent = requiredElement<HTMLElement>("#dialog-content");
const detailClose = requiredElement<HTMLButtonElement>("#dialog-close");
let detailRestoreFocus: HTMLElement | null = null;
let viewingHandover = false;

function announce(message: string): void { announcer.textContent = message; }
function uiState(): WorkflowUiState { return Object.freeze({ busy, pending, reloadRequired, notice }); }
function unwrap<T>(result: DesktopResult<T>): T | null {
  if (result.ok) return result.value;
  announce(`Action unavailable: ${result.code.toLowerCase().replaceAll("_", " ")}.`); return null;
}
function setNotice(text: string, tone: CommandNotice["tone"] = "info"): void { notice = Object.freeze({ text, tone }); announce(text); }

function detailNode<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (className !== undefined) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}
function closeDetail(): void { if (detailDialog.open) detailDialog.close(); }
detailClose.addEventListener("click", closeDetail);
detailDialog.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closeDetail();
});
detailDialog.addEventListener("close", () => {
  const restore = detailRestoreFocus;
  detailRestoreFocus = null;
  if (restore?.isConnected === true) restore.focus();
});
async function viewHandover(projectId: string, handoverId: string, revision: number): Promise<void> {
  if (snapshot?.state !== "ready" || viewingHandover) return;
  detailRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  detailTitle.textContent = `Planning handover, revision ${revision}`;
  detailContent.replaceChildren(detailNode("p", "muted", "Opening saved planning handover…"));
  if (!detailDialog.open) detailDialog.showModal();
  detailClose.focus();
  viewingHandover = true;
  try {
    const handover = await window.aiPowerhouse.planningHandover(projectId, handoverId);
    if (handover.schemaVersion !== 1 || handover.authority !== "none" || handover.projectId !== projectId || handover.handoverId !== handoverId || typeof handover.fileName !== "string" || handover.fileName.length === 0 || !["published", "differs-on-disk", "unavailable"].includes(handover.artifactState) || typeof handover.stale !== "boolean" || typeof handover.text !== "string" || handover.text.length > 262_144) throw new Error("INVALID_HANDOVER_VIEW");
    if (!detailDialog.open) return;
    const authority = detailNode("p", `status-badge${handover.stale ? " warning" : ""}`, handover.stale ? "Authority: none · Stale binding" : "Authority: none · Current binding");
    const fileName = detailNode("p", "help handover-path", `Export location: ${handover.fileName}`);
    const fileState = detailNode("p", handover.artifactState === "published" ? "help" : "notice warning", planningArtifactMessage(handover.artifactState));
    fileState.setAttribute("role", "status");
    const documentText = detailNode("pre", "handover-document");
    documentText.textContent = handover.text;
    detailContent.replaceChildren(authority, fileName, fileState, detailNode("p", "help", "Copy the returnTemplate object into a separate JSON file and edit that copy to attach your manual report. Preserve this exported handover."), documentText);
    announce(`Planning handover revision ${revision} opened.`);
  } catch {
    detailContent.replaceChildren(detailNode("p", "notice danger", "The saved handover is temporarily unavailable."));
    announce("The saved handover is temporarily unavailable.");
  } finally { viewingHandover = false; }
}

function setSnapshot(next: DesktopSnapshot): void {
  const previousState = snapshot?.state; const previousStatus = snapshot?.statusText; snapshot = next;
  document.body.dataset["textScale"] = next.preferences.textScale; servicePill.dataset["status"] = next.state; servicePill.textContent = next.statusText;
  modePill.textContent = next.preferences.presentationMode === "developer" ? "Developer" : "Normal";
  if (previousStatus !== next.statusText) announce(next.statusText); render(false);
  if (next.state === "ready" && previousState !== "ready" && workspace === null) void loadPlanning(selectedProjectId, false);
}
function setWorkspace(next: PlanningWorkspaceView): void {
  workspace = next; selectedProjectId = next.selected?.projectId ?? selectedProjectId; render(false);
}
async function loadPlanning(projectId: string | null, announceResult: boolean): Promise<void> {
  busy = true; render(false);
  try {
    const next = await window.aiPowerhouse.planningSnapshot(projectId); workspace = next; selectedProjectId = next.selected?.projectId ?? projectId;
    reloadRequired = false; if (announceResult) setNotice("Latest saved project loaded.");
  } catch {
    setNotice("Saved planning is temporarily unavailable. Existing content has been left unchanged.", "danger");
  } finally { busy = false; render(false); }
}
async function refreshAfterResult(result: PlanningCommandResult): Promise<void> {
  if (result.workspace !== null) { setWorkspace(result.workspace); return; }
  if (result.projectionWarning === "workspace-corrupt" || result.projectionWarning === "workspace-unavailable") return;
  const projectId = result.projectId ?? selectedProjectId;
  try { setWorkspace(await window.aiPowerhouse.planningSnapshot(projectId)); } catch { /* The result remains visible; a later reload is safe. */ }
}
async function applyPlanningResult(result: PlanningCommandResult, label: string, observed: boolean, exactCommandId: string | null): Promise<void> {
  setNotice(planningResultMessage(result, label, snapshot?.preferences.presentationMode === "developer"), result.kind === "corrupt" || result.kind === "refused" || result.projectionWarning === "workspace-corrupt" ? "danger" : result.kind === "unknown" || result.kind === "conflict" || result.projectionWarning !== null ? "warning" : "info");
  const recovery = planningRecoveryDirective(result, exactCommandId ?? pending?.commandId ?? null);
  if (result.kind === "unknown" || result.kind === "corrupt") {
    if (recovery.pendingCommandId === null) reloadRequired = recovery.reloadRequired; else pending = Object.freeze({ commandId: recovery.pendingCommandId, label });
    return;
  }
  if (observed || result.kind !== "not-recorded") pending = null;
  if (recovery.reloadRequired) reloadRequired = true;
  if (result.kind === "committed" || result.kind === "ready" || result.kind === "idempotent-replay") reloadRequired = recovery.reloadRequired;
  if (result.kind === "committed" || result.kind === "ready" || result.kind === "idempotent-replay") await refreshAfterResult(result);
}

function renderCommandStatus(focus: boolean): void {
  if (snapshot === null || workspace === null) return;
  main.querySelector<HTMLElement>(".command-status")?.remove();
  const status = createCommandStatus(snapshot, uiState(), actions);
  if (status !== null) main.prepend(status);
  const globallyAvailable = snapshot.state === "ready" && !busy && pending === null && !reloadRequired;
  for (const control of main.querySelectorAll<HTMLButtonElement>('[data-planning-action="true"]')) {
    const available = globallyAvailable && control.dataset["planningAllowed"] === "true";
    control.disabled = !available;
    if (!available) control.title = globallyAvailable ? (control.dataset["planningReason"] ?? "Action unavailable.") : busy ? "Wait for the current change to finish." : pending !== null ? "Observe the uncertain command outcome before continuing." : reloadRequired ? "Reload the saved project before continuing." : "The local workspace is unavailable.";
    else control.removeAttribute("title");
  }
  main.setAttribute("aria-busy", busy ? "true" : "false");
  if (focus) status?.focus();
}

async function runPlanningCommand(command: PlanningCommand, label: string): Promise<void> {
  if (busy || pending !== null || reloadRequired || snapshot?.state !== "ready") return;
  const workspaceBeforeCommand = workspace;
  busy = true; notice = null; renderCommandStatus(false);
  const exactId = "commandId" in command ? command.commandId : null;
  try { await applyPlanningResult(await window.aiPowerhouse.planningCommand(command), label, false, exactId); }
  catch {
    if (exactId === null) { reloadRequired = true; setNotice(`${label} did not return a result. Reload the saved project before continuing.`, "warning"); }
    else { pending = Object.freeze({ commandId: exactId, label }); setNotice(`${label} may already be saved. Observe this exact command before continuing.`, "warning"); }
  } finally { busy = false; if (workspace !== workspaceBeforeCommand) render(false); else renderCommandStatus(true); }
}
async function observePending(): Promise<void> {
  const exact = pending; if (exact === null || busy || snapshot?.state !== "ready") return; const workspaceBeforeObservation = workspace; busy = true; notice = null; renderCommandStatus(false);
  try { await applyPlanningResult(await window.aiPowerhouse.planningObserve(exact.commandId), exact.label, true, exact.commandId); }
  catch { pending = exact; setNotice(`The outcome of ${exact.label.toLowerCase()} is still unknown. Observe the same command again when the workspace is available.`, "warning"); }
  finally { busy = false; if (workspace !== workspaceBeforeObservation) render(false); else renderCommandStatus(true); }
}

const actions: RendererActions = {
  retryService: () => { void window.aiPowerhouse.retryService().then((result) => { const value = unwrap(result); if (value !== null) setSnapshot(value); }); },
  openReadOnly: () => { void window.aiPowerhouse.openReadOnly().then((result) => { const value = unwrap(result); if (value !== null) setSnapshot(value); }); },
  relaunch: () => { void window.aiPowerhouse.relaunch(); },
  quit: () => { void window.aiPowerhouse.quit(); },
  dismissWelcome: () => {
    if (snapshot === null) return; const preferences = { ...snapshot.preferences, welcomeDismissed: true } as DesktopPreferences;
    void window.aiPowerhouse.setPreferences(preferences).then((result) => { const value = unwrap(result); if (value !== null) setSnapshot(value); });
  },
  selectProject: (projectId) => { selectedProjectId = projectId; route = "project"; void loadPlanning(projectId, false).then(() => main.querySelector<HTMLElement>("h1")?.focus()); },
  navigate: (next) => navigate(next),
  runPlanningCommand: (command, label) => { void runPlanningCommand(command, label); },
  observePending: () => { void observePending(); },
  reloadPlanning: () => { void loadPlanning(selectedProjectId, true); },
  viewHandover: (projectId, handoverId, revision) => { void viewHandover(projectId, handoverId, revision); },
};

function saveSettings(mode: "normal" | "developer", textScale: "standard" | "large"): void {
  if (snapshot === null) return;
  const preferences: DesktopPreferences = Object.freeze({ schemaVersion: 1, presentationMode: mode, textScale, welcomeDismissed: snapshot.preferences.welcomeDismissed });
  void window.aiPowerhouse.setPreferences(preferences).then((result) => { const value = unwrap(result); if (value !== null) { setSnapshot(value); announce("Presentation settings saved."); } });
}
function loadingPage(message: string): HTMLElement {
  const page = document.createElement("div"); page.className = "page"; const h1 = document.createElement("h1"); h1.tabIndex = -1; h1.textContent = "Saved planning"; const p = document.createElement("p"); p.className = "muted"; p.textContent = message; page.append(h1, p); return page;
}
function render(focusHeading: boolean): void {
  if (snapshot === null) { main.replaceChildren(loadingPage("Starting the local workspace…")); return; }
  if (workspace === null) { main.replaceChildren(loadingPage("Loading saved projects…")); return; }
  let page: HTMLElement;
  switch (route) {
    case "home": page = createHomePage(snapshot, workspace, uiState(), actions); break;
    case "project": page = createProjectPage(snapshot, workspace, uiState(), actions); break;
    case "plan": page = createPlanPage(snapshot, workspace, uiState(), actions); break;
    case "approvals": page = createApprovalsPage(snapshot, workspace, uiState(), actions); break;
    case "handovers": page = createHandoversPage(snapshot, workspace, uiState(), actions); break;
    case "settings": page = createSettingsPage(snapshot, saveSettings); break;
  }
  const commandStatus = createCommandStatus(snapshot, uiState(), actions); main.replaceChildren(...(commandStatus === null ? [page] : [commandStatus, page]));
  main.setAttribute("aria-busy", busy ? "true" : "false");
  for (const control of document.querySelectorAll<HTMLButtonElement>("[data-route]")) control.setAttribute("aria-current", control.dataset["route"] === route ? "page" : "false");
  if (focusHeading) main.querySelector<HTMLElement>("h1")?.focus();
}
function navigate(next: WorkspaceRoute): void { route = next; render(true); }
const navigation = [...document.querySelectorAll<HTMLButtonElement>("[data-route]")];
for (const control of navigation) {
  control.addEventListener("click", () => navigate(control.dataset["route"] as WorkspaceRoute));
  control.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return; event.preventDefault(); const index = navigation.indexOf(control); const offset = event.key === "ArrowDown" ? 1 : -1; navigation[(index + offset + navigation.length) % navigation.length]?.focus();
  });
}

window.aiPowerhouse.onStateChanged(setSnapshot);
void Promise.allSettled([window.aiPowerhouse.snapshot(), window.aiPowerhouse.planningSnapshot(null)]).then(([desktopResult, planningResult]) => {
  if (desktopResult.status === "fulfilled") { const value = unwrap(desktopResult.value); if (value !== null) setSnapshot(value); }
  else setNotice("The local workspace did not return its status.", "danger");
  if (planningResult.status === "fulfilled") setWorkspace(planningResult.value);
  else setNotice("Saved planning is temporarily unavailable.", "danger");
  render(false);
});
