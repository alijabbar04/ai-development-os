import { assertNewBrief, parseProjectBrief } from "@ai-dev-os/project";
import { describe, expect, it } from "vitest";
import {
  IntakeError,
  assembleCandidate,
  candidateDigestMaterial,
  intakeSha256,
  normalProjectionLeakage,
  parseIntakeJsonText,
  verifyCandidate,
} from "../src/index.js";
import { materializeCandidateBrief } from "../src/candidate.js";
import {
  containsProtectedIdentifierShape,
  protectedBaseConfusableEquivalent,
  protectedConfusableEquivalent,
  protectedConfusableDataIdentity,
  protectedDirectConfusableEquivalent,
} from "../src/text.js";
import { candidate, constraint, draft, field, provenance, question } from "./fixtures.js";

describe("candidate construction and canonical provenance", () => {
  it("preserves the operator objective byte-for-byte and is deterministic", () => {
    const objective = "Build café intake — exactly as written.";
    const first = candidate({ objective: field(objective) });
    const second = candidate({ objective: field(objective) });
    expect(first.objective.value).toBe(objective);
    expect(first.candidateDigest).toBe(second.candidateDigest);
    expect(first.candidateDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(candidateDigestMaterial(first)).toBe(candidateDigestMaterial(second));
  });

  it("canonicalizes object key order without changing array meaning", () => {
    const regular = draft();
    const reordered = {
      sourceThreadId: regular.sourceThreadId,
      openQuestions: regular.openQuestions,
      assumptions: regular.assumptions,
      constraints: regular.constraints,
      audiences: regular.audiences,
      nonGoals: regular.nonGoals,
      outcomes: regular.outcomes,
      objective: regular.objective,
      projectId: regular.projectId,
    };
    expect(assembleCandidate(reordered, intakeSha256).candidateDigest).toBe(candidate().candidateDigest);
  });

  it("marks candidates without an outcome or audience as not ready", () => {
    expect(candidate({ outcomes: Object.freeze([]) }).ready).toBe(false);
    expect(candidate({ audiences: Object.freeze([]) }).ready).toBe(false);
    expect(candidate().ready).toBe(true);
  });

  it("validates the materialized accepted record with the real C6 parser", () => {
    const value = candidate();
    const brief = materializeCandidateBrief(value, {
      briefId: "brf:first",
      supersedes: null,
      createdAt: "2026-08-30T12:34:56.000Z",
    });
    expect(parseProjectBrief(brief)).toEqual(brief);
    expect(brief.objective).toBe(value.objective.value);
    expect(brief.origin).toBe("operator");
  });

  it("preserves all five C8 provenance distinctions before acceptance", () => {
    const value = candidate({
      outcomes: Object.freeze([
        field("Operator outcome", "operator-supplied", true),
        field("Observed outcome", "approved-observation", false),
        field("Proposed outcome", "model-proposed", false),
        field("Default outcome", "proposed-default", false),
        field("Derived outcome", "derived-deterministically", false),
      ]),
    });
    expect(value.outcomes.map((item) => item.provenance.source)).toEqual([
      "operator-supplied",
      "approved-observation",
      "model-proposed",
      "proposed-default",
      "derived-deterministically",
    ]);
  });

  it("rejects an impossible hard constraint and model-authored hard authority", () => {
    expect(() => candidate({
      constraints: Object.freeze([Object.freeze({ value: constraint(), provenance: provenance(), possible: false })]),
    })).toThrowError(expect.objectContaining({ code: "intake.candidate.not-ready" }));

    expect(() => candidate({
      constraints: Object.freeze([Object.freeze({
        value: constraint({ origin: "model", authority: "none" }),
        provenance: provenance("model-proposed", false),
        possible: true,
      })]),
    })).toThrowError(expect.objectContaining({ code: "intake.project.refused" }));
  });

  it.each([
    ["bidi", "Safe\u202Eunsafe", "intake.text.bidi"],
    ["control", "Safe\u0001unsafe", "intake.text.control"],
    ["zero width", "Safe\u200Bunsafe", "intake.text.zero-width"],
    ["combining grapheme joiner", "\u034Fbrf:metadata", "intake.text.zero-width"],
    ["variation selector", "\uFE0Fbrf:metadata", "intake.text.zero-width"],
    ["reserved default-ignorable", "\uFFF0brf:metadata", "intake.text.zero-width"],
    ["supplementary variation selector", "\u{E0100}brf:metadata", "intake.text.zero-width"],
    ["mixed normalization", "Cafe\u0301", "intake.text.normalization"],
    ["malformed Unicode", "Safe\uD800", "intake.text.malformed-unicode"],
    ["secret shape", "Use sk-ant-abcdefghijklmnopqrstuv", "intake.text.secret"],
    ["absolute path", "Read C:\\Users\\operator\\project", "intake.text.absolute-path"],
    ["POSIX absolute path", "Read /workspace/private/file.txt", "intake.text.absolute-path"],
    ["single-segment POSIX absolute path", "/tmp", "intake.text.absolute-path"],
    ["delimiter-adjacent POSIX absolute path", "Path:/tmp/file", "intake.text.absolute-path"],
    ["delimiter-adjacent Windows absolute path", "Path:C:\\Users\\operator\\project", "intake.text.absolute-path"],
    ["Windows root-relative absolute path", "Read \\Users\\operator\\project", "intake.text.absolute-path"],
    ["Windows root-only absolute path", "Read \\", "intake.text.absolute-path"],
    ["delimiter-bounded Windows root", "Read \\ then continue", "intake.text.absolute-path"],
    ["delimiter-bounded doubled Windows root", "Read \\\\ then continue", "intake.text.absolute-path"],
    ["quoted Windows root", "Read root \"\\\" before continuing", "intake.text.absolute-path"],
    ["quoted POSIX root", "Read root \"/\" before continuing", "intake.text.absolute-path"],
    ["delimiter-bounded doubled POSIX root", "Use // then continue", "intake.text.absolute-path"],
    ["mixed root-only run", "Use \/\\ then continue", "intake.text.absolute-path"],
    ["root-only file URL", "Use file:/// then continue", "intake.text.absolute-path"],
    ["root-only path form", "Use path:\\\\ then continue", "intake.text.absolute-path"],
    ["root-only forward path form", "Use path:/// then continue", "intake.text.absolute-path"],
    ["forward-slash UNC absolute path", "Read //server/share/private", "intake.text.absolute-path"],
    ["forward-slash UNC server root", "Read //server", "intake.text.absolute-path"],
    ["file UNC absolute path", "file://server/share/private", "intake.text.absolute-path"],
    ["Bearer credential shape", "Bearer abcdefghijklmnopqrstuv", "intake.text.secret"],
    ["Gemini credential shape", `AIza${"A".repeat(30)}`, "intake.text.secret"],
    ["Slack credential shape", "xoxb-abcdefghij", "intake.text.secret"],
    ["JWT credential shape", "eyJabcdefghijk.abcdefghijk.abcdefghijk", "intake.text.secret"],
    ["GitHub OAuth credential shape", "gho_abcdefghijklmnop", "intake.text.secret"],
    ["labelled credential shape", "api_key=abcdefgh", "intake.text.secret"],
    ["long hexadecimal secret shape", "Use aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "intake.text.secret"],
    ["long base64 secret shape", "A".repeat(48), "intake.text.secret"],
    ["internal identifier", "Replace brf:internal-record", "intake.input.invalid"],
    ["protected identifier with Cyrillic a", "int\u0430ke.digest.mismatch", "intake.input.invalid"],
    ["protected identifier with Cyrillic i", "\u0456ntake.digest.mismatch", "intake.input.invalid"],
    ["protected identifier with Greek alpha", "int\u03B1ke.digest.mismatch", "intake.input.invalid"],
    ["compatibility protected identifier", "\uFF49\uFF4E\uFF54\uFF41\uFF4B\uFF45\uFF0Edigest.mismatch", "intake.input.invalid"],
    ["protected record id with Cyrillic letters", "\u0440r\u0458:internal-record", "intake.input.invalid"],
    ["protected rule body with Cyrillic em", "intake.\u043Cismatch", "intake.input.invalid"],
    ["protected rule body with Greek mu", "intake.\u039Cismatch", "intake.input.invalid"],
    ["protected record body with Cyrillic em", "brf:\u043Cetadata", "intake.input.invalid"],
    ["protected record body with Greek mu", "brf:\u039Cetadata", "intake.input.invalid"],
    ["protected rule body with Cyrillic ha", "intake.\u0445ray", "intake.input.invalid"],
    ["protected rule body with Greek chi", "intake.\u03A7ray", "intake.input.invalid"],
    ["protected rule body with Latin small-cap d", "intake.\u1D05igest.mismatch", "intake.input.invalid"],
    ["confusable protected rule separator", "intake\u2024digest.mismatch", "intake.input.invalid"],
    ["confusable protected record separator", "brf\u2236metadata", "intake.input.invalid"],
    ["confusable protected prefix hyphen", "project\u2010brief:internal", "intake.input.invalid"],
    ["protected digest with Latin small-cap d", `${"a".repeat(31)}\u1D05${"a".repeat(32)}`, "intake.input.invalid"],
    ["protected digest with combining enclosure", `${"a".repeat(31)}\u20DD${"a".repeat(32)}`, "intake.input.invalid"],
    ["protected digest with repeated combining enclosures", `${"a".repeat(31)}\u20DD\u20DD${"a".repeat(31)}`, "intake.input.invalid"],
    ["NFKC-closed Cyrillic a in intake", "int\u{1E030}ke.digest.mismatch", "intake.input.invalid"],
    ["NFKC-closed Cyrillic be in sha256", "sha25\u{1E031}:abcdef", "intake.input.invalid"],
    ["NFKC-closed Cyrillic es in dec", "de\u{1E03F}:metadata", "intake.input.invalid"],
    ["NFKC-closed Cyrillic i in intake", "\u{1E068}ntake.digest.mismatch", "intake.input.invalid"],
    ["NFKC-closed record separator", "brf\u{10781}metadata", "intake.input.invalid"],
    ["NFKC-closed superscript prefix hyphen", "project\u207Bbrief:metadata", "intake.input.invalid"],
    ["NFKC-closed presentation-form prefix hyphen", "project\uFE32brief:metadata", "intake.input.invalid"],
    ["NFKC-closed digest slot", `${"a".repeat(31)}\u{1E030}${"a".repeat(32)}`, "intake.input.invalid"],
  ])("rejects %s objective text with a finite non-reflective code", (_label, objective, code) => {
    let thrown: unknown;
    try {
      candidate({ objective: field(objective) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(IntakeError);
    expect(thrown).toMatchObject({ code, root: "objective" });
    expect(JSON.stringify(thrown)).not.toContain(objective);
  });

  it("rejects oversized text and secret-shaped nested machine data", () => {
    expect(() => candidate({ objective: field("x".repeat(16_385)) })).toThrowError(
      expect.objectContaining({ code: "intake.text.too-long" }),
    );
    expect(() => candidate({
      constraints: Object.freeze([Object.freeze({
        value: constraint({ machineForm: { token: "sk-ant-abcdefghijklmnopqrstuv" } }),
        provenance: provenance(),
        possible: true,
      })]),
    })).toThrowError(expect.objectContaining({ code: "intake.text.secret" }));
  });

  it("allows ordinary URLs, multilingual prose, and non-identifier punctuation", () => {
    expect(candidate({ objective: field("Review https://example.com/spec") }).objective.value)
      .toBe("Review https://example.com/spec");
    const permitted = [
      "Build a multilingual guide for \u65E5\u672C\u8A9E and \u043A\u043E\u043C\u0430\u043D\u0434\u0430",
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
    for (const value of permitted) {
      expect(candidate({ objective: field(value) }).objective.value, value).toBe(value);
      expect(normalProjectionLeakage({ objective: value }), value).toEqual([]);
    }
  });

  it("pins the Unicode source identity and applies only character-equivalent protected substitutions", () => {
    expect(protectedConfusableDataIdentity()).toEqual({
      standard: "Unicode UTS #39",
      version: "17.0.0",
      date: "2025-07-22",
      sourceSha256: "091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a",
    });
    const named = [
      "int\u0430ke.digest.mismatch",
      "\u0456ntake.digest.mismatch",
      "project\u2010brief:metadata",
      "\u0440r\u0458:metadata",
      "brf\u2236metadata",
      "intake.\u1D05igest",
    ];
    for (const value of named) {
      expect(containsProtectedIdentifierShape(value), value).toBe(true);
      expect(() => candidate({ objective: field(value) }), value).toThrowError(
        expect.objectContaining({ code: "intake.input.invalid" }),
      );
      expect(normalProjectionLeakage({ value }).length, value).toBeGreaterThan(0);
    }
    for (let index = 0; index < 64; index += 1) {
      const value = `${"a".repeat(index)}\u1D05${"a".repeat(63 - index)}`;
      expect(containsProtectedIdentifierShape(value), `digest slot ${index}`).toBe(true);
    }
  });

  it("mechanically audits the complete one-code-point NFKC closure at both public boundaries", () => {
    const protectedClasses = "abcdefghijklmnopqrstuvwxyz0123456789._:-";
    const closureCodePoints = new Set<number>();
    const closureClasses = new Set<string>();
    let closurePairs = 0;

    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const actual = String.fromCodePoint(codePoint);
      const compatible = actual.normalize("NFKC");
      const compatibleCharacters = Array.from(compatible);
      if (compatible === actual || compatibleCharacters.length !== 1) continue;

      for (const expected of protectedClasses) {
        if (
          !protectedBaseConfusableEquivalent(compatibleCharacters[0] ?? "", expected)
          || protectedBaseConfusableEquivalent(actual, expected)
        ) continue;

        const label = `U+${codePoint.toString(16).toUpperCase()} => ${expected}`;
        closurePairs += 1;
        closureCodePoints.add(codePoint);
        closureClasses.add(expected);
        expect(protectedDirectConfusableEquivalent(actual, expected), label).toBe(true);
        expect(protectedConfusableEquivalent(actual, expected), label).toBe(true);

        const value = expected === ":"
          ? `brf${actual}metadata`
          : `intake.${actual}a`;
        expect(containsProtectedIdentifierShape(value), label).toBe(true);
        expect(() => candidate({ objective: field(value) }), label).toThrowError(
          expect.objectContaining({ code: "intake.input.invalid" }),
        );
        expect(normalProjectionLeakage({ value }).length, label).toBeGreaterThan(0);
      }
    }

    expect(closurePairs).toBe(84);
    expect(closureCodePoints.size).toBe(71);
    expect(closureClasses.size).toBe(26);
    expect(protectedConfusableEquivalent("\uFB00", "f")).toBe(false);
  });

  it("covers every fixed prefix and all 64 digest positions after NFKC closure", () => {
    const fixedPrefixes = [
      "\u{1E032}rf:metadata",
      "p\u{1E033}j:metadata",
      "de\u{1E03F}:metadata",
      "\u{1E040}hr:metadata",
      "\u{1E068}ntake-evidence:metadata",
      "project\u207Bbrief:metadata",
      "sha25\u{1E031}:metadata",
      "int\u{1E030}ke.digest",
      "brf\u{10781}metadata",
      "intake\u2024digest",
    ];
    for (const value of fixedPrefixes) {
      expect(containsProtectedIdentifierShape(value), value).toBe(true);
      expect(() => candidate({ objective: field(value) }), value).toThrowError(
        expect.objectContaining({ code: "intake.input.invalid" }),
      );
      expect(normalProjectionLeakage({ value }).length, value).toBeGreaterThan(0);
    }

    for (let index = 0; index < 64; index += 1) {
      const characters = Array<string>(64).fill("a");
      characters[index] = "\u{1E030}";
      characters[(index + 32) % 64] = "\u1D05";
      const value = characters.join("");
      expect(containsProtectedIdentifierShape(value), `NFKC digest slot ${index}`).toBe(true);
      expect(() => candidate({ objective: field(value) }), value).toThrowError(
        expect.objectContaining({ code: "intake.input.invalid" }),
      );
      expect(normalProjectionLeakage({ value }).length, value).toBeGreaterThan(0);
    }
  });

  it("refuses every tested Windows rooted run from one through eight leading backslashes", () => {
    for (let count = 1; count <= 8; count += 1) {
      const objective = `Read ${"\\".repeat(count)}server\\share`;
      expect(() => candidate({ objective: field(objective) }), objective).toThrowError(
        expect.objectContaining({ code: "intake.text.absolute-path" }),
      );
    }
  });

  it("rejects blocking-basis mismatches and validates questions through C6", () => {
    const invalid = { ...question("q:block"), question: { ...question("q:block").question, blocking: true } };
    expect(() => candidate({ openQuestions: Object.freeze([invalid]) })).toThrowError(
      expect.objectContaining({ code: "intake.question.blocking-basis" }),
    );
    expect(() => candidate({
      openQuestions: Object.freeze([question("q:empty", { proposedDefault: "" })]),
    })).toThrowError(expect.objectContaining({ code: "intake.project.refused" }));
    expect(() => candidate({
      openQuestions: Object.freeze([question("q:long-option", { options: ["x".repeat(1_025), "safe"] })]),
    })).toThrowError(expect.objectContaining({ code: "intake.text.too-long" }));
  });

  it("copies hostile mutable input into frozen canonical values", () => {
    const input = draft();
    const mutable = [...input.outcomes];
    const value = assembleCandidate({ ...input, outcomes: mutable }, intakeSha256);
    mutable.push(field("Late mutation"));
    expect(value.outcomes).toHaveLength(1);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.outcomes)).toBe(true);
  });

  it("detects a forged candidate digest", () => {
    const value = candidate();
    expect(() => verifyCandidate({ ...value, candidateDigest: "0".repeat(64) }, intakeSha256)).toThrowError(
      expect.objectContaining({ code: "intake.digest.mismatch" }),
    );
  });

  it("refuses an accessor-bearing candidate without invoking the getter", () => {
    let invoked = false;
    const hostile = { ...candidate() } as Record<string, unknown>;
    Object.defineProperty(hostile, "candidateDigest", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "0".repeat(64);
      },
    });
    expect(() => verifyCandidate(hostile as never, intakeSha256)).toThrowError(
      expect.objectContaining({ code: "intake.input.invalid" }),
    );
    expect(invoked).toBe(false);
  });

  it("rejects prototype/accessor shapes without invoking the getter", () => {
    let invoked = false;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "projectId", { enumerable: true, get: () => { invoked = true; return "prj:bad"; } });
    expect(() => assembleCandidate(hostile as never, intakeSha256)).toThrowError(
      expect.objectContaining({ code: "intake.input.invalid" }),
    );
    expect(invoked).toBe(false);
  });

  it("rejects duplicate JSON keys before materialization", () => {
    expect(() => parseIntakeJsonText('{"objective":"first","objective":"second"}')).toThrowError(
      expect.objectContaining({ code: "intake.input.invalid" }),
    );
    expect(parseIntakeJsonText('{"objective":"first"}')).toEqual({ objective: "first" });
  });

  it("materializes deliberate byte-identical revisions as distinct C6 records", () => {
    const value = candidate();
    const first = materializeCandidateBrief(value, {
      briefId: "brf:first",
      supersedes: null,
      createdAt: "2026-08-30T12:00:00.000Z",
    });
    const second = materializeCandidateBrief(value, {
      briefId: "brf:second",
      supersedes: first.briefId,
      createdAt: "2026-08-30T12:01:00.000Z",
    });
    expect(() => assertNewBrief(first, second)).not.toThrow();
    expect(second.objective).toBe(first.objective);
    expect(second.briefId).not.toBe(first.briefId);
  });

  it("keeps an ordinary candidate free of Normal-projection leakage shapes", () => {
    const value = candidate();
    expect(normalProjectionLeakage({
      objective: value.objective.value,
      outcomes: value.outcomes.map((item) => item.value),
      nonGoals: value.nonGoals.map((item) => item.value),
      audiences: value.audiences.map((item) => item.value),
    })).toEqual([]);
    expect(normalProjectionLeakage({ planted: "C:\\Users\\operator\\secret" }).length).toBeGreaterThan(0);
  });
});
