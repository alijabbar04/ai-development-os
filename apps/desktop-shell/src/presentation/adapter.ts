import type {
  ApprovalRequest,
  ProjectBrief,
  ProjectPlan,
  ProjectSummaryProjection,
} from "@ai-dev-os/project";
import type { PlanProjectionAction } from "@ai-dev-os/plan";

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
