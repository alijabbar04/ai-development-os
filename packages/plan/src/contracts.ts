import type {
  ApprovalRequest,
  Decision,
  Dependency,
  Project,
  ProjectBrief,
  ProjectPlan,
  ProjectTask,
} from "@ai-dev-os/project";
import type {
  ExecutableDisposition as UpstreamExecutableDisposition,
  ProductSpecification,
  RequirementTaskCoverage,
  ScopeAuthority as UpstreamScopeAuthority,
  ScopeDisposition as UpstreamScopeDisposition,
} from "@ai-dev-os/product-planning";
import type {
  ConstraintDispositionKind,
  PlanEventType,
  PlanRuleId,
  ScopeAuthority,
  ScopeDisposition,
} from "./constants.js";
import type { PlanRefusalCode } from "./errors.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type _ScopeDispositionParity = Assert<Equal<ScopeDisposition, UpstreamScopeDisposition>>;
type _ScopeAuthorityParity = Assert<Equal<ScopeAuthority, UpstreamScopeAuthority>>;
type _ExecutableDispositionParity = Assert<
  Equal<"required" | "expected-quality" | "delight-candidate", UpstreamExecutableDisposition>
>;

export interface PlanDigestPort {
  sha256(canonicalText: string): string;
}

export interface ClaimProvenance {
  readonly origin: "operator" | "operator-edit" | "brief" | "specification" | "repository" | "model";
  readonly derivedFrom: DerivedFromRef | null;
  readonly verbatim: boolean;
}

export type DerivedFromRef =
  | Readonly<{ kind: "brief-objective"; briefId: string }>
  | Readonly<{ kind: "brief-outcome"; briefId: string; index: number }>
  | Readonly<{ kind: "brief-non-goal"; briefId: string; index: number }>
  | Readonly<{ kind: "brief-constraint"; briefId: string; constraintId: string }>
  | Readonly<{ kind: "brief-assumption"; briefId: string; index: number }>
  | Readonly<{ kind: "requirement"; specificationId: string; requirementId: string }>;

export type StageFieldPath = "title" | "intent" | `exitCriteria[${number}]`;
export type TaskFieldPath = "title" | "objective" | `acceptance[${number}].criterion`;

export interface ProposedStage {
  readonly stageId: string;
  readonly title: string;
  readonly intent: string;
  readonly exitCriteria: readonly string[];
  readonly taskIds: readonly string[];
  readonly provenance: Readonly<Record<string, ClaimProvenance>>;
}

export interface ProposedTaskRequirements {
  readonly kind: ProjectTask["requirements"]["kind"];
  readonly complexity: ProjectTask["requirements"]["complexity"];
  readonly risk: ProjectTask["requirements"]["risk"];
  readonly reasoning: ProjectTask["requirements"]["reasoning"];
}

export interface ProposedTask {
  readonly taskId: string;
  readonly stageId: string;
  readonly title: string;
  readonly objective: string;
  readonly requirements: ProposedTaskRequirements;
  readonly acceptance: readonly Readonly<{
    criterion: string;
    validationCommand: readonly string[] | null;
  }>[];
  readonly requirementIds: readonly string[];
  readonly provenance: Readonly<Record<string, ClaimProvenance>>;
}

export type PlanProposalSource =
  | Readonly<{ kind: "operator"; authority: "none" }>
  | Readonly<{
      kind: "model";
      authority: "none";
      routeFingerprint: string;
      contributionDigest: string;
      narrativeRef: string | null;
      /** A host-prepared edit history; it grants no authentication or authority. */
      adoption?: PlanModelAdoption;
    }>
  | Readonly<{ kind: "deterministic"; authority: "none"; generatorId: string }>;

export interface ConstraintDisposition {
  readonly constraintId: string;
  readonly disposition: ConstraintDispositionKind;
  readonly taskId: string | null;
  readonly waiverDecisionId: string | null;
}

