import { WORKSPACE_EXAMPLE } from "../examples/workspace-example.js";
import type { DesktopPreferences, DesktopResult, DesktopSnapshot } from "../shared/contracts.js";
import {
  createApprovalsPage,
  createHomePage,
  createProjectsPage,
  createSettingsPage,
  createUsagePage,
  type ExampleUiState,
  type RendererActions,
} from "./components.js";

interface DesktopBridge {
  snapshot(): Promise<DesktopResult<DesktopSnapshot>>;
  retryService(): Promise<DesktopResult<DesktopSnapshot>>;
  openReadOnly(): Promise<DesktopResult<DesktopSnapshot>>;
  setPreferences(preferences: DesktopPreferences): Promise<DesktopResult<DesktopSnapshot>>;
  relaunch(): Promise<DesktopResult<Readonly<{ completed: true }>>>;
  quit(): Promise<DesktopResult<Readonly<{ completed: true }>>>;
  onStateChanged(listener: (snapshot: DesktopSnapshot) => void): () => void;
}

declare global { interface Window { readonly aiPowerhouse: DesktopBridge; } }

type Route = "home" | "projects" | "approvals" | "usage" | "settings";
let route: Route = "home";
let snapshot: DesktopSnapshot | null = null;
let exampleState: ExampleUiState = { intakeDraft: "", previewed: false, approvalReviewed: false };
let dialogReturnFocus: HTMLElement | null = null;

function requiredElement<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (value === null) throw new Error("DESKTOP_RENDERER_SHELL_MISSING");
  return value;
}

const main = requiredElement<HTMLElement>("#workspace-main");
const servicePill = requiredElement<HTMLElement>("#service-pill");
const modePill = requiredElement<HTMLElement>("#mode-pill");
const announcer = requiredElement<HTMLElement>("#status-announcer");
const dialog = requiredElement<HTMLDialogElement>("#detail-dialog");
const dialogTitle = requiredElement<HTMLElement>("#dialog-title");
const dialogContent = requiredElement<HTMLElement>("#dialog-content");
const dialogClose = requiredElement<HTMLButtonElement>("#dialog-close");

function announce(message: string): void { announcer.textContent = message; }

function unwrap<T>(result: DesktopResult<T>): T | null {
  if (result.ok) return result.value;
  announce(`Action unavailable: ${result.code.toLowerCase().replaceAll("_", " ")}.`);
  return null;
}

function setSnapshot(next: DesktopSnapshot): void {
  const previous = snapshot?.statusText;
  snapshot = next;
  document.body.dataset["textScale"] = next.preferences.textScale;
  servicePill.dataset["status"] = next.state;
  servicePill.textContent = next.statusText;
  modePill.textContent = next.preferences.presentationMode === "developer" ? "Developer" : "Normal";
  if (previous !== next.statusText) announce(next.statusText);
  render(false);
}

const actions: RendererActions = {
  retryService: () => { void window.aiPowerhouse.retryService().then((result) => { const value = unwrap(result); if (value !== null) setSnapshot(value); }); },
  openReadOnly: () => { void window.aiPowerhouse.openReadOnly().then((result) => { const value = unwrap(result); if (value !== null) setSnapshot(value); }); },
  relaunch: () => { void window.aiPowerhouse.relaunch(); },
  quit: () => { void window.aiPowerhouse.quit(); },
  dismissWelcome: () => {
    if (snapshot === null) return;
    const preferences = { ...snapshot.preferences, welcomeDismissed: true } as DesktopPreferences;
    void window.aiPowerhouse.setPreferences(preferences).then((result) => { const value = unwrap(result); if (value !== null) setSnapshot(value); });
  },
  updateExample: (next) => { exampleState = next; render(false); announce("Example-only state updated. Nothing was saved."); },
  openDialog: (title, content, returnFocus) => {
    dialogReturnFocus = returnFocus;
    dialogTitle.textContent = title;
    dialogContent.replaceChildren(content);
    dialog.showModal();
    dialogClose.focus();
  },
};

function saveSettings(mode: "normal" | "developer", textScale: "standard" | "large"): void {
  if (snapshot === null) return;
  const preferences: DesktopPreferences = Object.freeze({
    schemaVersion: 1,
    presentationMode: mode,
    textScale,
    welcomeDismissed: snapshot.preferences.welcomeDismissed,
  });
  void window.aiPowerhouse.setPreferences(preferences).then((result) => {
    const value = unwrap(result);
    if (value !== null) { setSnapshot(value); announce("Presentation settings saved."); }
  });
}

function render(focusHeading: boolean): void {
  if (snapshot === null) return;
  let page: HTMLElement;
  switch (route) {
    case "home": page = createHomePage(snapshot, WORKSPACE_EXAMPLE, exampleState, actions); break;
    case "projects": page = createProjectsPage(WORKSPACE_EXAMPLE, exampleState, actions); break;
    case "approvals": page = createApprovalsPage(WORKSPACE_EXAMPLE, exampleState, actions); break;
    case "usage": page = createUsagePage(snapshot); break;
    case "settings": page = createSettingsPage(snapshot, saveSettings); break;
  }
  main.replaceChildren(page);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-route]")) button.setAttribute("aria-current", button.dataset["route"] === route ? "page" : "false");
  if (focusHeading) main.querySelector<HTMLElement>("h1")?.focus();
}

function navigate(next: Route): void {
  route = next;
  render(true);
}

const navigation = [...document.querySelectorAll<HTMLButtonElement>("[data-route]")];
for (const button of navigation) {
  button.addEventListener("click", () => navigate(button.dataset["route"] as Route));
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = navigation.indexOf(button);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    navigation[(index + offset + navigation.length) % navigation.length]?.focus();
  });
}

function closeDialog(): void { if (dialog.open) dialog.close(); }
dialogClose.addEventListener("click", closeDialog);
dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(); });
dialog.addEventListener("close", () => { dialogReturnFocus?.focus(); dialogReturnFocus = null; });

window.aiPowerhouse.onStateChanged(setSnapshot);
void window.aiPowerhouse.snapshot().then((result) => {
  const value = unwrap(result);
  if (value !== null) setSnapshot(value);
});
