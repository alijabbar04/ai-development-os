import { serializeCanonicalProjectJson } from "@ai-dev-os/project";
import { EXECUTABLE_DISPOSITIONS, SCOPE_AUTHORITIES, SCOPE_DISPOSITIONS } from "./constants.js";
import type {
  BoundRequirement,
  PlanDigestPort,
  PlanSpecificationAdapterInput,
  ProposedTask,
  SpecificationBinding,
  UpstreamRequirementProvenance,
} from "./contracts.js";
import { refusePlan } from "./errors.js";
import {
  enumText,
  exactKeys,
  literal,
  planDigest,
  planIdentifier,
  planText,
  parsePlanSpecificationAdapterInput,
  safeInteger,
  strictArray,
  strictRecord,
} from "./validation.js";

const REQUIREMENT_CATEGORIES = Object.freeze([
  "capability", "quality", "risk", "constraint", "unresolved-question",
] as const);

type ParsedSpecification = PlanSpecificationAdapterInput["specification"];
type ParsedCoverage = PlanSpecificationAdapterInput["coverage"][number];

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.specification.incoherent", "planSpecification");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.specification.incoherent", "planSpecification");
  }
  return value;
}

function stringIds(value: unknown, path = "planSpecification"): readonly string[] {
  const values = strictArray(value, (entry) => planIdentifier(entry, "", path), path);
  if (new Set(values).size !== values.length) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.specification.incoherent", path);
  }
  return values;
}

function provenance(value: unknown): UpstreamRequirementProvenance {
  const input = strictRecord(value, "planSpecification");
  exactKeys(input, ["contributionId", "phaseId", "routeKey", "sourceFingerprint", "candidateId"], "planSpecification");
  return Object.freeze({
    contributionId: planIdentifier(input["contributionId"], "", "planSpecification"),
    phaseId: planIdentifier(input["phaseId"], "", "planSpecification"),
    routeKey: planIdentifier(input["routeKey"], "", "planSpecification"),
    sourceFingerprint: planDigest(input["sourceFingerprint"], "planSpecification"),
    candidateId: planIdentifier(input["candidateId"], "", "planSpecification"),
  });
}

function requirement(value: unknown): ParsedSpecification["requirements"][number] {
  const input = strictRecord(value, "planSpecification");
  exactKeys(input, ["requirementId", "requirementDigest", "title", "category", "disposition", "decisionId", "candidateIds", "provenance", "dissentIds"], "planSpecification");
  const rows = strictArray(input["provenance"], provenance, "planSpecification");
  const rowKeys = rows.map((row) => `${row.contributionId}|${row.phaseId}|${row.routeKey}|${row.sourceFingerprint}|${row.candidateId}`);
  if (new Set(rowKeys).size !== rowKeys.length) refusePlan("PLAN_VALIDATION_REFUSED", "plan.specification.incoherent", "planSpecification");
  return Object.freeze({
    requirementId: planIdentifier(input["requirementId"], "", "planSpecification"),
    requirementDigest: planDigest(input["requirementDigest"], "planSpecification"),
    title: planText(input["title"], "planSpecification", 4_000),
    category: enumText(input["category"], REQUIREMENT_CATEGORIES, "planSpecification"),
    disposition: enumText(input["disposition"], SCOPE_DISPOSITIONS, "planSpecification"),
    decisionId: planIdentifier(input["decisionId"], "", "planSpecification"),
    candidateIds: stringIds(input["candidateIds"]),
    provenance: rows,
    dissentIds: stringIds(input["dissentIds"]),
  });
}

