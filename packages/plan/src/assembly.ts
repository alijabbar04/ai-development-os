import {
  assertPlanDigest,
  parsePlanStage,
  parseProject,
  parseProjectBrief,
  parseProjectPlan,
  parseProjectTask,
  planDigestMaterial,
  serializeCanonicalProjectJson,
  type Dependency,
  type Project,
  type ProjectBrief,
  type ProjectPlan,
  type ProjectTask,
} from "@ai-dev-os/project";
import {
  PLAN_FIXED_HANDOVER,
  PLAN_FIXED_RETRY,
  PLAN_FIXED_TIMEOUT,
  PLAN_LIMITS,
} from "./constants.js";
import type {
  AcceptedBriefHead,
  ClaimProvenance,
  DerivedFromRef,
  PlanAssemblyRequest,
  PlanAssemblyResult,
  PlanDigestPort,
  PlanProvenanceSnapshot,
  PlanRecordCoordinates,
  ProposedStage,
  ProposedTask,
  SpecificationBinding,
} from "./contracts.js";
import { refusePlan } from "./errors.js";
import {
  canonicalPlanValue,
  dependencyKey,
  normalizedProposalMaterial,
  parsePlanAssemblyRequest,
  planDigest,
  sameCanonicalValue,
  taskBudgetComponents,
} from "./validation.js";
import {
  coverageDigestMaterial,
  parseProductSpecificationMirror,
  specificationDigestMaterial,
  transformPlanSpecification,
} from "./specification.js";

function checkedDigest(port: PlanDigestPort, value: unknown, ruleId: string, path: string): string {
  let output: unknown;
  try {
    output = port.sha256(serializeCanonicalProjectJson(value));
  } catch {
    return refusePlan("PLAN_VALIDATION_REFUSED", ruleId, path);
  }
  if (typeof output !== "string" || !/^[a-f0-9]{64}$/u.test(output)) {
    return refusePlan("PLAN_VALIDATION_REFUSED", ruleId, path);
  }
  return output;
}

function checkedTextDigest(port: PlanDigestPort, canonicalText: string, ruleId: string, path: string): string {
  let output: unknown;
  try {
    output = port.sha256(canonicalText);
  } catch {
    return refusePlan("PLAN_VALIDATION_REFUSED", ruleId, path);
  }
  if (typeof output !== "string" || !/^[a-f0-9]{64}$/u.test(output)) {
    return refusePlan("PLAN_VALIDATION_REFUSED", ruleId, path);
  }
  return output;
}

export function computeProposalDigest(requestValue: unknown, digest: PlanDigestPort): string {
  const request = parsePlanAssemblyRequest(requestValue);
  return checkedDigest(digest, normalizedProposalMaterial(request), "plan.proposal.digest-mismatch", "planProposal");
}

export function computeSpecificationDigest(requestValue: unknown, digest: PlanDigestPort): string | null {
  const request = parsePlanAssemblyRequest(requestValue);
  if (request.specificationInput === null) return null;
  const specification = parseProductSpecificationMirror(request.specificationInput.specification);
  return checkedDigest(digest, specificationDigestMaterial(specification), "plan.specification.digest-mismatch", "planSpecification");
}

export function computeCoverageDigest(requestValue: unknown, digest: PlanDigestPort): string | null {
  const request = parsePlanAssemblyRequest(requestValue);
  if (request.specificationInput === null) return null;
  return checkedDigest(digest, coverageDigestMaterial(request.specificationInput), "plan.specification.digest-mismatch", "planCoverage");
}

function referencedBriefText(reference: DerivedFromRef, brief: ProjectBrief): string | null {
  switch (reference.kind) {
    case "brief-objective": return reference.briefId === brief.briefId ? brief.objective : null;
    case "brief-outcome": return reference.briefId === brief.briefId ? brief.outcomes[reference.index] ?? null : null;
    case "brief-non-goal": return reference.briefId === brief.briefId ? brief.nonGoals[reference.index] ?? null : null;
    case "brief-constraint": return reference.briefId === brief.briefId
      ? brief.constraints.find((item) => item.constraintId === reference.constraintId)?.statement ?? null
      : null;
    case "brief-assumption": return reference.briefId === brief.briefId ? brief.assumptions[reference.index]?.text ?? null : null;
    case "requirement": return null;
  }
}