export interface PlanProposal {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly briefId: string;
  readonly source: PlanProposalSource;
  readonly stages: readonly ProposedStage[];
  readonly tasks: readonly ProposedTask[];
  readonly dependencies: readonly Dependency[];
  readonly budgetCeiling: ProjectPlan["budgetCeiling"];
  readonly constraintDispositions: readonly ConstraintDisposition[];
}

export interface AuthenticatedOperatorClaimEvidence {
  readonly nodeKind: "stage" | "task";
  readonly nodeId: string;
  readonly fieldPath: string;
  readonly value: string;
}

/** Existing prose fields only. Graph, source, coverage and authority are not editable here. */
export interface PlanModelFieldEdit extends AuthenticatedOperatorClaimEvidence {}

export interface PlanModelEditRecord extends PlanModelFieldEdit {
  readonly previousValue: string;
  readonly previousProvenance: ClaimProvenance;
}

export interface PlanModelAdoption {
  readonly schemaVersion: 1;
  readonly originalProposalDigest: string;
  readonly edits: readonly PlanModelEditRecord[];
}

export interface PreparedModelPlanAdoption {
  readonly proposal: PlanProposal;
  /** The trusted host must authenticate these exact rows using its private commit capability. */
  readonly authenticatedOperatorEvidence: readonly AuthenticatedOperatorClaimEvidence[];
}

export interface TaskBudgetAllocation {
  readonly taskId: string;
  readonly budget: ProjectTask["budget"];
}

export interface PlanTaskIdBinding {
  readonly upstreamTaskId: string;
  readonly planTaskId: string;
}

export interface PlanWaiverBinding {
  readonly requirementId: string;
  readonly waiverDecisionId: string;
}

export interface PlanSpecificationAdapterInput {
  readonly schemaVersion: 1;
  readonly specification: ProductSpecification;
  readonly coverage: readonly RequirementTaskCoverage[];
  readonly taskIdMap: readonly PlanTaskIdBinding[];
  readonly waiverBindings: readonly PlanWaiverBinding[];
}

export interface PlanAssemblyRequest {
  readonly schemaVersion: 1;
  readonly newPlanId: string;
  readonly proposal: PlanProposal;
  readonly expectedProposalDigest: string;
  readonly expectedSpecificationDigest: string | null;
  readonly expectedCoverageDigest: string | null;
  readonly taskBudgetAllocations: readonly TaskBudgetAllocation[];
  readonly specificationInput: PlanSpecificationAdapterInput | null;
}

export interface UpstreamRequirementProvenance {
  readonly contributionId: string;
  readonly phaseId: string;
  readonly routeKey: string;
  readonly sourceFingerprint: string;
  readonly candidateId: string;
}

export interface BoundRequirement {
  readonly requirementId: string;
  readonly requirementDigest: string;
  readonly decisionId: string;
  readonly disposition: ScopeDisposition;
  readonly sourceProvenance: readonly UpstreamRequirementProvenance[];
  readonly executable: boolean;
  readonly upstreamTaskId: string | null;
  readonly taskId: string | null;
  readonly waiverDecisionId: string | null;
}

export interface SpecificationBinding {
  readonly specificationId: string;
  readonly upstreamPlanId: string;
  readonly upstreamPlanVersion: number;
  readonly intentDigest: string;
  readonly decisionSetDigest: string;
  readonly approvedBy: Readonly<{ actorId: string; authority: ScopeAuthority }>;
  readonly approvalReference: string;
  readonly approvedAt: string;
  readonly approvalDigest: string;
  readonly specificationRef: string;
  readonly coverageRef: string;
  readonly requirements: readonly BoundRequirement[];
}

export interface PlanRecordCoordinates {
  readonly planId: string;
  readonly revision: number;
  readonly supersedes: string | null;
  readonly state: ProjectPlan["state"];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sealedAt: string | null;
}

