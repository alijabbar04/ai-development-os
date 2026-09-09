import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";
import { canonicalizeWithChecksum, type PersistenceAdapter } from "@ai-dev-os/persistence";
import {
  assertAuthenticatedOperatorEvidence,
  computeModelPlanProposalDigest,
  computeProposalDigest,
  evaluateSealConditions,
  parsePlanAssemblyRequest,
  parsePlanProposal,
  parsePlanReviewEvidence,
  prepareModelPlanAdoption,
  projectPlanView,
  type PlanAssemblyRequest,
  type PlanModelFieldEdit,
  type PlanProposal,
} from "../src/index.js";
import { createC8C7PlanStore, issueSyntheticPlanCommitAuthorization, planSha256 } from "../src/testing/index.js";
import {
  acceptedBinding,
  assembled,
  assemblyRequestForBrief,
  complexAssemblyRequest,
  draftRequest,
  projectionContext,
  rawAssemblyRequest,
  resolvedCeiling,
  seedFoundations,
} from "./fixtures.js";

function modelProposal(base = rawAssemblyRequest().proposal): PlanProposal {
  const model = Object.freeze({ origin: "model" as const, derivedFrom: null, verbatim: false });
  return parsePlanProposal({
    ...base,
    source: { kind: "model", authority: "none", routeFingerprint: "a".repeat(64), contributionDigest: "b".repeat(64), narrativeRef: `nar:${"c".repeat(64)}` },
    stages: base.stages.map((node) => ({ ...node, provenance: Object.fromEntries(Object.keys(node.provenance).map((path) => [path, model])) })),
    tasks: base.tasks.map((node) => ({ ...node, provenance: Object.fromEntries(Object.keys(node.provenance).map((path) => [path, model])) })),
  });
}

const edits: readonly PlanModelFieldEdit[] = Object.freeze([
  { nodeKind: "stage", nodeId: "stg:core", fieldPath: "title", value: "Review the operator-edited stage." },
  { nodeKind: "stage", nodeId: "stg:core", fieldPath: "intent", value: "Retain the model source while refining the intent." },
  { nodeKind: "stage", nodeId: "stg:core", fieldPath: "exitCriteria[0]", value: "The edited stage criteria remain visible." },
  { nodeKind: "task", nodeId: "tsk:core", fieldPath: "title", value: "Keep the original contribution." },
  { nodeKind: "task", nodeId: "tsk:core", fieldPath: "objective", value: "Preserve the proposal and all operator edits after reopening." },
  { nodeKind: "task", nodeId: "tsk:core", fieldPath: "acceptance[0].criterion", value: "Reopening retains exact previous and accepted wording." },
]);

function adopt(proposal = modelProposal(), values = edits) {
  return prepareModelPlanAdoption({ proposal, expectedModelProposalDigest: computeModelPlanProposalDigest(proposal, planSha256), edits: values }, planSha256);
}

function assemblyInput(proposal: PlanProposal, base = rawAssemblyRequest()): PlanAssemblyRequest {
  const input = { ...base, proposal, expectedProposalDigest: "0".repeat(64) };
  return parsePlanAssemblyRequest({ ...input, expectedProposalDigest: computeProposalDigest(input, planSha256) });
}

async function prepared(adapter: PersistenceAdapter) {
  const seed = await seedFoundations(adapter), base = assemblyRequestForBrief(seed.accepted.brief);
  const original = modelProposal(base.proposal), adoption = adopt(original);
  const result = assembled(assemblyInput(adoption.proposal, base), seed.project, seed.accepted);
  const review = { ...result.review, authenticatedOperatorEvidence: adoption.authenticatedOperatorEvidence };
  return { seed, original, adoption, result, review, request: draftRequest(result.plan, review, acceptedBinding(seed.accepted), seed.controls) };
}

