import type { PlanningProjectView, PlanningWorkspaceView } from "@ai-dev-os/application/planning-contracts";
import type { DesktopSnapshot } from "../shared/contracts.js";
import { aiPlanningReasonMessage, aiPlanningRequestMessage, aiSavedAnswerReadiness } from "../presentation/adapter.js";
import type { RendererActions, WorkflowUiState } from "./components.js";
import { PlanningEditBuffer, planningDraftContent } from "./planning-edit-buffer.js";

type Session = NonNullable<PlanningProjectView["aiPlanning"]["currentSession"]>;
type Draft = Session["draft"];
const edits = new PlanningEditBuffer();
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className !== undefined) value.className = className; return value;
}
function section(title: string): HTMLElement { const value = element("section", undefined, "card wide"); value.append(element("h2", title)); return value; }
function paragraphs(parent: HTMLElement, title: string, items: readonly string[]): void {
  parent.append(element("h3", title));
  if (items.length === 0) { parent.append(element("p", "None recorded.", "muted")); return; }
  const list = element("ul"); for (const item of items) list.append(element("li", item)); parent.append(list);
}
function modelNotes(parent: HTMLElement, notes: Session["requests"][number]["modelNotes"]): void {
  if (notes == null) return;
  const saved = element("details"); saved.append(element("summary", notes.detailsOmitted === true ? "Model proposal excerpt and limitations — authority: none" : "Original model proposal and limitations — authority: none"), element("p", notes.objective));
  if (notes.detailsOmitted === true) saved.append(element("p", "This view shows a bounded excerpt. Additional text remains in the saved original model contribution.", "help"));
  paragraphs(saved, "Model assumptions", notes.assumptions); paragraphs(saved, "Risks and limitations", notes.risks); paragraphs(saved, "Unresolved model questions", notes.openQuestions); parent.append(saved);
}
function clarificationHistory(parent: HTMLElement, session: Session, current = false): void {
  if (session.clarificationHistory.length === 0) return;
  const history = element("section", undefined, "ai-clarification-history"); if (current) history.id = "ai-clarification-history";
  history.append(element("h3", "Saved clarification history"), element("p", "Each round keeps the questions and your explicitly saved answers. These records do not change when a later round arrives.", "help"));
  for (const round of session.clarificationHistory) {
    const record = element("article", undefined, "record"); record.dataset["clarificationRound"] = String(round.round);
    record.append(element("h4", `Clarification round ${round.round}`));
    if (round.materialChangeReason !== null) record.append(element("p", round.materialChangeReason, "help"));
    if (round.questions.length === 0) record.append(element("p", "No new clarification questions were retained.", "muted"));
    for (const question of round.questions) {
      record.append(element("h4", question.question), element("p", question.whyItMatters, "help"));
      if (question.proposedDefault !== null) record.append(element("p", `Proposed default: ${question.proposedDefault}. It is not accepted automatically.`, "help"));
      record.append(element("p", `Your saved answer: ${round.answers.find(answer => answer.questionId === question.questionId)?.value ?? "No answer saved."}`));
    }
    record.append(element("p", `Request ${round.requestId}`, "digest")); history.append(record);
  }
  parent.append(history);
}
function action(id: string, label: string, run: () => void): HTMLButtonElement {
  const button = element("button", label); button.id = id; button.type = "button"; button.addEventListener("click", run); return button;
}
function gate(button: HTMLButtonElement, allowed: boolean, reason: string): void {
  button.dataset["planningAction"] = "true"; button.dataset["planningAllowed"] = String(allowed); button.dataset["planningReason"] = reason;
  button.disabled = !allowed; if (!allowed) button.title = reason; else button.removeAttribute("title");
}
function input(parent: HTMLElement, id: string, label: string, value: string, maximum: number, multiline = true): HTMLTextAreaElement | HTMLInputElement {
  const lab = element("label", label); lab.htmlFor = id;
  const control = multiline ? element("textarea") : element("input"); control.id = id; control.value = value; control.maxLength = maximum;
  if (control instanceof HTMLInputElement) control.type = "text";
  parent.append(lab, control); return control;
}
function lineValues(text: string): string[] { return text.split(/\r?\n/u).map(value => value.trim()).filter(Boolean); }
function changesAvailable(snapshot: DesktopSnapshot, ui: WorkflowUiState, project: PlanningProjectView): boolean {
  return snapshot.state === "ready" && !ui.busy && ui.pending === null && !ui.reloadRequired && !project.stopped;
}
function unavailableReason(snapshot: DesktopSnapshot, ui: WorkflowUiState, project: PlanningProjectView): string {
  if (project.stopped) return "Resume this project before changing AI planning.";
  if (ui.pending !== null) return "Observe the exact uncertain command before another change.";
  if (ui.reloadRequired) return "Reload the saved project before continuing.";
  return snapshot.state !== "ready" ? "The local workspace must be ready." : "Wait for the current change to finish.";
}