export interface PlanProvenanceSnapshot {
  readonly stages: readonly Readonly<{
    stageId: string;
    fields: Readonly<Record<string, ClaimProvenance>>;
  }>[];
  readonly tasks: readonly Readonly<{
    taskId: string;
    fields: Readonly<Record<string, ClaimProvenance>>;
  }>[];
}

export interface PlanReviewEvidence {
  readonly assemblyRequest: PlanAssemblyRequest;
  readonly proposalDigest: string;
  readonly specification: SpecificationBinding | null;
  readonly specificationDigest: string | null;
  readonly coverageDigest: string | null;
  readonly constraintDispositions: readonly ConstraintDisposition[];
  readonly provenance: PlanProvenanceSnapshot;
  readonly authenticatedOperatorEvidence: readonly AuthenticatedOperatorClaimEvidence[];
}

export interface PlanAssemblyResult {
  readonly plan: ProjectPlan;
  readonly review: PlanReviewEvidence;
}

export interface AcceptedBriefBinding {
  readonly projectId: ProjectBrief["projectId"];
  readonly briefId: ProjectBrief["briefId"];
  readonly briefAggregateVersion: number;
  readonly briefContentDigest: string;
  readonly acceptedCandidateDigest: string;
  readonly acceptanceEventId: string;
}

export interface AcceptedBriefHead {
  readonly projectId: ProjectBrief["projectId"];
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly brief: ProjectBrief;
  readonly briefContentDigest: string;
  readonly acceptedCandidateDigest: string;
  readonly acceptanceEventId: string;
}

export type AcceptedBriefRead =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "accepted"; head: AcceptedBriefHead }>
  | Readonly<{ kind: "invalid-proof"; ruleId: "plan.brief.acceptance-proof-invalid" }>
  | Readonly<{
      kind: "unresolved";
      ruleId: "plan.store.unresolved";
      reason: "adapter-unavailable" | "evidence-bound-exhausted" | "cursor-protocol-invalid";
    }>;

export interface PlanCommitBinding {
  readonly contentDigest: string;
  readonly expectedHeadPlanId: string | null;
  readonly expectedAggregateVersion: number;
}

export interface PlanEventBinding extends AcceptedBriefBinding {
  readonly contentDigest: string;
  readonly planId: string;
  readonly planRevision: number;
  readonly planDigest: string;
  readonly proposalDigest: string;
  readonly expectedHeadPlanId: string | null;
  readonly expectedAggregateVersion: number;
  readonly resultAggregateVersion: number;
  readonly resultState: ProjectPlan["state"];
  readonly headAdvanced: boolean;
  readonly stepIndex: 1 | 2;
  readonly stepCount: 1 | 2;
  readonly briefBlockingQuestionIds: readonly string[];
}

export interface PlanMutationControlEvidence {
  readonly projectAggregateVersion: number;
  readonly projectContentDigest: string;
  readonly projectStatus: "active";
  readonly projectStopSnapshotDigest: string;
  readonly activeProjectStopIds: readonly [];
}

export interface ResolvedProjectCeilingEvidence {
  readonly budgetAccountId: string;
  readonly budgetAccountAggregateVersion: number;
  readonly budgetAccountContentDigest: string;
  readonly budgetAccountStateVersion: number;
  readonly briefContentDigest: string;
  readonly accountMaximumTotalTokens: number | null;
  readonly ceiling: ProjectPlan["budgetCeiling"];
}

export interface PlanEventEnvelopeInput {
  readonly occurredAt: string;
  readonly traceId: string | null;
  readonly causationId: string | null;
}

export interface PlanDraftReplacementRebaseLink extends AcceptedBriefBinding {
  readonly kind: "plan.rebased";
  readonly replaces: string;
  readonly replacesRevision: number;
  readonly previousDisposition: Readonly<{ kind: "draft-replaced"; from: "drafting" }>;
}