export function parseProductSpecificationMirror(value: unknown): ParsedSpecification {
  const input = strictRecord(value, "planSpecification");
  exactKeys(input, ["schemaVersion", "specificationId", "planId", "planVersion", "intentDigest", "decisionSetDigest", "requirements", "findingIds", "questionIds", "dissentIds", "approvedBy", "approvalReference", "approvedAt", "approvalDigest"], "planSpecification");
  literal(input["schemaVersion"], 1, "planSpecification");
  const approver = strictRecord(input["approvedBy"], "planSpecification");
  exactKeys(approver, ["actorId", "authority"], "planSpecification");
  const requirements = strictArray(input["requirements"], requirement, "planSpecification");
  const requirementIds = requirements.map((item) => item.requirementId);
  if (new Set(requirementIds).size !== requirementIds.length) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.specification.incoherent", "planSpecification");
  }
  const planVersion = safeInteger(input["planVersion"], "planSpecification");
  if (planVersion < 1) refusePlan("PLAN_VALIDATION_REFUSED", "plan.specification.incoherent", "planSpecification");
  return Object.freeze({
    schemaVersion: 1,
    specificationId: planIdentifier(input["specificationId"], "product-specification:", "planSpecification"),
    planId: planIdentifier(input["planId"], "", "planSpecification"),
    planVersion,
    intentDigest: planDigest(input["intentDigest"], "planSpecification"),
    decisionSetDigest: planDigest(input["decisionSetDigest"], "planSpecification"),
    requirements,
    findingIds: stringIds(input["findingIds"]),
    questionIds: stringIds(input["questionIds"]),
    dissentIds: stringIds(input["dissentIds"]),
    approvedBy: Object.freeze({
      actorId: planIdentifier(approver["actorId"], "", "planSpecification"),
      authority: enumText(approver["authority"], SCOPE_AUTHORITIES, "planSpecification"),
    }),
    approvalReference: planIdentifier(input["approvalReference"], "", "planSpecification"),
    approvedAt: timestamp(input["approvedAt"]),
    approvalDigest: planDigest(input["approvalDigest"], "planSpecification"),
  });
}

export function parseRequirementTaskCoverageMirror(value: unknown): ParsedCoverage {
  const input = strictRecord(value, "planCoverage");
  exactKeys(input, ["requirementId", "requirementDigest", "decisionId", "disposition", "executable", "taskId"], "planCoverage");
  if (typeof input["executable"] !== "boolean") {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.specification.incoherent", "planCoverage");
  }
  return Object.freeze({
    requirementId: planIdentifier(input["requirementId"], "", "planCoverage"),
    requirementDigest: planDigest(input["requirementDigest"], "planCoverage"),
    decisionId: planIdentifier(input["decisionId"], "", "planCoverage"),
    disposition: enumText(input["disposition"], SCOPE_DISPOSITIONS, "planCoverage"),
    executable: input["executable"],
    taskId: input["taskId"] === null ? null : planIdentifier(input["taskId"], "requirement-task:", "planCoverage"),
  });
}

function coverageCompare(left: ParsedCoverage, right: ParsedCoverage): number {
  return left.requirementId.localeCompare(right.requirementId)
    || left.requirementDigest.localeCompare(right.requirementDigest)
    || left.decisionId.localeCompare(right.decisionId)
    || left.disposition.localeCompare(right.disposition)
    || (left.taskId ?? "").localeCompare(right.taskId ?? "");
}

export function specificationDigestMaterial(specification: ParsedSpecification): Readonly<{ schemaVersion: 1; specification: ParsedSpecification }> {
  return Object.freeze({ schemaVersion: 1, specification });
}

export function coverageDigestMaterial(input: PlanSpecificationAdapterInput): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: 1,
    coverage: Object.freeze([...input.coverage].sort(coverageCompare)),
    taskIdMap: Object.freeze([...input.taskIdMap].sort((left, right) => left.upstreamTaskId.localeCompare(right.upstreamTaskId))),
    waiverBindings: Object.freeze([...input.waiverBindings].sort((left, right) => left.requirementId.localeCompare(right.requirementId))),
  });
}

