import {
  canonicalizeProjectJson,
  parseDependency,
  serializeCanonicalProjectJson,
  type Dependency,
  type ProjectPlan,
  type ProjectTask,
} from "@ai-dev-os/project";
import {
  CONSTRAINT_DISPOSITIONS,
  PLAN_LIMITS,
  SCOPE_AUTHORITIES,
  SCOPE_DISPOSITIONS,
} from "./constants.js";
import type {
  AuthenticatedOperatorClaimEvidence,
  ClaimProvenance,
  ConstraintDisposition,
  DerivedFromRef,
  PlanAssemblyRequest,
  PlanProposal,
  PlanProposalSource,
  PlanSpecificationAdapterInput,
  PlanTaskIdBinding,
  PlanWaiverBinding,
  ProposedStage,
  ProposedTask,
  ProposedTaskRequirements,
  TaskBudgetAllocation,
} from "./contracts.js";
import { refusePlan } from "./errors.js";

export type StrictRecord = Readonly<Record<string, unknown>>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const NARRATIVE_REF = /^nar:[a-f0-9]{64}$/u;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/u;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/u;
const SUSPICIOUS = /(?:\b(?:https?|file):\/\/|(?:^|[\s("'])\/(?:[^/\s][^\s]*)|(?:^|[\s("'])[A-Za-z]:\\|\\\\|\b(?:sk-(?:ant-)?|ghp_|github_pat_|AKIA|xox[baprs]-)[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----)/u;
const TASK_KINDS = Object.freeze(["plan", "architecture", "implement", "refactor", "debug", "review", "test", "document", "shell", "explain", "transform"] as const);
const TASK_RISKS = Object.freeze(["low", "medium", "high", "critical"] as const);
const REASONING = Object.freeze(["low", "medium", "high", "extreme"] as const);

function ownDescriptors(value: object): PropertyDescriptorMap {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planProposal");
  }
}

export function strictRecord(value: unknown, path = "planProposal"): StrictRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  let prototype: object | null;
  let symbols: readonly symbol[];
  try {
    prototype = Object.getPrototypeOf(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  if ((prototype !== Object.prototype && prototype !== null) || symbols.length !== 0) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(ownDescriptors(value))) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
    }
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

export function exactKeys(
  value: StrictRecord,
  keys: readonly string[],
  path = "planProposal",
  extraRule: "plan.proposal.unknown-field" | "plan.proposal.malformed" = "plan.proposal.malformed",
): void {
  const actual = Object.keys(value);
  if (actual.some((key) => !keys.includes(key))) {
    refusePlan("PLAN_VALIDATION_REFUSED", extraRule, path);
  }
  if (keys.some((key) => !Object.hasOwn(value, key))) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
}

export function strictArray<T>(
  value: unknown,
  parse: (entry: unknown, index: number) => T,
  path = "planProposal",
  minimum = 0,
  maximum = 1_024,
): readonly T[] {
  if (!Array.isArray(value)) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  let prototype: object | null;
  let symbols: readonly symbol[];
  try {
    prototype = Object.getPrototypeOf(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  if (prototype !== Array.prototype || symbols.length !== 0) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  const descriptors = ownDescriptors(value);
  const lengthDescriptor = descriptors["length"];
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  const length = lengthDescriptor.value as number;
  if (length < minimum || length > maximum || Object.keys(descriptors).length !== length + 1) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  const output: T[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
    }
    output.push(parse(descriptor.value, index));
  }
  return Object.freeze(output);
}

function inspectedArrayLength(value: unknown, path: string): number | null {
  if (!Array.isArray(value)) return null;
  let prototype: object | null;
  let symbols: readonly symbol[];
  try {
    prototype = Object.getPrototypeOf(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  if (prototype !== Array.prototype || symbols.length !== 0) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  const descriptor = ownDescriptors(value)["length"];
  if (descriptor === undefined || !("value" in descriptor) || !Number.isSafeInteger(descriptor.value)) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  return descriptor.value as number;
}

export function planText(value: unknown, path = "planText", maximum = 16_384): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.normalize("NFC") || CONTROL.test(value)) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  if (BIDI.test(value)) refusePlan("PLAN_VALIDATION_REFUSED", "plan.text.bidi", "planText");
  return value;
}

export function quotedPlanText(value: unknown, path = "planText", maximum = 16_384): string {
  const parsed = planText(value, path, maximum);
  if (SUSPICIOUS.test(parsed)) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.text.suspicious-literal", "planText");
  }
  return parsed;
}

export function planIdentifier(value: unknown, prefix: string, path = "planProposal"): string {
  const parsed = planText(value, path, 128);
  if (!ID.test(parsed) || !parsed.startsWith(prefix)) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  return parsed;
}

export function planDigest(value: unknown, path = "planProposal"): string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  return value;
}

export function safeInteger(value: unknown, path = "planProposal", maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  return value as number;
}

export function literal<T extends string | number>(value: unknown, expected: T, path: string): T {
  if (value !== expected) return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  return expected;
}

export function enumText<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  return value as T;
}

export function parsePlanBudget(value: unknown, path = "planBudget"): ProjectPlan["budgetCeiling"] {
  const input = strictRecord(value, path);
  exactKeys(input, ["maximumInputTokens", "maximumOutputTokens", "maximumCostMicros", "maximumToolCalls", "maximumTurns"], path);
  return Object.freeze({
    maximumInputTokens: safeInteger(input["maximumInputTokens"], path, 1_000_000_000_000),
    maximumOutputTokens: safeInteger(input["maximumOutputTokens"], path, 1_000_000_000_000),
    maximumCostMicros: safeInteger(input["maximumCostMicros"], path),
    maximumToolCalls: safeInteger(input["maximumToolCalls"], path, 100_000),
    maximumTurns: safeInteger(input["maximumTurns"], path, 100_000),
  });
}

function parseDerivedFrom(value: unknown, path: string): DerivedFromRef {
  const input = strictRecord(value, path);
  const kind = enumText(input["kind"], ["brief-objective", "brief-outcome", "brief-non-goal", "brief-constraint", "brief-assumption", "requirement"] as const, path);
  switch (kind) {
    case "brief-objective":
      exactKeys(input, ["kind", "briefId"], path);
      return Object.freeze({ kind, briefId: planIdentifier(input["briefId"], "brf:", path) });
    case "brief-outcome": case "brief-non-goal": case "brief-assumption":
      exactKeys(input, ["kind", "briefId", "index"], path);
      return Object.freeze({ kind, briefId: planIdentifier(input["briefId"], "brf:", path), index: safeInteger(input["index"], path, 1_023) });
    case "brief-constraint":
      exactKeys(input, ["kind", "briefId", "constraintId"], path);
      return Object.freeze({ kind, briefId: planIdentifier(input["briefId"], "brf:", path), constraintId: planIdentifier(input["constraintId"], "", path) });
    case "requirement":
      exactKeys(input, ["kind", "specificationId", "requirementId"], path);
      return Object.freeze({
        kind,
        specificationId: planIdentifier(input["specificationId"], "product-specification:", path),
        requirementId: planIdentifier(input["requirementId"], "", path),
      });
  }
}

function parseProvenance(value: unknown, path: string): ClaimProvenance {
  const input = strictRecord(value, path);
  exactKeys(input, ["origin", "derivedFrom", "verbatim"], path);
  const origin = enumText(input["origin"], ["operator", "brief", "specification", "repository", "model"] as const, path);
  const derivedFrom = input["derivedFrom"] === null ? null : parseDerivedFrom(input["derivedFrom"], path);
  if (typeof input["verbatim"] !== "boolean") return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  if (origin === "repository") refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.provenance.fabricated-observation", path);
  if (origin === "model" && (derivedFrom !== null || input["verbatim"] !== false)) {
    refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.provenance.model-claims-derivation", path);
  }
  if (origin === "brief" && (derivedFrom === null || !derivedFrom.kind.startsWith("brief-"))) {
    refusePlan("PLAN_PROVENANCE_REFUSED", "plan.provenance.unresolved", path);
  }
  if (origin === "specification" && derivedFrom?.kind !== "requirement") {
    refusePlan("PLAN_PROVENANCE_REFUSED", "plan.provenance.unresolved", path);
  }
  return Object.freeze({ origin, derivedFrom, verbatim: input["verbatim"] });
}

function parseProvenanceMap(value: unknown, required: readonly string[], path: string): Readonly<Record<string, ClaimProvenance>> {
  const input = strictRecord(value, path);
  const keys = Object.keys(input);
  if (keys.some((key) => !required.includes(key))) {
    refusePlan("PLAN_PROVENANCE_REFUSED", "plan.provenance.unknown-path", path);
  }
  if (required.some((key) => !Object.hasOwn(input, key))) {
    refusePlan("PLAN_PROVENANCE_REFUSED", "plan.provenance.missing", path);
  }
  const output = Object.create(null) as Record<string, ClaimProvenance>;
  for (const key of required) output[key] = parseProvenance(input[key], path);
  return Object.freeze(output);
}

function parseSource(value: unknown): PlanProposalSource {
  const input = strictRecord(value, "planProposal");
  const kind = enumText(input["kind"], ["operator", "model", "deterministic"] as const, "planProposal");
  if (kind === "operator") {
    exactKeys(input, ["kind", "authority"], "planProposal", "plan.proposal.unknown-field");
    return Object.freeze({ kind, authority: literal(input["authority"], "none", "planProposal") });
  }
  if (kind === "deterministic") {
    exactKeys(input, ["kind", "authority", "generatorId"], "planProposal", "plan.proposal.unknown-field");
    return Object.freeze({
      kind,
      authority: literal(input["authority"], "none", "planProposal"),
      generatorId: planIdentifier(input["generatorId"], "", "planProposal"),
    });
  }
  exactKeys(input, ["kind", "authority", "routeFingerprint", "contributionDigest", "narrativeRef"], "planProposal", "plan.proposal.unknown-field");
  const narrativeRef = input["narrativeRef"];
  if (narrativeRef !== null && (typeof narrativeRef !== "string" || !NARRATIVE_REF.test(narrativeRef))) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planProposal");
  }
  return Object.freeze({
    kind,
    authority: literal(input["authority"], "none", "planProposal"),
    routeFingerprint: planDigest(input["routeFingerprint"], "planProposal"),
    contributionDigest: planDigest(input["contributionDigest"], "planProposal"),
    narrativeRef,
  });
}

