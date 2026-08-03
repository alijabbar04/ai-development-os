import { describe, expect, it } from "vitest";
import {
  buildLexicalIndex,
  buildTermVector,
  extractSymbols,
  findExactTerm,
  findPrefixTerms,
  inverseDocumentFrequency,
  matchesPathQuery,
  tokenize,
} from "../src/lexical.js";
import {
  classifyLanguage,
  decodeContent,
  detectBinary,
  detectGenerated,
  safeUtf8Cut,
} from "../src/content.js";

const LIMITS = { maxDistinctTerms: 1_000, maxPostingsPerTerm: 100 } as const;

describe("tokenize", () => {
  it("splits on non-word characters and case transitions", () => {
    expect(tokenize("parseRepositoryIndex", 100)).toEqual(["parse", "repository", "index"]);
    expect(tokenize("snake_case-and.dots", 100)).toEqual(["snake", "case", "and", "dots"]);
    expect(tokenize("HTTPServer", 100)).toEqual(["httpserver"]);
  });

  it("splits digit runs from letter runs", () => {
    expect(tokenize("sha256Digest", 100)).toEqual(["sha", "256", "digest"]);
  });

  it("drops one-character terms and truncates very long ones", () => {
    expect(tokenize("a bb ccc", 100)).toEqual(["bb", "ccc"]);
    expect(tokenize("x".repeat(100), 100)[0]).toHaveLength(64);
  });

  it("keeps non-ASCII letters as searchable terms", () => {
    expect(tokenize("café straße", 100)).toEqual(["café", "straße"]);
  });

  it("honours the term bound", () => {
    expect(tokenize("aa bb cc dd ee", 3)).toHaveLength(3);
  });
});

describe("term vectors and postings", () => {
  it("produces a stable, sorted vector regardless of input order", () => {
    const first = buildTermVector(
      [
        ["text", ["beta", "alpha", "beta"]],
        ["name", ["alpha"]],
      ],
      100,
    );
    const second = buildTermVector(
      [
        ["name", ["alpha"]],
        ["text", ["beta", "beta", "alpha"]],
      ],
      100,
    );
    expect(first.terms).toEqual(second.terms);
    expect(first.terms.map((item) => `${item.field}:${item.term}:${item.count}`)).toEqual([
      "name:alpha:1",
      "text:alpha:1",
      "text:beta:2",
    ]);
  });

  it("marks truncation when the per-entry bound is reached", () => {
    const vector = buildTermVector([["text", ["aa", "bb", "cc"]]], 2);
    expect(vector.truncated).toBe(true);
    expect(vector.terms).toHaveLength(2);
    expect(vector.totalTermCount).toBe(3);
  });

  it("folds documents into sorted postings", () => {
    const index = buildLexicalIndex(
      [
        { canonicalPath: "a.ts", vector: buildTermVector([["text", ["shared", "alpha"]]], 50) },
        { canonicalPath: "b.ts", vector: buildTermVector([["text", ["shared", "beta"]]], 50) },
      ],
      LIMITS,
    );
    expect(index.totalDocuments).toBe(2);
    expect(index.terms.map((item) => item.term)).toEqual(["alpha", "beta", "shared"]);
    expect(findExactTerm(index, "shared")[0]?.documentFrequency).toBe(2);
    expect(findExactTerm(index, "absent")).toHaveLength(0);
  });

  it("caps distinct terms and postings, and says so", () => {
    const documents = Array.from({ length: 5 }, (_, ordinal) => ({
      canonicalPath: `f${ordinal}.ts`,
      vector: buildTermVector([["text", ["common"]]], 50),
    }));
    const capped = buildLexicalIndex(documents, { maxDistinctTerms: 1, maxPostingsPerTerm: 2 });
    expect(capped.truncated).toBe(true);
    expect(findExactTerm(capped, "common")[0]?.postings).toHaveLength(2);
  });

  it("finds prefixes and reports prefix truncation", () => {
    const index = buildLexicalIndex(
      [
        {
          canonicalPath: "a.ts",
          vector: buildTermVector([["text", ["render", "renderer", "rendering", "other"]]], 50),
        },
      ],
      LIMITS,
    );
    expect(findPrefixTerms(index, "render", 10).matches.map((item) => item.term)).toEqual([
      "render",
      "renderer",
      "rendering",
    ]);
    const limited = findPrefixTerms(index, "render", 2);
    expect(limited.truncated).toBe(true);
    expect(limited.matches).toHaveLength(2);
  });
});

