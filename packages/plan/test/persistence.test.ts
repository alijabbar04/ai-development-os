import { describe, expect, it } from "vitest";
import { serializeCanonicalProjectJson } from "@ai-dev-os/project";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { PersistenceError, type PersistenceAdapter, type TransactionContext } from "@ai-dev-os/persistence";
import {
  PLAN_LIMITS,
  PlanContractError,
  assertCompleteMutationShape,
  canonicalRequestBytes,
  computeCoverageDigest,
  computePlanCommitContentDigest,
  computeProposalDigest,
  computeSpecificationDigest,
  parsePlanAssemblyRequest,
  parsePlanCommitRequest,
  parsePlanJournalEvent,
  planCommitDigestMaterial,
  planLineageId,
} from "../src/index.js";
import {
  c8AcceptedBriefAggregateId,
  createC8C7PlanStore,
  issueSyntheticPlanCommitAuthorization,
  planSha256,
} from "../src/testing/index.js";
import {
  T0,
  acceptNextBrief,
  acceptedBinding,
  acceptedHead,
  assemblyRequestForBrief,
  assembled,
  draftRequest,
  mutationControls,
  project,
  rawAssemblyRequest,
  seedFoundations,
} from "./fixtures.js";

function clone<T>(value: T): T { return structuredClone(value); }

function ruleOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof PlanContractError) return error.ruleId;
    throw error;
  }
  return "none";
}

const EXACT_REQUEST_KEYS = ["acceptedBrief", "binding", "expectedControls", "projectId", "schemaVersion", "steps"] as const;
const EXACT_STEP_KEYS = ["envelope", "event", "eventId", "expectedState", "plan"] as const;
const EXACT_ENVELOPE_KEYS = ["causationId", "occurredAt", "traceId"] as const;
const EXACT_EVENT_KEYS = [
  "binding", "budgetExtension", "controls", "decisions", "kind", "operation", "plan",
  "predecessor", "rebase", "review", "schemaVersion", "seal",
] as const;
const EXACT_REVIEW_KEYS = [
  "assemblyRequest", "authenticatedOperatorEvidence", "constraintDispositions", "coverageDigest",
  "proposalDigest", "provenance", "specification", "specificationDigest",
] as const;
const EXACT_EVENT_BINDING_KEYS = [
  "acceptanceEventId", "acceptedCandidateDigest", "briefAggregateVersion", "briefBlockingQuestionIds",
  "briefContentDigest", "briefId", "contentDigest", "expectedAggregateVersion", "expectedHeadPlanId",
  "headAdvanced", "planDigest", "planId", "planRevision", "projectId", "proposalDigest",
  "resultAggregateVersion", "resultState", "stepCount", "stepIndex",
] as const;
const EXACT_ASSEMBLY_REQUEST_KEYS = [
  "expectedCoverageDigest", "expectedProposalDigest", "expectedSpecificationDigest", "newPlanId",
  "proposal", "schemaVersion", "specificationInput", "taskBudgetAllocations",
] as const;

async function preparedDraft(adapter: PersistenceAdapter) {
  const seed = await seedFoundations(adapter);
  const assembly = assembled(assemblyRequestForBrief(seed.accepted.brief), seed.project, seed.accepted);
  return {
    seed,
    request: draftRequest(assembly.plan, assembly.review, acceptedBinding(seed.accepted), seed.controls),
  };
}

function rebindDigest(raw: Record<string, unknown>) {
  const request = raw as unknown as Parameters<typeof computePlanCommitContentDigest>[0];
  const digest = computePlanCommitContentDigest(request, planSha256);
  (raw["binding"] as Record<string, unknown>)["contentDigest"] = digest;
  for (const step of raw["steps"] as Record<string, unknown>[]) {
    const event = step["event"] as Record<string, unknown>;
    (event["binding"] as Record<string, unknown>)["contentDigest"] = digest;
  }
  return raw;
}

