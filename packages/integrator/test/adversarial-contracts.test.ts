import { describe, expect, it } from "vitest";
import {
  INTEGRATION_SCHEMA_VERSION,
  IntegrationError,
  assertIntegrationInputBudget,
  authorizeIntegrationRequest,
  compareIntegrationText,
  createIntegrationAuthorityConfiguration,
  createIntegrationRequest,
  integrationDigest,
  isIntegrationError,
  parseIntegrationCleanupResult,
  parseIntegrationConflict,
  parseIntegrationEffectIntent,
  parseIntegrationLease,
  parseIntegrationPreflightResult,
  parseIntegrationRequest,
  parseIntegrationReceipt,
  parseIntegrationRecoveryState,
  parseIntegrationTerminalResult,
  parseIntegrationValidationResult,
  stableIntegrationId,
} from "../src/index.js";
import {
  DIGEST_A,
  SHA_A,
  T0,
  T1,
  T2,
  authorityFor,
  fakePorts,
  preflightResult,
  requestInput,
  validationResult,
} from "./fixtures.js";

function revise(request: ReturnType<typeof requestInput>, changes: Readonly<Record<string, unknown>>) {
  const projection = { ...request, ...changes } as Record<string, unknown>;
  delete projection["requestDigest"];
  return Object.freeze({ ...projection, requestDigest: integrationDigest(projection) });
}

function exactResolutionRequest() {
  const initial = requestInput();
  const request = requestInput({
    strategy: "merge",
    repository: Object.freeze({
      ...initial.repository,
      expectedIntegratedCommit: "f".repeat(40),
      expectedParents: Object.freeze([initial.repository.expectedTargetCommit, initial.repository.sourceCommit]),
      mergeCommitTimestamp: T2,
    }),
  });
  const proposalBase = {
    proposalId: "proposal:reviewed",
    authority: "none" as const,
    conflictIds: ["conflict:reviewed"],
    patchArtifactDigest: "a".repeat(64),
    resultingTree: request.repository.expectedIntegratedTree,
    allowedPaths: [...request.allowedPaths],
    validationPlanDigest: request.validationPlan.planDigest,
  };
  const proposal = Object.freeze({ ...proposalBase, proposalDigest: integrationDigest(proposalBase) });
  const authorizationBase = {
    proposalDigest: proposal.proposalDigest,
    authorityDigest: request.authorityDigest,
    approvalReference: "approval:reviewed",
    approvedAt: T0,
  };
  const authorization = Object.freeze({ ...authorizationBase, authorizationDigest: integrationDigest(authorizationBase) });
  return { request: createIntegrationRequest(revise(request, { resolutionProposal: proposal, resolutionAuthorization: authorization })), authorization };
}