function nodeValues(node: ProposedStage | ProposedTask): Readonly<Record<string, string>> {
  const output = Object.create(null) as Record<string, string>;
  output["title"] = node.title;
  if ("intent" in node) {
    output["intent"] = node.intent;
    node.exitCriteria.forEach((entry, index) => { output[`exitCriteria[${index}]`] = entry; });
  } else {
    output["objective"] = node.objective;
    node.acceptance.forEach((entry, index) => { output[`acceptance[${index}].criterion`] = entry.criterion; });
  }
  return Object.freeze(output);
}

function sourceRequirementTitle(request: PlanAssemblyRequest, reference: DerivedFromRef): string | null {
  if (reference.kind !== "requirement" || request.specificationInput === null) return null;
  const specification = parseProductSpecificationMirror(request.specificationInput.specification);
  if (specification.specificationId !== reference.specificationId) return null;
  return specification.requirements.find((item) => item.requirementId === reference.requirementId)?.title ?? null;
}

function validateProvenanceRow(
  row: ClaimProvenance,
  value: string,
  brief: ProjectBrief,
  specification: SpecificationBinding | null,
  request: PlanAssemblyRequest,
): void {
  if (row.origin === "repository") {
    refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.provenance.fabricated-observation", "planProposal");
  }
  if (row.origin === "model") {
    if (row.derivedFrom !== null || row.verbatim) {
      refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.provenance.model-claims-derivation", "planProposal");
    }
    return;
  }
  if (row.origin === "operator") {
    if (request.proposal.source.kind === "model") {
      refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.provenance.model-claims-derivation", "planProposal");
    }
    if (row.derivedFrom !== null) {
      refusePlan("PLAN_PROVENANCE_REFUSED", "plan.provenance.unresolved", "planProposal");
    }
    return;
  }
  if (row.derivedFrom === null) {
    refusePlan("PLAN_PROVENANCE_REFUSED", "plan.provenance.unresolved", "planProposal");
  }
  const resolved = row.origin === "specification"
    ? sourceRequirementTitle(request, row.derivedFrom)
    : referencedBriefText(row.derivedFrom, brief);
  if (resolved === null) {
    refusePlan("PLAN_PROVENANCE_REFUSED", "plan.provenance.unresolved", "planProposal");
  }
  if (row.origin === "brief" && row.verbatim && resolved !== value) {
    refusePlan("PLAN_PROVENANCE_REFUSED", "plan.provenance.not-verbatim", "planProposal");
  }
}

function validateProvenance(
  request: PlanAssemblyRequest,
  brief: ProjectBrief,
  specification: SpecificationBinding | null,
): PlanProvenanceSnapshot {
  const stages = request.proposal.stages.map((stage) => {
    const values = nodeValues(stage);
    for (const [path, row] of Object.entries(stage.provenance)) {
      validateProvenanceRow(row, values[path] ?? "", brief, specification, request);
    }
    return Object.freeze({ stageId: stage.stageId, fields: stage.provenance });
  });
  const stageOrdinal = new Map(request.proposal.stages.map((stage, index) => [stage.stageId, index]));
  const tasks = [...request.proposal.tasks]
    .sort((left, right) => (stageOrdinal.get(left.stageId) ?? 0) - (stageOrdinal.get(right.stageId) ?? 0) || left.taskId.localeCompare(right.taskId))
    .map((task) => {
      const values = nodeValues(task);
      for (const [path, row] of Object.entries(task.provenance)) {
        validateProvenanceRow(row, values[path] ?? "", brief, specification, request);
      }
      return Object.freeze({ taskId: task.taskId, fields: task.provenance });
    });
  return Object.freeze({ stages: Object.freeze(stages), tasks: Object.freeze(tasks) });
}

