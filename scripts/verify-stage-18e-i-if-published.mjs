import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertStage18eIPublishedAnchorPreserved,
  hasCommittedStage18eIManifest,
  isStage18eIPublishedLineage,
  resolveCommit,
} from "./stage-18e-i-subject-manifest-lib.mjs";

if (process.argv.length !== 2) throw new Error("SUBJECT_CONDITIONAL_VERIFIER_ARGUMENTS_REFUSED");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const head = resolveCommit(root, "HEAD");
const publishedLineage = isStage18eIPublishedLineage(root, head);
const manifestPresent = hasCommittedStage18eIManifest(root, head);
if (publishedLineage || manifestPresent) {
  const verified = assertStage18eIPublishedAnchorPreserved(root, head);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: verified.status,
    head: verified.currentHead,
    publishedHead: verified.head,
    publishedTree: verified.tree,
    sourceCommit: verified.sourceCommit,
    sourceTree: verified.sourceTree,
    fileCount: verified.fileCount,
    aggregateSha256: verified.aggregateSha256,
  })}\n`);
} else process.stdout.write(`${JSON.stringify({ ok: true, status: "stage-18e-i-unpublished", head })}\n`);
