import type { DesktopSnapshot } from "../shared/contracts.js";
import type { DesktopWorkspacePresentation } from "../presentation/adapter.js";

export interface ExampleUiState {
  readonly intakeDraft: string;
  readonly previewed: boolean;
  readonly approvalReviewed: boolean;
}

export interface RendererActions {
  readonly retryService: () => void;
  readonly openReadOnly: () => void;
  readonly relaunch: () => void;
  readonly quit: () => void;
  readonly dismissWelcome: () => void;
  readonly updateExample: (next: ExampleUiState) => void;
  readonly openDialog: (title: string, content: HTMLElement, returnFocus: HTMLElement) => void;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (className !== undefined) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function heading(title: string, description: string): HTMLElement {
  const head = node("header", "page-head");
  head.append(node("span", "eyebrow", "AI Powerhouse"));
  const h1 = node("h1", undefined, title);
  h1.tabIndex = -1;
  head.append(h1, node("p", undefined, description));
  return head;
}

function card(title: string, wide = false): HTMLElement {
  const value = node("section", `card${wide ? " wide" : ""}`);
  value.append(node("h2", undefined, title));
  return value;
}

function list(items: readonly string[]): HTMLUListElement {
  const value = node("ul");
  for (const item of items) value.append(node("li", undefined, item));
  return value;
}

function button(label: string, action: () => void, style?: string): HTMLButtonElement {
  const value = node("button", style, label);
  value.type = "button";
  value.addEventListener("click", action);
  return value;
}

function serviceActions(snapshot: DesktopSnapshot, actions: RendererActions): HTMLElement | null {
  const group = node("div", "actions");
  if (snapshot.state === "failed-start") {
    if (!snapshot.recoveryAvailable) return null;
    group.append(button("Relaunch", actions.relaunch, "primary"));
    const readOnly = button("Open read-only", actions.openReadOnly);
    readOnly.disabled = !snapshot.readOnlyAvailable;
    if (readOnly.disabled) readOnly.title = "No verified cached observation exists yet.";
    group.append(readOnly, button("Quit", actions.quit, "danger-button"));
    return group;
  }
  if (snapshot.state === "service-lost") {
    group.append(button("Retry service", actions.retryService, "primary"));
    const readOnly = button("Continue read-only", actions.openReadOnly);
    readOnly.disabled = !snapshot.readOnlyAvailable;
    group.append(readOnly, button("Quit", actions.quit, "danger-button"));
    return group;
  }
  if (snapshot.state === "read-only") {
    group.append(button("Retry service", actions.retryService, "primary"), button("Quit", actions.quit, "danger-button"));
    return group;
  }
  return null;
}

export function createServiceCard(snapshot: DesktopSnapshot, actions: RendererActions): HTMLElement {
  const value = card("Local service", true);
  const status = node("div", `notice${snapshot.state === "ready" ? "" : snapshot.state === "loading" ? " warning" : " danger"}`);
  status.append(node("strong", undefined, snapshot.statusText));
  const explanation = snapshot.state === "ready"
    ? "Identity and session were verified against the child service. The verification connection is now closed."
    : snapshot.state === "loading"
      ? "The window is ready while its owned development service starts."
      : snapshot.state === "read-only"
        ? "The last verified observation is retained as stale. Nothing can dispatch from this view."
        : "No command or provider operation can run while the service is unavailable.";
  status.append(node("p", "help", explanation));
  value.append(status);
  if (snapshot.state === "failed-start" && !snapshot.recoveryAvailable) {
    value.append(node("p", "help", "Recovery choices become available at the fixed 20-second service-readiness deadline."));
  }
  const observation = snapshot.observation;
  if (observation !== null) {
    const metrics = node("div", "metric-row");
    const observed = node("div", "metric");
    observed.append(node("span", "muted", observation.freshness === "live" ? "Verified observation" : "Last verified observation"));
    observed.append(node("strong", undefined, observation.ageMs < 1_000 ? "just now" : `${Math.ceil(observation.ageMs / 1_000)} seconds old`));
    const sessions = node("div", "metric");
    sessions.append(node("span", "muted", "Synthetic running sessions"), node("strong", undefined, String(observation.runningSessions)));
    const boundary = node("div", "metric");
    boundary.append(node("span", "muted", "Authority"), node("strong", undefined, "None — read-only"));
    metrics.append(observed, sessions, boundary);
    value.append(metrics);
  }
  const controls = serviceActions(snapshot, actions);
  if (controls !== null) value.append(controls);
  return value;
}

export function createHomePage(snapshot: DesktopSnapshot, workspace: DesktopWorkspacePresentation, state: ExampleUiState, actions: RendererActions): HTMLElement {
  const page = node("div", "page");
  const serviceSummary = snapshot.state === "ready"
    ? "The local shell and its owned read-only service are live."
    : snapshot.state === "loading"
      ? "The workspace is visible while its owned read-only service starts."
      : "The workspace remains available while its owned read-only service is unavailable.";
  page.append(heading("A useful workspace, ready for integration", `${serviceSummary} Project content below is a clearly isolated example until durable operations are connected.`));
  if (snapshot.firstLaunch) {
    const welcome = card("Welcome to the first-light workspace", true);
    welcome.append(node("p", undefined, "You can explore a project brief, plan and approval summary without saving anything or running AI work."));
    welcome.append(button("Start exploring", actions.dismissWelcome, "primary"));
    page.append(welcome);
  }
  const grid = node("div", "grid");
  grid.append(createServiceCard(snapshot, actions));
  const project = card("Example project");
  project.append(node("span", "example-label", workspace.label));
  project.append(node("h3", undefined, workspace.project.displayName));
  project.append(node("p", "muted", `${workspace.project.status} · ${workspace.project.planState}`));
  project.append(node("p", undefined, workspace.project.progress));
  const needs = card("Needs your attention");
  needs.append(node("strong", undefined, "Review one example approval"));
  needs.append(node("p", "help", "Inspecting it changes example-only state. It does not approve scope or save a decision."));
  if (state.approvalReviewed) needs.append(node("p", "notice", "Example marked as reviewed in this window only."));
  grid.append(project, needs);
  page.append(grid);
  return page;
}

export function createProjectsPage(workspace: DesktopWorkspacePresentation, state: ExampleUiState, actions: RendererActions): HTMLElement {
  const page = node("div", "page");
  page.append(heading("Explore a project journey", "Describe, preview and inspect the reusable intake, brief and plan components. This first-light build deliberately has no save operation."));
  page.append(node("p", "example-label", workspace.label));
  const grid = node("div", "grid");
  const intake = card("Describe a project", true);
  const label = node("label", undefined, "What would you like to build?");
  label.htmlFor = "intake-description";
  const textarea = node("textarea");
  textarea.id = "intake-description";
  textarea.maxLength = 2_000;
  textarea.placeholder = "Describe the outcome in your own words";
  textarea.value = state.intakeDraft;
  const preview = button("Preview example brief", () => actions.updateExample({ ...state, intakeDraft: textarea.value, previewed: true }), "primary");
  intake.append(label, textarea, node("p", "help", "Preview stays in this window. Nothing is written to a project database or repository."), preview);
  if (state.previewed) intake.append(node("p", "notice", "Preview prepared in memory only — not saved."));

  const brief = card("Brief and revision summary");
  brief.append(node("span", "muted", workspace.brief.revisionLabel));
  brief.append(node("h3", undefined, workspace.brief.objective));
  brief.append(node("p", "help", `${workspace.brief.openQuestionCount} open questions in this example.`));
  brief.append(node("strong", undefined, "Outcomes"), list(workspace.brief.outcomes));
  brief.append(node("strong", undefined, "Not included"), list(workspace.brief.nonGoals));

  const plan = card("Plan list");
  plan.append(node("span", "muted", `${workspace.plan.revisionLabel} · ${workspace.plan.state}`));
  for (const stage of workspace.plan.stages) {
    const item = node("article", "stage");
    const header = node("header");
    header.append(node("h3", undefined, stage.title), node("span", "muted", `${stage.taskCount} tasks`));
    item.append(header, node("p", "help", stage.intent), node("span", "muted", stage.gate === "operator-review" ? "Operator review gate" : "Automatic gate"));
    plan.append(item);
  }
  const details = button("Inspect example plan", () => {
    const content = node("div", "stack");
    content.append(node("p", undefined, `${workspace.plan.taskCount} tasks and ${workspace.plan.dependencyCount} dependency in this synthetic plan.`));
    content.append(node("p", "notice warning", "Authority is none. Approval, sealing and execution are not connected."));
    actions.openDialog("Example plan details", content, details);
  });
  plan.append(details);
  grid.append(intake, brief, plan);
  page.append(grid);
  return page;
}

export function createApprovalsPage(workspace: DesktopWorkspacePresentation, state: ExampleUiState, actions: RendererActions): HTMLElement {
  const page = node("div", "page");
  page.append(heading("Understand an approval before it exists", "This reusable summary shows scope, effects and exclusions. It cannot grant authority in this build."));
  page.append(node("p", "example-label", workspace.label));
  const summary = card("Example approval summary", true);
  const definitions = node("dl", "definition-list");
  const rows: readonly [string, string][] = [
    ["Request", workspace.approval.title], ["Class", workspace.approval.classLabel],
    ["Risk", workspace.approval.risk], ["State", workspace.approval.state],
    ["Scope", workspace.approval.scope], ["Spending", workspace.approval.moneyLabel],
    ["Expires", workspace.approval.expiryLabel], ["Reversible", workspace.approval.reversible ? "Yes" : "No"],
  ];
  for (const [term, description] of rows) definitions.append(node("dt", undefined, term), node("dd", undefined, description));
  summary.append(definitions, node("h3", undefined, "Potential effects"), list(workspace.approval.effects), node("h3", undefined, "Explicit exclusions"), list(workspace.approval.exclusions));
  const inspect = button("Inspect example", () => {
    const content = node("div", "stack");
    content.append(node("p", undefined, workspace.approval.why), node("p", undefined, workspace.approval.changes));
    content.append(node("p", "notice warning", "This dialog cannot approve, save, spend, publish or start work."));
    const mark = button("Mark example as reviewed", () => {
      actions.updateExample({ ...state, approvalReviewed: true });
      const dialog = document.querySelector<HTMLDialogElement>("#detail-dialog");
      dialog?.close();
    });
    content.append(mark);
    actions.openDialog("Inspect example approval", content, inspect);
  }, "primary");
  summary.append(inspect);
  if (state.approvalReviewed) summary.append(node("p", "notice", "Reviewed in example-only memory. No approval record was created."));
  page.append(summary);
  return page;
}

export function createUsagePage(snapshot: DesktopSnapshot): HTMLElement {
  const page = node("div", "page");
  page.append(heading("Usage policy, without invented usage", "These are published policy constants. No account, subscription, provider or credential was queried by this app."));
  const grid = node("div", "grid");
  const current = card("Current usage");
  current.append(node("strong", undefined, "Unknown"), node("p", "help", "Unknown usage cannot supply capacity or current eligibility."));
  const policy = card("Borrowed-profile limits");
  policy.append(node("p", undefined, `${snapshot.usagePolicy.borrowedFiveHourCapPercent}% of the five-hour window during ${snapshot.usagePolicy.workHours}.`));
  policy.append(node("p", undefined, `${snapshot.usagePolicy.borrowedWeeklyCapPercent}% of the weekly window at all times.`));
  policy.append(node("p", "help", `${snapshot.usagePolicy.weekdays.join(", ")} · ${snapshot.usagePolicy.timezone}`));
  grid.append(current, policy);
  page.append(grid);
  return page;
}

export function createSettingsPage(snapshot: DesktopSnapshot, onSave: (mode: "normal" | "developer", scale: "standard" | "large") => void): HTMLElement {
  const page = node("div", "page");
  page.append(heading("Workspace settings", "Only benign presentation preferences are stored in this app's dedicated development root."));
  const grid = node("div", "grid");
  const presentation = card("Presentation");
  const modeLabel = node("label", undefined, "Detail level"); modeLabel.htmlFor = "presentation-mode";
  const mode = node("select"); mode.id = "presentation-mode";
  for (const [value, label] of [["normal", "Normal"], ["developer", "Developer diagnostics"]] as const) {
    const option = node("option", undefined, label); option.value = value; option.selected = snapshot.preferences.presentationMode === value; mode.append(option);
  }
  mode.disabled = snapshot.state !== "ready";
  if (mode.disabled) mode.title = "Detail level can change after the local service is verified.";
  const scaleLabel = node("label", undefined, "Text size"); scaleLabel.htmlFor = "text-scale";
  const scale = node("select"); scale.id = "text-scale";
  for (const [value, label] of [["standard", "Standard"], ["large", "Large"]] as const) {
    const option = node("option", undefined, label); option.value = value; option.selected = snapshot.preferences.textScale === value; scale.append(option);
  }
  presentation.append(modeLabel, mode, node("p", "help", "Developer diagnostics add received technical context only. Authority and available actions remain identical. Detail level can change only while the local service is verified because changing it restarts this app's owned synthetic service."), scaleLabel, scale);
  presentation.append(button("Save presentation settings", () => onSave(mode.value as "normal" | "developer", scale.value as "standard" | "large"), "primary"));
  const credentials = card("Credentials");
  credentials.append(node("strong", undefined, "Managed by the established credential boundary"), node("p", "help", "This workspace intentionally has no secret field, reveal action, clipboard handler or credential API."));
  grid.append(presentation, credentials);
  if (snapshot.diagnostics !== null) {
    const diagnostics = card("Received diagnostics", true);
    const definitions = node("dl", "definition-list");
    for (const [term, description] of [
      ["Service version", snapshot.diagnostics.serviceVersion ?? "Unavailable"],
      ["Presentation", snapshot.diagnostics.presentationMode],
      ["Service ownership", "Owned child process"],
      ["Verification connection", "Closed after check"],
      ["Runtime storage", "Dedicated disposable development root"],
    ]) definitions.append(node("dt", undefined, term), node("dd", undefined, description));
    diagnostics.append(definitions, node("p", "notice", "Authority: none. Commands: none."));
    grid.append(diagnostics);
  }
  page.append(grid);
  return page;
}
