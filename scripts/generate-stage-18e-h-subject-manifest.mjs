import { access, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSubjectManifest, resolveCommit, runGit, serializeSubjectManifest, STAGE_18E_H_MANIFEST_PATH } from "./stage-18e-h-subject-manifest-lib.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);
const baseArgument = arguments_.find((argument) => argument.startsWith("--base="));
const sourceArgument = arguments_.find((argument) => argument.startsWith("--source="));
if (baseArgument === undefined || arguments_.some((argument) => !argument.startsWith("--base=") && !argument.startsWith("--source=")) || arguments_.filter((argument) => argument.startsWith("--base=")).length !== 1 || arguments_.filter((argument) => argument.startsWith("--source=")).length > 1) throw new Error("SUBJECT_GENERATOR_ARGUMENTS_REFUSED");
const baseRevision = baseArgument.slice("--base=".length);
const sourceRevision = sourceArgument?.slice("--source=".length) ?? "HEAD";
const sourceCommit = resolveCommit(repositoryRoot, sourceRevision);
if (sourceCommit !== resolveCommit(repositoryRoot, "HEAD")) throw new Error("SUBJECT_GENERATOR_SOURCE_NOT_HEAD");
const status = String(runGit(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]));
if (status.length !== 0) throw new Error("SUBJECT_GENERATOR_WORKTREE_NOT_CLEAN");
const target = resolve(repositoryRoot, STAGE_18E_H_MANIFEST_PATH);
try { await access(target); throw new Error("SUBJECT_GENERATOR_TARGET_EXISTS"); }
catch (error) {
  if (error instanceof Error && error.message === "SUBJECT_GENERATOR_TARGET_EXISTS") throw error;
  if ((error instanceof Error ? error : {}).code !== "ENOENT") throw new Error("SUBJECT_GENERATOR_TARGET_CHECK_FAILED");
}
const manifest = collectSubjectManifest(repositoryRoot, baseRevision, sourceCommit);
await writeFile(target, serializeSubjectManifest(manifest), { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({ ok: true, path: STAGE_18E_H_MANIFEST_PATH, sourceCommit: manifest.sourceCommit, sourceTree: manifest.sourceTree, fileCount: manifest.inventory.blobPathCount, aggregateSha256: manifest.aggregateSha256 })}\n`);
