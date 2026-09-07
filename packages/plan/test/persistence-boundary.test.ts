import { expect, it } from "vitest";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { PersistenceError, canonicalizeWithChecksum, type AggregateEnvelope, type PersistenceAdapter, type TransactionContext } from "@ai-dev-os/persistence";
import { assemblePlan, type PlanCommitAuthorization } from "../src/index.js";
import { createPlanPersistenceBoundary, type PlanPersistenceOptions } from "../src/persistence-boundary.js";
import { createC8C7PlanStore, issueSyntheticPlanCommitAuthorization, planSha256 } from "../src/testing/index.js";
import { T0, acceptedBinding, assemblyRequestForBrief, draftRequest, seedFoundations } from "./fixtures.js";

async function fixture(initial = true) {
  const adapter = createMemoryPersistenceAdapter(), seed = await seedFoundations(adapter), input = assemblyRequestForBrief(seed.accepted.brief);
  const assembly = assemblePlan(input, seed.project, seed.accepted, { planId: input.newPlanId, revision: 1, supersedes: null, state: "drafting", createdAt: T0, updatedAt: T0, sealedAt: null }, planSha256);
  const request = draftRequest(assembly.plan, assembly.review, acceptedBinding(seed.accepted), seed.controls), store = createC8C7PlanStore(adapter);
  if (initial) expect((await store.commit(request, issueSyntheticPlanCommitAuthorization(request))).kind).toBe("committed");
  return { adapter, seed, request, store };
}
it.each(["missing-project", "unavailable-brief", "corrupt-brief", "unavailable-head", "create-storage", "create-conflict", "create-corrupt-reply", "append-storage", "append-conflict", "append-corrupt-reply"] as const)("refuses or reconciles %s at the real transaction boundary with no partial plan", async (kind) => {
  const f = await fixture(false);
  const adapter = faultAdapter(f.adapter, (tx) => ({ ...tx,
    aggregates: { ...tx.aggregates,
      get: async (...args) => {
        if (kind === "missing-project" && args[0] === "project") return null;
        if (kind === "unavailable-brief" && args[0] === "project-brief" || kind === "unavailable-head" && args[0] === "project-plan") throw new PersistenceError("STORAGE_FAILURE", "Owned unavailable read");
        const row = await tx.aggregates.get(...args);
        return kind === "corrupt-brief" && args[0] === "project-brief" && row !== null ? { ...row, payload: null } : row;
      },
      create: async (input) => {
        if (kind === "create-storage") throw new PersistenceError("STORAGE_FAILURE", "Owned failed write");
        if (kind === "create-conflict") throw new PersistenceError("DUPLICATE_ID", "Owned concurrent write");
        const row = await tx.aggregates.create(input); return kind === "create-corrupt-reply" ? { ...row, payload: null } : row;
      },
    }, events: { ...tx.events, append: async (input) => {
      if (kind === "append-storage") throw new PersistenceError("STORAGE_FAILURE", "Owned journal failure");
      if (kind === "append-conflict") throw new PersistenceError("DUPLICATE_ID", "Owned journal collision");
      const row = await tx.events.append(input); return kind === "append-corrupt-reply" ? { ...row, eventId: "event:wrong-result" } : row;
    } },
  }));
  const store = createC8C7PlanStore(adapter), outcome = await store.commit(f.request, issueSyntheticPlanCommitAuthorization(f.request));
  const expected = kind === "unavailable-brief" ? "not-attempted" : kind.endsWith("conflict") ? "conflict" : kind.startsWith("create-") || kind.startsWith("append-") ? "unknown" : "refused";
  expect(outcome.kind).toBe(expected); expect((await f.store.readHead(f.seed.project.projectId)).kind).toBe("absent");
  expect((await f.store.readAcceptedBriefHead(f.seed.project.projectId)).kind).toBe("accepted"); await f.adapter.close();
});
function faultAdapter(adapter: PersistenceAdapter, edit: (tx: TransactionContext) => TransactionContext): PersistenceAdapter {
  return { ...adapter, transact: async (work) => await adapter.transact((tx) => work(edit(tx))) };
}
it.each(["corrupt-get", "unavailable-get", "missing-head", "checksum", "cursor-cycle", "corrupt-events", "unavailable-events", "missing-head-corrupt-events", "missing-head-unavailable-events"] as const)("the production boundary refuses incomplete %s evidence without altering saved work", async (kind) => {
  const f = await fixture();
  const adapter = faultAdapter(f.adapter, (tx) => ({ ...tx,
    aggregates: { ...tx.aggregates, get: async (...args) => {
      if (kind === "corrupt-get") throw new PersistenceError("CORRUPTION_DETECTED", "Owned damaged record");
      if (kind === "unavailable-get") throw new Error("OWNED_ADAPTER_UNAVAILABLE");
      if (kind.startsWith("missing-head")) return null;
      const row = await tx.aggregates.get(...args);
      return row !== null && kind === "checksum" ? { ...row, payload: { damage: true } } : row;
    } },
    events: { ...tx.events, list: async (input) => {
      if (kind.endsWith("corrupt-events")) throw new PersistenceError("CORRUPTION_DETECTED", "Owned damaged journal");
      if (kind.endsWith("unavailable-events")) throw new PersistenceError("INVALID_CURSOR", "Owned unavailable page");
      if (kind === "cursor-cycle") return { items: [], nextCursor: "cycle" };
      return await tx.events.list(input);
    } },
  }));
  const boundary = createPlanPersistenceBoundary(adapter, { take: () => null });
  const unavailable = kind.includes("unavailable") || kind === "cursor-cycle";
  expect((await boundary.readHead(f.seed.project.projectId)).kind).toBe(unavailable ? "unavailable" : "corrupt");
  expect((await boundary.readAcceptedBriefHead(f.seed.project.projectId)).kind).toBe(unavailable ? "unresolved" : "invalid-proof");
  expect((await f.store.readHead(f.seed.project.projectId)).kind).toBe("head");
  await f.adapter.close();
});
it("distinguishes malformed journal windows, broken ordering, corrupt pages and unavailable adapters", async () => {
  const f = await fixture(), project = f.seed.project.projectId;
  for (const window of [{ limit: 0, cursor: null }, { limit: 129, cursor: null }, { limit: 10, cursor: "" }, { limit: 10, cursor: null, path: "../escape" }]) expect((await f.store.readJournal(project, window)).kind).toBe("cursor-invalid");
  for (const [error, expected] of [[new PersistenceError("INVALID_CURSOR", "owned"), "cursor-invalid"], [new PersistenceError("CORRUPTION_DETECTED", "owned"), "corrupt"], [new Error("OWNED_DOWN"), "unavailable"]] as const) {
    const boundary = createPlanPersistenceBoundary(faultAdapter(f.adapter, (tx) => ({ ...tx, events: { ...tx.events, list: async () => { throw error; } } })), { take: () => null });
    expect((await boundary.readJournal(project, { limit: 10, cursor: null })).kind).toBe(expected);
  }
  const duplicate = createPlanPersistenceBoundary(faultAdapter(f.adapter, (tx) => ({ ...tx, events: { ...tx.events, list: async (input) => { const page = await tx.events.list(input); return { items: [...page.items, ...page.items], nextCursor: null }; } } })), { take: () => null });
  expect((await duplicate.readJournal(project, { limit: 10, cursor: null })).kind).toBe("cursor-invalid");
  await f.adapter.close();
});
it.each([
  { evidenceDeadlineMs: 0 }, { now: () => Number.NaN }, { now: () => Number.MAX_SAFE_INTEGER }, { now: () => { throw new Error("OWNED_CLOCK_FAILURE"); } },
] satisfies PlanPersistenceOptions[])("bounds every store operation when no trustworthy evidence deadline exists %#", async (options) => {
  const f = await fixture(); let taken = 0;
  const boundary = createPlanPersistenceBoundary(f.adapter, { take: () => { taken++; return null; } }, planSha256, options);
  expect(await boundary.readHead(f.seed.project.projectId)).toMatchObject({ kind: "unavailable", reason: "evidence-bound-exhausted" });
  expect(await boundary.readAcceptedBriefHead(f.seed.project.projectId)).toMatchObject({ kind: "unresolved", reason: "evidence-bound-exhausted" });
  expect(await boundary.readJournal(f.seed.project.projectId, { limit: 10, cursor: null })).toMatchObject({ kind: "unavailable", reason: "evidence-bound-exhausted" });
  expect((await boundary.commit(f.request, {} as PlanCommitAuthorization)).kind).toBe("refused"); expect(taken).toBe(0);
  await f.adapter.close();
});

