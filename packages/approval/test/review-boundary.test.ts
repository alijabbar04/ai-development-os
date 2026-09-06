import { afterEach, describe, expect, it } from "vitest";
import { computeChecksumOfText, type PersistenceAdapter } from "@ai-dev-os/persistence";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";
import { parseApprovalRequest, parseProject, parseSpendingRequest, serializeCanonicalProjectJson, spendingSubjectMaterial } from "@ai-dev-os/project";
import {
  APPROVAL_CLASSES, approvalIdentityMaterial, evaluateApprovalOperation, parseApprovalOperation,
  parseApprovalProposal, parsePreparedApproval, prepareApprovalRequest, projectApproval,
  type ApprovalAuthorization, type PreparedApproval,
} from "../src/index.js";
import { approvalSha256 as hash, issueSyntheticApprovalAuthorization, syntheticAuthorizationState } from "../src/testing/index.js";
import { T0, T1, controls, harness, operation, operator, prepared, project, proposal, stop, wrapTransaction } from "./fixtures.js";

const adapters: PersistenceAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map((a) => a.close())); });
async function adapter(kind: string) {
  const clock = { now: () => new Date(T0) };
  const value = kind === "memory" ? createMemoryPersistenceAdapter({ clock }) : await createSqlitePersistenceAdapter({ memory: true, clock });
  adapters.push(value); return value;
}
async function snapshot(a: PersistenceAdapter) {
  return a.transact(async (tx) => ({ approvals: await tx.aggregates.list({ aggregateType: "approval-request", limit: 1000 }),
    spending: await tx.aggregates.list({ aggregateType: "spending-request", limit: 1000 }), events: await tx.events.list({ limit: 1000 }) }));
}
function changedMaterial(request: PreparedApproval, kind: string) {
  const p = request.proposal;
  return prepared(kind === "note" ? { ...p, explanation: { ...p.explanation, note: { origin: "operator", text: "A different explanation of identical authority." } } }
    : { ...p, createdAt: "2026-09-05T11:59:00.000Z" });
}
// A complete legacy global purchase, valid under the round-1 construction rule.
// C6 remains nullable; this fixture does not obtain a project by changing an ID.
function legacyGlobal(): PreparedApproval {
  const p = prepared();
  const global = { ...p.proposal, binding: { ...p.proposal.binding, project: null, scope: { ...p.proposal.binding.scope, projectId: null } } };
  const identityDigest = hash.sha256(approvalIdentityMaterial(global, p.approval.money));
  const approval = parseApprovalRequest({ ...p.approval, approvalRequestId: `apr:${identityDigest.slice(0, 32)}`, scope: global.binding.scope });
  const base = { ...p.spending!, projectId: null, linkedApprovalRequestId: approval.approvalRequestId };
  const spending = parseSpendingRequest({ ...base, spendingRequestId: `spd:${hash.sha256(serializeCanonicalProjectJson({ subject: spendingSubjectMaterial(base), projectId: null, approvalRequestId: approval.approvalRequestId })).slice(0, 32)}` });
  return { proposal: global, approval, spending, identityDigest };
}

describe("round-1 project boundary and supplied-material controls", () => {
  it.each(APPROVAL_CLASSES)("refuses an otherwise populated global %s proposal", (kind) => {
    const p = proposal(kind), global = { ...p, binding: { ...p.binding, project: null, scope: { ...p.binding.scope, projectId: null } } };
    expect(() => parseApprovalProposal(global)).toThrow();
    expect(() => prepareApprovalRequest(global, T0, hash)).toThrow();
    expect(parseApprovalProposal(p).binding.project?.projectId).toBe(project.projectId);
    if (kind === "paid-usage") expect(global.binding).toMatchObject({ accountRef: "account:synthetic-owned", providerModelId: "model:fixture", scope: { providerInstanceId: "provider:fixture" } });
  });
  it("cannot reparse, evaluate, project or issue authority for a complete legacy global request", () => {
    const p = legacyGlobal(), op = operation(p, "create");
    expect(parseApprovalRequest(p.approval).scope.projectId).toBeNull();
    expect(parseSpendingRequest(p.spending).projectId).toBeNull();
    expect(() => parsePreparedApproval(p, hash)).toThrow("binding.project-absent");
    expect(() => parseApprovalOperation(op, hash)).toThrow("binding.project-absent");
    expect(() => evaluateApprovalOperation(op, { approval: null, spending: null }, controls(p), operator, hash)).toThrow("binding.project-absent");
    expect(() => projectApproval({ kind: "ready", request: p }, { approval: null, spending: null }, { mode: "normal", serverNow: T0, controls: null, outcome: null }, hash)).toThrow("binding.project-absent");
    expect(() => issueSyntheticApprovalAuthorization(op, operator)).toThrow("binding.project-absent");
  });
  it.each(["note", "createdAt"])("classifies pure supplied %s disagreement without claiming persisted corruption", (kind) => {
    const p = prepared(), changed = changedMaterial(p, kind);
    const approval = parseApprovalRequest({ ...p.approval, state: "approved", decidedAt: T0, approverClass: "project-owner" });
    const spending = parseSpendingRequest({ ...p.spending!, state: "awaiting_approval" });
    expect(changed.identityDigest).toBe(p.identityDigest);
    const op = operation(changed, "authorize", { expectedApprovalVersion: 2, expectedSpendingVersion: 2 });
    expect(() => evaluateApprovalOperation(op, { approval, spending }, controls(changed), operator, hash)).toThrow("request.binding-mismatch");
    expect(() => projectApproval({ kind: "ready", request: changed }, { approval, spending }, { mode: "normal", serverNow: T0, controls: controls(changed), outcome: null }, hash)).toThrow("request.binding-mismatch");
  });
});