export function transformPlanSpecification(
  value: PlanSpecificationAdapterInput,
  expectedSpecificationDigest: string,
  expectedCoverageDigest: string,
  tasks: readonly ProposedTask[],
  digest: PlanDigestPort,
): SpecificationBinding {
  const parsedInput = parsePlanSpecificationAdapterInput(value);
  const specification = parseProductSpecificationMirror(parsedInput.specification);
  const coverage = parsedInput.coverage.map(parseRequirementTaskCoverageMirror);
  const checkedInput = Object.freeze({ ...parsedInput, specification, coverage });
  let specificationDigest: string;
  let coverageDigest: string;
  try {
    specificationDigest = planDigest(
      digest.sha256(serializeCanonicalProjectJson(specificationDigestMaterial(specification))),
      "planSpecification",
    );
    coverageDigest = planDigest(
      digest.sha256(serializeCanonicalProjectJson(coverageDigestMaterial(checkedInput))),
      "planCoverage",
    );
  } catch {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.specification.digest-mismatch", "planSpecification");
  }
  if (specificationDigest !== expectedSpecificationDigest || coverageDigest !== expectedCoverageDigest) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.specification.digest-mismatch", "planSpecification");
  }

  if (coverage.length !== specification.requirements.length) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.specification.incoherent", "planCoverage");
  }
  const byRequirement = new Map(coverage.map((item) => [item.requirementId, item]));
  if (byRequirement.size !== coverage.length) refusePlan("PLAN_VALIDATION_REFUSED", "plan.specification.incoherent", "planCoverage");
  const taskMap = new Map(parsedInput.taskIdMap.map((item) => [item.upstreamTaskId, item.planTaskId]));
  if (taskMap.size !== parsedInput.taskIdMap.length || new Set(parsedInput.taskIdMap.map((item) => item.planTaskId)).size !== parsedInput.taskIdMap.length) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.coverage.unmapped-task", "planCoverage");
  }
  const waiverMap = new Map(parsedInput.waiverBindings.map((item) => [item.requirementId, item.waiverDecisionId]));
  if (waiverMap.size !== parsedInput.waiverBindings.length) refusePlan("PLAN_VALIDATION_REFUSED", "plan.coverage.waiver-unbound", "planCoverage");
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const usedUpstream = new Set<string>();
  const usedWaivers = new Set<string>();

  const requirements: BoundRequirement[] = specification.requirements.map((source) => {
    const row = byRequirement.get(source.requirementId);
    if (row === undefined
      || row.requirementDigest !== source.requirementDigest
      || row.decisionId !== source.decisionId
      || row.disposition !== source.disposition) {
      return refusePlan("PLAN_VALIDATION_REFUSED", "plan.specification.incoherent", "planCoverage");
    }
    const executable = (EXECUTABLE_DISPOSITIONS as readonly string[]).includes(source.disposition);
    if (row.executable !== executable) {
      refusePlan("PLAN_VALIDATION_REFUSED", "plan.coverage.executable-mismatch", "planCoverage");
    }
    if (!executable && row.taskId !== null) {
      refusePlan("PLAN_VALIDATION_REFUSED", "plan.coverage.non-executable-covered", "planCoverage");
    }
    let taskId: string | null = null;
    if (row.taskId !== null) {
      taskId = taskMap.get(row.taskId) ?? null;
      if (taskId === null || !taskById.has(taskId)) {
        refusePlan("PLAN_VALIDATION_REFUSED", "plan.coverage.unmapped-task", "planCoverage");
      }
      usedUpstream.add(row.taskId);
      if (!taskById.get(taskId)?.requirementIds.includes(source.requirementId)) {
        refusePlan("PLAN_VALIDATION_REFUSED", "plan.coverage.unmapped-task", "planCoverage");
      }
    }
    const waiverDecisionId = waiverMap.get(source.requirementId) ?? null;
    if (waiverDecisionId !== null) usedWaivers.add(source.requirementId);
    if (source.disposition === "waived" && (taskId !== null || waiverDecisionId === null)) {
      refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.coverage.waiver-unbound", "planCoverage");
    }
    if (source.disposition !== "waived" && waiverDecisionId !== null) {
      refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.coverage.waiver-unbound", "planCoverage");
    }
    return Object.freeze({
      requirementId: source.requirementId,
      requirementDigest: source.requirementDigest,
      decisionId: source.decisionId,
      disposition: source.disposition,
      sourceProvenance: source.provenance,
      executable,
      upstreamTaskId: row.taskId,
      taskId,
      waiverDecisionId,
    });
  });

  if (usedUpstream.size !== parsedInput.taskIdMap.length || usedWaivers.size !== parsedInput.waiverBindings.length) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.coverage.unmapped-task", "planCoverage");
  }
  for (const task of tasks) {
    if (task.requirementIds.length > 0 && !requirements.some((requirement) => requirement.taskId === task.taskId)) {
      refusePlan("PLAN_VALIDATION_REFUSED", "plan.coverage.unmapped-task", "planCoverage");
    }
  }

  return Object.freeze({
    specificationId: specification.specificationId,
    upstreamPlanId: specification.planId,
    upstreamPlanVersion: specification.planVersion,
    intentDigest: specification.intentDigest,
    decisionSetDigest: specification.decisionSetDigest,
    approvedBy: specification.approvedBy,
    approvalReference: specification.approvalReference,
    approvedAt: specification.approvedAt,
    approvalDigest: specification.approvalDigest,
    specificationRef: `spec:${expectedSpecificationDigest.slice(0, 32)}`,
    coverageRef: `coverage:${expectedCoverageDigest.slice(0, 32)}`,
    requirements: Object.freeze(requirements),
  });
}
