import { describe, expect, it } from "vitest";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IntegrationError,
  createProductionDisabledIntegrationService,
  integrationDigest,
} from "../src/index.js";
import { createIntegrationServiceForTesting as createRawIntegrationServiceForTesting } from "../src/testing/index.js";
import { T0, T1, T2, T3, T4, TEST_CLOCK, authorityFor, command, fakePorts, preflightResult, requestInput, validationResult } from "./fixtures.js";

function createIntegrationServiceForTesting(options: Omit<Parameters<typeof createRawIntegrationServiceForTesting>[0], "clock">) {
  return createRawIntegrationServiceForTesting({ ...options, clock: TEST_CLOCK });
}

function serviceFixture(request = requestInput()) {
  const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
  const ports = fakePorts(request);
  const service = createIntegrationServiceForTesting({ persistence, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(request) });
  return { persistence, ports, service, request };
}

describe("durable serialized integration service", () => {
  it("keeps the production constructor literally disabled before any Git or validation callback", async () => {
    const request = requestInput();
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const ports = fakePorts(request);
    const service = createProductionDisabledIntegrationService({ persistence, clock: TEST_CLOCK, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(request) });
    const accepted = await service.accept(request);
    const claimed = await service.claim(command(request.runId, "claim:1", accepted.aggregateVersion, "claim", T1));
    await expect(service.prepare(command(request.runId, "prepare:1", claimed.aggregateVersion, "fenced", T2))).rejects.toMatchObject({ code: "PRODUCTION_DISABLED" });
    expect(ports.counts).toMatchObject({ preflight: 0, integrate: 0, validate: 0 });
    expect(service.productionEnabled).toBe(false);
  });

  it("keeps execute and reconciliation disabled after testing-created durable handoff states", async () => {
    const preparedRequest = requestInput({ runId: "integration:production-execute-refusal", idempotencyKey: "request:production-execute-refusal" });
    const preparedPersistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const preparedPorts = fakePorts(preparedRequest);
    const preparedAuthority = authorityFor(preparedRequest);
    const testingPrepared = createIntegrationServiceForTesting({ persistence: preparedPersistence, git: preparedPorts.git, validation: preparedPorts.validation, authorityConfiguration: preparedAuthority });
    await testingPrepared.accept(preparedRequest);
    await testingPrepared.claim(command(preparedRequest.runId, "claim:production-execute", 1, "claim", T1));
    await testingPrepared.prepare(command(preparedRequest.runId, "prepare:production-execute", 2, "fenced", T2));
    const productionPrepared = createProductionDisabledIntegrationService({ persistence: preparedPersistence, clock: TEST_CLOCK, git: preparedPorts.git, validation: preparedPorts.validation, authorityConfiguration: preparedAuthority });
    await expect(productionPrepared.execute(command(preparedRequest.runId, "execute:production-disabled", 3, "fenced", T3))).rejects.toMatchObject({ code: "PRODUCTION_DISABLED" });
    expect(preparedPorts.counts.integrate).toBe(0);
    await preparedPersistence.close();

    const uncertainRequest = requestInput({ runId: "integration:production-reconcile-refusal", idempotencyKey: "request:production-reconcile-refusal" });
    const uncertainPersistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const uncertainPorts = fakePorts(uncertainRequest);
    const uncertainGit = Object.freeze({
      ...uncertainPorts.git,
      async integrate(): Promise<never> {
        uncertainPorts.counts.integrate += 1;
        throw new Error("simulated lost Git acknowledgement");
      },
    });
    const uncertainAuthority = authorityFor(uncertainRequest);
    const testingUncertain = createIntegrationServiceForTesting({ persistence: uncertainPersistence, git: uncertainGit, validation: uncertainPorts.validation, authorityConfiguration: uncertainAuthority });
    await testingUncertain.accept(uncertainRequest);
    await testingUncertain.claim(command(uncertainRequest.runId, "claim:production-reconcile", 1, "claim", T1));
    await testingUncertain.prepare(command(uncertainRequest.runId, "prepare:production-reconcile", 2, "fenced", T2));
    await expect(testingUncertain.execute(command(uncertainRequest.runId, "execute:production-reconcile", 3, "fenced", T3))).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
    expect((await testingUncertain.get(uncertainRequest.runId))?.status).toBe("effect-uncertain");
    const countsBeforeProduction = { ...uncertainPorts.counts };
    const productionUncertain = createProductionDisabledIntegrationService({ persistence: uncertainPersistence, clock: TEST_CLOCK, git: uncertainGit, validation: uncertainPorts.validation, authorityConfiguration: uncertainAuthority });
    await expect(productionUncertain.reconcile(command(uncertainRequest.runId, "reconcile:production-disabled", 4, "fenced", T4))).rejects.toMatchObject({ code: "PRODUCTION_DISABLED" });
    expect(uncertainPorts.counts).toEqual(countsBeforeProduction);
    await uncertainPersistence.close();
  });

  it("persists an exact successful lifecycle and returns exact retries without a second effect", async () => {
    const { persistence, ports, service, request } = serviceFixture();
    const accepted = await service.accept(request);
    expect(await service.accept(request)).toEqual(accepted);
    const claimCommand = command(request.runId, "claim:1", 1, "claim", T1);
    const claimed = await service.claim(claimCommand);
    expect(await service.claim(claimCommand)).toEqual(claimed);
    const prepareCommand = command(request.runId, "prepare:1", 2, "fenced", T2);
    const prepared = await service.prepare(prepareCommand);
    expect(await service.prepare(prepareCommand)).toEqual(prepared);
    expect(ports.counts.preflight).toBe(1);
    const readsBeforeInvalid = { ...ports.counts };
    await expect(service.prepare(command(request.runId, "prepare:invalid-state", 3, "fenced", T3))).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(ports.counts).toEqual(readsBeforeInvalid);
    const executeCommand = command(request.runId, "execute:1", 3, "fenced", T3);
    const completed = await service.execute(executeCommand);
    expect(completed.status).toBe("completed");
    expect(await service.execute(executeCommand)).toEqual(completed);
    expect(ports.counts.integrate).toBe(1);
    expect(ports.counts.validate).toBe(2);
    expect(await service.get(request.runId)).toEqual(completed);
    expect(await service.history(request.runId)).toHaveLength(6);
    await expect(service.claim({ ...claimCommand, commandId: "execute:1" })).rejects.toMatchObject({ code: "CONFLICT" });
    await persistence.close();
  });

  it("serializes concurrent targets and rejects stale fences", async () => {
    const firstRequest = requestInput();
    const secondRequest = requestInput({ runId: "integration:2", idempotencyKey: "integration-request:2" });
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const ports = fakePorts(firstRequest);
    const service = createIntegrationServiceForTesting({ persistence, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(firstRequest, secondRequest) });
    await service.accept(firstRequest);
    await service.accept(secondRequest);
    await service.claim(command(firstRequest.runId, "claim:1", 1, "claim", T1));
    await expect(service.claim(command(secondRequest.runId, "claim:2", 1, "claim", T1))).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    await expect(service.prepare(command(firstRequest.runId, "prepare:stale", 2, "fenced", T2, 2))).rejects.toMatchObject({ code: "STALE_FENCE" });
    await persistence.close();
  });

  it("uses the trusted service clock for future-command, lease, and deadline refusal", async () => {
    const request = requestInput({ runId: "integration:clock", idempotencyKey: "request:clock" });
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const ports = fakePorts(request);
    const early = createRawIntegrationServiceForTesting({ persistence, clock: { now: () => new Date(T1) }, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(request) });
    await early.accept(request);
    const claim = command(request.runId, "claim:clock", 1, "claim", T1);
    const claimed = await early.claim(claim);
    await expect(early.cancel(command(request.runId, "cancel:future", 2, "cancel", T2))).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const expired = createRawIntegrationServiceForTesting({ persistence, clock: { now: () => new Date("2026-08-11T09:31:00.000Z") }, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(request) });
    expect(await expired.claim(claim)).toEqual(claimed);
    await expect(expired.prepare(command(request.runId, "prepare:expired", 2, "fenced", T2))).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    expect(ports.counts.preflight).toBe(0);
    await persistence.close();
  });

  it("derives durable preparation time from later asynchronous evidence while preserving submission idempotency", async () => {
    const request = requestInput({ runId: "integration:advancing-clock", idempotencyKey: "request:advancing-clock" });
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const base = fakePorts(request);
    const git = Object.freeze({ ...base.git, async preflight(candidate: typeof request) { await Promise.resolve(); return preflightResult(candidate, T2); } });
    const validation = Object.freeze({ ...base.validation, async validate(input: Parameters<typeof base.validation.validate>[0]) { await Promise.resolve(); return validationResult(input, T3); } });
    const service = createRawIntegrationServiceForTesting({ persistence, clock: { now: () => new Date(T3) }, git, validation, authorityConfiguration: authorityFor(request) });
    await service.accept(request);
    await service.claim(command(request.runId, "claim:advancing", 1, "claim", T1));
    const submitted = command(request.runId, "prepare:advancing", 2, "fenced", T1);
    const prepared = await service.prepare(submitted);
    expect(prepared).toMatchObject({ status: "prepared", updatedAt: T3, intent: { createdAt: T3 } });
    expect(await service.prepare(submitted)).toEqual(prepared);
    await persistence.close();
  });

  it("reclaims an expired prepared lease only by clearing stale evidence and fencing a new attempt", async () => {
    const request = requestInput({ runId: "integration:prepared-reclaim", idempotencyKey: "request:prepared-reclaim" });
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const ports = fakePorts(request);
    const initial = createIntegrationServiceForTesting({ persistence, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(request) });
    await initial.accept(request);
    await initial.claim(command(request.runId, "claim:prepared-reclaim:1", 1, "claim", T1));
    await initial.prepare(command(request.runId, "prepare:prepared-reclaim:1", 2, "fenced", T2));
    const reclaimedAt = "2026-08-11T09:31:00.000Z";
    const restarted = createRawIntegrationServiceForTesting({ persistence, clock: { now: () => new Date(reclaimedAt) }, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(request) });
    const reclaimed = await restarted.claim({ ...command(request.runId, "claim:prepared-reclaim:2", 3, "claim", reclaimedAt), leaseId: "lease:2", leaseExpiresAt: "2026-08-11T09:45:00.000Z" });
    expect(reclaimed).toMatchObject({ status: "leased", attemptsUsed: 2, retriesScheduled: 1, preflight: null, preValidation: null, intent: null, lease: { fencingToken: 2 } });
    expect(await restarted.history(request.runId)).toHaveLength(4);
    await persistence.close();
  });

  it("refuses untrusted historical checkpoints during global idempotency and target scans", async () => {
    const first = requestInput({ runId: "integration:authority-old", idempotencyKey: "request:authority-old" });
    const second = requestInput({ runId: "integration:authority-new", idempotencyKey: "request:authority-new" });
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const ports = fakePorts(first);
    const oldService = createIntegrationServiceForTesting({ persistence, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(first) });
    await oldService.accept(first);
    const rotated = createIntegrationServiceForTesting({ persistence, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(second) });
    await expect(rotated.accept(second)).rejects.toMatchObject({ code: "PERSISTENCE_MISMATCH" });
    await expect(rotated.get(first.runId)).rejects.toMatchObject({ code: "PERSISTENCE_MISMATCH" });
    await persistence.close();
  });

  it("serializes one physical repository target across separately authorized route configurations", async () => {
    const first = requestInput({ runId: "integration:physical-route-a", idempotencyKey: "request:physical-route-a" });
    const second = requestInput({ runId: "integration:physical-route-b", idempotencyKey: "request:physical-route-b", gitRouteFingerprint: "f".repeat(64) });
    const authority = authorityFor(first, second);
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const firstPorts = fakePorts(first);
    const secondPorts = fakePorts(second);
    const firstService = createIntegrationServiceForTesting({ persistence, git: firstPorts.git, validation: firstPorts.validation, authorityConfiguration: authority });
    const secondService = createIntegrationServiceForTesting({ persistence, git: secondPorts.git, validation: secondPorts.validation, authorityConfiguration: authority });
    await firstService.accept(first);
    await secondService.accept(second);
    await firstService.claim(command(first.runId, "claim:physical-route-a", 1, "claim", T1));
    await expect(secondService.claim(command(second.runId, "claim:physical-route-b", 1, "claim", T1))).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    await persistence.close();
  });

  it("records an ambiguous effect marker and reconciles without automatic reinvocation", async () => {
    const request = requestInput();
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const basePorts = fakePorts(request);
    let attempts = 0;
    const git = Object.freeze({
      ...basePorts.git,
      async integrate(): Promise<never> {
        attempts += 1;
        throw new Error("opaque fixture failure");
      },
    });
    const service = createIntegrationServiceForTesting({ persistence, git, validation: basePorts.validation, authorityConfiguration: authorityFor(request) });
    await service.accept(request);
    await service.claim(command(request.runId, "claim:1", 1, "claim", T1));
    await service.prepare(command(request.runId, "prepare:1", 2, "fenced", T2));
    const executeCommand = command(request.runId, "execute:1", 3, "fenced", T3);
    await expect(service.execute(executeCommand)).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
    expect((await service.get(request.runId))?.status).toBe("effect-uncertain");
    expect(attempts).toBe(1);
    expect((await service.execute(executeCommand)).status).toBe("effect-uncertain");
    expect(attempts).toBe(1);
    const afterDeadline = "2026-08-11T11:00:00.000Z";
    const recoveryGit = Object.freeze({
      ...git,
      async reconcile(intent: Parameters<typeof git.reconcile>[0], candidate: Parameters<typeof git.reconcile>[1]) {
        const base = await git.reconcile(intent, candidate, null, new AbortController().signal);
        const projection = { ...base, observedAt: afterDeadline } as Record<string, unknown>;
        delete projection["recoveryDigest"];
        return Object.freeze({ ...projection, recoveryDigest: integrationDigest(projection) });
      },
      async cleanup(worktreeId: string) { return Object.freeze({ worktreeId, cleaned: true, preservedEvidence: false, failureCode: null, observedAt: afterDeadline }); },
    });
    const restarted = createRawIntegrationServiceForTesting({ persistence, clock: { now: () => new Date(afterDeadline) }, git: recoveryGit, validation: basePorts.validation, authorityConfiguration: authorityFor(request) });
    const reconciled = await restarted.reconcile({ ...command(request.runId, "reconcile:1", 4, "fenced", T4), occurredAt: afterDeadline });
    expect(reconciled).toMatchObject({ status: "failed", lastFailureCode: "recovery-no-effect" });
    expect(attempts).toBe(1);
    await persistence.close();
  });

  it("checkpoints exhausted recovery as manual reconciliation without fabricating terminal Git evidence", async () => {
    const initial = requestInput();
    const request = requestInput({
      runId: "integration:recovery-exhausted",
      idempotencyKey: "integration-request:recovery-exhausted",
      retryPolicy: Object.freeze({ ...initial.retryPolicy, maximumAttempts: 1 }),
    });
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const ports = fakePorts(request);
    let recoveryCalls = 0;
    const git = Object.freeze({
      ...ports.git,
      async integrate(): Promise<never> { throw new Error("ambiguous effect"); },
      async reconcile(): Promise<never> {
        recoveryCalls += 1;
        throw new Error("unavailable recovery boundary");
      },
    });
    const service = createIntegrationServiceForTesting({ persistence, git, validation: ports.validation, authorityConfiguration: authorityFor(request) });
    await service.accept(request);
    await service.claim(command(request.runId, "claim:recovery-exhausted", 1, "claim", T1));
    await service.prepare(command(request.runId, "prepare:recovery-exhausted", 2, "fenced", T2));
    await expect(service.execute(command(request.runId, "execute:recovery-exhausted", 3, "fenced", T3))).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });

    const recoveryAt = "2026-08-11T09:10:00.000Z";
    const restarted = createRawIntegrationServiceForTesting({ persistence, clock: { now: () => new Date(recoveryAt) }, git, validation: ports.validation, authorityConfiguration: authorityFor(request) });
    const recoveryCommand = command(request.runId, "reconcile:recovery-exhausted", 4, "fenced", recoveryAt);
    const exhausted = await restarted.reconcile(recoveryCommand);
    expect(exhausted).toMatchObject({
      status: "manual-reconciliation-required",
      recoveryAttempts: 1,
      lastFailureCode: "recovery-boundary-exhausted",
      terminal: null,
      recovery: null,
      lease: null,
    });
    expect(await restarted.get(request.runId)).toEqual(exhausted);
    expect(await restarted.reconcile(recoveryCommand)).toEqual(exhausted);
    expect(recoveryCalls).toBe(1);
    expect((await restarted.history(request.runId)).map((event) => event.type)).toEqual([
      "integration.accepted",
      "integration.leased",
      "integration.prepared",
      "integration.effect-started",
      "integration.recovery-started",
      "integration.recovery-exhausted",
    ]);
    await persistence.close();
  });

  it("physically reopens a crashed final recovery start and exhausts it without another boundary call", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-dev-os-integration-final-recovery-"));
    const file = join(root, "integration.sqlite");
    const initial = requestInput();
    const request = requestInput({
      runId: "integration:crashed-final-recovery",
      idempotencyKey: "request:crashed-final-recovery",
      retryPolicy: Object.freeze({ ...initial.retryPolicy, maximumAttempts: 1 }),
    });
    const ports = fakePorts(request);
    let recoveryCalls = 0;
    let announceRecovery!: () => void;
    let releaseRecovery!: () => void;
    const recoveryStarted = new Promise<void>((resolve) => { announceRecovery = resolve; });
    const recoveryReleased = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const git = Object.freeze({
      ...ports.git,
      async integrate(): Promise<never> { throw new Error("ambiguous effect"); },
      async reconcile(): Promise<never> {
        recoveryCalls += 1;
        announceRecovery();
        await recoveryReleased;
        throw new Error("process disappeared after durable recovery start");
      },
    });
    const authority = authorityFor(request);
    const first = createSqlitePersistenceAdapter({ file, clock: { now: () => new Date(T0) } });
    const firstAt = "2026-08-11T09:10:00.000Z";
    const secondAt = "2026-08-11T09:11:00.000Z";
    const initialService = createRawIntegrationServiceForTesting({ persistence: first, clock: TEST_CLOCK, git, validation: ports.validation, authorityConfiguration: authority });
    await initialService.accept(request);
    await initialService.claim(command(request.runId, "claim:crashed-final-recovery", 1, "claim", T1));
    await initialService.prepare(command(request.runId, "prepare:crashed-final-recovery", 2, "fenced", T2));
    await expect(initialService.execute(command(request.runId, "execute:crashed-final-recovery", 3, "fenced", T3))).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
    const firstRecovery = createRawIntegrationServiceForTesting({ persistence: first, clock: { now: () => new Date(firstAt) }, git, validation: ports.validation, authorityConfiguration: authority });
    const inFlight = firstRecovery.reconcile(command(request.runId, "reconcile:crashed-final-recovery:1", 4, "fenced", firstAt));
    void inFlight.catch(() => undefined);
    await recoveryStarted;
    await first.close();

    const second = createSqlitePersistenceAdapter({ file, clock: { now: () => new Date(T0) } });
    try {
      const reopened = createRawIntegrationServiceForTesting({ persistence: second, clock: { now: () => new Date(secondAt) }, git, validation: ports.validation, authorityConfiguration: authority });
      const exhaustionCommand = command(request.runId, "reconcile:crashed-final-recovery:2", 5, "fenced", secondAt);
      const exhausted = await reopened.reconcile(exhaustionCommand);
      expect(exhausted).toMatchObject({ status: "manual-reconciliation-required", recoveryAttempts: 1, lastFailureCode: "recovery-boundary-exhausted" });
      expect(recoveryCalls).toBe(1);
      expect((await reopened.history(request.runId)).map((event) => event.type).slice(-2)).toEqual(["integration.recovery-started", "integration.recovery-exhausted"]);
      expect(await reopened.reconcile(exhaustionCommand)).toEqual(exhausted);
      expect(recoveryCalls).toBe(1);
      releaseRecovery();
      await inFlight.catch(() => undefined);
      expect(await reopened.get(request.runId)).toEqual(exhausted);
    } finally {
      releaseRecovery();
      await second.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed on unauthorized admission and command identity reuse", async () => {
    const { persistence, service, request } = serviceFixture();
    const unauthorized = requestInput({ authorityDigest: "f".repeat(64) });
    await expect(service.accept(unauthorized)).rejects.toBeInstanceOf(IntegrationError);
    await service.accept(request);
    const claim = command(request.runId, "same-command", 1, "claim", T1);
    await service.claim(claim);
    await expect(service.claim({ ...claim, owner: "worker:2" })).rejects.toMatchObject({ code: "CONFLICT" });
    await persistence.close();
  });

  it("binds the exact Git and validator routes before persistence or callbacks", async () => {
    const base = requestInput();
    for (const request of [
      requestInput({ runId: "integration:wrong-git", idempotencyKey: "request:wrong-git", gitPortId: "git:substituted" }),
      requestInput({ runId: "integration:wrong-git-route", idempotencyKey: "request:wrong-git-route", gitRouteFingerprint: "f".repeat(64) }),
      (() => {
        const planProjection = { ...base.validationPlan, validatorId: "validation:substituted" } as Record<string, unknown>;
        delete planProjection["planDigest"];
        const validationPlan = { ...planProjection, planDigest: integrationDigest(planProjection) };
        return requestInput({ runId: "integration:wrong-validation", idempotencyKey: "request:wrong-validation", validationPlan });
      })(),
      (() => {
        const planProjection = { ...base.validationPlan, routeFingerprint: "f".repeat(64) } as Record<string, unknown>;
        delete planProjection["planDigest"];
        const validationPlan = { ...planProjection, planDigest: integrationDigest(planProjection) };
        return requestInput({ runId: "integration:wrong-validation-route", idempotencyKey: "request:wrong-validation-route", validationPlan });
      })(),
    ]) {
      const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
      const ports = fakePorts(base);
      const service = createIntegrationServiceForTesting({ persistence, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(request) });
      await expect(service.accept(request)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(ports.counts).toEqual({ preflight: 0, integrate: 0, reconcile: 0, cleanup: 0, validate: 0 });
      expect(await service.get(request.runId)).toBeNull();
      await persistence.close();
    }
  });

  it("durably schedules only reviewed pre-effect retries and fences the next attempt", async () => {
    const request = requestInput({ runId: "integration:retry", idempotencyKey: "request:retry" });
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const ports = fakePorts(request);
    let preflightAttempts = 0;
    let now = T2;
    const git = Object.freeze({
      ...ports.git,
      async preflight(candidate: typeof request) {
        preflightAttempts += 1;
        if (preflightAttempts === 1) throw new Error("transient fixture boundary");
        return preflightResult(candidate, now);
      },
    });
    const validation = Object.freeze({ ...ports.validation, async validate(input: Parameters<typeof ports.validation.validate>[0]) { return validationResult(input, now); } });
    const service = createRawIntegrationServiceForTesting({ persistence, clock: { now: () => new Date(now) }, git, validation, authorityConfiguration: authorityFor(request) });
    await service.accept(request);
    await service.claim(command(request.runId, "claim:retry:1", 1, "claim", T1));
    const firstPrepare = command(request.runId, "prepare:retry:1", 2, "fenced", T2);
    const pending = await service.prepare(firstPrepare);
    expect(pending).toMatchObject({ status: "pending", attemptsUsed: 1, retriesScheduled: 1, lastFailureCode: "preflight-boundary-failed" });
    expect(await service.prepare(firstPrepare)).toEqual(pending);
    expect(preflightAttempts).toBe(1);
    now = T3;
    const claimed = await service.claim({ ...command(request.runId, "claim:retry:2", 3, "claim", T3), leaseId: "lease:2" });
    expect(claimed).toMatchObject({ status: "leased", attemptsUsed: 2, retriesScheduled: 1, lease: { fencingToken: 2 } });
    const prepared = await service.prepare({ ...command(request.runId, "prepare:retry:2", 4, "fenced", T3, 2), leaseId: "lease:2" });
    expect(prepared.status).toBe("prepared");
    expect(preflightAttempts).toBe(2);
    expect(await service.history(request.runId)).toHaveLength(5);
    await persistence.close();
  });

  it("preserves semantic validation conflicts and rejects missing criteria or changed thresholds", async () => {
    for (const mode of ["semantic", "criteria", "threshold", "coverage"] as const) {
      const request = requestInput({ runId: `integration:exact-${mode}`, idempotencyKey: `request:exact-${mode}` });
      const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
      const ports = fakePorts(request);
      const validation = Object.freeze({
        ...ports.validation,
        async validate(input: Parameters<typeof ports.validation.validate>[0]) {
          const valid = validationResult(input);
          const projection = {
            ...valid,
            ...(mode === "semantic" ? {
              passed: false,
              failedRuleCodes: ["semantic-break"],
              conflicts: [{ conflictId: "conflict:semantic", kind: "semantic", path: "packages/example/src/index.ts", ruleCode: "semantic-break", blocking: true }],
            } : {}),
            ...(mode === "criteria" ? { evaluatedCriterionIds: [], criterionResultDigests: [] } : {}),
            ...(mode === "threshold" ? { thresholdDigest: "f".repeat(64) } : {}),
            ...(mode === "coverage" ? { coverageDigest: "f".repeat(64) } : {}),
          } as Record<string, unknown>;
          delete projection["resultDigest"];
          return Object.freeze({ ...projection, resultDigest: integrationDigest(projection) });
        },
      });
      const service = createIntegrationServiceForTesting({ persistence, git: ports.git, validation, authorityConfiguration: authorityFor(request) });
      await service.accept(request);
      await service.claim(command(request.runId, `claim:${mode}`, 1, "claim", T1));
      const failed = await service.prepare(command(request.runId, `prepare:${mode}`, 2, "fenced", T2));
      expect(failed.status).toBe("failed");
      if (mode === "semantic") {
        expect(failed).toMatchObject({ lastFailureCode: "pre-validation-failed", preValidation: { conflicts: [{ kind: "semantic", ruleCode: "semantic-break" }] } });
      } else {
        expect(failed.preValidation).toBeNull();
      }
      await persistence.close();
    }
  });

  it("rejects changed validation configuration, fabricated success, skips, and post-integration regression", async () => {
    for (const mode of ["configuration", "fabricated", "skips"] as const) {
      const request = requestInput({ runId: `integration:${mode}`, idempotencyKey: `request:${mode}` });
      const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
      const ports = fakePorts(request);
      const validation = Object.freeze({
        ...ports.validation,
        async validate(input: Parameters<typeof ports.validation.validate>[0]) {
          const valid = validationResult(input);
          const projection = {
            ...valid,
            ...(mode === "configuration" ? { configurationDigest: "f".repeat(64) } : {}),
            ...(mode === "fabricated" ? { passed: true, failedRuleCodes: ["deterministic-failure"] } : {}),
            ...(mode === "skips" ? { passed: false, failedRuleCodes: ["unexpected-skip"], skippedCount: 1 } : {}),
          } as Record<string, unknown>;
          delete projection["resultDigest"];
          return Object.freeze({ ...projection, resultDigest: integrationDigest(projection) });
        },
      });
      const service = createIntegrationServiceForTesting({ persistence, git: ports.git, validation, authorityConfiguration: authorityFor(request) });
      await service.accept(request);
      await service.claim(command(request.runId, `claim:${mode}`, 1, "claim", T1));
      const failed = await service.prepare(command(request.runId, `prepare:${mode}`, 2, "fenced", T2));
      expect(failed.status).toBe("failed");
      await persistence.close();
    }

    const request = requestInput({ runId: "integration:regression", idempotencyKey: "request:regression" });
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const ports = fakePorts(request);
    const validation = Object.freeze({
      ...ports.validation,
      async validate(input: Parameters<typeof ports.validation.validate>[0]) {
        const valid = validationResult(input, input.phase === "pre-integration" ? T2 : T4);
        if (input.phase === "pre-integration") return valid;
        const projection = { ...valid, coverageDigest: "f".repeat(64) } as Record<string, unknown>;
        delete projection["resultDigest"];
        return Object.freeze({ ...projection, resultDigest: integrationDigest(projection) });
      },
    });
    const service = createIntegrationServiceForTesting({ persistence, git: ports.git, validation, authorityConfiguration: authorityFor(request) });
    await service.accept(request);
    await service.claim(command(request.runId, "claim:regression", 1, "claim", T1));
    await service.prepare(command(request.runId, "prepare:regression", 2, "fenced", T2));
    const failed = await service.execute(command(request.runId, "execute:regression", 3, "fenced", T3));
    expect(failed).toMatchObject({ status: "failed", lastFailureCode: "post-validation-invalid", postValidation: null });
    expect((await service.get(request.runId))?.status).toBe("failed");
    expect(await service.history(request.runId)).toHaveLength(6);
    await persistence.close();
  });

  it("physically closes and reopens the exact prepared and completed SQLite journal without redispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-dev-os-integrator-sqlite-"));
    const databasePath = join(root, "integrator.sqlite");
    const request = requestInput();
    const ports = fakePorts(request);
    let first = createSqlitePersistenceAdapter({ file: databasePath, clock: { now: () => new Date(T0) } });
    let service = createIntegrationServiceForTesting({ persistence: first, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(request) });
    try {
      await service.accept(request);
      await service.claim(command(request.runId, "claim:sqlite", 1, "claim", T1));
      const prepared = await service.prepare(command(request.runId, "prepare:sqlite", 2, "fenced", T2));
      expect(prepared.status).toBe("prepared");
      await first.close();

      const second = createSqlitePersistenceAdapter({ file: databasePath, clock: { now: () => new Date(T0) } });
      service = createIntegrationServiceForTesting({ persistence: second, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(request) });
      expect(await service.get(request.runId)).toEqual(prepared);
      const executeCommand = command(request.runId, "execute:sqlite", 3, "fenced", T3);
      const completed = await service.execute(executeCommand);
      expect(completed.status).toBe("completed");
      const effectReads = ports.counts.integrate;
      await second.close();

      const third = createSqlitePersistenceAdapter({ file: databasePath, clock: { now: () => new Date(T0) } });
      service = createIntegrationServiceForTesting({ persistence: third, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(request) });
      expect(await service.get(request.runId)).toEqual(completed);
      expect(await service.history(request.runId)).toHaveLength(6);
      expect(await service.execute(executeCommand)).toEqual(completed);
      expect(ports.counts.integrate).toBe(effectReads);
      await third.close();
    } finally {
      await first.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
