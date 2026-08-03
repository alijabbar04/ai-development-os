import { describe, expect, it } from "vitest";
import {
  ancestorDirectories,
  canonicalizeRepositoryPath,
  comparePaths,
  MAX_REPOSITORY_PATH_LENGTH,
  pathBaseName,
  pathDirName,
  pathExtension,
} from "../src/paths.js";
import type { FilesystemSemantics } from "../src/read-port.js";

const SENSITIVE: FilesystemSemantics = Object.freeze({
  caseSensitivity: "case-sensitive",
  unicodeForm: "nfc",
});
const INSENSITIVE: FilesystemSemantics = Object.freeze({
  caseSensitivity: "case-insensitive",
  unicodeForm: "nfc",
});
const PRESERVING: FilesystemSemantics = Object.freeze({
  caseSensitivity: "case-sensitive",
  unicodeForm: "preserve",
});

function reasonFor(raw: unknown, semantics: FilesystemSemantics = SENSITIVE): string {
  const result = canonicalizeRepositoryPath(raw, semantics);
  return result.ok ? "accepted" : result.reason;
}

describe("canonicalizeRepositoryPath", () => {
  it("accepts ordinary repository paths", () => {
    const result = canonicalizeRepositoryPath("src/util/format.ts", SENSITIVE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonicalPath).toBe("src/util/format.ts");
      expect(result.collisionKey).toBe("src/util/format.ts");
    }
  });

  it.each([
    ["", "empty"],
    [42, "not-a-string"],
    ["/etc/passwd", "absolute"],
    ["C:/Windows/System32", "drive-letter"],
    ["\\\\server\\share\\file", "unc-prefix"],
    ["src\\index.ts", "backslash"],
    ["../secrets.txt", "traversal"],
    ["src/../../etc/passwd", "traversal"],
    ["./src/index.ts", "traversal"],
    ["src//index.ts", "empty-segment"],
    ["~/.ssh/id_rsa", "home-reference"],
    ["readme.md:$DATA", "alternate-data-stream"],
    ["src/NUL", "reserved-device-name"],
    ["src/COM1.txt", "reserved-device-name"],
    ["src/trailing.", "unsafe-segment-edges"],
    ["src/ leading", "unsafe-segment-edges"],
    ["src/trailing ", "unsafe-segment-edges"],
  ])("rejects %j as %s", (input, reason) => {
    expect(reasonFor(input)).toBe(reason);
  });

  it("rejects NUL and other control characters", () => {
    expect(reasonFor("src/index\u0000.ts")).toBe("control-character");
    expect(reasonFor("src/index\u001f.ts")).toBe("control-character");
    expect(reasonFor("src/index\u007f.ts")).toBe("control-character");
  });

  it("rejects invisible and bidirectional control characters", () => {
    expect(reasonFor("src/pay\u202eload.ts")).toBe("bidi-or-format-character");
    expect(reasonFor("src/zero\u200bwidth.ts")).toBe("bidi-or-format-character");
    expect(reasonFor("src/\ufeffbom.ts")).toBe("bidi-or-format-character");
  });

  it("rejects unpaired surrogates", () => {
    expect(reasonFor(`src/${String.fromCharCode(0xd800)}.ts`)).toBe("unpaired-surrogate");
    expect(reasonFor(`src/${String.fromCharCode(0xdc00)}.ts`)).toBe("unpaired-surrogate");
  });

  it("enforces length and depth bounds", () => {
    expect(reasonFor("a".repeat(MAX_REPOSITORY_PATH_LENGTH + 1))).toBe("too-long");
    expect(reasonFor(`src/${"b".repeat(256)}.ts`)).toBe("segment-too-long");
    expect(reasonFor(Array.from({ length: 70 }, () => "d").join("/"))).toBe("too-deep");
  });

  it("normalizes to NFC when the filesystem declares it", () => {
    const decomposed = "src/cafe\u0301.ts";
    const composed = "src/caf\u00e9.ts";
    const normalized = canonicalizeRepositoryPath(decomposed, SENSITIVE);
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.canonicalPath).toBe(composed);
    }
  });

  it("preserves the original form when the filesystem does not normalize", () => {
    const decomposed = "src/cafe\u0301.ts";
    const preserved = canonicalizeRepositoryPath(decomposed, PRESERVING);
    expect(preserved.ok).toBe(true);
    if (preserved.ok) {
      expect(preserved.canonicalPath).toBe(decomposed);
      // The collision key still folds, so the two spellings are known to clash.
      expect(preserved.collisionKey).toBe("src/caf\u00e9.ts");
    }
  });

  it("folds case only where the filesystem is case-insensitive", () => {
    const sensitive = canonicalizeRepositoryPath("src/README.md", SENSITIVE);
    const insensitive = canonicalizeRepositoryPath("src/README.md", INSENSITIVE);
    expect(sensitive.ok && sensitive.collisionKey).toBe("src/README.md");
    expect(insensitive.ok && insensitive.collisionKey).toBe("src/readme.md");
  });
});

describe("path helpers", () => {
  it("splits base names, directories, and extensions", () => {
    expect(pathBaseName("a/b/c.ts")).toBe("c.ts");
    expect(pathBaseName("c.ts")).toBe("c.ts");
    expect(pathDirName("a/b/c.ts")).toBe("a/b");
    expect(pathDirName("c.ts")).toBe("");
    expect(pathExtension("a/b/c.TS")).toBe(".ts");
    expect(pathExtension("a/b/.gitignore")).toBe("");
    expect(pathExtension("a/b/c.")).toBe("");
  });

  it("lists ancestors shallowest first", () => {
    expect(ancestorDirectories("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestorDirectories("c.ts")).toEqual([]);
  });

  it("compares by code unit, not locale", () => {
    expect(comparePaths("A", "a")).toBe(-1);
    expect(comparePaths("a", "a")).toBe(0);
    expect(comparePaths("b", "a")).toBe(1);
  });
});