describe("authenticated model-artifact adoption", () => {
  it("retains the immutable model source and exact before/after wording for all supported prose fields", () => {
    const original = modelProposal(), before = JSON.stringify(original), adoption = adopt(original);
    expect(JSON.stringify(original)).toBe(before);
    expect(adoption.proposal.source).toMatchObject({ ...original.source, kind: "model", authority: "none", adoption: { schemaVersion: 1, originalProposalDigest: computeModelPlanProposalDigest(original, planSha256) } });
    expect(adoption.authenticatedOperatorEvidence).toEqual(edits);
    expect(adoption.proposal.stages[0]?.provenance["title"]).toEqual({ origin: "operator-edit", derivedFrom: null, verbatim: true });
    expect(adoption.proposal.tasks[0]?.provenance["acceptance[0].criterion"]).toEqual({ origin: "operator-edit", derivedFrom: null, verbatim: true });
    expect(adoption.proposal.source.kind === "model" && adoption.proposal.source.adoption?.edits).toHaveLength(6);
    expect(adoption.proposal.dependencies).toEqual(original.dependencies);
    expect(adoption.proposal.budgetCeiling).toEqual(original.budgetCeiling);
    expect(adoption.proposal.tasks[0]?.requirements).toEqual(original.tasks[0]?.requirements);
    expect(adoption.proposal.tasks[0]?.requirementIds).toEqual(original.tasks[0]?.requirementIds);
    expect(adoption.proposal.tasks[0]?.acceptance[0]?.validationCommand).toBe(original.tasks[0]?.acceptance[0]?.validationCommand);
    expect(Object.isFrozen(adoption.proposal.source)).toBe(true);
    expect(Object.isFrozen(adoption.authenticatedOperatorEvidence)).toBe(true);
    expect(parsePlanProposal(JSON.parse(JSON.stringify(adoption.proposal)))).toEqual(adoption.proposal);
  });

  it("adopts an unchanged proposal without inventing edits or changing a multi-task dependency graph", () => {
    const base = complexAssemblyRequest(), original = modelProposal(base.proposal), adoption = adopt(original, []);
    expect(adoption.authenticatedOperatorEvidence).toEqual([]);
    expect(adoption.proposal.tasks).toEqual(original.tasks);
    expect(adoption.proposal.dependencies.length).toBeGreaterThan(0);
    expect(adoption.proposal.dependencies).toEqual(original.dependencies);
    expect(assembled(assemblyInput(adoption.proposal, base)).plan.state).toBe("drafting");
  });

  it.each(["project", "brief", "route", "contribution", "content"] as const)("binds the factory to the original %s identity", (change) => {
    const original = modelProposal(), raw = structuredClone(original) as unknown as Record<string, unknown>;
    if (change === "project") raw["projectId"] = "prj:other";
    if (change === "brief") raw["briefId"] = "brf:other";
    if (change === "route") (raw["source"] as Record<string, unknown>)["routeFingerprint"] = "d".repeat(64);
    if (change === "contribution") (raw["source"] as Record<string, unknown>)["contributionDigest"] = "d".repeat(64);
    if (change === "content") (raw["tasks"] as Record<string, unknown>[])[0]!["title"] = "A substituted task.";
    expect(() => prepareModelPlanAdoption({ proposal: raw, expectedModelProposalDigest: computeModelPlanProposalDigest(original, planSha256), edits: [] }, planSha256)).toThrow();
  });

  it("does not turn ordinary or already adopted model input into authenticated operator authorship", () => {
    const original = modelProposal(), proposal = structuredClone(original) as unknown as Record<string, unknown>;
    const provenance = (proposal["tasks"] as Record<string, unknown>[])[0]!["provenance"] as Record<string, unknown>;
    for (const origin of ["operator", "operator-edit"]) {
      provenance["title"] = { origin, derivedFrom: null, verbatim: true };
      expect(() => parsePlanProposal(proposal)).toThrow();
    }
    expect(() => computeModelPlanProposalDigest(rawAssemblyRequest().proposal, planSha256)).toThrow();
    expect(() => adopt(adopt(original).proposal)).toThrow();
    expect(() => parsePlanProposal({ ...original, source: { ...original.source, authority: "operator" } })).toThrow();
    expect(() => parsePlanProposal({ ...original, source: { ...original.source, approvalId: "apr:invented" } })).toThrow();
  });

  it.each([
    { nodeKind: "stage", nodeId: "stg:absent", fieldPath: "title", value: "New text." },
    { nodeKind: "task", nodeId: "tsk:core", fieldPath: "dependencies", value: "A new graph." },
    { nodeKind: "task", nodeId: "tsk:core", fieldPath: "requirements.kind", value: "shell" },
    { nodeKind: "task", nodeId: "tsk:core", fieldPath: "acceptance[1].criterion", value: "An added criterion." },
    { nodeKind: "task", nodeId: "tsk:core", fieldPath: "acceptance[00].criterion", value: "An ambiguous path." },
    { nodeKind: "stage", nodeId: "stg:core", fieldPath: "exitCriteria[1]", value: "An added criterion." },
  ] as const)("refuses edits outside existing prose fields: $fieldPath", (edit) => {
    expect(() => adopt(modelProposal(), [edit])).toThrow();
  });

  it("rejects duplicate, unchanged, oversized, authority-bearing and accessor-backed edit inputs", () => {
    const original = modelProposal(), expectedModelProposalDigest = computeModelPlanProposalDigest(original, planSha256);
    expect(() => adopt(original, [edits[0]!, edits[0]!])).toThrow();
    expect(() => adopt(original, [{ ...edits[0]!, value: original.stages[0]!.title }])).toThrow();
    expect(() => adopt(original, Array.from({ length: 1_025 }, () => edits[0]!))).toThrow();
    expect(() => prepareModelPlanAdoption({ proposal: original, expectedModelProposalDigest, edits: [{ ...edits[0]!, approvalId: "apr:invented" }] } as never, planSha256)).toThrow();
    let reads = 0;
    const hostile = { proposal: original, expectedModelProposalDigest, get edits() { reads += 1; return []; } };
    expect(() => prepareModelPlanAdoption(hostile, planSha256)).toThrow();
    expect(reads).toBe(0);
    expect(() => computeModelPlanProposalDigest(original, { sha256: () => { throw new Error("OWNED_DIGEST_FAILURE"); } })).toThrow();
    expect(() => computeModelPlanProposalDigest(original, { sha256: () => "invalid" })).toThrow();
  });

  it.each(["missing-history", "wrong-value", "wrong-node", "operator-prior", "wrong-shape", "no-change", "invalid-edit-provenance"] as const)("rejects inconsistent edit history: %s", (change) => {
    const raw = structuredClone(adopt().proposal) as unknown as Record<string, unknown>;
    const source = raw["source"] as Record<string, unknown>, history = (source["adoption"] as Record<string, unknown>)["edits"] as Record<string, unknown>[];
    if (change === "missing-history") history.pop();
    if (change === "wrong-value") history[0]!["value"] = "A different final value.";
    if (change === "wrong-node") history[0]!["nodeId"] = "stg:absent";
    if (change === "operator-prior") history[0]!["previousProvenance"] = { origin: "operator", derivedFrom: null, verbatim: true };
    if (change === "wrong-shape") (source["adoption"] as Record<string, unknown>)["approvalId"] = "apr:invented";
    if (change === "no-change") history[0]!["previousValue"] = history[0]!["value"];
    if (change === "invalid-edit-provenance") ((raw["stages"] as Record<string, unknown>[])[0]!["provenance"] as Record<string, unknown>)["title"] = { origin: "operator-edit", derivedFrom: null, verbatim: false };
    expect(() => parsePlanProposal(raw)).toThrow();
  });

  it("detects a rewritten original even when the edited proposal and outer digest are recomputed", () => {
    const raw = structuredClone(adopt().proposal) as unknown as Record<string, unknown>;
    const source = raw["source"] as Record<string, unknown>, history = (source["adoption"] as Record<string, unknown>)["edits"] as Record<string, unknown>[];
    history[0]!["previousValue"] = "The attacker rewrote the model's original words.";
    expect(() => assembled(assemblyInput(parsePlanProposal(raw)))).toThrow();
  });

  it("still validates the original's brief provenance after that field was edited", () => {
    const original = modelProposal(), raw = structuredClone(original) as unknown as Record<string, unknown>;
    const stage = (raw["stages"] as Record<string, unknown>[])[0]!;
    stage["title"] = "A fabricated verbatim brief objective.";
    (stage["provenance"] as Record<string, unknown>)["title"] = { origin: "brief", derivedFrom: { kind: "brief-objective", briefId: original.briefId }, verbatim: true };
    const adoption = adopt(parsePlanProposal(raw), [edits[0]!]);
    expect(() => assembled(assemblyInput(adoption.proposal))).toThrow();
  });

  it("requires every edited field to be authenticated in both durable review and private commit facts", async () => {
    const adapter = createMemoryPersistenceAdapter();
    try {
      const f = await prepared(adapter), store = createC8C7PlanStore(adapter);
      expect(() => parsePlanReviewEvidence({ ...f.review, authenticatedOperatorEvidence: [] }, planSha256)).toThrow();
      expect(() => assertAuthenticatedOperatorEvidence(f.review, f.adoption.authenticatedOperatorEvidence.slice(1))).toThrow();
      expect(() => assertAuthenticatedOperatorEvidence(f.review, [...f.adoption.authenticatedOperatorEvidence, { ...edits[0]!, fieldPath: "budget" }])).toThrow();
      expect((await store.commit(f.request, issueSyntheticPlanCommitAuthorization(f.request))).kind).toBe("refused");
      expect((await store.readHead(f.seed.project.projectId)).kind).toBe("absent");
      expect((await store.commit(f.request, issueSyntheticPlanCommitAuthorization(f.request, f.adoption.authenticatedOperatorEvidence))).kind).toBe("committed");
      expect((await store.readHead(f.seed.project.projectId)).kind).toBe("head");
      const rows = await adapter.transact((tx) => tx.aggregates.list({ aggregateType: "task-run" }));
      expect(rows.items).toEqual([]);
    } finally { await adapter.close(); }
  });

  it("does not launder material model scope through editing every field", async () => {
    const adapter = createMemoryPersistenceAdapter();
    try {
      const f = await prepared(adapter);
      const conditions = evaluateSealConditions({ plan: f.result.plan, review: f.review, acceptedBrief: f.seed.accepted, project: f.seed.project, controls: f.seed.controls, resolvedProjectCeiling: resolvedCeiling(f.seed), authenticatedDecisions: [], scopeApproval: null });
      expect(conditions.find((row) => row.condition === 6)).toMatchObject({ passed: false });
    } finally { await adapter.close(); }
  });

  it("projects edited fields honestly in both modes with unchanged authority and actions", () => {
    const adoption = adopt(), result = assembled(assemblyInput(adoption.proposal));
    const review = { ...result.review, authenticatedOperatorEvidence: adoption.authenticatedOperatorEvidence };
    const normal = projectPlanView(result.plan, review, "normal", projectionContext(), planSha256);
    const developer = projectPlanView(result.plan, review, "developer", projectionContext(), planSha256);
    expect(JSON.stringify(normal)).toContain('"provenance":"operator-edited"');
    expect(JSON.stringify(developer)).toContain('"originalProposalDigest"');
    expect(normal.authority).toBe("none"); expect(developer.authority).toBe("none");
    expect(normal.commands).toEqual([]); expect(developer.commands).toEqual([]);
  });

  it("retains model attribution, edits, accepted-brief binding and a draft through physical SQLite reopen", async () => {
    const fixtureParent = await realpath(tmpdir());
    const root = await realpath(await mkdtemp(join(fixtureParent, "ai-dev-os-plan-adoption-"))), databasePath = join(root, "planning.sqlite");
    let adapter = createSqlitePersistenceAdapter({ file: databasePath });
    try {
      const f = await prepared(adapter), store = createC8C7PlanStore(adapter);
      expect((await store.commit(f.request, issueSyntheticPlanCommitAuthorization(f.request, f.adoption.authenticatedOperatorEvidence))).kind).toBe("committed");
      const originalBinding = acceptedBinding(f.seed.accepted);
      await adapter.close();
      adapter = createSqlitePersistenceAdapter({ file: databasePath });
      const reopened = createC8C7PlanStore(adapter), head = await reopened.readHead(f.seed.project.projectId);
      expect(head.kind).toBe("head");
      if (head.kind !== "head") throw new Error("OWNED_REOPEN_FAILED");
      expect(head.head.plan.state).toBe("drafting");
      expect(head.head.plan.sealedByApprovalId).toBeNull();
      expect(head.head.acceptedBrief).toEqual(originalBinding);
      expect(head.head.headEvent.payload.review.assemblyRequest.proposal.source).toEqual(f.adoption.proposal.source);
      expect(head.head.headEvent.payload.review.authenticatedOperatorEvidence).toEqual(edits);
      const journal = await reopened.readJournal(f.seed.project.projectId, { limit: 10, cursor: null });
      expect(journal.kind).toBe("page");
      if (journal.kind === "page") expect(journal.page.events.map((event) => event.eventType)).toEqual(["plan.drafted"]);
      const corrupted: PersistenceAdapter = { ...adapter, transact: async (work) => adapter.transact((tx) => work({ ...tx, events: { ...tx.events, list: async (input) => {
        const page = await tx.events.list(input);
        return { ...page, items: page.items.map((event) => {
          if (event.aggregateType !== "project-plan") return event;
          const payload = structuredClone(event.payload) as unknown as { review: { assemblyRequest: { proposal: { source: { adoption: { edits: { previousValue: string }[] } } } } } };
          payload.review.assemblyRequest.proposal.source.adoption.edits[0]!.previousValue = "A rewritten durable original.";
          return { ...event, payload: payload as never, checksum: canonicalizeWithChecksum(payload).checksum };
        }) };
      } } })) };
      expect((await createC8C7PlanStore(corrupted).readHead(f.seed.project.projectId)).kind).toBe("corrupt");
    } finally {
      await adapter.close();
      const target = await realpath(root);
      if (target !== root || dirname(target) !== fixtureParent || !basename(target).startsWith("ai-dev-os-plan-adoption-")) throw new Error("REFUSE_UNOWNED_PLAN_FIXTURE_CLEANUP");
      await rm(target, { recursive: true, force: true });
    }
  });
});
