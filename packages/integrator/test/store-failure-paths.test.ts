import { describe, expect, it } from "vitest";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import type { EventRecord, PersistenceAdapter, TransactionContext } from "@ai-dev-os/persistence";
import {
  IntegrationError,
  createIntegrationRun,
  integrationDigest,
  type IntegrationGitPort,
  type IntegrationValidationPort,
} from "../src/index.js";
import { integrationStoreTesting } from "../src/store.js";
import { createIntegrationServiceForTesting as createRawIntegrationServiceForTesting } from "../src/testing/index.js";
import { T0, T1, T2, T3, T4, TEST_CLOCK, authorityFor, command, fakePorts, requestInput, validationResult } from "./fixtures.js";

function createIntegrationServiceForTesting(options: Omit<Parameters<typeof createRawIntegrationServiceForTesting>[0], "clock">) {
  return createRawIntegrationServiceForTesting({ ...options, clock: TEST_CLOCK });
}

function requestWith(overrides: Readonly<Record<string, unknown>>) {
  return requestInput(overrides);
}

function recordFor(event: ReturnType<typeof createIntegrationRun>["event"]): EventRecord {
  return {
    eventId: event.eventId,
    aggregateType: "integration-run",
    aggregateId: event.runId,
    aggregateVersion: event.aggregateVersion,
    eventType: "integration.event",
    eventSchemaVersion: 1,
    payload: event,
    checksum: "0".repeat(64),
    occurredAt: event.occurredAt,
    recordedAt: event.occurredAt,
    globalSequence: event.sequence,
    traceId: null,
    causationId: null,
  };
}

function fakeEventTransaction(pages: readonly { readonly items: readonly EventRecord[]; readonly nextCursor: string | null }[]): TransactionContext {
  let index = 0;
  return {
    events: {
      async list() {
        return pages[Math.min(index++, pages.length - 1)]!;
      },
    },
  } as unknown as TransactionContext;
}

