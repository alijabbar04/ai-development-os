import { createHash } from "node:crypto";
import {
  DATA_CLASSIFICATIONS,
  EDIT_SCOPES,
  REASONING_DEMANDS,
  TASK_CAPABILITIES,
  TASK_KINDS,
  TASK_RISKS,
  toCanonicalJson,
  validation,
  type DataClassification,
  type EditScope,
  type ReasoningDemand,
  type TaskCapability,
  type TaskKind,
  type TaskRisk
} from "@ai-dev-os/domain";
import {
  MAX_PROPOSAL_DEPENDENCIES,
  MAX_PROPOSAL_LIST_ITEMS,
  MAX_PROPOSAL_TASKS,
  MAX_PROPOSAL_TEXT,
  THINKER_PROPOSAL_JSON_SCHEMA,
  THINKER_PROPOSAL_OUTPUT_SCHEMA_VERSION,
  effectivePromptClassification,
  effectivePromptRisk,
  parsePromptCompilationRequest,
  type PromptCompilationRequest
} from "@ai-dev-os/prompt-compiler";
import {
  DEFAULT_THINKER_CONFIGURATION,
  THINKER_FINGERPRINT_ALGORITHM_VERSION,
  THINKER_PLAN_SCHEMA_VERSION,
  type ThinkerConfiguration,
  parseThinkerConfiguration
} from "./configuration.js";

const {
  ensureArray,
  ensureEnum,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString
} = validation;

const HEX_64 = /^[0-9a-f]{64}$/u;
const PROPOSAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function text(value: unknown, path: string, maximum = MAX_PROPOSAL_TEXT): string {
  return ensureString(value, path, { minLength: 1, maxLength: maximum });
}

function textArray(value: unknown, path: string): readonly string[] {
  return Object.freeze(
    ensureArray(value, path, MAX_PROPOSAL_LIST_ITEMS).map((item, index) =>
      text(item, `${path}[${index}]`)
    )
  );
}

export const THINKER_OUTPUT_JSON_SCHEMA = THINKER_PROPOSAL_JSON_SCHEMA;
export const THINKER_PLAN_FINGERPRINT_ALGORITHM_VERSION =
  THINKER_FINGERPRINT_ALGORITHM_VERSION;

export const THINKER_PROPOSAL_STATUSES = Object.freeze([
  "viable",
  "blocked",
  "clarification-required"
] as const);
export type ThinkerProposalStatus = (typeof THINKER_PROPOSAL_STATUSES)[number];

export interface ThinkerEvidenceReference {
  readonly identity: string;
  readonly digest: string;
}

export interface ProposedThinkerTask {
  readonly proposalId: string;
  readonly kind: TaskKind;
  readonly title: string;
  readonly description: string;
  readonly dependencies: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly evidence: readonly ThinkerEvidenceReference[];
  readonly unsupportedAssumptions: readonly string[];
  readonly complexity: number;
  readonly reasoning: ReasoningDemand;
  readonly capabilities: readonly TaskCapability[];
  readonly editScope: EditScope;
  readonly risk: TaskRisk;
  readonly classification: DataClassification;
}

export interface ThinkerProposal {
  readonly schemaVersion: typeof THINKER_PROPOSAL_OUTPUT_SCHEMA_VERSION;
  readonly status: ThinkerProposalStatus;
  readonly objective: string;
  readonly assumptions: readonly string[];
  readonly risks: readonly string[];
  readonly openQuestions: readonly string[];
  readonly completionCriteria: readonly string[];
  readonly tasks: readonly ProposedThinkerTask[];
}

function parseEvidence(value: unknown, path: string): ThinkerEvidenceReference {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["identity", "digest"], path);
  return Object.freeze({
    identity: ensureString(record["identity"], `${path}.identity`, {
      minLength: 1,
      maxLength: 256
    }),
    digest: ensureString(record["digest"], `${path}.digest`, {
      minLength: 64,
      maxLength: 64,
      pattern: HEX_64,
      patternName: "sha-256 digest"
    })
  });
}