export function aiPlanningStatus(project: PlanningProjectView | null): string {
  const request = project?.aiPlanning.currentSession?.requests.at(-1);
  if (request === undefined) return "No AI request recorded in this session.";
  const labels = { intent: "intent saved", admitted: "confirmed and awaiting dispatch", dispatched: "waiting for its external outcome", succeeded: "validated and saved", refused: "refused", failed: "failed", cancelled: "cancelled", "outcome-unknown": "outcome unknown; it will not be retried automatically", stale: "stale because the saved context changed" } as const;
  const usage = request.usageState === "not-called" ? "No provider call is recorded." : request.usageState === "unknown" ? "Provider usage is unknown." : "The provider reported usage.";
  return `AI ${request.purpose} ${labels[request.state]}. ${usage}`;
}

export function createAiPlanningPage(snapshot: DesktopSnapshot, workspace: PlanningWorkspaceView, ui: WorkflowUiState, actions: RendererActions): HTMLElement {
  const page = element("div", undefined, "page"), head = element("header", undefined, "page-head"), title = element("h1", "AI planning"); title.tabIndex = -1;
  head.append(title, element("p", "Describe, clarify and review a proposed plan. Explicit adoption saves a draft; approval, sealing and execution remain separate.")); page.append(head);
  page.append(createAiConnectionCard(workspace));
  const project = workspace.selected;
  if (project === null) { const missing = section("Choose a saved project"); missing.append(element("p", "Create or open a saved project first. Its existing folder selection remains the repository boundary."), action("ai-choose-project", "View projects", () => actions.navigate("home"))); page.append(missing); return page; }
  page.append(element("p", `${project.name}${project.stopped ? " — stopped" : ""}`, "project-title"));
  const current = project.aiPlanning.currentSession;
  if (current !== null) page.append(createSessionEditor(snapshot, workspace, project, current, ui, actions));
  const start = createStartSession(snapshot, project, ui, actions);
  if (current === null) page.append(start);
  else { const extra = element("details", undefined, "card wide"); extra.append(element("summary", "Start a separate planning session"), element("p", "This preserves earlier sessions and requires new consent. It starts no provider request by itself."), start); page.append(extra); }
  if (project.aiPlanning.sessions.length > 0) {
    const history = section("Saved planning sessions");
    for (const session of project.aiPlanning.sessions) {
      const archived = element("details"); archived.append(element("summary", `Session ${session.sessionId} · ${session.requestCount}/${session.maxRequests} requests · ${session.adoptedPlanDigest === null ? "No proposal adopted" : "Proposal adopted"}`));
      archived.append(element("p", session.draft.description));
      if (session.draft.understanding !== null) {
        archived.append(element("h3", "Saved understanding"), element("p", session.draft.understanding.summary));
        paragraphs(archived, "Desired outcomes", session.draft.understanding.outcomes);
        paragraphs(archived, "Assumptions", session.draft.understanding.assumptions);
        paragraphs(archived, "Not included", session.draft.understanding.nonGoals);
        paragraphs(archived, "Audiences", session.draft.understanding.audiences);
      }
      clarificationHistory(archived, session);
      if (session.draft.proposal !== null) {
        archived.append(element("h3", session.draft.proposal.title));
        for (const task of session.draft.proposal.tasks) { archived.append(element("h4", task.title), element("p", task.objective)); paragraphs(archived, "Acceptance criteria", task.acceptanceCriteria); paragraphs(archived, "Dependency identities", task.dependsOn); }
      }
      for (const request of session.requests) {
        archived.append(element("p", `${request.purpose}: ${request.state}. Model: ${request.modelId ?? "not qualified"}.`, "help"), element("p", `Request ${request.requestId}${request.contributionDigest === null ? "" : ` · Contribution ${request.contributionDigest}`}`, "digest"));
        const message = aiPlanningRequestMessage(request, snapshot.preferences.presentationMode === "developer"); if (message !== null) archived.append(element("p", message, "notice warning"));
        else archived.append(element("p", request.usageState === "reported" ? "The provider reported usage." : request.usageState === "unknown" ? "Provider usage is unknown." : "No provider call is recorded.", "help"));
        modelNotes(archived, request.modelNotes);
      }
      archived.append(element("p", session.acceptedBriefDigest === null ? "No accepted brief." : `Accepted brief ${session.acceptedBriefDigest}`, "digest"));
      archived.append(element("p", session.adoptedPlanDigest === null ? "No adopted proposal." : `Adopted draft ${session.adoptedPlanDigest}`, "digest")); history.append(archived);
    }
    page.append(history);
  }
  return page;
}

