import { assembleCandidate, applyClarificationsToCandidate, createClarificationSession, openClarificationRound, resolveClarificationRound, prepareCandidateAcceptance, createC7IntakeStore, IntakeError, type IntakeTextField, type ProposedIntakeQuestion } from "@ai-dev-os/intake";
import type { TransactionContext } from "@ai-dev-os/persistence";
import type { AiPlanningSessionRecord, AiPlanningContribution } from "./planning-ai-storage.js";
import type { PlanningFoundations } from "./planning-plan.js";
import { planningTransactionAdapter, type PlanningConfirmation } from "./planning-ledger.js";
import { parseAiUnderstanding } from "./planning-ai-validation.js";
import { planningHash, planningObject, refusePlanning } from "./planning-validation.js";

/** Explicit native acceptance of a saved preview through the canonical C8 store. */
export async function acceptAiPlanningBrief(tx: TransactionContext, f: PlanningFoundations, session: AiPlanningSessionRecord, original: AiPlanningContribution, confirmation: PlanningConfirmation): Promise<unknown> {
  const draft = session.draft, understanding = draft.understanding;
  if (understanding === null || f.head?.plan.state === "awaiting_scope_approval") return refusePlanning("ai.brief-acceptance-unavailable");
  const originalUnderstanding = parseAiUnderstanding(planningObject(original.output, ["understanding", "questions"])["understanding"]);
  // The operator's own description remains the objective. A model's rendering
  // is preserved as a preview; it cannot claim to be an operator-authored goal.
  const operatorField = (value: string): IntakeTextField => ({ value, provenance: { source: "operator-supplied", acceptedByOperator: true } });
  const fields = (values: readonly string[], modelValues: readonly string[]): readonly IntakeTextField[] => values.map((value) => ({ value, provenance: { source: modelValues.includes(value) ? "model-proposed" : "operator-supplied", acceptedByOperator: true } }));
  // Application questions carry no machine constraint classification. Their
  // answers are required by this workflow, then faithfully recorded as C8
  // clarification answers without inventing a blocking machine-policy basis.
  const questions: ProposedIntakeQuestion[] = [];
  let clarification = createClarificationSession();
  if (session.clarificationHistory.length === 0) return refusePlanning("ai.clarification-history-unavailable");
  for (const round of session.clarificationHistory) {
    const proposed: readonly ProposedIntakeQuestion[] = round.questions.map((q) => ({ question: { ...q, theme: "scope", options: null, consequenceIfDefaulted: "The planning preview remains unaccepted until the operator answers.", blocking: false }, blockingBasis: null,
      provenance: { source: "model-proposed", acceptedByOperator: false }, source: "derived" }));
    const answers = proposed.map((q) => {
      const answer = round.answers.find((a) => a.questionId === q.question.questionId);
      if (answer === undefined) return refusePlanning("ai.clarification-answer-required");
      return { kind: "answered" as const, questionId: answer.questionId, value: answer.value };
    });
    clarification = resolveClarificationRound(openClarificationRound({ session: clarification, questions: proposed, knownFacts: [], materialChangeReason: round.materialChangeReason }, planningHash), round.round, answers, planningHash);
    questions.push(...proposed);
  }
  const candidate = applyClarificationsToCandidate(assembleCandidate({ projectId: f.project.projectId, objective: operatorField(draft.description),
    outcomes: fields(understanding.outcomes, originalUnderstanding.outcomes), nonGoals: fields(understanding.nonGoals, originalUnderstanding.nonGoals), audiences: fields(understanding.audiences, originalUnderstanding.audiences),
    constraints: (f.accepted?.brief.constraints ?? []).map((value) => ({ value, possible: true, provenance: { source: value.origin === "operator" ? "operator-supplied" : value.origin === "model" ? "model-proposed" : "approved-observation", acceptedByOperator: true } })),
    assumptions: understanding.assumptions.map((text) => ({ text, source: originalUnderstanding.assumptions.includes(text) ? "model" : "operator", confirmed: true, provenance: { source: originalUnderstanding.assumptions.includes(text) ? "model-proposed" : "operator-supplied", acceptedByOperator: true } })),
    openQuestions: questions, sourceThreadId: null }, planningHash), clarification, planningHash);
  const prepared = prepareCandidateAcceptance({ candidate, presentedDigest: candidate.candidateDigest, expectedHead: f.accepted?.brief ?? null,
    expectedAggregateVersion: f.accepted?.aggregateVersion ?? 0, clarification, operatorConfirmed: true }, { digest: planningHash, clock: { now: () => new Date(confirmation.confirmedAt) } });
  const outcome = await createC7IntakeStore(planningTransactionAdapter(tx), planningHash).attempt(prepared);
  if (outcome.kind === "unknown") throw new IntakeError("intake.persistence.unknown", "store");
  if (outcome.kind !== "committed") return refusePlanning("ai.brief-write-unconfirmed", outcome.kind === "conflict" ? "conflict" : "refused");
  return prepared;
}
