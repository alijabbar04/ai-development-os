import { createHash } from "node:crypto";
import { serializeCanonicalProjectJson } from "@ai-dev-os/project";
import type { PlanningCommand, PlanningTaskInput } from "./planning-contracts.js";

export class PlanningRefusal extends Error {
  constructor(readonly kind: "refused" | "conflict" | "corrupt", readonly reason: string) { super(reason); }
}
export function refusePlanning(reason: string, kind: PlanningRefusal["kind"] = "refused"): never { throw new PlanningRefusal(kind, reason); }
export const planningHash = Object.freeze({ sha256: (text: string): string => createHash("sha256").update(text, "utf8").digest("hex") });
export const canonicalPlanning = serializeCanonicalProjectJson;
export const digestPlanning = (value: unknown): string => planningHash.sha256(canonicalPlanning(value));

export function planningObject(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(value) as object | null)
    || Object.getOwnPropertySymbols(value).length > 0) return refusePlanning("input.shape");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((d) => !d.enumerable || !("value" in d))) return refusePlanning("input.shape");
  if (keys !== undefined && Object.keys(descriptors).sort().join(",") !== [...keys].sort().join(",")) return refusePlanning("input.fields");
  return value as Record<string, unknown>;
}
export function planningText(value: unknown, maximum = 4096): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|password|access[_-]?token)\s*[:=]\s*\S+|\bBearer\s+[A-Za-z0-9._-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|https?:\/\/[^\s/@]+:[^\s/@]+@)/iu.test(value)) return refusePlanning("input.text");
  return value.trim();
}
export function planningId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) return refusePlanning("input.identifier");
  return value;
}
export function planningInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) return refusePlanning("input.integer");
  return value;
}
export function planningArray<T>(value: unknown, parse: (value: unknown) => T, maximum = 32): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum || Object.keys(value).length !== value.length) return refusePlanning("input.collection");
  return Object.freeze(value.map(parse));
}
function texts(value: unknown): readonly string[] { return planningArray(value, (v) => planningText(v, 2000), 16); }
function task(value: unknown): PlanningTaskInput {
  const row = planningObject(value, ["title", "objective", "acceptanceCriteria"]);
  const criteria = texts(row["acceptanceCriteria"]);
  if (criteria.length === 0) return refusePlanning("plan.acceptance-required");
  return Object.freeze({ title: planningText(row["title"], 300), objective: planningText(row["objective"], 2000), acceptanceCriteria: criteria });
}
export function parsePlanningCommand(value: unknown): PlanningCommand {
  const input = planningObject(value);
  const kind = input["kind"];
  let result: PlanningCommand;
  const command = (): string => planningId(input["commandId"]);
  const project = (): string => { const id = planningId(input["projectId"]); if (!id.startsWith("prj:")) return refusePlanning("input.project"); return id; };
  const version = (name: string): number => planningInteger(input[name]);
  switch (kind) {
    case "create-project": {
      planningObject(input, ["kind", "commandId", "name", "objective", "outcomes", "budgetMinorUnits", "currency"]);
      const currency = planningText(input["currency"], 3);
      if (!["GBP", "USD", "EUR"].includes(currency)) return refusePlanning("budget.currency-unavailable");
      result = { kind, commandId: command(), name: planningText(input["name"], 200), objective: planningText(input["objective"]), outcomes: texts(input["outcomes"]), budgetMinorUnits: planningInteger(input["budgetMinorUnits"], 1_000_000_000), currency }; break;
    }
    case "draft-brief":
      planningObject(input, ["kind", "projectId", "objective", "outcomes", "nonGoals", "audiences", "expectedBriefVersion"]);
      result = { kind, projectId: project(), objective: planningText(input["objective"]), outcomes: texts(input["outcomes"]), nonGoals: texts(input["nonGoals"]), audiences: texts(input["audiences"]), expectedBriefVersion: version("expectedBriefVersion") }; break;
    case "answer-clarification":
      planningObject(input, ["kind", "projectId", "candidateId", "answers"]);
      result = { kind, projectId: project(), candidateId: planningId(input["candidateId"]), answers: planningArray(input["answers"], (v) => { const r = planningObject(v, ["questionId", "value"]); return Object.freeze({ questionId: planningId(r["questionId"]), value: planningText(r["value"], 1024) }); }, 8) }; break;
    case "accept-brief": {
      planningObject(input, ["kind", "commandId", "projectId", "candidateId", "candidateDigest", "expectedBriefVersion"]);
      const candidateDigest = input["candidateDigest"];
      if (typeof candidateDigest !== "string" || !/^[a-f0-9]{64}$/u.test(candidateDigest)) return refusePlanning("input.digest");
      result = { kind, commandId: command(), projectId: project(), candidateId: planningId(input["candidateId"]), candidateDigest, expectedBriefVersion: version("expectedBriefVersion") }; break;
    }
    case "select-repository": case "stop-project": case "resume-project":
      planningObject(input, ["kind", "commandId", "projectId", "expectedProjectVersion"]);
      result = { kind, commandId: command(), projectId: project(), expectedProjectVersion: version("expectedProjectVersion") }; break;
    case "save-plan": {
      planningObject(input, ["kind", "commandId", "projectId", "expectedPlanVersion", "title", "tasks", "scope"]);
      const scope = input["scope"]; if (scope !== "within-brief" && scope !== "scope-expansion") return refusePlanning("input.scope");
      const tasks = planningArray(input["tasks"], task); if (tasks.length === 0) return refusePlanning("plan.tasks-required");
      result = { kind, commandId: command(), projectId: project(), expectedPlanVersion: version("expectedPlanVersion"), title: planningText(input["title"], 300), tasks, scope }; break;
    }
    case "prepare-plan": case "approve-scope": case "seal-plan": case "export-handover":
      planningObject(input, ["kind", "commandId", "projectId", "expectedPlanVersion"]);
      result = { kind, commandId: command(), projectId: project(), expectedPlanVersion: version("expectedPlanVersion") }; break;
    case "attach-result":
      planningObject(input, ["kind", "commandId", "projectId", "handoverId"]);
      result = { kind, commandId: command(), projectId: project(), handoverId: planningId(input["handoverId"]) }; break;
    case "historical-money": {
      planningObject(input, ["kind", "commandId", "projectId", "approvalId", "expectedApprovalVersion", "expectedSpendingVersion", "action", "receiptRef"]);
      const action = input["action"]; if (action !== "report-executed" && action !== "record-receipt" && action !== "withdraw") return refusePlanning("input.action");
      const receiptRef = input["receiptRef"] === null ? null : planningText(input["receiptRef"], 128);
      if ((action === "record-receipt") !== (receiptRef !== null) || receiptRef !== null && (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/u.test(receiptRef) || /[A-Fa-f0-9]{32}/u.test(receiptRef))) return refusePlanning("input.receipt-reference");
      result = { kind, commandId: command(), projectId: project(), approvalId: planningId(input["approvalId"]), expectedApprovalVersion: version("expectedApprovalVersion"), expectedSpendingVersion: version("expectedSpendingVersion"), action, receiptRef }; break;
    }
    default: return refusePlanning("input.command");
  }
  if (canonicalPlanning(result).length > 131_072) return refusePlanning("input.too-large");
  return Object.freeze(result);
}