function parseTask(value: unknown, path: string): ProposedThinkerTask {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "proposalId",
      "kind",
      "title",
      "description",
      "dependencies",
      "acceptanceCriteria",
      "evidence",
      "unsupportedAssumptions",
      "complexity",
      "reasoning",
      "capabilities",
      "editScope",
      "risk",
      "classification"
    ],
    path
  );
  const dependencies = ensureArray(
    record["dependencies"],
    `${path}.dependencies`,
    MAX_PROPOSAL_DEPENDENCIES
  )
    .map((item, index) =>
      ensureString(item, `${path}.dependencies[${index}]`, {
        minLength: 1,
        maxLength: 64,
        pattern: PROPOSAL_ID,
        patternName: "proposal identifier"
      })
    )
    .sort(compareText);
  const evidence = ensureArray(record["evidence"], `${path}.evidence`, MAX_PROPOSAL_LIST_ITEMS)
    .map((item, index) => parseEvidence(item, `${path}.evidence[${index}]`))
    .sort(
      (a, b) => compareText(a.identity, b.identity) || compareText(a.digest, b.digest)
    );
  const capabilities = ensureArray(
    record["capabilities"],
    `${path}.capabilities`,
    TASK_CAPABILITIES.length
  ).map((item, index) =>
    ensureEnum(item, `${path}.capabilities[${index}]`, TASK_CAPABILITIES)
  );
  capabilities.sort((a, b) => TASK_CAPABILITIES.indexOf(a) - TASK_CAPABILITIES.indexOf(b));
  return Object.freeze({
    proposalId: ensureString(record["proposalId"], `${path}.proposalId`, {
      minLength: 1,
      maxLength: 64,
      pattern: PROPOSAL_ID,
      patternName: "proposal identifier"
    }),
    kind: ensureEnum(record["kind"], `${path}.kind`, TASK_KINDS),
    title: text(record["title"], `${path}.title`, 240),
    description: text(record["description"], `${path}.description`),
    dependencies: Object.freeze(dependencies),
    acceptanceCriteria: textArray(record["acceptanceCriteria"], `${path}.acceptanceCriteria`),
    evidence: Object.freeze(evidence),
    unsupportedAssumptions: textArray(
      record["unsupportedAssumptions"],
      `${path}.unsupportedAssumptions`
    ),
    complexity: ensureSafeInteger(record["complexity"], `${path}.complexity`, 1, 5),
    reasoning: ensureEnum(record["reasoning"], `${path}.reasoning`, REASONING_DEMANDS),
    capabilities: Object.freeze(capabilities),
    editScope: ensureEnum(record["editScope"], `${path}.editScope`, EDIT_SCOPES),
    risk: ensureEnum(record["risk"], `${path}.risk`, TASK_RISKS),
    classification: ensureEnum(
      record["classification"],
      `${path}.classification`,
      DATA_CLASSIFICATIONS
    )
  });
}

export function parseThinkerProposal(value: unknown, path = "thinkerProposal"): ThinkerProposal {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "status",
      "objective",
      "assumptions",
      "risks",
      "openQuestions",
      "completionCriteria",
      "tasks"
    ],
    path
  );
  ensureSchemaVersion(
    record["schemaVersion"],
    `${path}.schemaVersion`,
    THINKER_PROPOSAL_OUTPUT_SCHEMA_VERSION
  );
  const tasks = ensureArray(record["tasks"], `${path}.tasks`, MAX_PROPOSAL_TASKS)
    .map((item, index) => parseTask(item, `${path}.tasks[${index}]`))
    .sort((a, b) => compareText(a.proposalId, b.proposalId));
  return Object.freeze({
    schemaVersion: THINKER_PROPOSAL_OUTPUT_SCHEMA_VERSION,
    status: ensureEnum(record["status"], `${path}.status`, THINKER_PROPOSAL_STATUSES),
    objective: text(record["objective"], `${path}.objective`),
    assumptions: textArray(record["assumptions"], `${path}.assumptions`),
    risks: textArray(record["risks"], `${path}.risks`),
    openQuestions: textArray(record["openQuestions"], `${path}.openQuestions`),
    completionCriteria: textArray(record["completionCriteria"], `${path}.completionCriteria`),
    tasks: Object.freeze(tasks)
  });
}

