import { join, resolve } from "node:path";

export const REGENERATE_EVIDENCE_ARGUMENT = "--regenerate-evidence";

export function selectSmokePreview(arguments_, options) {
  if (!Array.isArray(arguments_) || typeof options !== "object" || options === null) throw new Error("SMOKE_PREVIEW_POLICY_INVALID");
  const smokeRoot = resolve(options.smokeRoot);
  const committedPreview = resolve(options.committedPreview);
  if (arguments_.length === 0) return Object.freeze({ path: join(smokeRoot, "default", "preview.png"), regeneratesEvidence: false });
  if (arguments_.length === 1 && arguments_[0] === REGENERATE_EVIDENCE_ARGUMENT) return Object.freeze({ path: committedPreview, regeneratesEvidence: true });
  throw new Error(`SMOKE_PREVIEW_ARGUMENTS_REFUSED: use no arguments for temporary smoke output or exactly ${REGENERATE_EVIDENCE_ARGUMENT} for the reviewed evidence destination`);
}
