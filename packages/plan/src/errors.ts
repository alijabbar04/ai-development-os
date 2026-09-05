export const PLAN_REFUSAL_CODES = Object.freeze([
  "PLAN_VALIDATION_REFUSED",
  "PLAN_PRECONDITION_REFUSED",
  "PLAN_BOUND_EXCEEDED",
  "PLAN_SEAL_CONDITION_FAILED",
  "PLAN_PROVENANCE_REFUSED",
  "PLAN_AUTHORITY_VIOLATION",
  "PLAN_STORE_CONFLICT",
  "PLAN_STORE_UNAVAILABLE",
  "PLAN_STORE_CORRUPT",
  "PLAN_OUT_OF_SCOPE",
] as const);

export type PlanRefusalCode = (typeof PLAN_REFUSAL_CODES)[number];

export const PLAN_DIAGNOSTIC_ROOTS = Object.freeze([
  "plan", "planProposal", "planStage", "planTask", "planDependency",
  "planGraph", "planBrief", "planSpecification", "planCoverage",
  "planConstraint", "planDecision", "planSeal", "planBudget",
  "planLineage", "planStore", "planSession", "planProjection", "planText",
] as const);

function finitePath(path: unknown): string {
  if (typeof path !== "string") return "plan";
  for (const root of PLAN_DIAGNOSTIC_ROOTS) {
    if (path === root || path.startsWith(`${root}.`) || path.startsWith(`${root}[`)) return root;
  }
  return "plan";
}

export class PlanContractError extends Error {
  readonly code: PlanRefusalCode;
  readonly ruleId: string;
  readonly path: string;
  readonly condition: 1 | 2 | 3 | 4 | 5 | 6 | null;

  constructor(
    code: PlanRefusalCode,
    ruleId: string,
    path: string,
    condition: 1 | 2 | 3 | 4 | 5 | 6 | null = null,
  ) {
    super("The plan contract was refused.");
    this.name = "PlanContractError";
    this.code = code;
    this.ruleId = ruleId;
    this.path = finitePath(path);
    this.condition = condition;
  }

  toJSON(): Readonly<{
    name: string;
    code: PlanRefusalCode;
    ruleId: string;
    path: string;
    condition: 1 | 2 | 3 | 4 | 5 | 6 | null;
    message: string;
  }> {
    return Object.freeze({
      name: this.name,
      code: this.code,
      ruleId: this.ruleId,
      path: this.path,
      condition: this.condition,
      message: this.message,
    });
  }
}

export function refusePlan(
  code: PlanRefusalCode,
  ruleId: string,
  path = "plan",
  condition: 1 | 2 | 3 | 4 | 5 | 6 | null = null,
): never {
  throw new PlanContractError(code, ruleId, path, condition);
}

export function isPlanContractError(value: unknown): value is PlanContractError {
  return value instanceof PlanContractError;
}