function validateAllocations(request: PlanAssemblyRequest): ReadonlyMap<string, ProjectTask["budget"]> {
  const taskIds = new Set(request.proposal.tasks.map((task) => task.taskId));
  if (request.taskBudgetAllocations.length !== taskIds.size
    || request.taskBudgetAllocations.some((item) => !taskIds.has(item.taskId))) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planBudget");
  }
  const ceiling = taskBudgetComponents(request.proposal.budgetCeiling);
  const sums = [0, 0, 0, 0, 0];
  const output = new Map<string, ProjectTask["budget"]>();
  for (const allocation of request.taskBudgetAllocations) {
    const values = taskBudgetComponents(allocation.budget);
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index] ?? 0;
      const maximum = ceiling[index] ?? 0;
      if (value > maximum) refusePlan("PLAN_VALIDATION_REFUSED", "plan.budget.task-exceeds-ceiling", "planBudget");
      const sum = sums[index] ?? 0;
      if (value > maximum - sum) refusePlan("PLAN_VALIDATION_REFUSED", "plan.budget.sum-exceeds-ceiling", "planBudget");
      sums[index] = sum + value;
    }
    output.set(allocation.taskId, allocation.budget);
  }
  return output;
}

function validateConstraints(request: PlanAssemblyRequest, brief: ProjectBrief, taskIds: ReadonlySet<string>): void {
  const briefIds = new Set(brief.constraints.map((constraint) => constraint.constraintId));
  if (request.proposal.constraintDispositions.length !== briefIds.size
    || request.proposal.constraintDispositions.some((item) => !briefIds.has(item.constraintId))) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.constraint.no-disposition", "planConstraint");
  }
  for (const item of request.proposal.constraintDispositions) {
    if (item.taskId !== null && !taskIds.has(item.taskId)) {
      refusePlan("PLAN_VALIDATION_REFUSED", "plan.constraint.no-disposition", "planConstraint");
    }
  }
  for (const constraint of brief.constraints) {
    if (constraint.enforcement !== "hard") continue;
    const form = constraint.machineForm;
    if (form === null || !recognizedMachineForm(constraint.kind, form)) {
      refusePlan("PLAN_VALIDATION_REFUSED", "plan.constraint.machine-form-unrecognised", "planConstraint");
    }
  }
}

function recognizedMachineForm(kind: ProjectBrief["constraints"][number]["kind"], value: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(value).sort();
  if (kind === "budget-money") {
    return sameCanonicalValue(keys, ["currency", "maximumCostMicros"])
      && typeof value["currency"] === "string"
      && /^[A-Z]{3}$/u.test(value["currency"])
      && Number.isSafeInteger(value["maximumCostMicros"])
      && (value["maximumCostMicros"] as number) >= 0;
  }
  if (kind === "budget-tokens") {
    const expected = ["maximumInputTokens", "maximumOutputTokens", "maximumToolCalls", "maximumTurns"].sort();
    return sameCanonicalValue(keys, expected) && expected.every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0);
  }
  return false;
}

