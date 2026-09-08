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

export function planningResultMessage(result: PlanningCommandResult, action: string, includeReason = false): string {
  const reason = !includeReason || result.reason === null ? "" : ` Details: ${result.reason}`;
  const message = (): string => {
  switch (result.kind) {
    case "committed": return `${action} saved.`;
    case "ready": return `${action} is ready.`;
    case "idempotent-replay": return `${action} was already saved. The original result is shown.`;
    case "unknown": return `${action} may have been saved. Observe this exact command before doing anything else.`;
    case "conflict": return `${action} was not saved because this project changed. Reload the saved project before continuing.${reason}`;
    case "corrupt": return `${action} could not be verified because saved data failed validation. Keep the exact command for observation; do not repeat it.${reason}`;
    case "not-recorded": return `No saved outcome was found for ${action.toLowerCase()}.${reason}`;
    case "cancelled": return `${action} was cancelled.`;
    case "refused": return `${action} was unavailable.${reason}`;
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