export const THINKER_PLAN_VIOLATION_CODES = Object.freeze([
  "MALFORMED_PROPOSAL",
  "TASK_LIMIT_EXCEEDED",
  "LIST_LIMIT_EXCEEDED",
  "TEXT_LIMIT_EXCEEDED",
  "DUPLICATE_TASK_ID",
  "UNKNOWN_DEPENDENCY",
  "SELF_DEPENDENCY",
  "DUPLICATE_DEPENDENCY",
  "CYCLIC_DEPENDENCY",
  "DUPLICATE_EVIDENCE",
  "FABRICATED_EVIDENCE",
  "TASK_KIND_OUTSIDE_AUTHORITY",
  "CAPABILITY_OUTSIDE_AUTHORITY",
  "DUPLICATE_CAPABILITY",
  "EDIT_SCOPE_OUTSIDE_AUTHORITY",
  "EDIT_SCOPE_CAPABILITY_MISMATCH",
  "RISK_UNDERSTATED",
  "CLASSIFICATION_LOWERED",
  "REASONING_OUTSIDE_AUTHORITY"
] as const);

export type ThinkerPlanViolationCode = (typeof THINKER_PLAN_VIOLATION_CODES)[number];
export type ThinkerPlanViolationCategory = "structure" | "dag" | "evidence" | "authority";

export interface ThinkerPlanViolation {
  readonly code: ThinkerPlanViolationCode;
  readonly category: ThinkerPlanViolationCategory;
  readonly path: string;
}

export type ThinkerPlanValidation =
  | {
      readonly valid: true;
      readonly proposal: ThinkerProposal;
      readonly violations: readonly ThinkerPlanViolation[];
    }
  | {
      readonly valid: false;
      readonly proposal: null;
      readonly violations: readonly ThinkerPlanViolation[];
    };

function violation(
  code: ThinkerPlanViolationCode,
  category: ThinkerPlanViolationCategory,
  path: string
): ThinkerPlanViolation {
  return Object.freeze({ code, category, path });
}

function pushListBounds(
  violations: ThinkerPlanViolation[],
  list: readonly unknown[],
  maximum: number,
  path: string
): void {
  if (list.length > maximum) {
    violations.push(violation("LIST_LIMIT_EXCEEDED", "structure", path));
  }
}

function pushTextBounds(
  violations: ThinkerPlanViolation[],
  value: string,
  maximum: number,
  path: string
): void {
  if (value.length > maximum) {
    violations.push(violation("TEXT_LIMIT_EXCEEDED", "structure", path));
  }
}

function hasCycle(tasks: readonly ProposedThinkerTask[]): boolean {
  const dependencies = new Map(tasks.map((task) => [task.proposalId, task.dependencies]));
  const state = new Map<string, "visiting" | "visited">();
  const visit = (id: string): boolean => {
    const current = state.get(id);
    if (current === "visiting") return true;
    if (current === "visited") return false;
    state.set(id, "visiting");
    for (const dependency of dependencies.get(id) ?? []) {
      if (dependencies.has(dependency) && visit(dependency)) return true;
    }
    state.set(id, "visited");
    return false;
  };
  return tasks.some((task) => visit(task.proposalId));
}

function bounds(
  configuration: ThinkerConfiguration,
  request: PromptCompilationRequest
): Readonly<Record<
  | "tasks"
  | "dependencies"
  | "criteria"
  | "evidence"
  | "unsupported"
  | "assumptions"
  | "risks"
  | "questions"
  | "completion"
  | "text"
  | "title"
  | "objective",
  number
>> {
  const authority = request.authority;
  return Object.freeze({
    tasks: Math.min(configuration.maxTasks, authority.maxTasks),
    dependencies: Math.min(
      configuration.maxDependenciesPerTask,
      authority.maxDependenciesPerTask
    ),
    criteria: Math.min(configuration.maxCriteriaPerTask, authority.maxCriteriaPerTask),
    evidence: Math.min(configuration.maxEvidencePerTask, authority.maxEvidencePerTask),
    unsupported: Math.min(
      configuration.maxUnsupportedAssumptionsPerTask,
      authority.maxUnsupportedAssumptionsPerTask
    ),
    assumptions: Math.min(configuration.maxAssumptions, authority.maxAssumptions),
    risks: Math.min(configuration.maxRisks, authority.maxRisks),
    questions: Math.min(configuration.maxQuestions, authority.maxQuestions),
    completion: Math.min(
      configuration.maxCompletionCriteria,
      authority.maxCompletionCriteria
    ),
    text: Math.min(configuration.maxTextLength, authority.maxTextLength),
    title: Math.min(configuration.maxTitleLength, authority.maxTitleLength),
    objective: Math.min(configuration.maxObjectiveLength, authority.maxObjectiveLength)
  });
}

