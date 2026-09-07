import type {
  PlanningCommand,
  PlanningProjectView,
  PlanningTaskInput,
  PlanningWorkspaceView,
} from "@ai-dev-os/application/planning-contracts";
import {
  adaptPlanningWorkspace,
  formatMinorUnits,
  formatObservedAt,
  formatPlanningState,
  shortDigest,
} from "../presentation/adapter.js";
import type { DesktopSnapshot } from "../shared/contracts.js";

export interface CommandNotice {
  readonly tone: "info" | "warning" | "danger";
  readonly text: string;
}
export interface PendingCommand { readonly commandId: string; readonly label: string; }
export interface WorkflowUiState {
  readonly busy: boolean;
  readonly pending: PendingCommand | null;
  readonly reloadRequired: boolean;
  readonly notice: CommandNotice | null;
}
export type WorkspaceRoute = "home" | "project" | "plan" | "approvals" | "handovers" | "settings";
export interface RendererActions {
  readonly retryService: () => void;
  readonly openReadOnly: () => void;
  readonly relaunch: () => void;
  readonly quit: () => void;
  readonly dismissWelcome: () => void;
  readonly selectProject: (projectId: string) => void;
  readonly navigate: (route: WorkspaceRoute) => void;
  readonly runPlanningCommand: (command: PlanningCommand, label: string) => void;
  readonly observePending: () => void;
  readonly reloadPlanning: () => void;
  readonly viewHandover: (projectId: string, handoverId: string, revision: number) => void;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (className !== undefined) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}
function heading(title: string, description: string): HTMLElement {
  const head = node("header", "page-head");
  head.append(node("span", "eyebrow", "Local planning workspace"));
  const h1 = node("h1", undefined, title); h1.tabIndex = -1;
  head.append(h1, node("p", undefined, description));
  return head;
}
function card(title: string, wide = false): HTMLElement {
  const value = node("section", `card${wide ? " wide" : ""}`);
  value.append(node("h2", undefined, title));
  return value;
}
function list(items: readonly string[], empty = "None recorded"): HTMLElement {
  if (items.length === 0) return node("p", "muted", empty);
  const value = node("ul");
  for (const item of items) value.append(node("li", undefined, item));
  return value;
}
function button(label: string, action: () => void, style?: string): HTMLButtonElement {
  const value = node("button", style, label); value.type = "button";
  value.addEventListener("click", action); return value;
}
function labelFor(id: string, text: string): HTMLLabelElement {
  const value = node("label", undefined, text); value.htmlFor = id; return value;
}
function textInput(id: string, value = "", maxLength = 240): HTMLInputElement {
  const input = node("input"); input.id = id; input.type = "text"; input.value = value; input.maxLength = maxLength; return input;
}
function textarea(id: string, value = "", maxLength = 4_000): HTMLTextAreaElement {
  const input = node("textarea"); input.id = id; input.value = value; input.maxLength = maxLength; return input;
}
function lines(value: string): readonly string[] {
  return Object.freeze(value.split(/\r?\n/u).map((entry) => entry.trim()).filter((entry) => entry.length > 0));
}
function validateLines(control: HTMLTextAreaElement, label: string, required: boolean): readonly string[] {
  const values = lines(control.value);
  const message = required && values.length === 0 ? `Enter at least one ${label}.`
    : values.length > 16 ? `Enter no more than 16 ${label}s.`
      : values.some((value) => value.length > 2_000) ? `Keep each ${label} within 2,000 characters.` : "";
  control.setCustomValidity(message); return values;
}
function requireText(control: HTMLInputElement | HTMLTextAreaElement, message: string): void {
  control.setCustomValidity(control.value.trim().length === 0 ? message : "");
}
function commandId(): string { return crypto.randomUUID(); }
function canChange(snapshot: DesktopSnapshot, state: WorkflowUiState, project?: PlanningProjectView): boolean {
  return snapshot.state === "ready" && !state.busy && !state.reloadRequired && state.pending === null && project?.stopped !== true;
}
function canRecordHistory(snapshot: DesktopSnapshot, state: WorkflowUiState): boolean {
  return snapshot.state === "ready" && !state.busy && !state.reloadRequired && state.pending === null;
}
function mutationReason(snapshot: DesktopSnapshot, state: WorkflowUiState, project?: PlanningProjectView): string {
  if (snapshot.state !== "ready") return "Changes are unavailable until the local workspace is ready.";
  if (state.pending !== null) return "Observe the uncertain command outcome before making another change.";
  if (state.reloadRequired) return "Reload the saved project before making another change.";
  if (project?.stopped === true) return "Resume this project before making changes.";
  return "Wait for the current change to finish.";
}
function gateAction(control: HTMLButtonElement, allowed: boolean, explanation: string): HTMLButtonElement {
  control.dataset["planningAction"] = "true";
  control.dataset["planningAllowed"] = allowed ? "true" : "false";
  control.dataset["planningReason"] = explanation;
  control.disabled = !allowed; if (!allowed) control.title = explanation; return control;
}
function field(label: HTMLLabelElement, control: HTMLElement, wide = false): HTMLElement {
  const wrapper = node("div", wide ? "field form-wide" : "field"); wrapper.append(label, control); return wrapper;
}
function actionRow(...controls: HTMLElement[]): HTMLElement {
  const row = node("div", "actions form-wide"); row.append(...controls); return row;
}

