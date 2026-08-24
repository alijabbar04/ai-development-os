import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertStage18eIBaseCommit,
  assertStage18eIManifestBase,
  assertManifestEquivalent,
  collectSubjectManifest,
  parseNameStatusZ,
  serializeSubjectManifest,
  STAGE_18E_I_BASE_COMMIT,
  STAGE_18E_I_MANIFEST_ALGORITHM,
  STAGE_18E_I_MANIFEST_PATH,
} from "../../../scripts/stage-18e-i-subject-manifest-lib.mjs";

describe("Stage 18E-I sanitized-receipt canonical committed-blob manifest", () => {
  it("uses a distinct namespace and rejects ambiguous or unsafe paths", () => {
    expect(STAGE_18E_I_MANIFEST_ALGORITHM).toBe("ai-dev-os.stage-18e-i.sanitized-success-receipt.git-blob-subject.v1");
    expect(STAGE_18E_I_MANIFEST_PATH).toBe("docs/release-evidence/stage-18e-i-sanitized-success-receipt-subject-manifest.json");
    expect(STAGE_18E_I_BASE_COMMIT).toBe("b438ed13b7213640e6a637d173bfefcf697ca9b8");
    expect(parseNameStatusZ(Buffer.from("M\0z.txt\0A\0a.txt\0D\0old.txt\0", "utf8"))).toEqual([
      { status: "A", path: "a.txt" },
      { status: "D", path: "old.txt" },
      { status: "M", path: "z.txt" },
    ]);
    for (const hostile of ["M\0../escape\0", "M\0C:/absolute\0", "R100\0old\0new\0", "M\0line\nbreak\0", "M\0duplicate\0A\0duplicate\0"]) {
      expect(() => parseNameStatusZ(Buffer.from(hostile, "utf8"))).toThrow(/^SUBJECT_/u);
    }
  });

  it("reads only committed bytes, binds object identity, and preserves a dirty worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-dev-os-stage-18e-i-manifest-test-"));
    const git = (...args: readonly string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
    try {
      git("init", "--quiet");
      git("config", "user.email", "manifest-test@example.invalid");
      git("config", "user.name", "Manifest Test");
      const target = join(root, "source.txt");
      await writeFile(target, "base\n", "utf8");
      git("add", "source.txt");
      git("commit", "--quiet", "-m", "base");
      const base = git("rev-parse", "HEAD");
      await writeFile(target, "source\n", "utf8");
      git("add", "source.txt");
      git("commit", "--quiet", "-m", "source");
      const source = git("rev-parse", "HEAD");
      await writeFile(target, "dirty\n", "utf8");
      const before = git("status", "--porcelain=v1", "--untracked-files=all");
      const manifest = collectSubjectManifest(root, base, source);
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        algorithm: STAGE_18E_I_MANIFEST_ALGORITHM,
        baseCommit: base,
        sourceCommit: source,
        sourceTree: git("rev-parse", `${source}^{tree}`),
        inventory: { changedPathCount: 1, blobPathCount: 1, deletedPathCount: 0 },
      });
      expect(manifest.files[0]).toMatchObject({
        path: "source.txt",
        byteCount: Buffer.byteLength("source\n"),
        sha256: createHash("sha256").update("source\n", "utf8").digest("hex"),
      });
      expect(manifest.aggregateSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(await readFile(target, "utf8")).toBe("dirty\n");
      expect(git("status", "--porcelain=v1", "--untracked-files=all")).toBe(before);
      expect(serializeSubjectManifest(manifest)).toMatch(/\n$/u);
      expect(serializeSubjectManifest(manifest)).not.toContain("\r");
      expect(() => assertManifestEquivalent({ ...manifest, aggregateSha256: "0".repeat(64) }, manifest)).toThrow("SUBJECT_MANIFEST_DRIFT:manifest.aggregateSha256");
      const wrongBaseManifest = { ...manifest, baseCommit: source };
      expect(() => assertStage18eIManifestBase(wrongBaseManifest)).toThrow("SUBJECT_MANIFEST_BASE_REFUSED");
      expect(assertStage18eIBaseCommit(STAGE_18E_I_BASE_COMMIT)).toBe(STAGE_18E_I_BASE_COMMIT);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
