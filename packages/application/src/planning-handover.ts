import { lstat, open, opendir, link, unlink } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { TransactionContext } from "@ai-dev-os/persistence";
import { canonicalPlanningDirectory, type PlanningRepositoryObservation } from "./planning-repository.js";
import { listPlanningAggregates, verifyPlanningEnvelope } from "./planning-ledger.js";
import type { PlanningFoundations } from "./planning-plan.js";
import { canonicalPlanning, digestPlanning, planningArray, planningHash, planningId, planningObject, planningText, refusePlanning } from "./planning-validation.js";

export interface PlanningHandoverRecord {
  readonly schemaVersion: 1;
  readonly kind: "planning-handover";
  readonly authority: "none";
  readonly handoverId: string;
  readonly projectId: string;
  readonly projectDigest: string;
  readonly briefId: string;
  readonly briefVersion: number;
  readonly briefDigest: string;
  readonly planId: string;
  readonly planRevision: number;
  readonly planVersion: number;
  readonly planDigest: string;
  readonly createdAt: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly result: Readonly<{ attribution: "operator-supplied-untrusted"; text: string; sourceName: string; attachedAt: string; sourceDigest: string }> | null;
}
export function createPlanningHandover(f: PlanningFoundations, repository: PlanningRepositoryObservation | null, commandId: string, at: string): PlanningHandoverRecord {
  if (f.accepted === null || f.head === null) return refusePlanning("handover.plan-required");
  const handoverId = `planning-handover:${digestPlanning(commandId).slice(0, 32)}`, plan = f.head.plan;
  const binding = { projectId: f.project.projectId, projectDigest: f.projectEnvelope.checksum.hex, briefId: f.accepted.brief.briefId, briefVersion: f.accepted.aggregateVersion,
    briefDigest: f.accepted.briefContentDigest, planId: plan.planId, planRevision: plan.revision, planVersion: f.head.aggregateVersion, planDigest: plan.planDigest };
  const document = {
    schemaVersion: 1, kind: "planning-handover", authority: "none", handoverId, ...binding, createdAt: at,
    projectName: f.project.displayName, objective: f.accepted.brief.objective, outcomes: f.accepted.brief.outcomes, nonGoals: f.accepted.brief.nonGoals, planState: plan.state,
    stages: plan.stages.map((s) => ({ title: s.title, intent: s.intent, exitCriteria: s.exitCriteria })),
    tasks: plan.tasks.map((t) => ({ taskId: t.taskId, title: t.title, objective: t.objective, acceptanceCriteria: t.acceptance.map((a) => a.criterion) })),
    repositoryObservation: repository === null ? null : { rootLeaf: repository.report.rootLeaf, canonicalRoot: repository.canonicalRoot, observedAt: repository.observedAt, state: repository.report.state, facts: repository.report.facts, digest: digestPlanning(repository) },
    instructions: "Manually inspect this planning context in your chosen tool. It grants no execution, spending, repository write, or approval authority. Returned text is an untrusted operator-supplied report.",
    returnTemplate: { schemaVersion: 1, kind: "planning-manual-result", authority: "none", handoverId, projectId: binding.projectId, briefDigest: binding.briefDigest, planDigest: binding.planDigest, text: "Replace this text with your manually returned report." },
  };
  return Object.freeze({ schemaVersion: 1, kind: "planning-handover", authority: "none", handoverId, ...binding, createdAt: at, document: Object.freeze(document), result: null });
}
export function parsePlanningHandover(value: unknown): PlanningHandoverRecord {
  try {
    const r = planningObject(value, ["schemaVersion", "kind", "authority", "handoverId", "projectId", "projectDigest", "briefId", "briefVersion", "briefDigest", "planId", "planRevision", "planVersion", "planDigest", "createdAt", "document", "result"]);
    if (r["schemaVersion"] !== 1 || r["kind"] !== "planning-handover" || r["authority"] !== "none") throw new Error();
    for (const key of ["handoverId", "projectId", "briefId", "planId"]) planningId(r[key]);
    for (const key of ["projectDigest", "briefDigest", "planDigest"]) if (!/^[a-f0-9]{64}$/u.test(String(r[key]))) throw new Error();
    for (const key of ["briefVersion", "planRevision", "planVersion"]) if (!Number.isSafeInteger(r[key]) || (r[key] as number) < 1) throw new Error();
    if (new Date(String(r["createdAt"])).toISOString() !== r["createdAt"]) throw new Error();
    const document = planningObject(r["document"], ["schemaVersion", "kind", "authority", "handoverId", "projectId", "projectDigest", "briefId", "briefVersion", "briefDigest", "planId", "planRevision", "planVersion", "planDigest", "createdAt", "projectName", "objective", "outcomes", "nonGoals", "planState", "stages", "tasks", "repositoryObservation", "instructions", "returnTemplate"]);
    for (const key of ["schemaVersion", "kind", "authority", "handoverId", "projectId", "projectDigest", "briefId", "briefVersion", "briefDigest", "planId", "planRevision", "planVersion", "planDigest", "createdAt"]) if (document[key] !== r[key]) throw new Error();
    planningText(document["projectName"], 300); planningText(document["objective"], 4000);
    for (const key of ["outcomes", "nonGoals"]) planningArray(document[key], (item) => planningText(item, 2000), 64);
    if (!["drafting", "awaiting_scope_approval", "proposed", "sealed", "superseded"].includes(String(document["planState"]))) throw new Error();
    planningArray(document["stages"], (item) => { const s = planningObject(item, ["title", "intent", "exitCriteria"]); planningText(s["title"], 300); planningText(s["intent"], 4000); planningArray(s["exitCriteria"], (criterion) => planningText(criterion, 2000), 64); return s; }, 32);
    planningArray(document["tasks"], (item) => { const t = planningObject(item, ["taskId", "title", "objective", "acceptanceCriteria"]); planningId(t["taskId"]); planningText(t["title"], 300); planningText(t["objective"], 2000); planningArray(t["acceptanceCriteria"], (criterion) => planningText(criterion, 2000), 16); return t; }, 32);
    if (document["repositoryObservation"] !== null) {
      const repo = planningObject(document["repositoryObservation"], ["rootLeaf", "canonicalRoot", "observedAt", "state", "facts", "digest"]);
      planningText(repo["rootLeaf"], 300); planningText(repo["canonicalRoot"], 4096);
      if (new Date(String(repo["observedAt"])).toISOString() !== repo["observedAt"] || !["complete", "partial", "unavailable"].includes(String(repo["state"])) || !/^[a-f0-9]{64}$/u.test(String(repo["digest"])) || !Array.isArray(repo["facts"])) throw new Error();
    }
    if (document["instructions"] !== "Manually inspect this planning context in your chosen tool. It grants no execution, spending, repository write, or approval authority. Returned text is an untrusted operator-supplied report.") throw new Error();
    const template = planningObject(document["returnTemplate"], ["schemaVersion", "kind", "authority", "handoverId", "projectId", "briefDigest", "planDigest", "text"]);
    if (template["schemaVersion"] !== 1 || template["kind"] !== "planning-manual-result" || template["authority"] !== "none") throw new Error();
    for (const key of ["handoverId", "projectId", "briefDigest", "planDigest"]) if (template[key] !== r[key]) throw new Error();
    planningText(template["text"], 16_384);
    if (r["result"] !== null) {
      const result = planningObject(r["result"], ["attribution", "text", "sourceName", "attachedAt", "sourceDigest"]);
      if (result["attribution"] !== "operator-supplied-untrusted" || !/^[a-f0-9]{64}$/u.test(String(result["sourceDigest"])) || new Date(String(result["attachedAt"])).toISOString() !== result["attachedAt"]) throw new Error();
      planningText(result["text"], 16_384); planningText(result["sourceName"], 200);
    }
    if (canonicalPlanning(value).length > 262_144) throw new Error();
    return value as PlanningHandoverRecord;
  } catch { return refusePlanning("handover.corrupt", "corrupt"); }
}
export function planningHandoverStale(record: PlanningHandoverRecord, f: PlanningFoundations): boolean {
  return record.projectDigest !== f.projectEnvelope.checksum.hex || record.briefDigest !== f.accepted?.briefContentDigest || record.planId !== f.head?.plan.planId || record.planDigest !== f.head?.plan.planDigest
    || record.planVersion !== f.head?.aggregateVersion;
}
export function attachPlanningManualResult(record: PlanningHandoverRecord, source: Readonly<{ name: string; text: string }>, at: string): PlanningHandoverRecord {
  if (record.result !== null) return refusePlanning("handover.result-already-attached", "conflict");
  if (Buffer.byteLength(source.text, "utf8") > 65_536) return refusePlanning("handover.import-too-large");
  let raw: unknown; try { raw = JSON.parse(source.text); } catch { return refusePlanning("handover.import-json-required"); }
  const input = planningObject(raw, ["schemaVersion", "kind", "authority", "handoverId", "projectId", "briefDigest", "planDigest", "text"]);
  if (input["schemaVersion"] !== 1 || input["kind"] !== "planning-manual-result" || input["authority"] !== "none"
    || input["handoverId"] !== record.handoverId || input["projectId"] !== record.projectId || input["briefDigest"] !== record.briefDigest || input["planDigest"] !== record.planDigest) return refusePlanning("handover.import-binding-mismatch", "conflict");
  return parsePlanningHandover({ ...record, result: { attribution: "operator-supplied-untrusted", text: planningText(input["text"], 16_384), sourceName: planningText(source.name, 200), attachedAt: at, sourceDigest: planningHash.sha256(source.text) } });
}
export function planningHandoverFileName(record: PlanningHandoverRecord): string { return `planning-handover-${digestPlanning(record.handoverId).slice(0, 24)}.json`; }
async function verifyArtifact(root: string, target: string, bytes: string): Promise<void> {
  const expected = Buffer.from(bytes, "utf8"), before = await lstat(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(expected.length)) return refusePlanning("handover.file-conflict", "conflict");
  const file = await open(target, "r");
  try {
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) return refusePlanning("handover.file-conflict", "conflict");
    // The acknowledged document bounds allocation and I/O even if the file
    // grows after stat. Compare exact bytes, without unbounded readFile/decode.
    const buffer = Buffer.alloc(expected.length + 1); let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const part = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (part.bytesRead === 0) break; bytesRead += part.bytesRead;
    }
    if (bytesRead !== expected.length || !buffer.subarray(0, bytesRead).equals(expected)) return refusePlanning("handover.file-conflict", "conflict");
    // A crash after atomic publication can leave our staging link. Reconcile
    // only an exact staging name, inode and complete document in this app root.
    // Unknown links and files are preserved, never overwritten or swept.
    if (opened.nlink > 1n) {
      const directory = await opendir(root); let visited = 0;
      for await (const entry of directory) {
        if (++visited > 1024) return refusePlanning("handover.artifact-bound");
        if (!entry.name.startsWith(`${basename(target)}.`) || !/\.[a-f0-9-]{36}\.pending$/u.test(entry.name)) continue;
        const staging = join(root, entry.name), stat = await lstat(staging, { bigint: true });
        if (stat.isFile() && !stat.isSymbolicLink() && stat.ino === opened.ino && stat.dev === opened.dev && await canonicalPlanningDirectory(root) === root) await unlink(staging);
      }
    }
    const after = await file.stat({ bigint: true }), named = await lstat(target, { bigint: true });
    if (after.ino !== before.ino || after.dev !== before.dev || after.nlink !== 1n || after.size !== before.size || after.mtimeNs !== before.mtimeNs || !named.isFile() || named.isSymbolicLink()
      || named.ino !== after.ino || named.dev !== after.dev || named.size !== after.size || named.mtimeNs !== after.mtimeNs || named.nlink !== 1n || await canonicalPlanningDirectory(root) !== root) return refusePlanning("handover.file-conflict", "conflict");
  } finally { await file.close(); }
}
async function publishArtifact(root: string, target: string, bytes: string): Promise<void> {
  try { await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const staging = `${target}.${randomUUID()}.pending`, file = await open(staging, "wx", 0o600);
    let identity: BigIntStats | null = null;
    try {
      identity = await file.stat({ bigint: true });
      await file.writeFile(bytes, "utf8"); await file.sync();
      const written = await file.stat({ bigint: true }); await file.close();
      if (await canonicalPlanningDirectory(root) !== root) return refusePlanning("handover.file-conflict", "conflict");
      const staged = await lstat(staging, { bigint: true });
      if (!staged.isFile() || staged.isSymbolicLink() || staged.ino !== identity.ino || staged.dev !== identity.dev || staged.nlink !== 1n
        || staged.size !== BigInt(Buffer.byteLength(bytes)) || staged.mtimeNs !== written.mtimeNs) return refusePlanning("handover.file-conflict", "conflict");
      // link is atomic and refuses an existing target on both supported Node
      // platforms. A partially written document can never become the target.
      try { await link(staging, target); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "EEXIST") throw failure; }
    } finally {
      await file.close();
      if (identity !== null) {
        const named = await lstat(staging, { bigint: true });
        if (named.isFile() && !named.isSymbolicLink() && named.ino === identity.ino && named.dev === identity.dev && await canonicalPlanningDirectory(root) === root) await unlink(staging);
      }
    }
  }
  await verifyArtifact(root, target, bytes);
}
/** Materialize acknowledged documents idempotently after commit or after restart.
 * An existing different file is preserved and refused, never overwritten. */
export async function materializePlanningHandovers(tx: TransactionContext, artifactRoot: string): Promise<void> {
  const records = await listPlanningAggregates(tx, "planning-handover", 256);
  const root = await canonicalPlanningDirectory(artifactRoot);
  for (const envelope of records) {
    verifyPlanningEnvelope(envelope, "planning-handover");
    const record = parsePlanningHandover(envelope.payload);
    if (record.handoverId !== envelope.aggregateId) return refusePlanning("handover.identity-corrupt", "corrupt");
    const target = join(root, planningHandoverFileName(record)), bytes = `${JSON.stringify(record.document, null, 2)}\n`;
    await publishArtifact(root, target, bytes);
  }
}
