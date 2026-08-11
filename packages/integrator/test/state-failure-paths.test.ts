import { describe, expect, it } from "vitest";
import {
  IntegrationError,
  cancelIntegrationRun,
  claimIntegrationRun,
  completeIntegrationRun,
  createIntegrationRun,
  exhaustIntegrationRecovery,
  failIntegrationRun,
  integrationCommandEquals,
  integrationDigest,
  parseIntegrationCommandInput,
  parseIntegrationRunSnapshot,
  prepareIntegrationRun,
  reconcileIntegrationRun,
  recordIntegrationReceipt,
  replayIntegrationEvents,
  stableIntegrationId,
  startIntegrationEffect,
  startIntegrationRecovery,
  type IntegrationRequest,
} from "../src/index.js";
import { integrationStateTesting } from "../src/state.js";
import {
  T0,
  T1,
  T2,
  T3,
  T4,
  authorityFor,
  command,
  fakePorts,
  preflightResult,
  requestInput,
  validationResult,
} from "./fixtures.js";

function withDigest<T extends Record<string, unknown>>(value: T, key: string): Readonly<Record<string, unknown>> {
  const projection = { ...value };
  delete projection[key];
  return Object.freeze({ ...projection, [key]: integrationDigest(projection) });
}

function mergeRequest(): IntegrationRequest {
  const request = requestInput();
  const base = {
    ...request,
    repository: {
      ...request.repository,
      expectedIntegratedCommit: "e".repeat(40),
      expectedIntegratedTree: "f".repeat(40),
      expectedParents: [request.repository.expectedTargetCommit, request.repository.sourceCommit],
      mergeCommitTimestamp: T2,
    },
    strategy: "merge" as const,
  } as Record<string, unknown>;
  delete base["requestDigest"];
  return Object.freeze({ ...base, requestDigest: integrationDigest(base) }) as unknown as IntegrationRequest;
}

async function uncertainLifecycle(request = requestInput()) {
  const accepted = createIntegrationRun(request, authorityFor(request));
  const claimed = claimIntegrationRun(
    accepted.snapshot,
    parseIntegrationCommandInput(command(request.runId, "claim:state", 1, "claim", T1), "claim"),
  );
  const prepareInput = parseIntegrationCommandInput(command(request.runId, "prepare:state", 2, "fenced", T2), "prepare");
  const validationInput = {
    phase: "pre-integration" as const,
    request,
    headCommit: request.repository.sourceCommit,
    treeId: request.repository.expectedIntegratedTree,
    plan: request.validationPlan,
  };
  const prepared = prepareIntegrationRun(
    claimed.snapshot,
    prepareInput,
    preflightResult(request),
    validationResult(validationInput),
  );
  const executeInput = parseIntegrationCommandInput(command(request.runId, "execute:state", 3, "fenced", T3), "execute");
  const uncertain = startIntegrationEffect(prepared.snapshot, executeInput);
  const receipt = await fakePorts(request).git.integrate(uncertain.snapshot.intent!, request, new AbortController().signal);
  return { accepted, claimed, prepared, uncertain, receipt };
}