function parseProposedStage(value: unknown): ProposedStage {
  const input = strictRecord(value, "planStage");
  exactKeys(input, ["stageId", "title", "intent", "exitCriteria", "taskIds", "provenance"], "planStage", "plan.proposal.unknown-field");
  const exitCriteria = strictArray(input["exitCriteria"], (entry) => quotedPlanText(entry, "planText"), "planStage", 1);
  const requiredPaths = ["title", "intent", ...exitCriteria.map((_, index) => `exitCriteria[${index}]`)] as const;
  return Object.freeze({
    stageId: planIdentifier(input["stageId"], "stg:", "planStage"),
    title: quotedPlanText(input["title"], "planText", 512),
    intent: quotedPlanText(input["intent"], "planText"),
    exitCriteria,
    taskIds: uniqueStrings(strictArray(input["taskIds"], (entry) => planIdentifier(entry, "tsk:", "planStage"), "planStage", 1), "planStage"),
    provenance: parseProvenanceMap(input["provenance"], requiredPaths, "planStage"),
  });
}

function parseRequirements(value: unknown): ProposedTaskRequirements {
  const input = strictRecord(value, "planTask");
  exactKeys(input, ["kind", "complexity", "risk", "reasoning"], "planTask", "plan.proposal.unknown-field");
  const complexity = safeInteger(input["complexity"], "planTask", 5);
  if (complexity < 1) return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planTask");
  return Object.freeze({
    kind: enumText(input["kind"], TASK_KINDS, "planTask"),
    complexity: complexity as ProposedTaskRequirements["complexity"],
    risk: enumText(input["risk"], TASK_RISKS, "planTask"),
    reasoning: enumText(input["reasoning"], REASONING, "planTask"),
  });
}

