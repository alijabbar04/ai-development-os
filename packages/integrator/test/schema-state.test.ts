import { describe, expect, it } from "vitest";
import {
  IntegrationError,
  cancelIntegrationRun,
  claimIntegrationRun,
  completeIntegrationRun,
  createIntegrationRequest,
  createIntegrationRun,
  integrationDigest,
  parseIntegrationCommandInput,
  parseIntegrationEvent,
  parseIntegrationRunSnapshot,
  prepareIntegrationRun,
  recordIntegrationReceipt,
  reconcileIntegrationRun,
  replayIntegrationEvents,
  stableIntegrationId,
  startIntegrationEffect,
  startIntegrationRecovery,
} from "../src/index.js";
import {
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

describe("integration contracts and exact replay", () => {
  it("binds evaluation admission, exact repository state, scope, parents, and production refusal", () => {
    const request = requestInput();
    expect(createIntegrationRequest(request)).toEqual(request);
    expect(() => createIntegrationRequest({ ...request, requestDigest: "0".repeat(64) })).toThrow(IntegrationError);
    expect(() => createIntegrationRequest({
      ...request,
      repository: { ...request.repository, targetRef: "refs/heads/main" },
      requestDigest: request.requestDigest,
    })).toThrow(IntegrationError);
    expect(() => createIntegrationRequest({
      ...request,
      idempotencyKey: "integration-internal:forged",
      requestDigest: request.requestDigest,
    })).toThrow(IntegrationError);
    const mergeRepository = {
      ...request.repository,
      expectedIntegratedCommit: "e".repeat(40),
      expectedIntegratedTree: "f".repeat(40),
      expectedParents: [request.repository.expectedTargetCommit, request.repository.sourceCommit],
      mergeCommitTimestamp: T2,
    };
    const mergeBase = { ...request, strategy: "merge", repository: mergeRepository };
    const merge = { ...mergeBase, requestDigest: integrationDigest(Object.fromEntries(Object.entries(mergeBase).filter(([key]) => key !== "requestDigest"))) };
    expect(createIntegrationRequest(merge).repository.expectedParents).toEqual([
      request.repository.expectedTargetCommit,
      request.repository.sourceCommit,
    ]);
    const wrongOrderBase = { ...merge, repository: { ...mergeRepository, expectedParents: [...mergeRepository.expectedParents].reverse() } };
    const wrongOrder = { ...wrongOrderBase, requestDigest: integrationDigest(Object.fromEntries(Object.entries(wrongOrderBase).filter(([key]) => key !== "requestDigest"))) };
    expect(() => createIntegrationRequest(wrongOrder)).toThrow(IntegrationError);
  });

  it("replays the exact lease, prepared intent, ambiguous marker, receipt, and terminal validation", async () => {
    const request = requestInput();
    const authority = authorityFor(request);
    const accepted = createIntegrationRun(request, authority);
    const claimInput = parseIntegrationCommandInput(command(request.runId, "command:claim", 1, "claim", T1), "claim");
    const claimed = claimIntegrationRun(accepted.snapshot, claimInput);
    const prepareInput = parseIntegrationCommandInput(command(request.runId, "command:prepare", 2, "fenced", T2), "prepare");
    const ports = fakePorts(request);
    const validationInput = { phase: "pre-integration" as const, request, headCommit: request.repository.sourceCommit, treeId: request.repository.expectedIntegratedTree, plan: request.validationPlan };
    const prepared = prepareIntegrationRun(claimed.snapshot, prepareInput, preflightResult(request), validationResult(validationInput));
    const exactlyExpiredExecute = parseIntegrationCommandInput(command(request.runId, "command:execute-expired", 3, "fenced", "2026-08-11T09:30:00.000Z"), "execute");
    expect(() => startIntegrationEffect(prepared.snapshot, exactlyExpiredExecute)).toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    const executeInput = parseIntegrationCommandInput(command(request.runId, "command:execute", 3, "fenced", T3), "execute");
    const uncertain = startIntegrationEffect(prepared.snapshot, executeInput);
    const receipt = await ports.git.integrate(uncertain.snapshot.intent!, request, new AbortController().signal);
    const receiptInput = Object.freeze({ ...executeInput, commandId: stableIntegrationId("integration-internal", uncertain.snapshot.intent!.intentDigest, "receipt"), expectedVersion: 4, occurredAt: receipt.committedAt });
    const committed = recordIntegrationReceipt(uncertain.snapshot, receiptInput, receipt);
    const terminalInput = Object.freeze({ ...executeInput, commandId: stableIntegrationId("integration-internal", receipt.receiptDigest, "terminal"), expectedVersion: 5, occurredAt: T4 });
    const postValidation = validationResult({ phase: "post-integration", request, headCommit: receipt.integratedCommit, treeId: receipt.integratedTree, plan: request.validationPlan }, T4);
    const completed = completeIntegrationRun(committed.snapshot, terminalInput, postValidation, {
      worktreeId: receipt.worktreeId,
      cleaned: true,
      preservedEvidence: true,
      failureCode: null,
      observedAt: T4,
    });
    const events = [accepted.event, claimed.event, prepared.event, uncertain.event, committed.event, completed.event];
    expect(replayIntegrationEvents(events)).toEqual(completed.snapshot);
    expect(parseIntegrationEvent(completed.event)).toEqual(completed.event);
    expect(parseIntegrationRunSnapshot(completed.snapshot)).toEqual(completed.snapshot);
    expect(completed.snapshot).toMatchObject({ status: "completed", productionEnabled: false, attemptsUsed: 1, nextFencingToken: 2 });
    expect(() => replayIntegrationEvents([{ ...accepted.event, eventId: stableIntegrationId("tampered", "1") }])).toThrow(IntegrationError);
    const forgedAcceptedSnapshot = Object.freeze({ ...accepted.snapshot, lastFailureCode: "forged-acceptance-failure" });
    const forgedAcceptedDigest = integrationDigest(forgedAcceptedSnapshot);
    const forgedAcceptedEvent = Object.freeze({
      ...accepted.event,
      afterDigest: forgedAcceptedDigest,
      eventId: stableIntegrationId("integration-event", request.runId, "1", "integration.accepted", accepted.event.command.commandFingerprint, forgedAcceptedDigest),
      snapshot: forgedAcceptedSnapshot,
    });
    expect(() => replayIntegrationEvents([forgedAcceptedEvent])).toThrowError(expect.objectContaining({ code: "PERSISTENCE_MISMATCH" }));
    expect(() => replayIntegrationEvents([accepted.event, { ...claimed.event, beforeDigest: "0".repeat(64) }])).toThrow(IntegrationError);
    expect(() => replayIntegrationEvents(new Array(1))).toThrow();
    expect(() => parseIntegrationRunSnapshot({ ...completed.snapshot, receipt: null })).toThrow(IntegrationError);
    expect(() => parseIntegrationRunSnapshot({ ...prepared.snapshot, lease: null })).toThrow(IntegrationError);
    const expiryIntentProjection = { ...prepared.snapshot.intent!, createdAt: prepared.snapshot.lease!.expiresAt } as Record<string, unknown>;
    delete expiryIntentProjection["intentDigest"];
    const expiryIntent = Object.freeze({ ...expiryIntentProjection, intentDigest: integrationDigest(expiryIntentProjection) });
    expect(() => parseIntegrationRunSnapshot({ ...prepared.snapshot, intent: expiryIntent, updatedAt: prepared.snapshot.lease!.expiresAt }))
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));

    const validationConflict = Object.freeze({
      conflictId: "conflict:validation-bound",
      kind: "semantic" as const,
      path: request.allowedPaths[0]!,
      ruleCode: "validation-conflict",
      blocking: true as const,
    });
    const boundedRequest = requestInput({ bounds: Object.freeze({ ...request.bounds, maximumConflicts: 0 }) });
    const boundedAccepted = createIntegrationRun(boundedRequest, authorityFor(boundedRequest));
    const boundedClaimed = claimIntegrationRun(boundedAccepted.snapshot, parseIntegrationCommandInput(command(boundedRequest.runId, "claim:bounded-validation", 1, "claim", T1), "claim"));
    const boundedValidationInput = { phase: "pre-integration" as const, request: boundedRequest, headCommit: boundedRequest.repository.sourceCommit, treeId: boundedRequest.repository.expectedIntegratedTree, plan: boundedRequest.validationPlan };
    const boundedValidationBase = { ...validationResult(boundedValidationInput), passed: false, conflicts: [validationConflict] } as Record<string, unknown>;
    delete boundedValidationBase["resultDigest"];
    const boundedValidation = Object.freeze({ ...boundedValidationBase, resultDigest: integrationDigest(boundedValidationBase) });
    expect(() => prepareIntegrationRun(boundedClaimed.snapshot, parseIntegrationCommandInput(command(boundedRequest.runId, "prepare:bounded-validation", 2, "fenced", T2), "prepare"), preflightResult(boundedRequest), boundedValidation))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    const forgedValidationProjection = { ...prepared.snapshot.preValidation!, resultId: "validation-result:forged" } as Record<string, unknown>;
    delete forgedValidationProjection["resultDigest"];
    const forgedValidation = Object.freeze({ ...forgedValidationProjection, resultDigest: integrationDigest(forgedValidationProjection) });
    const forgedIntentProjection = { ...prepared.snapshot.intent!, validationResultDigest: forgedValidation.resultDigest } as Record<string, unknown>;
    delete forgedIntentProjection["intentDigest"];
    const forgedIntent = Object.freeze({ ...forgedIntentProjection, intentDigest: integrationDigest(forgedIntentProjection) });
    expect(() => parseIntegrationRunSnapshot({ ...prepared.snapshot, preValidation: forgedValidation, intent: forgedIntent })).toThrow(IntegrationError);

    const failedValidationProjection = { ...prepared.snapshot.preValidation!, passed: false, failedRuleCodes: ["deterministic-failure"] } as Record<string, unknown>;
    delete failedValidationProjection["resultDigest"];
    const failedValidation = Object.freeze({ ...failedValidationProjection, resultDigest: integrationDigest(failedValidationProjection) });
    const invalidIntentProjection = { ...prepared.snapshot.intent!, validationResultDigest: failedValidation.resultDigest } as Record<string, unknown>;
    delete invalidIntentProjection["intentDigest"];
    const invalidIntent = Object.freeze({ ...invalidIntentProjection, intentDigest: integrationDigest(invalidIntentProjection) });
    expect(() => parseIntegrationRunSnapshot({ ...prepared.snapshot, preValidation: failedValidation, intent: invalidIntent })).toThrow(IntegrationError);

    const recoveryBase = {
      state: "ref-published" as const,
      effectGuardState: "absent" as const,
      intentDigest: committed.snapshot.intent!.intentDigest,
      observedTargetCommit: receipt.integratedCommit,
      observedTargetTree: receipt.integratedTree,
      receipt,
      observedAt: T4,
    };
    const recovery = { ...recoveryBase, recoveryDigest: integrationDigest(recoveryBase) };
    const reconcileCommand = parseIntegrationCommandInput(command(request.runId, "command:reconcile", 5, "fenced", T4), "reconcile");
    const recoveryStarted = startIntegrationRecovery(committed.snapshot, reconcileCommand, T4);
    const reconcileInput = Object.freeze({ ...reconcileCommand, commandId: stableIntegrationId("integration-internal", recovery.recoveryDigest, "reconciled"), expectedVersion: 6, occurredAt: T4 });
    const reconciled = reconcileIntegrationRun(recoveryStarted.snapshot, reconcileInput, recovery, postValidation, {
      worktreeId: receipt.worktreeId,
      cleaned: true,
      preservedEvidence: true,
      failureCode: null,
      observedAt: T4,
    });
    expect(reconciled.snapshot.status).toBe("completed");
    expect(replayIntegrationEvents([accepted.event, claimed.event, prepared.event, uncertain.event, committed.event, recoveryStarted.event, reconciled.event])).toEqual(reconciled.snapshot);

    const revertedBase = {
      state: "diverged" as const,
      effectGuardState: "absent" as const,
      intentDigest: committed.snapshot.intent!.intentDigest,
      observedTargetCommit: request.repository.expectedTargetCommit,
      observedTargetTree: request.repository.expectedTargetTree,
      receipt: null,
      observedAt: T4,
    };
    const reverted = { ...revertedBase, recoveryDigest: integrationDigest(revertedBase) };
    const revertedStart = startIntegrationRecovery(committed.snapshot, reconcileCommand, T4);
    const revertedInput = Object.freeze({ ...reconcileCommand, commandId: stableIntegrationId("integration-internal", reverted.recoveryDigest, "reconciled"), expectedVersion: 6, occurredAt: T4 });
    const revertedResult = reconcileIntegrationRun(revertedStart.snapshot, revertedInput, reverted, null, {
      worktreeId: receipt.worktreeId,
      cleaned: true,
      preservedEvidence: false,
      failureCode: null,
      observedAt: T4,
    });
    expect(revertedResult.snapshot).toMatchObject({ status: "failed", lastFailureCode: "recovery-diverged", receipt });
    const falseNoEffectBase = { ...revertedBase, state: "no-effect" as const };
    const falseNoEffect = { ...falseNoEffectBase, recoveryDigest: integrationDigest(falseNoEffectBase) };
    const falseNoEffectInput = Object.freeze({ ...reconcileCommand, commandId: stableIntegrationId("integration-internal", falseNoEffect.recoveryDigest, "reconciled"), expectedVersion: 6, occurredAt: T4 });
    expect(() => reconcileIntegrationRun(revertedStart.snapshot, falseNoEffectInput, falseNoEffect, null, null))
      .toThrowError(expect.objectContaining({ code: "GIT_BOUNDARY_FAILURE" }));
  });

  it("enforces monotonic fencing, lease expiry, cancellation reachability, and immutable internal namespace", () => {
    const request = requestInput();
    const accepted = createIntegrationRun(request, authorityFor(request));
    const claimOne = claimIntegrationRun(accepted.snapshot, parseIntegrationCommandInput(command(request.runId, "claim:1", 1, "claim", T1), "claim"));
    expect(claimOne.snapshot.lease?.fencingToken).toBe(1);
    expect(() => claimIntegrationRun(claimOne.snapshot, parseIntegrationCommandInput(command(request.runId, "claim:2", 2, "claim", T2), "claim"))).toThrow(IntegrationError);
    const expiredClaim = claimIntegrationRun(claimOne.snapshot, parseIntegrationCommandInput({
      ...command(request.runId, "claim:2", 2, "claim", "2026-08-11T09:31:00.000Z"),
      leaseExpiresAt: "2026-08-11T09:45:00.000Z",
    }, "claim"));
    expect(expiredClaim.snapshot.lease?.fencingToken).toBe(2);
    const cancelled = cancelIntegrationRun(expiredClaim.snapshot, parseIntegrationCommandInput(command(request.runId, "cancel:1", 3, "cancel", "2026-08-11T09:32:00.000Z"), "cancel"));
    expect(cancelled.snapshot.status).toBe("cancelled");
    expect(() => parseIntegrationCommandInput(command(request.runId, "integration-internal:forged", 1, "claim", T1), "claim")).toThrow(IntegrationError);
    expect(() => parseIntegrationRunSnapshot({ ...cancelled.snapshot, aggregateVersion: 20, eventSequence: 20 })).toThrow(IntegrationError);
  });

  it("rejects advisory resolution without exact separately authorized authority and scope", () => {
    const request = requestInput();
    const proposalBase = {
      proposalId: "proposal:1",
      authority: "none" as const,
      conflictIds: ["conflict:1"],
      patchArtifactDigest: "a".repeat(64),
      resultingTree: request.repository.expectedIntegratedTree,
      allowedPaths: request.allowedPaths,
      validationPlanDigest: request.validationPlan.planDigest,
    };
    const proposal = { ...proposalBase, proposalDigest: integrationDigest(proposalBase) };
    const unauthorizedBase = { ...request, resolutionProposal: proposal, resolutionAuthorization: null };
    const unauthorized = { ...unauthorizedBase, requestDigest: integrationDigest(Object.fromEntries(Object.entries(unauthorizedBase).filter(([key]) => key !== "requestDigest"))) };
    expect(() => createIntegrationRequest(unauthorized)).toThrow(IntegrationError);
  });
});
