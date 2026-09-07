import type { AggregateEnvelope, TransactionContext } from "@ai-dev-os/persistence";
import type { PlanningRepositoryObservation } from "./planning-repository.js";
import { verifyPlanningEnvelope, writePlanningAggregate } from "./planning-ledger.js";
import { canonicalPlanning, planningArray, planningId, planningInteger, planningObject, planningText, refusePlanning } from "./planning-validation.js";

export interface PlanningMetadata {
  readonly schemaVersion: 1; readonly kind: "project-planning-metadata"; readonly projectId: string;
  readonly repository: PlanningRepositoryObservation | null;
  readonly plan: Readonly<{ planId: string; requiresScope: boolean; originCommandId: string; scopeApprovalId: string | null }> | null;
}
export const planningMetadataId = (projectId: string): string => `project-metadata:${projectId}`;
export function parsePlanningMetadata(value: unknown): PlanningMetadata {
  try {
    const r = planningObject(value, ["schemaVersion", "kind", "projectId", "repository", "plan"]);
    if (r["schemaVersion"] !== 1 || r["kind"] !== "project-planning-metadata") throw new Error();
    planningId(r["projectId"]);
    if (r["plan"] !== null) {
      const p = planningObject(r["plan"], ["planId", "requiresScope", "originCommandId", "scopeApprovalId"]);
      planningId(p["planId"]); planningId(p["originCommandId"]); if (p["scopeApprovalId"] !== null) planningId(p["scopeApprovalId"]);
      if (typeof p["requiresScope"] !== "boolean") throw new Error();
    }
    if (r["repository"] !== null) {
      const repo = planningObject(r["repository"], ["schemaVersion", "canonicalRoot", "observedAt", "grant", "report"]);
      if (repo["schemaVersion"] !== 1 || repo["grant"] !== "native-folder-selection-read-only" || new Date(String(repo["observedAt"])).toISOString() !== repo["observedAt"]) throw new Error();
      planningText(repo["canonicalRoot"], 4096);
      const report = planningObject(repo["report"], ["state", "canonicalRoot", "rootLeaf", "files", "facts", "unavailable", "totalBytes"]);
      if (report["canonicalRoot"] !== repo["canonicalRoot"] || !["complete", "partial", "unavailable"].includes(String(report["state"]))) throw new Error();
      planningText(report["rootLeaf"], 255); planningInteger(report["totalBytes"]);
      planningArray(report["facts"], (value) => { const fact = planningObject(value, ["kind", "value"]); if (!["ecosystem", "package-manager", "git-head", "git-branch", "git-status"].includes(String(fact["kind"]))) throw new Error(); planningText(fact["value"], 65536); return fact; }, 32);
      planningArray(report["files"], (value) => { const file = planningObject(value, ["relativePath", "kind", "byteLength"]); planningText(file["relativePath"], 255); planningText(file["kind"], 30); planningInteger(file["byteLength"]); return file; }, 128);
      planningArray(report["unavailable"], (value) => { const item = planningObject(value, ["source", "code"]); if (!["filesystem", "git"].includes(String(item["source"]))) throw new Error(); planningText(item["code"], 100); return item; }, 32);
    }
    if (canonicalPlanning(value).length > 131072) throw new Error();
    return value as PlanningMetadata;
  } catch { return refusePlanning("project.metadata-corrupt", "corrupt"); }
}
export async function readPlanningMetadata(tx: TransactionContext, projectId: string): Promise<Readonly<{ value: PlanningMetadata; envelope: AggregateEnvelope }>> {
  const row = await tx.aggregates.get("planning-workspace", planningMetadataId(projectId));
  if (row === null) return refusePlanning("project.metadata-unavailable");
  verifyPlanningEnvelope(row, "planning-workspace", planningMetadataId(projectId));
  const value = parsePlanningMetadata(row.payload);
  if (value.projectId !== projectId) return refusePlanning("project.metadata-corrupt", "corrupt");
  return Object.freeze({ value, envelope: row });
}
export async function writePlanningMetadata(tx: TransactionContext, value: PlanningMetadata, version: number, commandId: string, at: string): Promise<void> {
  await writePlanningAggregate(tx, "planning-workspace", planningMetadataId(value.projectId), parsePlanningMetadata(value), version, commandId, "project.planning-updated", at);
}
