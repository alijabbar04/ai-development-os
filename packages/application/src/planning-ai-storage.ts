import type { AggregateEnvelope, TransactionContext } from "@ai-dev-os/persistence";
import { semanticIntakeKey } from "@ai-dev-os/intake";
import { parsePlanningRequestBinding, type PlanningRequestBinding, type PlanningUsageObservation } from "@ai-dev-os/provider-claude-code";
import { parseProviderUsage } from "@ai-dev-os/providers";
import type { AiPlanningClarificationRound, AiPlanningSessionView, AiPlanningRequestView } from "./planning-ai-contracts.js";
import { listPlanningEvents, parsePlanningConfirmation, verifyPlanningEnvelope, writePlanningAggregate, type PlanningConfirmation } from "./planning-ledger.js";
import { aiBoolean, aiDigest, parseAiDraft, parseAiQuestions } from "./planning-ai-validation.js";
import { canonicalPlanning, digestPlanning, planningArray, planningId, planningInteger, planningObject, planningText, refusePlanning } from "./planning-validation.js";

export interface AiPlanningRequestRecord extends AiPlanningRequestView {
  readonly usageObservation: PlanningUsageObservation | null;
  readonly context: unknown;
  readonly contextDigest: string;
  readonly savedDraftDigest: string;
  readonly foundationDigest: string;
  readonly confirmation: PlanningConfirmation;
  readonly dispatchedAt: string | null;
  readonly routeFingerprint: string;
  readonly qualificationDigest: string;
  readonly dispatchBinding: Readonly<{ binding: PlanningRequestBinding; requestFingerprint: string }> | null;
  readonly terminationConfirmed: boolean | null;
  readonly revoked: boolean;
}
export interface AiPlanningSessionRecord extends Omit<AiPlanningSessionView, "requests"> {
  readonly requests: readonly AiPlanningRequestRecord[];
  readonly acceptedDraftDigest: string | null;
}
export interface AiPlanningRecord {
  readonly schemaVersion: 1;
  readonly kind: "development-planning-session-history";
  readonly authority: "none";
  readonly projectId: string;
  readonly currentSessionId: string | null;
  readonly sessions: readonly AiPlanningSessionRecord[];
}
export interface AiPlanningContribution {
  readonly schemaVersion: 1;
  readonly kind: "development-planning-contribution";
  readonly authority: "none";
  readonly projectId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly purpose: "understanding" | "proposal";
  readonly contextDigest: string;
  readonly artifact: unknown;
  readonly artifactDigest: string;
  readonly output: unknown;
  readonly routeFingerprint: string;
  readonly narrativeRef: string;
  readonly createdAt: string;
}
const nullableDigest = (v: unknown): string | null => v === null ? null : aiDigest(v);
const nullableId = (v: unknown): string | null => v === null ? null : planningId(v);
const date = (v: unknown): string => { if (typeof v !== "string" || new Date(v).toISOString() !== v) throw new Error("AI_DATE"); return v; };
export const aiPlanningRecordId = (projectId: string): string => `ai-planning:${projectId}`;
export const aiContributionId = (digest: string): string => `ai-contribution:${digest}`;
export function parseAiRecord(value: unknown): AiPlanningRecord {
  try {
    const r = planningObject(value, ["schemaVersion", "kind", "authority", "projectId", "currentSessionId", "sessions"]);
    if (r["schemaVersion"] !== 1 || r["kind"] !== "development-planning-session-history" || r["authority"] !== "none") throw new Error();
    planningId(r["projectId"]); nullableId(r["currentSessionId"]);
    const sessions = planningArray(r["sessions"], (value) => {
      const s = planningObject(value, ["sessionId", "createdAt", "updatedAt", "requestCount", "maxRequests", "clarificationRounds", "maxClarificationRounds", "draft", "understandingContributionDigest", "proposalContributionDigest", "acceptedBriefDigest", "adoptedPlanDigest", "questions", "clarificationHistory", "requests", "activeRequestId", "acceptedDraftDigest"]);
      planningId(s["sessionId"]); date(s["createdAt"]); date(s["updatedAt"]);
      if (s["maxRequests"] !== 3 || s["maxClarificationRounds"] !== 2 || String(s["updatedAt"]) < String(s["createdAt"])) throw new Error();
      planningInteger(s["requestCount"], 3); planningInteger(s["clarificationRounds"], 2); parseAiDraft(s["draft"]); parseAiQuestions(s["questions"]);
      for (const key of ["understandingContributionDigest", "proposalContributionDigest", "acceptedBriefDigest", "adoptedPlanDigest", "acceptedDraftDigest"]) nullableDigest(s[key]);
      nullableId(s["activeRequestId"]);
      const requests = planningArray(s["requests"], (value) => {
        const q = planningObject(value, ["requestId", "purpose", "state", "reason", "usageState", "usageObservation", "modelId", "createdAt", "completedAt", "contributionDigest", "context", "contextDigest", "savedDraftDigest", "foundationDigest", "confirmation", "dispatchedAt", "routeFingerprint", "qualificationDigest", "dispatchBinding", "terminationConfirmed", "revoked"]);
        planningId(q["requestId"]); nullableId(q["modelId"]); date(q["createdAt"]);
        if (q["completedAt"] !== null) date(q["completedAt"]);
        if (q["dispatchedAt"] !== null) date(q["dispatchedAt"]);
        if (q["reason"] !== null) planningText(q["reason"], 128);
        if (!["understanding", "proposal"].includes(String(q["purpose"])) || !["intent", "admitted", "dispatched", "succeeded", "refused", "failed", "cancelled", "outcome-unknown", "stale"].includes(String(q["state"])) || !["not-called", "unknown", "reported"].includes(String(q["usageState"]))) throw new Error();
        nullableDigest(q["contributionDigest"]); aiDigest(q["contextDigest"]); aiDigest(q["savedDraftDigest"]); aiDigest(q["foundationDigest"]); aiDigest(q["routeFingerprint"]); parsePlanningConfirmation(q["confirmation"]); aiBoolean(q["revoked"]);
        if (q["terminationConfirmed"] !== null) aiBoolean(q["terminationConfirmed"]);
        if (q["usageObservation"] !== null) {
          const usage = planningObject(q["usageObservation"], ["state", "value", "subscriptionEquivalentUsd"]);
          if (usage["state"] === "reported") {
            parseProviderUsage(usage["value"]);
            const cost = usage["subscriptionEquivalentUsd"];
            if (cost !== null && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) throw new Error();
          } else if (usage["state"] !== "unknown" || usage["value"] !== null || usage["subscriptionEquivalentUsd"] !== null) throw new Error();
        }
        if (q["usageState"] === "reported" && (q["usageObservation"] === null || planningObject(q["usageObservation"])["state"] !== "reported")) throw new Error();
        aiDigest(q["qualificationDigest"]);
        if (q["dispatchBinding"] !== null) {
          const d = planningObject(q["dispatchBinding"], ["binding", "requestFingerprint"]), binding = parsePlanningRequestBinding(d["binding"]); aiDigest(d["requestFingerprint"]);
          if (binding.requestId !== q["requestId"] || binding.sessionId !== s["sessionId"] || binding.projectId !== r["projectId"] || binding.modelId !== q["modelId"]) throw new Error();
        }
        if ((q["dispatchBinding"] === null) !== (q["dispatchedAt"] === null)) throw new Error();
        if (digestPlanning(q["context"]) !== q["contextDigest"] || canonicalPlanning(q["context"]).length > 32_768) throw new Error();
        if (q["dispatchedAt"] !== null && q["usageState"] === "not-called" || q["state"] === "succeeded" && (q["contributionDigest"] === null || q["revoked"] === true || q["dispatchedAt"] === null)) throw new Error();
        return value as AiPlanningRequestRecord;
      }, 3);
      if (requests.length !== s["requestCount"] || requests.filter((q) => q.purpose === "understanding").length !== s["clarificationRounds"] || new Set(requests.map((q) => q.requestId)).size !== requests.length) throw new Error();
      const history = planningArray(s["clarificationHistory"], (value): AiPlanningClarificationRound => {
        const h = planningObject(value, ["round", "requestId", "questions", "answers", "materialChangeReason"]);
        if (h["round"] !== 1 && h["round"] !== 2) throw new Error();
        const requestId = planningId(h["requestId"]), questions = parseAiQuestions(h["questions"]);
        const answers = planningArray(h["answers"], (value) => {
          const a = planningObject(value, ["questionId", "value"]);
          return { questionId: planningId(a["questionId"]), value: planningText(a["value"], 1024) };
        }, 3);
        if (new Set(answers.map((a) => a.questionId)).size !== answers.length || answers.some((a) => !questions.some((q) => q.questionId === a.questionId))) throw new Error();
        const materialChangeReason = h["materialChangeReason"] === null ? null : planningText(h["materialChangeReason"], 2000);
        const request = requests.find((q) => q.requestId === requestId);
        if (request?.purpose !== "understanding" || request.state !== "succeeded" || request.contributionDigest === null || materialChangeReason !== planningObject(request.context)["clarificationMaterialChangeReason"]) throw new Error();
        return { round: h["round"], requestId, questions, answers, materialChangeReason };
      }, 2);
      if (history.length > Number(s["clarificationRounds"]) || new Set(history.map((h) => h.requestId)).size !== history.length
        || history.some((h, i) => h.round !== i + 1 || (i === 0) !== (h.materialChangeReason === null))
        || history.slice(0, -1).some((h) => h.questions.some((q) => !h.answers.some((a) => a.questionId === q.questionId)))) throw new Error();
      const questionIds = history.flatMap((h) => h.questions.map((q) => q.questionId));
      const questionKeys = history.flatMap((h) => h.questions.map((q) => semanticIntakeKey(q.question)));
      if (new Set(questionIds).size !== questionIds.length || new Set(questionKeys).size !== questionKeys.length
        || history.some((h, i) => canonicalPlanning(planningObject(requests.find((q) => q.requestId === h.requestId)!.context)["clarificationHistory"]) !== canonicalPlanning(history.slice(0, i)))) throw new Error();
      const draft = parseAiDraft(s["draft"]), latest = history.at(-1);
      if (draft.understanding !== null && (latest === undefined || canonicalPlanning(latest.questions) !== canonicalPlanning(s["questions"]) || canonicalPlanning(latest.answers) !== canonicalPlanning(draft.answers))) throw new Error();
      const active = requests.filter((q) => ["intent", "admitted", "dispatched"].includes(q.state));
      if (active.length > 1 || (active[0]?.requestId ?? null) !== s["activeRequestId"]) throw new Error();
      return value as AiPlanningSessionRecord;
    }, 16);
    if (new Set(sessions.map((s) => s.sessionId)).size !== sessions.length || (sessions.at(-1)?.sessionId ?? null) !== r["currentSessionId"] || sessions.slice(0, -1).some((s) => s.activeRequestId !== null) || canonicalPlanning(value).length > 2_097_152) throw new Error();
    return value as AiPlanningRecord;
  } catch { return refusePlanning("ai.session-corrupt", "corrupt"); }
}
export async function readAiRecord(tx: TransactionContext, projectId: string): Promise<{ record: AiPlanningRecord; envelope: AggregateEnvelope | null; version: number }> {
  const id = aiPlanningRecordId(projectId), envelope = await tx.aggregates.get("planning-ai-session", id);
  if (envelope === null) {
    if ((await listPlanningEvents(tx, "planning-ai-session", id)).length !== 0) return refusePlanning("ai.session-journal-corrupt", "corrupt");
    return { envelope, version: 0, record: { schemaVersion: 1, kind: "development-planning-session-history", authority: "none", projectId, currentSessionId: null, sessions: [] } };
  }
  verifyPlanningEnvelope(envelope, "planning-ai-session", id);
  const record = parseAiRecord(envelope.payload), events = await listPlanningEvents(tx, "planning-ai-session", id);
  if (record.projectId !== projectId || events.length !== envelope.aggregateVersion || events.some((e, i) => e.aggregateVersion !== i + 1) || canonicalPlanning(planningObject(events.at(-1)!.payload)["record"]) !== canonicalPlanning(record)) return refusePlanning("ai.session-journal-corrupt", "corrupt");
  for (const session of record.sessions) {
    const priorQuestionKeys = new Set<string>();
    for (const round of session.clarificationHistory) {
      const request = session.requests.find((q) => q.requestId === round.requestId)!;
      const contribution = await readAiContribution(tx, request.contributionDigest!, projectId, session.sessionId);
      if (contribution.requestId !== request.requestId || contribution.purpose !== "understanding" || contribution.contextDigest !== request.contextDigest || contribution.routeFingerprint !== request.routeFingerprint) return refusePlanning("ai.clarification-history-corrupt", "corrupt");
      const original = parseAiQuestions(planningObject(contribution.output, ["understanding", "questions"])["questions"]);
      const expected = original.filter((question) => {
        const key = semanticIntakeKey(question.question);
        if (priorQuestionKeys.has(key)) return false;
        priorQuestionKeys.add(key); return true;
      });
      if (canonicalPlanning(expected) !== canonicalPlanning(round.questions)) return refusePlanning("ai.clarification-history-corrupt", "corrupt");
    }
  }
  return { record, envelope, version: envelope.aggregateVersion };
}
export async function writeAiRecord(tx: TransactionContext, record: AiPlanningRecord, version: number, commandId: string, at: string, event = "ai.session-updated"): Promise<void> {
  // Keep all retained sessions readable within the unchanged desktop reply
  // bound. Admission reserves room for one bounded result before dispatch.
  if (Buffer.byteLength(canonicalPlanning(record)) > 524_288) return refusePlanning("ai.history-capacity");
  await writePlanningAggregate(tx, "planning-ai-session", aiPlanningRecordId(record.projectId), parseAiRecord(record), version, commandId, event, at);
}
export function replaceAiSession(record: AiPlanningRecord, session: AiPlanningSessionRecord): AiPlanningRecord {
  return { ...record, sessions: record.sessions.map((s) => s.sessionId === session.sessionId ? session : s) };
}
export function parseAiContribution(value: unknown): AiPlanningContribution {
  try {
    const r = planningObject(value, ["schemaVersion", "kind", "authority", "projectId", "sessionId", "requestId", "purpose", "contextDigest", "artifact", "artifactDigest", "output", "routeFingerprint", "narrativeRef", "createdAt"]);
    if (r["schemaVersion"] !== 1 || r["kind"] !== "development-planning-contribution" || r["authority"] !== "none" || !["understanding", "proposal"].includes(String(r["purpose"]))) throw new Error();
    planningId(r["projectId"]); planningId(r["sessionId"]); planningId(r["requestId"]); planningId(r["narrativeRef"]); aiDigest(r["contextDigest"]); aiDigest(r["artifactDigest"]); aiDigest(r["routeFingerprint"]); date(r["createdAt"]);
    if (digestPlanning(r["artifact"]) !== r["artifactDigest"] || canonicalPlanning(value).length > 524_288) throw new Error();
    return value as AiPlanningContribution;
  } catch { return refusePlanning("ai.contribution-corrupt", "corrupt"); }
}
export async function readAiContribution(tx: TransactionContext, digest: string, projectId: string, sessionId: string): Promise<AiPlanningContribution> {
  const id = aiContributionId(aiDigest(digest)), row = await tx.aggregates.get("planning-ai-contribution", id);
  if (row === null) return refusePlanning("ai.contribution-absent", "corrupt");
  verifyPlanningEnvelope(row, "planning-ai-contribution", id); const value = parseAiContribution(row.payload);
  const events = await listPlanningEvents(tx, "planning-ai-contribution", id, 1);
  if (row.aggregateVersion !== 1 || digestPlanning(value) !== digest || value.projectId !== projectId || value.sessionId !== sessionId || events.length !== 1 || events[0]!.aggregateVersion !== 1 || canonicalPlanning(planningObject(events[0]!.payload)["record"]) !== canonicalPlanning(value)) return refusePlanning("ai.contribution-corrupt", "corrupt");
  return value;
}