export function createCommandStatus(snapshot: DesktopSnapshot, state: WorkflowUiState, actions: RendererActions): HTMLElement | null {
  if (state.pending === null && !state.reloadRequired && state.notice === null && !state.busy) return null;
  const value = node("section", "command-status"); value.setAttribute("aria-label", "Save status"); value.tabIndex = -1;
  if (state.notice !== null) value.append(node("p", `notice${state.notice.tone === "info" ? "" : ` ${state.notice.tone}`}`, state.notice.text));
  if (state.busy) value.append(node("p", "notice", "Working with the saved workspace…"));
  if (state.pending !== null) {
    const uncertain = node("div", "notice warning");
    const observe = button("Observe outcome", actions.observePending, "primary"); observe.disabled = snapshot.state !== "ready" || state.busy; if (observe.disabled) observe.title = "The outcome can be checked after the local workspace is ready.";
    uncertain.append(node("strong", undefined, "Outcome needs checking"), node("p", "help", `${state.pending.label} may already be saved. Check command ${state.pending.commandId} rather than repeating the action.`), observe);
    value.append(uncertain);
  }
  if (state.reloadRequired) {
    const stale = node("div", "notice warning");
    const reload = button("Reload saved project", actions.reloadPlanning, "primary"); reload.disabled = snapshot.state !== "ready" || state.busy; if (reload.disabled) reload.title = "The project can be reloaded after the local workspace is ready.";
    stale.append(node("strong", undefined, "Saved project changed"), node("p", "help", "Reload the latest saved version before editing or approving anything else."), reload);
    value.append(stale);
  }
  return value;
}

function serviceActions(snapshot: DesktopSnapshot, actions: RendererActions): HTMLElement | null {
  const group = node("div", "actions");
  if (snapshot.state === "failed-start") {
    if (!snapshot.recoveryAvailable) return null;
    group.append(button("Relaunch", actions.relaunch, "primary"));
    const readOnly = button("Open read-only", actions.openReadOnly); readOnly.disabled = !snapshot.readOnlyAvailable;
    if (readOnly.disabled) readOnly.title = "No verified saved view is available yet.";
    group.append(readOnly, button("Quit", actions.quit, "danger-button")); return group;
  }
  if (snapshot.state === "service-lost") {
    group.append(button("Retry", actions.retryService, "primary"));
    const readOnly = button("Continue read-only", actions.openReadOnly); readOnly.disabled = !snapshot.readOnlyAvailable;
    group.append(readOnly, button("Quit", actions.quit, "danger-button")); return group;
  }
  if (snapshot.state === "read-only") {
    group.append(button("Retry", actions.retryService, "primary"), button("Quit", actions.quit, "danger-button")); return group;
  }
  return null;
}
export function createServiceCard(snapshot: DesktopSnapshot, actions: RendererActions): HTMLElement {
  const value = card("Workspace availability", true);
  const tone = snapshot.state === "ready" ? "" : snapshot.state === "loading" ? " warning" : " danger";
  const status = node("div", `notice${tone}`); status.append(node("strong", undefined, snapshot.statusText));
  const explanation = snapshot.state === "ready"
    ? "Saved planning is available. This app does not run AI tasks, contact providers or spend money."
    : snapshot.state === "read-only" ? "You can inspect the last saved view, but changes are disabled."
      : snapshot.state === "loading" ? "Saved planning will become available after the local workspace finishes starting."
        : "Changes are disabled while the local workspace is unavailable.";
  status.append(node("p", "help", explanation)); value.append(status);
  const controls = serviceActions(snapshot, actions); if (controls !== null) value.append(controls); return value;
}