describe.each(["memory", "SQLite real engine"])("round-1 repaired %s admission/replay", (kind) => {
  it.each(["missing", "inactive", "changed-content", "wrong-project"])("requires verified actual Project evidence: %s", async (fault) => {
    let armed = false;
    const base = await adapter(kind), h = await harness(base, prepared(), (a) => wrapTransaction(a, (tx) => ({ ...tx, aggregates: { ...tx.aggregates,
      get: async (type, id) => {
        const envelope = await tx.aggregates.get(type, id);
        if (!armed || type !== "project" || envelope === null) return envelope;
        if (fault === "missing") return null;
        const payload = parseProject({ ...project, ...(fault === "inactive" ? { status: "paused" } : fault === "wrong-project" ? { projectId: "prj:other" } : { displayName: "Changed actual project" }) });
        return { ...envelope, payload, checksum: computeChecksumOfText(serializeCanonicalProjectJson(payload)) };
      },
    } })));
    await h.approve(); const before = await snapshot(base); armed = true;
    const result = await h.run("authorize");
    const expected = { missing: ["refused", "binding.project-absent"], inactive: ["refused", "project.not-active"], "changed-content": ["refused", "binding.stale"], "wrong-project": ["corrupt", "store.corrupt"] }[fault]!;
    expect([result.outcome.kind, result.outcome.reason]).toEqual(expected);
    expect(syntheticAuthorizationState(result.token)).toEqual({ attempted: true, consumed: false });
    expect(await snapshot(base)).toEqual(before);
    armed = false;
    expect((await h.store.attempt(result.op, result.token)).kind).toBe("refused");
    expect((await h.run("authorize")).outcome.kind).toBe("committed");
  });
  it("scopes stop refusal to the bound project and preserves records/events", async () => {
    const h = await harness(await adapter(kind)); await h.approve();
    const unrelated = { ...stop(), projectStopId: "pst:other", projectId: "prj:other" };
    await h.adapter.transact((tx) => tx.aggregates.create({ aggregateType: "project-stop", aggregateId: unrelated.projectStopId, schemaVersion: 1, payload: unrelated }));
    const before = await snapshot(h.adapter);
    await h.addStop(); const stopped = await snapshot(h.adapter);
    const refused = await h.run("authorize"); expect(refused.outcome.reason).toBe("project.stopped");
    expect(await snapshot(h.adapter)).toEqual(stopped);
    await h.adapter.transact(async (tx) => { const e = await tx.aggregates.get("project-stop", "pst:fixture"); await tx.aggregates.update({ aggregateType: "project-stop", aggregateId: "pst:fixture", schemaVersion: 1, expectedVersion: e!.aggregateVersion, payload: { ...stop(), resumedAt: T1 } }); });
    h.setTime(T1);
    expect((await h.run("authorize")).outcome.kind).toBe("committed");
    expect((await snapshot(h.adapter)).events.items.length).toBe(before.events.items.length + 2);
  });
  it("keeps an exact create replay no-write after the lifecycle has advanced", async () => {
    const h = await harness(await adapter(kind)); await h.approve(); await h.run("authorize");
    const before = await snapshot(h.adapter), op = operation(h.request, "create", { operationId: "replay:advanced" });
    const token = issueSyntheticApprovalAuthorization(op, operator);
    expect((await h.store.attempt(op, token)).kind).toBe("idempotent-replay");
    expect(syntheticAuthorizationState(token)).toEqual({ attempted: true, consumed: false });
    expect((await h.store.attempt(op, token)).kind).toBe("refused");
    expect(await snapshot(h.adapter)).toEqual(before);
    expect((await h.heads()).approval!.payload).toMatchObject({ record: { state: "consumed" } });
  });
  it.each(["note", "createdAt"])("conflicts on full caller %s material for create and current-version follow-up", async (change) => {
    const h = await harness(await adapter(kind)); await h.approve();
    const changed = changedMaterial(h.request, change), before = await snapshot(h.adapter);
    expect(changed.identityDigest).toBe(h.request.identityDigest);
    for (const action of ["create", "authorize"] as const) {
      const op = action === "create" ? operation(changed, action, { operationId: `material:${change}:${action}` }) : await h.command(action, { request: changed });
      const token = issueSyntheticApprovalAuthorization(op, operator);
      expect(await h.store.attempt(op, token)).toMatchObject({ kind: "conflict", reason: "store.material-conflict" });
      expect(syntheticAuthorizationState(token)).toEqual({ attempted: true, consumed: false });
      expect((await h.store.attempt(op, token)).kind).toBe("refused");
      expect(await snapshot(h.adapter)).toEqual(before);
    }
    const head = await h.heads();
    expect((head.spending!.payload as any).record.justification).toBe(h.request.proposal.explanation.note.text);
    const view = projectApproval({ kind: "ready", request: h.request }, { approval: (head.approval!.payload as any).record, spending: (head.spending!.payload as any).record }, { mode: "normal", serverNow: T0, controls: controls(h.request), outcome: { kind: "conflict", operationId: "material", reason: "store.material-conflict" } }, hash);
    expect(view.value.untrustedQuotes[0]!.text).toBe(h.request.proposal.explanation.note.text);
    expect(view.value.recovery).toContain("material or stored version");
    expect(view.value.recovery).not.toContain("a stored version changed");
    expect((await h.run("authorize")).outcome.kind).toBe("committed");
  });
  it.each(["paired-originals", "missing-spending", "missing-approval", "impossible-link", "immutable-record", "malformed", "checksum", "legacy-global"])("retains intrinsic stored corruption for %s", async (fault) => {
    let armed = false;
    const base = await adapter(kind), p = prepared(), changed = changedMaterial(p, "note");
    const h = await harness(base, p, (a) => wrapTransaction(a, (tx) => ({ ...tx, aggregates: { ...tx.aggregates,
      get: async (type, id) => {
        const envelope = await tx.aggregates.get(type, id);
        if (!armed || envelope === null || type === "project") return envelope;
        if (fault === "missing-spending" && type === "spending-request" || fault === "missing-approval" && type === "approval-request") return null;
        if (fault === "paired-originals" && type === "spending-request") {
          const payload = { request: changed, record: { ...(envelope.payload as any).record, justification: changed.proposal.explanation.note.text } };
          return { ...envelope, payload, checksum: computeChecksumOfText(serializeCanonicalProjectJson(payload)) };
        }
        if (["impossible-link", "immutable-record"].includes(fault)) {
          if (type !== "spending-request") return envelope;
          const payload = { ...(envelope.payload as any), record: { ...(envelope.payload as any).record,
            ...(fault === "impossible-link" ? { linkedApprovalRequestId: "apr:other" } : { justification: "Different from this row's own original." }) } };
          return { ...envelope, payload, checksum: computeChecksumOfText(serializeCanonicalProjectJson(payload)) };
        }
        if (type !== "approval-request" || fault === "paired-originals" || fault.startsWith("missing")) return envelope;
        const payload = fault === "legacy-global" ? { request: legacyGlobal(), record: legacyGlobal().approval }
          : { ...(envelope.payload as any), record: { ...(envelope.payload as any).record, state: "malformed" } };
        return { ...envelope, payload, checksum: fault === "checksum" ? envelope.checksum : computeChecksumOfText(serializeCanonicalProjectJson(payload)) };
      },
    } })));
    await h.approve(); const before = await snapshot(base); armed = true;
    const result = await h.run("create");
    expect(result.outcome).toMatchObject({ kind: "corrupt", reason: "store.corrupt" });
    expect(await snapshot(base)).toEqual(before);
    armed = false; expect((await h.run("create")).outcome.kind).toBe("idempotent-replay");
    expect(await snapshot(base)).toEqual(before);
    const globalOp = operation(legacyGlobal(), "create");
    expect(await h.store.attempt(globalOp, {} as ApprovalAuthorization)).toMatchObject({ kind: "refused", reason: "request.malformed" });
  });
});
