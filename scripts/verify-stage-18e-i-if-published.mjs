import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGE_18E_I_MANIFEST_PATH } from "./stage-18e-i-subject-manifest-lib.mjs";

if (process.argv.length !== 2) throw new Error("SUBJECT_CONDITIONAL_VERIFIER_ARGUMENTS_REFUSED");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const present = spawnSync("git", ["cat-file", "-e", `HEAD:${STAGE_18E_I_MANIFEST_PATH}`], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
});
if (present.status === 0) await import("./verify-stage-18e-i-subject-manifest.mjs");
else process.stdout.write(`${JSON.stringify({ ok: true, status: "stage-18e-i-unpublished" })}\n`);