function parseProposedTask(value: unknown): ProposedTask {
  const input = strictRecord(value, "planTask");
  exactKeys(input, ["taskId", "stageId", "title", "objective", "requirements", "acceptance", "requirementIds", "provenance"], "planTask", "plan.proposal.unknown-field");
  const acceptance = strictArray(input["acceptance"], (entry) => {
    const item = strictRecord(entry, "planTask");
    exactKeys(item, ["criterion", "validationCommand"], "planTask", "plan.proposal.unknown-field");
    const command = item["validationCommand"] === null ? null : strictArray(
      item["validationCommand"],
      (argument) => planText(argument, "planTask", 32_768),
      "planTask",
      1,
      256,
    );
    return Object.freeze({ criterion: quotedPlanText(item["criterion"], "planText"), validationCommand: command });
  }, "planTask", 1);
  const requiredPaths = ["title", "objective", ...acceptance.map((_, index) => `acceptance[${index}].criterion`)] as const;
  return Object.freeze({
    taskId: planIdentifier(input["taskId"], "tsk:", "planTask"),
    stageId: planIdentifier(input["stageId"], "stg:", "planTask"),
    title: quotedPlanText(input["title"], "planText", 512),
    objective: quotedPlanText(input["objective"], "planText"),
    requirements: parseRequirements(input["requirements"]),
    acceptance,
    requirementIds: uniqueStrings(strictArray(input["requirementIds"], (entry) => planIdentifier(entry, "", "planTask"), "planTask"), "planTask"),
    provenance: parseProvenanceMap(input["provenance"], requiredPaths, "planTask"),
  });
}

