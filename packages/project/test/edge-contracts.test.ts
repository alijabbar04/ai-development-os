import { describe, expect, it } from "vitest";
import {
  APPROVAL_STATE_MACHINE, ProjectContractError, canEvidenceCloseRequirement, deriveProjectHealthProjection,
  deriveProjectSummaryProjection, deriveRecoveryDirective, deriveNotificationCopy,
  parseAgentRun, parseApprovalRequest, parseBlocker, parseDecision, parseDeliverable, parseExternalIntegration,
  parseEvidenceRecord, parseHandover, parseNotification, parseProjectBrief, parseProjectHealthProjection,
  parseProjectPlan, parseProjectRecordJson, parseProjectSummaryProjection, parseProjectTask,
  parseSession, parseSpendingRequest, parseUsageReservation, projectTaskRunStatus,
} from "../src/index.js";
import { SHA, T0, T1, T2, cloneFixture, recordFixtures, stage, task, usage } from "./fixtures.js";

describe("positive lifecycle variants exercise every optional structure", () => {
  it("parses blocking clarification questions and bounded handover policy", () => {
    const brief = cloneFixture(recordFixtures["project-brief"]) as Record<string, unknown>;
    brief["openQuestions"] = [{ questionId: "question:one", theme: "scope", question: "Should the optional item be included?", whyItMatters: "It changes scope.", options: ["Include", "Defer"], proposedDefault: "Defer", consequenceIfDefaulted: "The item remains out of scope.", blocking: true }];
    expect(parseProjectBrief(brief).openQuestions[0]?.options).toEqual(["Include", "Defer"]);
    const boundedTask = cloneFixture(recordFixtures.task) as Record<string, unknown>;
    boundedTask["handoverPolicy"] = { requires: "required", acceptFrom: ["tsk:prior"], maximumAgeMs: 60_000 };
    expect(parseProjectTask(boundedTask).handoverPolicy.maximumAgeMs).toBe(60_000);
  });

  it("parses a sealed two-task DAG and rejects cycles and broken membership", () => {
    const second = { ...cloneFixture(task), taskId: "tsk:two", handoverPolicy: { requires: "optional", acceptFrom: ["tsk:one"], maximumAgeMs: null } };
    const plan = cloneFixture(recordFixtures["project-plan"]) as Record<string, unknown>;
    plan["state"] = "sealed"; plan["sealedAt"] = T1; plan["sealedByApprovalId"] = "apr:scope";
    plan["specificationRef"] = "spec:one"; plan["coverageRef"] = "coverage:one"; plan["supersedes"] = "pln:zero";
    plan["revision"] = 2;
    plan["stages"] = [{ ...cloneFixture(stage), taskIds: ["tsk:one", "tsk:two"] }]; plan["tasks"] = [cloneFixture(task), second];
    plan["dependencies"] = [{ fromTaskId: "tsk:one", toTaskId: "tsk:two", kind: "artifact", artifactKind: "test-report" }];
    expect(parseProjectPlan(plan).tasks).toHaveLength(2);
    const cyclic = cloneFixture(plan); cyclic["dependencies"] = [...(cyclic["dependencies"] as unknown[]), { fromTaskId: "tsk:two", toTaskId: "tsk:one", kind: "finish-to-start", artifactKind: null }];
    expect(() => parseProjectPlan(cyclic)).toThrowError(ProjectContractError);
    const missing = cloneFixture(plan); (missing["tasks"] as Record<string, unknown>[])[1]!["stageId"] = "stg:missing";
    expect(() => parseProjectPlan(missing)).toThrowError(ProjectContractError);
    const membership = cloneFixture(plan); (membership["stages"] as Record<string, unknown>[])[0]!["taskIds"] = ["tsk:one"];
    expect(() => parseProjectPlan(membership)).toThrowError(ProjectContractError);
    const superseded = cloneFixture(plan); superseded["state"] = "superseded";
    expect(parseProjectPlan(superseded).sealedAt).toBe(T1);
    const falseApproval = cloneFixture(recordFixtures["project-plan"]) as Record<string, unknown>; falseApproval["sealedByApprovalId"] = "apr:scope";
    expect(() => parseProjectPlan(falseApproval)).toThrowError(ProjectContractError);
  });

  it("parses all run terminal outcomes and refuses contradictory outcomes", () => {
    for (const [state, outcome, classification] of [["succeeded", "completed", null], ["failed", "failed", "provider"], ["cancelled", "cancelled", null]] as const) {
      const run = cloneFixture(recordFixtures["agent-run"]) as Record<string, unknown>;
      Object.assign(run, { state, startedAt: T0, finishedAt: T1, reservationId: `reservation:${SHA}`, dispatchId: "dispatch:one", sessionId: "ses:one", consumedHandoverId: `hnd:${"a".repeat(32)}`, terminal: { outcome, classification, code: "terminal-code", effectPhase: "post-response" } });
      expect(parseAgentRun(run).terminal?.outcome).toBe(outcome);
    }
    const bad = cloneFixture(recordFixtures["agent-run"]) as Record<string, unknown>;
    Object.assign(bad, { state: "failed", startedAt: T0, finishedAt: T1, terminal: { outcome: "completed", classification: null, code: "bad", effectPhase: "pre-dispatch" } });
    expect(() => parseAgentRun(bad)).toThrowError(ProjectContractError);
  });

  it("parses live and archived sessions and acknowledged handovers", () => {
    const running = cloneFixture(recordFixtures.session) as Record<string, unknown>;
    Object.assign(running, { state: "running", providerSessionRef: "opaque-provider-token", ownerRunId: "run:one", lastHeartbeatAt: T1, resumable: true, updatedAt: T1 });
    expect(parseSession(running).providerSessionRef).toBe("opaque-provider-token");
    const archived = cloneFixture(recordFixtures.session) as Record<string, unknown>;
    Object.assign(archived, { state: "archived", archivedAt: T1, archiveRef: "artifact:archive", updatedAt: T1 });
    expect(parseSession(archived).archivedAt).toBe(T1);
    const handover = cloneFixture(recordFixtures.handover) as Record<string, unknown>;
    Object.assign(handover, { state: "acknowledged", acknowledgedAt: T1, acknowledgedByRunId: "run:two", supersedes: `hnd:${"b".repeat(32)}`, modelNarrativeRef: "artifact:narrative" });
    expect(parseHandover(handover).state).toBe("acknowledged");
  });

  it("parses both remaining recurring scope patterns and approval lifecycle metadata", () => {
    const external = cloneFixture(recordFixtures["approval-request"]) as Record<string, unknown>;
    Object.assign(external, { class: "external-communication", actions: ["external-message"], usage: "bounded-recurring", scopePattern: { kind: "external-communication", integrationId: "ext:one", channelRef: "channel:one", recipientRef: "recipient:one", redactionClass: "status-only" }, consumptionCeiling: 2, consumptionCount: 1, state: "partially_consumed", decidedAt: T0, approverClass: "user" });
    expect(parseApprovalRequest(external).scopePattern?.kind).toBe("external-communication");
    const paid = cloneFixture(recordFixtures["approval-request"]) as Record<string, unknown>;
    Object.assign(paid, { class: "paid-usage", actions: ["paid-usage"], usage: "bounded-recurring", scopePattern: { kind: "paid-usage", providerInstanceId: "provider:one", modelId: "model:one", currency: "GBP", ceilingMinorUnits: 1000 }, consumptionCeiling: 5,
      money: { vendor: { name: "Provider", instanceRef: "vendor:one" }, amountMinorUnits: 1000, currency: "GBP", kind: "ceiling", period: null, occurrences: null, quoteDigest: null, quotedAt: null, quoteExpiresAt: null } });
    expect(parseApprovalRequest(paid).scopePattern?.kind).toBe("paid-usage");
    const revoked = cloneFixture(external); Object.assign(revoked, { state: "revoked", revokedAt: T1 });
    expect(parseApprovalRequest(revoked).revokedAt).toBe(T1);
    const voided = cloneFixture(recordFixtures["approval-request"]) as Record<string, unknown>; Object.assign(voided, { state: "voided", voidedBy: "stop:one" });
    expect(parseApprovalRequest(voided).state).toBe("voided");
    const premature = cloneFixture(recordFixtures["approval-request"]) as Record<string, unknown>;
    Object.assign(premature, { state: "consumed", consumptionCount: 0, decidedAt: T0, approverClass: "user", consumedAt: T0 });
    expect(() => parseApprovalRequest(premature)).toThrowError(ProjectContractError);
  });

  it("keeps every legal approval-state edge compatible with its durable record parser", () => {
    const legal = [
      ["requested", "approve", "approved"], ["requested", "reject", "rejected"],
      ["requested", "expire", "expired"], ["requested", "void", "voided"],
      ["approved", "consume-one", "consumed"], ["approved", "consume-partial", "partially_consumed"],
      ["partially_consumed", "consume-partial", "partially_consumed"], ["partially_consumed", "consume-ceiling", "consumed"],
      ["approved", "revoke", "revoked"], ["partially_consumed", "revoke", "revoked"],
      ["approved", "expire", "expired"], ["partially_consumed", "expire", "expired"],
      ["approved", "void", "voided"], ["partially_consumed", "void", "voided"],
    ] as const;
    for (const [from, event, to] of legal) {
      expect(APPROVAL_STATE_MACHINE.table[from][event]).toBe(to);
      const fixture = cloneFixture(recordFixtures["approval-request"]) as Record<string, unknown>;
      const recurring = from === "partially_consumed" || event === "consume-partial" || event === "consume-ceiling";
      if (recurring) Object.assign(fixture, {
        class: "git-publication",
        actions: ["git-write"],
        usage: "bounded-recurring",
        scopePattern: { kind: "git-publication", projectId: "prj:one", remote: "https://example.invalid/repo", refPrefix: "refs/heads/feat/", forcePush: false },
        consumptionCeiling: 2,
      });
      const preservesDecision = from !== "requested" || to === "approved" || to === "rejected";
      Object.assign(fixture, {
        state: to,
        decidedAt: preservesDecision ? T0 : null,
        approverClass: preservesDecision ? "user" : null,
        consumptionCount: to === "partially_consumed" ? 1 : to === "consumed" ? recurring ? 2 : 1 : from === "partially_consumed" ? 1 : 0,
        consumedAt: to === "consumed" ? T0 : null,
        revokedAt: to === "revoked" ? T1 : null,
        voidedBy: to === "voided" ? "stop:one" : null,
      });
      expect(parseApprovalRequest(fixture).state, `${from}:${event}`).toBe(to);
    }
  });

  it("parses recurring spending, reconciliation, acceptance, clearing and delivery failures", () => {
    const spending = cloneFixture(recordFixtures["spending-request"]) as Record<string, unknown>;
    Object.assign(spending, { kind: "subscription", recurrence: { period: "annual", occurrences: 2 }, state: "reconciled", executedAt: T1, externalReceiptRef: "receipt:one" });
    expect(parseSpendingRequest(spending).recurrence?.occurrences).toBe(2);
    const reservation = cloneFixture(recordFixtures["usage-reservation"]) as Record<string, unknown>;
    Object.assign(reservation, { status: "reconciled", actualUsage: usage, reconciledAt: T1 });
    expect(parseUsageReservation(reservation).actualUsage).not.toBeNull();
    const deliverable = cloneFixture(recordFixtures.deliverable) as Record<string, unknown>;
    Object.assign(deliverable, { acceptance: "accepted", acceptedByDecisionId: `dec:${"a".repeat(32)}` });
    expect(parseDeliverable(deliverable).acceptance).toBe("accepted");
    const blocker = cloneFixture(recordFixtures.blocker) as Record<string, unknown>;
    Object.assign(blocker, { state: "cleared", clearedAt: T1, clearedBy: "dec:clear" });
    expect(parseBlocker(blocker).state).toBe("cleared");
    const notification = cloneFixture(recordFixtures.notification) as Record<string, unknown>;
    Object.assign(notification, { category: "task-failed", severity: "danger", ...deriveNotificationCopy("task-failed"), actionable: true, deepLink: { route: "task", params: { projectId: "prj:one", taskId: "tsk:one" } }, acknowledgedAt: T1, expiresAt: T2,
      deliveries: [{ channel: "windows-toast", state: "failed", attempt: 1, idempotencyKey: "notify:failed", lastAttemptAt: T1, failureCode: "delivery-refused" }] });
    expect(parseNotification(notification).deepLink?.route).toBe("task");
  });

  it("mirrors every scheduler-owned reservation accounting status exactly", () => {
    for (const status of ["reserved", "reconciliation-required", "reconciled", "released"] as const) {
      const terminal = status === "reconciled" || status === "released";
      const fixture = cloneFixture(recordFixtures["usage-reservation"]) as Record<string, unknown>;
      Object.assign(fixture, { status, actualUsage: terminal ? usage : null, reconciledAt: terminal ? T1 : null });
      expect(parseUsageReservation(fixture).status).toBe(status);
      Object.assign(fixture, { actualUsage: terminal ? null : usage, reconciledAt: terminal ? null : T1 });
      expect(() => parseUsageReservation(fixture)).toThrowError(ProjectContractError);
    }
  });

  it("requires exact handover repository identity, disposition coherence and evidence closure", () => {
    for (const worktreeDisposition of ["reuse", "fresh-from-base"] as const) {
      const fixture = cloneFixture(recordFixtures.handover) as Record<string, unknown>;
      fixture["repository"] = { ...(fixture["repository"] as object), worktreeDisposition, resultRevision: null };
      expect(parseHandover(fixture).repository.worktreeDisposition).toBe(worktreeDisposition);
    }
    const mutations: Array<(fixture: Record<string, unknown>) => void> = [
      (fixture) => { (fixture["repository"] as Record<string, unknown>)["baseRevision"] = "not-a-revision"; },
      (fixture) => { (fixture["repository"] as Record<string, unknown>)["resultRevision"] = null; },
      (fixture) => { fixture["evidenceIds"] = []; },
    ];
    for (const mutate of mutations) {
      const fixture = cloneFixture(recordFixtures.handover) as Record<string, unknown>;
      mutate(fixture);
      expect(() => parseHandover(fixture)).toThrowError(ProjectContractError);
    }

    const invalidBranches = [
      "feature.", "team/.hidden", "team/name.lock/sub", "feat//invalid",
      "trailing/", "two..dots", "at@{brace", "has space", "has~tilde",
      "has^caret", "has:colon", "has?question", "has*star", "has[bracket",
      "has\\backslash", "-leading-dash", ".leading-dot", "name.lock", "control\u0001char",
    ] as const;
    for (const branch of invalidBranches) {
      const fixture = cloneFixture(recordFixtures.handover) as Record<string, unknown>;
      (fixture["repository"] as Record<string, unknown>)["branch"] = branch;
      expect(() => parseHandover(fixture), branch).toThrowError(ProjectContractError);
    }

    for (const branch of ["feat/c6-project-contracts", "release/20.0_rc-1", "team/topic/subtopic"] as const) {
      const fixture = cloneFixture(recordFixtures.handover) as Record<string, unknown>;
      (fixture["repository"] as Record<string, unknown>)["branch"] = branch;
      expect(parseHandover(fixture).repository.branch, branch).toBe(branch);
    }
  });

  it("rejects self-supersession for every immutable content record", () => {
    const brief = cloneFixture(recordFixtures["project-brief"]) as Record<string, unknown>;
    brief["supersedes"] = brief["briefId"];
    expect(() => parseProjectBrief(brief)).toThrowError(ProjectContractError);
    const handover = cloneFixture(recordFixtures.handover) as Record<string, unknown>;
    handover["supersedes"] = handover["handoverId"];
    expect(() => parseHandover(handover)).toThrowError(ProjectContractError);
    const decision = cloneFixture(recordFixtures.decision) as Record<string, unknown>;
    decision["supersedes"] = decision["decisionId"];
    expect(() => parseDecision(decision)).toThrowError(ProjectContractError);
    const evidence = cloneFixture(recordFixtures["evidence-record"]) as Record<string, unknown>;
    evidence["supersedes"] = evidence["evidenceId"];
    expect(() => parseEvidenceRecord(evidence)).toThrowError(ProjectContractError);
  });

  it("parses configured integrations and populated stale projections", () => {
    const integration = cloneFixture(recordFixtures["external-integration"]) as Record<string, unknown>;
    Object.assign(integration, { state: "configured", capabilities: ["status-send"], credentialRef: { schemaVersion: 1, type: "named", namespace: "application", version: null, expectedKind: "text", providerInstanceId: "provider:one", name: "discord-default" }, allowlist: ["channel:one"], boundVersion: "1.0.0", boundDigest: SHA, lastVerifiedAt: T1 });
    expect(parseExternalIntegration(integration).state).toBe("configured");
    const health = cloneFixture(recordFixtures["project-health"]) as Record<string, unknown>;
    Object.assign(health, { confidence: "stale", staleReason: "The event cursor is behind.", openBlockers: [{ blockerId: "blk:one", kind: "usage-stale", operatorActionable: false }] });
    expect(parseProjectHealthProjection(health).openBlockers).toHaveLength(1);
    const summary = {
      schemaVersion: 1, projectId: "prj:one", displayName: "One", status: "active", planState: "Running",
      currentStage: { ordinal: 1, title: "Build", gate: "operator-review" }, nextMilestone: { title: "Review", expectedBy: T2 },
      counts: { running: 1, waiting: 0, blocked: 0, awaitingApproval: 0, queued: 0, done: 0, total: 1 },
      needsYou: [{ kind: "stage-gate", title: "Review the stage checkpoint", expiresAt: null, deepLink: { route: "plan", params: { projectId: "prj:one" } } }],
      usage: { reservedBp: 100, actualBp: 50, currency: "GBP", estimateMicros: 100, actualMicros: 50, pricingAt: T0 },
      capacity: [{ alias: "Owned", ownership: "owned", windowStatus: "active", eligible: true, blockingRuleId: null, resetAt: T2 }], confidence: "current", sourceSequence: 1, computedAt: T0,
    };
    expect(parseProjectSummaryProjection(summary).currentStage?.ordinal).toBe(1);
    expect(() => parseProjectSummaryProjection({ ...summary, planState: "arbitrary renderer prose" })).toThrowError(ProjectContractError);
    expect(() => parseProjectSummaryProjection({ ...summary, needsYou: [{ ...(summary.needsYou[0] as object), title: "Model-authored question text" }] })).toThrowError(ProjectContractError);
    expect(() => parseProjectSummaryProjection({ ...summary, needsYou: [{ ...(summary.needsYou[0] as object), deepLink: { route: "plan", params: { projectId: "prj:one", path: "C:\\private" } } }] })).toThrowError(ProjectContractError);
  });

  it("reuses every existing SecretRef shape without admitting secret material", () => {
    const common = { schemaVersion: 1, namespace: "application", version: null, expectedKind: "text", providerInstanceId: "provider:one" };
    const refs = [
      { ...common, type: "named", name: "provider-default" },
      { ...common, type: "environment", variableName: "PROVIDER_API_KEY" },
      { ...common, type: "keychain", service: "provider", account: "default" },
      { ...common, type: "encrypted-file", containerId: "container:one", entryName: "provider-default" },
      { ...common, type: "external-vault", vaultNamespace: "team", pathSegments: ["providers"], entryName: "default" },
    ];
    for (const credentialRef of refs) {
      const integration = cloneFixture(recordFixtures["external-integration"]) as Record<string, unknown>;
      Object.assign(integration, { state: "configured", capabilities: ["status-send"], credentialRef });
      expect(parseExternalIntegration(integration).credentialRef?.type).toBe(credentialRef.type);
    }
    const material = cloneFixture(recordFixtures["external-integration"]) as Record<string, unknown>;
    const secretMaterialSentinel = ["sk", "ant", "hostile-secret-canary"].join("-");
    Object.assign(material, { state: "configured", capabilities: ["status-send"], credentialRef: secretMaterialSentinel });
    expect(() => parseExternalIntegration(material)).toThrowError(ProjectContractError);
  });
});