it.each(["complete-pages", "invalid-cursor", "corrupt-page", "adapter-cursor", "adapter-corrupt", "adapter-down", "empty-continuation", "duplicate-order", "stop-identity", "stop-shape"] as const)("requires a complete trustworthy stop scan before committing a plan: %s", async (kind) => {
  const f = await fixture(false);
  const stops = await f.adapter.transact(async (tx) => {
    const rows: AggregateEnvelope[] = [];
    for (const suffix of ["a", "b"]) rows.push(await tx.aggregates.create({ aggregateType: "project-stop", aggregateId: `pst:foreign-${suffix}`, schemaVersion: 1, payload: {
      schemaVersion: 1, projectStopId: `pst:foreign-${suffix}`, revision: 1, projectId: "prj:foreign", engagedAt: T0, resumedAt: null,
      effects: { cancelledTaskIds: [], stoppingSessionIds: [], unconfirmedSessionIds: [], voidedApprovalIds: [], voidedHandoverIds: [], releasedReservationIds: [], retainedReservationIds: [] },
    } }));
    return rows;
  });
  const adapter = faultAdapter(f.adapter, (tx) => ({ ...tx, aggregates: { ...tx.aggregates, list: async (input) => {
    if (input.aggregateType !== "project-stop") return await tx.aggregates.list(input);
    if (kind === "adapter-cursor") throw new PersistenceError("INVALID_CURSOR", "Owned unavailable stop cursor");
    if (kind === "adapter-corrupt") throw new PersistenceError("CORRUPTION_DETECTED", "Owned damaged stop page");
    if (kind === "adapter-down") throw new Error("OWNED_STOP_ADAPTER_UNAVAILABLE");
    if (kind === "invalid-cursor") return { items: [], nextCursor: "../escape" };
    if (kind === "empty-continuation") return { items: [], nextCursor: "next" };
    if (kind === "corrupt-page") return { items: [{ ...stops[0]!, payload: {} }], nextCursor: null };
    if (kind === "duplicate-order") return { items: [stops[1]!, stops[0]!], nextCursor: null };
    if (kind === "stop-identity" || kind === "stop-shape") {
      const payload = kind === "stop-shape" ? {} : { ...(stops[0]!.payload as object), projectStopId: "pst:wrong" };
      return { items: [{ ...stops[0]!, payload, checksum: canonicalizeWithChecksum(payload).checksum }], nextCursor: null };
    }
    return input.cursor === "second" ? { items: [stops[1]!], nextCursor: null } : { items: [stops[0]!], nextCursor: "second" };
  } } }));
  const store = createC8C7PlanStore(adapter), outcome = await store.commit(f.request, issueSyntheticPlanCommitAuthorization(f.request));
  expect(outcome.kind).toBe(kind === "complete-pages" ? "committed" : "refused");
  if (kind !== "complete-pages") expect((await f.store.readHead(f.seed.project.projectId)).kind).toBe("absent");
  else expect((await f.store.readHead(f.seed.project.projectId)).kind).toBe("head");
  await f.adapter.close();
});

