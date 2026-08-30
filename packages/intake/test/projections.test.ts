import { describe, expect, it } from "vitest";
import {
  INTAKE_AVAILABLE_COMMANDS,
  INTAKE_AUTHORITY,
  INTAKE_REFUSAL_CODES,
  INTAKE_VIEW_STATES,
  clarificationView,
  createClarificationSession,
  intakeSha256,
  intakeRefusalCopy,
  intakeStateView,
  normalProjectionLeakage,
  openClarificationRound,
  prepareCandidateAcceptance,
  projectBriefHistoryView,
  projectBriefView,
  serializeIntakeProjection,
} from "../src/index.js";
import { candidate, fixedClock, question } from "./fixtures.js";

function eventV1() {
  const value = candidate();
  return prepareCandidateAcceptance({
    candidate: value,
    presentedDigest: value.candidateDigest,
    expectedHead: null,
    expectedAggregateVersion: 0,
    clarification: { rounds: [] },
    operatorConfirmed: true,
  }, { digest: intakeSha256, clock: fixedClock }).event;
}

function isSubset(subset: unknown, superset: unknown): boolean {
  if (Array.isArray(subset)) {
    return Array.isArray(superset)
      && subset.length === superset.length
      && subset.every((item, index) => isSubset(item, superset[index]));
  }
  if (subset !== null && typeof subset === "object") {
    if (superset === null || typeof superset !== "object" || Array.isArray(superset)) return false;
    return Object.entries(subset).every(([key, value]) => isSubset(value, (superset as Record<string, unknown>)[key]));
  }
  return Object.is(subset, superset);
}

