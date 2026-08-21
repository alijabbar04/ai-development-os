import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REGENERATE_EVIDENCE_ARGUMENT, selectSmokePreview } from "../scripts/smoke-preview-policy.mjs";

const options = Object.freeze({ smokeRoot: resolve("C:/synthetic-smoke-root"), committedPreview: resolve("C:/synthetic-repository/docs/release-evidence/stage-18e-h-credential-setup.png") });

describe("real-Electron smoke preview policy", () => {
  it("routes ordinary smoke output only beneath its temporary root", () => {
    const selected = selectSmokePreview([], options);
    expect(selected).toEqual({ path: resolve(options.smokeRoot, "default", "preview.png"), regeneratesEvidence: false });
    expect(selected.path).not.toBe(options.committedPreview);
  });

  it("routes the one explicit regeneration mode to the one committed evidence path", () => {
    expect(selectSmokePreview([REGENERATE_EVIDENCE_ARGUMENT], options)).toEqual({ path: options.committedPreview, regeneratesEvidence: true });
  });

  it.each([
    ["--smoke-preview=C:/arbitrary.png"],
    ["--destination=C:/arbitrary.png"],
    [REGENERATE_EVIDENCE_ARGUMENT, "--destination=C:/arbitrary.png"],
    [REGENERATE_EVIDENCE_ARGUMENT, REGENERATE_EVIDENCE_ARGUMENT],
    ["--unknown"],
  ])("refuses custom, extra, duplicate, and ambiguous arguments: %j", (...arguments_) => {
    expect(() => selectSmokePreview(arguments_, options)).toThrow(/SMOKE_PREVIEW_ARGUMENTS_REFUSED/u);
  });
});
