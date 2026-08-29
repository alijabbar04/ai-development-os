import type { ProjectRecordKind } from "../src/index.js";

export const T0 = "2026-08-29T10:00:00.000Z";
export const T1 = "2026-08-29T11:00:00.000Z";
export const T2 = "2026-08-30T10:00:00.000Z";
export const SHA = "a".repeat(64);
export const SHA_B = "b".repeat(64);
export const CONTENT = "a".repeat(32);

export const budget = Object.freeze({ maximumInputTokens: 1000, maximumOutputTokens: 500, maximumCostMicros: 100_000, maximumToolCalls: 10, maximumTurns: 4 });
export const usage = Object.freeze({ inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningTokens: 0, toolCalls: 1, costMicros: 25 });
export const task = Object.freeze({
  taskId: "tsk:one", stageId: "stg:one", title: "Build contracts", objective: "Implement the bounded contract.",
  requirements: { kind: "implement", complexity: 3, risk: "medium", reasoning: "high", editScope: "multi-file", capabilities: ["reasoning", "repository-read", "code-edit", "testing", "structured-output"], dataClassification: "internal", expectedInputTokens: 1000, expectedOutputTokens: 500 },
  requirementIds: ["req:one"], workspaceMode: "worktree",
  acceptance: [{ criterion: "The focused suite passes.", validationCommand: ["npm", "test"] }],
  expectedOutputSchema: { type: "object" }, idempotencyClass: "replayable", budget,
  retry: { maximumAttempts: 2, initialBackoffMs: 100, maximumBackoffMs: 1000, retryableFailures: ["capacity"] },
  timeout: { dispatchMs: 1000, attemptMs: 10_000 }, priority: "normal", workloadClass: "general",
  handoverPolicy: { requires: "none", acceptFrom: [], maximumAgeMs: null }, state: "pending", stateRevision: 1,
});
export const stage = Object.freeze({ stageId: "stg:one", ordinal: 1, title: "Contracts", intent: "Define the spine.", exitCriteria: ["Contracts pass."], exitEvidenceKinds: ["test-report"], taskIds: ["tsk:one"], gate: "automatic" });
export const dependency = Object.freeze({ fromTaskId: "tsk:one", toTaskId: "tsk:two", kind: "finish-to-start", artifactKind: null });

