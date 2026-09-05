"use strict";

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const npmExecPath = process.env["npm_execpath"];
if (typeof npmExecPath !== "string" || !/npm-cli\.js$/u.test(npmExecPath.replaceAll("\\", "/"))) {
  throw new Error("Invoke the plan packed-consumer gate through its npm script.");
}

function npm(args, cwd) {
  const result = spawnSync(process.execPath, [npmExecPath, ...args], {
    cwd,
    shell: false,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`npm command exited ${String(result.status)}: ${String(result.stderr).slice(-4_000)}`);
  }
  return result.stdout;
}

function packedMainGraph(packageDirectory) {
  const distRoot = resolve(packageDirectory, "dist");
  const pending = [resolve(distRoot, "index.js")];
  const visited = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    const fromRoot = relative(distRoot, file);
    if (fromRoot.startsWith("..") || resolve(distRoot, fromRoot) !== file || !existsSync(file)) {
      throw new Error("The packed main export graph escaped its bounded dist root.");
    }
    visited.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/gu)) {
      pending.push(resolve(dirname(file), match[1]));
    }
  }
  return Object.freeze([...visited]);
}

function containsWrongAggregate(text) {
  return /["']product-plan["']/u.test(text);
}

// Literal transitive runtime closure of the production entry and the isolated
// C8/C7 test-composition entry.  Declaring every tarball at the consumer root
// prevents npm from resolving an unpublished workspace package from elsewhere.
const packages = Object.freeze([
  Object.freeze({ name: "@ai-dev-os/domain", directory: "packages/domain" }),
  Object.freeze({ name: "@ai-dev-os/artifacts", directory: "packages/artifacts" }),
  Object.freeze({ name: "@ai-dev-os/persistence", directory: "packages/persistence" }),
  Object.freeze({ name: "@ai-dev-os/providers", directory: "packages/providers" }),
  Object.freeze({ name: "@ai-dev-os/scheduler", directory: "packages/scheduler" }),
  Object.freeze({ name: "@ai-dev-os/task-graph", directory: "packages/task-graph" }),
  Object.freeze({ name: "@ai-dev-os/project", directory: "packages/project" }),
  Object.freeze({ name: "@ai-dev-os/intake", directory: "packages/intake" }),
  Object.freeze({ name: "@ai-dev-os/product-planning", directory: "packages/product-planning" }),
  Object.freeze({ name: "@ai-dev-os/persistence-memory", directory: "packages/persistence-memory" }),
  Object.freeze({ name: "@ai-dev-os/persistence-sqlite", directory: "packages/persistence-sqlite" }),
  Object.freeze({ name: "@ai-dev-os/plan", directory: "packages/plan" }),
]);

const workRoot = mkdtempSync(join(tmpdir(), "ai-dev-os-plan-packed-consumer-"));
try {
  const packRoot = join(workRoot, "pack");
  const consumerRoot = join(workRoot, "consumer");
  mkdirSync(packRoot);
  mkdirSync(consumerRoot);
  const dependencies = {};
  let totalFiles = 0;
  for (const definition of packages) {
    const root = resolve(repositoryRoot, definition.directory);
    if (!existsSync(join(root, "dist", "index.js"))) throw new Error(`${definition.name} has no built entry.`);
    const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", packRoot], root));
    if (!Array.isArray(packed) || packed.length !== 1) throw new Error(`Unexpected pack result for ${definition.name}.`);
    const description = packed[0];
    if (description.name !== definition.name || typeof description.filename !== "string") {
      throw new Error(`Unexpected package identity for ${definition.name}.`);
    }
    const paths = description.files.map((entry) => String(entry.path));
    const unexpected = paths.filter((path) => path !== "package.json" && path !== "README.md" && !path.startsWith("dist/"));
    if (unexpected.length !== 0 || !paths.includes("dist/index.js") || !paths.includes("dist/index.d.ts")) {
      throw new Error(`${definition.name} tarball violates the bounded file policy.`);
    }
    if (definition.name === "@ai-dev-os/plan"
      && (!paths.includes("dist/testing/index.js") || !paths.includes("dist/testing/index.d.ts"))) {
      throw new Error("The plan tarball does not contain its declared isolated testing export.");
    }
    const tarball = resolve(packRoot, description.filename);
    if (!existsSync(tarball)) throw new Error(`Missing tarball for ${definition.name}.`);
    dependencies[definition.name] = `file:${tarball.replaceAll("\\", "/")}`;
    totalFiles += paths.length;
  }

  writeFileSync(join(consumerRoot, "package.json"), `${JSON.stringify({
    name: "plan-packed-consumer",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies,
  }, null, 2)}\n`);
  writeFileSync(join(consumerRoot, "probe.mjs"), `
    import {
      PLAN_AVAILABLE_COMMANDS,
      PLAN_PRODUCTION_ENABLED,
      PLAN_RUNTIME_CAPABILITIES,
      assemblePlan,
      computePlanCommitContentDigest,
      computeProposalDigest,
      observePlanCommit,
      parsePlanAssemblyRequest,
      parsePlanCommitRequest,
      promoteDraft,
      projectStopSnapshotDigestMaterial,
    } from "@ai-dev-os/plan";
    import {
      createC8C7PlanStore,
      issueSyntheticPlanCommitAuthorization,
      planSha256,
    } from "@ai-dev-os/plan/testing";
    import {
      acceptCandidate,
      assembleCandidate,
      createC7IntakeStore,
      createClarificationSession,
      intakeSha256,
    } from "@ai-dev-os/intake";
    import { parseDecision, parseProject, parseProjectPlan, serializeCanonicalProjectJson } from "@ai-dev-os/project";
    import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
    import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";

    const T0 = "2026-09-04T10:00:00.000Z";
    const T1 = "2026-09-04T10:01:00.000Z";
    const T2 = "2026-09-04T10:02:00.000Z";
    const operator = Object.freeze({ source: "operator-supplied", acceptedByOperator: true });
    const field = (value) => Object.freeze({ value, provenance: operator });

    function project(projectId) {
      return parseProject({
        schemaVersion: 1,
        projectId,
        revision: 1,
        displayName: "Packed C9",
        repositoryRoots: ["C:\\\\Packed-C9"],
        defaultBranch: "main",
        dataClassification: "internal",
        permissionMode: "contained-default",
        budgetAccountId: "budget:" + projectId.slice(4),
        effectiveConfigDigest: "a".repeat(64),
        status: "active",
        createdAt: T0,
        updatedAt: T0,
      });
    }

    async function seed(adapter, suffix) {
      const value = project("prj:packed-" + suffix);
      const envelope = await adapter.transact((tx) => tx.aggregates.create({
        aggregateType: "project",
        aggregateId: value.projectId,
        schemaVersion: 1,
        payload: value,
      }));
      const candidate = assembleCandidate({
        projectId: value.projectId,
        objective: field("Build the packed C9 plan."),
        outcomes: [field("Produce a deterministic plan record.")],
        nonGoals: [field("Do not execute project tasks.")],
        audiences: [field("Packed consumers.")],
        constraints: [],
        assumptions: [],
        openQuestions: [],
        sourceThreadId: null,
      }, intakeSha256);
      const accepted = await acceptCandidate({
        candidate,
        presentedDigest: candidate.candidateDigest,
        expectedHead: null,
        expectedAggregateVersion: 0,
        clarification: createClarificationSession(),
        operatorConfirmed: true,
      }, {
        digest: intakeSha256,
        clock: Object.freeze({ now: () => new Date(T0) }),
        store: createC7IntakeStore(adapter),
      });
      if (accepted.status === "not-recorded" || accepted.status === "outcome-unknown") throw new Error("Packed C8 acceptance failed.");
      const store = createC8C7PlanStore(adapter);
      const read = await store.readAcceptedBriefHead(value.projectId);
      if (read.kind !== "accepted") throw new Error("Packed accepted brief proof failed: " + read.kind);
      return { adapter, value, envelope, accepted: read.head, store };
    }

    function requestFor(seedValue, suffix) {
      const brief = seedValue.accepted.brief;
      const budget = { maximumInputTokens: 0, maximumOutputTokens: 0, maximumCostMicros: 0, maximumToolCalls: 0, maximumTurns: 0 };
      const proposal = {
        schemaVersion: 1,
        projectId: seedValue.value.projectId,
        briefId: brief.briefId,
        source: { kind: "deterministic", authority: "none", generatorId: "generator:packed" },
        stages: [{
          stageId: "stg:packed",
          title: brief.objective,
          intent: brief.outcomes[0],
          exitCriteria: [brief.nonGoals[0]],
          taskIds: ["tsk:packed"],
          provenance: {
            title: { origin: "brief", derivedFrom: { kind: "brief-objective", briefId: brief.briefId }, verbatim: true },
            intent: { origin: "brief", derivedFrom: { kind: "brief-outcome", briefId: brief.briefId, index: 0 }, verbatim: true },
            "exitCriteria[0]": { origin: "brief", derivedFrom: { kind: "brief-non-goal", briefId: brief.briefId, index: 0 }, verbatim: true },
          },
        }],
        tasks: [{
          taskId: "tsk:packed",
          stageId: "stg:packed",
          title: brief.objective,
          objective: brief.outcomes[0],
          requirements: { kind: "implement", complexity: 1, risk: "low", reasoning: "low" },
          acceptance: [{ criterion: brief.nonGoals[0], validationCommand: null }],
          requirementIds: [],
          provenance: {
            title: { origin: "brief", derivedFrom: { kind: "brief-objective", briefId: brief.briefId }, verbatim: true },
            objective: { origin: "brief", derivedFrom: { kind: "brief-outcome", briefId: brief.briefId, index: 0 }, verbatim: true },
            "acceptance[0].criterion": { origin: "brief", derivedFrom: { kind: "brief-non-goal", briefId: brief.briefId, index: 0 }, verbatim: true },
          },
        }],
        dependencies: [],
        budgetCeiling: budget,
        constraintDispositions: [],
      };
      const raw = {
        schemaVersion: 1,
        newPlanId: "pln:packed-" + suffix,
        proposal,
        expectedProposalDigest: "0".repeat(64),
        expectedSpecificationDigest: null,
        expectedCoverageDigest: null,
        taskBudgetAllocations: [{ taskId: "tsk:packed", budget }],
        specificationInput: null,
      };
      raw.expectedProposalDigest = computeProposalDigest(raw, planSha256);
      const assemblyRequest = parsePlanAssemblyRequest(raw);
      const result = assemblePlan(assemblyRequest, seedValue.value, seedValue.accepted, {
        planId: raw.newPlanId,
        revision: 1,
        supersedes: null,
        state: "drafting",
        createdAt: T0,
        updatedAt: T0,
        sealedAt: null,
      }, planSha256);
      const acceptedBrief = {
        projectId: seedValue.accepted.projectId,
        briefId: brief.briefId,
        briefAggregateVersion: seedValue.accepted.aggregateVersion,
        briefContentDigest: seedValue.accepted.briefContentDigest,
        acceptedCandidateDigest: seedValue.accepted.acceptedCandidateDigest,
        acceptanceEventId: seedValue.accepted.acceptanceEventId,
      };
      const controls = {
        projectAggregateVersion: seedValue.envelope.aggregateVersion,
        projectContentDigest: seedValue.envelope.checksum.hex,
        projectStatus: "active",
        projectStopSnapshotDigest: projectStopSnapshotDigestMaterial(seedValue.value.projectId, [], planSha256),
        activeProjectStopIds: [],
      };
      const binding = {
        ...acceptedBrief,
        contentDigest: "0".repeat(64),
        planId: result.plan.planId,
        planRevision: result.plan.revision,
        planDigest: result.plan.planDigest,
        proposalDigest: result.review.proposalDigest,
        expectedHeadPlanId: null,
        expectedAggregateVersion: 0,
        resultAggregateVersion: 1,
        resultState: "drafting",
        headAdvanced: true,
        stepIndex: 1,
        stepCount: 1,
        briefBlockingQuestionIds: [],
      };
      const event = {
        schemaVersion: 1,
        kind: "plan.drafted",
        operation: { kind: "draft", mode: "create" },
        plan: result.plan,
        binding,
        controls,
        review: result.review,
        decisions: [],
        rebase: null,
        predecessor: null,
        seal: null,
        budgetExtension: null,
      };
      const unbound = {
        schemaVersion: 1,
        projectId: seedValue.value.projectId,
        binding: { contentDigest: "0".repeat(64), expectedHeadPlanId: null, expectedAggregateVersion: 0 },
        acceptedBrief,
        expectedControls: controls,
        steps: [{
          eventId: "plan-event:packed-" + suffix,
          expectedState: null,
          plan: result.plan,
          envelope: { occurredAt: T0, traceId: null, causationId: null },
          event,
        }],
      };
      const contentDigest = computePlanCommitContentDigest(unbound, planSha256);
      return parsePlanCommitRequest({
        ...unbound,
        binding: { ...unbound.binding, contentDigest },
        steps: [{ ...unbound.steps[0], event: { ...event, binding: { ...binding, contentDigest } } }],
      }, planSha256);
    }

    function acceptedBindingOf(seedValue) {
      return {
        projectId: seedValue.accepted.projectId,
        briefId: seedValue.accepted.brief.briefId,
        briefAggregateVersion: seedValue.accepted.aggregateVersion,
        briefContentDigest: seedValue.accepted.briefContentDigest,
        acceptedCandidateDigest: seedValue.accepted.acceptedCandidateDigest,
        acceptanceEventId: seedValue.accepted.acceptanceEventId,
      };
    }

    function controlsOf(seedValue) {
      return {
        projectAggregateVersion: seedValue.envelope.aggregateVersion,
        projectContentDigest: seedValue.envelope.checksum.hex,
        projectStatus: "active",
        projectStopSnapshotDigest: projectStopSnapshotDigestMaterial(seedValue.value.projectId, [], planSha256),
        activeProjectStopIds: [],
      };
    }

    async function mustHead(store, projectId) {
      const read = await store.readHead(projectId);
      if (read.kind !== "head") throw new Error("Packed plan head proof failed: " + read.kind);
      return read.head;
    }

    function predecessorStamp(plan, state, updatedAt) {
      const value = state === "drafting" ? plan : parseProjectPlan({ ...plan, state, updatedAt });
      return {
        planId: value.planId,
        revision: value.revision,
        supersedes: value.supersedes,
        state,
        planDigest: value.planDigest,
        sealedAt: value.sealedAt,
        sealedByApprovalId: null,
      };
    }

    function decisionFor(plan, kind, decidedAt) {
      const material = {
        schemaVersion: 1,
        revision: 1,
        projectId: plan.projectId,
        scope: { planId: plan.planId, planRevision: plan.revision, stageId: null, taskId: null },
        kind,
        decidedBy: "operator",
        statement: "Authorize " + kind + " for the exact packed plan.",
        rationale: null,
        supersedes: null,
        subjectDigest: plan.planDigest,
        decidedAt,
      };
      return parseDecision({
        ...material,
        decisionId: "dec:" + planSha256.sha256(serializeCanonicalProjectJson(material)).slice(0, 32),
      });
    }

    function rebaseLink(previous, accepted, disposition) {
      return disposition === "draft-replaced"
        ? {
            kind: "plan.rebased",
            replaces: previous.planId,
            replacesRevision: previous.revision,
            previousDisposition: { kind: "draft-replaced", from: "drafting" },
            ...accepted,
          }
        : {
            kind: "plan.rebased",
            replaces: previous.planId,
            replacesRevision: previous.revision,
            previousDisposition: { kind: "superseded", from: previous.state, to: "superseded" },
            ...accepted,
          };
    }

    function eventFor(head, plan, kind, operation, additions = {}) {
      return {
        schemaVersion: 1,
        kind,
        operation,
        plan,
        controls: head.headEvent.payload.controls,
        review: head.headEvent.payload.review,
        decisions: [],
        rebase: null,
        predecessor: null,
        seal: null,
        budgetExtension: null,
        ...additions,
      };
    }

    function boundRequest(seedValue, accepted, expectedHead, unboundSteps) {
      let resultVersion = expectedHead === null ? 0 : expectedHead.aggregateVersion;
      const steps = unboundSteps.map((step, index) => {
        const headAdvanced = step.event.kind !== "plan.budget-extended";
        if (headAdvanced) resultVersion += 1;
        const binding = {
          ...accepted,
          contentDigest: "0".repeat(64),
          planId: step.event.plan.planId,
          planRevision: step.event.plan.revision,
          planDigest: step.event.plan.planDigest,
          proposalDigest: step.event.review.proposalDigest,
          expectedHeadPlanId: expectedHead === null ? null : expectedHead.plan.planId,
          expectedAggregateVersion: expectedHead === null ? 0 : expectedHead.aggregateVersion,
          resultAggregateVersion: resultVersion,
          resultState: step.event.plan.state,
          headAdvanced,
          stepIndex: index + 1,
          stepCount: unboundSteps.length,
          briefBlockingQuestionIds: [],
        };
        return { ...step, event: { ...step.event, binding } };
      });
      const raw = {
        schemaVersion: 1,
        projectId: seedValue.value.projectId,
        binding: {
          contentDigest: "0".repeat(64),
          expectedHeadPlanId: expectedHead === null ? null : expectedHead.plan.planId,
          expectedAggregateVersion: expectedHead === null ? 0 : expectedHead.aggregateVersion,
        },
        acceptedBrief: accepted,
        expectedControls: controlsOf(seedValue),
        steps,
      };
      const contentDigest = computePlanCommitContentDigest(raw, planSha256);
      return parsePlanCommitRequest({
        ...raw,
        binding: { ...raw.binding, contentDigest },
        steps: raw.steps.map((step) => ({
          ...step,
          event: { ...step.event, binding: { ...step.event.binding, contentDigest } },
        })),
      }, planSha256);
    }

    function assemblyFor(seedValue, suffix, coordinates) {
      const template = requestFor(seedValue, suffix).steps[0].event.review.assemblyRequest;
      return assemblePlan(template, seedValue.value, seedValue.accepted, coordinates, planSha256);
    }

    async function acceptNextBrief(adapter, seedValue) {
      const brief = seedValue.accepted.brief;
      const candidate = assembleCandidate({
        projectId: seedValue.value.projectId,
        objective: field(brief.objective),
        outcomes: brief.outcomes.map(field),
        nonGoals: brief.nonGoals.map(field),
        audiences: brief.audiences.map(field),
        constraints: [],
        assumptions: [],
        openQuestions: [],
        sourceThreadId: null,
      }, intakeSha256);
      const outcome = await acceptCandidate({
        candidate,
        presentedDigest: candidate.candidateDigest,
        expectedHead: brief,
        expectedAggregateVersion: seedValue.accepted.aggregateVersion,
        clarification: createClarificationSession(),
        operatorConfirmed: true,
      }, {
        digest: intakeSha256,
        clock: Object.freeze({ now: () => new Date(T2) }),
        store: createC7IntakeStore(adapter),
      });
      if (outcome.status === "not-recorded" || outcome.status === "outcome-unknown") {
        throw new Error("Packed later C8 acceptance failed.");
      }
      const read = await seedValue.store.readAcceptedBriefHead(seedValue.value.projectId);
      if (read.kind !== "accepted") throw new Error("Packed later accepted brief proof failed: " + read.kind);
      return { ...seedValue, accepted: read.head };
    }

    async function commitInitial(seedValue, suffix) {
      const request = requestFor(seedValue, suffix);
      const outcome = await seedValue.store.commit(request, issueSyntheticPlanCommitAuthorization(request));
      if (outcome.kind !== "committed" || outcome.aggregateVersion !== 1) throw new Error("Packed branch initial draft failed.");
      return mustHead(seedValue.store, seedValue.value.projectId);
    }

    async function commitAndObserve(seedValue, request, expectedVersion, label, decisions = []) {
      const outcome = await seedValue.store.commit(request, issueSyntheticPlanCommitAuthorization(request, [], decisions));
      if (outcome.kind !== "committed" || outcome.aggregateVersion !== expectedVersion) {
        throw new Error("Packed " + label + " direct commit failed.");
      }
      const observation = await observePlanCommit(seedValue.store, request, planSha256);
      if (observation.kind !== "committed" || observation.aggregateVersion !== expectedVersion) {
        throw new Error("Packed " + label + " observation failed.");
      }
      return mustHead(seedValue.store, seedValue.value.projectId);
    }

    async function commitAmbiguousAndObserve(seedValue, request, expectedVersion, label, decisions = []) {
      let mutationAttempts = 0;
      const uncertainAdapter = {
        ...seedValue.adapter,
        transact: async (work) => {
          mutationAttempts += 1;
          await seedValue.adapter.transact(work);
          throw new Error("synthetic packed receipt loss after commit");
        },
      };
      const uncertainStore = createC8C7PlanStore(uncertainAdapter);
      const authorization = issueSyntheticPlanCommitAuthorization(request, [], decisions);
      const outcome = await uncertainStore.commit(request, authorization);
      if (outcome.kind !== "unknown" || mutationAttempts !== 1) {
        throw new Error("Packed " + label + " did not classify the single lost-receipt attempt as unknown.");
      }
      const observation = await observePlanCommit(seedValue.store, request, planSha256);
      if (observation.kind !== "committed" || observation.aggregateVersion !== expectedVersion) {
        throw new Error("Packed " + label + " ambiguous exact observation failed.");
      }
      const replay = await uncertainStore.commit(request, authorization);
      if (replay.kind !== "refused" || mutationAttempts !== 1) {
        throw new Error("Packed " + label + " ambiguous attempt was retried.");
      }
      return mustHead(seedValue.store, seedValue.value.projectId);
    }

    async function exerciseAssemblyBranches(factory, suffix, ambiguous) {
      const commitBranch = ambiguous ? commitAmbiguousAndObserve : commitAndObserve;
      {
        const seedValue = await seed(factory(), "same-brief-" + suffix);
        const draft = await commitInitial(seedValue, "same-brief-base-" + suffix);
        const planId = "pln:packed-same-brief-redraft-" + suffix;
        const result = assemblyFor(seedValue, "same-brief-redraft-" + suffix, {
          planId,
          revision: draft.plan.revision,
          supersedes: draft.plan.supersedes,
          state: "drafting",
          createdAt: T1,
          updatedAt: T1,
          sealedAt: null,
        });
        const request = boundRequest(seedValue, acceptedBindingOf(seedValue), draft, [{
          eventId: "plan-event:packed-same-brief-redraft-" + suffix,
          expectedState: "drafting",
          plan: result.plan,
          envelope: { occurredAt: T1, traceId: null, causationId: draft.headEvent.eventId },
          event: eventFor(draft, result.plan, "plan.drafted", { kind: "draft", mode: "redraft" }, {
            review: result.review,
            predecessor: predecessorStamp(draft.plan, "drafting", T1),
            rebase: draft.headEvent.payload.rebase,
          }),
        }]);
        const head = await commitBranch(seedValue, request, 2, "same-brief redraft");
        if (head.plan.planId !== planId || head.plan.revision !== 1) throw new Error("Packed same-brief coordinates changed.");
      }

      {
        const adapter = factory();
        let seedValue = await seed(adapter, "stale-draft-" + suffix);
        const draft = await commitInitial(seedValue, "stale-draft-base-" + suffix);
        seedValue = await acceptNextBrief(adapter, seedValue);
        const accepted = acceptedBindingOf(seedValue);
        const planId = "pln:packed-stale-draft-r2-" + suffix;
        const result = assemblyFor(seedValue, "stale-draft-r2-" + suffix, {
          planId,
          revision: 1,
          supersedes: null,
          state: "drafting",
          createdAt: T2,
          updatedAt: T2,
          sealedAt: null,
        });
        const request = boundRequest(seedValue, accepted, draft, [{
          eventId: "plan-event:packed-stale-draft-r2-" + suffix,
          expectedState: "drafting",
          plan: result.plan,
          envelope: { occurredAt: T2, traceId: null, causationId: draft.headEvent.eventId },
          event: eventFor(draft, result.plan, "plan.drafted", { kind: "draft", mode: "redraft" }, {
            review: result.review,
            predecessor: predecessorStamp(draft.plan, "drafting", T2),
            rebase: rebaseLink(draft.plan, accepted, "draft-replaced"),
          }),
        }]);
        const head = await commitBranch(seedValue, request, 2, "stale-draft R2 redraft");
        if (head.plan.briefId !== seedValue.accepted.brief.briefId || head.plan.supersedes !== null) {
          throw new Error("Packed stale-draft R2 coordinates changed.");
        }
      }

      {
        const seedValue = await seed(factory(), "revision-r1-" + suffix);
        const draft = await commitInitial(seedValue, "revision-r1-base-" + suffix);
        const proposed = promoteDraft(draft.plan, T1, false)[0];
        const promote = boundRequest(seedValue, acceptedBindingOf(seedValue), draft, [{
          eventId: "plan-event:packed-r1-promote-" + suffix,
          expectedState: "drafting",
          plan: proposed,
          envelope: { occurredAt: T1, traceId: null, causationId: draft.headEvent.eventId },
          event: eventFor(draft, proposed, "plan.proposed", { kind: "promote" }),
        }]);
        const current = await commitAndObserve(seedValue, promote, 2, "R1 prerequisite promote");
        const planId = "pln:packed-revision-r1-" + suffix;
        const result = assemblyFor(seedValue, "revision-r1-" + suffix, {
          planId,
          revision: current.plan.revision + 1,
          supersedes: current.plan.planId,
          state: "drafting",
          createdAt: T2,
          updatedAt: T2,
          sealedAt: null,
        });
        const revisionDecision = decisionFor(result.plan, "plan-revision-accepted", T2);
        const superseded = parseProjectPlan({ ...current.plan, state: "superseded", updatedAt: T2 });
        const request = boundRequest(seedValue, acceptedBindingOf(seedValue), current, [{
          eventId: "plan-event:packed-revision-r1-" + suffix,
          expectedState: "proposed",
          plan: result.plan,
          envelope: { occurredAt: T2, traceId: null, causationId: current.headEvent.eventId },
          event: eventFor(current, result.plan, "plan.revised", { kind: "revise", mode: "R1" }, {
            review: result.review,
            decisions: [revisionDecision],
            predecessor: predecessorStamp(superseded, "superseded", T2),
          }),
        }]);
        let crossed = false;
        try {
          boundRequest(seedValue, acceptedBindingOf(seedValue), current, [{
            ...request.steps[0],
            event: { ...request.steps[0].event, binding: undefined, operation: { kind: "revise", mode: "R2" } },
          }]);
        } catch { crossed = true; }
        if (!crossed) throw new Error("Packed cross-mode R1/R2 substitution was accepted.");
        const head = await commitBranch(seedValue, request, 3, "revision R1", [revisionDecision]);
        if (head.plan.revision !== 2 || head.plan.supersedes !== current.plan.planId) throw new Error("Packed R1 coordinates changed.");
      }

      {
        const adapter = factory();
        let seedValue = await seed(adapter, "revision-r2-" + suffix);
        const draft = await commitInitial(seedValue, "revision-r2-base-" + suffix);
        const proposed = promoteDraft(draft.plan, T1, false)[0];
        const promote = boundRequest(seedValue, acceptedBindingOf(seedValue), draft, [{
          eventId: "plan-event:packed-r2-promote-" + suffix,
          expectedState: "drafting",
          plan: proposed,
          envelope: { occurredAt: T1, traceId: null, causationId: draft.headEvent.eventId },
          event: eventFor(draft, proposed, "plan.proposed", { kind: "promote" }),
        }]);
        const current = await commitAndObserve(seedValue, promote, 2, "R2 prerequisite promote");
        seedValue = await acceptNextBrief(adapter, seedValue);
        const accepted = acceptedBindingOf(seedValue);
        const planId = "pln:packed-revision-r2-" + suffix;
        const result = assemblyFor(seedValue, "revision-r2-" + suffix, {
          planId,
          revision: 1,
          supersedes: null,
          state: "drafting",
          createdAt: T2,
          updatedAt: T2,
          sealedAt: null,
        });
        const revisionDecision = decisionFor(result.plan, "plan-revision-accepted", T2);
        const superseded = parseProjectPlan({ ...current.plan, state: "superseded", updatedAt: T2 });
        const request = boundRequest(seedValue, accepted, current, [{
          eventId: "plan-event:packed-revision-r2-" + suffix,
          expectedState: "proposed",
          plan: result.plan,
          envelope: { occurredAt: T2, traceId: null, causationId: current.headEvent.eventId },
          event: eventFor(current, result.plan, "plan.revised", { kind: "revise", mode: "R2" }, {
            review: result.review,
            decisions: [revisionDecision],
            predecessor: predecessorStamp(superseded, "superseded", T2),
            rebase: rebaseLink(current.plan, accepted, "superseded"),
          }),
        }]);
        const head = await commitBranch(seedValue, request, 3, "revision R2", [revisionDecision]);
        if (head.plan.revision !== 1 || head.plan.supersedes !== null || head.plan.briefId !== seedValue.accepted.brief.briefId) {
          throw new Error("Packed R2 coordinates changed.");
        }
      }
    }

    async function exercise(factory, suffix) {
      const seeded = await seed(factory(), suffix);
      const request = requestFor(seeded, suffix);
      if (JSON.stringify(request).includes("authorization")) throw new Error("Authorization became serializable.");
      const before = await observePlanCommit(seeded.store, request, planSha256);
      if (before.kind !== "not-recorded" || before.aggregateVersion !== 0) throw new Error("Packed pre-write observation failed.");
      const authorization = issueSyntheticPlanCommitAuthorization(request);
      const outcome = await seeded.store.commit(request, authorization);
      if (outcome.kind !== "committed" || outcome.aggregateVersion !== 1 || outcome.evidence !== "receipt") throw new Error("Packed first write failed.");
      const after = await observePlanCommit(seeded.store, request, planSha256);
      if (after.kind !== "committed" || after.evidence !== "head-observation") throw new Error("Packed observation failed.");
      const replay = await seeded.store.commit(request, authorization);
      if (replay.kind !== "refused" || replay.code !== "PLAN_AUTHORITY_VIOLATION") throw new Error("Packed one-shot replay was not refused.");
      const raw = await seeded.store.commit(request, {});
      if (raw.kind !== "refused" || raw.code !== "PLAN_AUTHORITY_VIOLATION") throw new Error("Packed raw authorization was not refused.");
    }

    async function exerciseAmbiguousFirstDraft(factory, suffix) {
      const seeded = await seed(factory(), "ambiguous-first-" + suffix);
      const request = requestFor(seeded, "ambiguous-first-" + suffix);
      const head = await commitAmbiguousAndObserve(seeded, request, 1, "first draft");
      if (head.plan.state !== "drafting" || head.plan.revision !== 1 || head.plan.supersedes !== null) {
        throw new Error("Packed ambiguous first-draft coordinates changed.");
      }
    }

    async function exerciseRollback(factory, suffix) {
      const adapter = factory();
      const seeded = await seed(adapter, "rollback-" + suffix);
      const request = requestFor(seeded, "rollback-" + suffix);
      let appendCalls = 0;
      const faulty = {
        ...adapter,
        transact: (work) => adapter.transact((tx) => work({
          ...tx,
          events: {
            ...tx.events,
            append: async () => {
              appendCalls += 1;
              throw new Error("synthetic packed append fault");
            },
          },
        })),
      };
      const store = createC8C7PlanStore(faulty);
      const authorization = issueSyntheticPlanCommitAuthorization(request);
      const outcome = await store.commit(request, authorization);
      if (outcome.kind !== "unknown" || appendCalls !== 1) throw new Error("Packed ambiguous-write classification failed.");
      const durable = createC8C7PlanStore(adapter);
      const observation = await observePlanCommit(durable, request, planSha256);
      if (observation.kind !== "not-recorded" || observation.aggregateVersion !== 0) throw new Error("Packed aggregate-before-event rollback failed.");
      const replay = await store.commit(request, authorization);
      if (replay.kind !== "refused" || appendCalls !== 1) throw new Error("Packed ambiguous write was retried.");
    }

    if (PLAN_PRODUCTION_ENABLED !== false || PLAN_AVAILABLE_COMMANDS.length !== 0 || PLAN_RUNTIME_CAPABILITIES.length !== 0) {
      throw new Error("Packed production-disabled contract changed.");
    }
    await exercise(() => createMemoryPersistenceAdapter(), "memory");
    await exercise(() => createSqlitePersistenceAdapter({ memory: true }), "sqlite");
    await exerciseRollback(() => createMemoryPersistenceAdapter(), "memory");
    await exerciseRollback(() => createSqlitePersistenceAdapter({ memory: true }), "sqlite");
    await exerciseAmbiguousFirstDraft(() => createMemoryPersistenceAdapter(), "memory");
    await exerciseAmbiguousFirstDraft(() => createSqlitePersistenceAdapter({ memory: true }), "sqlite");
    await exerciseAssemblyBranches(() => createMemoryPersistenceAdapter(), "memory-direct", false);
    await exerciseAssemblyBranches(() => createSqlitePersistenceAdapter({ memory: true }), "sqlite-direct", false);
    await exerciseAssemblyBranches(() => createMemoryPersistenceAdapter(), "memory-ambiguous", true);
    await exerciseAssemblyBranches(() => createSqlitePersistenceAdapter({ memory: true }), "sqlite-ambiguous", true);
  `);

  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumerRoot);
  const installedPlanRoot = join(consumerRoot, "node_modules", "@ai-dev-os", "plan");
  const packedMainFiles = packedMainGraph(installedPlanRoot);
  const packedMainSource = packedMainFiles.map((file) => readFileSync(file, "utf8")).join("\n");
  if (packedMainFiles.some((file) => file.replaceAll("\\", "/").includes("/dist/testing/"))) {
    throw new Error("The packed main export graph reached the isolated testing export.");
  }
  if (containsWrongAggregate(packedMainSource) || !containsWrongAggregate('const aggregateType = "product-plan";')) {
    throw new Error("The packed main export graph contains the forbidden product-plan aggregate literal.");
  }
  const nativeBinding = join(consumerRoot, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  if (existsSync(nativeBinding)) throw new Error("Lifecycle scripts ran despite the scripts-disabled install.");
  npm(["rebuild", "better-sqlite3", "--foreground-scripts", "--ignore-scripts=false", "--no-audit", "--no-fund"], consumerRoot);
  if (!existsSync(nativeBinding)) throw new Error("The explicit better-sqlite3 rebuild produced no native binding.");
  npm(["ls", "--all"], consumerRoot);
  const lock = readFileSync(join(consumerRoot, "package-lock.json"), "utf8");
  if (/"link"\s*:\s*true/u.test(lock) || /workspace:/u.test(lock)) {
    throw new Error("The packed consumer dependency graph contains a workspace link.");
  }
  const probe = spawnSync(process.execPath, [join(consumerRoot, "probe.mjs")], {
    cwd: consumerRoot,
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (probe.status !== 0) {
    throw new Error(`Packed plan probe exited ${String(probe.status)}: ${String(probe.stderr).slice(-4_000)}`);
  }
  process.stdout.write(`PLAN-PACKED-CONSUMER: PASS\npackages=${String(packages.length)}\nfiles=${String(totalFiles)}\nadapters=memory,sqlite\n`);
} finally {
  const resolved = resolve(workRoot);
  const expectedPrefix = resolve(tmpdir(), "ai-dev-os-plan-packed-consumer-");
  if (!resolved.startsWith(expectedPrefix)) throw new Error("Refusing to clean an unowned plan consumer root.");
  rmSync(resolved, { recursive: true, force: true });
}