export interface PlanSupersedingRebaseLink extends AcceptedBriefBinding {
  readonly kind: "plan.rebased";
  readonly replaces: string;
  readonly replacesRevision: number;
  readonly previousDisposition: Readonly<{
    kind: "superseded";
    from: "proposed" | "sealed";
    to: "superseded";
  }>;
}

export type PlanRebaseLink = PlanDraftReplacementRebaseLink | PlanSupersedingRebaseLink;

export interface PlanPredecessorStamp {
  readonly planId: string;
  readonly revision: number;
  readonly supersedes: string | null;
  readonly state: "superseded";
  readonly planDigest: string;
  readonly sealedAt: string | null;
  readonly sealedByApprovalId: string | null;
}

export interface PlanDraftReplacementStamp {
  readonly planId: string;
  readonly revision: number;
  readonly supersedes: string | null;
  readonly state: "drafting";
  readonly planDigest: string;
  readonly sealedAt: null;
  readonly sealedByApprovalId: null;
}

export type PlanPredecessorEvidence = PlanPredecessorStamp | PlanDraftReplacementStamp;

export interface PlanSealConditionVerdict {
  readonly condition: 1 | 2 | 3 | 4 | 5 | 6;
  readonly passed: boolean;
  readonly ruleIds: readonly string[];
}

export interface PlanSealEvidence {
  readonly verdicts: readonly [
    PlanSealConditionVerdict & Readonly<{ condition: 1 }>,
    PlanSealConditionVerdict & Readonly<{ condition: 2 }>,
    PlanSealConditionVerdict & Readonly<{ condition: 3 }>,
    PlanSealConditionVerdict & Readonly<{ condition: 4 }>,
    PlanSealConditionVerdict & Readonly<{ condition: 5 }>,
    PlanSealConditionVerdict & Readonly<{ condition: 6 }>,
  ];
  readonly blockingQuestionIds: readonly string[];
  readonly resolvedProjectCeiling: ResolvedProjectCeilingEvidence;
  readonly sealedAt: string;
  readonly sealedByApprovalId: string | null;
}

export interface PlanBudgetExtensionEvidence {
  readonly taskId: string;
  readonly previousBudget: ProjectTask["budget"];
  readonly requestedBudget: ProjectTask["budget"];
  readonly decisionId: string;
}

type DecisionOf<K extends Decision["kind"]> = Readonly<Decision & { readonly kind: K }>;
export type ScopeSealDecision = DecisionOf<"scope-accepted" | "scope-deferred">;
export type SupplementalSealDecision = DecisionOf<"waiver-granted" | "conflict-resolution">;
export type PlanSealDecisions = readonly [ScopeSealDecision, ...SupplementalSealDecision[]];

export interface PlanEventPayload<
  K extends PlanEventType,
  O,
  D extends readonly Decision[],
  R extends PlanRebaseLink | null,
  P extends PlanPredecessorEvidence | null,
  S extends PlanSealEvidence | null,
  B extends PlanBudgetExtensionEvidence | null,
> {
  readonly schemaVersion: 1;
  readonly kind: K;
  readonly operation: O;
  readonly plan: ProjectPlan;
  readonly binding: PlanEventBinding;
  readonly controls: PlanMutationControlEvidence;
  readonly review: PlanReviewEvidence;
  readonly decisions: D;
  readonly rebase: R;
  readonly predecessor: P;
  readonly seal: S;
  readonly budgetExtension: B;
}

export type PlanDraftedEvent =
  | PlanEventPayload<"plan.drafted", Readonly<{ kind: "draft"; mode: "create" }>, readonly [], null, null, null, null>
  | PlanEventPayload<"plan.drafted", Readonly<{ kind: "draft"; mode: "redraft" }>, readonly [], PlanRebaseLink | null, PlanDraftReplacementStamp, null, null>;