function parseConstraintDisposition(value: unknown): ConstraintDisposition {
  const input = strictRecord(value, "planConstraint");
  exactKeys(input, ["constraintId", "disposition", "taskId", "waiverDecisionId"], "planConstraint");
  const disposition = enumText(input["disposition"], CONSTRAINT_DISPOSITIONS, "planConstraint");
  const taskId = input["taskId"] === null ? null : planIdentifier(input["taskId"], "tsk:", "planConstraint");
  const waiverDecisionId = input["waiverDecisionId"] === null ? null : planIdentifier(input["waiverDecisionId"], "dec:", "planConstraint");
  if ((disposition === "enforced-by-task") !== (taskId !== null) || (disposition === "waived-by-decision") !== (waiverDecisionId !== null)) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planConstraint");
  }
  return Object.freeze({
    constraintId: planIdentifier(input["constraintId"], "", "planConstraint"),
    disposition,
    taskId,
    waiverDecisionId,
  });
}

function uniqueStrings(values: readonly string[], path: string, rule = "plan.proposal.malformed"): readonly string[] {
  if (new Set(values).size !== values.length) refusePlan("PLAN_VALIDATION_REFUSED", rule, path);
  return values;
}

export function parsePlanProposal(value: unknown): PlanProposal {
  const input = strictRecord(value, "planProposal");
  exactKeys(input, ["schemaVersion", "projectId", "briefId", "source", "stages", "tasks", "dependencies", "budgetCeiling", "constraintDispositions"], "planProposal", "plan.proposal.unknown-field");
  literal(input["schemaVersion"], 1, "planProposal");
  if ((inspectedArrayLength(input["stages"], "planProposal") ?? 0) > PLAN_LIMITS.maxStages) {
    refusePlan("PLAN_BOUND_EXCEEDED", "plan.graph.too-many-stages", "planGraph");
  }
  if ((inspectedArrayLength(input["tasks"], "planProposal") ?? 0) > PLAN_LIMITS.maxTasks) {
    refusePlan("PLAN_BOUND_EXCEEDED", "plan.graph.too-many-tasks", "planGraph");
  }
  if ((inspectedArrayLength(input["dependencies"], "planProposal") ?? 0) > PLAN_LIMITS.maxDependencies) {
    refusePlan("PLAN_BOUND_EXCEEDED", "plan.graph.too-many-dependencies", "planGraph");
  }
  const source = parseSource(input["source"]);
  const stages = strictArray(input["stages"], parseProposedStage, "planProposal", 1, PLAN_LIMITS.maxStages);
  const tasks = strictArray(input["tasks"], parseProposedTask, "planProposal", 1, PLAN_LIMITS.maxTasks);
  uniqueStrings(stages.map((stage) => stage.stageId), "planStage");
  uniqueStrings(tasks.map((task) => task.taskId), "planTask");
  if (source.kind === "model" && [...stages.flatMap((stage) => Object.values(stage.provenance)), ...tasks.flatMap((task) => Object.values(task.provenance))].some((row) => row.origin === "operator")) {
    refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.provenance.model-claims-derivation", "planProposal");
  }
  const dependencies = strictArray(input["dependencies"], (entry) => {
    try { return parseDependency(entry); }
    catch { return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planDependency"); }
  }, "planDependency", 0, PLAN_LIMITS.maxDependencies);
  const constraintDispositions = strictArray(input["constraintDispositions"], parseConstraintDisposition, "planConstraint");
  uniqueStrings(constraintDispositions.map((item) => item.constraintId), "planConstraint");
  return Object.freeze({
    schemaVersion: 1,
    projectId: planIdentifier(input["projectId"], "prj:", "planProposal"),
    briefId: planIdentifier(input["briefId"], "brf:", "planProposal"),
    source,
    stages,
    tasks,
    dependencies,
    budgetCeiling: parsePlanBudget(input["budgetCeiling"]),
    constraintDispositions,
  });
}

export function parseTaskBudgetAllocation(value: unknown): TaskBudgetAllocation {
  const input = strictRecord(value, "planBudget");
  exactKeys(input, ["taskId", "budget"], "planBudget");
  return Object.freeze({ taskId: planIdentifier(input["taskId"], "tsk:", "planBudget"), budget: parsePlanBudget(input["budget"]) });
}

export function parsePlanTaskIdBinding(value: unknown): PlanTaskIdBinding {
  const input = strictRecord(value, "planSpecification");
  exactKeys(input, ["upstreamTaskId", "planTaskId"], "planSpecification");
  return Object.freeze({
    upstreamTaskId: planIdentifier(input["upstreamTaskId"], "requirement-task:", "planSpecification"),
    planTaskId: planIdentifier(input["planTaskId"], "tsk:", "planSpecification"),
  });
}

export function parsePlanWaiverBinding(value: unknown): PlanWaiverBinding {
  const input = strictRecord(value, "planSpecification");
  exactKeys(input, ["requirementId", "waiverDecisionId"], "planSpecification");
  return Object.freeze({
    requirementId: planIdentifier(input["requirementId"], "", "planSpecification"),
    waiverDecisionId: planIdentifier(input["waiverDecisionId"], "dec:", "planSpecification"),
  });
}

export function parsePlanSpecificationAdapterInput(value: unknown): PlanSpecificationAdapterInput {
  const input = strictRecord(value, "planSpecification");
  exactKeys(input, ["schemaVersion", "specification", "coverage", "taskIdMap", "waiverBindings"], "planSpecification");
  literal(input["schemaVersion"], 1, "planSpecification");
  const coverage = strictArray(input["coverage"], (entry) => canonicalizeProjectJson(entry) as unknown as PlanSpecificationAdapterInput["coverage"][number], "planCoverage");
  const taskIdMap = strictArray(input["taskIdMap"], parsePlanTaskIdBinding, "planSpecification");
  const waiverBindings = strictArray(input["waiverBindings"], parsePlanWaiverBinding, "planSpecification");
  uniqueStrings(taskIdMap.map((item) => item.upstreamTaskId), "planSpecification");
  uniqueStrings(taskIdMap.map((item) => item.planTaskId), "planSpecification");
  uniqueStrings(waiverBindings.map((item) => item.requirementId), "planSpecification");
  return Object.freeze({
    schemaVersion: 1,
    specification: canonicalizeProjectJson(input["specification"]) as unknown as PlanSpecificationAdapterInput["specification"],
    coverage,
    taskIdMap,
    waiverBindings,
  });
}

export function parsePlanAssemblyRequest(value: unknown): PlanAssemblyRequest {
  const input = strictRecord(value, "planProposal");
  exactKeys(input, ["schemaVersion", "newPlanId", "proposal", "expectedProposalDigest", "expectedSpecificationDigest", "expectedCoverageDigest", "taskBudgetAllocations", "specificationInput"], "planProposal", "plan.proposal.unknown-field");
  literal(input["schemaVersion"], 1, "planProposal");
  const taskBudgetAllocations = strictArray(input["taskBudgetAllocations"], parseTaskBudgetAllocation, "planBudget");
  uniqueStrings(taskBudgetAllocations.map((item) => item.taskId), "planBudget");
  const specificationInput = input["specificationInput"] === null ? null : parsePlanSpecificationAdapterInput(input["specificationInput"]);
  const expectedSpecificationDigest = input["expectedSpecificationDigest"] === null ? null : planDigest(input["expectedSpecificationDigest"], "planSpecification");
  const expectedCoverageDigest = input["expectedCoverageDigest"] === null ? null : planDigest(input["expectedCoverageDigest"], "planCoverage");
  if ((specificationInput === null) !== (expectedSpecificationDigest === null) || (specificationInput === null) !== (expectedCoverageDigest === null)) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.specification.incoherent", "planSpecification");
  }
  return Object.freeze({
    schemaVersion: 1,
    newPlanId: planIdentifier(input["newPlanId"], "pln:", "planProposal"),
    proposal: parsePlanProposal(input["proposal"]),
    expectedProposalDigest: planDigest(input["expectedProposalDigest"], "planProposal"),
    expectedSpecificationDigest,
    expectedCoverageDigest,
    taskBudgetAllocations,
    specificationInput,
  });
}