function createStartSession(snapshot: DesktopSnapshot, project: PlanningProjectView, ui: WorkflowUiState, actions: RendererActions): HTMLElement {
  const card = section("Describe the project"), form = element("form", undefined, "stack"), subject = `${project.projectId}:new-session`;
  const savedDescription = project.brief?.objective ?? project.candidate?.objective ?? "";
  const description = input(form, "ai-new-description", "What would you like to build?", edits.read(subject, "description", savedDescription), 4_096);
  description.required = true; description.addEventListener("input", () => edits.edit(subject, "description", description.value));
  const include = element("input"); include.type = "checkbox"; include.id = "ai-new-repository-summary"; include.checked = edits.read(subject, "include", "false") === "true";
  include.addEventListener("change", () => edits.edit(subject, "include", String(include.checked)));
  const label = element("label", "Include the existing bounded repository summary"); label.htmlFor = include.id;
  form.append(include, label, element("p", "Optional: send only the already saved bounded repository observation. No additional scan is performed. Typed project information, your answers and the accepted brief or proposal context are disclosed before each request.", "help"));
  const begin = action("ai-start-session", "Start planning session", () => undefined); begin.type = "submit"; begin.className = "primary";
  gate(begin, changesAvailable(snapshot, ui, project) && project.aiPlanning.currentSession?.activeRequestId == null, "Wait for or cancel the active request before a new session.");
  form.append(begin); form.addEventListener("submit", event => {
    event.preventDefault(); description.setCustomValidity(description.value.trim().length === 0 ? "Describe the project before starting a session." : ""); if (!form.reportValidity()) return;
    actions.runPlanningCommand({ kind: "start-ai-planning", commandId: crypto.randomUUID(), projectId: project.projectId, expectedSessionVersion: project.aiPlanning.version, description: description.value.trim(), includeRepositorySummary: include.checked }, "Planning session");
  }); card.append(form); return card;
}