describe("integration adversarial contract boundaries", () => {
  it("accepts only exact reviewed resolution authority and rejects substitutions", () => {
    const { request, authorization } = exactResolutionRequest();
    const authorityBase = authorityFor(request);
    const projection = {
      ...authorityBase,
      authorizedResolutionDigests: [authorization.authorizationDigest],
    } as Record<string, unknown>;
    delete projection["configurationFingerprint"];
    const authority = createIntegrationAuthorityConfiguration({ ...projection, configurationFingerprint: integrationDigest(projection) });
    expect(() => authorizeIntegrationRequest(request, authority)).not.toThrow();
    const substitutedRequest = createIntegrationRequest(revise(request, { runId: "integration:substituted", idempotencyKey: "request:substituted" }));
    expect(() => authorizeIntegrationRequest(substitutedRequest, authority)).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(() => authorizeIntegrationRequest(request, authorityFor(request))).toThrow(IntegrationError);
    expect(() => createIntegrationRequest(revise(request, {
      resolutionAuthorization: { ...request.resolutionAuthorization!, proposalDigest: "f".repeat(64) },
    }))).toThrow(IntegrationError);
    expect(() => createIntegrationRequest(revise(request, {
      resolutionProposal: { ...request.resolutionProposal!, proposalDigest: "0".repeat(64) },
    }))).toThrow(IntegrationError);
    const substitutedAuthorizationProjection = {
      ...request.resolutionAuthorization!,
      authorityDigest: "f".repeat(64),
    } as Record<string, unknown>;
    delete substitutedAuthorizationProjection["authorizationDigest"];
    const substitutedAuthorization = {
      ...substitutedAuthorizationProjection,
      authorizationDigest: integrationDigest(substitutedAuthorizationProjection),
    };
    expect(() => createIntegrationRequest(revise(request, { resolutionAuthorization: substitutedAuthorization })))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    const changedAdmissionProjection = { ...request.admission, waiverDigests: ["0".repeat(64)] } as Record<string, unknown>;
    delete changedAdmissionProjection["admissionDigest"];
    const changedAdmission = { ...changedAdmissionProjection, admissionDigest: integrationDigest(changedAdmissionProjection) };
    const changedRequest = createIntegrationRequest(revise(request, { admission: changedAdmission }));
    expect(() => authorizeIntegrationRequest(changedRequest, authority)).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    const changedArtifactProjection = { ...request.candidateArtifact, artifactDigest: "2".repeat(64) } as Record<string, unknown>;
    delete changedArtifactProjection["bindingDigest"];
    const changedArtifact = { ...changedArtifactProjection, bindingDigest: integrationDigest(changedArtifactProjection) };
    const artifactSubstitution = createIntegrationRequest(revise(request, { candidateArtifact: changedArtifact }));
    expect(() => authorizeIntegrationRequest(artifactSubstitution, authority)).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  it("enforces cumulative structural, text, plain-data, dense-property, and alias bounds before parsing", () => {
    expect(() => assertIntegrationInputBudget("x".repeat(2_000_001))).toThrow(IntegrationError);
    expect(() => assertIntegrationInputBudget(new Array(75_001).fill(null))).toThrow(IntegrationError);
    let deep: unknown = null;
    for (let index = 0; index < 34; index += 1) deep = { value: deep };
    expect(() => assertIntegrationInputBudget(deep)).toThrow(IntegrationError);
    expect(() => assertIntegrationInputBudget(Number.NaN)).toThrow(IntegrationError);
    expect(() => assertIntegrationInputBudget(Symbol("not-data"))).toThrow(IntegrationError);
    expect(() => assertIntegrationInputBudget(new Date())).toThrow(IntegrationError);
    const shared = {};
    expect(() => assertIntegrationInputBudget([shared, shared])).toThrow(IntegrationError);
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    expect(() => assertIntegrationInputBudget(cyclic)).toThrow(IntegrationError);
    const symbolic = { ok: true }; Object.defineProperty(symbolic, Symbol("secret"), { value: true, enumerable: true });
    expect(() => assertIntegrationInputBudget(symbolic)).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    const oversized = Object.fromEntries(Array.from({ length: 75_001 }, (_, index) => [`k${index}`, null]));
    expect(() => assertIntegrationInputBudget(oversized)).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    const hidden = {}; Object.defineProperty(hidden, "secret", { value: true, enumerable: false });
    expect(() => assertIntegrationInputBudget(hidden)).toThrow(IntegrationError);
    const throwingProxy = new Proxy(requestInput(), { ownKeys() { throw new Error("SECRET_PROXY_TRAP"); } });
    expect(() => parseIntegrationRequest(throwingProxy)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const revoked = Proxy.revocable(requestInput(), {}); revoked.revoke();
    expect(() => parseIntegrationRequest(revoked.proxy)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    let inspectionCount = 0;
    const statefulProxy = new Proxy(requestInput(), {
      getOwnPropertyDescriptor(target, property) {
        inspectionCount += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(() => parseIntegrationRequest(statefulProxy)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(inspectionCount).toBe(0);
  });

  it("rejects every request-level parent, revision, ordering, literal, digest, deadline, and bound contradiction", () => {
    const request = requestInput();
    const emptyAdmissionProjection = { ...request.admission, requirementIds: [] } as Record<string, unknown>;
    delete emptyAdmissionProjection["admissionDigest"];
    const emptyPlanProjection = { ...request.validationPlan, commandIds: [], requiredCriterionIds: [] } as Record<string, unknown>;
    delete emptyPlanProjection["planDigest"];
    const cases: unknown[] = [
      revise(request, { allowedPaths: ["z.ts", "a.ts"] }),
      revise(request, { allowedPaths: ["a.ts", "a.ts"] }),
      revise(request, { deadline: T0 }),
      revise(request, { repository: { ...request.repository, expectedTargetCommit: "a".repeat(64) } }),
      revise(request, { repository: { ...request.repository, expectedParents: [SHA_A] } }),
      revise(request, { repository: { ...request.repository, expectedIntegratedTree: SHA_A } }),
      revise(request, { repository: { ...request.repository, expectedIntegratedCommit: SHA_A } }),
      revise(request, { repository: { ...request.repository, targetRef: "refs/heads/Main" } }),
      revise(request, { candidateArtifact: { ...request.candidateArtifact, bindingDigest: "0".repeat(64) } }),
      revise(request, { validationPlan: { ...request.validationPlan, allowSkips: true } }),
      revise(request, { retryPolicy: { ...request.retryPolicy, automaticRetryBeforeEffectOnly: false } }),
      revise(request, { bounds: { ...request.bounds, maximumWorktrees: 2 } }),
      revise(request, { admission: { ...request.admission, admissionDigest: "0".repeat(64) } }),
      revise(request, { validationPlan: { ...request.validationPlan, planDigest: "0".repeat(64) } }),
      revise(request, { admission: { ...emptyAdmissionProjection, admissionDigest: integrationDigest(emptyAdmissionProjection) } }),
      revise(request, { validationPlan: { ...emptyPlanProjection, planDigest: integrationDigest(emptyPlanProjection) } }),
      revise(request, { completionNarrative: "model-says-complete" }),
    ];
    for (const candidate of cases) expect(() => createIntegrationRequest(candidate)).toThrow();
    expect(() => createIntegrationRequest(revise(request, { retryPolicy: { ...request.retryPolicy, retryableFailureCodes: ["conflict"] } })))
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => createIntegrationRequest(revise(request, {
      repository: {
        ...request.repository,
        sourceCommit: request.repository.expectedTargetCommit,
        expectedIntegratedCommit: request.repository.expectedTargetCommit,
      },
    })))
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const paired = exactResolutionRequest().request;
    expect(() => createIntegrationRequest(revise(paired, { resolutionAuthorization: null })))
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(compareIntegrationText("a", "b")).toBe(-1);
    expect(compareIntegrationText("b", "a")).toBe(1);
    expect(compareIntegrationText("a", "a")).toBe(0);
  });

  it("round-trips every evidence parser and rejects contradictory projections", async () => {
    const request = requestInput();
    const preflight = preflightResult(request);
    expect(parseIntegrationPreflightResult(preflight)).toEqual(preflight);
    expect(() => parseIntegrationPreflightResult({ ...preflight, preflightDigest: "0".repeat(64) })).toThrow(IntegrationError);
    const validation = validationResult({ phase: "pre-integration", request, headCommit: request.repository.sourceCommit, treeId: request.repository.expectedIntegratedTree, plan: request.validationPlan });
    expect(parseIntegrationValidationResult(validation)).toEqual(validation);
    expect(() => parseIntegrationValidationResult({ ...validation, passed: true, failedRuleCodes: ["failed"] })).toThrow(IntegrationError);
    const intentBase = {
      intentId: "intent:1",
      requestDigest: request.requestDigest,
      preflightDigest: preflight.preflightDigest,
      validationResultDigest: validation.resultDigest,
      resolutionAuthorizationDigest: null,
      leaseId: "lease:1",
      fencingToken: 1,
      createdAt: T1,
    };
    const intent = { ...intentBase, intentDigest: integrationDigest(intentBase) };
    expect(parseIntegrationEffectIntent(intent)).toEqual(intent);
    expect(() => parseIntegrationEffectIntent({ ...intent, intentDigest: DIGEST_A })).toThrow(IntegrationError);
    const receipt = await fakePorts(request).git.integrate(intent, request, new AbortController().signal);
    expect(parseIntegrationReceipt(receipt)).toEqual(receipt);
    expect(() => parseIntegrationReceipt({ ...receipt, refUpdated: false })).toThrow();
    const recoveryBase = { state: "ref-published", effectGuardState: "absent", intentDigest: intent.intentDigest, observedTargetCommit: receipt.integratedCommit, observedTargetTree: receipt.integratedTree, receipt, observedAt: T1 };
    const recovery = { ...recoveryBase, recoveryDigest: integrationDigest(recoveryBase) };
    expect(parseIntegrationRecoveryState(recovery)).toEqual(recovery);
    expect(() => parseIntegrationRecoveryState({ ...recovery, state: "no-effect" })).toThrow(IntegrationError);
    const cleanup = { worktreeId: receipt.worktreeId, cleaned: true, preservedEvidence: true, failureCode: null, observedAt: T1 };
    expect(parseIntegrationCleanupResult(cleanup)).toEqual(cleanup);
    expect(() => parseIntegrationCleanupResult({ ...cleanup, failureCode: "failed" })).toThrow(IntegrationError);
    const terminalBase = { outcome: "completed", receiptDigest: receipt.receiptDigest, validationResultDigest: validation.resultDigest, failureCode: null, cleanup, completedAt: T1 };
    const terminal = { ...terminalBase, terminalDigest: integrationDigest(terminalBase) };
    expect(parseIntegrationTerminalResult(terminal)).toEqual(terminal);
    expect(() => parseIntegrationTerminalResult({ ...terminal, failureCode: "false-success" })).toThrow(IntegrationError);
  });

  it("validates leases, conflicts, stable IDs, and finite error serialization", () => {
    const lease = { leaseId: "lease:1", owner: "worker:1", fencingToken: 1, acquiredAt: T0, expiresAt: T1 };
    expect(parseIntegrationLease(lease)).toEqual(lease);
    expect(() => parseIntegrationLease({ ...lease, expiresAt: T0 })).toThrow(IntegrationError);
    const conflict = { conflictId: "conflict:1", kind: "semantic", path: "src/a.ts", ruleCode: "semantic-break", blocking: true };
    expect(parseIntegrationConflict(conflict, "conflict")).toEqual(conflict);
    expect(stableIntegrationId("x", "a\u001fb", "c")).not.toBe(stableIntegrationId("x", "a", "b\u001fc"));
    const error = new IntegrationError("CONFLICT", "Finite conflict.", { count: 1 });
    expect(error.toJSON()).toEqual({ name: "IntegrationError", code: "CONFLICT", message: "Finite conflict.", details: { count: 1 } });
    expect(isIntegrationError(error)).toBe(true);
    expect(isIntegrationError(error, "CONFLICT")).toBe(true);
    expect(isIntegrationError(error, "INVALID_INPUT")).toBe(false);
    expect(isIntegrationError(new Error("no"))).toBe(false);
  });
});