export function parseAuthenticatedOperatorEvidence(value: unknown): readonly AuthenticatedOperatorClaimEvidence[] {
  const rows = strictArray(value, (entry) => {
    const input = strictRecord(entry, "planProposal");
    exactKeys(input, ["nodeKind", "nodeId", "fieldPath", "value"], "planProposal");
    const nodeKind = enumText(input["nodeKind"], ["stage", "task"] as const, "planProposal");
    return Object.freeze({
      nodeKind,
      nodeId: planIdentifier(input["nodeId"], nodeKind === "stage" ? "stg:" : "tsk:", "planProposal"),
      fieldPath: planText(input["fieldPath"], "planProposal", 128),
      value: quotedPlanText(input["value"], "planText"),
    });
  }, "planProposal");
  uniqueStrings(rows.map((row) => `${row.nodeKind}|${row.nodeId}|${row.fieldPath}`), "planProposal", "plan.provenance.operator-claim-unbacked");
  return rows;
}

function operatorClaimValue(
  node: ProposedStage | ProposedTask,
  path: string,
): string | null {
  if (path === "title") return node.title;
  if ("intent" in node) {
    if (path === "intent") return node.intent;
    const match = /^exitCriteria\[(\d+)\]$/u.exec(path);
    return match === null ? null : node.exitCriteria[Number(match[1])] ?? null;
  }
  if (path === "objective") return node.objective;
  const match = /^acceptance\[(\d+)\]\.criterion$/u.exec(path);
  return match === null ? null : node.acceptance[Number(match[1])]?.criterion ?? null;
}

