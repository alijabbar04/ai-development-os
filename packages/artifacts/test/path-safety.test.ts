import { describe, expect, it } from "vitest";
import { ValidationError } from "@ai-dev-os/domain";
import {
  createArtifactDigest,
  digestEquals,
  parseArtifactDigest,
  parseArtifactLocation,
  parseSafeRelativePath,
} from "../src/index.js";

const SHA256_HEX = "a".repeat(64);

describe("SafeRelativePath", () => {
  it("accepts ordinary nested relative paths", () => {
    expect(parseSafeRelativePath("src/index.ts")).toBe("src/index.ts");
    expect(parseSafeRelativePath("deep/a/b/c/file-1.spec.tsx")).toBe("deep/a/b/c/file-1.spec.tsx");
    expect(parseSafeRelativePath("file with space.txt")).toBe("file with space.txt");
    expect(parseSafeRelativePath("comX/readme.md")).toBe("comX/readme.md");
    expect(parseSafeRelativePath("COM10/file.txt")).toBe("COM10/file.txt");
  });

  it("rejects traversal in every disguise", () => {
    const hostile = [
      "../etc/passwd",
      "src/../../secret",
      "src/..",
      "..",
      ".",
      "./src/file.ts",
      "a/./b",
    ];
    for (const candidate of hostile) {
      expect(() => parseSafeRelativePath(candidate)).toThrow(ValidationError);
    }
  });

  it("rejects absolute paths, drive letters, UNC, and backslashes", () => {
    const hostile = [
      "/etc/passwd",
      "C:file.txt",
      "c:/windows/system32",
      "\\\\server\\share\\file",
      "src\\index.ts",
      "//server/share",
    ];
    for (const candidate of hostile) {
      expect(() => parseSafeRelativePath(candidate)).toThrow(ValidationError);
    }
  });

  it("rejects Windows reserved device names case-insensitively", () => {
    const hostile = ["CON", "con", "Con.txt", "aux.log", "NUL", "com1", "COM9.tar.gz", "lpt5.txt", "src/PRN.md"];
    for (const candidate of hostile) {
      expect(() => parseSafeRelativePath(candidate)).toThrow(ValidationError);
    }
  });

  it("rejects control characters, forbidden characters, and unsafe segment edges", () => {
    const hostile = [
      "file\u0000.txt",
      "file\u001f.txt",
      "file\u007f.txt",
      "line\nbreak.txt",
      "src/fi:le.txt",
      "src/fi*le.txt",
      "src/fi?le.txt",
      'src/fi"le.txt',
      "src/<file>.txt",
      "src/fi|le.txt",
      "trailing./x",
      "trailing /x",
      " leading.txt",
      "dir/trailingdot.",
      "empty//segment",
      "trailing/",
      "~",
      "~/config",
    ];
    for (const candidate of hostile) {
      expect(() => parseSafeRelativePath(candidate)).toThrow(ValidationError);
    }
  });

  it("enforces total and per-segment length limits", () => {
    expect(() => parseSafeRelativePath("a/".repeat(600) + "x")).toThrow(ValidationError);
    expect(() => parseSafeRelativePath("a".repeat(256))).toThrow(ValidationError);
    expect(parseSafeRelativePath("a".repeat(255))).toBe("a".repeat(255));
    expect(() => parseSafeRelativePath("")).toThrow(ValidationError);
    expect(() => parseSafeRelativePath(42)).toThrow(ValidationError);
  });

  it("does not echo hostile path content in errors", () => {
    const secretPath = "../secrets/api-key-sk-12345.txt";
    try {
      parseSafeRelativePath(secretPath);
      expect.unreachable();
    } catch (error) {
      expect((error as ValidationError).message).not.toContain("sk-12345");
    }
  });
});

describe("ArtifactDigest", () => {
  it("accepts exact-length lowercase hex for each algorithm", () => {
    const sha256 = createArtifactDigest("sha-256", SHA256_HEX);
    expect(sha256.hex).toHaveLength(64);
    const sha512 = createArtifactDigest("sha-512", "b".repeat(128));
    expect(sha512.hex).toHaveLength(128);
    expect(digestEquals(sha256, createArtifactDigest("sha-256", SHA256_HEX))).toBe(true);
    expect(digestEquals(sha256, sha512)).toBe(false);
    expect(digestEquals(sha256, createArtifactDigest("sha-256", "c".repeat(64)))).toBe(false);
  });

  it("rejects wrong lengths, uppercase, and unknown algorithms", () => {
    expect(() => createArtifactDigest("sha-256", "a".repeat(63))).toThrow(ValidationError);
    expect(() => createArtifactDigest("sha-256", "A".repeat(64))).toThrow(ValidationError);
    expect(() => createArtifactDigest("sha-256", "g".repeat(64))).toThrow(ValidationError);
    expect(() => parseArtifactDigest({ algorithm: "md5", hex: "a".repeat(32) })).toThrow(
      ValidationError,
    );
    expect(() => parseArtifactDigest({ algorithm: "sha-256", hex: SHA256_HEX, extra: 1 })).toThrow(
      ValidationError,
    );
  });
});

describe("ArtifactLocation", () => {
  it("parses content-addressed and workspace-file locations", () => {
    expect(parseArtifactLocation({ type: "content-addressed", store: "local" })).toEqual({
      type: "content-addressed",
      store: "local",
    });
    const workspace = parseArtifactLocation({
      type: "workspace-file",
      workspaceId: "ws-1",
      path: "out/report.json",
    });
    expect(workspace).toEqual({ type: "workspace-file", workspaceId: "ws-1", path: "out/report.json" });
    expect(Object.isFrozen(workspace)).toBe(true);
  });

  it("rejects unknown types, traversal paths, and extra fields", () => {
    expect(() => parseArtifactLocation({ type: "url", href: "https://x" })).toThrow(
      ValidationError,
    );
    expect(() =>
      parseArtifactLocation({ type: "workspace-file", workspaceId: "ws-1", path: "../escape" }),
    ).toThrow(ValidationError);
    expect(() =>
      parseArtifactLocation({ type: "content-addressed", store: "local", path: "x" }),
    ).toThrow(ValidationError);
    expect(() =>
      parseArtifactLocation({ type: "workspace-file", workspaceId: "!bad", path: "a.txt" }),
    ).toThrow(ValidationError);
  });
});