export function assertPlanBounds(plan: ProjectPlan): void {
  if (plan.stages.length > PLAN_LIMITS.maxStages) refusePlan("PLAN_BOUND_EXCEEDED", "plan.graph.too-many-stages", "planGraph");
  if (plan.tasks.length > PLAN_LIMITS.maxTasks) refusePlan("PLAN_BOUND_EXCEEDED", "plan.graph.too-many-tasks", "planGraph");
  if (plan.dependencies.length > PLAN_LIMITS.maxDependencies) refusePlan("PLAN_BOUND_EXCEEDED", "plan.graph.too-many-dependencies", "planGraph");
  if (plan.stages.some((stage) => stage.taskIds.length > PLAN_LIMITS.maxTasksPerStage)) {
    refusePlan("PLAN_BOUND_EXCEEDED", "plan.graph.stage-too-large", "planGraph");
  }
  const taskStage = new Map(plan.tasks.map((task) => [task.taskId, task.stageId]));
  const ordinal = new Map(plan.stages.map((stage) => [stage.stageId, stage.ordinal]));
  const endpoints = new Set<string>();
  const incoming = new Map(plan.tasks.map((task) => [task.taskId, 0]));
  const orderingOutgoing = new Map(plan.tasks.map((task) => [task.taskId, [] as string[]]));
  for (const dependency of plan.dependencies) {
    const edge = `${dependency.fromTaskId}|${dependency.toTaskId}`;
    if (endpoints.has(edge)) refusePlan("PLAN_VALIDATION_REFUSED", "plan.graph.parallel-edge", "planGraph");
    endpoints.add(edge);
    const nextIncoming = (incoming.get(dependency.toTaskId) ?? 0) + 1;
    incoming.set(dependency.toTaskId, nextIncoming);
    if (dependency.kind !== "advisory") orderingOutgoing.get(dependency.fromTaskId)?.push(dependency.toTaskId);
    if (nextIncoming > PLAN_LIMITS.maxFanIn) refusePlan("PLAN_BOUND_EXCEEDED", "plan.graph.fan-in", "planGraph");
    const outgoingCount = plan.dependencies.filter((candidate) => candidate.fromTaskId === dependency.fromTaskId).length;
    if (outgoingCount > PLAN_LIMITS.maxFanOut) refusePlan("PLAN_BOUND_EXCEEDED", "plan.graph.fan-out", "planGraph");
    if (dependency.kind !== "advisory") {
      const fromOrdinal = ordinal.get(taskStage.get(dependency.fromTaskId) ?? "") ?? 0;
      const toOrdinal = ordinal.get(taskStage.get(dependency.toTaskId) ?? "") ?? 0;
      if (fromOrdinal > toOrdinal) refusePlan("PLAN_VALIDATION_REFUSED", "plan.graph.stage-order-inconsistent", "planGraph");
    }
  }
  const orderingIndegree = new Map(plan.tasks.map((task) => [task.taskId, 0]));
  for (const dependency of plan.dependencies) {
    if (dependency.kind !== "advisory") orderingIndegree.set(dependency.toTaskId, (orderingIndegree.get(dependency.toTaskId) ?? 0) + 1);
  }
  const depth = new Map(plan.tasks.map((task) => [task.taskId, 1]));
  const queue = plan.tasks.filter((task) => (orderingIndegree.get(task.taskId) ?? 0) === 0).map((task) => task.taskId).sort();
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of orderingOutgoing.get(current) ?? []) {
      depth.set(next, Math.max(depth.get(next) ?? 1, (depth.get(current) ?? 1) + 1));
      if ((depth.get(next) ?? 1) > PLAN_LIMITS.maxDepth) refusePlan("PLAN_BOUND_EXCEEDED", "plan.graph.too-deep", "planGraph");
      const remaining = (orderingIndegree.get(next) ?? 0) - 1;
      orderingIndegree.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }
}

export function computePlanOrder(planValue: unknown): readonly string[] {
  let plan: ProjectPlan;
  try { plan = parseProjectPlan(planValue); }
  catch { return refusePlan("PLAN_SEAL_CONDITION_FAILED", "plan.seal.condition-1", "planGraph", 1); }
  assertPlanBounds(plan);
  const ordinal = new Map(plan.stages.map((stage) => [stage.stageId, stage.ordinal]));
  const task = new Map(plan.tasks.map((item) => [item.taskId, item]));
  const indegree = new Map(plan.tasks.map((item) => [item.taskId, 0]));
  const outgoing = new Map(plan.tasks.map((item) => [item.taskId, [] as string[]]));
  for (const dependency of plan.dependencies) {
    if (dependency.kind === "advisory") continue;
    indegree.set(dependency.toTaskId, (indegree.get(dependency.toTaskId) ?? 0) + 1);
    outgoing.get(dependency.fromTaskId)?.push(dependency.toTaskId);
  }
  const compare = (left: string, right: string): number => {
    const leftTask = task.get(left)!;
    const rightTask = task.get(right)!;
    return (ordinal.get(leftTask.stageId) ?? 0) - (ordinal.get(rightTask.stageId) ?? 0) || left.localeCompare(right);
  };
  const ready = plan.tasks.filter((item) => indegree.get(item.taskId) === 0).map((item) => item.taskId).sort(compare);
  const order: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    order.push(current);
    for (const next of outgoing.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
        ready.sort(compare);
      }
    }
  }
  if (order.length !== plan.tasks.length) {
    return refusePlan("PLAN_SEAL_CONDITION_FAILED", "plan.seal.condition-1", "planGraph", 1);
  }
  return Object.freeze(order);
}

