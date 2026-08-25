import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveCommit,
  verifyStage18eIPublishedAnchor,
} from "./stage-18e-i-subject-manifest-lib.mjs";

if (process.argv.length !== 2) throw new Error("SUBJECT_VERIFIER_ARGUMENTS_REFUSED");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const head = resolveCommit(root, "HEAD");
const published = verifyStage18eIPublishedAnchor(root);
if (head !== published.head) throw new Error("SUBJECT_VERIFIER_REQUIRES_EXACT_PUBLISHED_HEAD");
process.stdout.write(`${JSON.stringify({ ok: true, head, sourceCommit: published.sourceCommit, sourceTree: published.sourceTree, fileCount: published.fileCount, aggregateSha256: published.aggregateSha256 })}\n`);
