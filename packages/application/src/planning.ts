import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createBudgetAccount, parseAggregateBudget } from "@ai-dev-os/domain";
import { assembleCandidate, applyClarificationsToCandidate, createClarificationSession, openClarificationRound, resolveClarificationRound, prepareCandidateAcceptance, createC7IntakeStore, type CandidateBrief, type CandidateDraftInput, type ClarificationSession } from "@ai-dev-os/intake";
import type { PersistenceAdapter, TransactionContext } from "@ai-dev-os/persistence";
import { parseProject, parseProjectStop, isProjectStopActive, type ProjectPlan } from "@ai-dev-os/project";
import { assertSealConditions, blockingOpenQuestionIds, consumePlanScopeApproval, operationKindsOf, promoteDraft, sealProposedPlan, type IssuedPlanCommitFacts, type PlanCommitAuthorization, type PlanCommitRequest, type PlanHeadEventPayload } from "@ai-dev-os/plan";
import { createPlanPersistenceBoundary } from "@ai-dev-os/plan/persistence-boundary";
import { evaluateApprovalOperation, evaluateHistoricalMoneyCompletion, parseApprovalOperation, type ApprovalOperation } from "@ai-dev-os/approval";
import type { PlanningCommand, PlanningCommandResult, PlanningHandoverView, PlanningProjectSummary, PlanningProjectView, PlanningWorkspaceView } from "./planning-contracts.js";
import { canonicalPlanning, digestPlanning, parsePlanningCommand, planningHash, planningId, planningObject, PlanningRefusal, refusePlanning } from "./planning-validation.js";
import { capturePlanningEffects, listPlanningAggregates, listPlanningEvents, observePlanningReceipt, planningTransactionAdapter, recordPlanningIntent, recordPlanningReceipt, verifyPlanningEnvelope, writePlanningAggregate, type PlanningConfirmation, type PlanningReceipt, type PlanningReceiptResult } from "./planning-ledger.js";
import { assertPlanningAdmission, bindPlanningSteps, draftPlanningRequest, operatorPlanningEvidence, planningCeiling, planningDecision, readPlanningFoundations, type PlanningFoundations, type PlanningUnboundStep } from "./planning-plan.js";
import { createPlanningApprovalOwner, preparePlanningScopeApproval, prospectiveScopeConsumption, readJointScopeConsumption, readPlanningApprovalControls, readPlanningApprovalPair, verifyPlanningApprovalHistory, verifyPlanningMoneyHistory, writeJointScopeConsumption } from "./planning-approval.js";
import { inspectPlanningRepository, type PlanningRepositoryObservation } from "./planning-repository.js";
import { readPlanningMetadata, writePlanningMetadata, type PlanningMetadata } from "./planning-metadata.js";
import { attachPlanningManualResult, createPlanningHandover, materializePlanningHandovers, parsePlanningHandover, planningHandoverFileName, planningHandoverStale } from "./planning-handover.js";

export type { PlanningCommand, PlanningCommandResult, PlanningWorkspaceView } from "./planning-contracts.js";
export { parsePlanningCommand } from "./planning-validation.js";
export interface PlanningNativeReview { readonly reviewId: string; readonly action: PlanningCommand["kind"]; readonly title: string; readonly detail: string; readonly subjectDigest: string }
/** This port belongs to the trusted native host, never to a renderer IPC payload. */
export interface PlanningOperatorPort {
  confirm(review: PlanningNativeReview): Promise<boolean>;
  selectRepository(): Promise<string | null>;
  selectResult(): Promise<Readonly<{ name: string; text: string }> | null>;
}
export interface SavedPlanningApplication {
  initialize(): Promise<void>;
  snapshot(projectId: string | null): Promise<PlanningWorkspaceView>;
  handover(projectId: string, handoverId: string): Promise<PlanningHandoverView>;
  command(value: unknown): Promise<PlanningCommandResult>;
  observe(commandId: string): Promise<PlanningCommandResult>;
  drain(): Promise<void>;
}
type DurableCommand = Extract<PlanningCommand, { commandId: string }>;
interface EphemeralCandidate { readonly candidateId: string; readonly value: CandidateBrief; readonly clarification: ClarificationSession; readonly expectedBriefVersion: number }
interface CommandBasis { readonly f: PlanningFoundations | null; readonly metadata: Awaited<ReturnType<typeof readPlanningMetadata>> | null; readonly digest: string; readonly detail: unknown }
const titles: Record<PlanningCommand["kind"], string> = {
  "create-project": "Create this local project", "draft-brief": "Review this temporary brief", "answer-clarification": "Use these clarification answers", "accept-brief": "Save this exact accepted brief",
  "select-repository": "Save this repository read grant", "save-plan": "Save this manually authored plan", "prepare-plan": "Prepare this exact plan for review", "approve-scope": "Approve this scope and seal the plan",
  "seal-plan": "Seal this exact plan", "stop-project": "Stop local project operations", "resume-project": "Resume local project operations", "export-handover": "Export this planning context",
  "attach-result": "Attach this untrusted manual report", "historical-money": "Record a historical spending fact",
};
function candidateDraft(projectId: string, input: { objective: string; outcomes: readonly string[]; nonGoals?: readonly string[]; audiences?: readonly string[] }): EphemeralCandidate {
  const provenance = { source: "operator-supplied" as const, acceptedByOperator: true }, field = (value: string) => ({ value, provenance });
  const question = { questionId: "q:required-outcome", theme: "scope" as const, question: "What observable outcome should this project achieve?", whyItMatters: "An accepted brief needs a concrete outcome.", options: null,
    proposedDefault: "Describe one outcome before accepting the brief.", consequenceIfDefaulted: "The brief stays unaccepted.", blocking: true };
  const openQuestions = input.outcomes.length > 0 ? [] : [{ question, blockingBasis: "required-outcome" as const, provenance: { source: "derived-deterministically" as const, acceptedByOperator: false }, source: "derived" as const }];
  const value = assembleCandidate({ projectId, objective: field(input.objective), outcomes: input.outcomes.map(field), nonGoals: (input.nonGoals ?? []).map(field),
    audiences: input.audiences?.length ? input.audiences.map(field) : [{ value: "The project operator", provenance: { source: "proposed-default", acceptedByOperator: false } }],
    constraints: [], assumptions: [], openQuestions, sourceThreadId: null }, planningHash);
  const clarification = openQuestions.length === 0 ? createClarificationSession() : openClarificationRound({ session: createClarificationSession(), questions: openQuestions, knownFacts: [], materialChangeReason: null }, planningHash);
  return { candidateId: `candidate:${randomUUID()}`, value, clarification, expectedBriefVersion: 0 };
}
function result(kind: PlanningCommandResult["kind"], commandId: string | null, projectId: string | null, reason: string | null = null, workspace: PlanningWorkspaceView | null = null): PlanningCommandResult {
  return Object.freeze({ kind, commandId, reason, projectId, workspace });
}
function safeFailure(error: unknown, id: string | null, projectId: string | null): PlanningCommandResult {
  if (error instanceof PlanningRefusal) return result(error.kind, id, projectId, error.reason);
  if (error !== null && typeof error === "object" && "ruleId" in error && typeof error.ruleId === "string") return result("refused", id, projectId, error.ruleId);
  if (error !== null && typeof error === "object" && "reason" in error && typeof error.reason === "string") return result("refused", id, projectId, error.reason);
  if (error instanceof Error && "code" in error && typeof error.code === "string" && /^(PROJECT_|DOMAIN_|INTAKE_)/u.test(error.code)) return result("refused", id, projectId, "command.contract-refused");
  return result("unknown", id, projectId, "command.outcome-unconfirmed");
}
function ensureVersion(command: PlanningCommand, f: PlanningFoundations): void {
  if ("expectedProjectVersion" in command && command.expectedProjectVersion !== f.projectEnvelope.aggregateVersion
    || "expectedBriefVersion" in command && command.expectedBriefVersion !== (f.accepted?.aggregateVersion ?? 0)
    || "expectedPlanVersion" in command && command.expectedPlanVersion !== (f.head?.aggregateVersion ?? 0)) return refusePlanning("command.version-conflict", "conflict");
}

