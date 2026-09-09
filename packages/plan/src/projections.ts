import {
  parseProjectPlan,
  planStateDisplayWord,
  serializeCanonicalProjectJson,
  type ProjectPlan,
} from "@ai-dev-os/project";
import { assertPlanReviewCoherent, canonicalPlanDigestMaterial, computePlanOrder } from "./assembly.js";
import { PLAN_AVAILABLE_COMMANDS, PLAN_EVENT_TYPES, PLAN_PRODUCTION_ENABLED } from "./constants.js";
import type {
  AcceptedBriefBinding,
  PlanDigestPort,
  PlanHeadEventPayload,
  PlanHeadJournalEntry,
  PlanLineageHead,
  PlanReviewEvidence,
} from "./contracts.js";
import { refusePlan } from "./errors.js";
import { PLAN_ASSEMBLY_STATES, assertAcyclicPlanChain, type PlanAssemblyState } from "./lifecycle.js";
import {
  isHeadEvent,
  parseAcceptedBriefBinding,
  parsePlanJournalEvent,
  parsePlanReviewEvidence,
  parsePlanSealVerdicts,
  parseResolvedProjectCeilingEvidence,
} from "./persistence.js";
import {
  enumText,
  exactKeys,
  literal,
  planDigest,
  planIdentifier,
  safeInteger,
  strictArray,
  strictRecord,
} from "./validation.js";

export type PlanProjectionMode = "normal" | "developer";

export interface PlanProjectionEnvelope<K extends string, V> {
  readonly mode: PlanProjectionMode;
  readonly kind: K;
  readonly authority: "none";
  readonly commands: readonly [];
  readonly value: V;
}

export interface QuotedPlanContent {
  readonly text: string;
  readonly provenance: "operator-confirmed" | "operator-edited" | "accepted-brief" | "specification" | "model-proposed";
}

export const PLAN_PROJECTION_ACTIONS = Object.freeze([
  "save-draft", "promote", "abandon", "seal", "revise", "record-budget-extension",
  "wait-for-c10", "reject-scope", "rebase", "discard-stale", "cancel",
  "recheck-brief-evidence", "check-save-status",
] as const);
export type PlanProjectionActionKind = (typeof PLAN_PROJECTION_ACTIONS)[number];

export interface PlanProjectionAction {
  readonly action: PlanProjectionActionKind;
  readonly label: string;
  readonly enabled: boolean;
  readonly disabledReason: string | null;
}

export type PlanProjectionNotice =
  | Readonly<{
      kind: "brief-evidence-unresolved";
      reason: "adapter-unavailable" | "evidence-bound-exhausted" | "cursor-protocol-invalid";
    }>
  | Readonly<{
      kind: "write-outcome-unknown";
      state: "write-outcome-unknown-to-review" | "write-outcome-unknown-to-committed" | "write-outcome-unknown-to-stale";
      operation: "first-draft" | "redraft" | "promote" | "scope-rejected" | "seal" | "revision-r1" | "revision-r2" | "discard-stale" | "abandon" | "budget-extension";
      origin: "review-required" | "committed" | "source-brief-stale";
      observationKind: "head" | "journal";
    }>
  | Readonly<{
      kind: "write-not-recorded";
      origin: "review-required" | "committed" | "source-brief-stale";
    }>;

export interface PlanProjectionContext {
  readonly computedAt: string;
  readonly sessionState: PlanAssemblyState;
  readonly planAggregateVersion: number;
  readonly acceptedBrief: AcceptedBriefBinding;
  readonly acceptedBriefAggregateId: string;
  readonly currentBrief: AcceptedBriefBinding | null;
  readonly unconfirmedAssumptionCount: number;
  readonly openQuestionCount: number;
  readonly notice: PlanProjectionNotice | null;
  readonly historicalHead: PlanLineageHead | null;
}

const OPERATION_VALUES = Object.freeze([
  "first-draft", "redraft", "promote", "scope-rejected", "seal", "revision-r1",
  "revision-r2", "discard-stale", "abandon", "budget-extension",
] as const);
const ORIGIN_VALUES = Object.freeze(["review-required", "committed", "source-brief-stale"] as const);
const UNKNOWN_STATES = Object.freeze([
  "write-outcome-unknown-to-review", "write-outcome-unknown-to-committed", "write-outcome-unknown-to-stale",
] as const);
const UNRESOLVED_REASONS = Object.freeze([
  "adapter-unavailable", "evidence-bound-exhausted", "cursor-protocol-invalid",
] as const);

function timestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value
    || value < "2000-01-01T00:00:00.000Z"
    || value > "9999-12-31T23:59:59.999Z") {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  return value;
}

