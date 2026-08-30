import { PersistenceError, type PersistenceAdapter } from "@ai-dev-os/persistence";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { ProjectContractError } from "@ai-dev-os/project";
import { describe, expect, it } from "vitest";
import {
  IntakeError,
  applyClarificationsToCandidate,
  assembleCandidate,
  candidateDigestMaterial,
  collectRepositoryInspection,
  createC7IntakeStore,
  createClarificationSession,
  exactIntakeKeys,
  intakeArray,
  intakeRecord,
  intakeSha256,
  intakeStateView,
  isIntakeDiagnosticRoot,
  mapProjectRefusal,
  openClarificationRound,
  parseIntakeJsonText,
  prepareCandidateAcceptance,
  projectBriefHistoryView,
  projectBriefView,
  resolveClarificationRound,
  serializeIntakeProjection,
  validateDigest,
  validateSafeInteger,
  verifyCandidate,
  type IntakeFileObservation,
  type IntakeFilesystemPort,
  type IntakeGitPort,
  type IntakeMonotonicClock,
  type PreparedAcceptance,
  type RepositoryInspectionRequest,
} from "../src/index.js";
import { materializeCandidateBrief } from "../src/candidate.js";
import { validateIntakeText } from "../src/text.js";
import { candidate, constraint, draft, field, fixedClock, provenance, question } from "./fixtures.js";

function prepared(): PreparedAcceptance {
  const value = candidate();
  return prepareCandidateAcceptance({
    candidate: value,
    presentedDigest: value.candidateDigest,
    expectedHead: null,
    expectedAggregateVersion: 0,
    clarification: createClarificationSession(),
    operatorConfirmed: true,
  }, { digest: intakeSha256, clock: fixedClock });
}