export function createSavedPlanningApplication(options: Readonly<{ persistence: PersistenceAdapter; artifactRoot: string; operator: PlanningOperatorPort; clock?: { now(): Date } }>): SavedPlanningApplication {
  const { persistence, operator } = options, clock = options.clock ?? { now: () => new Date() };
  const candidates = new Map<string, EphemeralCandidate>(), active = new Map<string, Promise<PlanningCommandResult>>();
  const ephemeral = new Set<Promise<unknown>>();
  let initialized = false, closing = false;
  const now = (): string => clock.now().toISOString();
  async function basis(tx: TransactionContext, command: PlanningCommand): Promise<CommandBasis> {
    const policy = await tx.aggregates.get("planning-workspace", "local-planning-policy");
    if (policy === null) return refusePlanning("policy.unavailable");
    verifyPlanningEnvelope(policy, "planning-workspace", "local-planning-policy");
    if (canonicalPlanning(policy.payload) !== canonicalPlanning({ schemaVersion: 1, kind: "local-planning-policy", version: 1, mode: "manual-planning-only" })) return refusePlanning("policy.unavailable");
    if (command.kind === "create-project") {
      const projects = await listPlanningAggregates(tx, "project", 128);
      if (projects.length >= 128) return refusePlanning("project.capacity");
      return { f: null, metadata: null, digest: digestPlanning([policy.checksum, projects.map((p) => [p.aggregateId, p.aggregateVersion])]), detail: { localBudgetOnly: true, taskExecution: false } };
    }
    const f = await readPlanningFoundations(tx, command.projectId), metadata = await readPlanningMetadata(tx, command.projectId);
    ensureVersion(command, f);
    if (!["stop-project", "resume-project", "historical-money"].includes(command.kind)) assertPlanningAdmission(f);
    let extra: unknown = null;
    if (command.kind === "accept-brief" || command.kind === "answer-clarification") {
      const candidate = candidates.get(command.projectId);
      if (candidate === undefined || candidate.candidateId !== command.candidateId) return refusePlanning("brief.candidate-unavailable");
      if (candidate.expectedBriefVersion !== (f.accepted?.aggregateVersion ?? 0)) return refusePlanning("brief.candidate-stale", "conflict");
      if (command.kind === "accept-brief" && command.candidateDigest !== candidate.value.candidateDigest) return refusePlanning("brief.candidate-conflict", "conflict");
      extra = candidate;
    }
    if (command.kind === "attach-result") {
      const handover = await tx.aggregates.get("planning-handover", command.handoverId);
      if (handover === null) return refusePlanning("handover.absent");
      verifyPlanningEnvelope(handover); const record = parsePlanningHandover(handover.payload);
      if (record.projectId !== command.projectId) return refusePlanning("handover.project-mismatch");
      extra = handover;
    }
    if (command.kind === "historical-money" || command.kind === "approve-scope") {
      const approvalId = command.kind === "historical-money" ? command.approvalId : metadata.value.plan?.scopeApprovalId;
      if (approvalId === null || approvalId === undefined) return refusePlanning("approval.unavailable");
      const pair = await readPlanningApprovalPair(tx, approvalId);
      if (pair === null || pair.approval.scope.projectId !== command.projectId) return refusePlanning("approval.unavailable");
      if (command.kind === "historical-money" && (command.expectedApprovalVersion !== pair.approvalEnvelope.aggregateVersion || command.expectedSpendingVersion !== pair.spendingEnvelope?.aggregateVersion)) return refusePlanning("approval.version-conflict", "conflict");
      extra = pair;
    }
    const detail = { project: f.project, brief: f.accepted?.brief ?? null, plan: f.head?.plan ?? null, planVersion: f.head?.aggregateVersion ?? 0,
      localBudget: f.budget, stopContext: f.stops, metadata: metadata.value, exactActionEvidence: extra, policy: policy.payload };
    return { f, metadata, detail, digest: digestPlanning([f.projectEnvelope, f.budgetEnvelope, f.controls, f.accepted, f.head, metadata.envelope, extra, policy]) };
  }
  async function confirm(command: PlanningCommand, b: CommandBasis, selected: unknown): Promise<PlanningConfirmation | null> {
    const reviewId = `native-review:${randomUUID()}`, subjectDigest = digestPlanning({ command, basis: b.digest, selected });
    const lines = ["This local planning action starts no task, provider or payment."], f = b.f;
    const list = (label: string, values: readonly string[]): void => { if (values.length > 0) lines.push(`\n${label}`, ...values.map((text) => `• ${text}`)); };
    const tasks = (label: string, title: string, items: readonly { title: string; objective: string; acceptanceCriteria: readonly string[] }[]): void => {
      lines.push(`\n${label}: ${title}`); for (const [index, task] of items.entries()) { lines.push(`\n${index + 1}. ${task.title}`, task.objective); list("Acceptance criteria", task.acceptanceCriteria); }
    };
    if (f !== null) {
      lines.push(`\nProject: ${f.project.displayName}`, `Local planned budget: ${((f.budget.budget.money?.limit.amountMicros ?? 0) / 1_000_000).toFixed(2)} ${f.budget.budget.money?.limit.currency ?? "GBP"}`, `Local operations: ${f.stopped ? "stopped" : "available"}`);
      if (f.accepted !== null) { lines.push(`\nAccepted brief, version ${f.accepted.aggregateVersion}`, f.accepted.brief.objective); list("Accepted outcomes", f.accepted.brief.outcomes); list("Outside the accepted scope", f.accepted.brief.nonGoals); }
      if (f.head !== null) {
        const plan = f.head.plan;
        tasks(`Saved plan, revision ${plan.revision}, version ${f.head.aggregateVersion} (${plan.state.replaceAll("_", " ")})`, plan.stages[0]?.title ?? "Manual plan", plan.tasks.map((task) => ({ ...task, acceptanceCriteria: task.acceptance.map((item) => item.criterion) })));
        lines.push(`Plan content digest: ${plan.planDigest}`);
      }
    }
    if (command.kind === "create-project" || command.kind === "draft-brief") {
      if (command.kind === "create-project") lines.push(`\nNew project: ${command.name}`, `Local planned budget: ${(command.budgetMinorUnits / 100).toFixed(2)} ${command.currency}`, "The description becomes a temporary brief to review; it is not accepted yet.");
      lines.push("\nProposed objective", command.objective); list("Proposed outcomes", command.outcomes);
      if (command.kind === "draft-brief") { list("Proposed non-goals", command.nonGoals); list("Proposed audience", command.audiences); }
    } else if (command.kind === "answer-clarification") {
      const candidate = candidates.get(command.projectId)!;
      for (const answer of command.answers) lines.push(`\n${candidate.value.openQuestions.find((item) => item.question.questionId === answer.questionId)?.question.question ?? "Clarification answer"}`, answer.value);
    } else if (command.kind === "accept-brief") {
      const candidate = candidates.get(command.projectId)!.value;
      lines.push("\nBrief to accept", candidate.objective.value); list("Outcomes to accept", candidate.outcomes.map((field) => field.value)); list("Non-goals to accept", candidate.nonGoals.map((field) => field.value)); list("Audience to accept (including any proposed default)", candidate.audiences.map((field) => field.value));
    } else if (command.kind === "save-plan") {
      tasks("Proposed manual plan", command.title, command.tasks); lines.push(`\nRequested scope: ${command.scope.replaceAll("-", " ")}. Additional objectives require an exact scope approval before sealing.`);
    } else if (command.kind === "approve-scope") {
      lines.push("\nDecision: approve the exact additional scope above and seal this plan in one saved transaction. This consumes this scope approval once. It authorizes no task execution or spending.");
    } else if (command.kind === "historical-money") {
      const pair = planningObject(b.detail)["exactActionEvidence"] as NonNullable<Awaited<ReturnType<typeof readPlanningApprovalPair>>>;
      lines.push(`\nHistorical action: ${command.action.replaceAll("-", " ")}`, `Original approval: ${pair.approval.approvalRequestId}`, `Saved spending state: ${pair.spending?.state ?? "unavailable"}`, `Original amount: ${((pair.spending?.amountMinorUnits ?? 0) / 100).toFixed(2)} ${pair.spending?.currency ?? ""}`,
        "This records an operator-supplied past fact. External verification is unavailable. Original approval terms and consumption remain unchanged; later binding changes and stop remain visible context.");
      if (command.receiptRef !== null) lines.push(`Receipt reference supplied by the operator: ${command.receiptRef}`);
    } else if (command.kind === "attach-result" && selected !== null) {
      const source = selected as { name: string; text: string }, report = JSON.parse(source.text) as { text: string };
      lines.push(`\nManual return: ${source.name}`, "The text below is untrusted, attributed to the operator, and grants no authority.", report.text);
    } else if (command.kind === "stop-project" || command.kind === "resume-project") {
      lines.push(command.kind === "stop-project" ? "\nStop new local planning operations. Saved records remain. This app runs no AI processes to terminate." : "\nAllow new explicit local planning actions. Resuming starts nothing.");
    }
    if ((command.kind === "create-project" || command.kind === "select-repository") && selected !== null) {
      const repository = selected as PlanningRepositoryObservation;
      lines.push(`\nRepository read grant: ${repository.canonicalRoot}`, "Only bounded file metadata and Git reference observations are collected. Working-tree status and commit object verification are unavailable. No repository command is executed.");
      list("Repository observations", repository.report.facts.map((fact) => `${fact.kind.replaceAll("-", " ")}: ${fact.value}`));
    }
    const detail = `${lines.join("\n")}\n\nExact action content: ${subjectDigest}`;
    if (detail.length > 196608) return refusePlanning("confirmation.content-bound");
    if (!await operator.confirm(Object.freeze({ reviewId, action: command.kind, title: titles[command.kind], detail, subjectDigest }))) return null;
    return Object.freeze({ reviewId, identityRef: "operator:local-desktop", approverClass: "project-owner", confirmedAt: now(), subjectDigest });
  }
  async function commitPlan(tx: TransactionContext, request: PlanCommitRequest): Promise<void> {
    // This capability is created only inside a freshly checked, natively
    // confirmed application transaction. No public issuer or serialized token.
    const token = Object.freeze(Object.create(null)) as PlanCommitAuthorization;
    let available = true;
    const facts: IssuedPlanCommitFacts = { projectId: request.projectId, contentDigest: request.binding.contentDigest, operationKinds: operationKindsOf(request), eventIds: request.steps.map((s) => s.eventId),
      authenticatedOperatorEvidence: operatorPlanningEvidence(request.steps[0].event.review), decisions: request.steps.flatMap((s) => [...s.event.decisions]) };
    const store = createPlanPersistenceBoundary(planningTransactionAdapter(tx), { take(value) { if (value !== token || !available) return null; available = false; return facts; }, readConsumedScopeApproval: readJointScopeConsumption });
    const outcome = await store.commit(request, token);
    if (outcome.kind !== "committed") return refusePlanning("ruleId" in outcome ? outcome.ruleId : "plan.write-unconfirmed", outcome.kind === "conflict" ? "conflict" : "refused");
  }
  async function assertManualOrigin(tx: TransactionContext, f: PlanningFoundations, m: PlanningMetadata): Promise<void> {
    if (f.head === null || m.plan === null || f.head.plan.planId !== m.plan.planId) return refusePlanning("plan.origin-unavailable");
    const receipt = await observePlanningReceipt(tx, m.plan.originCommandId);
    if (receipt === null || receipt.commandKind !== "save-plan" || receipt.result.kind !== "committed" || receipt.confirmation === null) return refusePlanning("plan.operator-proof-unavailable");
    const material = planningObject(receipt.material, ["command", "request"]), command = parsePlanningCommand(material["command"]);
    if (command.kind !== "save-plan" || digestPlanning(command) !== receipt.inputDigest || command.projectId !== f.project.projectId) return refusePlanning("plan.operator-proof-corrupt", "corrupt");
    const origin = material["request"] as PlanCommitRequest;
    if (origin?.steps?.[0]?.plan?.planId !== f.head.plan.planId || canonicalPlanning(origin.steps[0].event.review) !== canonicalPlanning(f.head.headEvent.payload.review)
      || canonicalPlanning(operatorPlanningEvidence(f.head.headEvent.payload.review)) !== canonicalPlanning(f.head.headEvent.payload.review.authenticatedOperatorEvidence)) return refusePlanning("plan.operator-proof-corrupt", "corrupt");
  }
  async function approvalOperation(tx: TransactionContext, request: ApprovalOperation, confirmation: PlanningConfirmation, historical = false): Promise<void> {
    const owner = createPlanningApprovalOwner(planningTransactionAdapter(tx), clock), outcome = await owner.attemptConfirmed(request, confirmation, historical);
    if (outcome.kind !== "committed") return refusePlanning(outcome.reason ?? "approval.write-unconfirmed", outcome.kind === "conflict" ? "conflict" : outcome.kind === "corrupt" ? "corrupt" : "refused");
  }
  function op(kind: ApprovalOperation["kind"], commandId: string, pair: NonNullable<Awaited<ReturnType<typeof readPlanningApprovalPair>>>, at: string, receiptRef: string | null = null): ApprovalOperation {
    return parseApprovalOperation({ schemaVersion: 1, kind, operationId: commandId, request: pair.request, successor: null, expectedApprovalVersion: pair.approvalEnvelope.aggregateVersion,
      expectedSpendingVersion: pair.spendingEnvelope?.aggregateVersion ?? 0, at, receiptRef }, planningHash);
  }
  function transitionEvent(f: PlanningFoundations, plan: ProjectPlan, kind: "plan.proposed" | "plan.scope-approval-required" | "plan.sealed", operationKind: "promote" | "require-scope-approval" | "approve-scope" | "seal", confirmation: PlanningConfirmation, scopeApproval: Awaited<ReturnType<typeof prospectiveScopeConsumption>> | null = null): Omit<PlanHeadEventPayload, "binding"> {
    if (f.head === null || f.accepted === null) return refusePlanning("plan.absent");
    const decisions = kind === "plan.sealed" ? [planningDecision("scope-accepted", plan, confirmation)] : [];
    const ceiling = planningCeiling(f), seal = kind !== "plan.sealed" ? null : {
      verdicts: assertSealConditions({ plan, review: f.head.headEvent.payload.review, acceptedBrief: f.accepted, project: f.project, controls: f.controls, resolvedProjectCeiling: ceiling, authenticatedDecisions: decisions, scopeApproval }),
      blockingQuestionIds: blockingOpenQuestionIds(f.accepted.brief), resolvedProjectCeiling: ceiling, sealedAt: confirmation.confirmedAt, sealedByApprovalId: scopeApproval?.approvalRequestId ?? null };
    return { schemaVersion: 1, kind, operation: { kind: operationKind }, plan, controls: f.controls, review: f.head.headEvent.payload.review, decisions, predecessor: null, rebase: null, seal, budgetExtension: null } as unknown as Omit<PlanHeadEventPayload, "binding">;
  }
  async function mutate(tx: TransactionContext, command: DurableCommand, b: CommandBasis, confirmation: PlanningConfirmation, selected: unknown): Promise<{ projectId: string; material: unknown }> {
    const at = confirmation.confirmedAt;
    if (command.kind === "create-project") {
      const id = digestPlanning(command.commandId).slice(0, 32), projectId = `prj:${id}`, budgetId = `budget:${id}`;
      const policy = (await tx.aggregates.get("planning-workspace", "local-planning-policy"))!;
      const observation = selected as PlanningRepositoryObservation;
      const project = parseProject({ schemaVersion: 1, projectId, revision: 1, displayName: command.name, repositoryRoots: [observation.canonicalRoot], defaultBranch: observation.report.facts.find((fact) => fact.kind === "git-branch")?.value ?? null, dataClassification: "internal", permissionMode: "contained-default",
        budgetAccountId: budgetId, effectiveConfigDigest: policy.checksum.hex, status: "active", createdAt: at, updatedAt: at });
      const budget = createBudgetAccount({ scope: { scopeType: "project", scopeId: projectId }, budget: parseAggregateBudget({ tokens: null,
        money: { limit: { currency: command.currency, amountMicros: command.budgetMinorUnits * 10000 }, softLimit: null }, time: null }) });
      await writePlanningAggregate(tx, "project", projectId, project, 0, command.commandId, "project.created", at);
      await writePlanningAggregate(tx, "budget-account", budgetId, budget, 0, command.commandId, "project.local-budget-created", at);
      await writePlanningMetadata(tx, { schemaVersion: 1, kind: "project-planning-metadata", projectId, repository: observation, plan: null }, 0, command.commandId, at);
      // The objective/outcomes remain an ephemeral intake candidate until C8
      // acceptance. Only their digest enters the durable command identity.
      return { projectId, material: { project, localBudget: budget } };
    }
    const f = b.f!, m = b.metadata!, projectId = command.projectId;
    if (command.kind === "accept-brief") {
      if (f.head?.plan.state === "awaiting_scope_approval") return refusePlanning("brief.scope-review-pending");
      const candidate = candidates.get(projectId)!;
      const prepared = prepareCandidateAcceptance({ candidate: candidate.value, presentedDigest: command.candidateDigest, expectedHead: f.accepted?.brief ?? null,
        expectedAggregateVersion: command.expectedBriefVersion, clarification: candidate.clarification, operatorConfirmed: true }, { digest: planningHash, clock: { now: () => new Date(at) } });
      const store = createC7IntakeStore(planningTransactionAdapter(tx), planningHash);
      const outcome = await store.attempt(prepared);
      if (outcome.kind !== "committed") return refusePlanning("brief.write-unconfirmed", outcome.kind === "conflict" ? "conflict" : "refused");
      return { projectId, material: { command, prepared } };
    }
    if (command.kind === "select-repository") {
      if (f.head?.plan.state === "awaiting_scope_approval") return refusePlanning("repository.scope-review-pending");
      const observation = selected as PlanningRepositoryObservation;
      const project = parseProject({ ...f.project, repositoryRoots: [observation.canonicalRoot], defaultBranch: observation.report.facts.find((fact) => fact.kind === "git-branch")?.value ?? null,
        revision: f.project.revision + 1, updatedAt: at });
      await writePlanningAggregate(tx, "project", projectId, project, f.projectEnvelope.aggregateVersion, command.commandId, "project.repository-selected", at);
      await writePlanningMetadata(tx, { ...m.value, repository: observation }, m.envelope.aggregateVersion, command.commandId, at);
      return { projectId, material: { command, observation } };
    }
    if (command.kind === "save-plan") {
      const request = draftPlanningRequest(command, f, confirmation);
      await commitPlan(tx, request);
      const briefValues = new Set([f.accepted!.brief.objective, ...f.accepted!.brief.outcomes]);
      const requiresScope = command.scope === "scope-expansion" || command.tasks.some((task) => !briefValues.has(task.objective));
      await writePlanningMetadata(tx, { ...m.value, plan: { planId: request.steps[0].plan!.planId, requiresScope, originCommandId: command.commandId, scopeApprovalId: null } }, m.envelope.aggregateVersion, command.commandId, at);
      return { projectId, material: { command, request } };
    }
    if (command.kind === "prepare-plan" || command.kind === "seal-plan" || command.kind === "approve-scope") {
      await assertManualOrigin(tx, f, m.value);
      const head = f.head!.plan, steps: PlanningUnboundStep[] = [];
      let scopePair: Awaited<ReturnType<typeof readPlanningApprovalPair>> = null;
      let consumed: ReturnType<typeof prospectiveScopeConsumption> | null = null;
      if (command.kind === "prepare-plan") {
        if (head.state !== "drafting") return refusePlanning("plan.prepare-unavailable");
        const plans = promoteDraft(head, at, m.value.plan!.requiresScope);
        steps.push({ expectedState: head.state, event: transitionEvent(f, plans[0]!, "plan.proposed", "promote", confirmation) });
        if (plans.length === 2) steps.push({ expectedState: "proposed", event: transitionEvent(f, plans[1]!, "plan.scope-approval-required", "require-scope-approval", confirmation) });
      } else if (command.kind === "seal-plan") {
        if (head.state !== "proposed" || m.value.plan!.requiresScope) return refusePlanning("plan.seal-unavailable");
        steps.push({ expectedState: head.state, event: transitionEvent(f, sealProposedPlan(head, at), "plan.sealed", "seal", confirmation) });
      } else {
        if (head.state !== "awaiting_scope_approval" || m.value.plan!.scopeApprovalId === null) return refusePlanning("scope.approval-unavailable");
        scopePair = await readPlanningApprovalPair(tx, m.value.plan!.scopeApprovalId!);
        if (scopePair === null || scopePair.approval.state !== "requested") return refusePlanning("scope.approval-unavailable");
        await approvalOperation(tx, op("approve", `${command.commandId}:approve`, scopePair, at), confirmation);
        scopePair = (await readPlanningApprovalPair(tx, scopePair.approval.approvalRequestId))!;
        consumed = prospectiveScopeConsumption(scopePair, at);
        const proposed = consumePlanScopeApproval(head, at), sealed = sealProposedPlan(proposed, at, consumed.approvalRequestId);
        steps.push({ expectedState: head.state, event: transitionEvent(f, proposed, "plan.proposed", "approve-scope", confirmation) }, { expectedState: "proposed", event: transitionEvent(f, sealed, "plan.sealed", "seal", confirmation, consumed) });
      }
      const request = bindPlanningSteps(f, command.commandId, steps, at);
      if (scopePair !== null && consumed !== null) await writeJointScopeConsumption(tx, scopePair, consumed, await readPlanningApprovalControls(tx, scopePair.request.proposal.binding, at), request, confirmation);
      await commitPlan(tx, request);
      if (command.kind === "prepare-plan" && m.value.plan!.requiresScope) {
        const fresh = await readPlanningFoundations(tx, projectId), prepared = await preparePlanningScopeApproval(tx, fresh, at);
        await approvalOperation(tx, parseApprovalOperation({ schemaVersion: 1, kind: "create", operationId: `${command.commandId}:create`, request: prepared, successor: null, expectedApprovalVersion: 0, expectedSpendingVersion: 0, at, receiptRef: null }, planningHash), confirmation);
        await writePlanningMetadata(tx, { ...m.value, plan: { ...m.value.plan!, scopeApprovalId: prepared.approval.approvalRequestId } }, m.envelope.aggregateVersion, command.commandId, at);
      }
      return { projectId, material: { command, request } };
    }
    if (command.kind === "stop-project" || command.kind === "resume-project") {
      const activeStops = f.stops.filter(isProjectStopActive);
      if (command.kind === "stop-project" && activeStops.length > 0 || command.kind === "resume-project" && activeStops.length === 0) return refusePlanning("stop.state-conflict", "conflict");
      if (command.kind === "stop-project") {
        const stop = parseProjectStop({ schemaVersion: 1, projectStopId: `pst:${digestPlanning(command.commandId).slice(0, 32)}`, revision: 1, projectId, engagedAt: at,
          effects: { cancelledTaskIds: [], stoppingSessionIds: [], unconfirmedSessionIds: [], voidedApprovalIds: [], voidedHandoverIds: [], releasedReservationIds: [], retainedReservationIds: [] }, resumedAt: null });
        // This application launches no sessions and reserves no usage. Existing
        // approvals remain historical facts; admission is stopped by this record.
        await writePlanningAggregate(tx, "project-stop", stop.projectStopId, stop, 0, command.commandId, "project.local-operations-stopped", at);
      } else {
        for (const stop of activeStops) {
          const envelope = (await tx.aggregates.get("project-stop", stop.projectStopId))!;
          await writePlanningAggregate(tx, "project-stop", stop.projectStopId, parseProjectStop({ ...stop, revision: stop.revision + 1, resumedAt: at }), envelope.aggregateVersion, command.commandId, "project.local-operations-resumed", at);
        }
      }
      // PersistenceAdapter serializes transactions; the desktop also holds an
      // exclusive OS lifetime lock on this SQLite store. The stop and every
      // admission therefore read/write in one ordering without inventing a
      // project-content change that would invalidate a pending scope review.
      return { projectId, material: command };
    }
    if (command.kind === "export-handover") {
      const handover = createPlanningHandover(f, m.value.repository, command.commandId, at);
      await writePlanningAggregate(tx, "planning-handover", handover.handoverId, handover, 0, command.commandId, "planning-handover.exported", at);
      return { projectId, material: { command, handover } };
    }
    if (command.kind === "attach-result") {
      const envelope = (await tx.aggregates.get("planning-handover", command.handoverId))!, prior = parsePlanningHandover(envelope.payload);
      const handover = attachPlanningManualResult(prior, selected as { name: string; text: string }, at);
      await writePlanningAggregate(tx, "planning-handover", handover.handoverId, handover, envelope.aggregateVersion, command.commandId, "planning-handover.manual-result-attached", at);
      return { projectId, material: { command, sourceDigest: handover.result!.sourceDigest } };
    }
    if (command.kind !== "historical-money") return refusePlanning("command.unsupported");
    const pair = (await readPlanningApprovalPair(tx, command.approvalId))!;
    await approvalOperation(tx, op(command.action, `${command.commandId}:history`, pair, at, command.receiptRef), confirmation, true);
    return { projectId, material: command };
  }
  async function execute(command: DurableCommand): Promise<PlanningCommandResult> {
    const id = command.commandId, projectId = "projectId" in command ? command.projectId : null, inputDigest = digestPlanning(command);
    let confirmation: PlanningConfirmation | null = null;
    try {
      const existing = await persistence.transact(async (tx) => {
        const receipt = await observePlanningReceipt(tx, id, inputDigest);
        if (receipt === null) await recordPlanningIntent(tx, { commandId: id, commandKind: command.kind, inputDigest, projectId, at: now() });
        return receipt;
      });
      if (existing !== null) return await withWorkspace(existing.result);
      const before = await persistence.transact((tx) => basis(tx, command));
      let selected: unknown = null;
      if (command.kind === "select-repository" || command.kind === "create-project") {
        const path = await operator.selectRepository();
        if (path !== null) selected = await inspectPlanningRepository(path, now());
      } else if (command.kind === "attach-result") {
        selected = await operator.selectResult();
        if (selected !== null) {
          const envelope = planningObject(before.detail)["exactActionEvidence"] as { payload: unknown };
          attachPlanningManualResult(parsePlanningHandover(envelope.payload), selected as { name: string; text: string }, now());
        }
      }
      const cancelledPicker = (command.kind === "select-repository" || command.kind === "create-project" || command.kind === "attach-result") && selected === null;
      if (!cancelledPicker) confirmation = await confirm(command, before, selected);
      if (confirmation === null) {
        const cancelled = { kind: "cancelled" as const, commandId: id, reason: "operator.cancelled", projectId };
        await persistence.transact((tx) => recordPlanningReceipt(tx, { schemaVersion: 1, commandId: id, commandKind: command.kind, inputDigest, at: now(), confirmation: null, material: null, effects: [], result: cancelled }));
        return await withWorkspace(cancelled);
      }
      const confirmed = confirmation;
      const committed = await persistence.transact(async (base) => {
        const recorded = await observePlanningReceipt(base, id, inputDigest, true);
        if (recorded !== null) return recorded.result;
        const capture = capturePlanningEffects(base), tx = capture.tx, fresh = await basis(tx, command);
        if (fresh.digest !== before.digest || confirmed.subjectDigest !== digestPlanning({ command, basis: fresh.digest, selected })) return refusePlanning("confirmation.subject-changed", "conflict");
        const mutation = await mutate(tx, command, fresh, confirmed, selected), outcome: PlanningReceiptResult = { kind: "committed", commandId: id, reason: null, projectId: mutation.projectId };
        await recordPlanningReceipt(base, { schemaVersion: 1, commandId: id, commandKind: command.kind, inputDigest, at: confirmed.confirmedAt, confirmation: confirmed, material: mutation.material, effects: capture.effects, result: outcome });
        return outcome;
      });
      if (committed.kind === "committed") {
        if (command.kind === "create-project") candidates.set(committed.projectId!, candidateDraft(committed.projectId!, command));
        if (command.kind === "accept-brief") candidates.delete(command.projectId);
      }
      return await withWorkspace(committed);
    } catch (error) {
      const failed = safeFailure(error, id, projectId);
      // A semantic rejection proves the transaction rolled back. Unknown commit
      // results are never overwritten; Observe reads the original durable record.
      if (["refused", "conflict"].includes(failed.kind)) {
        try { await persistence.transact(async (tx) => {
          const receipt = await observePlanningReceipt(tx, id, inputDigest, true);
          if (receipt === null) await recordPlanningReceipt(tx, { schemaVersion: 1, commandId: id, commandKind: command.kind, inputDigest, at: now(), confirmation, material: null, effects: [],
            result: { kind: failed.kind as "refused" | "conflict", commandId: id, projectId, reason: failed.reason } });
        }); } catch { /* Preserve the original intent/evidence for Observe. */ }
      }
      return failed;
    }
  }
  async function ephemeralCommand(command: Exclude<PlanningCommand, DurableCommand>): Promise<PlanningCommandResult> {
    try {
      const before = await persistence.transact((tx) => basis(tx, command));
      const confirmation = await confirm(command, before, null);
      if (confirmation === null) return result("cancelled", null, command.projectId, "operator.cancelled");
      await persistence.transact(async (tx) => {
        const fresh = await basis(tx, command);
        if (fresh.digest !== before.digest) return refusePlanning("confirmation.subject-changed", "conflict");
        if (command.kind === "draft-brief") candidates.set(command.projectId, { ...candidateDraft(command.projectId, command), expectedBriefVersion: command.expectedBriefVersion });
        else {
          const prior = candidates.get(command.projectId)!, clarification = resolveClarificationRound(prior.clarification, 1, command.answers.map((a) => ({ ...a, kind: "answered" as const })), planningHash);
          const applied = applyClarificationsToCandidate(prior.value, clarification, planningHash), { candidateDigest: _digest, ready: _ready, ...draft } = applied;
          const outcome = command.answers.find((answer) => answer.questionId === "q:required-outcome");
          const value = assembleCandidate({ ...draft, outcomes: outcome === undefined ? draft.outcomes : [...draft.outcomes, { value: outcome.value, provenance: { source: "operator-supplied", acceptedByOperator: true } }] } as CandidateDraftInput, planningHash);
          candidates.set(command.projectId, { ...prior, value, clarification });
        }
      });
      return result("ready", null, command.projectId, null, await snapshot(command.projectId));
    } catch (error) { return safeFailure(error, null, command.projectId); }
  }
  async function snapshot(projectId: string | null): Promise<PlanningWorkspaceView> {
    if (!initialized || closing) return refusePlanning("workspace.unavailable");
    if (projectId !== null) planningId(projectId);
    return await persistence.transact(async (tx) => {
      const rows = await listPlanningAggregates(tx, "project", 128), projects: PlanningProjectSummary[] = [];
      let selected: PlanningProjectView | null = null;
      for (const row of rows) {
        const f = await readPlanningFoundations(tx, row.aggregateId), m = await readPlanningMetadata(tx, row.aggregateId);
        const summary: PlanningProjectSummary = { projectId: row.aggregateId, name: f.project.displayName, version: row.aggregateVersion, stopped: f.stopped, planState: f.head?.plan.state ?? null };
        projects.push(summary);
        if (row.aggregateId !== projectId) continue;
        const candidate = candidates.get(projectId), head = f.head, repo = m.value.repository;
        const approvals: PlanningProjectView["approvals"][number][] = [];
        let scopeAvailable = false;
        for (const envelope of await listPlanningAggregates(tx, "approval-request")) {
          const pair = await readPlanningApprovalPair(tx, envelope.aggregateId);
          if (pair === null || pair.approval.scope.projectId !== projectId) continue;
          const actions: ("report-executed" | "record-receipt" | "withdraw")[] = [];
          let context = pair.spending === null ? "Exact local scope; no spending or task execution." : "Historical operator report; external verification is unavailable.";
          if (pair.spending === null) {
            try {
              await verifyPlanningApprovalHistory(tx, pair);
              if (pair.approval.approvalRequestId === m.value.plan?.scopeApprovalId && pair.approval.state === "requested") {
                const controls = await readPlanningApprovalControls(tx, pair.request.proposal.binding, now());
                try { evaluateApprovalOperation(op("approve", "scope:availability", pair, controls.observedAt), { approval: pair.approval, spending: null }, controls,
                  { kind: "operator", identityRef: "operator:local-desktop", approverClass: "project-owner" }, planningHash); scopeAvailable = true; }
                catch { context += " Approval is unavailable for the current saved bindings, time or stop state."; }
              }
            } catch (error) { if (error instanceof PlanningRefusal && error.kind === "corrupt") throw error; context += " Required trusted history is unavailable."; }
          }
          if (pair.approval.state === "consumed" && pair.spending !== null) {
            try {
              await verifyPlanningMoneyHistory(tx, pair);
              const controls = await readPlanningApprovalControls(tx, pair.request.proposal.binding, now());
              const drift = canonicalPlanning(controls.binding) !== canonicalPlanning(pair.request.proposal.binding);
              context += `${drift ? " Saved bindings have changed." : ""}${f.stopped ? " Local project operations are stopped." : ""}`;
              for (const kind of ["report-executed", "record-receipt", "withdraw"] as const) {
                try { evaluateHistoricalMoneyCompletion(op(kind, "history:availability", pair, controls.observedAt, kind === "record-receipt" ? "Manual receipt reference" : null), { approval: pair.approval, spending: pair.spending }, controls,
                  { kind: "operator", identityRef: "operator:local-desktop", approverClass: "project-owner" }, planningHash); actions.push(kind); } catch { /* This legal transition is unavailable. */ }
              }
            } catch (error) { if (error instanceof PlanningRefusal && error.kind === "corrupt") throw error; context += " Required trusted history is unavailable."; }
          }
          approvals.push({ approvalId: pair.approval.approvalRequestId, version: pair.approvalEnvelope.aggregateVersion, spendingVersion: pair.spendingEnvelope?.aggregateVersion ?? 0,
            title: pair.spending === null ? "Manual plan scope approval" : "Historical money record", state: pair.spending?.state ?? pair.approval.state, context, actions });
        }
        const handovers: PlanningProjectView["handovers"][number][] = [];
        for (const envelope of await listPlanningAggregates(tx, "planning-handover", 256)) {
          const record = parsePlanningHandover(envelope.payload);
          if (record.projectId !== projectId) continue;
          const stale = planningHandoverStale(record, f);
          handovers.push({ handoverId: record.handoverId, fileName: join(options.artifactRoot, planningHandoverFileName(record)), planRevision: record.planRevision, planDigest: record.planDigest, stale,
            result: record.result === null ? null : { attribution: record.result.attribution, text: record.result.text, stale } });
        }
        const stopHistory = (await Promise.all(f.stops.map((stop) => listPlanningEvents(tx, "project-stop", stop.projectStopId)))).flat();
        const history = [...await listPlanningEvents(tx, "project", projectId), ...stopHistory, ...(f.accepted === null ? [] : await listPlanningEvents(tx, "project-brief", f.accepted.aggregateId)),
          ...(head === null ? [] : await listPlanningEvents(tx, "project-plan", head.aggregateId))].sort((a, b) => a.globalSequence - b.globalSequence).slice(-100).map((event) => ({ eventId: event.eventId, kind: event.eventType, at: event.occurredAt }));
        const actions: ("prepare-plan" | "approve-scope" | "seal-plan")[] = f.stopped || head === null ? [] : head.plan.state === "drafting" ? ["prepare-plan"] : head.plan.state === "awaiting_scope_approval" && scopeAvailable ? ["approve-scope"] : head.plan.state === "proposed" && !m.value.plan?.requiresScope ? ["seal-plan"] : [];
        selected = { ...summary, budget: { minorUnits: (f.budget.budget.money?.limit.amountMicros ?? 0) / 10000, currency: f.budget.budget.money?.limit.currency ?? "GBP" },
          repository: repo === null ? null : { rootLeaf: repo.report.rootLeaf, state: repo.report.state, head: repo.report.facts.find((fact) => fact.kind === "git-head")?.value ?? null,
            branch: repo.report.facts.find((fact) => fact.kind === "git-branch")?.value ?? null, observedAt: repo.observedAt, facts: repo.report.facts.map((fact) => `${fact.kind}: ${fact.value}`) },
          brief: f.accepted === null ? null : { briefId: f.accepted.brief.briefId, version: f.accepted.aggregateVersion, digest: f.accepted.briefContentDigest, objective: f.accepted.brief.objective, outcomes: f.accepted.brief.outcomes, nonGoals: f.accepted.brief.nonGoals, audiences: f.accepted.brief.audiences },
          candidate: candidate === undefined ? null : { candidateId: candidate.candidateId, digest: candidate.value.candidateDigest, ready: candidate.value.ready, objective: candidate.value.objective.value, outcomes: candidate.value.outcomes.map((field) => field.value), questions: candidate.value.openQuestions.map((item) => item.question) },
          plan: head === null ? null : { planId: head.plan.planId, version: head.aggregateVersion, revision: head.plan.revision, digest: head.plan.planDigest, state: head.plan.state, title: head.plan.stages[0]?.title ?? "Manual plan",
            tasks: head.plan.tasks.map((task) => ({ title: task.title, objective: task.objective, acceptanceCriteria: task.acceptance.map((item) => item.criterion) })), scope: m.value.plan?.requiresScope ? "scope-expansion" : "within-brief", sealedByApprovalId: head.plan.sealedByApprovalId, actions }, approvals, handovers, history };
      }
      if (projectId !== null && selected === null) return refusePlanning("project.absent");
      return Object.freeze({ schemaVersion: 1, authority: "none", source: "saved-local-planning", projects, selected });
    });
  }
  async function withWorkspace(outcome: PlanningReceiptResult): Promise<PlanningCommandResult> {
    try { await persistence.transact((tx) => materializePlanningHandovers(tx, options.artifactRoot)); }
    catch { return result("unknown", outcome.commandId, outcome.projectId, "handover.materialization-unconfirmed"); }
    return result(outcome.kind, outcome.commandId, outcome.projectId, outcome.reason, await snapshot(outcome.projectId));
  }
  const app: SavedPlanningApplication = {
    async initialize() {
      if (initialized || closing) return;
      await persistence.transact(async (tx) => {
        const policy = await tx.aggregates.get("planning-workspace", "local-planning-policy");
        if (policy === null) await writePlanningAggregate(tx, "planning-workspace", "local-planning-policy", { schemaVersion: 1, kind: "local-planning-policy", version: 1, mode: "manual-planning-only" }, 0, "workspace:initialize", "planning-workspace.initialized", now());
        else verifyPlanningEnvelope(policy, "planning-workspace", "local-planning-policy");
        // Reconcile durable attempts before any UI query or new command. A
        // remaining intent proves an uncommitted transaction after child drain.
        for (const row of await listPlanningAggregates(tx, "planning-command")) {
          const value = planningObject(row.payload), id = planningId(value["commandId"]);
          await observePlanningReceipt(tx, id);
        }
        await materializePlanningHandovers(tx, options.artifactRoot);
      });
      initialized = true;
    }, snapshot,
    async handover(projectId, handoverId) {
      planningId(projectId); planningId(handoverId);
      if (!initialized || closing) return refusePlanning("workspace.unavailable");
      if (active.size + ephemeral.size >= 8) return refusePlanning("command.capacity");
      const pending = persistence.transact(async (tx) => {
        const f = await readPlanningFoundations(tx, projectId), envelope = await tx.aggregates.get("planning-handover", handoverId);
        if (envelope === null) return refusePlanning("handover.absent");
        verifyPlanningEnvelope(envelope, "planning-handover", handoverId);
        const record = parsePlanningHandover(envelope.payload);
        if (record.handoverId !== handoverId) return refusePlanning("handover.identity-corrupt", "corrupt");
        if (record.projectId !== projectId) return refusePlanning("handover.project-mismatch");
        const text = `${JSON.stringify(record.document, null, 2)}\n`;
        if (text.length > 262_144) return refusePlanning("handover.view-bound");
        return Object.freeze({ schemaVersion: 1 as const, authority: "none" as const, projectId, handoverId, fileName: join(options.artifactRoot, planningHandoverFileName(record)), stale: planningHandoverStale(record, f), text });
      });
      ephemeral.add(pending); try { return await pending; } finally { ephemeral.delete(pending); }
    },
    async command(value) {
      let command: PlanningCommand;
      try { command = parsePlanningCommand(value); } catch (error) { return safeFailure(error, null, null); }
      if (!initialized || closing) return result("refused", "commandId" in command ? command.commandId : null, "projectId" in command ? command.projectId : null, "workspace.unavailable");
      if (active.size + ephemeral.size >= 8) return result("refused", "commandId" in command ? command.commandId : null, null, "command.capacity");
      if (!("commandId" in command)) {
        const pending = ephemeralCommand(command); ephemeral.add(pending);
        try { return await pending; } finally { ephemeral.delete(pending); }
      }
      if (active.has(command.commandId)) return result("unknown", command.commandId, "projectId" in command ? command.projectId : null, "command.in-flight");
      const pending = execute(command); active.set(command.commandId, pending);
      try { return await pending; } finally { active.delete(command.commandId); }
    },
    async observe(commandId) {
      try {
        planningId(commandId);
        if (!initialized || closing) return result("unknown", commandId, null, "workspace.unavailable");
        if (active.has(commandId)) return result("unknown", commandId, null, "command.in-flight");
        const receipt = await persistence.transact((tx) => observePlanningReceipt(tx, commandId));
        return receipt === null ? result("not-recorded", commandId, null) : await withWorkspace(receipt.result);
      } catch (error) { return safeFailure(error, commandId, null); }
    },
    async drain() { closing = true; await Promise.allSettled([...active.values(), ...ephemeral]); candidates.clear(); },
  };
  return Object.freeze(app);
}