export function validateThinkerPlan(
  value: unknown,
  compilationRequest: unknown,
  thinkerConfiguration: unknown = DEFAULT_THINKER_CONFIGURATION
): ThinkerPlanValidation {
  let proposal: ThinkerProposal;
  try {
    proposal = parseThinkerProposal(value);
  } catch {
    return Object.freeze({
      valid: false,
      proposal: null,
      violations: Object.freeze([
        violation("MALFORMED_PROPOSAL", "structure", "thinkerProposal")
      ])
    });
  }
  const request = parsePromptCompilationRequest(compilationRequest);
  const configuration = parseThinkerConfiguration(thinkerConfiguration);
  const maximum = bounds(configuration, request);
  const violations: ThinkerPlanViolation[] = [];
  if (proposal.tasks.length > maximum.tasks) {
    violations.push(violation("TASK_LIMIT_EXCEEDED", "structure", "thinkerProposal.tasks"));
  }
  pushTextBounds(violations, proposal.objective, maximum.objective, "thinkerProposal.objective");
  pushListBounds(violations, proposal.assumptions, maximum.assumptions, "thinkerProposal.assumptions");
  pushListBounds(violations, proposal.risks, maximum.risks, "thinkerProposal.risks");
  pushListBounds(violations, proposal.openQuestions, maximum.questions, "thinkerProposal.openQuestions");
  pushListBounds(
    violations,
    proposal.completionCriteria,
    maximum.completion,
    "thinkerProposal.completionCriteria"
  );
  for (const [index, item] of proposal.assumptions.entries())
    pushTextBounds(violations, item, maximum.text, `thinkerProposal.assumptions[${index}]`);
  for (const [index, item] of proposal.risks.entries())
    pushTextBounds(violations, item, maximum.text, `thinkerProposal.risks[${index}]`);
  for (const [index, item] of proposal.openQuestions.entries())
    pushTextBounds(violations, item, maximum.text, `thinkerProposal.openQuestions[${index}]`);
  for (const [index, item] of proposal.completionCriteria.entries())
    pushTextBounds(violations, item, maximum.text, `thinkerProposal.completionCriteria[${index}]`);

  const taskIds = new Set<string>();
  for (const [index, task] of proposal.tasks.entries()) {
    const path = `thinkerProposal.tasks[${index}]`;
    if (taskIds.has(task.proposalId))
      violations.push(violation("DUPLICATE_TASK_ID", "dag", `${path}.proposalId`));
    taskIds.add(task.proposalId);
    pushTextBounds(violations, task.title, maximum.title, `${path}.title`);
    pushTextBounds(violations, task.description, maximum.text, `${path}.description`);
    pushListBounds(violations, task.dependencies, maximum.dependencies, `${path}.dependencies`);
    pushListBounds(violations, task.acceptanceCriteria, maximum.criteria, `${path}.acceptanceCriteria`);
    pushListBounds(violations, task.evidence, maximum.evidence, `${path}.evidence`);
    pushListBounds(
      violations,
      task.unsupportedAssumptions,
      maximum.unsupported,
      `${path}.unsupportedAssumptions`
    );
    for (const [itemIndex, item] of task.acceptanceCriteria.entries())
      pushTextBounds(violations, item, maximum.text, `${path}.acceptanceCriteria[${itemIndex}]`);
    for (const [itemIndex, item] of task.unsupportedAssumptions.entries())
      pushTextBounds(violations, item, maximum.text, `${path}.unsupportedAssumptions[${itemIndex}]`);
  }

  const evidence = new Set(
    request.context.pack.items.map((item) => `${item.identity}\u0000${item.digest}`)
  );
  for (const [index, task] of proposal.tasks.entries()) {
    const path = `thinkerProposal.tasks[${index}]`;
    const seenDependencies = new Set<string>();
    for (const dependency of task.dependencies) {
      if (dependency === task.proposalId)
        violations.push(violation("SELF_DEPENDENCY", "dag", `${path}.dependencies`));
      if (!taskIds.has(dependency))
        violations.push(violation("UNKNOWN_DEPENDENCY", "dag", `${path}.dependencies`));
      if (seenDependencies.has(dependency))
        violations.push(violation("DUPLICATE_DEPENDENCY", "dag", `${path}.dependencies`));
      seenDependencies.add(dependency);
    }
    const seenEvidence = new Set<string>();
    for (const reference of task.evidence) {
      const key = `${reference.identity}\u0000${reference.digest}`;
      if (seenEvidence.has(key))
        violations.push(violation("DUPLICATE_EVIDENCE", "evidence", `${path}.evidence`));
      if (!evidence.has(key))
        violations.push(violation("FABRICATED_EVIDENCE", "evidence", `${path}.evidence`));
      seenEvidence.add(key);
    }
    if (!request.authority.permittedTaskKinds.includes(task.kind))
      violations.push(
        violation("TASK_KIND_OUTSIDE_AUTHORITY", "authority", `${path}.kind`)
      );
    const seenCapabilities = new Set<TaskCapability>();
    for (const capability of task.capabilities) {
      if (seenCapabilities.has(capability))
        violations.push(
          violation("DUPLICATE_CAPABILITY", "authority", `${path}.capabilities`)
        );
      if (!request.authority.capabilityCeiling.includes(capability))
        violations.push(
          violation("CAPABILITY_OUTSIDE_AUTHORITY", "authority", `${path}.capabilities`)
        );
      seenCapabilities.add(capability);
    }
    if (EDIT_SCOPES.indexOf(task.editScope) > EDIT_SCOPES.indexOf(request.authority.editScopeCeiling))
      violations.push(
        violation("EDIT_SCOPE_OUTSIDE_AUTHORITY", "authority", `${path}.editScope`)
      );
    if (task.editScope !== "none" && !task.capabilities.includes("code-edit"))
      violations.push(
        violation("EDIT_SCOPE_CAPABILITY_MISMATCH", "authority", `${path}.editScope`)
      );
    if (TASK_RISKS.indexOf(task.risk) < TASK_RISKS.indexOf(effectivePromptRisk(request)))
      violations.push(violation("RISK_UNDERSTATED", "authority", `${path}.risk`));
    if (
      DATA_CLASSIFICATIONS.indexOf(task.classification) <
      DATA_CLASSIFICATIONS.indexOf(effectivePromptClassification(request))
    )
      violations.push(
        violation("CLASSIFICATION_LOWERED", "authority", `${path}.classification`)
      );
    if (
      REASONING_DEMANDS.indexOf(task.reasoning) >
      REASONING_DEMANDS.indexOf(request.authority.reasoningCeiling)
    )
      violations.push(
        violation("REASONING_OUTSIDE_AUTHORITY", "authority", `${path}.reasoning`)
      );
  }
  if (hasCycle(proposal.tasks)) {
    violations.push(violation("CYCLIC_DEPENDENCY", "dag", "thinkerProposal.tasks"));
  }
  if (violations.length > 0) {
    return Object.freeze({
      valid: false,
      proposal: null,
      violations: Object.freeze(violations)
    });
  }
  return Object.freeze({ valid: true, proposal, violations: Object.freeze([]) });
}

export function thinkerPlanFingerprint(value: unknown): string {
  const proposal = parseThinkerProposal(value);
  return createHash("sha256")
    .update(
      toCanonicalJson(
        {
          fingerprintAlgorithmVersion: THINKER_PLAN_FINGERPRINT_ALGORITHM_VERSION,
          planSchemaVersion: THINKER_PLAN_SCHEMA_VERSION,
          proposal
        },
        "thinkerPlanFingerprint"
      ),
      "utf8"
    )
    .digest("hex");
}
