import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertManifestEquivalent, collectSubjectManifest, parseNameStatusZ, readCommittedSubjectManifest, resolveCommit, runGit, serializeSubjectManifest, STAGE_18E_H_MANIFEST_PATH } from "./stage-18e-h-subject-manifest-lib.mjs";

if (process.argv.length !== 2) throw new Error("SUBJECT_VERIFIER_ARGUMENTS_REFUSED");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const head = resolveCommit(repositoryRoot, "HEAD");
const { raw, manifest: actual } = readCommittedSubjectManifest(repositoryRoot, head);
if (typeof actual !== "object" || actual === null || typeof actual.baseCommit !== "string" || typeof actual.sourceCommit !== "string") throw new Error("SUBJECT_MANIFEST_SHAPE_REFUSED");
const parents = String(runGit(repositoryRoot, ["rev-list", "--parents", "-n", "1", head])).trim().split(/\s+/u);
if (parents.length !== 2) throw new Error("SUBJECT_MANIFEST_COMMIT_PARENT_COUNT_REFUSED");
const parent = parents[1];
if (actual.sourceCommit !== parent) throw new Error("SUBJECT_MANIFEST_PARENT_DRIFT");
const manifestCommitChanges = parseNameStatusZ(runGit(repositoryRoot, ["diff", "--name-status", "-z", "--no-renames", parent, head], { binary: true }));
if (manifestCommitChanges.length !== 1 || manifestCommitChanges[0]?.status !== "A" || manifestCommitChanges[0]?.path !== STAGE_18E_H_MANIFEST_PATH) throw new Error("SUBJECT_MANIFEST_COMMIT_NOT_MANIFEST_ONLY");
const expected = collectSubjectManifest(repositoryRoot, actual.baseCommit, parent);
assertManifestEquivalent(actual, expected);
if (raw !== serializeSubjectManifest(expected)) throw new Error("SUBJECT_MANIFEST_SERIALIZATION_DRIFT");
process.stdout.write(`${JSON.stringify({ ok: true, head, sourceCommit: expected.sourceCommit, sourceTree: expected.sourceTree, fileCount: expected.inventory.blobPathCount, aggregateSha256: expected.aggregateSha256 })}\n`);
