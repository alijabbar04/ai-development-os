import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toCanonicalJson } from "@ai-dev-os/domain";
import {
  assertStage18eIManifestBase,
  assertManifestEquivalent,
  collectSubjectManifest,
  parseNameStatusZ,
  readCommittedSubjectManifest,
  resolveCommit,
  runGit,
  serializeSubjectManifest,
  STAGE_18E_I_BASE_COMMIT,
  STAGE_18E_I_MANIFEST_PATH,
} from "../../../scripts/stage-18e-i-subject-manifest-lib.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(appRoot, "..", "..");
const target = resolve(appRoot, "dist", "main", "stage-18e-i-candidate-binding.json");

const presence = spawnSync("git", ["cat-file", "-e", `HEAD:${STAGE_18E_I_MANIFEST_PATH}`], {
  cwd: repositoryRoot,
  encoding: "utf8",
  windowsHide: true,
});
if (presence.status !== 0) {
  await rm(target, { force: true });
  process.stdout.write(`${JSON.stringify({ ok: true, status: "unpublished", output: null })}\n`);
} else {
  if (String(runGit(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).length !== 0) {
    throw new Error("CANDIDATE_BINDING_WORKTREE_NOT_CLEAN");
  }
  const head = resolveCommit(repositoryRoot, "HEAD");
  const { raw, manifest } = readCommittedSubjectManifest(repositoryRoot, head);
  if (
    typeof manifest !== "object" || manifest === null ||
    typeof manifest.baseCommit !== "string" || typeof manifest.sourceCommit !== "string"
  ) throw new Error("CANDIDATE_BINDING_MANIFEST_SHAPE_REFUSED");
  assertStage18eIManifestBase(manifest);
  const parents = String(runGit(repositoryRoot, ["rev-list", "--parents", "-n", "1", head])).trim().split(/\s+/u);
  if (parents.length !== 2 || parents[1] !== manifest.sourceCommit) {
    throw new Error("CANDIDATE_BINDING_PARENT_REFUSED");
  }
  const changes = parseNameStatusZ(runGit(repositoryRoot, [
    "diff", "--name-status", "-z", "--no-renames", parents[1], head,
  ], { binary: true }));
  if (changes.length !== 1 || changes[0]?.status !== "A" || changes[0]?.path !== STAGE_18E_I_MANIFEST_PATH) {
    throw new Error("CANDIDATE_BINDING_MANIFEST_COMMIT_REFUSED");
  }
  const expected = collectSubjectManifest(repositoryRoot, STAGE_18E_I_BASE_COMMIT, parents[1]);
  assertManifestEquivalent(manifest, expected);
  if (raw !== serializeSubjectManifest(expected)) throw new Error("CANDIDATE_BINDING_MANIFEST_BYTES_REFUSED");
  const tree = String(runGit(repositoryRoot, ["rev-parse", "--verify", `${head}^{tree}`])).trim();
  if (!/^[a-f0-9]{40}$/u.test(tree)) throw new Error("CANDIDATE_BINDING_TREE_REFUSED");
  const binding = Object.freeze({
    schemaVersion: 1,
    status: "published",
    head,
    tree,
    sourceCommit: expected.sourceCommit,
    sourceTree: expected.sourceTree,
    manifestPath: STAGE_18E_I_MANIFEST_PATH,
    manifestSha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    manifestAggregate: expected.aggregateSha256,
  });
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${toCanonicalJson(binding, "stage18eICandidateBinding")}\n`, { encoding: "utf8" });
  process.stdout.write(`${JSON.stringify({ ok: true, status: "published", output: target, head, tree, manifestAggregate: expected.aggregateSha256 })}\n`);
}