describe("scoring arithmetic", () => {
  it("uses integers only and decreases with document frequency", () => {
    const rare = inverseDocumentFrequency(100, 1);
    const common = inverseDocumentFrequency(100, 100);
    expect(Number.isSafeInteger(rare)).toBe(true);
    expect(Number.isSafeInteger(common)).toBe(true);
    expect(rare).toBeGreaterThan(common);
    expect(inverseDocumentFrequency(0, 0)).toBe(0);
  });
});

describe("symbol extraction", () => {
  it("finds declaration-shaped names without parsing", () => {
    const source = [
      "export function computeTotal(values) {}",
      "export class Ledger {}",
      "export interface Options {}",
      "export type Alias = string;",
      "const localHelper = 1;",
      "def python_style():",
      "func goStyle() {}",
      "fn rustStyle() {}",
      "struct Point {}",
      "enum Colour {}",
    ].join("\n");
    expect(extractSymbols(source, 50)).toEqual([
      "Alias",
      "Colour",
      "Ledger",
      "Options",
      "Point",
      "computeTotal",
      "goStyle",
      "localHelper",
      "python_style",
      "rustStyle",
    ]);
  });

  it("respects the symbol bound", () => {
    const source = Array.from({ length: 40 }, (_, index) => `function fn${index}() {}`).join("\n");
    expect(extractSymbols(source, 5)).toHaveLength(5);
  });
});

describe("path matching", () => {
  it("matches exactly, by prefix, and by substring", () => {
    expect(matchesPathQuery("src/util/format.ts", "src/util/format.ts")).toBe(true);
    expect(matchesPathQuery("src/util/format.ts", "util")).toBe(true);
    expect(matchesPathQuery("src/util/format.ts", "form")).toBe(true);
    expect(matchesPathQuery("src/util/format.ts", "absent")).toBe(false);
  });
});

describe("content analysis", () => {
  it("detects binaries by NUL byte, magic prefix, and control ratio", () => {
    expect(detectBinary(new Uint8Array([0x61, 0x00, 0x62])).evidence).toBe("nul-byte");
    expect(detectBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d])).evidence).toBe("magic-prefix");
    expect(detectBinary(new Uint8Array(Array.from({ length: 100 }, () => 0x01))).evidence).toBe(
      "control-byte-ratio",
    );
    expect(detectBinary(new TextEncoder().encode("plain text")).binary).toBe(false);
    expect(detectBinary(new Uint8Array(0)).binary).toBe(false);
  });

  it("reports invalid UTF-8 rather than substituting characters", () => {
    const decoded = decodeContent(new Uint8Array([0x61, 0xc3, 0x28, 0x62]), 1_000);
    expect(decoded.encoding).toBe("invalid-utf-8");
    expect(decoded.text).toBeNull();
  });

  it("truncates on a UTF-8 boundary so a multibyte character is never split", () => {
    const bytes = new TextEncoder().encode("aaébb");
    // Byte 3 lands inside the two-byte sequence for the accented character.
    expect(safeUtf8Cut(bytes, 3)).toBe(2);
    const decoded = decodeContent(bytes, 3);
    expect(decoded.encoding).toBe("utf-8");
    expect(decoded.truncated).toBe(true);
    expect(decoded.text).toBe("aa");
  });

  it("classifies empty files explicitly", () => {
    expect(decodeContent(new Uint8Array(0), 10).encoding).toBe("empty");
  });

  it("detects generated and minified content", () => {
    expect(detectGenerated("// @generated by tool\nconst a = 1;\n").evidence).toBe("marker-comment");
    expect(detectGenerated(`const a=${"1+".repeat(600)}1;`).evidence).toBe("long-line");
    expect(detectGenerated("const a = 1;\nconst b = 2;\n").generated).toBe(false);
  });

  it("classifies languages from extension, file name, and shebang", () => {
    expect(classifyLanguage("src/a.ts", null)).toEqual({
      languageId: "typescript",
      evidence: "extension",
    });
    expect(classifyLanguage("Dockerfile", null)).toEqual({
      languageId: "dockerfile",
      evidence: "file-name",
    });
    expect(classifyLanguage("scripts/run", "#!/usr/bin/env python3")).toEqual({
      languageId: "python",
      evidence: "shebang",
    });
    expect(classifyLanguage("data.unknownext", null)).toEqual({
      languageId: "unknown",
      evidence: "none",
    });
  });

  it("prefers the validated extension over content-supplied shebang claims", () => {
    expect(classifyLanguage("src/a.ts", "#!/bin/bash").languageId).toBe("typescript");
  });
});