describe("integration store fail-closed paths", () => {
  it("rejects malformed event envelopes and non-progressing or oversized journals", async () => {
    const request = requestInput();
    const accepted = createIntegrationRun(request, authorityFor(request));
    const record = recordFor(accepted.event);
    expect(() => integrationStoreTesting.eventFromRecord({ ...record, aggregateId: "integration:wrong" }))
      .toThrowError(expect.objectContaining({ code: "PERSISTENCE_MISMATCH" }));
    const malformed = { ...record, payload: null } as unknown as EventRecord;
    const malformedError = (() => {
      try {
        integrationStoreTesting.eventFromRecord(malformed);
        throw new Error("expected malformed event rejection");
      } catch (error) {
        return error;
      }
    })();
    expect(malformedError).toBeInstanceOf(IntegrationError);
    expect(JSON.stringify((malformedError as IntegrationError).toJSON())).not.toContain("payload");

    await expect(integrationStoreTesting.listEvents(fakeEventTransaction([
      { items: [], nextCursor: "cursor:stalled" },
    ]), request.runId)).rejects.toMatchObject({ code: "PERSISTENCE_MISMATCH" });

    await expect(integrationStoreTesting.listEvents(fakeEventTransaction([
      { items: [record], nextCursor: "cursor:repeat" },
      { items: [record], nextCursor: "cursor:repeat" },
    ]), request.runId)).rejects.toMatchObject({ code: "PERSISTENCE_MISMATCH" });

    await expect(integrationStoreTesting.listEvents(fakeEventTransaction([
      { items: new Array(31).fill(record), nextCursor: null },
    ]), request.runId)).rejects.toMatchObject({ code: "PERSISTENCE_MISMATCH" });
  });

  it("rejects a repeated aggregate-list cursor before creating a run", async () => {
    const request = requestInput();
    const candidate = createIntegrationRun(request, authorityFor(request));
    const envelope = {
      aggregateType: "integration-run",
      aggregateId: candidate.snapshot.runId,
      schemaVersion: 1,
      aggregateVersion: 1,
      payload: candidate.snapshot,
      checksum: "0".repeat(64),
      createdAt: T0,
      updatedAt: T0,
      traceId: null,
    };
    const tx = {
      aggregates: {
        async get() { return null; },
        async list() { return { items: [envelope], nextCursor: "cursor:repeat" }; },
      },
    } as unknown as TransactionContext;
    const persistence = {
      async transact<T>(work: (context: TransactionContext) => Promise<T> | T): Promise<T> { return await work(tx); },
    } as unknown as PersistenceAdapter;
    const ports = fakePorts(request);
    const service = createIntegrationServiceForTesting({ persistence, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(request) });
    await expect(service.accept(request)).rejects.toMatchObject({ code: "PERSISTENCE_MISMATCH" });
  });

  it("detects checkpoint and listing envelope corruption before returning state", async () => {
    const request = requestInput();
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const ports = fakePorts(request);
    const service = createIntegrationServiceForTesting({
      persistence,
      git: ports.git,
      validation: ports.validation,
      authorityConfiguration: authorityFor(request),
      trustedAuthorityConfigurationFingerprints: [authorityFor(request).configurationFingerprint],
    });
    const accepted = await service.accept(request);
    await persistence.transact((tx) => tx.aggregates.update({
      aggregateType: "integration-run",
      aggregateId: request.runId,
      schemaVersion: 1,
      expectedVersion: accepted.aggregateVersion,
      payload: accepted,
      traceId: null,
    }));
    await expect(service.get(request.runId)).rejects.toMatchObject({ code: "PERSISTENCE_MISMATCH" });
    await persistence.close();

    const listingPersistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const candidate = createIntegrationRun(request, authorityFor(request));
    await listingPersistence.transact((tx) => tx.aggregates.create({
      aggregateType: "integration-run",
      aggregateId: "integration:wrong-envelope",
      schemaVersion: 1,
      payload: candidate.snapshot,
      traceId: null,
    }));
    const listingService = createIntegrationServiceForTesting({ persistence: listingPersistence, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(request) });
    await expect(listingService.accept(request)).rejects.toMatchObject({ code: "PERSISTENCE_MISMATCH" });
    await listingPersistence.close();
  });

  it("times out an external preflight, records the finite failure, and never waits indefinitely", async () => {
    const initial = requestInput();
    const request = requestWith({
      runId: "integration:timeout",
      idempotencyKey: "integration-request:timeout",
      bounds: { ...initial.bounds, maximumWallTimeMs: 40 },
    });
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const ports = fakePorts(request);
    let calls = 0;
    let observedAbort = false;
    let drained = false;
    const git: IntegrationGitPort = Object.freeze({
      ...ports.git,
      async preflight(_request, signal): Promise<never> {
        calls += 1;
        return await new Promise<never>((_resolve, reject) => {
          const abort = (): void => {
            observedAbort = true;
            queueMicrotask(() => {
              drained = true;
              reject(new IntegrationError("TIMEOUT", "controlled preflight abort"));
            });
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      },
    });
    const service = createIntegrationServiceForTesting({ persistence, git, validation: ports.validation, authorityConfiguration: authorityFor(request) });
    await service.accept(request);
    await service.claim(command(request.runId, "claim:timeout", 1, "claim", T1));
    const failed = await service.prepare(command(request.runId, "prepare:timeout", 2, "fenced", T2));
    expect(failed).toMatchObject({ status: "failed", lastFailureCode: "timeout" });
    expect({ calls, observedAbort, drained }).toEqual({ calls: 1, observedAbort: true, drained: true });
    await persistence.close();
  });

  it("refuses exact lease-expiry preparation and effect commands before any external callback", async () => {
    const leaseExpiry = "2026-08-11T09:30:00.000Z";
    const prepareRequest = requestWith({ runId: "integration:exact-expiry-prepare", idempotencyKey: "integration-request:exact-expiry-prepare" });
    const preparePersistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const preparePorts = fakePorts(prepareRequest);
    let preflightCalls = 0;
    const countedPreflight: IntegrationGitPort = Object.freeze({
      ...preparePorts.git,
      async preflight(...args) { preflightCalls += 1; return await preparePorts.git.preflight(...args); },
    });
    const prepareService = createIntegrationServiceForTesting({ persistence: preparePersistence, git: countedPreflight, validation: preparePorts.validation, authorityConfiguration: authorityFor(prepareRequest) });
    await prepareService.accept(prepareRequest);
    await prepareService.claim(command(prepareRequest.runId, "claim:exact-expiry-prepare", 1, "claim", T1));
    const expiredPrepareService = createRawIntegrationServiceForTesting({ persistence: preparePersistence, clock: { now: () => new Date(leaseExpiry) }, git: countedPreflight, validation: preparePorts.validation, authorityConfiguration: authorityFor(prepareRequest) });
    await expect(expiredPrepareService.prepare(command(prepareRequest.runId, "prepare:exact-expiry", 2, "fenced", leaseExpiry)))
      .rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    expect(preflightCalls).toBe(0);
    await preparePersistence.close();

    const executeRequest = requestWith({ runId: "integration:exact-expiry-execute", idempotencyKey: "integration-request:exact-expiry-execute" });
    const executePersistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const executePorts = fakePorts(executeRequest);
    const executeService = createIntegrationServiceForTesting({ persistence: executePersistence, git: executePorts.git, validation: executePorts.validation, authorityConfiguration: authorityFor(executeRequest) });
    await executeService.accept(executeRequest);
    await executeService.claim(command(executeRequest.runId, "claim:exact-expiry-execute", 1, "claim", T1));
    await executeService.prepare(command(executeRequest.runId, "prepare:exact-expiry-execute", 2, "fenced", T2));
    let integrateCalls = 0;
    const countedIntegrate: IntegrationGitPort = Object.freeze({
      ...executePorts.git,
      async integrate(...args) { integrateCalls += 1; return await executePorts.git.integrate(...args); },
    });
    const expiredExecuteService = createRawIntegrationServiceForTesting({ persistence: executePersistence, clock: { now: () => new Date(leaseExpiry) }, git: countedIntegrate, validation: executePorts.validation, authorityConfiguration: authorityFor(executeRequest) });
    await expect(expiredExecuteService.execute(command(executeRequest.runId, "execute:exact-expiry", 3, "fenced", leaseExpiry)))
      .rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    expect(integrateCalls).toBe(0);
    await executePersistence.close();
  });

  it("terminalizes post-validation exceptions and redacts arbitrary boundary error names", async () => {
    const request = requestWith({ runId: "integration:post-throw", idempotencyKey: "integration-request:post-throw" });
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const ports = fakePorts(request);
    const validation: IntegrationValidationPort = Object.freeze({
      ...ports.validation,
      async validate(input) {
        if (input.phase === "post-integration") throw new Error("provider-body-canary");
        return validationResult(input);
      },
    });
    const service = createIntegrationServiceForTesting({ persistence, git: ports.git, validation, authorityConfiguration: authorityFor(request) });
    await service.accept(request);
    await service.claim(command(request.runId, "claim:post", 1, "claim", T1));
    await service.prepare(command(request.runId, "prepare:post", 2, "fenced", T2));
    expect(await service.execute(command(request.runId, "execute:post", 3, "fenced", T3)))
      .toMatchObject({ status: "failed", lastFailureCode: "post-validation-boundary-failed", terminal: { cleanup: { cleaned: true, preservedEvidence: true } } });
    expect(ports.counts.cleanup).toBe(1);
    await persistence.close();

    const uncertainRequest = requestWith({ runId: "integration:redaction", idempotencyKey: "integration-request:redaction" });
    const uncertainPersistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const uncertainPorts = fakePorts(uncertainRequest);
    const canary = "SECRET_ERROR_NAME_CANARY";
    const git: IntegrationGitPort = Object.freeze({
      ...uncertainPorts.git,
      async integrate(): Promise<never> {
        throw new IntegrationError("GIT_BOUNDARY_FAILURE", "fixed boundary failure", { operation: canary });
      },
      async reconcile(): Promise<never> {
        throw new Error(canary);
      },
    });
    const uncertainService = createIntegrationServiceForTesting({ persistence: uncertainPersistence, git, validation: uncertainPorts.validation, authorityConfiguration: authorityFor(uncertainRequest) });
    await uncertainService.accept(uncertainRequest);
    await uncertainService.claim(command(uncertainRequest.runId, "claim:redact", 1, "claim", T1));
    await uncertainService.prepare(command(uncertainRequest.runId, "prepare:redact", 2, "fenced", T2));
    const error = await uncertainService.execute(command(uncertainRequest.runId, "execute:redact", 3, "fenced", T3)).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(IntegrationError);
    expect(JSON.stringify((error as IntegrationError).toJSON())).not.toContain(canary);
    const recoveryAt = "2026-08-11T09:10:00.000Z";
    const recoveryService = createRawIntegrationServiceForTesting({ persistence: uncertainPersistence, clock: { now: () => new Date(recoveryAt) }, git, validation: uncertainPorts.validation, authorityConfiguration: authorityFor(uncertainRequest) });
    const recoveryError = await recoveryService.reconcile(command(uncertainRequest.runId, "reconcile:redact", 4, "fenced", recoveryAt)).catch((reason: unknown) => reason);
    expect(recoveryError).toMatchObject({ code: "GIT_BOUNDARY_FAILURE" });
    expect(JSON.stringify((recoveryError as IntegrationError).toJSON())).not.toContain(canary);
    await uncertainPersistence.close();
  });

  it("redacts hostile schema keys at the public service boundary", async () => {
    const request = requestInput({ runId: "integration:redacted-key", idempotencyKey: "request:redacted-key" });
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const ports = fakePorts(request);
    const service = createIntegrationServiceForTesting({ persistence, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(request) });
    const canary = "SECRET_OPTION_KEY_CANARY";
    const error = await service.accept({ ...request, [canary]: true }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(JSON.stringify((error as IntegrationError).toJSON())).not.toContain(canary);
    const proxyError = await service.accept(new Proxy(request, {
      ownKeys() { throw new Error(canary); },
    })).catch((reason: unknown) => reason);
    expect(proxyError).toMatchObject({ code: "INVALID_INPUT" });
    expect(JSON.stringify((proxyError as IntegrationError).toJSON())).not.toContain(canary);
    await persistence.close();
  });

  it("rejects idempotency conflicts, audits persistence failure, and cancels idempotently", async () => {
    const request = requestInput();
    const conflicting = requestWith({ runId: "integration:idempotency-conflict" });
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const ports = fakePorts(request);
    const service = createIntegrationServiceForTesting({ persistence, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(request, conflicting) });
    await service.accept(request);
    await expect(service.accept(conflicting)).rejects.toMatchObject({ code: "CONFLICT" });
    const cancelled = await service.cancel(command(request.runId, "cancel:service", 1, "cancel", T1));
    expect(cancelled.status).toBe("cancelled");
    expect(await service.cancel(command(request.runId, "cancel:service", 1, "cancel", T1))).toEqual(cancelled);
    await persistence.close();

    const closed = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    await closed.close();
    const audit: unknown[] = [];
    const failedService = createIntegrationServiceForTesting({ persistence: closed, git: ports.git, validation: ports.validation, authorityConfiguration: authorityFor(request), audit: (record) => { audit.push(record); } });
    await expect(failedService.accept(request)).rejects.toBeDefined();
    expect(audit).toContainEqual(expect.objectContaining({ operation: "accept", outcome: "failed", code: "persistence-error" }));
  });
});