export type PlanProposedEvent = PlanEventPayload<"plan.proposed", Readonly<{ kind: "promote" | "approve-scope" }>, readonly [], null, null, null, null>;
export type PlanScopeApprovalRequiredEvent = PlanEventPayload<"plan.scope-approval-required", Readonly<{ kind: "require-scope-approval" }>, readonly [], null, null, null, null>;
export type PlanScopeRejectedEvent = PlanEventPayload<"plan.scope-rejected", Readonly<{ kind: "reject-scope" }>, readonly [DecisionOf<"scope-rejected">], null, null, null, null>;
export type PlanSealedEvent = PlanEventPayload<"plan.sealed", Readonly<{ kind: "seal" }>, PlanSealDecisions, null, null, PlanSealEvidence, null>;
export type PlanRevisedEvent =
  | PlanEventPayload<"plan.revised", Readonly<{ kind: "revise"; mode: "R1" }>, readonly [DecisionOf<"plan-revision-accepted">], null, PlanPredecessorStamp, null, null>
  | PlanEventPayload<"plan.revised", Readonly<{ kind: "revise"; mode: "R2" }>, readonly [DecisionOf<"plan-revision-accepted">], PlanSupersedingRebaseLink, PlanPredecessorStamp, null, null>;
export type PlanSupersededEvent = PlanEventPayload<"plan.superseded", Readonly<{ kind: "discard-stale" }>, readonly [], null, null, null, null>;
export type PlanAbandonedEvent = PlanEventPayload<"plan.abandoned", Readonly<{ kind: "abandon" }>, readonly [], null, null, null, null>;
export type PlanBudgetExtendedEvent = PlanEventPayload<"plan.budget-extended", Readonly<{ kind: "record-budget-extension" }>, readonly [DecisionOf<"budget-extension-accepted">], null, null, null, PlanBudgetExtensionEvidence>;

export type PlanHeadEventPayload =
  | PlanDraftedEvent | PlanProposedEvent | PlanScopeApprovalRequiredEvent
  | PlanScopeRejectedEvent | PlanSealedEvent | PlanRevisedEvent
  | PlanSupersededEvent | PlanAbandonedEvent;
export type PlanJournalEventPayload = PlanHeadEventPayload | PlanBudgetExtendedEvent;

export interface PlanJournalEntry {
  readonly eventId: string;
  readonly aggregateType: "project-plan";
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: PlanEventType;
  readonly eventSchemaVersion: 1;
  readonly payload: PlanJournalEventPayload;
  readonly payloadChecksum: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly globalSequence: number;
  readonly traceId: string | null;
  readonly causationId: string | null;
}

export interface PlanHeadJournalEntry extends Omit<PlanJournalEntry, "payload"> {
  readonly payload: PlanHeadEventPayload;
}

export interface PlanLineageHead {
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly plan: ProjectPlan;
  readonly payloadChecksum: string;
  readonly acceptedBrief: AcceptedBriefBinding;
  readonly headEvent: PlanHeadJournalEntry;
}

export type PlanHeadRead =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "head"; head: PlanLineageHead }>
  | Readonly<{ kind: "corrupt"; ruleId: "plan.store.corrupt" }>
  | Readonly<{
      kind: "unavailable";
      ruleId: "plan.store.unavailable";
      reason: "adapter-unavailable" | "evidence-bound-exhausted" | "cursor-protocol-invalid";
    }>;

export interface PlanJournalWindow {
  readonly limit: number;
  readonly cursor: string | null;
}

export interface PlanJournalPage {
  readonly events: readonly PlanJournalEntry[];
  readonly nextCursor: string | null;
}

export type PlanJournalRead =
  | Readonly<{ kind: "page"; page: PlanJournalPage }>
  | Readonly<{ kind: "corrupt"; ruleId: "plan.store.corrupt" }>
  | Readonly<{ kind: "cursor-invalid"; ruleId: "plan.store.cursor-invalid" }>
  | Readonly<{
      kind: "unavailable";
      ruleId: "plan.store.unavailable";
      reason: "adapter-unavailable" | "evidence-bound-exhausted";
    }>;