export const recordFixtures: Readonly<Record<ProjectRecordKind, unknown>> = Object.freeze({
  project: {
    schemaVersion: 1, projectId: "prj:one", revision: 1, displayName: "Project One", repositoryRoots: ["C:\\Projects\\One"], defaultBranch: "main", dataClassification: "internal", permissionMode: "contained-default", budgetAccountId: "budget:one", effectiveConfigDigest: SHA, status: "active", createdAt: T0, updatedAt: T0,
  },
  "project-brief": {
    schemaVersion: 1, briefId: "brf:one", projectId: "prj:one", revision: 1, supersedes: null, origin: "operator", objective: "Build the project spine.", outcomes: ["Contracts are reviewable."], nonGoals: ["No persistence."], audiences: ["Operator"],
    constraints: [{ constraintId: "constraint:one", kind: "quality-bar", statement: "Tests must pass.", enforcement: "hard", machineForm: { command: ["npm", "test"] }, origin: "operator", authority: "operator" }],
    assumptions: [{ text: "The repository uses npm workspaces.", source: "repository", confirmed: true }], openQuestions: [], sourceThreadId: "thr:audit", createdAt: T0,
  },
  constraint: { constraintId: "constraint:one", kind: "quality-bar", statement: "Tests must pass.", enforcement: "hard", machineForm: { gate: "tests" }, origin: "operator", authority: "operator" },
  "project-plan": {
    schemaVersion: 1, planId: "pln:one", projectId: "prj:one", briefId: "brf:one", briefRevision: 1, revision: 1, supersedes: null, state: "drafting", stages: [stage], tasks: [task], dependencies: [], specificationRef: null, coverageRef: null, planDigest: SHA, sealedAt: null, sealedByApprovalId: null, budgetCeiling: budget, origin: "model", authority: "none", createdAt: T0, updatedAt: T0,
  },
  "plan-stage": stage,
  task,
  dependency,
  "agent-run": {
    schemaVersion: 1, runId: "run:one", projectId: "prj:one", planId: "pln:one", planRevision: 1, taskId: "tsk:one", attempt: 1, workId: "work:one", leaseId: "lease:one", fencingToken: 1,
    route: { candidateId: "candidate:one", providerId: "provider:one", modelId: "model:one", profileId: "profile:one", ownership: "owned" }, reservationId: null, dispatchId: null, sessionId: null, grantDigest: SHA,
    consumedApprovalIds: [], consumedHandoverId: null, state: "leased", usage, startedAt: null, finishedAt: null, terminal: null,
  },
  session: {
    schemaVersion: 1, sessionId: "ses:one", projectId: "prj:one", providerId: "provider:one", providerSessionRef: null,
    workspace: { projectId: "prj:one", workspaceId: "workspace:one", snapshotId: "snapshot:one", baseRevision: "a".repeat(40) }, worktreePath: "C:\\Projects\\One\\Worktrees\\One",
    containment: { backendId: "backend:one", securityClass: "constrained-incomplete", jobObjectBound: true, terminationConfirmable: true }, state: "requested", lastHeartbeatAt: null, heartbeatIntervalMs: 5000, ownerRunId: null, resumable: false, archivedAt: null, archiveRef: null, createdAt: T0, updatedAt: T0,
  },
  handover: {
    schemaVersion: 1, handoverId: `hnd:${CONTENT}`, revision: 1, supersedes: null, projectId: "prj:one", planId: "pln:one", planRevision: 1, fromRunId: "run:one", toTaskId: "tsk:two", sequence: 1, state: "assembled",
    repository: { repositoryRoot: "C:\\Projects\\One", snapshotId: "snapshot:one", baseRevision: "a".repeat(40), branch: "feat/contracts", worktreeDisposition: "fresh-from-result", resultRevision: "b".repeat(40) },
    goals: ["Continue the contract."], nonGoals: [], completed: [{ claim: "Parser exists.", evidenceIds: [`evd:${CONTENT}`] }], remaining: [{ item: "Review.", requirementIds: ["req:review"] }], risks: [{ risk: "Schema drift.", severity: "medium", mitigated: true }],
    operatorDecisionIds: [`dec:${CONTENT}`], consumedApprovalIds: [], evidenceIds: [`evd:${CONTENT}`], budgetRemaining: budget, expectedOutputSchema: { type: "object" }, origin: "system", authority: "none", modelNarrativeRef: null, createdAt: T0, acknowledgedAt: null, acknowledgedByRunId: null,
  },
  decision: {
    schemaVersion: 1, decisionId: `dec:${CONTENT}`, revision: 1, projectId: "prj:one", scope: { planId: "pln:one", planRevision: 1, stageId: null, taskId: null }, kind: "scope-accepted", decidedBy: "operator", statement: "Accept the bounded scope.", rationale: null, supersedes: null, subjectDigest: SHA, decidedAt: T0,
  },
  "approval-request": {
    schemaVersion: 1, approvalRequestId: "apr:one", class: "credential-use", actions: ["secret-access"], risk: "high",
    scope: { projectId: "prj:one", taskId: "tsk:one", providerInstanceId: null, workspaceId: null, operationId: "operation:one", traceId: "trace:one" }, subjectDigest: SHA,
    subjectSummary: { what: "Use a credential reference.", why: "A bounded operation needs it.", changes: "No durable content changes.", where: "The selected provider.", reversible: false, scope: "One operation.", effects: ["Resolve one secret reference."], exclusions: ["No export."] },
    usage: "one-shot", scopePattern: null, consumptionCeiling: null, consumptionCount: 0, retryAllowance: 0, effects: ["Resolve one secret reference."], exclusions: ["No export."], money: null,
    requestedBy: { kind: "system", runId: "run:one", reason: "The task requires a provider credential." }, state: "requested", createdAt: T0, expiresAt: T1, decidedAt: null, approverClass: null, consumedAt: null, revokedAt: null, voidedBy: null,
  },
  "spending-request": {
    schemaVersion: 1, spendingRequestId: "spd:one", projectId: "prj:one", kind: "purchase", vendor: { name: "Example Vendor", instanceRef: "vendor:one" }, amountMinorUnits: 500, currency: "GBP", recurrence: null, quotedAt: T1, quoteExpiresAt: T2, quoteDigest: SHA, justification: "Acquire a test service.", linkedApprovalRequestId: "apr:money", state: "quoted", executedAt: null, externalReceiptRef: null, createdAt: T0,
  },
  "usage-reservation": {
    reservationId: `reservation:${SHA}`, snapshotId: "snapshot:usage", sourceAdapterVersion: "3.0.0", sourceFingerprint: SHA, observedAt: T0, fiveHourWindowId: "window:five", fiveHourResetAt: T1, weeklyWindowId: "window:weekly", weeklyResetAt: T2, usedFiveHourBasisPoints: 1000, usedWeeklyBasisPoints: 2000, predictedFiveHourBasisPoints: 100, predictedWeeklyBasisPoints: 200, estimatedUsage: usage,
    circuit: { schemaVersion: 1, evidenceId: "circuit:one", providerId: "provider:one", profileId: "profile:one", state: "closed", observedAt: T0, sourceFingerprint: SHA }, reservedAt: T0, status: "reserved", actualUsage: null, reconciledAt: null,
  },
  "evidence-record": {
    schemaVersion: 1, evidenceId: `evd:${CONTENT}`, revision: 1, supersedes: null, projectId: "prj:one", runId: "run:one", kind: "test-report", sha256: SHA, mediaType: "application/json", sizeBytes: 100, producedBy: "deterministic-validation", claimsSupported: ["req:one"], sensitivity: "internal", retentionClass: "permanent", createdAt: T0,
  },
  deliverable: {
    schemaVersion: 1, deliverableId: "dlv:one", projectId: "prj:one", stageId: "stg:one", title: "Contract package", kind: "commit", evidenceIds: [`evd:${CONTENT}`], repositoryRef: { revision: "a".repeat(40), branch: "feat/contracts" }, acceptance: "pending", acceptedByDecisionId: null, createdAt: T0,
  },
  blocker: {
    schemaVersion: 1, blockerId: "blk:one", projectId: "prj:one", scope: { planId: "pln:one", stageId: "stg:one", taskId: "tsk:one", runId: null }, kind: "usage-stale", ruleIds: ["usage.stale.refused"], statement: "Fresh usage evidence is required.", unblockedBy: ["Wait for one fresh authorized usage snapshot."], operatorActionable: false, state: "open", openedAt: T0, clearedAt: null, clearedBy: null,
  },
  notification: {
    schemaVersion: 1, notificationId: "ntf:one", projectId: "prj:one", category: "task-completed", severity: "success", episodeKey: "episode:one", title: "Task completed", body: "A project task completed successfully.", deepLink: null, actionable: false, createdAt: T0, quietHoursDeferredUntil: null,
    deliveries: [{ channel: "in-app", state: "pending", attempt: 0, idempotencyKey: "notify:one", lastAttemptAt: null, failureCode: null }], acknowledgedAt: null, expiresAt: null,
  },
  "communication-thread": {
    schemaVersion: 1, threadId: "thr:one", projectId: "prj:one", channel: "in-app", participantRef: "participant:operator", messages: [{ messageId: "message:one", direction: "inbound", at: T0, bodyRef: "artifact:body", trust: "untrusted-input", derivedRecordIds: ["dec:derived"] }], createdAt: T0,
  },
  "external-integration": {
    schemaVersion: 1, integrationId: "ext:one", kind: "messaging", implementationId: "discord", state: "planned", capabilities: [], credentialRef: null, allowlist: [], boundVersion: null, boundDigest: null, lastVerifiedAt: null, createdAt: T0,
  },
  "project-health": {
    schemaVersion: 1, projectId: "prj:one", computedAt: T0, sourceSequence: 1, planState: "drafting", stageProgress: [{ stageId: "stg:one", done: 0, total: 1, gate: "automatic" }], counts: { running: 0, queued: 0, blocked: 0, awaitingApproval: 0, failed: 0, completed: 0 }, openBlockers: [], coverage: { required: { covered: 0, total: 1 }, expectedQuality: { covered: 0, total: 1 } }, budget: { reservedMicros: 0, actualMicros: 0, ceilingMicros: 100_000 }, capacity: [{ profileId: "profile:one", windowStatus: "active", headroomBasisPoints: 9000 }], confidence: "current", staleReason: null,
  },
  "project-stop": {
    schemaVersion: 1, projectStopId: "pst:one", revision: 1, projectId: "prj:one", engagedAt: T0, effects: { cancelledTaskIds: ["tsk:one"], stoppingSessionIds: ["ses:one"], unconfirmedSessionIds: [], voidedApprovalIds: ["apr:one"], voidedHandoverIds: [`hnd:${CONTENT}`], releasedReservationIds: [`reservation:${SHA}`], retainedReservationIds: [] }, resumedAt: null,
  },
});

export function cloneFixture<T>(value: T): T {
  return structuredClone(value);
}