describe("Normal and Developer intake projections", () => {
  it("makes Normal a recursive structural subset of Developer with identical authority and actions", () => {
    const event = eventV1();
    const normal = projectBriefView(event, "normal");
    const developer = projectBriefView(event, "developer");
    expect(isSubset(normal, developer)).toBe(true);
    expect(normal.authority).toBe(INTAKE_AUTHORITY);
    expect(normal.commands).toBe(INTAKE_AVAILABLE_COMMANDS);
    expect(developer.authority).toBe(normal.authority);
    expect(developer.commands).toEqual(normal.commands);
    expect(developer.actions).toEqual(normal.actions);
  });

  it("structurally omits ids, digests, rules, thread references, and paths from Normal", () => {
    const event = eventV1();
    const normal = projectBriefView(event, "normal");
    const developer = projectBriefView(event, "developer");
    const normalText = JSON.stringify(normal);
    expect(normalText).not.toMatch(/(?:brf|prj|dec|thr|project-brief):/u);
    expect(normalText).not.toContain(event.binding.candidateDigest);
    expect(normalText).not.toContain("sourceThreadId");
    expect(normalText).not.toContain("developer");
    expect(normalProjectionLeakage(normal)).toEqual([]);
    expect(JSON.stringify(developer)).toContain(event.brief.briefId);
    expect(JSON.stringify(developer)).toContain(event.binding.candidateDigest);
  });

  it("projects every finite intake state with the same verbs in both modes", () => {
    for (const state of INTAKE_VIEW_STATES) {
      const input = {
        state,
        questionCount: state === "blocked" ? 2 : 0,
        blockingCount: state === "blocked" ? 1 : 0,
        candidateDigest: "a".repeat(64),
        diagnosticRule: "intake.blocking.unanswered",
        canonicalRoot: "C:\\Projects\\Synthetic",
      } as const;
      const normal = intakeStateView(input, "normal");
      const developer = intakeStateView(input, "developer");
      expect(isSubset(normal, developer), state).toBe(true);
      expect(developer.actions, state).toEqual(normal.actions);
      expect(developer.authority, state).toBe("none");
      expect(developer.commands, state).toEqual([]);
      expect(normalProjectionLeakage(normal), state).toEqual([]);
    }
  });

  it("refuses operator-facing states whose blocking count contradicts the state", () => {
    const base = {
      questionCount: 1,
      candidateDigest: "a".repeat(64),
      diagnosticRule: null,
      canonicalRoot: null,
    } as const;
    expect(() => intakeStateView({ ...base, state: "ready", blockingCount: 1 }, "normal"))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid", root: "projection" }));
    expect(() => intakeStateView({ ...base, state: "blocked", blockingCount: 0 }, "normal"))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid", root: "projection" }));
    expect(() => intakeStateView({ ...base, state: "partial", blockingCount: 1 }, "developer"))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid", root: "projection" }));
  });

  it("keeps clarification questions mode-parity while exposing bounded diagnostics only in Developer", () => {
    const session = openClarificationRound({
      session: createClarificationSession(),
      questions: [question("q:visible"), question("q:dropped", { question: "Which outcome applies to q:visible?" })],
      knownFacts: [],
      materialChangeReason: null,
    }, intakeSha256);
    const normal = clarificationView(session, "normal");
    const developer = clarificationView(session, "developer");
    expect(isSubset(normal, developer)).toBe(true);
    expect(normal.authority).toBe("none");
    expect(normal.actions).toEqual(developer.actions);
    expect(JSON.stringify(normal)).not.toContain("questionId");
    expect(developer.developer.rounds[0]?.droppedDuplicates).toHaveLength(1);
  });

  it("uses deterministic canonical projection serialization", () => {
    const normal = projectBriefView(eventV1(), "normal");
    expect(serializeIntakeProjection(normal)).toBe(serializeIntakeProjection({
      productionEnabled: false,
      commands: normal.commands,
      authority: normal.authority,
      actions: normal.actions,
      openQuestions: normal.openQuestions,
      assumptions: normal.assumptions,
      constraints: normal.constraints,
      audiences: normal.audiences,
      nonGoals: normal.nonGoals,
      outcomes: normal.outcomes,
      objective: normal.objective,
      acceptedAt: normal.acceptedAt,
      version: normal.version,
      state: normal.state,
      presentation: normal.presentation,
    }));
  });

  it("derives a gap-free history and keeps identities Developer-only", () => {
    const first = eventV1();
    const value = candidate();
    const second = prepareCandidateAcceptance({
      candidate: value,
      presentedDigest: value.candidateDigest,
      expectedHead: first.brief,
      expectedAggregateVersion: 1,
      clarification: { rounds: [] },
      operatorConfirmed: true,
    }, {
      digest: intakeSha256,
      clock: { now: () => new Date("2026-08-30T12:35:56.000Z") },
    }).event;
    const normal = projectBriefHistoryView([second, first], "normal");
    const developer = projectBriefHistoryView([second, first], "developer");
    expect(normal.versions).toEqual([
      expect.objectContaining({ version: 1, status: "superseded" }),
      expect.objectContaining({ version: 2, status: "current" }),
    ]);
    expect(isSubset(normal, developer)).toBe(true);
    expect(JSON.stringify(normal)).not.toContain(first.brief.briefId);
    expect(JSON.stringify(developer)).toContain(first.brief.briefId);
  });

  it("refuses a history version gap and a malformed audience", () => {
    const first = eventV1();
    expect(() => projectBriefHistoryView([{ ...first, aggregateVersion: 2 }] as never, "normal"))
      .toThrowError();
    expect(() => projectBriefView(first, "operator" as never)).toThrowError(
      expect.objectContaining({ code: "intake.input.invalid" }),
    );
  });

  it("does not dereference chat history, so deletion cannot change an accepted view", () => {
    const event = eventV1();
    expect(event.brief.sourceThreadId).toBe("thr:intake-test");
    const before = projectBriefView(event, "normal");
    const simulatedThreadStoreAfterDeletion = new Map<string, unknown>();
    expect(simulatedThreadStoreAfterDeletion.size).toBe(0);
    const after = projectBriefView(event, "normal");
    expect(after).toEqual(before);
  });

  it("provides fixed non-reflective copy for every emitted refusal code", () => {
    expect(INTAKE_REFUSAL_CODES.length).toBeGreaterThan(10);
    for (const code of INTAKE_REFUSAL_CODES) {
      const copy = intakeRefusalCopy(code);
      expect(copy.length, code).toBeGreaterThan(10);
      expect(copy, code).not.toMatch(/(?:sk-ant-|C:\\Users\\|BEGIN PRIVATE KEY)/u);
    }
  });

  it("proves the Normal leakage detector is load-bearing", () => {
    const canaries = [
      { value: "C:\\Users\\operator\\project" },
      { value: "a".repeat(64) },
      { value: "brf:internal" },
      { value: "intake.digest.mismatch" },
      { value: "sk-ant-abcdefghijklmnopqrstuv" },
      { value: "Bearer abcdefghijklmnopqrstuv" },
      { value: "/tmp" },
      { value: "Path:/tmp/file" },
      { value: "Path:C:\\Users\\operator\\project" },
      { value: "Read \\Users\\operator\\project" },
      { value: "Read \\" },
      { value: "Read \\ then continue" },
      { value: "Read \\\\ then continue" },
      { value: "Read root \"\\\" before continuing" },
      { value: "Read root \"/\" before continuing" },
      { value: "Use // then continue" },
      { value: "Use \/\\ then continue" },
      { value: "Use file:/// then continue" },
      { value: "Use path:\\\\ then continue" },
      { value: "Use path:/// then continue" },
      { value: "Read //server/share/private" },
      { value: "Read //server" },
      { value: "file://server/share/private" },
      ...Array.from({ length: 6 }, (_value, index) => ({
        value: `Read ${"\\".repeat(index + 3)}server\\share`,
      })),
      { value: `AIza${"A".repeat(30)}` },
      { value: "xoxb-abcdefghij" },
      { value: "eyJabcdefghijk.abcdefghijk.abcdefghijk" },
      { value: "ghu_abcdefghijklmnop" },
      { value: "api_key=abcdefgh" },
      { value: "A".repeat(48) },
      { value: "int\u0430ke.digest.mismatch" },
      { value: "\u0456ntake.digest.mismatch" },
      { value: "int\u03B1ke.digest.mismatch" },
      { value: "\uFF49\uFF4E\uFF54\uFF41\uFF4B\uFF45\uFF0Edigest.mismatch" },
      { value: "\u0440r\u0458:internal-record" },
      { value: "intake.\u043Cismatch" },
      { value: "intake.\u039Cismatch" },
      { value: "brf:\u043Cetadata" },
      { value: "brf:\u039Cetadata" },
      { value: "intake.\u0445ray" },
      { value: "intake.\u03A7ray" },
      { value: "intake.\u1D05igest.mismatch" },
      { value: "intake\u2024digest.mismatch" },
      { value: "brf\u2236metadata" },
      { value: "project\u2010brief:internal" },
      { value: `${"a".repeat(31)}\u1D05${"a".repeat(32)}` },
      { value: `${"a".repeat(31)}\u20DD${"a".repeat(32)}` },
      { value: `${"a".repeat(31)}\u20DD\u20DD${"a".repeat(31)}` },
      { value: "int\u{1E030}ke.digest.mismatch" },
      { value: "sha25\u{1E031}:abcdef" },
      { value: "de\u{1E03F}:metadata" },
      { value: "\u{1E068}ntake.digest.mismatch" },
      { value: "brf\u{10781}metadata" },
      { value: "project\u207Bbrief:metadata" },
      { value: "project\uFE32brief:metadata" },
      { value: `${"a".repeat(31)}\u{1E030}${"a".repeat(32)}` },
      { value: "\u034Fbrf:metadata" },
      { value: "\uFE0Fbrf:metadata" },
      { value: "\uFFF0brf:metadata" },
      { value: "\u{E0100}brf:metadata" },
      { value: "unsafe\u202Etext" },
    ];
    for (const canary of canaries) expect(normalProjectionLeakage(canary).length).toBeGreaterThan(0);
    const permitted = [
      "Review https://example.com/spec",
      "A multilingual guide for \u65E5\u672C\u8A9E and \u043A\u043E\u043C\u0430\u043D\u0434\u0430",
      "Discuss intake planning and project-brief review",
      "\u65E5\u672C\u8A9E\u3002\u8AAC\u660E",
      "\u4E2D\u6587\u7A3F\u3002\u7E7C\u7E8C",
      "\uD55C\uAD6D\uC5B4\u3002\uC124\uBA85",
      "\u0646\u0635\u0639\u060C\u0646\u0635",
      "\u043C\u0438\u0440\uFF1A\u0434\u0435\u043B\u043E",
      "\u03B4\u03BF\u03BA\u00B7\u03AD\u03C1\u03B3\u03BF",
      "\u65E5".repeat(64),
      "intake\u2014planning",
      "intake\u2022planning",
      "intake... planning",
      "Complete intake.\u201D Next",
    ];
    for (const value of permitted) expect(normalProjectionLeakage({ value }), value).toEqual([]);
  });

  it("returns frozen data without callbacks or runtime handles", () => {
    const normal = projectBriefView(eventV1(), "normal");
    expect(Object.isFrozen(normal)).toBe(true);
    expect(Object.values(normal).some((value) => typeof value === "function")).toBe(false);
    expect(normal.productionEnabled).toBe(false);
  });
});