it.each(["checksum", "identity", "shape", "payload-project", "time-order"] as const)("rejects %s corruption in authoritative Project evidence before writes", async (kind) => {
  const f = await fixture(false);
  const adapter = faultAdapter(f.adapter, (tx) => ({ ...tx, aggregates: { ...tx.aggregates, get: async (...args) => {
    const row = await tx.aggregates.get(...args); if (row === null || args[0] !== "project") return row;
    if (kind === "checksum") return { ...row, payload: {} };
    if (kind === "identity") return { ...row, aggregateId: "prj:wrong" };
    if (kind === "time-order") return { ...row, updatedAt: "2000-01-01T00:00:00.000Z" };
    const payload = kind === "shape" ? {} : { ...(row.payload as object), projectId: "prj:wrong" };
    return { ...row, payload, checksum: canonicalizeWithChecksum(payload).checksum };
  } } }));
  expect((await createC8C7PlanStore(adapter).commit(f.request, issueSyntheticPlanCommitAuthorization(f.request))).kind).toBe("refused");
  expect((await f.store.readHead(f.seed.project.projectId)).kind).toBe("absent"); await f.adapter.close();
});

it.each(["plan-envelope", "plan-project", "brief-envelope"] as const)("does not return another record as the requested %s head", async (kind) => {
  const f = await fixture();
  const adapter = faultAdapter(f.adapter, (tx) => ({ ...tx, aggregates: { ...tx.aggregates, get: async (...args) => {
    const row = await tx.aggregates.get(...args); if (row === null) return row;
    if (kind === "brief-envelope" && args[0] === "project-brief" || kind === "plan-envelope" && args[0] === "project-plan") return { ...row, aggregateId: "aggregate:other-project" };
    if (kind === "plan-project" && args[0] === "project-plan") { const payload = { ...(row.payload as object), projectId: "prj:other" }; return { ...row, payload, checksum: canonicalizeWithChecksum(payload).checksum }; }
    return row;
  } } }));
  const boundary = createPlanPersistenceBoundary(adapter, { take: () => null });
  expect(kind === "brief-envelope" ? (await boundary.readAcceptedBriefHead(f.seed.project.projectId)).kind : (await boundary.readHead(f.seed.project.projectId)).kind).toBe(kind === "brief-envelope" ? "invalid-proof" : "corrupt");
  expect((await f.store.readHead(f.seed.project.projectId)).kind).toBe("head"); await f.adapter.close();
});