function createSessionEditor(snapshot: DesktopSnapshot, workspace: PlanningWorkspaceView, project: PlanningProjectView, session: Session, ui: WorkflowUiState, actions: RendererActions): HTMLElement {
  const card = section("Your planning draft"), form = element("form", undefined, "stack"), subject = `${project.projectId}:${session.sessionId}`, saved = session.draft;
  const available = changesAvailable(snapshot, ui, project), reason = unavailableReason(snapshot, ui, project), fields: { control: HTMLTextAreaElement | HTMLInputElement; field: string }[] = [];
  const field = (id: string, label: string, savedValue: string, maximum = 4_096, multiline = true, parent: HTMLElement = form) => {
    const control = input(parent, id, label, edits.read(subject, id, savedValue), maximum, multiline); fields.push({ control, field: id }); return control;
  };
  card.append(element("p", `Session request limit: ${session.requestCount}/${session.maxRequests}. Clarification rounds: ${session.clarificationRounds}/${session.maxClarificationRounds}. No automatic retries.`, "help"));
  const requestStatus = element("p", aiPlanningStatus(project), "notice"); requestStatus.id = "ai-request-status"; requestStatus.setAttribute("role", "status"); card.append(requestStatus);
  const description = field("ai-description", "Your project description (accepted brief objective)", saved.description);
  description.required = true;
  form.append(element("p", "Your description becomes the accepted brief's objective. Saving a changed description clears the current AI preview so you can request a fresh understanding; earlier contributions remain in history.", "help"));
  const include = element("input"); include.id = "ai-repository-summary"; include.type = "checkbox"; include.checked = edits.read(subject, include.id, String(saved.includeRepositorySummary)) === "true";
  const includeLabel = element("label", "Include the existing bounded repository summary"); includeLabel.htmlFor = include.id; form.append(include, includeLabel);
  const answerControls = session.questions.map(question => {
    const questionCard = element("fieldset", undefined, "stack"), legend = element("legend", question.question);
    questionCard.append(legend, element("p", question.whyItMatters, "help"));
    if (question.proposedDefault !== null) questionCard.append(element("p", `Proposed default: ${question.proposedDefault}. It is not accepted automatically.`, "help"));
    const answer = saved.answers.find(item => item.questionId === question.questionId)?.value ?? "";
    const control = field(`ai-answer-${question.questionId}`, "Your answer (you may state that you decline)", answer, 1_024, true, questionCard);
    form.append(questionCard); return { questionId: question.questionId, control };
  });
  const understanding = saved.understanding === null ? null : {
    summary: field("ai-understanding-summary", "Editable understanding summary (saved preview)", saved.understanding.summary, 4_000),
    outcomes: field("ai-understanding-outcomes", "Desired outcomes (one per line)", saved.understanding.outcomes.join("\n"), 32_015),
    nonGoals: field("ai-understanding-non-goals", "Not included (one per line)", saved.understanding.nonGoals.join("\n"), 32_015),
    audiences: field("ai-understanding-audiences", "Audiences (one per line)", saved.understanding.audiences.join("\n"), 32_015),
    assumptions: field("ai-understanding-assumptions", "Assumptions to review (one per line)", saved.understanding.assumptions.join("\n"), 32_015),
  };
  if (understanding !== null) { for (const required of [understanding.summary, understanding.outcomes, understanding.audiences]) required.required = true; form.append(element("p", "Review the proposed outcomes, audiences, exclusions and assumptions before explicitly accepting the brief. Your description remains its objective; this understanding summary is retained alongside it as a preview. Save edits before acceptance.", "help")); }
  const proposal = saved.proposal === null ? null : (() => {
    const title = field("ai-proposal-title", "Proposed plan title", saved.proposal.title, 300, false);
    title.required = true;
    const tasks = saved.proposal.tasks.map((task, index) => {
      const editor = element("fieldset", undefined, "stack ai-task-editor"); editor.append(element("legend", `Task ${index + 1}`));
      const title = field(`ai-task-${index}-title`, "Task title", task.title, 300, false, editor);
      const objective = field(`ai-task-${index}-objective`, "Task objective", task.objective, 2_000, true, editor);
      const acceptance = task.acceptanceCriteria.map((criterion, criterionIndex) => field(`ai-task-${index}-criterion-${criterionIndex}`, `Acceptance criterion ${criterionIndex + 1}`, criterion, 2_000, true, editor));
      for (const required of [title, objective, ...acceptance]) required.required = true;
      const dependencies = task.dependsOn.map(id => { const found = saved.proposal!.tasks.findIndex(item => item.taskId === id); return found < 0 ? id : `Task ${found + 1}: ${saved.proposal!.tasks[found]!.title}`; });
      paragraphs(editor, "Depends on", dependencies); form.append(editor); return { taskId: task.taskId, title, objective, acceptance, dependsOn: task.dependsOn };
    });
    form.append(element("p", "Edit the proposed wording and existing acceptance criteria. Task identities and dependencies stay bound to the saved model artifact. Model attribution and edited-field provenance remain visible after adoption.", "help")); return { title, tasks };
  })();
  const collect = (): Draft => ({ description: description.value.trim(), includeRepositorySummary: include.checked, answers: answerControls.map(answer => ({ questionId: answer.questionId, value: answer.control.value.trim() })).filter(answer => answer.value.length > 0),
    understanding: understanding === null ? null : { summary: understanding.summary.value.trim(), outcomes: lineValues(understanding.outcomes.value), nonGoals: lineValues(understanding.nonGoals.value), audiences: lineValues(understanding.audiences.value), assumptions: lineValues(understanding.assumptions.value) },
    proposal: proposal === null ? null : { title: proposal.title.value.trim(), tasks: proposal.tasks.map(task => ({ taskId: task.taskId, title: task.title.value.trim(), objective: task.objective.value.trim(), acceptanceCriteria: task.acceptance.map(control => control.value.trim()), dependsOn: task.dependsOn })) } });
  const dirty = (): boolean => planningDraftContent(collect()) !== planningDraftContent(saved);
  const status = element("p", undefined, "help"); status.id = "ai-edit-status"; status.setAttribute("role", "status");
  const save = action("ai-save-edits", "Save planning edits", () => undefined); save.type = "submit"; save.className = "primary";
  const command = (kind: "request-ai-understanding" | "request-ai-proposal" | "accept-ai-brief" | "adopt-ai-proposal", label: string): void => {
    if (dirty()) return;
    actions.runPlanningCommand({ kind, commandId: crypto.randomUUID(), projectId: project.projectId, sessionId: session.sessionId, expectedSessionVersion: project.aiPlanning.version, contextDigest: project.aiPlanning.contextDigest }, label);
  };
  const row = element("div", undefined, "actions"); const controls: { button: HTMLButtonElement; eligible: boolean; explanation: string }[] = [];
  const add = (id: string, label: string, kind: Parameters<typeof command>[0], eligible: boolean, explanation: string) => { const button = action(id, label, () => command(kind, label)); row.append(button); controls.push({ button, eligible, explanation }); };
  const noActiveRequest = session.activeRequestId === null, requestRoom = session.requestCount < session.maxRequests;
  const connectionReady = aiConnectionAvailable(workspace), answerReadiness = aiSavedAnswerReadiness(session);
  add("ai-request-understanding", session.understandingContributionDigest === null ? "Request AI understanding" : "Request another clarification", "request-ai-understanding", noActiveRequest && requestRoom && connectionReady && session.clarificationRounds < session.maxClarificationRounds && session.acceptedBriefDigest === null && answerReadiness.ready,
    answerReadiness.reason ?? (!connectionReady ? aiPlanningReasonMessage("ai.LIVE_ROUTE_BLOCKED")! : !requestRoom || session.clarificationRounds >= session.maxClarificationRounds ? aiPlanningReasonMessage("ai.local-request-cap")! : "A remaining clarification round and no accepted brief or active request are required."));
  if (understanding !== null) add("ai-accept-brief", "Accept this AI brief", "accept-ai-brief", noActiveRequest && session.acceptedBriefDigest === null && answerReadiness.ready, answerReadiness.reason ?? "This brief has already been accepted or a request is still active.");
  if (session.acceptedBriefDigest !== null) add("ai-request-proposal", "Request AI plan proposal", "request-ai-proposal", noActiveRequest && requestRoom && connectionReady, "A qualified route, a remaining request and no active request are required.");
  if (proposal !== null) add("ai-adopt-proposal", "Adopt this proposed draft", "adopt-ai-proposal", noActiveRequest && session.adoptedPlanDigest === null && session.proposalContributionDigest !== null, "This proposal has already been adopted or is not available for exact adoption.");
  if (!answerReadiness.ready) {
    const guidance = element("p", answerReadiness.reason!, "notice warning"); guidance.id = "ai-answer-guidance"; form.append(guidance);
    for (const { button } of controls) if (["ai-request-understanding", "ai-accept-brief"].includes(button.id)) button.setAttribute("aria-describedby", guidance.id);
  }
  const update = (): void => {
    const changed = dirty(); status.textContent = changed ? "Unsaved planning edits. Save before requesting, accepting or adopting. Status refresh keeps your typing." : "Planning edits saved. They will be available after reopening.";
    gate(save, available && changed && session.adoptedPlanDigest === null, session.adoptedPlanDigest !== null ? "This adopted proposal is a saved record. Request a new proposal before editing another AI revision." : changed ? reason : "These exact edits are already saved.");
    for (const control of controls) gate(control.button, available && !changed && control.eligible, changed ? "Save planning edits first." : !available ? reason : control.explanation);
  };
  for (const { control, field } of fields) { control.readOnly = session.adoptedPlanDigest !== null; control.addEventListener("input", () => { edits.edit(subject, field, control.value); update(); }); }
  include.disabled = session.adoptedPlanDigest !== null;
  include.addEventListener("change", () => { edits.edit(subject, include.id, String(include.checked)); update(); });
  form.append(status, save, row); form.addEventListener("submit", event => {
    event.preventDefault();
    if (session.adoptedPlanDigest !== null) return;
    for (const { control } of fields) control.setCustomValidity(control.required && control.value.trim().length === 0 ? "Enter a value for this field." : "");
    if (understanding !== null) for (const control of [understanding.outcomes, understanding.nonGoals, understanding.audiences, understanding.assumptions]) {
      const values = lineValues(control.value); if (values.length > 12 || values.some(value => value.length > 2_000)) control.setCustomValidity("Use at most 12 lines, with at most 2,000 characters on each line.");
    }
    if (!form.reportValidity() || !dirty()) return;
    actions.runPlanningCommand({ kind: "save-ai-planning-draft", commandId: crypto.randomUUID(), projectId: project.projectId, sessionId: session.sessionId, expectedSessionVersion: project.aiPlanning.version, draft: collect() }, "Planning edits");
  }); update(); card.append(form); clarificationHistory(card, session, true);
  const refresh = action("ai-refresh-status", "Refresh AI planning status", actions.reloadPlanning); refresh.disabled = snapshot.state !== "ready" || ui.busy; card.append(refresh);
  if (session.activeRequestId !== null) {
    const cancel = action("ai-cancel-request", "Cancel planning request", () => actions.runPlanningCommand({ kind: "cancel-ai-request", commandId: crypto.randomUUID(), projectId: project.projectId, sessionId: session.sessionId, requestId: session.activeRequestId! }, "Planning cancellation"));
    gate(cancel, snapshot.state === "ready" && !ui.busy && ui.pending === null && !ui.reloadRequired, reason); card.append(cancel, element("p", "Cancellation is best-effort and preserves unknown usage. A late result cannot silently replace your work.", "help"));
  }
  if (session.acceptedBriefDigest !== null) card.append(element("p", "AI brief explicitly accepted and saved.", "notice"));
  if (session.adoptedPlanDigest !== null) card.append(element("p", "Proposed plan explicitly adopted as a saved draft. Scope approval and sealing remain separate. No task has started.", "notice"), element("p", "This adopted proposal is retained as a saved record. Request a new proposal, within the remaining session limit, to edit another AI revision; open the saved plan for a manual revision.", "help"), action("ai-open-adopted-plan", "Open saved plan", () => actions.navigate("plan")));
  const history = section("Requests and provenance");
  if (session.requests.length === 0) history.append(element("p", "No provider request has been dispatched for this session.", "muted"));
  for (const request of session.requests) {
    const record = element("article", undefined, "record"); record.append(element("h3", `${request.purpose} · ${request.state}`), element("p", `Model: ${request.modelId ?? "not qualified"}.`, "help"));
    const message = aiPlanningRequestMessage(request, snapshot.preferences.presentationMode === "developer"); if (message !== null) record.append(element("p", message, "notice warning"));
    else record.append(element("p", request.usageState === "reported" ? "The provider reported usage." : request.usageState === "unknown" ? "Provider usage is unknown." : "No provider call is recorded.", "help"));
    modelNotes(record, request.modelNotes);
    record.append(element("p", `Request ${request.requestId}${request.contributionDigest === null ? "" : ` · Validated contribution ${request.contributionDigest}`}`, "digest")); history.append(record);
  }
  card.append(history); return card;
}

// These two functions use only the application-projected non-secret route
// observation. Renderer text never supplies provider or executable authority.
export function createAiConnectionCard(workspace: PlanningWorkspaceView): HTMLElement {
  const card = section("AI planning connection"), connection = workspace.aiPlanningConnection;
  card.append(element("p", connection.source === "synthetic-fixture" ? "Owned synthetic fixture" : connection.state, "status-badge"), element("p", connection.detail, connection.state === "LIVE_ROUTE_BLOCKED" ? "notice warning" : "help"));
  card.append(element("p", `Provider: ${connection.provider}. Model: ${connection.modelId ?? "not qualified"}. Subscription allowance remaining: unknown.`, "help"));
  card.append(element("p", "Each explicitly confirmed request may use the existing subscription allowance. Maximum three requests per session; no API billing fallback, account switching or automatic retries.", "help"));
  if (connection.source === "synthetic-fixture") card.append(element("p", "Owned test fixture only. No live provider or account was contacted. This is not evidence of a working subscription connection.", "notice warning"));
  return card;
}
function aiConnectionAvailable(workspace: PlanningWorkspaceView): boolean { return workspace.aiPlanningConnection.state === "qualified"; }