export function assertPlanRecordInvariants(planValue: unknown, digest: PlanDigestPort): ProjectPlan {
  let plan: ProjectPlan;
  try { plan = parseProjectPlan(planValue); }
  catch { return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "plan"); }
  const expectedDigest = checkedTextDigest(digest, planDigestMaterial(plan), "plan.proposal.digest-mismatch", "plan");
  if (plan.planDigest !== expectedDigest) refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.digest-mismatch", "plan");
  const expectedOrdinals = plan.stages.map((_, index) => index + 1);
  if (plan.stages.some((stage, index) => stage.ordinal !== expectedOrdinals[index])) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.stage.ordinal-not-dense", "planStage");
  }
  const stageOrdinal = new Map(plan.stages.map((stage) => [stage.stageId, stage.ordinal]));
  const sortedTasks = [...plan.tasks].sort((left, right) =>
    (stageOrdinal.get(left.stageId) ?? 0) - (stageOrdinal.get(right.stageId) ?? 0) || left.taskId.localeCompare(right.taskId));
  if (!sameCanonicalValue(plan.tasks, sortedTasks) || !sameCanonicalValue(plan.dependencies, sortedDependencies(plan.dependencies))) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "plan");
  }
  if (plan.stages.some((stage) => stage.gate !== "operator-review")) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planStage");
  }
  for (const taskValue of plan.tasks) {
    if (taskValue.state !== "pending" || taskValue.stateRevision !== 1) {
      refusePlan("PLAN_PRECONDITION_REFUSED", "plan.task.not-pending", "planTask");
    }
    if (taskValue.idempotencyClass !== "pure"
      || !sameCanonicalValue(taskValue.retry, PLAN_FIXED_RETRY)
      || !sameCanonicalValue(taskValue.timeout, PLAN_FIXED_TIMEOUT)
      || taskValue.priority !== "normal"
      || taskValue.workloadClass !== "general"
      || !sameCanonicalValue(taskValue.handoverPolicy, PLAN_FIXED_HANDOVER)) {
      refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planTask");
    }
  }
  if (plan.sealedByApprovalId !== null) {
    refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.seal.approval-binding", "planSeal");
  }
  if (["clarifying", "executing", "expanding", "stage_gate", "halted", "completed"].includes(plan.state)) {
    refusePlan("PLAN_OUT_OF_SCOPE", "plan.state.out-of-scope", "plan");
  }
  if (plan.state === "sealed" ? plan.sealedAt === null
    : plan.state === "superseded" ? false
      : plan.sealedAt !== null) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.seal.metadata", "planSeal");
  }
  assertPlanBounds(plan);
  return plan;
}

function sortedDependencies(values: readonly Dependency[]): readonly Dependency[] {
  return Object.freeze([...values].sort((left, right) => dependencyKey(left).localeCompare(dependencyKey(right))));
}

