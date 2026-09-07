import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateSubjectFiles, assertManifestEquivalent, collectSubjectManifest, parseNameStatusZ, readCommittedSubjectManifest, serializeSubjectManifest, STAGE_18E_H_MANIFEST_PATH } from "../../../scripts/stage-18e-h-subject-manifest-lib.mjs";
import { committedBlobFixture } from "./committed-blob-fixture.js";

const file = Object.freeze({ path: "apps/example.txt", changeType: "M", byteCount: 3, blobOid: "1".repeat(40), sha256: "2".repeat(64) });

describe("Stage 18E-H canonical subject manifest", () => {
  it("parses, validates, and raw-UTF-8-sorts the exact no-rename Git inventory", () => {
    expect(parseNameStatusZ(Buffer.from("M\0z.txt\0A\0a.txt\0D\0old.txt\0", "utf8"))).toEqual([
      { status: "A", path: "a.txt" },
      { status: "D", path: "old.txt" },
      { status: "M", path: "z.txt" },
    ]);
    for (const hostile of ["M\0../escape\0", "M\0C:/absolute\0", "R100\0old\0new\0", "M\0line\nbreak\0", "M\0duplicate\0A\0duplicate\0", "M\0missing-terminal"]) expect(() => parseNameStatusZ(Buffer.from(hostile, "utf8"))).toThrow(/^SUBJECT_/u);
  });

  it("binds hash, size, object identity, and path into an LF-only aggregate", () => {
    const baseline = aggregateSubjectFiles([file]);
    expect(baseline).toMatch(/^[0-9a-f]{64}$/u);
    expect(aggregateSubjectFiles([{ ...file, byteCount: 4 }])).not.toBe(baseline);
    expect(aggregateSubjectFiles([{ ...file, blobOid: "3".repeat(40) }])).not.toBe(baseline);
    expect(aggregateSubjectFiles([{ ...file, sha256: "4".repeat(64) }])).not.toBe(baseline);
    expect(aggregateSubjectFiles([{ ...file, path: "apps/other.txt" }])).not.toBe(baseline);
    expect(() => aggregateSubjectFiles([{ ...file, path: "z.txt" }, { ...file, path: "a.txt" }])).toThrow("SUBJECT_FILE_ORDER_REFUSED");
  });

  it.each([
    ["path", "apps/other.txt"],
    ["byteCount", 4],
    ["blobOid", "3".repeat(40)],
    ["sha256", "4".repeat(64)],
  ] as const)("rejects %s drift with a finite field diagnostic", (field, value) => {
    const expected = { schemaVersion: 1, sourceTree: "5".repeat(40), files: [file], aggregateSha256: aggregateSubjectFiles([file]) };
    expect(() => assertManifestEquivalent({ ...expected, files: [{ ...file, [field]: value }] }, expected)).toThrow(`SUBJECT_MANIFEST_DRIFT:manifest.files[0].${field}`);
  });

  it("rejects source-tree and aggregate drift and serializes canonically", () => {
    const expected = { schemaVersion: 1, sourceTree: "5".repeat(40), files: [file], aggregateSha256: aggregateSubjectFiles([file]) };
    expect(() => assertManifestEquivalent({ ...expected, sourceTree: "6".repeat(40) }, expected)).toThrow("SUBJECT_MANIFEST_DRIFT:manifest.sourceTree");
    expect(() => assertManifestEquivalent({ ...expected, aggregateSha256: "7".repeat(64) }, expected)).toThrow("SUBJECT_MANIFEST_DRIFT:manifest.aggregateSha256");
    expect(() => assertManifestEquivalent({ aggregateSha256: expected.aggregateSha256, schemaVersion: 1, files: [file] }, expected)).toThrow("SUBJECT_MANIFEST_DRIFT:manifest.keys");
    expect(serializeSubjectManifest(expected).endsWith("\n")).toBe(true);
    expect(serializeSubjectManifest(expected)).not.toContain("\r");
  });

  describe("real committed-blob fixture", () => {
    const check = committedBlobFixture("tracked.txt", "dirty-worktree\n");
    it("reads exact committed blobs without writing to or trusting the worktree", () => check(async ({ root, target, baseCommit, sourceCommit, beforeStatus, git }) => {
      const manifest = collectSubjectManifest(root, baseCommit, sourceCommit);
      const afterStatus = git("status", "--porcelain=v1", "--untracked-files=all");
      const record = manifest.files.find((candidate) => candidate.path === "tracked.txt");
      expect(record).toMatchObject({ blobOid: git("rev-parse", sourceCommit + ":tracked.txt"), byteCount: Buffer.byteLength("source\n"), sha256: createHash("sha256").update("source\n", "utf8").digest("hex") });
      expect(manifest.sourceTree).toBe(git("rev-parse", `${sourceCommit}^{tree}`));
      expect(await readFile(target, "utf8")).toBe("dirty-worktree\n");
      expect(afterStatus).toBe(beforeStatus);
    }));
  });

  it("reads the committed manifest blob when corrected CRLF worktree bytes would mask it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-dev-os-subject-verifier-"));
    const git = (...arguments_: readonly string[]): string => execFileSync("git", arguments_, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
    try {
      git("init", "--quiet");
      git("config", "user.email", "manifest-test@example.invalid");
      git("config", "user.name", "Manifest Test");
      await writeFile(join(root, "source.txt"), "base\n", "utf8");
      git("add", "source.txt");
      git("commit", "--quiet", "-m", "base");
      const baseCommit = git("rev-parse", "HEAD");
      await writeFile(join(root, "source.txt"), "source\n", "utf8");
      git("add", "source.txt");
      git("commit", "--quiet", "-m", "source");
      const sourceCommit = git("rev-parse", "HEAD");
      const manifestPath = join(root, ...STAGE_18E_H_MANIFEST_PATH.split("/"));
      await mkdir(join(root, "docs", "release-evidence"), { recursive: true });
      const committedBad = `${JSON.stringify({ baseCommit, sourceCommit, marker: "committed-bad" })}\n`;
      await writeFile(manifestPath, committedBad, "utf8");
      git("add", STAGE_18E_H_MANIFEST_PATH);
      git("commit", "--quiet", "-m", "manifest");
      const corrected = { baseCommit, sourceCommit, marker: "corrected-worktree" };
      await writeFile(manifestPath, serializeSubjectManifest(corrected).replaceAll("\n", "\r\n"), "utf8");
      const beforeStatus = git("status", "--porcelain=v1", "--untracked-files=all");
      const loaded = readCommittedSubjectManifest(root, "HEAD");
      const afterStatus = git("status", "--porcelain=v1", "--untracked-files=all");
      expect(loaded.raw).toBe(committedBad);
      expect(loaded.manifest).toMatchObject({ marker: "committed-bad" });
      expect(() => assertManifestEquivalent(loaded.manifest, corrected)).toThrow("SUBJECT_MANIFEST_DRIFT:manifest.marker");
      expect(await readFile(manifestPath, "utf8")).toContain("\r\n");
      expect(afterStatus).toBe(beforeStatus);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
