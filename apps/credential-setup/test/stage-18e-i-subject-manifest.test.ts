import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertStage18eIPublishedAnchorPreserved,
  assertStage18eIBaseCommit,
  assertStage18eIManifestBase,
  assertManifestEquivalent,
  collectSubjectManifest,
  hasCommittedStage18eIManifest,
  isStage18eIPublishedLineage,
  parseNameStatusZ,
  serializeSubjectManifest,
  STAGE_18E_I_BASE_COMMIT,
  STAGE_18E_I_MANIFEST_ALGORITHM,
  STAGE_18E_I_MANIFEST_PATH,
  STAGE_18E_I_PUBLISHED_COMMIT,
  STAGE_18E_I_PUBLISHED_MANIFEST_SHA256,
  STAGE_18E_I_PUBLISHED_TREE,
  verifyStage18eIPublishedAnchor,
} from "../../../scripts/stage-18e-i-subject-manifest-lib.mjs";
import { committedBlobFixture } from "./committed-blob-fixture.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

describe("Stage 18E-I sanitized-receipt canonical committed-blob manifest", () => {
  it("uses a distinct namespace and rejects ambiguous or unsafe paths", () => {
    expect(STAGE_18E_I_MANIFEST_ALGORITHM).toBe("ai-dev-os.stage-18e-i.sanitized-success-receipt.git-blob-subject.v1");
    expect(STAGE_18E_I_MANIFEST_PATH).toBe("docs/release-evidence/stage-18e-i-sanitized-success-receipt-subject-manifest.json");
    expect(STAGE_18E_I_BASE_COMMIT).toBe("b438ed13b7213640e6a637d173bfefcf697ca9b8");
    expect(STAGE_18E_I_PUBLISHED_COMMIT).toBe("f90a779fce8c14cb6c4c3166ed89b0af5355b660");
    expect(STAGE_18E_I_PUBLISHED_TREE).toBe("f4a0035c03150970f700435af64cd2bd4e0968e4");
    expect(STAGE_18E_I_PUBLISHED_MANIFEST_SHA256).toBe("f296c931bd9fa924126c9ff39a518f1a3d438b28ba76dd33580e0743c8a1b57d");
    expect(parseNameStatusZ(Buffer.from("M\0z.txt\0A\0a.txt\0D\0old.txt\0", "utf8"))).toEqual([
      { status: "A", path: "a.txt" },
      { status: "D", path: "old.txt" },
      { status: "M", path: "z.txt" },
    ]);
    for (const hostile of ["M\0../escape\0", "M\0C:/absolute\0", "R100\0old\0new\0", "M\0line\nbreak\0", "M\0duplicate\0A\0duplicate\0"]) {
      expect(() => parseNameStatusZ(Buffer.from(hostile, "utf8"))).toThrow(/^SUBJECT_/u);
    }
  });

  describe("real committed-blob fixture", () => {
    const check = committedBlobFixture("source.txt", "dirty\n");
    it("reads only committed bytes, binds object identity, and preserves a dirty worktree", () => check(async ({ root, target, baseCommit: base, sourceCommit: source, beforeStatus: before, git }) => {
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
        blobOid: git("rev-parse", source + ":source.txt"),
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
    }));
  });

  it("keeps the exact reviewed publication immutable and allows only ancestry-preserving descendants", () => {
    const published = verifyStage18eIPublishedAnchor(repositoryRoot);
    expect(published).toMatchObject({
      head: STAGE_18E_I_PUBLISHED_COMMIT,
      tree: STAGE_18E_I_PUBLISHED_TREE,
      manifestSha256: STAGE_18E_I_PUBLISHED_MANIFEST_SHA256,
      sourceCommit: "bd26bc1cf8238c23406fc5e0a63fed046c988136",
      sourceTree: "9ef3a12c3434d3a838da02706413c9573f235aa5",
      fileCount: 45,
      aggregateSha256: "0cb4729cc4211dca11ef1f166ccd4340ad82db4ba50310c6b5e97244fcbd1d66",
    });
    const current = assertStage18eIPublishedAnchorPreserved(repositoryRoot);
    expect(current.head).toBe(STAGE_18E_I_PUBLISHED_COMMIT);
    expect(current.currentHead).toMatch(/^[a-f0-9]{40}$/u);
    expect(["exact-published-head", "published-anchor-descendant"]).toContain(current.status);
  }, 30_000);

  it("refuses a published-lineage descendant that deletes the immutable manifest", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ai-dev-os-stage-18e-i-descendant-test-"));
    const clone = join(parent, "repository");
    try {
      execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", repositoryRoot, clone], {
        encoding: "utf8",
        windowsHide: true,
      });
      const git = (...args: readonly string[]): string => execFileSync("git", args, {
        cwd: clone,
        encoding: "utf8",
        windowsHide: true,
      }).trim();
      git("config", "user.email", "manifest-test@example.invalid");
      git("config", "user.name", "Manifest Test");
      git("checkout", "--quiet", STAGE_18E_I_PUBLISHED_COMMIT);
      git("rm", "--quiet", "--", STAGE_18E_I_MANIFEST_PATH);
      git("commit", "--quiet", "-m", "delete immutable manifest");
      expect(isStage18eIPublishedLineage(clone)).toBe(true);
      expect(hasCommittedStage18eIManifest(clone)).toBe(false);
      expect(() => assertStage18eIPublishedAnchorPreserved(clone)).toThrow(
        "SUBJECT_PUBLISHED_MANIFEST_MISSING",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 30_000);
});