export function assemblePlan(
  requestValue: unknown,
  projectValue: unknown,
  acceptedBrief: AcceptedBriefHead,
  coordinates: PlanRecordCoordinates,
  digest: PlanDigestPort,
): PlanAssemblyResult {
  const request = parsePlanAssemblyRequest(requestValue);
  let project: Project;
  let brief: ProjectBrief;
  try {
    project = parseProject(projectValue);
    brief = parseProjectBrief(acceptedBrief.brief);
  } catch {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "plan");
  }
  if (project.projectId !== request.proposal.projectId || brief.projectId !== project.projectId || request.proposal.briefId !== brief.briefId || acceptedBrief.projectId !== project.projectId) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.project.mismatch", "plan");
  }
  if (coordinates.planId !== request.newPlanId) refusePlan("PLAN_VALIDATION_REFUSED", "plan.lineage.not-successor", "planLineage");
  if (brief.revision !== 1) refusePlan("PLAN_VALIDATION_REFUSED", "plan.brief.revision-not-one", "planBrief");
  const contentDigest = checkedDigest(digest, brief, "plan.brief.content-digest-mismatch", "planBrief");
  if (contentDigest !== acceptedBrief.briefContentDigest) {
    refusePlan("PLAN_STORE_CORRUPT", "plan.brief.content-digest-mismatch", "planBrief");
  }
  const proposalDigest = checkedDigest(digest, normalizedProposalMaterial(request), "plan.proposal.digest-mismatch", "planProposal");
  if (proposalDigest !== request.expectedProposalDigest) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.digest-mismatch", "planProposal");
  }
  let specification: SpecificationBinding | null = null;
  if (request.specificationInput !== null && request.expectedSpecificationDigest !== null && request.expectedCoverageDigest !== null) {
    specification = transformPlanSpecification(
      request.specificationInput,
      request.expectedSpecificationDigest,
      request.expectedCoverageDigest,
      request.proposal.tasks,
      digest,
    );
  }
  const provenance = validateProvenance(request, brief, specification);
  const allocations = validateAllocations(request);
  const taskIds = new Set(request.proposal.tasks.map((task) => task.taskId));
  validateConstraints(request, brief, taskIds);

  const stageOrdinal = new Map(request.proposal.stages.map((stage, index) => [stage.stageId, index + 1]));
  const proposedTaskById = new Map(request.proposal.tasks.map((task) => [task.taskId, task]));
  if (request.proposal.stages.some((stage) => stage.taskIds.some((taskId) => proposedTaskById.get(taskId)?.stageId !== stage.stageId))) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planStage");
  }
  const listedTasks = request.proposal.stages.flatMap((stage) => stage.taskIds);
  if (listedTasks.length !== taskIds.size || new Set(listedTasks).size !== taskIds.size || listedTasks.some((taskId) => !taskIds.has(taskId))) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planStage");
  }

  const stages = request.proposal.stages.map((stage, index) => {
    try {
      return parsePlanStage({
        stageId: stage.stageId,
        ordinal: index + 1,
        title: stage.title,
        intent: stage.intent,
        exitCriteria: stage.exitCriteria,
        exitEvidenceKinds: ["evidence.plan-stage-exit"],
        taskIds: [...stage.taskIds].sort(),
        gate: "operator-review",
      });
    } catch {
      return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planStage");
    }
  });
  const tasks = [...request.proposal.tasks]
    .sort((left, right) => (stageOrdinal.get(left.stageId) ?? 0) - (stageOrdinal.get(right.stageId) ?? 0) || left.taskId.localeCompare(right.taskId))
    .map((task) => {
      const budget = allocations.get(task.taskId);
      if (budget === undefined) return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planBudget");
      try {
        return parseProjectTask({
          taskId: task.taskId,
          stageId: task.stageId,
          title: task.title,
          objective: task.objective,
          requirements: {
            ...task.requirements,
            editScope: "none",
            capabilities: ["reasoning"],
            dataClassification: project.dataClassification,
            expectedInputTokens: null,
            expectedOutputTokens: null,
          },
          requirementIds: [...task.requirementIds].sort(),
          workspaceMode: "none",
          acceptance: task.acceptance,
          expectedOutputSchema: {},
          idempotencyClass: "pure",
          budget,
          retry: PLAN_FIXED_RETRY,
          timeout: PLAN_FIXED_TIMEOUT,
          priority: "normal",
          workloadClass: "general",
          handoverPolicy: PLAN_FIXED_HANDOVER,
          state: "pending",
          stateRevision: 1,
        });
      } catch {
        return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planTask");
      }
    });
  const dependencies = sortedDependencies(request.proposal.dependencies);
  if (coordinates.state === "sealed" && coordinates.sealedAt === null
    || coordinates.state !== "sealed" && coordinates.state !== "superseded" && coordinates.sealedAt !== null) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.seal.metadata", "planSeal");
  }
  const base = {
    schemaVersion: 1 as const,
    planId: coordinates.planId,
    projectId: project.projectId,
    briefId: brief.briefId,
    briefRevision: brief.revision,
    revision: coordinates.revision,
    supersedes: coordinates.supersedes,
    state: coordinates.state,
    stages: Object.freeze(stages),
    tasks: Object.freeze(tasks),
    dependencies,
    specificationRef: specification?.specificationRef ?? null,
    coverageRef: specification?.coverageRef ?? null,
    planDigest: "0".repeat(64),
    sealedAt: coordinates.sealedAt,
    sealedByApprovalId: null,
    budgetCeiling: request.proposal.budgetCeiling,
    origin: "model" as const,
    authority: "none" as const,
    createdAt: coordinates.createdAt,
    updatedAt: coordinates.updatedAt,
  };
  const computedPlanDigest = checkedTextDigest(digest, planDigestMaterial(base), "plan.proposal.digest-mismatch", "plan");
  let plan: ProjectPlan;
  try {
    plan = parseProjectPlan({ ...base, planDigest: computedPlanDigest });
    assertPlanDigest(plan, computedPlanDigest);
  } catch {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "plan");
  }
  assertPlanRecordInvariants(plan, digest);
  const review = Object.freeze({
    assemblyRequest: request,
    proposalDigest,
    specification,
    specificationDigest: request.expectedSpecificationDigest,
    coverageDigest: request.expectedCoverageDigest,
    constraintDispositions: request.proposal.constraintDispositions,
    provenance,
    authenticatedOperatorEvidence: Object.freeze([]),
  });
  return Object.freeze({ plan, review });
}