describe("integration state fail-closed paths", () => {
  it("rejects inconsistent public command variants and stale fences", () => {
    const request = requestInput();
    expect(() => parseIntegrationCommandInput({ ...command(request.runId, "claim:bad", 1, "claim", T1), owner: null }, "claim"))
      .toThrow(IntegrationError);
    expect(() => parseIntegrationCommandInput({ ...command(request.runId, "cancel:bad", 1, "cancel", T1), owner: "worker:1" }, "cancel"))
      .toThrow(IntegrationError);
    expect(() => parseIntegrationCommandInput({ ...command(request.runId, "prepare:bad", 1, "fenced", T1), owner: null }, "prepare"))
      .toThrow(IntegrationError);

    const accepted = createIntegrationRun(request, authorityFor(request));
    expect(() => claimIntegrationRun(
      accepted.snapshot,
      parseIntegrationCommandInput(command(request.runId, "claim:backwards", 1, "claim", "2026-08-11T08:59:00.000Z"), "claim"),
    )).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => claimIntegrationRun(
      accepted.snapshot,
      parseIntegrationCommandInput(command(request.runId, "claim:version", 2, "claim", T1), "claim"),
    )).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(() => claimIntegrationRun(
      accepted.snapshot,
      parseIntegrationCommandInput(command("integration:other", "claim:identity", 1, "claim", T1), "claim"),
    )).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => claimIntegrationRun(
      accepted.snapshot,
      parseIntegrationCommandInput({ ...command(request.runId, "claim:window", 1, "claim", T1), leaseExpiresAt: T1 }, "claim"),
    )).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const claimed = claimIntegrationRun(accepted.snapshot, parseIntegrationCommandInput(command(request.runId, "claim:1", 1, "claim", T1), "claim"));
    expect(() => prepareIntegrationRun(
      claimed.snapshot,
      parseIntegrationCommandInput(command("integration:other", "prepare:wrong-run", 2, "fenced", T2), "prepare"),
      preflightResult(request),
      validationResult({ phase: "pre-integration", request, headCommit: request.repository.sourceCommit, treeId: request.repository.expectedIntegratedTree, plan: request.validationPlan }),
    )).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => prepareIntegrationRun(
      claimed.snapshot,
      parseIntegrationCommandInput(command(request.runId, "prepare:backdated", 2, "fenced", "2026-08-11T09:00:30.000Z"), "prepare"),
      preflightResult(request, T2),
      validationResult({ phase: "pre-integration", request, headCommit: request.repository.sourceCommit, treeId: request.repository.expectedIntegratedTree, plan: request.validationPlan }),
    )).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => prepareIntegrationRun(
      claimed.snapshot,
      parseIntegrationCommandInput(command(request.runId, "prepare:backdated-evidence", 2, "fenced", T2), "prepare"),
      preflightResult(request, T1),
      validationResult({ phase: "pre-integration", request, headCommit: request.repository.sourceCommit, treeId: request.repository.expectedIntegratedTree, plan: request.validationPlan }, T1),
    )).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => prepareIntegrationRun(
      claimed.snapshot,
      parseIntegrationCommandInput(command(request.runId, "prepare:stale", 2, "fenced", T2, 2), "prepare"),
      preflightResult(request),
      validationResult({ phase: "pre-integration", request, headCommit: request.repository.sourceCommit, treeId: request.repository.expectedIntegratedTree, plan: request.validationPlan }),
    )).toThrowError(expect.objectContaining({ code: "STALE_FENCE" }));
    expect(() => prepareIntegrationRun(
      claimed.snapshot,
      parseIntegrationCommandInput(command(request.runId, "prepare:expired", 2, "fenced", "2026-08-11T09:31:00.000Z"), "prepare"),
      preflightResult(request),
      validationResult({ phase: "pre-integration", request, headCommit: request.repository.sourceCommit, treeId: request.repository.expectedIntegratedTree, plan: request.validationPlan }),
    )).toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    expect(() => failIntegrationRun(
      claimed.snapshot,
      parseIntegrationCommandInput(command(request.runId, "fail:cleanup", 2, "fenced", T2), "execute"),
      "fixture-failure",
      { worktreeId: "integration-worktree:unexpected", cleaned: true, preservedEvidence: true, failureCode: null, observedAt: T2 },
    )).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("rejects drift, unauthorised conflict resolution, and inexact receipts", async () => {
    const request = requestInput();
    const accepted = createIntegrationRun(request, authorityFor(request));
    const claimed = claimIntegrationRun(accepted.snapshot, parseIntegrationCommandInput(command(request.runId, "claim:1", 1, "claim", T1), "claim"));
    const prepareInput = parseIntegrationCommandInput(command(request.runId, "prepare:1", 2, "fenced", T2), "prepare");
    const validation = validationResult({ phase: "pre-integration", request, headCommit: request.repository.sourceCommit, treeId: request.repository.expectedIntegratedTree, plan: request.validationPlan });
    const drift = withDigest({ ...preflightResult(request), targetTree: "0".repeat(40) }, "preflightDigest");
    expect(() => prepareIntegrationRun(claimed.snapshot, prepareInput, drift, validation))
      .toThrowError(expect.objectContaining({ code: "TARGET_DRIFT" }));

    const conflicted = withDigest({
      ...preflightResult(request),
      conflicts: [{ conflictId: "conflict:1", kind: "textual", path: "packages/example/src/index.ts", ruleCode: "textual-conflict", blocking: true }],
    }, "preflightDigest");
    const unresolved = prepareIntegrationRun(claimed.snapshot, prepareInput, conflicted, validation);
    expect(unresolved.snapshot).toMatchObject({ status: "failed", lastFailureCode: "unresolved-conflicts" });
    expect(replayIntegrationEvents([accepted.event, claimed.event, unresolved.event])).toEqual(unresolved.snapshot);
    const semanticConflict = withDigest({
      ...preflightResult(request),
      conflicts: [{ conflictId: "conflict:semantic", kind: "semantic", path: null, ruleCode: "semantic-conflict", blocking: true }],
    }, "preflightDigest");
    expect(prepareIntegrationRun(claimed.snapshot, prepareInput, semanticConflict, validation).snapshot)
      .toMatchObject({ status: "failed", lastFailureCode: "unresolved-conflicts" });

    const lifecycle = await uncertainLifecycle(request);
    expect(() => startIntegrationRecovery(
      lifecycle.uncertain.snapshot,
      parseIntegrationCommandInput(command(request.runId, "reconcile:backdated-start", 4, "fenced", T4), "reconcile"),
      T3,
    )).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const receiptInput = parseIntegrationCommandInput(command(request.runId, "receipt:bad", 4, "fenced", T4), "execute");
    const wrongScope = withDigest({ ...lifecycle.receipt, changedPaths: ["different.ts"] }, "receiptDigest");
    expect(() => recordIntegrationReceipt(lifecycle.uncertain.snapshot, receiptInput, wrongScope))
      .toThrowError(expect.objectContaining({ code: "GIT_BOUNDARY_FAILURE" }));

    const merge = mergeRequest();
    const mergeLifecycle = await uncertainLifecycle(merge);
    const wrongParents = withDigest({ ...mergeLifecycle.receipt, parents: [...mergeLifecycle.receipt.parents].reverse() }, "receiptDigest");
    expect(() => recordIntegrationReceipt(
      mergeLifecycle.uncertain.snapshot,
      parseIntegrationCommandInput(command(merge.runId, "receipt:parents", 4, "fenced", T4), "execute"),
      wrongParents,
    )).toThrowError(expect.objectContaining({ code: "GIT_BOUNDARY_FAILURE" }));
  });

  it("records exact failed and cancelled replay deltas and rejects a repeated acceptance", () => {
    const request = requestInput();
    const accepted = createIntegrationRun(request, authorityFor(request));
    const claimed = claimIntegrationRun(accepted.snapshot, parseIntegrationCommandInput(command(request.runId, "claim:failure", 1, "claim", T1), "claim"));
    const failed = failIntegrationRun(
      claimed.snapshot,
      parseIntegrationCommandInput(command(request.runId, "fail:1", 2, "fenced", T2), "execute"),
      "fixture-failure",
      null,
    );
    expect(replayIntegrationEvents([accepted.event, claimed.event, failed.event])).toEqual(failed.snapshot);

    const cancelled = cancelIntegrationRun(
      accepted.snapshot,
      parseIntegrationCommandInput(command(request.runId, "cancel:1", 1, "cancel", T1), "cancel"),
    );
    expect(replayIntegrationEvents([accepted.event, cancelled.event])).toEqual(cancelled.snapshot);
    expect(integrationCommandEquals(cancelled.event, "cancel:1", cancelled.event.command.commandFingerprint)).toBe(true);
    expect(integrationCommandEquals(cancelled.event, "cancel:other", cancelled.event.command.commandFingerprint)).toBe(false);
    expect(() => integrationStateTesting.assertReplayDelta(accepted.snapshot, { ...claimed.event, type: "integration.accepted" }))
      .toThrowError(expect.objectContaining({ code: "PERSISTENCE_MISMATCH" }));
    expect(() => integrationStateTesting.assertReplayDelta(null, { ...accepted.event, type: "integration.leased" }))
      .toThrowError(expect.objectContaining({ code: "PERSISTENCE_MISMATCH" }));
    expect(() => integrationStateTesting.assertReplayDelta(null, {
      ...accepted.event,
      command: { ...accepted.event.command, commandId: "integration-request:other" },
    })).toThrowError(expect.objectContaining({ code: "PERSISTENCE_MISMATCH" }));
    expect(() => integrationStateTesting.assertReplayDelta(accepted.snapshot, {
      ...claimed.event,
      snapshot: { ...claimed.snapshot, status: "pending" },
    })).toThrowError(expect.objectContaining({ code: "PERSISTENCE_MISMATCH" }));
    expect(() => integrationStateTesting.assertReplayDelta(accepted.snapshot, {
      ...claimed.event,
      snapshot: { ...claimed.snapshot, attemptsUsed: 2 },
    })).toThrowError(expect.objectContaining({ code: "PERSISTENCE_MISMATCH" }));
    const retry = failIntegrationRun(
      claimed.snapshot,
      parseIntegrationCommandInput(command(request.runId, "retry:1", 2, "fenced", T2), "execute"),
      "preflight-boundary-failed",
      null,
    );
    expect(() => integrationStateTesting.assertReplayDelta(claimed.snapshot, {
      ...retry.event,
      command: { ...retry.event.command, commandId: "integration-internal:forged" },
    })).toThrowError(expect.objectContaining({ code: "PERSISTENCE_MISMATCH" }));
  });

  it("fails reconciliation deterministically when recovery validation is wrong or absent", async () => {
    const request = requestInput();
    const lifecycle = await uncertainLifecycle(request);
    expect(() => failIntegrationRun(
      lifecycle.uncertain.snapshot,
      parseIntegrationCommandInput(command(request.runId, "fail:ambiguous", 4, "fenced", T4), "execute"),
      "ambiguous-effect",
      null,
    )).toThrowError(expect.objectContaining({ code: "INVALID_TRANSITION" }));
    const recoveredReceipt = withDigest({
      ...lifecycle.receipt,
      timingBasis: "recovered-observation" as const,
      committedAt: T4,
    }, "receiptDigest");
    const recoveryBase = {
      state: "ref-published" as const,
      effectGuardState: "absent" as const,
      intentDigest: lifecycle.uncertain.snapshot.intent!.intentDigest,
      observedTargetCommit: recoveredReceipt.integratedCommit,
      observedTargetTree: recoveredReceipt.integratedTree,
      receipt: recoveredReceipt,
      observedAt: T4,
    };
    const recovery = Object.freeze({ ...recoveryBase, recoveryDigest: integrationDigest(recoveryBase) });
    const wrongTargetBase = { ...recoveryBase, observedTargetCommit: request.repository.expectedTargetCommit, observedTargetTree: request.repository.expectedTargetTree };
    const wrongTarget = Object.freeze({ ...wrongTargetBase, recoveryDigest: integrationDigest(wrongTargetBase) });
    const cleanup = Object.freeze({ worktreeId: recoveredReceipt.worktreeId, cleaned: true, preservedEvidence: true, failureCode: null, observedAt: T4 });
    const post = validationResult({ phase: "post-integration", request, headCommit: recoveredReceipt.integratedCommit, treeId: recoveredReceipt.integratedTree, plan: request.validationPlan }, T4);
    const invalidPost = withDigest({ ...post, passed: false, failedRuleCodes: ["post-regression"] }, "resultDigest");
    const startedFor = (commandId: string) => startIntegrationRecovery(
      lifecycle.uncertain.snapshot,
      parseIntegrationCommandInput(command(request.runId, commandId, 4, "fenced", T4), "reconcile"),
      T4,
    );
    const terminalInputFor = (started: ReturnType<typeof startIntegrationRecovery>, recoveryDigest: string) => Object.freeze({
      ...parseIntegrationCommandInput(command(request.runId, "reconcile:terminal", started.snapshot.aggregateVersion, "fenced", T4), "reconcile"),
      commandId: stableIntegrationId("integration-internal", recoveryDigest, "reconciled"),
    });
    const firstAttempt = startedFor("reconcile:attempt-1");
    const earlyExhaustionBase = parseIntegrationCommandInput(command(request.runId, "reconcile:early-exhaustion", firstAttempt.snapshot.aggregateVersion, "fenced", T4), "reconcile");
    const earlyExhaustion = Object.freeze({ ...earlyExhaustionBase, commandId: stableIntegrationId("integration-internal", lifecycle.uncertain.snapshot.intent!.intentDigest, "recovery-exhausted") });
    expect(() => exhaustIntegrationRecovery(firstAttempt.snapshot, earlyExhaustion))
      .toThrowError(expect.objectContaining({ code: "INVALID_TRANSITION" }));
    const secondAttempt = startIntegrationRecovery(firstAttempt.snapshot, parseIntegrationCommandInput(command(request.runId, "reconcile:attempt-2", firstAttempt.snapshot.aggregateVersion, "fenced", T4), "reconcile"), T4);
    const thirdAttempt = startIntegrationRecovery(secondAttempt.snapshot, parseIntegrationCommandInput(command(request.runId, "reconcile:attempt-3", secondAttempt.snapshot.aggregateVersion, "fenced", T4), "reconcile"), T4);
    expect(() => startIntegrationRecovery(thirdAttempt.snapshot, parseIntegrationCommandInput(command(request.runId, "reconcile:attempt-4", thirdAttempt.snapshot.aggregateVersion, "fenced", T4), "reconcile"), T4))
      .toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    expect(() => exhaustIntegrationRecovery(
      thirdAttempt.snapshot,
      parseIntegrationCommandInput({ ...command(request.runId, "reconcile:wrong-owner", thirdAttempt.snapshot.aggregateVersion, "fenced", T4), owner: "worker:other" }, "reconcile"),
      T4,
    )).toThrowError(expect.objectContaining({ code: "STALE_FENCE" }));
    expect(() => exhaustIntegrationRecovery(
      thirdAttempt.snapshot,
      parseIntegrationCommandInput(command(request.runId, "reconcile:backdated-exhaustion", thirdAttempt.snapshot.aggregateVersion, "fenced", T0), "reconcile"),
      T4,
    )).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const wrongStarted = startedFor("reconcile:wrong-target");
    expect(() => reconcileIntegrationRun(
      wrongStarted.snapshot,
      parseIntegrationCommandInput(command(request.runId, "reconcile:not-internal", wrongStarted.snapshot.aggregateVersion, "fenced", T4), "reconcile"),
      recovery,
      post,
      cleanup,
    )).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => reconcileIntegrationRun(
      wrongStarted.snapshot,
      terminalInputFor(wrongStarted, wrongTarget.recoveryDigest),
      wrongTarget,
      post,
      cleanup,
    )).toThrowError(expect.objectContaining({ code: "GIT_BOUNDARY_FAILURE" }));
    const forgedObservedBase = { ...recoveryBase, receipt: lifecycle.receipt };
    const forgedObserved = Object.freeze({ ...forgedObservedBase, recoveryDigest: integrationDigest(forgedObservedBase) });
    const forgedStarted = startedFor("reconcile:forged-observed");
    expect(() => reconcileIntegrationRun(
      forgedStarted.snapshot,
      terminalInputFor(forgedStarted, forgedObserved.recoveryDigest),
      forgedObserved,
      post,
      cleanup,
    )).toThrowError(expect.objectContaining({ code: "GIT_BOUNDARY_FAILURE" }));
    const backdatedReceipt = withDigest({ ...recoveredReceipt, committedAt: T3 }, "receiptDigest");
    const backdatedRecoveryBase = { ...recoveryBase, receipt: backdatedReceipt, observedAt: T3 };
    const backdatedRecovery = Object.freeze({ ...backdatedRecoveryBase, recoveryDigest: integrationDigest(backdatedRecoveryBase) });
    const backdatedStarted = startedFor("reconcile:backdated-evidence");
    expect(() => reconcileIntegrationRun(
      backdatedStarted.snapshot,
      terminalInputFor(backdatedStarted, backdatedRecovery.recoveryDigest),
      backdatedRecovery,
      post,
      cleanup,
    )).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const invalidStarted = startedFor("reconcile:invalid");
    const invalid = reconcileIntegrationRun(
      invalidStarted.snapshot,
      terminalInputFor(invalidStarted, recovery.recoveryDigest),
      recovery,
      invalidPost,
      cleanup,
    );
    expect(invalid.snapshot).toMatchObject({ status: "failed", lastFailureCode: "post-validation-failed" });
    const wrongCoverage = withDigest({ ...post, coverageDigest: "0".repeat(64) }, "resultDigest");
    const wrongCoverageStarted = startedFor("reconcile:wrong-coverage");
    expect(reconcileIntegrationRun(
      wrongCoverageStarted.snapshot,
      terminalInputFor(wrongCoverageStarted, recovery.recoveryDigest),
      recovery,
      wrongCoverage,
      cleanup,
    ).snapshot).toMatchObject({ status: "failed", lastFailureCode: "post-validation-invalid", postValidation: null });
    const lostCleanupStarted = startedFor("reconcile:lost-cleanup");
    expect(reconcileIntegrationRun(
      lostCleanupStarted.snapshot,
      terminalInputFor(lostCleanupStarted, recovery.recoveryDigest),
      recovery,
      post,
      { ...cleanup, cleaned: false, preservedEvidence: false, failureCode: "cleanup-failed" },
    ).snapshot).toMatchObject({ status: "failed", lastFailureCode: "cleanup-evidence-lost" });
    const missingCleanupStarted = startedFor("reconcile:missing-cleanup");
    expect(reconcileIntegrationRun(
      missingCleanupStarted.snapshot,
      terminalInputFor(missingCleanupStarted, recovery.recoveryDigest),
      recovery,
      post,
      null,
    ).snapshot).toMatchObject({ status: "failed", lastFailureCode: "recovery-cleanup-missing" });
    const missingStarted = startedFor("reconcile:missing");
    const missing = reconcileIntegrationRun(
      missingStarted.snapshot,
      terminalInputFor(missingStarted, recovery.recoveryDigest),
      recovery,
      null,
      null,
    );
    expect(missing.snapshot).toMatchObject({ status: "failed", lastFailureCode: "recovery-validation-missing" });
  });

  it("binds internal receipt and committed-terminal commands and replays committed failure evidence", async () => {
    const request = requestInput();
    const lifecycle = await uncertainLifecycle(request);
    const publicReceiptInput = parseIntegrationCommandInput(
      command(request.runId, "receipt:public", 4, "fenced", lifecycle.receipt.committedAt),
      "execute",
    );
    expect(() => recordIntegrationReceipt(lifecycle.uncertain.snapshot, publicReceiptInput, lifecycle.receipt))
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));

    const receiptInput = Object.freeze({
      ...publicReceiptInput,
      commandId: stableIntegrationId("integration-internal", lifecycle.uncertain.snapshot.intent!.intentDigest, "receipt"),
    });
    const committed = recordIntegrationReceipt(lifecycle.uncertain.snapshot, receiptInput, lifecycle.receipt);
    const cleanup = Object.freeze({
      worktreeId: lifecycle.receipt.worktreeId,
      cleaned: true,
      preservedEvidence: true,
      failureCode: null,
      observedAt: T4,
    });
    const post = validationResult({
      phase: "post-integration",
      request,
      headCommit: lifecycle.receipt.integratedCommit,
      treeId: lifecycle.receipt.integratedTree,
      plan: request.validationPlan,
    }, T4);
    const publicTerminalInput = parseIntegrationCommandInput(
      command(request.runId, "terminal:public", 5, "fenced", T4),
      "execute",
    );
    expect(() => completeIntegrationRun(committed.snapshot, publicTerminalInput, post, cleanup))
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => failIntegrationRun(committed.snapshot, publicTerminalInput, "post-validation-failed", null))
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => failIntegrationRun(committed.snapshot, publicTerminalInput, "post-validation-failed", cleanup))
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));

    const terminalInput = Object.freeze({
      ...publicTerminalInput,
      commandId: stableIntegrationId("integration-internal", lifecycle.receipt.receiptDigest, "terminal"),
    });
    const backdatedPost = validationResult({
      phase: "post-integration",
      request,
      headCommit: lifecycle.receipt.integratedCommit,
      treeId: lifecycle.receipt.integratedTree,
      plan: request.validationPlan,
    }, T3);
    expect(() => completeIntegrationRun(committed.snapshot, terminalInput, backdatedPost, cleanup))
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const wrongCoverage = withDigest({ ...post, coverageDigest: "0".repeat(64) }, "resultDigest");
    expect(() => completeIntegrationRun(committed.snapshot, terminalInput, wrongCoverage, cleanup))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => completeIntegrationRun(committed.snapshot, terminalInput, post, { ...cleanup, worktreeId: "integration-worktree:unexpected" }))
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const failedPost = withDigest({ ...post, passed: false, failedRuleCodes: ["post-regression"] }, "resultDigest");
    const terminalFailure = completeIntegrationRun(committed.snapshot, terminalInput, failedPost, cleanup);
    expect(terminalFailure.snapshot).toMatchObject({ status: "failed", lastFailureCode: "post-validation-failed" });
    expect(replayIntegrationEvents([
      lifecycle.accepted.event,
      lifecycle.claimed.event,
      lifecycle.prepared.event,
      lifecycle.uncertain.event,
      committed.event,
      terminalFailure.event,
    ])).toEqual(terminalFailure.snapshot);
    const unreachableTerminalProjection = { ...terminalFailure.snapshot.terminal!, cleanup: null } as Record<string, unknown>;
    delete unreachableTerminalProjection["terminalDigest"];
    const unreachableTerminal = Object.freeze({ ...unreachableTerminalProjection, terminalDigest: integrationDigest(unreachableTerminalProjection) });
    expect(() => parseIntegrationRunSnapshot({ ...terminalFailure.snapshot, terminal: unreachableTerminal }))
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));

    const preEffectFailureInput = parseIntegrationCommandInput(
      command(request.runId, "fail:prepared", lifecycle.prepared.snapshot.aggregateVersion, "fenced", T3),
      "execute",
    );
    const preEffectFailure = failIntegrationRun(lifecycle.prepared.snapshot, preEffectFailureInput, "pre-effect-terminal", null, T3);
    expect(() => parseIntegrationRunSnapshot({
      ...preEffectFailure.snapshot,
      aggregateVersion: preEffectFailure.snapshot.aggregateVersion + 1,
      eventSequence: preEffectFailure.snapshot.eventSequence + 1,
    })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));

    const failureInput = Object.freeze({
      ...publicTerminalInput,
      commandId: stableIntegrationId("integration-internal", lifecycle.receipt.receiptDigest, "terminal-failure"),
    });
    const failed = failIntegrationRun(committed.snapshot, failureInput, "post-validation-failed", cleanup);
    expect(replayIntegrationEvents([
      lifecycle.accepted.event,
      lifecycle.claimed.event,
      lifecycle.prepared.event,
      lifecycle.uncertain.event,
      committed.event,
      failed.event,
    ])).toEqual(failed.snapshot);
  });
});
