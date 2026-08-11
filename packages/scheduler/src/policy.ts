import { createHash } from "node:crypto";
import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import { SchedulerError } from "./errors.js";
import { PERMISSION_MODES, STAGE_18A_PRODUCTION_ENABLED, type PermissionMode, type PolicyBlock } from "./types.js";

const { ensureBoolean, ensureEnum, ensureExactKeys, ensureRecord, ensureString } = validation;

export interface DispatchPolicyContext {
  readonly permissionMode: PermissionMode;
  readonly stage17Admitted: boolean;
  readonly productionEnabled: boolean;
  readonly credentialsAvailable: boolean;
  readonly operatorPolicyAllows: boolean;
  readonly providerSafetyAllows: boolean;
  readonly usageAllows: boolean;
  readonly requestsElevation: boolean;
  readonly operation: {
    readonly taskId: string;
    readonly candidateId: string | null;
    readonly objectiveDigest: string;
  };
}

export interface DispatchPolicyDecision {
  readonly outcome: "allowed" | "blocked";
  readonly code: string;
  readonly ruleIds: readonly string[];
  readonly reasons: readonly string[];
  readonly operationFingerprint: string;
  readonly humanResumable: boolean;
}

export function evaluateDispatchPolicy(raw: DispatchPolicyContext): DispatchPolicyDecision {
  const input = ensureRecord(raw, "dispatchPolicy");
  ensureExactKeys(input, [
    "permissionMode", "stage17Admitted", "productionEnabled", "credentialsAvailable",
    "operatorPolicyAllows", "providerSafetyAllows", "usageAllows", "requestsElevation", "operation",
  ], "dispatchPolicy");
  const permissionMode = ensureEnum(input["permissionMode"], "dispatchPolicy.permissionMode", PERMISSION_MODES);
  const operationInput = ensureRecord(input["operation"], "dispatchPolicy.operation");
  ensureExactKeys(operationInput, ["taskId", "candidateId", "objectiveDigest"], "dispatchPolicy.operation");
  const operation = Object.freeze({
    taskId: ensureString(operationInput["taskId"], "dispatchPolicy.operation.taskId", { maxLength: 128 }),
    candidateId: operationInput["candidateId"] === null ? null : ensureString(operationInput["candidateId"], "dispatchPolicy.operation.candidateId", { maxLength: 128 }),
    objectiveDigest: ensureString(operationInput["objectiveDigest"], "dispatchPolicy.operation.objectiveDigest", { maxLength: 64, pattern: /^[a-f0-9]{64}$/, patternName: "SHA-256" }),
  });
  // Retained for source compatibility with the Stage 18A request shape. These
  // caller assertions are deliberately non-authorizing; a future admitted
  // schema must consume private verifier evidence rather than booleans.
  ensureBoolean(input["stage17Admitted"], "dispatchPolicy.stage17Admitted");
  ensureBoolean(input["productionEnabled"], "dispatchPolicy.productionEnabled");
  const checks = Object.freeze({
    credentialsAvailable: ensureBoolean(input["credentialsAvailable"], "dispatchPolicy.credentialsAvailable"),
    operatorPolicyAllows: ensureBoolean(input["operatorPolicyAllows"], "dispatchPolicy.operatorPolicyAllows"),
    providerSafetyAllows: ensureBoolean(input["providerSafetyAllows"], "dispatchPolicy.providerSafetyAllows"),
    usageAllows: ensureBoolean(input["usageAllows"], "dispatchPolicy.usageAllows"),
    requestsElevation: ensureBoolean(input["requestsElevation"], "dispatchPolicy.requestsElevation"),
  });
  const ruleIds: string[] = [];
  const reasons: string[] = [];
  if (STAGE_18A_PRODUCTION_ENABLED === false) {
    ruleIds.push("orchestration.stage18a.production-disabled");
    reasons.push("Stage 18A is compiled production-disabled.");
  }
  ruleIds.push("orchestration.stage17-admission.required");
  reasons.push("Stage 17 production admission is required before dispatch.");
  if (!checks.credentialsAvailable) {
    ruleIds.push("orchestration.credentials.required");
    reasons.push("Provider credentials are unavailable.");
  }
  if (!checks.operatorPolicyAllows) {
    ruleIds.push("orchestration.operator-policy.required");
    reasons.push("Operator policy does not authorize this dispatch.");
  }
  if (!checks.providerSafetyAllows) {
    ruleIds.push("orchestration.provider-safety.required");
    reasons.push("Provider safety controls refused the operation.");
  }
  if (!checks.usageAllows) {
    ruleIds.push("orchestration.usage.required");
    reasons.push("Usage policy refused the operation.");
  }
  if (checks.requestsElevation) {
    ruleIds.push("orchestration.elevation.forbidden");
    reasons.push("Permission modes never authorize elevation.");
  }
  const operationFingerprint = createHash("sha256").update(toCanonicalJson({ permissionMode, operation })).digest("hex");
  return Object.freeze({
    outcome: ruleIds.length === 0 ? "allowed" : "blocked",
    code: ruleIds.length === 0 ? "policy-allowed" : "policy-blocked",
    ruleIds: Object.freeze(ruleIds),
    reasons: Object.freeze(reasons),
    operationFingerprint,
    humanResumable: ruleIds.every((rule) => rule === "orchestration.credentials.required" || rule === "orchestration.operator-policy.required"),
  });
}

export function policyBlockFromDecision(decision: DispatchPolicyDecision): PolicyBlock {
  if (decision.outcome !== "blocked") throw new SchedulerError("INVALID_TRANSITION", "An allowed policy decision cannot create a block.");
  return Object.freeze({
    blockId: `block:${decision.operationFingerprint.slice(0, 32)}`,
    operationFingerprint: decision.operationFingerprint,
    ruleIds: decision.ruleIds,
    reason: decision.reasons.join(" "),
    humanResumable: decision.humanResumable,
  });
}