function parseBudget(value: string, currency: string): number | null {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/u.exec(value.trim()); if (match === null) return null;
  let digits = 2;
  try { digits = new Intl.NumberFormat("en-GB", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { /* The application will validate the currency code. */ }
  const enteredFraction = match[2] ?? ""; if (enteredFraction.length > digits || (digits === 0 && enteredFraction.length > 0)) return null;
  const whole = Number(match[1]); const fraction = digits === 0 ? 0 : Number(enteredFraction.padEnd(digits, "0")); const total = (whole * (10 ** digits)) + fraction;
  return Number.isSafeInteger(total) && total <= 1_000_000_000 ? total : null;
}
function createNewProjectCard(snapshot: DesktopSnapshot, state: WorkflowUiState, actions: RendererActions): HTMLElement {
  const value = card("Create a project", true); const form = node("form", "form-grid");
  const name = textInput("new-project-name", "", 200); name.required = true;
  const objective = textarea("new-project-objective", "", 4_096); objective.required = true;
  const outcomes = textarea("new-project-outcomes", "", 32_015); outcomes.required = true;
  const budget = textInput("new-project-budget", "", 30); budget.required = true; budget.inputMode = "decimal"; budget.placeholder = "2500.00";
  const currency = node("select"); currency.id = "new-project-currency";
  for (const code of ["GBP", "USD", "EUR"] as const) { const option = node("option", undefined, code); option.value = code; currency.append(option); }
  form.append(field(labelFor(name.id, "Project name"), name), field(labelFor(currency.id, "Budget currency"), currency), field(labelFor(objective.id, "Objective"), objective, true), field(labelFor(outcomes.id, "Desired outcomes (one per line)"), outcomes, true), field(labelFor(budget.id, "Planning budget amount"), budget));
  const save = button("Create project", () => undefined, "primary"); save.type = "submit"; gateAction(save, canChange(snapshot, state), mutationReason(snapshot, state));
  form.append(node("p", "help form-wide", "Windows will ask you to choose the project repository folder while creating this record. The budget is a local planning limit; creating the project does not connect an account or authorise spending."), actionRow(save));
  form.addEventListener("submit", (event) => {
    event.preventDefault(); const budgetMinorUnits = parseBudget(budget.value, currency.value); const desired = validateLines(outcomes, "desired outcome", true);
    requireText(name, "Enter a project name."); requireText(objective, "Enter the project objective.");
    budget.setCustomValidity(budgetMinorUnits === null ? "Enter a non-negative amount within the supported range, using the currency's decimal places." : "");
    if (!form.reportValidity() || budgetMinorUnits === null) return;
    actions.runPlanningCommand(Object.freeze({ kind: "create-project", commandId: commandId(), name: name.value.trim(), objective: objective.value.trim(), outcomes: desired, budgetMinorUnits, currency: currency.value }), "Project creation");
  });
  value.append(form); return value;
}
export function createHomePage(snapshot: DesktopSnapshot, workspace: PlanningWorkspaceView, state: WorkflowUiState, actions: RendererActions): HTMLElement {
  const page = node("div", "page"); page.append(heading("Your saved projects", "Create a local planning project or continue one you have already saved. Planning remains manual in this milestone."));
  if (snapshot.firstLaunch) {
    const welcome = card("Welcome", true); const dismiss = button("Got it", actions.dismissWelcome, "primary"); gateAction(dismiss, snapshot.state === "ready", "This preference can be saved after the local workspace is ready."); welcome.append(node("p", undefined, "Use this workspace to shape a brief, save a plan, record scope approval and exchange a planning handover. It does not generate a plan or run the work for you."), dismiss); page.append(welcome);
  }
  page.append(createServiceCard(snapshot, actions)); const presentation = adaptPlanningWorkspace(workspace); const projects = card("Projects", true);
  if (presentation.projects.length === 0) projects.append(node("p", "muted", "No saved projects yet."));
  else {
    const projectList = node("div", "project-list");
    for (const project of presentation.projects) {
      const item = node("article", "project-row"); const summary = node("div");
      summary.append(node("h3", undefined, project.name), node("p", "muted", `${project.stateLabel} · ${project.versionLabel}`));
      item.append(summary, button("Open project", () => actions.selectProject(project.projectId), "primary")); projectList.append(item);
    }
    projects.append(projectList);
  }
  page.append(projects, createNewProjectCard(snapshot, state, actions)); return page;
}
function noProject(actions: RendererActions): HTMLElement {
  const page = node("div", "page"); page.append(heading("Choose a project", "Select a saved project before working on its brief, plan, approvals or handovers."));
  const value = card("No project selected", true); value.append(button("View projects", () => actions.navigate("home"), "primary")); page.append(value); return page;
}
function projectHeader(project: PlanningProjectView): HTMLElement {
  const value = node("div", "project-title"); value.append(node("h2", undefined, project.name)); const badges = node("div", "badge-row");
  badges.append(node("span", "status-badge", project.stopped ? "Stopped" : "Active"), node("span", "status-badge", `Saved version ${project.version}`)); value.append(badges); return value;
}
function createRepositoryCard(snapshot: DesktopSnapshot, state: WorkflowUiState, project: PlanningProjectView, actions: RendererActions): HTMLElement {
  const value = card("Repository", true);
  if (project.repository === null) value.append(node("p", "muted", "No repository selected."));
  else {
    const details = node("dl", "definition-list"); details.append(node("dt", undefined, "Folder"), node("dd", undefined, project.repository.rootLeaf), node("dt", undefined, "State"), node("dd", undefined, formatPlanningState(project.repository.state)), node("dt", undefined, "Branch"), node("dd", undefined, project.repository.branch ?? "Not available"), node("dt", undefined, "Observed HEAD reference"), node("dd", undefined, project.repository.head === null ? "Not available" : shortDigest(project.repository.head)), node("dt", undefined, "Observed"), node("dd", undefined, formatObservedAt(project.repository.observedAt)));
    value.append(details, list(project.repository.facts, "No additional repository facts recorded."));
  }
  const select = button(project.repository === null ? "Select repository" : "Select another repository", () => actions.runPlanningCommand(Object.freeze({ kind: "select-repository", commandId: commandId(), projectId: project.projectId, expectedProjectVersion: project.version }), "Repository selection"), "primary");
  gateAction(select, canChange(snapshot, state, project), mutationReason(snapshot, state, project)); value.append(node("p", "help", "Windows will ask you to choose a folder. The app records a bounded observation and does not change the repository."), actionRow(select)); return value;
}
function createBriefEditor(snapshot: DesktopSnapshot, state: WorkflowUiState, project: PlanningProjectView, actions: RendererActions): HTMLElement {
  const value = card(project.brief === null ? "Draft the brief" : "Revise the brief candidate", true); const seed = project.candidate ?? project.brief; const form = node("form", "form-grid");
  const objective = textarea("brief-objective", seed?.objective ?? "", 4_096); objective.required = true;
  const outcomes = textarea("brief-outcomes", seed?.outcomes.join("\n") ?? "", 32_015); outcomes.required = true;
  const nonGoals = textarea("brief-non-goals", project.brief?.nonGoals.join("\n") ?? "", 32_015); const audiences = textarea("brief-audiences", project.brief?.audiences.join("\n") ?? "", 32_015);
  form.append(field(labelFor(objective.id, "Objective"), objective, true), field(labelFor(outcomes.id, "Desired outcomes (one per line)"), outcomes, true), field(labelFor(nonGoals.id, "Not included (one per line)"), nonGoals), field(labelFor(audiences.id, "Audiences (one per line)"), audiences));
  const draft = button("Prepare brief candidate", () => undefined, "primary"); draft.type = "submit"; gateAction(draft, canChange(snapshot, state, project), mutationReason(snapshot, state, project));
  form.append(node("p", "help form-wide", "Candidates and clarification answers remain temporary until you accept the exact candidate shown below."), actionRow(draft));
  form.addEventListener("submit", (event) => {
    event.preventDefault(); requireText(objective, "Enter the brief objective."); const desired = validateLines(outcomes, "desired outcome", true); const excluded = validateLines(nonGoals, "non-goal", false); const readers = validateLines(audiences, "audience", false); if (!form.reportValidity()) return;
    actions.runPlanningCommand(Object.freeze({ kind: "draft-brief", projectId: project.projectId, objective: objective.value.trim(), outcomes: desired, nonGoals: excluded, audiences: readers, expectedBriefVersion: project.brief?.version ?? 0 }), "Brief candidate");
  });
  value.append(form); return value;
}
function createCandidateCard(snapshot: DesktopSnapshot, state: WorkflowUiState, project: PlanningProjectView, actions: RendererActions): HTMLElement | null {
  const candidate = project.candidate; if (candidate === null) return null; const value = card("Brief candidate", true);
  value.append(node("p", "digest", `Candidate ${shortDigest(candidate.digest)}`), node("h3", undefined, candidate.objective), list(candidate.outcomes));
  if (candidate.questions.length > 0) {
    const form = node("form", "stack clarification-form"); form.append(node("h3", undefined, "Clarification questions")); const answers: { questionId: string; input: HTMLTextAreaElement }[] = [];
    for (const question of candidate.questions) {
      const wrapper = node("div", "question"); const input = textarea(`question-${question.questionId}`, question.proposedDefault, 1_024); input.required = question.blocking;
      wrapper.append(labelFor(input.id, question.question), node("p", "help", question.whyItMatters), input); form.append(wrapper); answers.push({ questionId: question.questionId, input });
    }
    const answer = button("Apply answers", () => undefined, "primary"); answer.type = "submit"; gateAction(answer, canChange(snapshot, state, project), mutationReason(snapshot, state, project)); form.append(actionRow(answer));
    form.addEventListener("submit", (event) => {
      event.preventDefault(); for (const entry of answers) if (entry.input.required) requireText(entry.input, "Answer this blocking question."); if (!form.reportValidity()) return;
      actions.runPlanningCommand(Object.freeze({ kind: "answer-clarification", projectId: project.projectId, candidateId: candidate.candidateId, answers: Object.freeze(answers.map((entry) => Object.freeze({ questionId: entry.questionId, value: entry.input.value.trim() }))) }), "Clarification answers");
    });
    value.append(form);
  }
  const accept = button("Accept this exact brief", () => actions.runPlanningCommand(Object.freeze({ kind: "accept-brief", commandId: commandId(), projectId: project.projectId, candidateId: candidate.candidateId, candidateDigest: candidate.digest, expectedBriefVersion: project.brief?.version ?? 0 }), "Brief acceptance"), "primary");
  gateAction(accept, candidate.ready && canChange(snapshot, state, project), candidate.ready ? mutationReason(snapshot, state, project) : "Answer the blocking clarification questions first.");
  value.append(node("p", "help", candidate.ready ? "Acceptance saves this exact candidate and digest." : "This candidate still needs clarification."), actionRow(accept)); return value;
}
export function createProjectPage(snapshot: DesktopSnapshot, workspace: PlanningWorkspaceView, state: WorkflowUiState, actions: RendererActions): HTMLElement {
  const project = workspace.selected; if (project === null) return noProject(actions); const page = node("div", "page");
  page.append(heading("Project brief", "Select a repository, shape the brief and accept the exact candidate you reviewed."), projectHeader(project));
  const summary = card("Saved project", true); summary.append(node("p", undefined, `Local budget: ${formatMinorUnits(project.budget.minorUnits, project.budget.currency)}`));
  if (project.brief !== null) summary.append(node("p", "digest", `Accepted brief ${shortDigest(project.brief.digest)} · version ${project.brief.version}`), node("h3", undefined, project.brief.objective), node("strong", undefined, "Outcomes"), list(project.brief.outcomes), node("strong", undefined, "Not included"), list(project.brief.nonGoals), node("strong", undefined, "Audiences"), list(project.brief.audiences));
  else summary.append(node("p", "muted", "No brief has been accepted yet."));
  page.append(summary, createRepositoryCard(snapshot, state, project, actions), createBriefEditor(snapshot, state, project, actions)); const candidate = createCandidateCard(snapshot, state, project, actions); if (candidate !== null) page.append(candidate); return page;
}

function taskEditor(task: PlanningTaskInput, index: number, remove: () => void): HTMLElement {
  const value = node("fieldset", "task-editor"); const legend = node("legend", undefined, `Task ${index + 1}`);
  const title = textInput(`task-${index}-title`, task.title, 300); title.required = true; title.dataset["taskField"] = "title";
  const objective = textarea(`task-${index}-objective`, task.objective, 2_000); objective.required = true; objective.dataset["taskField"] = "objective";
  const criteria = textarea(`task-${index}-criteria`, task.acceptanceCriteria.join("\n"), 32_015); criteria.required = true; criteria.dataset["taskField"] = "criteria";
  value.append(legend, labelFor(title.id, "Title"), title, labelFor(objective.id, "Objective"), objective, labelFor(criteria.id, "Acceptance criteria (one per line)"), criteria, actionRow(button("Remove task", remove, "danger-button"))); return value;
}
function collectTasks(container: HTMLElement, validate: boolean): PlanningTaskInput[] {
  const values: PlanningTaskInput[] = [];
  for (const editor of container.querySelectorAll<HTMLElement>(".task-editor")) {
    const title = editor.querySelector<HTMLInputElement>('[data-task-field="title"]'); const objective = editor.querySelector<HTMLTextAreaElement>('[data-task-field="objective"]'); const criteria = editor.querySelector<HTMLTextAreaElement>('[data-task-field="criteria"]');
    if (title === null || objective === null || criteria === null) continue; const acceptanceCriteria = lines(criteria.value);
    if (validate) { requireText(title, "Enter a task title."); requireText(objective, "Enter the task objective."); validateLines(criteria, "acceptance criterion", true); } values.push({ title: title.value.trim(), objective: objective.value.trim(), acceptanceCriteria });
  }
  return values;
}
export function createPlanPage(snapshot: DesktopSnapshot, workspace: PlanningWorkspaceView, state: WorkflowUiState, actions: RendererActions): HTMLElement {
  const project = workspace.selected; if (project === null) return noProject(actions); const page = node("div", "page");
  page.append(heading("Plan the work", "Write and save the plan yourself. This workspace does not generate tasks or execute them."), projectHeader(project));
  if (project.brief === null) {
    const missing = card("Accept a brief first", true); missing.append(node("p", undefined, "A saved plan must be bound to an accepted brief."), button("Go to project brief", () => actions.navigate("project"), "primary")); page.append(missing); return page;
  }
  const plan = project.plan; const editor = card(plan === null ? "New plan" : "Edit plan", true);
  if (plan !== null) editor.append(node("p", "digest", `Revision ${plan.revision} · ${formatPlanningState(plan.state)} · ${shortDigest(plan.digest)}`));
  const form = node("form", "stack"); const title = textInput("plan-title", plan?.title ?? "", 300); title.required = true; const scope = node("select"); scope.id = "plan-scope";
  for (const [value, label] of [["within-brief", "Within the accepted brief"], ["scope-expansion", "Expands beyond the accepted brief"]] as const) { const option = node("option", undefined, label); option.value = value; option.selected = (plan?.scope ?? "within-brief") === value; scope.append(option); }
  const tasks = node("div", "stack task-list"); const seed: readonly PlanningTaskInput[] = plan?.tasks.length ? plan.tasks : [{ title: "", objective: "", acceptanceCriteria: [""] }]; let add: HTMLButtonElement | null = null;
  const renderTasks = (values: readonly PlanningTaskInput[]): void => {
    tasks.replaceChildren(); values.forEach((task, index) => tasks.append(taskEditor(task, index, () => { const current = collectTasks(tasks, false); current.splice(index, 1); renderTasks(current.length === 0 ? [{ title: "", objective: "", acceptanceCriteria: [""] }] : current); })));
    if (add !== null) { add.disabled = values.length >= 32; add.title = values.length >= 32 ? "A plan can contain up to 32 tasks." : ""; }
  };
  renderTasks(seed);
  add = button("Add task", () => { const current = collectTasks(tasks, false); if (current.length >= 32) return; current.push({ title: "", objective: "", acceptanceCriteria: [""] }); renderTasks(current); });
  if (seed.length >= 32) { add.disabled = true; add.title = "A plan can contain up to 32 tasks."; }
  const save = button("Save plan draft", () => undefined, "primary"); save.type = "submit";
  const savedStateAllowsRevision = plan === null || ["drafting", "proposed", "sealed"].includes(plan.state);
  gateAction(save, savedStateAllowsRevision && canChange(snapshot, state, project), savedStateAllowsRevision ? mutationReason(snapshot, state, project) : "Complete or reload the current scope decision before saving another plan revision.");
  form.append(labelFor(title.id, "Plan title"), title, labelFor(scope.id, "Scope"), scope, node("p", "help", "Choose scope expansion when the plan goes beyond the accepted brief. Exact approval will be required before sealing."), tasks, actionRow(add, save));
  form.addEventListener("submit", (event) => {
    event.preventDefault(); requireText(title, "Enter a plan title."); const taskValues = collectTasks(tasks, true); if (!form.reportValidity() || taskValues.length === 0) return;
    actions.runPlanningCommand(Object.freeze({ kind: "save-plan", commandId: commandId(), projectId: project.projectId, expectedPlanVersion: plan?.version ?? 0, title: title.value.trim(), tasks: Object.freeze(taskValues.map((task) => Object.freeze({ ...task, acceptanceCriteria: Object.freeze(task.acceptanceCriteria) }))), scope: scope.value as "within-brief" | "scope-expansion" }), "Plan draft");
  });
  editor.append(form); page.append(editor);
  if (plan !== null) {
    const actionsCard = card("Plan actions", true);
    if (plan.actions.length === 0) actionsCard.append(node("p", "muted", plan.state === "sealed" ? "This plan is sealed." : "No plan action is available for the current saved state."));
    else {
      actionsCard.append(node("p", "help", "Only actions available for this exact saved revision are shown. Scope approval opens a trusted system confirmation.")); const row = node("div", "actions"); const labels = { "prepare-plan": "Prepare plan", "approve-scope": "Review and approve scope", "seal-plan": "Seal plan" } as const;
      for (const kind of plan.actions) { const action = button(labels[kind], () => actions.runPlanningCommand(Object.freeze({ kind, commandId: commandId(), projectId: project.projectId, expectedPlanVersion: plan.version }), labels[kind]), kind === "approve-scope" ? "primary" : undefined); gateAction(action, canChange(snapshot, state, project), mutationReason(snapshot, state, project)); row.append(action); }
      actionsCard.append(row);
    }
    page.append(actionsCard);
  }
  return page;
}

function stopResumeCard(snapshot: DesktopSnapshot, state: WorkflowUiState, project: PlanningProjectView, actions: RendererActions): HTMLElement {
  const value = card("Project state", true); const kind = project.stopped ? "resume-project" : "stop-project"; const label = project.stopped ? "Resume project" : "Stop project";
  value.append(node("p", undefined, project.stopped ? "This project is stopped. Resume only reopens local planning actions; it starts no work." : "Stopping pauses supported local changes. This app has no AI process to terminate."));
  const control = button(label, () => actions.runPlanningCommand(Object.freeze({ kind, commandId: commandId(), projectId: project.projectId, expectedProjectVersion: project.version }), label), project.stopped ? "primary" : "danger-button");
  gateAction(control, snapshot.state === "ready" && !state.busy && !state.reloadRequired && state.pending === null, mutationReason(snapshot, state)); value.append(actionRow(control)); return value;
}
export function createApprovalsPage(snapshot: DesktopSnapshot, workspace: PlanningWorkspaceView, state: WorkflowUiState, actions: RendererActions): HTMLElement {
  const project = workspace.selected; if (project === null) return noProject(actions); const page = node("div", "page");
  page.append(heading("Approvals and history", "Review saved decisions and past events. Money actions here only record historical facts exposed by the saved project; they cannot make a payment."), projectHeader(project), stopResumeCard(snapshot, state, project, actions));
  const approvals = card("Approval history", true);
  if (project.approvals.length === 0) approvals.append(node("p", "muted", "No approval records yet."));
  for (const approval of project.approvals) {
    const item = node("article", "record"); const head = node("div", "record-head"); head.append(node("h3", undefined, approval.title), node("span", "status-badge", formatPlanningState(approval.state)));
    item.append(head, node("p", undefined, approval.context), node("p", "digest", `Approval ${shortDigest(approval.approvalId)} · version ${approval.version}`));
    if (approval.actions.length > 0) {
      const receiptId = `receipt-${approval.approvalId}`; const receipt = textInput(receiptId, "", 128); receipt.placeholder = "Manual receipt reference 1"; receipt.pattern = "[A-Za-z0-9][A-Za-z0-9 ._\\-]{0,127}";
      if (approval.actions.includes("record-receipt")) item.append(labelFor(receiptId, "Receipt reference"), receipt); const row = node("div", "actions"); const labels = { "report-executed": "Report past execution", "record-receipt": "Record receipt", "withdraw": "Withdraw historical request" } as const;
      for (const actionKind of approval.actions) {
        const control = button(labels[actionKind], () => {
          let receiptRef: string | null = null;
          if (actionKind === "record-receipt") {
            const proposedReceiptRef = receipt.value.trim();
            receipt.required = true;
            receipt.setCustomValidity(/[A-Fa-f0-9]{32}/u.test(proposedReceiptRef) ? "Use a short human receipt reference, not a digest." : "");
            if (!receipt.reportValidity()) return;
            receiptRef = proposedReceiptRef;
          }
          actions.runPlanningCommand(Object.freeze({ kind: "historical-money", commandId: commandId(), projectId: project.projectId, approvalId: approval.approvalId, expectedApprovalVersion: approval.version, expectedSpendingVersion: approval.spendingVersion, action: actionKind, receiptRef }), labels[actionKind]);
        }); gateAction(control, canRecordHistory(snapshot, state), mutationReason(snapshot, state)); row.append(control);
      }
      item.append(node("p", "help", "These controls record an operator-reported past fact. They do not verify external evidence, renew authority or spend money."), row);
    }
    approvals.append(item);
  }
  page.append(approvals); const history = card("Project history", true);
  if (project.history.length === 0) history.append(node("p", "muted", "No saved events yet."));
  else { const timeline = node("ol", "timeline"); for (const event of project.history) { const item = node("li"); item.append(node("strong", undefined, formatPlanningState(event.kind)), node("span", "muted", formatObservedAt(event.at))); timeline.append(item); } history.append(timeline); }
  page.append(history); return page;
}

export function createHandoversPage(snapshot: DesktopSnapshot, workspace: PlanningWorkspaceView, state: WorkflowUiState, actions: RendererActions): HTMLElement {
  const project = workspace.selected; if (project === null) return noProject(actions); const page = node("div", "page");
  page.append(heading("Planning handovers", "Export the saved brief and plan binding, then reopen a returned handover to attach an operator-supplied result."), projectHeader(project));
  const exportCard = card("Export current planning handover", true); exportCard.append(node("p", undefined, project.plan === null ? "Save a plan before exporting a handover." : `The export will bind plan revision ${project.plan.revision} and digest ${shortDigest(project.plan.digest)}.`), node("p", "help", "A planning handover carries no execution authority and contains no invented run, task or completion receipt."));
  const exportButton = button("Export handover", () => { if (project.plan !== null) actions.runPlanningCommand(Object.freeze({ kind: "export-handover", commandId: commandId(), projectId: project.projectId, expectedPlanVersion: project.plan.version }), "Handover export"); }, "primary");
  gateAction(exportButton, project.plan !== null && canChange(snapshot, state, project), project.plan === null ? "Save a plan first." : mutationReason(snapshot, state, project)); exportCard.append(actionRow(exportButton)); page.append(exportCard);
  const saved = card("Saved handovers", true); if (project.handovers.length === 0) saved.append(node("p", "muted", "No planning handovers have been exported yet."));
  for (const handover of project.handovers) {
    const item = node("article", `record${handover.stale ? " stale-record" : ""}`); const head = node("div", "record-head"); head.append(node("h3", undefined, `Planning handover, revision ${handover.planRevision}`), node("span", `status-badge${handover.stale ? " warning" : ""}`, handover.stale ? "Stale binding" : "Current binding"));
    const open = button("Open saved handover", () => actions.viewHandover(project.projectId, handover.handoverId, handover.planRevision));
    const canView = snapshot.state === "ready" && !state.busy;
    open.disabled = !canView;
    if (!canView) open.title = state.busy ? "Wait for the current action to finish." : "The saved handover can be opened after the local workspace is ready.";
    item.append(head, node("p", "help handover-path", `Saved file: ${handover.fileName}`), node("p", "digest", `Plan revision ${handover.planRevision} · ${shortDigest(handover.planDigest)}`), actionRow(open));
    if (handover.result === null) {
      item.append(node("p", "muted", "No returned result attached."));
      const attach = button("Open returned handover and attach result", () => actions.runPlanningCommand(Object.freeze({ kind: "attach-result", commandId: commandId(), projectId: project.projectId, handoverId: handover.handoverId }), "Returned handover attachment")); gateAction(attach, canChange(snapshot, state, project), mutationReason(snapshot, state, project));
      item.append(node("p", "help", "Windows will ask you to choose the returned file. Its prose remains untrusted and cannot approve or start work."), actionRow(attach));
    } else item.append(node("p", "help", `Operator-supplied, untrusted information${handover.result.stale ? " · stale" : ""}`), node("blockquote", "manual-result", handover.result.text), node("p", "help", "This saved result is append-only. Export another handover if you need to attach a different return."));
    saved.append(item);
  }
  page.append(saved); return page;
}

export function createSettingsPage(snapshot: DesktopSnapshot, onSave: (mode: "normal" | "developer", scale: "standard" | "large") => void): HTMLElement {
  const page = node("div", "page"); page.append(heading("Workspace settings", "Change how the workspace is presented. Normal and Developer modes have the same actions.")); const grid = node("div", "grid"); const presentation = card("Presentation");
  const mode = node("select"); mode.id = "presentation-mode";
  for (const [value, label] of [["normal", "Normal"], ["developer", "Developer diagnostics"]] as const) { const option = node("option", undefined, label); option.value = value; option.selected = snapshot.preferences.presentationMode === value; mode.append(option); }
  mode.disabled = snapshot.state !== "ready"; if (mode.disabled) mode.title = "Detail level can change after the local workspace is ready."; const scale = node("select"); scale.id = "text-scale";
  for (const [value, label] of [["standard", "Standard"], ["large", "Large"]] as const) { const option = node("option", undefined, label); option.value = value; option.selected = snapshot.preferences.textScale === value; scale.append(option); }
  const save = button("Save presentation settings", () => onSave(mode.value as "normal" | "developer", scale.value as "standard" | "large"), "primary"); gateAction(save, snapshot.state === "ready", "Settings can be saved after the local workspace is ready.");
  presentation.append(labelFor(mode.id, "Detail level"), mode, labelFor(scale.id, "Text size"), scale, save);
  const capabilities = card("What this milestone does"); capabilities.append(list(["Saves local project planning records", "Supports manual brief and plan editing", "Records exact approval and handover history"]), node("p", "help", "AI generation, provider execution, credentials, live account usage and payments are unavailable.")); grid.append(presentation, capabilities);
  if (snapshot.diagnostics !== null) { const diagnostics = card("Developer diagnostics", true); const definitions = node("dl", "definition-list"); for (const [term, description] of [["Service version", snapshot.diagnostics.serviceVersion ?? "Unavailable"], ["Presentation", snapshot.diagnostics.presentationMode], ["Planning authority", "None"]]) definitions.append(node("dt", undefined, term), node("dd", undefined, description)); diagnostics.append(definitions); grid.append(diagnostics); }
  page.append(grid); return page;
}