/**
 * Re-binds parsed authentication rows to the exact proposal claim. This is
 * intentionally module-internal to the package root: only a host-issued
 * capability can establish authenticity, while durable reopen must still
 * refuse impossible extra, wrong-node, wrong-path, non-operator, or
 * byte-mismatched rows.
 */
export function assertOperatorEvidenceTargets(
  request: PlanAssemblyRequest,
  rows: readonly AuthenticatedOperatorClaimEvidence[],
): void {
  const stages = new Map(request.proposal.stages.map((stage) => [stage.stageId, stage]));
  const tasks = new Map(request.proposal.tasks.map((task) => [task.taskId, task]));
  for (const row of rows) {
    const node = row.nodeKind === "stage" ? stages.get(row.nodeId) : tasks.get(row.nodeId);
    if (node === undefined
      || node.provenance[row.fieldPath]?.origin !== "operator"
      || operatorClaimValue(node, row.fieldPath) !== row.value) {
      refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.provenance.operator-claim-unbacked", "planProposal");
    }
  }
}

export function normalizedProposalMaterial(request: PlanAssemblyRequest): Readonly<Record<string, unknown>> {
  const ordinal = new Map(request.proposal.stages.map((stage, index) => [stage.stageId, index + 1]));
  const tasks = [...request.proposal.tasks].sort((left, right) =>
    (ordinal.get(left.stageId) ?? Number.MAX_SAFE_INTEGER) - (ordinal.get(right.stageId) ?? Number.MAX_SAFE_INTEGER)
      || left.taskId.localeCompare(right.taskId));
  const dependencies = [...request.proposal.dependencies].sort((left, right) =>
    left.fromTaskId.localeCompare(right.fromTaskId)
      || left.toTaskId.localeCompare(right.toTaskId)
      || left.kind.localeCompare(right.kind)
      || (left.artifactKind ?? "").localeCompare(right.artifactKind ?? ""));
  const proposal = Object.freeze({ ...request.proposal, tasks: Object.freeze(tasks), dependencies: Object.freeze(dependencies) });
  return Object.freeze({
    schemaVersion: 1,
    newPlanId: request.newPlanId,
    proposal,
    specificationInput: request.specificationInput === null ? null : Object.freeze({
      ...request.specificationInput,
      coverage: Object.freeze([...request.specificationInput.coverage].sort(coverageCompare)),
      taskIdMap: Object.freeze([...request.specificationInput.taskIdMap].sort((a, b) => a.upstreamTaskId.localeCompare(b.upstreamTaskId))),
      waiverBindings: Object.freeze([...request.specificationInput.waiverBindings].sort((a, b) => a.requirementId.localeCompare(b.requirementId))),
    }),
    taskBudgetAllocations: Object.freeze([...request.taskBudgetAllocations].sort((a, b) => a.taskId.localeCompare(b.taskId))),
    expectedSpecificationDigest: request.expectedSpecificationDigest,
    expectedCoverageDigest: request.expectedCoverageDigest,
  });
}

function coverageCompare(left: PlanSpecificationAdapterInput["coverage"][number], right: PlanSpecificationAdapterInput["coverage"][number]): number {
  return left.requirementId.localeCompare(right.requirementId)
    || left.requirementDigest.localeCompare(right.requirementDigest)
    || left.decisionId.localeCompare(right.decisionId)
    || left.disposition.localeCompare(right.disposition)
    || (left.taskId ?? "").localeCompare(right.taskId ?? "");
}

export function canonicalPlanValue(value: unknown): string {
  return serializeCanonicalProjectJson(value);
}

export function dependencyKey(value: Dependency): string {
  return `${value.fromTaskId}|${value.toTaskId}|${value.kind}|${value.artifactKind ?? ""}`;
}

export function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalPlanValue(left) === canonicalPlanValue(right);
}

export function taskBudgetComponents(value: ProjectTask["budget"]): readonly number[] {
  return [value.maximumInputTokens, value.maximumOutputTokens, value.maximumCostMicros, value.maximumToolCalls, value.maximumTurns];
}

export { SCOPE_AUTHORITIES, SCOPE_DISPOSITIONS };