describe("bounded hostile-input edge contracts", () => {
  it("covers primitive text, digest, integer, and Unicode boundary refusals", () => {
    expect(validateIntakeText("safe😀", "text")).toBe("safe😀");
    expect(() => validateIntakeText("\uDC00", "text")).toThrowError(expect.objectContaining({ code: "intake.text.malformed-unicode" }));
    expect(() => validateIntakeText(1, "text")).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => validateIntakeText("", "text")).toThrowError(expect.objectContaining({ code: "intake.text.too-long" }));
    expect(validateIntakeText("", "text", { allowEmpty: true })).toBe("");
    expect(validateDigest("a".repeat(64), "input")).toBe("a".repeat(64));
    expect(() => validateDigest("A".repeat(64), "input")).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(validateSafeInteger(2, "input", 1, 3)).toBe(2);
    for (const value of [0, 4, 1.5, Number.NaN]) {
      expect(() => validateSafeInteger(value, "input", 1, 3)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    }
  });

  it("refuses exotic records, symbols, hidden fields, wrong keys, and reflection failures", () => {
    for (const value of [null, [], new Date(0)]) {
      expect(() => intakeRecord(value, "input")).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    }
    const symbolRecord = { safe: true } as Record<PropertyKey, unknown>;
    symbolRecord[Symbol("hidden")] = true;
    expect(() => intakeRecord(symbolRecord, "input")).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    const hidden = {};
    Object.defineProperty(hidden, "safe", { value: true, enumerable: false });
    expect(() => intakeRecord(hidden, "input")).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => intakeRecord(new Proxy({}, { getPrototypeOf: () => { throw new Error("hostile"); } }), "input"))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => exactIntakeKeys({ value: 1 }, ["other"], "input")).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    const protoKey = Object.create(null) as Record<string, unknown>;
    protoKey["constructor"] = "x";
    expect(() => exactIntakeKeys(protoKey, ["constructor"], "input")).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
  });

  it("refuses exotic, oversized, sparse, symbolic, and reflection-hostile arrays", () => {
    expect(() => intakeArray("not-array", "input", (item) => item)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    const altered: unknown[] = [];
    Object.setPrototypeOf(altered, null);
    expect(() => intakeArray(altered, "input", (item) => item)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => intakeArray([1, 2], "input", (item) => item, 1)).toThrowError(expect.objectContaining({ code: "intake.collection.too-large" }));
    const symbolic = [1] as Array<unknown> & Record<PropertyKey, unknown>;
    symbolic[Symbol("extra")] = true;
    expect(() => intakeArray(symbolic, "input", (item) => item)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    const sparse = new Array(2);
    expect(() => intakeArray(sparse, "input", (item) => item)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    const proxied = new Proxy([], { getOwnPropertyDescriptor: () => { throw new Error("hostile"); } });
    expect(() => intakeArray(proxied, "input", (item) => item)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
  });

  it("maps project and non-project failures without reflecting their payload", () => {
    const intake = new IntakeError("intake.input.invalid", "input");
    expect(() => mapProjectRefusal(intake, "candidate")).toThrow(intake);
    expect(() => mapProjectRefusal(new ProjectContractError("INVARIANT_VIOLATION", "projectBrief.secret", "safe"), "brief"))
      .toThrowError(expect.objectContaining({ code: "intake.project.refused", details: { projectCode: "INVARIANT_VIOLATION", projectPath: "projectBrief", limit: null } }));
    expect(() => mapProjectRefusal(new Error("raw secret"), "brief")).toThrowError(expect.objectContaining({ code: "intake.project.refused" }));
  });

  it("scans nested JSON arrays/objects and rejects malformed or non-text JSON", () => {
    expect(parseIntakeJsonText('{"a":{},"b":[],"c":[1,"x",{"d":true}]}')).toEqual({ a: {}, b: [], c: [1, "x", { d: true }] });
    for (const value of [null, "", "{", '[1,2,]']) {
      expect(() => parseIntakeJsonText(value)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    }
    expect(isIntakeDiagnosticRoot("candidate")).toBe(true);
    expect(isIntakeDiagnosticRoot("caller-secret")).toBe(false);
    expect(isIntakeDiagnosticRoot(1)).toBe(false);
  });

  it("refuses invalid provenance, assumption, constraint, question, and objective shapes", () => {
    expect(() => assembleCandidate({ ...draft(), objective: { value: "Objective", provenance: { source: "unknown", acceptedByOperator: true } } } as never, intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => assembleCandidate({ ...draft(), objective: { value: "Objective", provenance: { source: "operator-supplied", acceptedByOperator: "yes" } } } as never, intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => assembleCandidate({ ...draft(), objective: field("Objective", "model-proposed", false) }, intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => assembleCandidate({ ...draft(), sourceThreadId: 3 } as never, intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => assembleCandidate({ ...draft(), constraints: [{ value: constraint(), provenance: provenance(), possible: "yes" }] } as never, intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => assembleCandidate({ ...draft(), constraints: [{
      value: constraint({ origin: "repository", authority: "none" }),
      provenance: provenance("operator-supplied", true),
      possible: true,
    }] } as never, intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => assembleCandidate({ ...draft(), assumptions: [{ text: "Assume one", source: "other", confirmed: false, provenance: provenance() }] } as never, intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => assembleCandidate({ ...draft(), assumptions: [{ text: "Assume one", source: "operator", confirmed: "yes", provenance: provenance() }] } as never, intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => assembleCandidate({ ...draft(), assumptions: [{ text: "Assume one", source: "repository", confirmed: false, provenance: provenance() }] } as never, intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => assembleCandidate({ ...draft(), assumptions: [{ text: "Assume one", source: "model", confirmed: false, provenance: provenance() }] } as never, intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => assembleCandidate({ ...draft(), openQuestions: [{ ...question("q:bad"), source: "unknown" }] } as never, intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => assembleCandidate({ ...draft(), openQuestions: [{ ...question("q:bad"), question: null }] } as never, intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.project.refused" }));
  });

  it("accepts repository/model provenance and recursively validates machine-form arrays", () => {
    const value = assembleCandidate({
      ...draft(),
      constraints: [{
        value: constraint({ machineForm: { nested: ["safe", { enabled: true }] } }),
        provenance: provenance(),
        possible: true,
      }, {
        value: constraint({
          constraintId: "constraint:repo",
          enforcement: "advisory",
          machineForm: null,
          origin: "repository",
          authority: "none",
        }),
        provenance: provenance("approved-observation", false),
        possible: true,
      }, {
        value: constraint({
          constraintId: "constraint:model",
          enforcement: "advisory",
          machineForm: null,
          origin: "model",
          authority: "none",
        }),
        provenance: provenance("model-proposed", false),
        possible: true,
      }],
      assumptions: [
        { text: "Observed package manager", source: "repository", confirmed: true, provenance: provenance("approved-observation", true) },
        { text: "Suggested audience", source: "model", confirmed: false, provenance: provenance("model-proposed", false) },
      ],
      openQuestions: [question("q:open")],
    }, intakeSha256);
    expect(value.constraints).toHaveLength(3);
    expect(value.assumptions).toHaveLength(2);
    expect(materializeCandidateBrief(value, { briefId: "brf:rich", supersedes: null, createdAt: "2026-08-30T12:00:00.000Z" }).assumptions).toHaveLength(2);
  });

  it("covers candidate canonicalization and materialization failure paths", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => candidateDigestMaterial({ ...draft(), objective: circular } as never)).toThrowError(
      expect.objectContaining({ code: "intake.project.refused" }),
    );
    expect(() => verifyCandidate(candidate(), { sha256: () => { throw new Error("digest unavailable"); } })).toThrowError(
      expect.objectContaining({ code: "intake.input.invalid" }),
    );
    const notReady = candidate({ outcomes: [] });
    expect(() => materializeCandidateBrief(notReady, { briefId: "brf:none", supersedes: null, createdAt: "2026-08-30T12:00:00.000Z" }))
      .toThrowError(expect.objectContaining({ code: "intake.candidate.not-ready" }));
    const forged = { ...candidate(), projectId: "wrong", ready: true } as never;
    expect(() => materializeCandidateBrief(forged, { briefId: "brf:bad", supersedes: null, createdAt: "2026-08-30T12:00:00.000Z" }))
      .toThrowError(expect.objectContaining({ code: "intake.project.refused" }));
  });

  it("refuses malformed clarification sessions, facts, rounds, and resolutions", () => {
    expect(() => openClarificationRound({
      session: createClarificationSession(), questions: [question("q:one")], knownFacts: [{ source: "operator", text: "fact" }] as never, materialChangeReason: null,
    }, intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => openClarificationRound({
      session: { rounds: null } as never, questions: [], knownFacts: [], materialChangeReason: null,
    }, intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => openClarificationRound({
      session: { rounds: [{ ordinal: 2 }] } as never, questions: [], knownFacts: [], materialChangeReason: null,
    }, intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => openClarificationRound({
      session: createClarificationSession(), questions: [question("q:one")], knownFacts: [], materialChangeReason: "not allowed in round one",
    }, intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => openClarificationRound({
      session: createClarificationSession(),
      questions: [question("q:same", { question: "First?" }), question("q:same", { question: "Second?" })],
      knownFacts: [], materialChangeReason: null,
    }, intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));

    const session = openClarificationRound({ session: createClarificationSession(), questions: [question("q:one")], knownFacts: [], materialChangeReason: null }, intakeSha256);
    expect(() => resolveClarificationRound(session, 2, [], intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => resolveClarificationRound(session, 1, [{ questionId: "q:one", kind: "invalid", value: "Library" }] as never, intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => resolveClarificationRound(session, 1, [
      { questionId: "q:one", kind: "answered", value: "Library" },
      { questionId: "q:one", kind: "answered", value: "Library" },
    ], intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => resolveClarificationRound(session, 1, [{ questionId: "q:missing", kind: "answered", value: "Library" }], intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => resolveClarificationRound(session, 1, [{ questionId: "q:one", kind: "default-confirmed", value: "Library" }], intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
  });

  it("refuses duplicated resolution identity when applying forged round data", () => {
    const q = question("q:one");
    const base = openClarificationRound({ session: createClarificationSession(), questions: [q], knownFacts: [], materialChangeReason: null }, intakeSha256);
    const forged = { rounds: [{ ...base.rounds[0], resolutions: [
      { questionId: "q:one", kind: "answered", value: "Library" },
      { questionId: "q:one", kind: "answered", value: "Library" },
    ] }] } as never;
    expect(() => applyClarificationsToCandidate(candidate({ openQuestions: [q] }), forged, intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
  });
});

describe("inspection and projection edge branches", () => {
  const baseRequest: RepositoryInspectionRequest = {
    approvedRoot: "/work/repo",
    pathFlavor: "posix",
    relativePaths: ["pyproject.toml", "Cargo.toml", "solution.sln", "pnpm-lock.yaml"],
    maximumFiles: 8,
    maximumBytes: 10_000,
    deadlineMs: 100,
    includeGit: false,
  };
  const clock = (values: number[] = [0]): IntakeMonotonicClock => {
    let index = 0;
    return { nowMs: () => values[Math.min(index++, values.length - 1)] ?? 0 };
  };
  const observations = (values: Partial<IntakeFileObservation>[] = []): IntakeFilesystemPort => ({
    inspect: async ({ relativePaths }) => relativePaths.map((relativePath, index) => ({
      relativePath,
      canonicalPath: `/work/repo/${relativePath}`,
      kind: "file",
      byteLength: 10,
      reparsePoint: false,
      failureCode: null,
      ...(values[index] ?? {}),
    })),
  });
  const noGit: IntakeGitPort = { run: async () => ({ kind: "status", status: "ok", value: "", failureCode: null }) };

  it("classifies additional ecosystems and lockfiles", async () => {
    const report = await collectRepositoryInspection(baseRequest, { filesystem: observations(), git: noGit, clock: clock() });
    expect(report.facts).toEqual(expect.arrayContaining([
      { kind: "ecosystem", value: "Python" },
      { kind: "ecosystem", value: "Rust" },
      { kind: "ecosystem", value: ".NET" },
      { kind: "package-manager", value: "pnpm" },
    ]));
    const yarn = await collectRepositoryInspection({ ...baseRequest, relativePaths: ["yarn.lock"] }, { filesystem: observations(), git: noGit, clock: clock() });
    expect(yarn.facts).toContainEqual({ kind: "package-manager", value: "Yarn" });
  });

  it("refuses invalid inspection requests and observation arrays", async () => {
    const cases: Array<Promise<unknown>> = [
      collectRepositoryInspection({ ...baseRequest, pathFlavor: "other" as never }, { filesystem: observations(), git: noGit, clock: clock() }),
      collectRepositoryInspection({ ...baseRequest, includeGit: "yes" as never }, { filesystem: observations(), git: noGit, clock: clock() }),
      collectRepositoryInspection({ ...baseRequest, relativePaths: ["same", "same"] }, { filesystem: observations(), git: noGit, clock: clock() }),
      collectRepositoryInspection(baseRequest, { filesystem: observations(), git: noGit, clock: { nowMs: () => Number.NaN } }),
      collectRepositoryInspection(baseRequest, { filesystem: { inspect: async () => "bad" as never }, git: noGit, clock: clock() }),
      collectRepositoryInspection(baseRequest, { filesystem: observations([{ relativePath: "unknown" }]), git: noGit, clock: clock() }),
      collectRepositoryInspection(baseRequest, { filesystem: observations([{ kind: "other" as never }]), git: noGit, clock: clock() }),
      collectRepositoryInspection(baseRequest, { filesystem: observations([{ canonicalPath: null, kind: "file" }]), git: noGit, clock: clock() }),
    ];
    for (const promise of cases) await expect(promise).rejects.toBeInstanceOf(IntakeError);
  });

  it("marks omitted observations and Git deadline/throws as partial", async () => {
    const incomplete: IntakeFilesystemPort = { inspect: async () => [] };
    const unavailable = await collectRepositoryInspection(baseRequest, { filesystem: incomplete, git: noGit, clock: clock() });
    expect(unavailable).toMatchObject({ state: "unavailable", unavailable: [{ source: "filesystem", code: "incomplete" }] });

    const gitRequest = { ...baseRequest, relativePaths: ["pyproject.toml"], includeGit: true };
    const deadline = await collectRepositoryInspection(gitRequest, { filesystem: observations(), git: noGit, clock: clock([0, 0, 101]) });
    expect(deadline.unavailable).toContainEqual({ source: "git", code: "deadline" });
    const throwing: IntakeGitPort = { run: async () => { throw new Error("raw path"); } };
    const thrown = await collectRepositoryInspection(gitRequest, { filesystem: observations(), git: throwing, clock: clock() });
    expect(thrown.unavailable).toContainEqual({ source: "git", code: "io" });
  });

  it("refuses malformed Git result envelopes and mismatched roots", async () => {
    const gitRequest = { ...baseRequest, relativePaths: ["pyproject.toml"], includeGit: true };
    const ports: IntakeGitPort[] = [
      { run: async () => ({ kind: "head", status: "ok", value: "/work/repo", failureCode: null }) },
      { run: async () => ({ kind: "root", status: "ok", value: null, failureCode: null } as never) },
      { run: async () => ({ kind: "root", status: "unavailable", value: "bad", failureCode: "io" } as never) },
      { run: async () => ({ kind: "root", status: "ok", value: "/work/other", failureCode: null }) },
    ];
    for (const git of ports) {
      await expect(collectRepositoryInspection(gitRequest, { filesystem: observations(), git, clock: clock() }))
        .rejects.toMatchObject({ code: expect.stringMatching(/^intake\.(?:git|root)\./u) });
    }
  });

  it("covers projection refusal and rich-question/assumption branches", () => {
    const rich = candidate({
      assumptions: [{ text: "Suggested default", source: "model", confirmed: false, provenance: provenance("model-proposed", false) }],
      openQuestions: [question("q:open")],
    });
    const event = prepareCandidateAcceptance({
      candidate: rich,
      presentedDigest: rich.candidateDigest,
      expectedHead: null,
      expectedAggregateVersion: 0,
      clarification: createClarificationSession(),
      operatorConfirmed: true,
    }, { digest: intakeSha256, clock: fixedClock }).event;
    expect(projectBriefView(event, "normal").openQuestions).toHaveLength(1);
    expect(projectBriefView(event, "developer").developer.questions).toHaveLength(1);
    expect(() => projectBriefView({ ...event, brief: { ...event.brief, objective: "a".repeat(64) } } as never, "normal"))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => intakeStateView({ state: "bad" as never, questionCount: 0, blockingCount: 0, candidateDigest: null, diagnosticRule: null, canonicalRoot: null }, "normal"))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => intakeStateView({ state: "ready", questionCount: 0, blockingCount: 0, candidateDigest: null, diagnosticRule: "Bad Rule", canonicalRoot: null }, "developer"))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => projectBriefHistoryView([], "other" as never)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    expect(() => serializeIntakeProjection(cycle)).toThrowError(expect.objectContaining({ code: "intake.project.refused" }));
  });
});

describe("C7 bridge finite failure classification", () => {
  function throwingAdapter(error: unknown): PersistenceAdapter {
    return {
      transact: async () => { throw error; },
      migrationStatus: async () => ({ applied: [], pending: [], databaseSchemaAhead: false }),
      close: async () => undefined,
    };
  }

  it.each([
    [new PersistenceError("CONCURRENCY_CONFLICT", "safe"), "conflict"],
    [new PersistenceError("NOT_FOUND", "safe"), "conflict"],
    [new PersistenceError("DUPLICATE_ID", "safe"), "conflict"],
    [new PersistenceError("STORAGE_FAILURE", "safe"), "unknown"],
    [new PersistenceError("ADAPTER_CLOSED", "safe"), "refused"],
    [new ProjectContractError("INVARIANT_VIOLATION", "projectBrief", "safe"), "refused"],
    [new IntakeError("intake.input.invalid", "store"), "refused"],
    [new Error("raw"), "unknown"],
  ])("classifies %s without retry", async (error, kind) => {
    const result = await createC7IntakeStore(throwingAdapter(error)).attempt(prepared());
    expect(result.kind).toBe(kind);
  });

  it("returns unknown when a reconciliation read fails", async () => {
    expect(await createC7IntakeStore(throwingAdapter(new Error("raw"))).reconcile(prepared())).toEqual({ kind: "unknown" });
  });

  it("refuses a same-version durable head with a different expected identity", async () => {
    const adapter = createMemoryPersistenceAdapter({ clock: fixedClock });
    try {
      const existing = prepared();
      await createC7IntakeStore(adapter).attempt(existing);
      const forged = { ...existing, binding: { ...existing.binding, expectedAggregateVersion: 1, expectedHeadBriefId: "brf:different" }, aggregateVersion: 2 } as never;
      expect(await createC7IntakeStore(adapter).attempt(forged)).toEqual({ kind: "refused" });
    } finally {
      await adapter.close();
    }
  });
});
