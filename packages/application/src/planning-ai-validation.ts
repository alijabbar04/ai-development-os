import type { AiPlanningCommand, AiPlanningDraft, AiPlanningProposal, AiPlanningQuestion, AiPlanningUnderstanding } from "./planning-ai-contracts.js";
import { canonicalPlanning, planningArray, planningId, planningInteger, planningObject, planningText, refusePlanning } from "./planning-validation.js";

export const AI_PLANNING_COMMANDS = Object.freeze(["start-ai-planning", "save-ai-planning-draft", "request-ai-understanding", "request-ai-proposal", "accept-ai-brief", "adopt-ai-proposal", "cancel-ai-request"]);
export function isAiPlanningCommand(value: { readonly kind: string }): value is AiPlanningCommand { return AI_PLANNING_COMMANDS.includes(value.kind); }
export function aiDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) return refusePlanning("ai.digest");
  return value;
}
export function aiBoolean(value: unknown): boolean { if (typeof value !== "boolean") return refusePlanning("ai.boolean"); return value; }
const texts = (value: unknown, maximum = 12): readonly string[] => planningArray(value, (v) => planningText(v, 2000), maximum);
export function parseAiUnderstanding(value: unknown): AiPlanningUnderstanding {
  const r = planningObject(value, ["summary", "outcomes", "nonGoals", "audiences", "assumptions"]);
  const outcomes = texts(r["outcomes"]), audiences = texts(r["audiences"]);
  if (outcomes.length === 0 || audiences.length === 0) return refusePlanning("ai.understanding-incomplete");
  const parsed = Object.freeze({ summary: planningText(r["summary"], 4000), outcomes, nonGoals: texts(r["nonGoals"]), audiences, assumptions: texts(r["assumptions"]) });
  if (Buffer.byteLength(canonicalPlanning(parsed)) > 16_384) return refusePlanning("ai.understanding-bound");
  return parsed;
}
export function parseAiQuestions(value: unknown): readonly AiPlanningQuestion[] {
  const questions = planningArray(value, (item) => {
    const r = planningObject(item, ["questionId", "question", "whyItMatters", "proposedDefault", "blocking"]);
    return Object.freeze({ questionId: planningId(r["questionId"]), question: planningText(r["question"], 1000), whyItMatters: planningText(r["whyItMatters"], 1000), proposedDefault: planningText(r["proposedDefault"], 1000), blocking: aiBoolean(r["blocking"]) });
  }, 3);
  if (new Set(questions.map((q) => q.questionId)).size !== questions.length) return refusePlanning("ai.duplicate-question");
  return questions;
}
export function parseAiProposal(value: unknown): AiPlanningProposal {
  const r = planningObject(value, ["title", "tasks"]);
  const tasks = planningArray(r["tasks"], (item) => {
    const t = planningObject(item, ["taskId", "title", "objective", "acceptanceCriteria", "dependsOn"]);
    const acceptanceCriteria = texts(t["acceptanceCriteria"], 8), dependsOn = planningArray(t["dependsOn"], planningId, 12);
    if (acceptanceCriteria.length === 0 || new Set(dependsOn).size !== dependsOn.length) return refusePlanning("ai.task-incomplete");
    return Object.freeze({ taskId: planningId(t["taskId"]), title: planningText(t["title"], 300), objective: planningText(t["objective"], 2000), acceptanceCriteria, dependsOn });
  }, 12);
  const ids = new Set(tasks.map((t) => t.taskId));
  if (tasks.length === 0 || ids.size !== tasks.length || tasks.some((t) => t.dependsOn.some((d) => !ids.has(d) || d === t.taskId))) return refusePlanning("ai.task-graph-invalid");
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) return refusePlanning("ai.task-cycle");
    if (visited.has(id)) return;
    visiting.add(id); for (const d of tasks.find((t) => t.taskId === id)!.dependsOn) visit(d);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  const parsed = Object.freeze({ title: planningText(r["title"], 300), tasks });
  if (Buffer.byteLength(canonicalPlanning(parsed)) > 32_768) return refusePlanning("ai.proposal-bound");
  return parsed;
}
export function parseAiDraft(value: unknown): AiPlanningDraft {
  const r = planningObject(value, ["description", "includeRepositorySummary", "answers", "understanding", "proposal"]);
  const answers = planningArray(r["answers"], (item) => { const a = planningObject(item, ["questionId", "value"]); return Object.freeze({ questionId: planningId(a["questionId"]), value: planningText(a["value"], 1024) }); }, 6);
  if (new Set(answers.map((a) => a.questionId)).size !== answers.length) return refusePlanning("ai.answer-duplicate");
  const parsed = Object.freeze({ description: planningText(r["description"], 8000), includeRepositorySummary: aiBoolean(r["includeRepositorySummary"]), answers,
    understanding: r["understanding"] === null ? null : parseAiUnderstanding(r["understanding"]), proposal: r["proposal"] === null ? null : parseAiProposal(r["proposal"]) });
  if (Buffer.byteLength(canonicalPlanning(parsed)) > 65_536) return refusePlanning("ai.draft-bound");
  return parsed;
}
export function parseAiPlanningCommand(value: unknown): AiPlanningCommand {
  const r = planningObject(value), kind = r["kind"];
  const commandId = planningId(r["commandId"]), projectId = planningId(r["projectId"]);
  if (!projectId.startsWith("prj:")) return refusePlanning("input.project");
  let command: AiPlanningCommand;
  if (kind === "start-ai-planning") {
    planningObject(r, ["kind", "commandId", "projectId", "expectedSessionVersion", "description", "includeRepositorySummary"]);
    command = { kind, commandId, projectId, expectedSessionVersion: planningInteger(r["expectedSessionVersion"]), description: planningText(r["description"], 8000), includeRepositorySummary: aiBoolean(r["includeRepositorySummary"]) };
  } else if (kind === "cancel-ai-request") {
    planningObject(r, ["kind", "commandId", "projectId", "sessionId", "requestId"]);
    command = { kind, commandId, projectId, sessionId: planningId(r["sessionId"]), requestId: planningId(r["requestId"]) };
  } else {
    const common = { commandId, projectId, sessionId: planningId(r["sessionId"]), expectedSessionVersion: planningInteger(r["expectedSessionVersion"]) };
    if (kind === "save-ai-planning-draft") {
      planningObject(r, ["kind", "commandId", "projectId", "sessionId", "expectedSessionVersion", "draft"]);
      command = { kind, ...common, draft: parseAiDraft(r["draft"]) };
    } else if (kind === "request-ai-understanding" || kind === "request-ai-proposal" || kind === "accept-ai-brief" || kind === "adopt-ai-proposal") {
      planningObject(r, ["kind", "commandId", "projectId", "sessionId", "expectedSessionVersion", "contextDigest"]);
      command = { kind, ...common, contextDigest: aiDigest(r["contextDigest"]) };
    } else return refusePlanning("input.command");
  }
  if (canonicalPlanning(command).length > 65_536) return refusePlanning("ai.input-bound");
  return Object.freeze(command);
}
