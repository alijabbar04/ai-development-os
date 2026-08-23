import { access, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertStage18eIBaseCommit,
  collectSubjectManifest,
  resolveCommit,
  runGit,
  serializeSubjectManifest,
  STAGE_18E_I_BASE_COMMIT,
  STAGE_18E_I_MANIFEST_PATH,
} from "./stage-18e-i-subject-manifest-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const base = args.filter((value) => value.startsWith("--base="));
const source = args.filter((value) => value.startsWith("--source="));
if (base.length !== 1 || source.length > 1 || args.length !== base.length + source.length) {
  throw new Error("SUBJECT_GENERATOR_ARGUMENTS_REFUSED");
}
const sourceCommit = resolveCommit(root, source[0]?.slice("--source=".length) ?? "HEAD");
assertStage18eIBaseCommit(resolveCommit(root, base[0].slice("--base=".length)));
if (sourceCommit !== resolveCommit(root, "HEAD")) throw new Error("SUBJECT_GENERATOR_SOURCE_NOT_HEAD");
if (String(runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"])).length !== 0) {
  throw new Error("SUBJECT_GENERATOR_WORKTREE_NOT_CLEAN");
}
const target = resolve(root, STAGE_18E_I_MANIFEST_PATH);
try { await access(target); throw new Error("SUBJECT_GENERATOR_TARGET_EXISTS"); }
catch (error) {
  if (error instanceof Error && error.message === "SUBJECT_GENERATOR_TARGET_EXISTS") throw error;
  if ((error instanceof Error ? error : {}).code !== "ENOENT") throw new Error("SUBJECT_GENERATOR_TARGET_CHECK_FAILED");
}
const manifest = collectSubjectManifest(root, STAGE_18E_I_BASE_COMMIT, sourceCommit);
await writeFile(target, serializeSubjectManifest(manifest), { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({ ok: true, path: STAGE_18E_I_MANIFEST_PATH, sourceCommit: manifest.sourceCommit, sourceTree: manifest.sourceTree, fileCount: manifest.inventory.blobPathCount, aggregateSha256: manifest.aggregateSha256 })}\n`);
