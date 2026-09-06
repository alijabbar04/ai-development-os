import { afterEach, describe, expect, it } from "vitest";
import { computeChecksumOfText, PersistenceError, type PersistenceAdapter, type TransactionContext } from "@ai-dev-os/persistence";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";
import { parseApprovalRequest, serializeCanonicalProjectJson } from "@ai-dev-os/project";
import { createC7ApprovalStore, issueSyntheticApprovalAuthorization, syntheticAuthorizationState } from "../src/testing/index.js";
import { projectApproval, type ApprovalAuthorization, type ApprovalOperation } from "../src/index.js";
import { approvalSha256 as hash } from "../src/testing/index.js";
import { B, T0, T2, controls, harness, operation, operator, prepared, proposal, wrapTransaction } from "./fixtures.js";

const adapters: PersistenceAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map((a) => a.close())); });
async function adapter(kind: string): Promise<PersistenceAdapter> {
  const options = { clock: { now: () => new Date(T0) } };
  const value = kind === "memory" ? createMemoryPersistenceAdapter(options) : await createSqlitePersistenceAdapter({ ...options, memory: true });
  adapters.push(value); return value;
}
async function snapshot(a: PersistenceAdapter) {
  return a.transact(async (tx) => ({ approvals: await tx.aggregates.list({ aggregateType: "approval-request", limit: 1000 }),
    spending: await tx.aggregates.list({ aggregateType: "spending-request", limit: 1000 }), events: await tx.events.list({ limit: 1000 }) }));
}

