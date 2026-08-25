import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toCanonicalJson } from "@ai-dev-os/domain";
import {
  assertStage18eIPublishedAnchorPreserved,
  hasCommittedStage18eIManifest,
  isStage18eIPublishedLineage,
  resolveCommit,
  runGit,
  STAGE_18E_I_MANIFEST_PATH,
} from "../../../scripts/stage-18e-i-subject-manifest-lib.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(appRoot, "..", "..");
const target = resolve(appRoot, "dist", "main", "stage-18e-i-candidate-binding.json");

const head = resolveCommit(repositoryRoot, "HEAD");
const publishedLineage = isStage18eIPublishedLineage(repositoryRoot, head);
const manifestPresent = hasCommittedStage18eIManifest(repositoryRoot, head);
if (!publishedLineage && !manifestPresent) {
  await rm(target, { force: true });
  process.stdout.write(`${JSON.stringify({ ok: true, status: "unpublished", output: null })}\n`);
} else {
  if (String(runGit(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).length !== 0) {
    throw new Error("CANDIDATE_BINDING_WORKTREE_NOT_CLEAN");
  }
  const published = assertStage18eIPublishedAnchorPreserved(repositoryRoot, head);
  if (head !== published.head) {
    await rm(target, { force: true });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      status: "published-anchor-descendant-disabled",
      output: null,
      head,
      reviewedHead: published.head,
    })}\n`);
  } else {
    const binding = Object.freeze({
      schemaVersion: 1,
      status: "published",
      head,
      tree: published.tree,
      sourceCommit: published.sourceCommit,
      sourceTree: published.sourceTree,
      manifestPath: STAGE_18E_I_MANIFEST_PATH,
      manifestSha256: published.manifestSha256,
      manifestAggregate: published.aggregateSha256,
    });
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${toCanonicalJson(binding, "stage18eICandidateBinding")}\n`, { encoding: "utf8" });
    process.stdout.write(`${JSON.stringify({ ok: true, status: "published", output: target, head, tree: published.tree, manifestAggregate: published.aggregateSha256 })}\n`);
  }
}