function atLeastOne(value: unknown, path: string): number {
  const parsed = safeInteger(value, path);
  if (parsed < 1) return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  return parsed;
}

function nullableIdentifier(value: unknown, path: string): string | null {
  return value === null ? null : planIdentifier(value, "", path);
}

function sameValue(left: unknown, right: unknown): boolean {
  try {
    return serializeCanonicalProjectJson(left as never) === serializeCanonicalProjectJson(right as never);
  } catch {
    return false;
  }
}

function bindingFromEvent(payload: PlanHeadEventPayload): AcceptedBriefBinding {
  return Object.freeze({
    projectId: payload.binding.projectId,
    briefId: payload.binding.briefId,
    briefAggregateVersion: payload.binding.briefAggregateVersion,
    briefContentDigest: payload.binding.briefContentDigest,
    acceptedCandidateDigest: payload.binding.acceptedCandidateDigest,
    acceptanceEventId: payload.binding.acceptanceEventId,
  });
}

function canonicalPlan(value: unknown, digest: PlanDigestPort): ProjectPlan {
  let plan: ProjectPlan;
  try { plan = parseProjectPlan(value); }
  catch { return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planProjection"); }
  let computed: string;
  try { computed = planDigest(digest.sha256(canonicalPlanDigestMaterial(plan)), "planProjection"); }
  catch { return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.digest-mismatch", "planProjection"); }
  if (computed !== plan.planDigest) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.digest-mismatch", "planProjection");
  }
  return plan;
}

function parseProjectionHead(value: unknown, digest: PlanDigestPort): PlanLineageHead {
  const input = strictRecord(value, "planProjection");
  exactKeys(input, ["aggregateId", "aggregateVersion", "plan", "payloadChecksum", "acceptedBrief", "headEvent"], "planProjection");
  const aggregateId = planIdentifier(input["aggregateId"], "prj:", "planProjection");
  const aggregateVersion = atLeastOne(input["aggregateVersion"], "planProjection");
  const plan = canonicalPlan(input["plan"], digest);
  const payloadChecksum = planDigest(input["payloadChecksum"], "planProjection");
  const acceptedBrief = parseAcceptedBriefBinding(input["acceptedBrief"]);
  const eventInput = strictRecord(input["headEvent"], "planProjection");
  exactKeys(eventInput, [
    "eventId", "aggregateType", "aggregateId", "aggregateVersion", "eventType", "eventSchemaVersion",
    "payload", "payloadChecksum", "occurredAt", "recordedAt", "globalSequence", "traceId", "causationId",
  ], "planProjection");
  literal(eventInput["aggregateType"], "project-plan", "planProjection");
  literal(eventInput["eventSchemaVersion"], 1, "planProjection");
  const payload = parsePlanJournalEvent(eventInput["payload"], digest);
  if (!isHeadEvent(payload)) refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planProjection");
  const headEventChecksum = planDigest(eventInput["payloadChecksum"], "planProjection");
  let expectedChecksum: string;
  try { expectedChecksum = planDigest(digest.sha256(serializeCanonicalProjectJson(payload)), "planProjection"); }
  catch { return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planProjection"); }
  const headEvent = Object.freeze({
    eventId: planIdentifier(eventInput["eventId"], "", "planProjection"),
    aggregateType: "project-plan" as const,
    aggregateId: planIdentifier(eventInput["aggregateId"], "prj:", "planProjection"),
    aggregateVersion: atLeastOne(eventInput["aggregateVersion"], "planProjection"),
    eventType: enumText(eventInput["eventType"], PLAN_EVENT_TYPES, "planProjection"),
    eventSchemaVersion: 1 as const,
    payload,
    payloadChecksum: headEventChecksum,
    occurredAt: timestamp(eventInput["occurredAt"], "planProjection"),
    recordedAt: timestamp(eventInput["recordedAt"], "planProjection"),
    globalSequence: atLeastOne(eventInput["globalSequence"], "planProjection"),
    traceId: nullableIdentifier(eventInput["traceId"], "planProjection"),
    causationId: nullableIdentifier(eventInput["causationId"], "planProjection"),
  }) as PlanHeadJournalEntry;
  if (aggregateId !== plan.projectId
    || aggregateId !== headEvent.aggregateId
    || aggregateVersion !== headEvent.aggregateVersion
    || aggregateVersion !== payload.binding.resultAggregateVersion
    || payloadChecksum !== headEventChecksum
    || headEventChecksum !== expectedChecksum
    || headEvent.eventType !== payload.kind
    || !sameValue(plan, payload.plan)
    || !sameValue(acceptedBrief, bindingFromEvent(payload))) {
    refusePlan("PLAN_STORE_CORRUPT", "plan.store.corrupt", "planProjection");
  }
  return Object.freeze({ aggregateId, aggregateVersion, plan, payloadChecksum, acceptedBrief, headEvent });
}

function parseNotice(value: unknown): PlanProjectionNotice | null {
  if (value === null) return null;
  const input = strictRecord(value, "planProjection");
  const kind = enumText(input["kind"], ["brief-evidence-unresolved", "write-outcome-unknown", "write-not-recorded"] as const, "planProjection");
  if (kind === "brief-evidence-unresolved") {
    exactKeys(input, ["kind", "reason"], "planProjection");
    return Object.freeze({ kind, reason: enumText(input["reason"], UNRESOLVED_REASONS, "planProjection") });
  }
  if (kind === "write-outcome-unknown") {
    exactKeys(input, ["kind", "state", "operation", "origin", "observationKind"], "planProjection");
    return Object.freeze({
      kind,
      state: enumText(input["state"], UNKNOWN_STATES, "planProjection"),
      operation: enumText(input["operation"], OPERATION_VALUES, "planProjection"),
      origin: enumText(input["origin"], ORIGIN_VALUES, "planProjection"),
      observationKind: enumText(input["observationKind"], ["head", "journal"] as const, "planProjection"),
    });
  }
  exactKeys(input, ["kind", "origin"], "planProjection");
  return Object.freeze({ kind, origin: enumText(input["origin"], ORIGIN_VALUES, "planProjection") });
}

function parseProjectionContext(value: unknown, digest: PlanDigestPort): PlanProjectionContext {
  const input = strictRecord(value, "planProjection");
  exactKeys(input, [
    "computedAt", "sessionState", "planAggregateVersion", "acceptedBrief", "acceptedBriefAggregateId", "currentBrief",
    "unconfirmedAssumptionCount", "openQuestionCount", "notice", "historicalHead",
  ], "planProjection");
  const acceptedBrief = parseAcceptedBriefBinding(input["acceptedBrief"]);
  const currentBrief = input["currentBrief"] === null ? null : parseAcceptedBriefBinding(input["currentBrief"]);
  const historicalHead = input["historicalHead"] === null ? null : parseProjectionHead(input["historicalHead"], digest);
  const notice = parseNotice(input["notice"]);
  const sessionState = enumText(input["sessionState"], PLAN_ASSEMBLY_STATES, "planProjection");
  const planAggregateVersion = safeInteger(input["planAggregateVersion"], "planProjection");
  if (historicalHead !== null && (historicalHead.aggregateVersion !== planAggregateVersion
    || !sameValue(historicalHead.acceptedBrief, acceptedBrief))) {
    refusePlan("PLAN_STORE_CORRUPT", "plan.store.corrupt", "planProjection");
  }
  if (notice?.kind === "write-outcome-unknown" && notice.state !== sessionState) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planProjection");
  }
  if (UNKNOWN_STATES.includes(sessionState as typeof UNKNOWN_STATES[number]) && notice?.kind !== "write-outcome-unknown") {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planProjection");
  }
  return Object.freeze({
    computedAt: timestamp(input["computedAt"], "planProjection"),
    sessionState,
    planAggregateVersion,
    acceptedBrief,
    acceptedBriefAggregateId: planIdentifier(input["acceptedBriefAggregateId"], "project-brief:", "planProjection"),
    currentBrief,
    unconfirmedAssumptionCount: safeInteger(input["unconfirmedAssumptionCount"], "planProjection"),
    openQuestionCount: safeInteger(input["openQuestionCount"], "planProjection"),
    notice,
    historicalHead,
  });
}

function displayOrigin(origin: string, authenticated: boolean): QuotedPlanContent["provenance"] {
  if (origin === "operator" && authenticated) return "operator-confirmed";
  if (origin === "operator-edit" && authenticated) return "operator-edited";
  if (origin === "brief") return "accepted-brief";
  if (origin === "specification") return "specification";
  return "model-proposed";
}

function evidenceKey(kind: "stage" | "task", id: string, path: string, value: string): string {
  return `${kind}|${id}|${path}|${value}`;
}

function isCurrent(context: PlanProjectionContext): boolean {
  return context.currentBrief !== null && sameValue(context.acceptedBrief, context.currentBrief);
}

function action(actionKind: PlanProjectionActionKind, label: string, enabled = true, disabledReason: string | null = null): PlanProjectionAction {
  return Object.freeze({ action: actionKind, label, enabled, disabledReason });
}

function stateActions(plan: ProjectPlan, context: PlanProjectionContext): readonly PlanProjectionAction[] {
  if (["clarifying", "executing", "expanding", "stage_gate", "halted", "completed"].includes(plan.state)) return Object.freeze([]);
  if (context.notice?.kind === "brief-evidence-unresolved") {
    return Object.freeze([action("recheck-brief-evidence", "Recheck brief evidence")]);
  }
  if (context.notice?.kind === "write-outcome-unknown") {
    return Object.freeze([action("check-save-status", "Check save status")]);
  }
  const stale = !isCurrent(context) || context.sessionState === "source-brief-stale"
    || context.notice?.kind === "write-not-recorded" && context.notice.origin === "source-brief-stale";
  if (stale) {
    if (plan.state === "proposed" || plan.state === "sealed") {
      return Object.freeze([
        action("seal", "Seal plan", false, "The accepted brief has moved; rebase before sealing."),
        action("rebase", "Rebase on the current brief"),
        action("discard-stale", "Discard stale plan"),
      ]);
    }
    return plan.state === "drafting" ? Object.freeze([action("rebase", "Rebase on the current brief")]) : Object.freeze([]);
  }
  switch (plan.state) {
    case "drafting": return context.planAggregateVersion === 0
      ? Object.freeze([action("save-draft", "Save draft"), action("cancel", "Cancel")])
      : Object.freeze([action("promote", "Promote for review"), action("abandon", "Abandon draft"), action("record-budget-extension", "Record budget extension")]);
    case "proposed": return Object.freeze([action("seal", "Seal plan"), action("revise", "Propose a revision"), action("record-budget-extension", "Record budget extension")]);
    case "awaiting_scope_approval": return Object.freeze([action("wait-for-c10", "Waiting for scope-approval support"), action("reject-scope", "Reject scope"), action("record-budget-extension", "Record budget extension")]);
    case "sealed": return Object.freeze([action("revise", "Propose a revision")]);
    case "rejected": case "abandoned": case "superseded": return Object.freeze([]);
    default: return Object.freeze([]);
  }
}

function projectedNotice(context: PlanProjectionContext, mode: PlanProjectionMode): Readonly<Record<string, unknown>> | null {
  const notice = context.notice;
  if (notice === null) return null;
  if (notice.kind === "brief-evidence-unresolved") {
    const common = { kind: notice.kind, sentence: "Brief evidence could not be confirmed; nothing was saved." };
    return Object.freeze(mode === "normal" ? common : {
      ...common, reason: notice.reason, ruleId: "plan.store.unresolved", engineOutcome: "brief-evidence-unresolved",
    });
  }
  if (notice.kind === "write-outcome-unknown") {
    const common = { kind: notice.kind, sentence: "Saving could not be confirmed" };
    return Object.freeze(mode === "normal" ? common : {
      ...common, operation: notice.operation, origin: notice.origin, observationKind: notice.observationKind,
    });
  }
  const sentences = {
    "review-required": "Nothing was saved. Your reviewed plan is unchanged.",
    committed: "Nothing was saved. The saved plan is unchanged.",
    "source-brief-stale": "Nothing was saved. The stale plan is unchanged.",
  } as const;
  return Object.freeze({ kind: notice.kind, sentence: sentences[notice.origin] });
}

function commonValue(plan: ProjectPlan, context: PlanProjectionContext, mode: PlanProjectionMode): Readonly<Record<string, unknown>> {
  const briefIsCurrent = isCurrent(context);
  return Object.freeze({
    productionDisabled: !PLAN_PRODUCTION_ENABLED,
    runtimeHandleCount: 0,
    stateTitle: planStateDisplayWord(plan.state),
    confidence: briefIsCurrent ? "current" : "stale",
    computedAt: context.computedAt,
    briefIsCurrent,
    briefVersion: context.acceptedBrief.briefAggregateVersion,
    currentBriefVersion: context.currentBrief?.briefAggregateVersion ?? null,
    unconfirmedAssumptionCount: context.unconfirmedAssumptionCount,
    openQuestionCount: context.openQuestionCount,
    actions: stateActions(plan, context),
    notice: projectedNotice(context, mode),
  });
}

function provenanceLookup(review: PlanReviewEvidence): Readonly<{
  authenticated: ReadonlySet<string>;
  stageProposal: ReadonlyMap<string, PlanReviewEvidence["assemblyRequest"]["proposal"]["stages"][number]>;
  taskProposal: ReadonlyMap<string, PlanReviewEvidence["assemblyRequest"]["proposal"]["tasks"][number]>;
}> {
  return Object.freeze({
    authenticated: new Set(review.authenticatedOperatorEvidence.map((row) => evidenceKey(row.nodeKind, row.nodeId, row.fieldPath, row.value))),
    stageProposal: new Map(review.assemblyRequest.proposal.stages.map((stage) => [stage.stageId, stage])),
    taskProposal: new Map(review.assemblyRequest.proposal.tasks.map((task) => [task.taskId, task])),
  });
}

function dependencyFacts(plan: ProjectPlan): Readonly<{
  depth: ReadonlyMap<string, number>;
  incoming: ReadonlyMap<string, number>;
  outgoing: ReadonlyMap<string, number>;
}> {
  const incoming = new Map(plan.tasks.map((task) => [task.taskId, 0]));
  const outgoing = new Map(plan.tasks.map((task) => [task.taskId, 0]));
  const depth = new Map(plan.tasks.map((task) => [task.taskId, 1]));
  const order = computePlanOrder(plan);
  for (const dependency of plan.dependencies) {
    incoming.set(dependency.toTaskId, (incoming.get(dependency.toTaskId) ?? 0) + 1);
    outgoing.set(dependency.fromTaskId, (outgoing.get(dependency.fromTaskId) ?? 0) + 1);
  }
  for (const taskId of order) {
    for (const edge of plan.dependencies.filter((candidate) => candidate.fromTaskId === taskId && candidate.kind !== "advisory")) {
      depth.set(edge.toTaskId, Math.max(depth.get(edge.toTaskId) ?? 1, (depth.get(taskId) ?? 1) + 1));
    }
  }
  return Object.freeze({ depth, incoming, outgoing });
}

function projectedPlanValue(plan: ProjectPlan, review: PlanReviewEvidence, context: PlanProjectionContext, mode: PlanProjectionMode): Readonly<Record<string, unknown>> {
  const { authenticated, stageProposal, taskProposal } = provenanceLookup(review);
  const taskOrdinal = new Map(plan.tasks.map((task, index) => [task.taskId, index + 1]));
  const facts = dependencyFacts(plan);
  const stages = plan.stages.map((stage) => {
    const proposal = stageProposal.get(stage.stageId);
    if (proposal === undefined) refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.coverage.provenance-inconsistent", "planProjection");
    const wrap = (path: string, text: string): Readonly<Record<string, unknown>> => {
      const evidence = proposal.provenance[path];
      if (evidence === undefined) refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.coverage.provenance-inconsistent", "planProjection");
      const common = {
        text,
        provenance: displayOrigin(evidence.origin, authenticated.has(evidenceKey("stage", stage.stageId, path, text))),
      };
      return Object.freeze(common);
    };
    const taskStates = stage.taskIds.map((id) => plan.tasks.find((task) => task.taskId === id)?.state);
    const common = {
      ordinal: stage.ordinal,
      title: wrap("title", stage.title),
      intent: wrap("intent", stage.intent),
      exitCriteria: Object.freeze(stage.exitCriteria.map((text, index) => wrap(`exitCriteria[${index}]`, text))),
      gate: "Your review is required",
      taskCount: stage.taskIds.length,
      progress: Object.freeze({ completed: taskStates.filter((state) => state === "succeeded").length, total: taskStates.length }),
    };
    return Object.freeze(mode === "normal" ? common : {
      ...common,
      stageId: stage.stageId,
      exitEvidenceKinds: stage.exitEvidenceKinds,
      provenanceAudit: proposal.provenance,
    });
  });
  const tasks = plan.tasks.map((task) => {
    const proposal = taskProposal.get(task.taskId);
    if (proposal === undefined) refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.coverage.provenance-inconsistent", "planProjection");
    const wrap = (path: string, text: string): Readonly<Record<string, unknown>> => {
      const evidence = proposal.provenance[path];
      if (evidence === undefined) refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.coverage.provenance-inconsistent", "planProjection");
      const common = {
        text,
        provenance: displayOrigin(evidence.origin, authenticated.has(evidenceKey("task", task.taskId, path, text))),
      };
      return Object.freeze(common);
    };
    const common = {
      ordinal: taskOrdinal.get(task.taskId),
      stageOrdinal: plan.stages.find((stage) => stage.stageId === task.stageId)?.ordinal,
      title: wrap("title", task.title),
      objective: wrap("objective", task.objective),
      acceptance: Object.freeze(task.acceptance.map((row, index) => Object.freeze({ criterion: wrap(`acceptance[${index}].criterion`, row.criterion) }))),
      state: task.state,
      requirementCount: task.requirementIds.length,
      budget: task.budget,
      approvalBoundOrIrreversible: task.idempotencyClass === "approval-bound" || task.idempotencyClass === "irreversible",
    };
    return Object.freeze(mode === "normal" ? common : {
      ...common,
      taskId: task.taskId,
      stageId: task.stageId,
      requirementIds: task.requirementIds,
      idempotencyClass: task.idempotencyClass,
      workspaceMode: task.workspaceMode,
      expectedOutputSchema: task.expectedOutputSchema,
      retry: task.retry,
      timeout: task.timeout,
      stateRevision: task.stateRevision,
      provenanceAudit: proposal.provenance,
    });
  });
  const dependencies = plan.dependencies.map((dependency) => {
    const common = {
      fromTaskOrdinal: taskOrdinal.get(dependency.fromTaskId),
      toTaskOrdinal: taskOrdinal.get(dependency.toTaskId),
      kind: dependency.kind,
      artifactRequired: dependency.artifactKind !== null,
    };
    return Object.freeze(mode === "normal" ? common : {
      ...common,
      fromTaskId: dependency.fromTaskId,
      toTaskId: dependency.toTaskId,
      artifactKind: dependency.artifactKind,
      fromDepth: facts.depth.get(dependency.fromTaskId),
      toDepth: facts.depth.get(dependency.toTaskId),
      fromDegree: facts.outgoing.get(dependency.fromTaskId),
      toDegree: facts.incoming.get(dependency.toTaskId),
    });
  });
  const common = {
    ...commonValue(plan, context, mode),
    state: plan.state,
    stageCount: plan.stages.length,
    taskCount: plan.tasks.length,
    dangerousTaskCount: plan.tasks.filter((task) => task.idempotencyClass === "approval-bound" || task.idempotencyClass === "irreversible").length,
    stages: Object.freeze(stages),
    tasks: Object.freeze(tasks),
    dependencies: Object.freeze(dependencies),
    dependencyCount: plan.dependencies.length,
    taskOrder: Object.freeze(computePlanOrder(plan).map((taskId) => taskOrdinal.get(taskId))),
    budgetCeiling: plan.budgetCeiling,
  };
  if (mode === "normal") return Object.freeze(common);
  const source = review.assemblyRequest.proposal.source;
  const historical = context.historicalHead?.headEvent.payload;
  return Object.freeze({
    ...common,
    planId: plan.planId,
    projectId: plan.projectId,
    briefId: plan.briefId,
    briefRevision: plan.briefRevision,
    revision: plan.revision,
    supersedes: plan.supersedes,
    planDigest: plan.planDigest,
    specificationRef: plan.specificationRef,
    coverageRef: plan.coverageRef,
    proposalDigest: review.proposalDigest,
    specificationDigest: review.specificationDigest,
    coverageDigest: review.coverageDigest,
    aggregateVersion: context.planAggregateVersion,
    acceptedBriefAggregateId: context.acceptedBriefAggregateId,
    acceptedBrief: context.acceptedBrief,
    narrativeRef: source.kind === "model" ? source.narrativeRef : null,
    proposalSourceAudit: source.kind === "model" ? Object.freeze({
      routeFingerprint: source.routeFingerprint,
      contributionDigest: source.contributionDigest,
      narrativeRef: source.narrativeRef,
      ...(source.adoption === undefined ? {} : { adoption: source.adoption }),
    }) : null,
    constraints: review.constraintDispositions,
    specification: review.specification,
    authenticatedOperatorEvidence: review.authenticatedOperatorEvidence,
    historicalAudit: historical === undefined ? null : Object.freeze({
      evidenceFreshness: "historical-audit-snapshot",
      controls: historical.controls,
      seal: historical.seal,
      decisions: historical.decisions,
    }),
  });
}

export function projectPlanView(
  planValue: unknown,
  reviewValue: unknown,
  mode: PlanProjectionMode,
  contextValue: unknown,
  digest: PlanDigestPort,
): PlanProjectionEnvelope<"plan", Readonly<Record<string, unknown>>> {
  const modeValue = enumText(mode, ["normal", "developer"] as const, "planProjection");
  const plan = canonicalPlan(planValue, digest);
  const review = parsePlanReviewEvidence(reviewValue, digest);
  assertPlanReviewCoherent({ plan, review });
  const context = parseProjectionContext(contextValue, digest);
  if (context.acceptedBrief.projectId !== plan.projectId
    || context.acceptedBrief.briefId !== plan.briefId
    || context.historicalHead !== null && (!sameValue(context.historicalHead.plan, plan)
      || !sameValue(context.historicalHead.headEvent.payload.review, review))) {
    refusePlan("PLAN_STORE_CORRUPT", "plan.store.corrupt", "planProjection");
  }
  const result = Object.freeze({
    mode: modeValue,
    kind: "plan" as const,
    authority: "none" as const,
    commands: PLAN_AVAILABLE_COMMANDS,
    value: projectedPlanValue(plan, review, context, modeValue),
  });
  assertPlanProjectionSafe(result);
  return result;
}

export function projectSealReadinessView(
  verdictsValue: unknown,
  blockingQuestionCountValue: unknown,
  ceilingValue: unknown,
  mode: PlanProjectionMode,
  contextValue: unknown,
  digest: PlanDigestPort,
): PlanProjectionEnvelope<"seal-readiness", Readonly<Record<string, unknown>>> {
  const modeValue = enumText(mode, ["normal", "developer"] as const, "planProjection");
  const verdicts = parsePlanSealVerdicts(verdictsValue);
  const blockingQuestionCount = safeInteger(blockingQuestionCountValue, "planProjection");
  const ceiling = parseResolvedProjectCeilingEvidence(ceilingValue);
  const context = parseProjectionContext(contextValue, digest);
  const audit = context.historicalHead?.headEvent.payload;
  const plan = audit?.plan ?? context.historicalHead?.plan;
  const shared = Object.freeze({
    ...(plan === undefined ? {
      productionDisabled: !PLAN_PRODUCTION_ENABLED,
      runtimeHandleCount: 0,
      confidence: isCurrent(context) ? "current" : "stale",
      computedAt: context.computedAt,
      briefIsCurrent: isCurrent(context),
      briefVersion: context.acceptedBrief.briefAggregateVersion,
      currentBriefVersion: context.currentBrief?.briefAggregateVersion ?? null,
      unconfirmedAssumptionCount: context.unconfirmedAssumptionCount,
      openQuestionCount: context.openQuestionCount,
      actions: Object.freeze([] as const),
      notice: projectedNotice(context, modeValue),
    } : commonValue(plan, context, modeValue)),
    ready: verdicts.every((verdict) => verdict.passed) && blockingQuestionCount === 0 && isCurrent(context),
    blockingQuestionCount,
    failingConditionCount: verdicts.filter((verdict) => !verdict.passed).length,
    conditions: Object.freeze(verdicts.map((verdict) => Object.freeze({
      condition: verdict.condition,
      passed: verdict.passed,
      sentence: conditionSentence(verdict.condition),
      issueCount: verdict.ruleIds.length,
    }))),
  });
  const value = modeValue === "normal" ? shared : Object.freeze({
    ...shared,
    conditions: Object.freeze(verdicts.map((verdict) => Object.freeze({
      condition: verdict.condition,
      passed: verdict.passed,
      sentence: conditionSentence(verdict.condition),
      issueCount: verdict.ruleIds.length,
      ruleIds: verdict.ruleIds,
    }))),
    verdicts,
    ceiling: ceiling.ceiling,
    budgetAccountId: ceiling.budgetAccountId,
    budgetAccountAggregateVersion: ceiling.budgetAccountAggregateVersion,
    budgetAccountStateVersion: ceiling.budgetAccountStateVersion,
    budgetAccountContentDigest: ceiling.budgetAccountContentDigest,
    briefContentDigest: ceiling.briefContentDigest,
    acceptedBriefAggregateId: context.acceptedBriefAggregateId,
    accountMaximumTotalTokens: ceiling.accountMaximumTotalTokens,
    evidenceFreshness: "historical-audit-snapshot",
    controls: audit?.controls ?? null,
    specificationDigest: audit?.review.specificationDigest ?? null,
    coverageDigest: audit?.review.coverageDigest ?? null,
    authenticatedOperatorEvidence: audit?.review.authenticatedOperatorEvidence ?? Object.freeze([]),
    decisions: audit?.decisions ?? Object.freeze([]),
  });
  const result = Object.freeze({ mode: modeValue, kind: "seal-readiness" as const, authority: "none" as const, commands: PLAN_AVAILABLE_COMMANDS, value });
  assertPlanProjectionSafe(result);
  return result;
}

export function projectPlanLineageView(
  headsValue: unknown,
  mode: PlanProjectionMode,
  contextValue: unknown,
  digest: PlanDigestPort,
): PlanProjectionEnvelope<"plan-lineage", Readonly<Record<string, unknown>>> {
  const modeValue = enumText(mode, ["normal", "developer"] as const, "planProjection");
  const heads = strictArray(headsValue, (head) => parseProjectionHead(head, digest), "planProjection", 1, 4_096);
  const context = parseProjectionContext(contextValue, digest);
  if (new Set(heads.map((head) => head.aggregateId)).size !== 1
    || heads.some((head) => head.aggregateId !== context.acceptedBrief.projectId)) {
    refusePlan("PLAN_STORE_CORRUPT", "plan.store.corrupt", "planProjection");
  }
  const lineageNodes: PlanLineageHead[] = [];
  const seenPlanIds = new Set<string>();
  for (let index = 0; index < heads.length; index += 1) {
    const current = heads[index]!;
    const previous = heads[index - 1];
    if (current.plan.planId !== previous?.plan.planId) {
      if (seenPlanIds.has(current.plan.planId)) {
        refusePlan("PLAN_STORE_CORRUPT", "plan.store.corrupt", "planProjection");
      }
      seenPlanIds.add(current.plan.planId);
      lineageNodes.push(current);
    }
    if (previous === undefined) continue;
    const targets = new Set([
      current.plan.supersedes,
      current.headEvent.payload.predecessor?.planId ?? null,
      current.headEvent.payload.rebase?.replaces ?? null,
    ].filter((target): target is string => target !== null));
    if (current.aggregateVersion <= previous.aggregateVersion
      || current.headEvent.globalSequence <= previous.headEvent.globalSequence
      || current.plan.planId !== previous.plan.planId && !targets.has(previous.plan.planId)) {
      refusePlan("PLAN_STORE_CORRUPT", "plan.store.corrupt", "planProjection");
    }
  }
  assertAcyclicPlanChain(lineageNodes.map((head) => ({
    plan: head.plan,
    rebase: head.headEvent.payload.rebase,
    predecessor: head.headEvent.payload.predecessor,
  })));
  const latest = heads[heads.length - 1]!;
  if (context.historicalHead === null || !sameValue(latest, context.historicalHead)) {
    refusePlan("PLAN_STORE_CORRUPT", "plan.store.corrupt", "planProjection");
  }
  const sharedEntries = heads.map((head) => Object.freeze({
    state: head.plan.state,
    stateTitle: planStateDisplayWord(head.plan.state),
    planRevision: head.plan.revision,
    briefVersion: head.acceptedBrief.briefAggregateVersion,
    stageCount: head.plan.stages.length,
    taskCount: head.plan.tasks.length,
    createdAt: head.plan.createdAt,
    updatedAt: head.plan.updatedAt,
  }));
  const common = {
    ...commonValue(latest.plan, context, modeValue),
    entryCount: heads.length,
    entries: Object.freeze(sharedEntries),
  };
  const value = modeValue === "normal" ? Object.freeze(common) : Object.freeze({
    ...common,
    acceptedBriefAggregateId: context.acceptedBriefAggregateId,
    entries: Object.freeze(heads.map((head, index) => Object.freeze({
      ...sharedEntries[index],
      aggregateId: head.aggregateId,
      aggregateVersion: head.aggregateVersion,
      planId: head.plan.planId,
      supersedes: head.plan.supersedes,
      planDigest: head.plan.planDigest,
      acceptedBrief: head.acceptedBrief,
      headEventId: head.headEvent.eventId,
      eventPredecessor: head.headEvent.payload.predecessor,
      replaces: head.headEvent.payload.rebase,
      globalSequence: head.headEvent.globalSequence,
    }))),
  });
  const result = Object.freeze({ mode: modeValue, kind: "plan-lineage" as const, authority: "none" as const, commands: PLAN_AVAILABLE_COMMANDS, value });
  assertPlanProjectionSafe(result);
  return result;
}

function conditionSentence(value: number): string {
  switch (value) {
    case 1: return "The task graph is acyclic.";
    case 2: return "The plan stays within graph and size bounds.";
    case 3: return "Required scope is covered or explicitly waived.";
    case 4: return "Hard constraints are machine-checkable and disposed.";
    case 5: return "The plan stays within the current project ceiling.";
    case 6: return "Material inferred scope has the required approval.";
    default: return "The condition is not recognized.";
  }
}

const SECRET = /(?:\b(?:sk-(?:ant-)?|ghp_|github_pat_|AKIA|xox[baprs]-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----)/u;
const ABSOLUTE_PATH = /(?:^[A-Za-z]:\\|^\\\\|^\/(?!\/))/u;

export function assertPlanProjectionSafe(value: unknown): void {
  const visit = (entry: unknown, key: string | null): void => {
    if (typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
      refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.task.provider-fact", "planProjection");
    }
    if (typeof entry === "string") {
      if (SECRET.test(entry) || (key !== "text" && ABSOLUTE_PATH.test(entry))) {
        refusePlan("PLAN_VALIDATION_REFUSED", "plan.text.suspicious-literal", "planProjection");
      }
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, key);
      return;
    }
    for (const [childKey, child] of Object.entries(entry)) visit(child, childKey);
  };
  visit(value, null);
}
