import type {
  ApprovalRequest,
  ProjectBrief,
  ProjectPlan,
  ProjectSummaryProjection,
} from "@ai-dev-os/project";
import type { PlanProjectionAction } from "@ai-dev-os/plan";
import type {
  PlanningCommandResult,
  PlanningArtifactState,
  PlanningProjectView,
  PlanningWorkspaceView,
  AiPlanningSessionView,
  AiPlanningRequestView,
} from "@ai-dev-os/application/planning-contracts";

export interface DesktopPresentationSource {
  readonly example: true;
  readonly label: string;
  readonly observedAt: string;
  readonly project: Pick<ProjectSummaryProjection, "displayName" | "status" | "planState" | "counts" | "confidence" | "computedAt">;
  readonly brief: Pick<ProjectBrief, "revision" | "objective" | "outcomes" | "nonGoals" | "audiences" | "assumptions" | "openQuestions" | "createdAt">;
  readonly plan: Pick<ProjectPlan, "revision" | "state" | "stages" | "dependencies" | "authority"> & Readonly<{
    tasks: readonly Pick<ProjectPlan["tasks"][number], "taskId">[];
  }>;
  readonly planActions: readonly PlanProjectionAction[];
  readonly approval: Pick<ApprovalRequest, "class" | "risk" | "subjectSummary" | "usage" | "effects" | "exclusions" | "state" | "expiresAt" | "money">;
}

export interface DesktopWorkspacePresentation {
  readonly example: true;
  readonly label: string;
  readonly freshness: string;
  readonly project: Readonly<{
    displayName: string;
    status: string;
    planState: string;
    progress: string;
    confidence: string;
  }>;
  readonly intake: Readonly<{
    objective: string;
    outcomes: readonly string[];
    audiences: readonly string[];
  }>;
  readonly brief: Readonly<{
    revisionLabel: string;
    objective: string;
    outcomes: readonly string[];
    nonGoals: readonly string[];
    assumptions: readonly Readonly<{ text: string; confirmed: boolean }>[];
    openQuestionCount: number;
  }>;
  readonly plan: Readonly<{
    revisionLabel: string;
    state: string;
    stages: readonly Readonly<{
      title: string;
      intent: string;
      taskCount: number;
      gate: "automatic" | "operator-review";
    }>[];
    taskCount: number;
    dependencyCount: number;
    authority: "none";
    actions: readonly PlanProjectionAction[];
  }>;
  readonly approval: Readonly<{
    classLabel: string;
    risk: string;
    title: string;
    why: string;
    changes: string;
    scope: string;
    reversible: boolean;
    effects: readonly string[];
    exclusions: readonly string[];
    state: string;
    expiryLabel: string;
    moneyLabel: string;
  }>;
}

function words(value: string): string {
  return value.replaceAll("-", " ").replaceAll("_", " ");
}

export interface PlanningWorkspacePresentation {
  readonly projects: readonly Readonly<{
    projectId: string;
    name: string;
    versionLabel: string;
    stateLabel: string;
    stopped: boolean;
  }>[];
  readonly selected: PlanningProjectPresentation | null;
}

export interface PlanningProjectPresentation {
  readonly projectId: string;
  readonly name: string;
  readonly versionLabel: string;
  readonly stateLabel: string;
  readonly stopped: boolean;
  readonly budgetLabel: string;
  readonly repositoryLabel: string;
  readonly briefLabel: string;
  readonly planLabel: string;
}

function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function formatMinorUnits(minorUnits: number, currency: string): string {
  const code = currency.toUpperCase();
  const digits = currencyDigits(code);
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: code }).format(minorUnits / (10 ** digits));
  } catch {
    return `${code} ${(minorUnits / 100).toFixed(2)}`;
  }
}

export function formatPlanningState(value: string | null): string {
  return value === null ? "No plan yet" : words(value);
}

