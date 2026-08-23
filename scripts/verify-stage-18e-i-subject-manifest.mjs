import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
} from "./stage-18e-i-subject-manifest-lib.mjs";

if (process.argv.length !== 2) throw new Error("SUBJECT_VERIFIER_ARGUMENTS_REFUSED");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const head = resolveCommit(root, "HEAD");
const { raw, manifest } = readCommittedSubjectManifest(root, head);
if (typeof manifest !== "object" || manifest === null || typeof manifest.baseCommit !== "string" || typeof manifest.sourceCommit !== "string") throw new Error("SUBJECT_MANIFEST_SHAPE_REFUSED");
assertStage18eIManifestBase(manifest);
const parents = String(runGit(root, ["rev-list", "--parents", "-n", "1", head])).trim().split(/\s+/u);
if (parents.length !== 2 || parents[1] !== manifest.sourceCommit) throw new Error("SUBJECT_MANIFEST_PARENT_DRIFT");
const changes = parseNameStatusZ(runGit(root, ["diff", "--name-status", "-z", "--no-renames", parents[1], head], { binary: true }));
if (changes.length !== 1 || changes[0]?.status !== "A" || changes[0]?.path !== STAGE_18E_I_MANIFEST_PATH) throw new Error("SUBJECT_MANIFEST_COMMIT_NOT_MANIFEST_ONLY");
const expected = collectSubjectManifest(root, STAGE_18E_I_BASE_COMMIT, parents[1]);
assertManifestEquivalent(manifest, expected);
if (raw !== serializeSubjectManifest(expected)) throw new Error("SUBJECT_MANIFEST_SERIALIZATION_DRIFT");
process.stdout.write(`${JSON.stringify({ ok: true, head, sourceCommit: expected.sourceCommit, sourceTree: expected.sourceTree, fileCount: expected.inventory.blobPathCount, aggregateSha256: expected.aggregateSha256 })}\n`);