export function assertPlanReviewCoherent(result: PlanAssemblyResult): void {
  const proposal = result.review.assemblyRequest.proposal;
  const stageOrdinal = new Map(proposal.stages.map((stage, index) => [stage.stageId, index + 1]));
  const expectedStages = proposal.stages.map((stage, index) => Object.freeze({
    stageId: stage.stageId,
    ordinal: index + 1,
    title: stage.title,
    intent: stage.intent,
    exitCriteria: stage.exitCriteria,
    taskIds: Object.freeze([...stage.taskIds].sort()),
  }));
  const actualStages = result.plan.stages.map((stage) => Object.freeze({
    stageId: stage.stageId,
    ordinal: stage.ordinal,
    title: stage.title,
    intent: stage.intent,
    exitCriteria: stage.exitCriteria,
    taskIds: stage.taskIds,
  }));
  const allocations = new Map(result.review.assemblyRequest.taskBudgetAllocations.map((entry) => [entry.taskId, entry.budget]));
  const expectedTasks = [...proposal.tasks]
    .sort((left, right) => (stageOrdinal.get(left.stageId) ?? 0) - (stageOrdinal.get(right.stageId) ?? 0) || left.taskId.localeCompare(right.taskId))
    .map((task) => Object.freeze({
      taskId: task.taskId,
      stageId: task.stageId,
      title: task.title,
      objective: task.objective,
      requirements: task.requirements,
      acceptance: task.acceptance,
      requirementIds: Object.freeze([...task.requirementIds].sort()),
      budget: allocations.get(task.taskId),
    }));
  const actualTasks = result.plan.tasks.map((task) => Object.freeze({
    taskId: task.taskId,
    stageId: task.stageId,
    title: task.title,
    objective: task.objective,
    requirements: Object.freeze({
      kind: task.requirements.kind,
      complexity: task.requirements.complexity,
      risk: task.requirements.risk,
      reasoning: task.requirements.reasoning,
    }),
    acceptance: task.acceptance,
    requirementIds: task.requirementIds,
    budget: task.budget,
  }));
  if (result.plan.planId !== result.review.assemblyRequest.newPlanId
    || result.plan.projectId !== proposal.projectId
    || result.plan.briefId !== proposal.briefId
    || result.plan.planDigest.length !== 64
    || result.review.proposalDigest !== result.review.assemblyRequest.expectedProposalDigest
    || allocations.size !== proposal.tasks.length
    || !sameCanonicalValue(expectedStages, actualStages)
    || !sameCanonicalValue(expectedTasks, actualTasks)
    || !sameCanonicalValue(result.plan.dependencies, sortedDependencies(proposal.dependencies))
    || !sameCanonicalValue(result.plan.budgetCeiling, proposal.budgetCeiling)
    || !sameCanonicalValue(result.review.constraintDispositions, proposal.constraintDispositions)
    || result.plan.specificationRef !== result.review.specification?.specificationRef && result.review.specification !== null
    || result.plan.coverageRef !== result.review.specification?.coverageRef && result.review.specification !== null
    || result.review.specification === null && (result.plan.specificationRef !== null || result.plan.coverageRef !== null)) {
    refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.coverage.provenance-inconsistent", "planCoverage");
  }
}

export function canonicalPlanDigestMaterial(plan: ProjectPlan): string {
  return planDigestMaterial(plan);
}