describe("P-1..P-35 canonical persistence and proof parsing", () => {
  it("P-20 finitely refuses a valid journal event whose canonical payload exceeds the event bound", () => {
    const raw = clone(rawAssemblyRequest()) as unknown as Record<string, unknown>;
    const proposal = raw["proposal"] as Record<string, unknown>;
    const task = (proposal["tasks"] as Record<string, unknown>[])[0]!;
    const longCriterion = "x".repeat(16_384);
    task["acceptance"] = Array.from({ length: 350 }, () => ({
      criterion: longCriterion,
      validationCommand: null,
    }));
    const provenance = task["provenance"] as Record<string, unknown>;
    for (let index = 0; index < 350; index += 1) {
      provenance[`acceptance[${index}].criterion`] = { origin: "model", derivedFrom: null, verbatim: false };
    }
    raw["expectedSpecificationDigest"] = computeSpecificationDigest(raw, planSha256);
    raw["expectedCoverageDigest"] = computeCoverageDigest(raw, planSha256);
    raw["expectedProposalDigest"] = computeProposalDigest(raw, planSha256);
    const request = parsePlanAssemblyRequest(raw);
    const accepted = acceptedHead();
    const result = assembled(request, project(), accepted);
    expect(serializeCanonicalProjectJson({ plan: result.plan, review: result.review }).length)
      .toBeGreaterThan(PLAN_LIMITS.maxEventBytes);
    expect(ruleOf(() => draftRequest(
      result.plan,
      result.review,
      acceptedBinding(accepted),
      mutationControls(),
    ))).toBe("plan.event.too-large");
  });

  it("round-trips canonical request material with a shared non-recursive digest", async () => {
    const { request } = await preparedDraft(createMemoryPersistenceAdapter());
    expect(parsePlanCommitRequest(clone(request), planSha256)).toEqual(request);
    expect(computePlanCommitContentDigest(request, planSha256)).toBe(request.binding.contentDigest);
    expect(JSON.stringify(planCommitDigestMaterial(request))).not.toContain(`\"contentDigest\":\"${request.binding.contentDigest}\"`);
    expect(canonicalRequestBytes(request)).toBe(canonicalRequestBytes(parsePlanCommitRequest(clone(request), planSha256)));
    expect(planLineageId(request.projectId)).toBe(request.projectId);

    const step = request.steps[0]!;
    expect(Object.keys(request).sort()).toEqual(EXACT_REQUEST_KEYS);
    expect(Object.keys(step).sort()).toEqual(EXACT_STEP_KEYS);
    expect(Object.keys(step.envelope).sort()).toEqual(EXACT_ENVELOPE_KEYS);
    expect(Object.keys(step.event).sort()).toEqual(EXACT_EVENT_KEYS);
    expect(Object.keys(step.event.review).sort()).toEqual(EXACT_REVIEW_KEYS);
    expect(Object.keys(step.event.binding).sort()).toEqual(EXACT_EVENT_BINDING_KEYS);
    expect(Object.keys(step.event.review.assemblyRequest).sort()).toEqual(EXACT_ASSEMBLY_REQUEST_KEYS);
    expect(step.event.binding.contentDigest).toBe(request.binding.contentDigest);
    expect(step.event.binding.planId).toBe(step.plan?.planId);
    expect(step.event.binding.planDigest).toBe(step.plan?.planDigest);
    expect(step.event.review.assemblyRequest).toEqual(request.steps[0]?.event.review.assemblyRequest);
  });

  it("rejects unknown fields, authentication lookalikes, cross-kind operations, and retained-digest mutations", async () => {
    const { request } = await preparedDraft(createMemoryPersistenceAdapter());
    for (const key of ["authorization", "operatorEvidence", "authenticatedOperatorEvidence", "transport", "approval", "scopeApproval"]) {
      const hostile = clone(request) as unknown as Record<string, unknown>;
      hostile[key] = {};
      expect(() => parsePlanCommitRequest(hostile, planSha256)).toThrow();
    }
    const mutation = clone(request) as unknown as Record<string, unknown>;
    const first = (mutation["steps"] as Record<string, unknown>[])[0]!;
    ((first["event"] as Record<string, unknown>)["plan"] as Record<string, unknown>)["updatedAt"] = "2026-09-04T11:00:00.000Z";
    expect(() => parsePlanCommitRequest(mutation, planSha256)).toThrow();

    const crossKind = clone(request) as unknown as Record<string, unknown>;
    const event = (((crossKind["steps"] as Record<string, unknown>[])[0]!)["event"] as Record<string, unknown>);
    event["kind"] = "plan.sealed";
    expect(() => parsePlanCommitRequest(rebindDigest(crossKind), planSha256)).toThrow();

    const nonPromotePair = clone(request) as unknown as Record<string, unknown>;
    const pair = nonPromotePair["steps"] as Record<string, unknown>[];
    const second = clone(pair[0]!);
    second["eventId"] = "plan-event:forged-second-draft";
    (second["event"] as Record<string, unknown>)["binding"] = {
      ...((second["event"] as Record<string, unknown>)["binding"] as Record<string, unknown>),
      resultAggregateVersion: 2,
      stepIndex: 2,
      stepCount: 2,
    };
    ((pair[0]!["event"] as Record<string, unknown>)["binding"] as Record<string, unknown>)["stepCount"] = 2;
    pair.push(second);
    const parsedPair = parsePlanCommitRequest(rebindDigest(nonPromotePair), planSha256);
    expect(() => assertCompleteMutationShape(parsedPair)).toThrow();
  });

  it("never invokes accessors and rejects exotic prototypes, symbols, holes, and sparse arrays", async () => {
    const { request } = await preparedDraft(createMemoryPersistenceAdapter());
    let invoked = 0;
    const accessor = clone(request) as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "projectId", { enumerable: true, get: () => { invoked += 1; return request.projectId; } });
    expect(() => parsePlanCommitRequest(accessor, planSha256)).toThrow();
    expect(invoked).toBe(0);

    const prototype = clone(request) as unknown as Record<string, unknown>;
    Object.setPrototypeOf(prototype, { polluted: true });
    expect(() => parsePlanCommitRequest(prototype, planSha256)).toThrow();

    const symbol = clone(request) as unknown as Record<PropertyKey, unknown>;
    symbol[Symbol("hidden")] = true;
    expect(() => parsePlanCommitRequest(symbol, planSha256)).toThrow();

    const sparse = clone(request) as unknown as Record<string, unknown>;
    (sparse["steps"] as unknown[]).length = 2;
    expect(() => parsePlanCommitRequest(sparse, planSha256)).toThrow();
  });

  it("fuzz-refuses arbitrary JSON shapes without accepting an accidental event", () => {
    let accepted = 0;
    let seed = 0x9e3779b9;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
    const atoms: unknown[] = [null, true, false, 0, -1, 1.5, "", "plan.drafted", [], {}, { schemaVersion: 1 }];
    for (let index = 0; index < 500; index += 1) {
      const value = clone(atoms[next() % atoms.length]);
      try { parsePlanJournalEvent(value, planSha256); accepted += 1; } catch { /* expected closed refusal */ }
    }
    expect(accepted).toBe(0);
  });

  it("distinguishes accepted, invalid-proof, absent, and unresolved accepted-head reads", async () => {
    const valid = createMemoryPersistenceAdapter();
    const seed = await seedFoundations(valid);
    const store = createC8C7PlanStore(valid);
    const accepted = await store.readAcceptedBriefHead(seed.project.projectId);
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind === "accepted") expect(accepted.head.briefContentDigest).not.toBe(accepted.head.acceptedCandidateDigest);

    const forgedIdBase = createMemoryPersistenceAdapter();
    const forgedSeed = await seedFoundations(forgedIdBase);
    const forgedIdAdapter = {
      ...forgedIdBase,
      transact: <T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> => forgedIdBase.transact((tx) => work({
        ...tx,
        events: {
          ...tx.events,
          list: async (query) => {
            const page = await tx.events.list(query);
            return query.aggregateType === "project-brief"
              ? { ...page, items: page.items.map((record) => ({ ...record, eventId: `intake:${"f".repeat(32)}` })) }
              : page;
          },
        },
      })),
    } satisfies PersistenceAdapter;
    expect(await createC8C7PlanStore(forgedIdAdapter).readAcceptedBriefHead(forgedSeed.project.projectId))
      .toEqual({ kind: "invalid-proof", ruleId: "plan.brief.acceptance-proof-invalid" });

    valid.corruptAggregatePayload("project-brief", c8AcceptedBriefAggregateId(seed.project.projectId));
    expect(await store.readAcceptedBriefHead(seed.project.projectId)).toEqual({ kind: "invalid-proof", ruleId: "plan.brief.acceptance-proof-invalid" });

    const empty = createC8C7PlanStore(createMemoryPersistenceAdapter());
    expect(await empty.readAcceptedBriefHead("prj:absent")).toEqual({ kind: "absent" });

    const unavailable = createC8C7PlanStore({
      ...createMemoryPersistenceAdapter(),
      transact: async () => { throw new Error("adapter unavailable"); },
    });
    expect(await unavailable.readAcceptedBriefHead("prj:unavailable")).toEqual({ kind: "unresolved", ruleId: "plan.store.unresolved", reason: "adapter-unavailable" });
  });

  it("bounds evidence by an injected deadline, preserves an un-dispatched capability, and treats a missing bound brief as invalid proof", async () => {
    const base = createMemoryPersistenceAdapter();
    const { request } = await preparedDraft(base);
    const normalStore = createC8C7PlanStore(base);
    const authorization = issueSyntheticPlanCommitAuthorization(request);
    const preDispatchExpiry = createC8C7PlanStore(base, planSha256, {
      evidenceDeadlineMs: 1,
      now: (() => { let tick = 0; return () => tick++; })(),
    });
    expect(await preDispatchExpiry.commit(request, authorization)).toEqual({
      kind: "refused", code: "PLAN_STORE_UNAVAILABLE", ruleId: "plan.store.unavailable",
    });
    expect(await normalStore.commit(request, authorization)).toMatchObject({ kind: "committed", aggregateVersion: 1 });

    const lateBase = createMemoryPersistenceAdapter();
    const { request: lateRequest } = await preparedDraft(lateBase);
    const consumedAuthorization = issueSyntheticPlanCommitAuthorization(lateRequest);
    const inTransactionExpiry = createC8C7PlanStore(lateBase, planSha256, {
      evidenceDeadlineMs: 3,
      now: (() => { let tick = 0; return () => tick++; })(),
    });
    expect(await inTransactionExpiry.commit(lateRequest, consumedAuthorization)).toEqual({
      kind: "refused", code: "PLAN_STORE_UNAVAILABLE", ruleId: "plan.store.unavailable",
    });
    expect(await createC8C7PlanStore(lateBase).readHead(lateRequest.projectId)).toEqual({ kind: "absent" });
    expect(await createC8C7PlanStore(lateBase).commit(lateRequest, consumedAuthorization)).toEqual({
      kind: "refused", code: "PLAN_AUTHORITY_VIOLATION", ruleId: "plan.provenance.operator-claim-unbacked",
    });

    const expiringOptions = () => ({
      evidenceDeadlineMs: 3,
      now: (() => { let tick = 0; return () => tick++; })(),
    });
    expect(await createC8C7PlanStore(base, planSha256, expiringOptions()).readAcceptedBriefHead(request.projectId))
      .toEqual({ kind: "unresolved", ruleId: "plan.store.unresolved", reason: "evidence-bound-exhausted" });
    expect(await createC8C7PlanStore(base, planSha256, expiringOptions()).readHead(request.projectId))
      .toEqual({ kind: "unavailable", ruleId: "plan.store.unavailable", reason: "evidence-bound-exhausted" });
    expect(await createC8C7PlanStore(base, planSha256, expiringOptions()).readJournal(request.projectId, { limit: 128, cursor: null }))
      .toEqual({ kind: "unavailable", ruleId: "plan.store.unavailable", reason: "evidence-bound-exhausted" });

    const missingBrief = {
      ...base,
      transact: <T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> => base.transact((tx) => work({
        ...tx,
        aggregates: {
          ...tx.aggregates,
          get: (aggregateType, aggregateId) => aggregateType === "project-brief"
            ? Promise.resolve(null)
            : tx.aggregates.get(aggregateType, aggregateId),
        },
      })),
    } satisfies PersistenceAdapter;
    expect(await createC8C7PlanStore(missingBrief).readAcceptedBriefHead(request.projectId))
      .toEqual({ kind: "invalid-proof", ruleId: "plan.brief.acceptance-proof-invalid" });
  });

  it("returns not-attempted when accepted-proof evidence becomes unresolved before mutation", async () => {
    const base = createMemoryPersistenceAdapter();
    const { request } = await preparedDraft(base);
    const faulty = {
      ...base,
      transact: <T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> => base.transact((tx) => work({
        ...tx,
        events: {
          ...tx.events,
          list: async (query) => query.aggregateType === "project-brief"
            ? Promise.reject(new PersistenceError("STORAGE_FAILURE", "bounded evidence unavailable"))
            : tx.events.list(query),
        },
      })),
    } satisfies PersistenceAdapter;
    const store = createC8C7PlanStore(faulty);
    expect(await store.commit(request, issueSyntheticPlanCommitAuthorization(request))).toEqual({ kind: "not-attempted", reason: "brief-evidence-unresolved", ruleId: "plan.store.unresolved" });
    expect(await createC8C7PlanStore(base).readHead(request.projectId)).toEqual({ kind: "absent" });
  });

  it("routes corrupt stored plan events to corrupt and malformed public cursors to cursor-invalid", async () => {
    const adapter = createMemoryPersistenceAdapter();
    const { request } = await preparedDraft(adapter);
    const store = createC8C7PlanStore(adapter);
    expect(await store.commit(request, issueSyntheticPlanCommitAuthorization(request))).toMatchObject({ kind: "committed" });
    adapter.corruptEventPayload(request.steps[0].eventId);
    expect(await store.readHead(request.projectId)).toEqual({ kind: "corrupt", ruleId: "plan.store.corrupt" });
    expect(await store.readJournal(request.projectId, { limit: 0, cursor: null })).toEqual({ kind: "cursor-invalid", ruleId: "plan.store.cursor-invalid" });
    expect(await store.readJournal(request.projectId, { limit: 129, cursor: null })).toEqual({ kind: "cursor-invalid", ruleId: "plan.store.cursor-invalid" });
    expect(await store.readJournal(request.projectId, { limit: 128, cursor: "" })).toEqual({ kind: "cursor-invalid", ruleId: "plan.store.cursor-invalid" });
    expect(await store.readJournal(request.projectId, { limit: 128, cursor: null, extra: true } as never)).toEqual({ kind: "cursor-invalid", ruleId: "plan.store.cursor-invalid" });
    let invoked = 0;
    const accessor = { cursor: null } as { limit?: number; cursor: string | null };
    Object.defineProperty(accessor, "limit", { enumerable: true, get: () => { invoked += 1; return 128; } });
    expect(await store.readJournal(request.projectId, accessor as never)).toEqual({ kind: "cursor-invalid", ruleId: "plan.store.cursor-invalid" });
    expect(invoked).toBe(0);
  });

  it("rolls back when an adapter returns valid-looking aggregate coordinates other than the attempted write", async () => {
    const base = createMemoryPersistenceAdapter();
    const { request } = await preparedDraft(base);
    const faulty = {
      ...base,
      transact: <T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> => base.transact((tx) => work({
        ...tx,
        aggregates: {
          ...tx.aggregates,
          create: async (input) => ({ ...await tx.aggregates.create(input), aggregateId: "prj:returned-other-plan" }),
        },
      })),
    } satisfies PersistenceAdapter;
    const outcome = await createC8C7PlanStore(faulty).commit(request, issueSyntheticPlanCommitAuthorization(request));
    expect(outcome).toEqual({ kind: "unknown" });
    expect(await createC8C7PlanStore(base).readHead(request.projectId)).toEqual({ kind: "absent" });
  });

  it("runtime-validates adapter record metadata, opaque cursors, and data properties", async () => {
    const acceptedBase = createMemoryPersistenceAdapter();
    const acceptedSeed = await seedFoundations(acceptedBase);
    const forgedAcceptedMetadata = {
      ...acceptedBase,
      transact: <T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> => acceptedBase.transact((tx) => work({
        ...tx,
        events: {
          ...tx.events,
          list: async (query) => {
            const page = await tx.events.list(query);
            return query.aggregateType === "project-brief"
              ? { ...page, items: page.items.map((record) => ({ ...record, globalSequence: 0 })) }
              : page;
          },
        },
      })),
    } satisfies PersistenceAdapter;
    expect(await createC8C7PlanStore(forgedAcceptedMetadata).readAcceptedBriefHead(acceptedSeed.project.projectId))
      .toEqual({ kind: "invalid-proof", ruleId: "plan.brief.acceptance-proof-invalid" });

    const laterAccepted = await acceptNextBrief(acceptedBase, acceptedSeed.accepted);
    const missingPriorAcceptance = {
      ...acceptedBase,
      transact: <T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> => acceptedBase.transact((tx) => work({
        ...tx,
        events: {
          ...tx.events,
          list: async (query) => {
            const page = await tx.events.list(query);
            return query.aggregateType === "project-brief"
              ? { ...page, items: page.items.filter((record) => record.aggregateVersion === laterAccepted.aggregateVersion) }
              : page;
          },
        },
      })),
    } satisfies PersistenceAdapter;
    expect(await createC8C7PlanStore(missingPriorAcceptance).readAcceptedBriefHead(laterAccepted.projectId))
      .toEqual({ kind: "invalid-proof", ruleId: "plan.brief.acceptance-proof-invalid" });
    const reversedAcceptedJournal = {
      ...acceptedBase,
      transact: <T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> => acceptedBase.transact((tx) => work({
        ...tx,
        events: {
          ...tx.events,
          list: async (query) => {
            const page = await tx.events.list(query);
            return query.aggregateType === "project-brief" ? { ...page, items: [...page.items].reverse() } : page;
          },
        },
      })),
    } satisfies PersistenceAdapter;
    expect(await createC8C7PlanStore(reversedAcceptedJournal).readAcceptedBriefHead(laterAccepted.projectId))
      .toEqual({ kind: "unresolved", ruleId: "plan.store.unresolved", reason: "cursor-protocol-invalid" });
    const extraAcceptedJournalEvent = {
      ...acceptedBase,
      transact: <T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> => acceptedBase.transact((tx) => work({
        ...tx,
        events: {
          ...tx.events,
          list: async (query) => {
            const page = await tx.events.list(query);
            if (query.aggregateType !== "project-brief" || page.items.length === 0) return page;
            const last = page.items.at(-1)!;
            return {
              ...page,
              items: [...page.items, {
                ...last,
                eventId: "intake:unexpected-journal-entry",
                eventType: "project-brief.unexpected",
                globalSequence: last.globalSequence + 1,
              }],
            };
          },
        },
      })),
    } satisfies PersistenceAdapter;
    expect(await createC8C7PlanStore(extraAcceptedJournalEvent).readAcceptedBriefHead(laterAccepted.projectId))
      .toEqual({ kind: "invalid-proof", ruleId: "plan.brief.acceptance-proof-invalid" });

    const planBase = createMemoryPersistenceAdapter();
    const { request } = await preparedDraft(planBase);
    expect(await createC8C7PlanStore(planBase).commit(request, issueSyntheticPlanCommitAuthorization(request)))
      .toMatchObject({ kind: "committed" });
    const invalidCursor = {
      ...planBase,
      transact: <T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> => planBase.transact((tx) => work({
        ...tx,
        events: {
          ...tx.events,
          list: async (query) => {
            const page = await tx.events.list(query);
            return query.aggregateType === "project-plan" ? { ...page, nextCursor: "" } : page;
          },
        },
      })),
    } satisfies PersistenceAdapter;
    const cursorStore = createC8C7PlanStore(invalidCursor);
    expect(await cursorStore.readHead(request.projectId)).toEqual({
      kind: "unavailable",
      ruleId: "plan.store.unavailable",
      reason: "cursor-protocol-invalid",
    });
    expect(await cursorStore.readJournal(request.projectId, { limit: 128, cursor: null }))
      .toEqual({ kind: "cursor-invalid", ruleId: "plan.store.cursor-invalid" });

    let getterCalls = 0;
    const accessorRecord = {
      ...planBase,
      transact: <T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> => planBase.transact((tx) => work({
        ...tx,
        events: {
          ...tx.events,
          list: async (query) => {
            const page = await tx.events.list(query);
            if (query.aggregateType !== "project-plan" || page.items.length === 0) return page;
            const hostile = { ...page.items[0] };
            Object.defineProperty(hostile, "eventId", {
              enumerable: true,
              get: () => { getterCalls += 1; return page.items[0]!.eventId; },
            });
            return { ...page, items: [hostile, ...page.items.slice(1)] };
          },
        },
      })),
    } satisfies PersistenceAdapter;
    expect(await createC8C7PlanStore(accessorRecord).readJournal(request.projectId, { limit: 128, cursor: null }))
      .toEqual({ kind: "corrupt", ruleId: "plan.store.corrupt" });
    expect(getterCalls).toBe(0);
  });
});