export function shortDigest(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

export function formatObservedAt(value: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return "Observation time unavailable";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(instant);
}

/** Human guidance for the finite reasons emitted by the planning owner. Raw
 * codes remain diagnostic detail, never a source of renderer authority. */
export function aiPlanningReasonMessage(reason: string | null): string | null {
  switch (reason) {
    case "ai.LIVE_ROUTE_BLOCKED": return "The subscription connection is blocked until its isolation checks are qualified. Save your draft locally and review the AI planning connection. Signing in alone cannot resolve this; no API fallback is available.";
    case "ai.previous-clarification-unanswered":
    case "ai.clarification-answer-required": return "Answer each clarification question, or explicitly state that you decline, then save your planning edits. Proposed defaults are never accepted for you.";
    case "ai.local-request-cap": return "This session allows at most three AI requests and two clarification rounds. Review the saved results or continue planning manually. Further AI work needs a separate planning session and new consent.";
    case "ai.clarification-material-change-required": return "Another clarification needs a material change after the previous round. Save your answers or a revised description first; an unchanged request cannot be repeated.";
    case "ai.context-conflict":
    case "ai.session-stale":
    case "ai.proposal-stale":
    case "ai.request-context-stale":
    case "ai.context-changed-after-dispatch":
    case "ai.confirmation-subject-changed": return "The saved planning context changed. Reload and review the current draft; a result for the earlier context cannot replace or approve it.";
    case "ai.route-or-context-changed":
    case "ai.route-changed": return "The selected connection or planning context changed. Reload and check both before giving fresh consent to a new request.";
    case "ai.request-in-flight": return "A planning request is still active. Refresh its status or explicitly cancel it before starting another action.";
    case "ai.accepted-brief-required": return "Save your answers and understanding, then explicitly accept the exact brief before requesting a plan proposal.";
    case "ai.adopted-draft-locked": return "This adopted proposal is a saved record. Open the saved plan for a manual revision, or request a new proposal within the remaining session limit.";
    case "ai.adoption-unavailable":
    case "ai.proposal-unavailable":
    case "ai.contribution-inadoptable": return "There is no current validated proposal available for this action. Review the accepted brief and request history before explicitly requesting a new proposal.";
    case "ai.provider.MALFORMED_RESPONSE": return "The response failed validation of its structure, model or usage, or contained unsupported tool data. It cannot become an adopted plan. Review the saved request before deciding on a separately confirmed request; there is no automatic retry.";
    case "ai.provider.QUOTA_EXCEEDED": return "The provider reported a usage limit. Remaining subscription allowance is unknown. Keep your draft and check the existing subscription before any later request; the app will not switch accounts or use API billing.";
    case "ai.provider.RATE_LIMITED": return "The provider reported a request-rate limit. Keep your draft and check the existing subscription before explicitly trying later. The app will not retry automatically or switch routes.";
    case "ai.provider.AUTHENTICATION_FAILED": return "The provider did not accept the existing subscription sign-in. Check that subscription connection before a new request; separate API credentials cannot replace it here.";
    case "ai.provider.CONTENT_REJECTED": return "The provider declined this request. Review the project description and saved request history before deciding whether to submit a changed request with new consent.";
    case "ai.provider.POLICY_DENIED": return "The connection or project information did not pass the planning disclosure checks. Review the connection and remove sensitive credentials from the draft before any new request.";
    case "ai.provider.MODEL_UNAVAILABLE": return "The exact selected model is unavailable. Review the AI planning connection; the app will not silently choose another model.";
    case "ai.provider.INVALID_REQUEST":
    case "ai.context-bound":
    case "ai.input-bound":
    case "ai.draft-bound": return "The planning input does not fit the supported request. Review and shorten the description and answers, save them, and review the exact disclosure before another request.";
    case "ai.provider.DEADLINE_EXCEEDED": return "The request exceeded its time limit. Check its saved outcome and usage state before deciding what to do next; a timeout does not prove that the provider was never called.";
    case "ai.provider.PROTOCOL_VIOLATION":
    case "ai.provider-outcome-unconfirmed":
    case "ai.command-outcome-unconfirmed": return "The request outcome could not be confirmed. Review the exact saved attempt and its usage state; do not assume failure means that no provider call occurred.";
    case "ai.interrupted-before-dispatch": return "The app closed before dispatch was recorded. This attempt will not be retried on reopening; review it before initiating any new request.";
    case "ai.interrupted-after-dispatch": return "The app closed after dispatch. The external outcome and usage remain unknown; reopening and refresh do not retry the request.";
    case "operator.cancelled":
    case "ai.request-revoked":
    case "ai.admission-revoked":
    case "ai.provider.CANCELLED": return "The request was cancelled or its consent ended. It will not retry or replace the current draft. Check the recorded usage state before any new request.";
    case "ai.history-capacity": return "This project's saved AI history has reached its capacity. Existing work is preserved. Continue with the saved plan manually; another session in this project cannot increase the storage limit.";
    case "ai.session-start-unavailable": return "A new session cannot start while a request is active or after this project's session limit is reached. Review current requests and keep working with the saved project.";
    case "The model could not propose a viable plan. Its retained contribution explains the limitations.":
    case "The model needs clarification before a proposal can be adopted. Review its retained questions.":
    case "The model output is incomplete for an editable brief or task plan. Its original contribution remains saved.": return `${reason} Review those notes and revise the saved requirements before another explicitly confirmed request.`;
    default: return reason?.startsWith("ai.") === true ? "AI planning could not continue. Review the saved request history and current draft before taking another action." : null;
  }
}

export function aiPlanningRequestMessage(request: Pick<AiPlanningRequestView, "state" | "reason" | "usageState">, includeReason = false): string | null {
  const guidance = aiPlanningReasonMessage(request.reason);
  const outcome = request.state === "outcome-unknown" ? "The external outcome is unknown. Refresh or reopen to review this saved attempt; neither retries it. Do not repeat it based on an assumed failure."
    : request.state === "stale" ? "This result belongs to an earlier saved context. It remains in history and cannot overwrite or be adopted into the current draft."
      : request.state === "cancelled" ? "This request is cancelled. It will not retry or replace the current draft." : guidance;
  if (outcome === null && request.reason === null) return null;
  const usage = request.usageState === "not-called" ? "No provider call is recorded." : request.usageState === "unknown" ? "Provider usage is unknown." : "Reported provider usage remains in the saved history.";
  return `${outcome ?? "Review this saved request before taking another action."} ${usage}${includeReason && request.reason !== null ? ` Details: ${request.reason}` : ""}`;
}

export function aiSavedAnswerReadiness(session: Pick<AiPlanningSessionView, "questions" | "draft" | "clarificationHistory">): Readonly<{ ready: boolean; reason: string | null }> {
  const answered = (questions: AiPlanningSessionView["questions"], answers: AiPlanningSessionView["draft"]["answers"]): boolean => questions.every(question => answers.some(answer => answer.questionId === question.questionId && answer.value.trim().length > 0));
  if (!answered(session.questions, session.draft.answers)) return { ready: false, reason: "Answer each current clarification question, or explicitly state that you decline, then save your planning edits before continuing. Defaults are never selected for you." };
  if (session.clarificationHistory.some(round => !answered(round.questions, round.answers))) return { ready: false, reason: "An earlier clarification round has no saved answer. Its history is preserved. If that round is no longer editable, start a separate planning session before requesting or accepting a new brief." };
  return { ready: true, reason: null };
}

export function planningResultMessage(result: PlanningCommandResult, action: string, includeReason = false): string {
  const reason = !includeReason || result.reason === null ? "" : ` Details: ${result.reason}`;
  const guidance = aiPlanningReasonMessage(result.reason), explanation = guidance === null ? "" : ` ${guidance}`;
  const message = (): string => {
  switch (result.kind) {
    case "committed": return `${action} saved.`;
    case "ready": return `${action} is ready.`;
    case "idempotent-replay": return `${action} was already saved. The original result is shown.`;
    case "unknown": return `${action} may have been saved. Observe this exact command before doing anything else.`;
    case "conflict": return `${action} was not saved because this project changed. Reload the saved project before continuing.${explanation}${reason}`;
    case "corrupt": return `${action} could not be verified because saved data failed validation. Keep the exact command for observation; do not repeat it.${reason}`;
    case "not-recorded": return `No saved outcome was found for ${action.toLowerCase()}.${reason}`;
    case "cancelled": return `${action} was cancelled.`;
    case "refused": return `${action} was unavailable.${explanation}${reason}`;
  }
  };
  const warning = result.projectionWarning === "handover-files" ? " An exported handover differs or is unavailable. Saved work remains accessible; see the handover file warning."
    : result.projectionWarning === "workspace-corrupt" ? " This outcome is confirmed, but saved workspace data failed validation. Reload is required before further changes."
    : result.projectionWarning === "workspace-unavailable" ? " This outcome is confirmed, but the workspace could not be refreshed. Reload before further changes." : "";
  return message() + warning;
}

export function planningArtifactMessage(state: PlanningArtifactState): string {
  return state === "published" ? "Export file matches the saved document at the latest check."
    : state === "differs-on-disk" ? "Export file differs from the saved document or could not be safely verified. The file has been preserved. Open the saved handover to read the authoritative document; saved work can continue."
    : "Export file is unavailable. The saved document remains accessible here. Check the export folder and reload to refresh its file status.";
}

export interface PlanningRecoveryDirective {
  readonly pendingCommandId: string | null;
  readonly reloadRequired: boolean;
}

export function planningRecoveryDirective(result: PlanningCommandResult, submittedCommandId: string | null): PlanningRecoveryDirective {
  if (result.kind === "unknown" || result.kind === "corrupt") return Object.freeze({
    pendingCommandId: submittedCommandId ?? result.commandId,
    reloadRequired: result.kind === "corrupt" || submittedCommandId === null && result.commandId === null,
  });
  return Object.freeze({ pendingCommandId: null, reloadRequired: result.kind === "conflict" || result.projectionWarning === "workspace-corrupt" || result.projectionWarning === "workspace-unavailable" });
}

function adaptProject(project: PlanningProjectView): PlanningProjectPresentation {
  return Object.freeze({
    projectId: project.projectId,
    name: project.name,
    versionLabel: `Saved version ${project.version}`,
    stateLabel: project.stopped ? "Stopped" : formatPlanningState(project.planState),
    stopped: project.stopped,
    budgetLabel: formatMinorUnits(project.budget.minorUnits, project.budget.currency),
    repositoryLabel: project.repository === null ? "No repository selected" : `${project.repository.rootLeaf} · ${words(project.repository.state)}`,
    briefLabel: project.brief === null ? "No accepted brief" : `Accepted brief version ${project.brief.version}`,
    planLabel: project.plan === null ? "No saved plan" : `Plan revision ${project.plan.revision} · ${words(project.plan.state)}`,
  });
}

export function adaptPlanningWorkspace(source: PlanningWorkspaceView): PlanningWorkspacePresentation {
  return Object.freeze({
    projects: Object.freeze(source.projects.map((project) => Object.freeze({
      projectId: project.projectId,
      name: project.name,
      versionLabel: `Saved version ${project.version}`,
      stateLabel: project.stopped ? "Stopped" : formatPlanningState(project.planState),
      stopped: project.stopped,
    }))),
    selected: source.selected === null ? null : adaptProject(source.selected),
  });
}

export function adaptWorkspacePresentation(source: DesktopPresentationSource): DesktopWorkspacePresentation {
  const done = source.project.counts.done;
  const total = source.project.counts.total;
  return Object.freeze({
    example: true,
    label: source.label,
    freshness: `Synthetic example prepared ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(source.observedAt))}`,
    project: Object.freeze({
      displayName: source.project.displayName,
      status: words(source.project.status),
      planState: source.project.planState === null ? "No plan" : words(source.project.planState),
      progress: `${done} of ${total} example tasks complete`,
      confidence: source.project.confidence,
    }),
    intake: Object.freeze({
      objective: source.brief.objective,
      outcomes: Object.freeze([...source.brief.outcomes]),
      audiences: Object.freeze([...source.brief.audiences]),
    }),
    brief: Object.freeze({
      revisionLabel: `Brief revision ${source.brief.revision}`,
      objective: source.brief.objective,
      outcomes: Object.freeze([...source.brief.outcomes]),
      nonGoals: Object.freeze([...source.brief.nonGoals]),
      assumptions: Object.freeze(source.brief.assumptions.map((entry) => Object.freeze({ text: entry.text, confirmed: entry.confirmed }))),
      openQuestionCount: source.brief.openQuestions.length,
    }),
    plan: Object.freeze({
      revisionLabel: `Plan revision ${source.plan.revision}`,
      state: words(source.plan.state),
      stages: Object.freeze(source.plan.stages.map((stage) => Object.freeze({
        title: stage.title,
        intent: stage.intent,
        taskCount: stage.taskIds.length,
        gate: stage.gate,
      }))),
      taskCount: source.plan.tasks.length,
      dependencyCount: source.plan.dependencies.length,
      authority: source.plan.authority,
      actions: Object.freeze(source.planActions.map((action) => Object.freeze({ ...action }))),
    }),
    approval: Object.freeze({
      classLabel: words(source.approval.class),
      risk: source.approval.risk,
      title: source.approval.subjectSummary.what,
      why: source.approval.subjectSummary.why,
      changes: source.approval.subjectSummary.changes,
      scope: source.approval.subjectSummary.scope,
      reversible: source.approval.subjectSummary.reversible,
      effects: Object.freeze([...source.approval.effects]),
      exclusions: Object.freeze([...source.approval.exclusions]),
      state: words(source.approval.state),
      expiryLabel: new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(source.approval.expiresAt)),
      moneyLabel: source.approval.money === null ? "No spending requested" : "Spending details require a real bound request",
    }),
  });
}