describe("negative branches and guard precision", () => {
  it("refuses malformed scalar, schema, JSON, path and canonical-object inputs", () => {
    expect(() => parseProjectRecordJson("project", "")).toThrowError(ProjectContractError);
    expect(() => parseProjectRecordJson("project", "{" )).toThrowError(ProjectContractError);
    expect(() => parseProjectRecordJson("project", JSON.stringify(recordFixtures.project))).not.toThrow();
    const ahead = cloneFixture(recordFixtures.project) as Record<string, unknown>; ahead["schemaVersion"] = 2;
    expect(() => parseProjectPlan({ ...cloneFixture(recordFixtures["project-plan"]), schemaVersion: 2 })).toThrowError(ProjectContractError);
    expect(() => parseProjectBrief([])).toThrowError(ProjectContractError);
    const badPath = cloneFixture(recordFixtures.project) as Record<string, unknown>; badPath["repositoryRoots"] = ["relative\\path"];
    expect(() => parseProjectPlan({ ...cloneFixture(recordFixtures["project-plan"]), budgetCeiling: { maximumInputTokens: 1, maximumOutputTokens: 1, maximumCostMicros: 0, maximumToolCalls: 0, maximumTurns: 0 } })).not.toThrow();
    expect(() => parseProjectRecordJson("project", JSON.stringify(badPath))).toThrowError(ProjectContractError);
    expect(() => parseProjectRecordJson("project", JSON.stringify({ ...cloneFixture(recordFixtures.project), repositoryRoots: ["C:\\Projects\\trailing."] }))).toThrowError(ProjectContractError);
    expect(() => parseProjectRecordJson("project", JSON.stringify({ ...cloneFixture(recordFixtures.project), repositoryRoots: ["\\\\server\\share"] }))).toThrowError(ProjectContractError);
    expect(parseProjectRecordJson("project", JSON.stringify({ ...cloneFixture(recordFixtures.project), repositoryRoots: ["C:\\", "/", "/tmp/.project"] }))).toBeDefined();
    expect(ahead["schemaVersion"]).toBe(2);
  });

  it("refuses inconsistent task, session, notification and projection invariants", () => {
    const noCode = cloneFixture(recordFixtures.task) as Record<string, unknown>;
    (noCode["requirements"] as Record<string, unknown>)["capabilities"] = ["reasoning"];
    expect(() => parseProjectTask(noCode)).toThrowError(ProjectContractError);
    const session = cloneFixture(recordFixtures.session) as Record<string, unknown>; Object.assign(session, { state: "running", providerSessionRef: "opaque", ownerRunId: null });
    expect(() => parseSession(session)).toThrowError(ProjectContractError);
    const notice = cloneFixture(recordFixtures.notification) as Record<string, unknown>; notice["body"] = "credential hostile value";
    expect(() => parseNotification(notice)).toThrowError(ProjectContractError);
    const health = cloneFixture(recordFixtures["project-health"]) as Record<string, unknown>;
    ((health["stageProgress"] as Record<string, unknown>[])[0] as Record<string, unknown>)["done"] = 2;
    expect(() => parseProjectHealthProjection(health)).toThrowError(ProjectContractError);
  });

  it("executes finite never guards for hostile JavaScript callers", () => {
    expect(() => projectTaskRunStatus({ taskState: "invented" as never, blockerKind: null })).toThrowError(ProjectContractError);
    expect(() => deriveRecoveryDirective({ runState: "abandoned", sessionState: null, effectPhase: "pre-dispatch", idempotencyClass: "pure", reconciliation: "invented" as never, termination: "not-applicable" })).toThrowError(ProjectContractError);
    expect(() => canEvidenceCloseRequirement({ producedBy: "invented" } as never)).toThrowError(ProjectContractError);
  });

  it("refuses summary source mismatch while deriving transcript-independent views", () => {
    const project = cloneFixture(recordFixtures.project) as never;
    const plan = cloneFixture(recordFixtures["project-plan"]) as never;
    const health = deriveProjectHealthProjection({ projectId: "prj:one", plan, blockers: [cloneFixture(recordFixtures.blocker) as never], coverage: null, budget: { reservedMicros: 0, actualMicros: 0, ceilingMicros: 1 }, capacity: [], computedAt: T0, sourceSequence: 1, confidence: "stale", staleReason: "Lagging." });
    expect(health.openBlockers).toHaveLength(1);
    expect(() => deriveProjectSummaryProjection({ project: { ...(project as object), projectId: "prj:other" } as never, plan, projectStop: null, health, nextMilestone: null, needsYou: [], usage: { reservedBp: 0, actualBp: 0, currency: "GBP", estimateMicros: 0, actualMicros: 0, pricingAt: T0 }, capacity: [] })).toThrowError(ProjectContractError);
  });
});
