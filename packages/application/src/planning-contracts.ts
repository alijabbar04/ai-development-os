/** Renderer proposals and lookup coordinates only. No actor, path grant or approval capability crosses this boundary. */
export type PlanningCommand =
  | Readonly<{ kind: "create-project"; commandId: string; name: string; objective: string; outcomes: readonly string[]; budgetMinorUnits: number; currency: string }>
  | Readonly<{ kind: "draft-brief"; projectId: string; objective: string; outcomes: readonly string[]; nonGoals: readonly string[]; audiences: readonly string[]; expectedBriefVersion: number }>
  | Readonly<{ kind: "answer-clarification"; projectId: string; candidateId: string; answers: readonly Readonly<{ questionId: string; value: string }>[] }>
  | Readonly<{ kind: "accept-brief"; commandId: string; projectId: string; candidateId: string; candidateDigest: string; expectedBriefVersion: number }>
  | Readonly<{ kind: "select-repository"; commandId: string; projectId: string; expectedProjectVersion: number }>
  | Readonly<{ kind: "save-plan"; commandId: string; projectId: string; expectedPlanVersion: number; title: string; tasks: readonly PlanningTaskInput[]; scope: "within-brief" | "scope-expansion" }>
  | Readonly<{ kind: "prepare-plan" | "seal-plan"; commandId: string; projectId: string; expectedPlanVersion: number }>
  | Readonly<{ kind: "approve-scope" | "request-scope-again"; commandId: string; projectId: string; expectedPlanVersion: number; scopeRequest: PlanningScopeSubject }>
  | Readonly<{ kind: "stop-project" | "resume-project"; commandId: string; projectId: string; expectedProjectVersion: number }>
  | Readonly<{ kind: "export-handover"; commandId: string; projectId: string; expectedPlanVersion: number }>
  | Readonly<{ kind: "attach-result"; commandId: string; projectId: string; handoverId: string }>
  | Readonly<{ kind: "historical-money"; commandId: string; projectId: string; approvalId: string; expectedApprovalVersion: number; expectedSpendingVersion: number; action: "report-executed" | "record-receipt" | "withdraw"; receiptRef: string | null }>;

/** Lookup coordinates, checked against saved authority before and after native confirmation. */
export interface PlanningScopeSubject {
  readonly approvalId: string;
  readonly approvalVersion: number;
  readonly metadataId: string;
  readonly metadataVersion: number;
  readonly metadataDigest: string;
}
export type PlanningArtifactState = "published" | "differs-on-disk" | "unavailable";
export type PlanningProjectionWarning = "handover-files" | "workspace-unavailable" | "workspace-corrupt";
export interface PlanningTaskInput {
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
}
export interface PlanningProjectSummary {
  readonly projectId: string;
  readonly name: string;
  readonly version: number;
  readonly stopped: boolean;
  readonly planState: string | null;
}
export interface PlanningWorkspaceView {
  readonly schemaVersion: 1;
  readonly authority: "none";
  readonly source: "saved-local-planning";
  readonly projects: readonly PlanningProjectSummary[];
  readonly selected: PlanningProjectView | null;
}
export interface PlanningProjectView extends PlanningProjectSummary {
  readonly budget: Readonly<{ minorUnits: number; currency: string }>;
  readonly repository: Readonly<{ rootLeaf: string; state: string; head: string | null; branch: string | null; observedAt: string; facts: readonly string[] }> | null;
  readonly brief: Readonly<{ briefId: string; version: number; digest: string; objective: string; outcomes: readonly string[]; nonGoals: readonly string[]; audiences: readonly string[] }> | null;
  readonly candidate: Readonly<{ candidateId: string; digest: string; ready: boolean; objective: string; outcomes: readonly string[]; questions: readonly Readonly<{ questionId: string; question: string; whyItMatters: string; proposedDefault: string; blocking: boolean }>[] }> | null;
  readonly plan: Readonly<{ planId: string; version: number; revision: number; digest: string; state: string; title: string; tasks: readonly PlanningTaskInput[]; scope: "within-brief" | "scope-expansion"; sealedByApprovalId: string | null; scopeApproval: Readonly<{ subject: PlanningScopeSubject; state: string; expiresAt: string; expired: boolean }> | null; actions: readonly ("prepare-plan" | "approve-scope" | "request-scope-again" | "seal-plan")[] }> | null;
  readonly approvals: readonly Readonly<{ approvalId: string; version: number; spendingVersion: number; title: string; state: string; expiresAt: string; context: string; actions: readonly ("report-executed" | "record-receipt" | "withdraw")[] }>[];
  readonly handovers: readonly Readonly<{ handoverId: string; fileName: string; artifactState: PlanningArtifactState; planRevision: number; planDigest: string; stale: boolean; result: Readonly<{ attribution: "operator-supplied-untrusted"; text: string; stale: boolean }> | null }>[];
  readonly history: readonly Readonly<{ eventId: string; kind: string; at: string }>[];
}
export interface PlanningCommandResult {
  readonly kind: "committed" | "ready" | "idempotent-replay" | "refused" | "conflict" | "corrupt" | "unknown" | "not-recorded" | "cancelled";
  readonly commandId: string | null;
  readonly reason: string | null;
  readonly projectId: string | null;
  readonly workspace: PlanningWorkspaceView | null;
  readonly projectionWarning: PlanningProjectionWarning | null;
}
/** Bounded read-only view of one saved authority-none planning artifact. */
export interface PlanningHandoverView {
  readonly schemaVersion: 1;
  readonly authority: "none";
  readonly projectId: string;
  readonly handoverId: string;
  readonly fileName: string;
  readonly artifactState: PlanningArtifactState;
  readonly stale: boolean;
  readonly text: string;
}