export interface PlanHeadStep {
  readonly eventId: string;
  readonly expectedState: ProjectPlan["state"] | null;
  readonly plan: ProjectPlan;
  readonly envelope: PlanEventEnvelopeInput;
  readonly event: PlanHeadEventPayload;
}

export interface PlanAnnotationStep {
  readonly eventId: string;
  readonly expectedState: ProjectPlan["state"];
  readonly plan: null;
  readonly envelope: PlanEventEnvelopeInput;
  readonly event: PlanBudgetExtendedEvent;
}

export interface PlanCommitRequest {
  readonly schemaVersion: 1;
  readonly projectId: ProjectBrief["projectId"];
  readonly binding: PlanCommitBinding;
  readonly acceptedBrief: AcceptedBriefBinding;
  readonly expectedControls: PlanMutationControlEvidence;
  readonly steps: readonly [PlanHeadStep] | readonly [PlanHeadStep, PlanHeadStep] | readonly [PlanAnnotationStep];
}

declare const planCommitAuthorizationBrand: unique symbol;
export interface PlanCommitAuthorization {
  readonly [planCommitAuthorizationBrand]: true;
}

export type PlanOperationKind =
  | "draft" | "promote" | "approve-scope" | "require-scope-approval" | "reject-scope"
  | "seal" | "revise" | "discard-stale" | "abandon" | "record-budget-extension";

export interface IssuedPlanCommitFacts {
  readonly projectId: string;
  readonly contentDigest: string;
  readonly operationKinds: readonly PlanOperationKind[];
  readonly eventIds: readonly string[];
  readonly authenticatedOperatorEvidence: readonly AuthenticatedOperatorClaimEvidence[];
  readonly decisions: readonly Decision[];
}

export type PlanCommitOutcome =
  | Readonly<{ kind: "committed"; aggregateVersion: number; evidence: "receipt" }>
  | Readonly<{ kind: "conflict"; actualVersion: number }>
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "not-attempted"; reason: "brief-evidence-unresolved"; ruleId: "plan.store.unresolved" }>
  | Readonly<{ kind: "refused"; code: PlanRefusalCode; ruleId: string }>;

export type PlanObservationOutcome =
  | Readonly<{ kind: "committed"; aggregateVersion: number; evidence: "head-observation" | "journal-observation" }>
  | Readonly<{ kind: "not-recorded"; aggregateVersion: number }>
  | Readonly<{ kind: "conflict"; actualVersion: number }>
  | Readonly<{ kind: "unknown" }>;

export interface PlanStore {
  readHead(projectId: string): Promise<PlanHeadRead>;
  readAcceptedBriefHead(projectId: string): Promise<AcceptedBriefRead>;
  commit(request: PlanCommitRequest, authorization: PlanCommitAuthorization): Promise<PlanCommitOutcome>;
  readJournal(projectId: string, window: PlanJournalWindow): Promise<PlanJournalRead>;
}

export interface SealEvaluationInput {
  readonly plan: ProjectPlan;
  readonly review: PlanReviewEvidence;
  readonly acceptedBrief: AcceptedBriefHead;
  readonly project: Project;
  readonly controls: PlanMutationControlEvidence;
  readonly resolvedProjectCeiling: ResolvedProjectCeilingEvidence;
  readonly authenticatedDecisions: readonly Decision[];
  readonly scopeApproval: ApprovalRequest | null;
}

export type PlanWriteOperation =
  | "first-draft" | "redraft" | "promote" | "scope-rejected" | "seal"
  | "revision-r1" | "revision-r2" | "discard-stale" | "abandon" | "budget-extension";
export type PlanWriteOrigin = "review-required" | "committed" | "source-brief-stale";

export interface PendingWriteContext {
  readonly operation: PlanWriteOperation;
  readonly origin: PlanWriteOrigin;
  readonly observationKind: "head" | "journal";
  readonly request: PlanCommitRequest;
}