describe.each(["memory", "SQLite real engine"])("isolated %s approval/spending transactions", (kind) => {
  it.each(["decline", "expire", "invalidate", "replace"] as const)("atomically closes an initial quote through %s without authorizing it", async (action) => {
    const h = await harness(await adapter(kind)); expect((await h.run("create")).outcome.kind).toBe("committed");
    if (action === "expire") h.setTime(T2);
    if (action === "invalidate") h.setBinding({ ...h.request.proposal.binding, policy: { version: "policy:changed", fingerprint: B } });
    const successor = action === "replace" ? prepared({ ...h.request.proposal, spending: { ...h.request.proposal.spending!, amount: { kind: "known", minorUnits: 1000 } } }) : null;
    expect((await h.run(action, { successor })).outcome.kind).toBe("committed");
    const head = await h.heads();
    expect((head.approval!.payload as any).record.state).toBe(action === "expire" ? "expired" : action === "invalidate" ? "voided" : "rejected");
    expect((head.spending!.payload as any).record.state).toBe(action === "expire" ? "quote_expired" : "declined");
    expect((head.approval!.payload as any).record.consumptionCount).toBe(0);
    if (successor !== null) expect((await h.heads(successor)).approval!.payload).toMatchObject({ record: { state: "requested", consumptionCount: 0 } });
  });
  it("records approval, consumption and operator-reported execution as three distinct steps", async () => {
    const h = await harness(await adapter(kind));
    const opened = await h.run("create"); expect(opened.outcome.kind).toBe("committed");
    expect((await h.run("request-approval")).outcome.kind).toBe("committed");
    const approved = await h.run("approve"); expect(approved.outcome.kind).toBe("committed");
    let heads = await h.heads();
    expect((heads.approval!.payload as any).record.state).toBe("approved"); expect((heads.spending!.payload as any).record.state).toBe("awaiting_approval");
    const approvedView = projectApproval({ kind: "ready", request: h.request }, { approval: (heads.approval!.payload as any).record, spending: (heads.spending!.payload as any).record }, { mode: "normal", serverNow: T0, controls: controls(h.request), outcome: approved.outcome }, hash);
    expect(approvedView.value.status).toBe("Approval recorded");
    expect(approvedView.value.outcome).toBe("Change recorded");
    expect(approvedView.value.actions.map((a) => a.kind)).toEqual(["revoke", "replace"]);
    const authorized = await h.run("authorize"); expect(authorized.outcome.kind).toBe("committed");
    heads = await h.heads();
    expect((heads.approval!.payload as any).record.state).toBe("consumed"); expect((heads.spending!.payload as any).record.state).toBe("authorized");
    expect((heads.spending!.payload as any).record.executedAt).toBeNull();
    expect((await h.run("report-executed")).outcome.kind).toBe("committed");
    expect((await h.run("record-receipt", { receiptRef: "Invoice-EXAMPLE-42" })).outcome.kind).toBe("committed");
    heads = await h.heads();
    expect((heads.spending!.payload as any).record.state).toBe("reconciled");
    const view = projectApproval({ kind: "ready", request: h.request }, { approval: (heads.approval!.payload as any).record, spending: (heads.spending!.payload as any).record }, { mode: "developer", serverNow: T0, controls: controls(h.request), outcome: null }, hash);
    expect(view.value.externalOutcome).toContain("operator reported");
    expect(JSON.stringify(view)).toContain("operatorAssertedReceiptReference");
    const before = await snapshot(h.adapter);
    expect((await h.run("authorize")).outcome.kind).toBe("refused"); expect(await snapshot(h.adapter)).toEqual(before);
  });
  it.each(["decline", "revoke", "expire", "invalidate", "withdraw"] as const)("closes %s through the existing state machines", async (action) => {
    const h = await harness(await adapter(kind)); await h.open();
    if (["revoke", "withdraw"].includes(action)) await h.run("approve");
    if (action === "withdraw") await h.run("authorize");
    if (action === "expire") h.setTime(T2);
    if (action === "invalidate") h.setBinding({ ...h.request.proposal.binding, policy: { version: "policy:two", fingerprint: B } });
    const result = await h.run(action); expect(result.outcome.kind).toBe("committed");
    const heads = await h.heads();
    const expected = { decline: ["rejected", "declined"], revoke: ["revoked", "declined"], expire: ["expired", "quote_expired"], invalidate: ["voided", "declined"], withdraw: ["consumed", "withdrawn"] };
    expect([(heads.approval!.payload as any).record.state, (heads.spending!.payload as any).record.state]).toEqual(expected[action]);
  });
  it("uses content identity for duplicate requests but refuses changed material", async () => {
    const h = await harness(await adapter(kind)); await h.run("create");
    const original = await snapshot(h.adapter);
    const base = h.request.proposal;
    const changedProse = prepared({ ...base, explanation: { ...base.explanation, note: { origin: "operator", text: "A different explanation of the same terms." } } });
    const op = operation(changedProse, "create", { operationId: "duplicate:prose" });
    expect(await h.store.attempt(op, issueSyntheticApprovalAuthorization(op, operator))).toMatchObject({ kind: "conflict", reason: "store.material-conflict" });
    expect(await snapshot(h.adapter)).toEqual(original);
    const tampered = structuredClone(h.request); (tampered.approval as any).money.amountMinorUnits = 1;
    const bad = { ...op, operationId: "bad:material", request: tampered };
    expect((await h.store.attempt(bad, {} as ApprovalAuthorization)).kind).toBe("refused");
  });
  it("atomically replaces two predecessors with a new pair without approving new terms", async () => {
    const h = await harness(await adapter(kind)); await h.approve();
    const base = h.request.proposal;
    const successor = prepared({ ...base, spending: { ...base.spending!, amount: { kind: "known", minorUnits: 1000 }, currency: "EUR" } });
    const replacement = await h.run("replace", { successor }); expect(replacement.outcome.kind).toBe("committed");
    const old = await h.heads(), next = await h.heads(successor);
    expect((old.approval!.payload as any).record.state).toBe("revoked"); expect((old.spending!.payload as any).record.state).toBe("declined");
    expect((next.approval!.payload as any).record.state).toBe("requested"); expect((next.spending!.payload as any).record.amountMinorUnits).toBe(1000);
    expect((old.spending!.payload as any).record.amountMinorUnits).toBe(1900);
    const events = await h.adapter.transact((tx) => tx.events.list({ aggregateType: "approval-request", aggregateId: successor.approval.approvalRequestId }));
    expect((events.items[0]!.payload as any).writes).toHaveLength(4);
  });
  it.each([2, 4])("rolls back the complete %i-record operation after earlier mutations and journal appends", async (count) => {
    const base = await adapter(kind); let armed = false, writes = 0;
    const h = await harness(base, prepared(), (a) => wrapTransaction(a, (tx) => ({ ...tx, aggregates: { ...tx.aggregates,
      create: async (input) => { if (armed && ++writes === count) throw new PersistenceError("CONCURRENCY_CONFLICT", "planted rollback"); return tx.aggregates.create(input); },
      update: async (input) => { if (armed && ++writes === count) throw new PersistenceError("CONCURRENCY_CONFLICT", "planted rollback"); return tx.aggregates.update(input); },
    } })));
    await h.approve(); const before = await snapshot(base); armed = true;
    const next = prepared({ ...h.request.proposal, spending: { ...h.request.proposal.spending!, amount: { kind: "known", minorUnits: 1000 } } });
    const result = await h.run(count === 2 ? "authorize" : "replace", count === 4 ? { successor: next } : {});
    expect(writes).toBe(count); expect(result.outcome.kind).toBe("conflict");
    expect(await snapshot(base)).toEqual(before);
    expect(syntheticAuthorizationState(result.token)).toEqual({ attempted: true, consumed: true });
  });
  it("allows exactly one concurrent consumption", async () => {
    const h = await harness(await adapter(kind)); await h.approve();
    const first = await h.command("authorize"), second = { ...first, operationId: "concurrent:second" };
    const outcomes = await Promise.all([first, second].map((op) => h.store.attempt(op, issueSyntheticApprovalAuthorization(op, operator))));
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["committed", "conflict"]);
    const heads = await h.heads(); expect((heads.approval!.payload as any).record.consumptionCount).toBe(1);
    expect(heads.approval!.aggregateVersion).toBe(3); expect(heads.spending!.aggregateVersion).toBe(3);
  });
  it("rejects active and incomplete stop evidence before mutation consumption", async () => {
    let incomplete = false;
    const base = await adapter(kind), h = await harness(base, prepared(), (a) => wrapTransaction(a, (tx) => ({ ...tx, aggregates: { ...tx.aggregates,
      list: async (q) => incomplete && q.aggregateType === "project-stop" ? { items: [], nextCursor: "repeat" } : tx.aggregates.list(q),
    } })));
    await h.approve(); let before = await snapshot(base); incomplete = true;
    const result = await h.run("authorize"); expect(result.outcome.kind).toBe("refused");
    expect(syntheticAuthorizationState(result.token)).toEqual({ attempted: true, consumed: false });
    expect(await snapshot(base)).toEqual(before); incomplete = false;
    await h.addStop(); before = await snapshot(base);
    expect((await h.run("authorize")).outcome.reason).toBe("project.stopped"); expect(await snapshot(base)).toEqual(before);
    expect((await h.run("invalidate")).outcome.reason).toBe("stop.approval-not-named");
  });
  it("permits stop invalidation only when the durable stop names the exact approval", async () => {
    const h = await harness(await adapter(kind)); await h.approve(); await h.addStop(true);
    expect((await h.run("invalidate")).outcome.kind).toBe("committed");
    expect((await h.heads()).approval!.payload).toMatchObject({ record: { state: "voided", voidedBy: "pst:fixture" } });
  });
  it("cannot use a cast object or changed command as operator authorization", async () => {
    const h = await harness(await adapter(kind)); const op = await h.command("create");
    const before = await snapshot(h.adapter);
    expect((await h.store.attempt(op, {} as ApprovalAuthorization)).reason).toBe("authorization.not-issued");
    const token = issueSyntheticApprovalAuthorization(op, operator);
    expect((await h.store.attempt({ ...op, operationId: "changed" }, token)).kind).toBe("refused");
    expect(await snapshot(h.adapter)).toEqual(before);
    expect((await h.store.attempt(op, token)).kind).toBe("committed");
    expect((await h.store.attempt(op, token)).kind).toBe("refused");
  });
  it("rechecks policy/account binding and activation/expiry within the transaction", async () => {
    const h = await harness(await adapter(kind)); await h.approve(); const before = await snapshot(h.adapter);
    h.setBinding({ ...h.request.proposal.binding, policy: { version: "policy:two", fingerprint: B } });
    expect((await h.run("authorize")).outcome.reason).toBe("binding.stale");
    h.setBinding({ ...h.request.proposal.binding, accountRef: "different-account" });
    expect((await h.run("authorize")).outcome.reason).toBe("binding.stale");
    h.setBinding(h.request.proposal.binding); h.setTime(T2);
    expect((await h.run("authorize")).outcome.reason).toBe("approval.expired");
    expect(await snapshot(h.adapter)).toEqual(before);
  });
  it("recovers a lost acknowledgement with exact events and never retries the write", async () => {
    const base = await adapter(kind); let loseAck = false, mutatingTransactions = 0, observationsFail = false;
    const wrapped: PersistenceAdapter = { ...base,
      migrationStatus: () => base.migrationStatus(), close: () => base.close(),
      transact: async (work) => {
        let mutated = false;
        const value = await base.transact((tx) => work({ ...tx, aggregates: { ...tx.aggregates,
          create: async (input) => { mutated = true; return tx.aggregates.create(input); },
          update: async (input) => { mutated = true; return tx.aggregates.update(input); },
        }, events: { ...tx.events, list: async (q) => { if (observationsFail) throw new PersistenceError("STORAGE_FAILURE", "planted unavailable observation"); return tx.events.list(q); } } }));
        if (mutated) mutatingTransactions++;
        if (mutated && loseAck) { loseAck = false; throw new PersistenceError("STORAGE_FAILURE", "planted lost commit acknowledgement"); }
        return value;
      },
    };
    const h = await harness(base, prepared(), () => wrapped); await h.approve();
    const writesBefore = mutatingTransactions; loseAck = true; observationsFail = true;
    const result = await h.run("authorize"); expect(result.outcome.kind).toBe("unknown");
    expect(mutatingTransactions).toBe(writesBefore + 1);
    expect((await h.store.attempt(result.op, result.token)).kind).toBe("refused");
    expect(syntheticAuthorizationState(result.token)).toEqual({ attempted: true, consumed: true });
    expect((await h.store.observe(result.op)).kind).toBe("unknown");
    observationsFail = false;
    expect((await h.store.observe(result.op)).kind).toBe("committed");
    expect((await h.store.observe(result.op)).kind).toBe("committed");
    expect(mutatingTransactions).toBe(writesBefore + 1);
    expect((await h.store.observe({ ...result.op, operationId: "different" })).kind).toBe("unknown");
  });
  it("proves a rolled-back uncertain write not-recorded from unchanged heads and complete journals", async () => {
    let fail = false;
    const base = await adapter(kind), h = await harness(base, prepared(), (a) => wrapTransaction(a, (tx) => ({ ...tx, events: { ...tx.events,
      append: async (input) => { if (fail) throw new PersistenceError("STORAGE_FAILURE", "planted event failure"); return tx.events.append(input); },
    } })));
    await h.approve(); const before = await snapshot(base); fail = true;
    const result = await h.run("authorize"); expect(result.outcome.kind).toBe("not-recorded");
    expect(await snapshot(base)).toEqual(before);
    expect((await h.store.attempt(result.op, result.token)).kind).toBe("refused");
  });
  it("rejects expiry reached during the last asynchronous head read", async () => {
    let armed = false;
    const base = await adapter(kind), h = await harness(base, prepared(), (a) => wrapTransaction(a, (tx) => ({ ...tx, aggregates: { ...tx.aggregates,
      get: async (type, id) => { const value = await tx.aggregates.get(type, id); if (armed && type === "spending-request") h.setTime(T2); return value; },
    } })));
    await h.approve(); const before = await snapshot(base); armed = true;
    const result = await h.run("authorize");
    expect(result.outcome).toMatchObject({ kind: "refused", reason: "approval.expired" });
    expect(syntheticAuthorizationState(result.token)).toEqual({ attempted: true, consumed: false });
    expect(await snapshot(base)).toEqual(before);
  });
  it.each(["partial", "absent", "metadata", "checksum", "repeating-cursor"])("bounds exact reconciliation with planted %s evidence", async (fault) => {
    let armed = false, queries = 0;
    const base = await adapter(kind), h = await harness(base, prepared(), (a) => wrapTransaction(a, (tx) => ({ ...tx, events: { ...tx.events,
      list: async (query) => {
        const page = await tx.events.list(query);
        if (!armed) return page;
        queries++;
        if (fault === "repeating-cursor") return { items: page.items, nextCursor: "repeat" };
        return { ...page, items: page.items.flatMap((event) => {
          if (event.eventType !== "approval.authorize") return [event];
          if (fault === "absent" || fault === "partial" && event.aggregateType === "spending-request") return [];
          if (fault === "metadata") return [{ ...event, causationId: "planted:other-operation" }];
          if (fault === "checksum") return [{ ...event, payload: { planted: true } }];
          return [event];
        }) };
      },
    } })));
    await h.approve(); const result = await h.run("authorize"); expect(result.outcome.kind).toBe("committed");
    const before = await snapshot(base); armed = true;
    const observed = await h.store.observe(result.op);
    expect(observed.kind).toBe(fault === "absent" || fault === "repeating-cursor" ? "unknown" : "corrupt");
    expect(queries).toBeGreaterThan(0); expect(queries).toBeLessThanOrEqual(2);
    expect(await snapshot(base)).toEqual(before);
    expect((await h.store.attempt(result.op, result.token)).kind).toBe("refused");
    // Restoring the exact journal proves the real commit; the planted views did
    // not create additional write attempts or durable corruption.
    armed = false; expect((await h.store.observe(result.op)).kind).toBe("committed");
  });
  it("rolls back when the adapter returns mismatched event metadata", async () => {
    let armed = false;
    const base = await adapter(kind), h = await harness(base, prepared(), (a) => wrapTransaction(a, (tx) => ({ ...tx, events: { ...tx.events,
      append: async (input) => { const event = await tx.events.append(input); return armed ? { ...event, causationId: "planted:wrong" } : event; },
    } })));
    await h.approve(); const before = await snapshot(base); armed = true;
    expect((await h.run("authorize")).outcome.kind).toBe("corrupt");
    expect(await snapshot(base)).toEqual(before);
  });
  it("distinguishes checksum-valid malformed stored records from refused requested transitions", async () => {
    let armed = false;
    const base = await adapter(kind), h = await harness(base, prepared(), (a) => wrapTransaction(a, (tx) => ({ ...tx, aggregates: { ...tx.aggregates,
      get: async (type, id) => {
        const envelope = await tx.aggregates.get(type, id);
        if (!armed || type !== "approval-request" || envelope === null) return envelope;
        const payload = { ...(envelope.payload as object), record: { ...(envelope.payload as any).record, state: "planted-impossible-state" } };
        return { ...envelope, payload, checksum: computeChecksumOfText(serializeCanonicalProjectJson(payload)) };
      },
    } })));
    await h.approve(); const before = await snapshot(base); armed = true;
    expect((await h.run("authorize")).outcome).toMatchObject({ kind: "corrupt", reason: "store.corrupt" });
    expect(await snapshot(base)).toEqual(before);
    armed = false;
    expect((await h.run("approve")).outcome.kind).toBe("refused");
    expect(await snapshot(base)).toEqual(before);
  });
});
