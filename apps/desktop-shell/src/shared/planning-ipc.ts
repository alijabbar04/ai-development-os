import type { PlanningCommand, PlanningCommandResult, PlanningHandoverView, PlanningWorkspaceView } from "@ai-dev-os/application/planning-contracts";

export type PlanningQuery = Readonly<{ kind: "snapshot"; projectId: string | null }> | Readonly<{ kind: "observe"; commandId: string }> | Readonly<{ kind: "handover"; projectId: string; handoverId: string }> | Readonly<{ kind: "command"; command: unknown }>;
export type PlanningReply = PlanningWorkspaceView | PlanningCommandResult | PlanningHandoverView;
export interface NativePlanningReview { readonly reviewId: string; readonly action: PlanningCommand["kind"]; readonly title: string; readonly detail: string; readonly subjectDigest: string }
export type NativePlanningRequest = Readonly<{ kind: "confirm"; review: NativePlanningReview }> | Readonly<{ kind: "repository" }> | Readonly<{ kind: "result" }>;
export type NativePlanningReply = boolean | string | Readonly<{ name: string; text: string }> | null;
export function exactPlanningRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value) as null)) throw new Error("INVALID_REQUEST");
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string") || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error("INVALID_REQUEST");
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (d === undefined || !d.enumerable || !("value" in d)) throw new Error("INVALID_REQUEST"); }
  return value as Record<string, unknown>;
}
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(value);
export function parsePlanningQuery(value: unknown): PlanningQuery {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REQUEST");
  const kind = (value as Record<string, unknown>)["kind"];
  if (kind === "snapshot") { const r = exactPlanningRecord(value, ["kind", "projectId"]); if (r["projectId"] !== null && !id(r["projectId"])) throw new Error("INVALID_REQUEST"); }
  else if (kind === "observe") { const r = exactPlanningRecord(value, ["kind", "commandId"]); if (!id(r["commandId"])) throw new Error("INVALID_REQUEST"); }
  else if (kind === "handover") { const r = exactPlanningRecord(value, ["kind", "projectId", "handoverId"]); if (!id(r["projectId"]) || !id(r["handoverId"])) throw new Error("INVALID_REQUEST"); }
  else if (kind === "command") { exactPlanningRecord(value, ["kind", "command"]); if (JSON.stringify(value).length > 131072) throw new Error("INVALID_REQUEST"); }
  else throw new Error("INVALID_REQUEST");
  return value as PlanningQuery;
}
export function parseNativePlanningRequest(value: unknown): NativePlanningRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REQUEST");
  const kind = (value as Record<string, unknown>)["kind"];
  if (kind === "repository" || kind === "result") exactPlanningRecord(value, ["kind"]);
  else if (kind === "confirm") {
    const r = exactPlanningRecord(value, ["kind", "review"]), review = exactPlanningRecord(r["review"], ["reviewId", "action", "title", "detail", "subjectDigest"]);
    if (!id(review["reviewId"]) || typeof review["action"] !== "string" || !["create-project", "draft-brief", "answer-clarification", "accept-brief", "select-repository", "save-plan", "prepare-plan", "approve-scope", "request-scope-again", "seal-plan", "stop-project", "resume-project", "export-handover", "attach-result", "historical-money", "start-ai-planning", "save-ai-planning-draft", "request-ai-understanding", "request-ai-proposal", "accept-ai-brief", "adopt-ai-proposal", "cancel-ai-request"].includes(review["action"])
      || typeof review["title"] !== "string" || review["title"].length > 200 || typeof review["detail"] !== "string" || review["detail"].length > 196608 || typeof review["subjectDigest"] !== "string" || !/^[a-f0-9]{64}$/u.test(review["subjectDigest"])) throw new Error("INVALID_REQUEST");
  } else throw new Error("INVALID_REQUEST");
  return value as NativePlanningRequest;
}
