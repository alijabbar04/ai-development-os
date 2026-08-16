import { describe, expect, it } from "vitest";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import {
  PRODUCTION_ADMISSION_RULE_IDS,
  PRODUCTION_EFFECT_CLASSES,
  STAGE_18D_APPLICATION_PRODUCTION_ENABLED,
  createProductionAdmissionGate,
  createProductionDisabledApplication,
} from "../src/index.js";

describe("Stage 18D refusal-only production admission", () => {
  it("returns a stable non-authorizing refusal for every effect class", () => {
    const gate = createProductionAdmissionGate();
    expect(gate.productionEnabled).toBe(false);
    expect(STAGE_18D_APPLICATION_PRODUCTION_ENABLED).toBe(false);
    for (const effectClass of PRODUCTION_EFFECT_CLASSES) {
      const request = {
        schemaVersion: 1 as const,
        effectClass,
        workId: "work:1",
        dispatchId: "dispatch:1",
      };
      const first = gate.evaluate(request);
      const second = gate.evaluate(JSON.parse(JSON.stringify(request)));
      expect(first).toEqual(second);
      expect(first).toMatchObject({
        schemaVersion: 1,
        admitted: false,
        productionEnabled: false,
        grantsAuthority: false,
        resumableByHumanApproval: false,
        stage17Status: "safety-gated",
        ruleIds: [
          "admission.stage18d.production-disabled",
          "admission.stage17.evidence-unavailable",
          "admission.effect.not-wired",
        ],
      });
      expect(first.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect("receipt" in first).toBe(false);
      expect("authority" in first).toBe(false);
    }
  });

  it.each([
    null,
    {},
    { schemaVersion: 2, effectClass: "provider" },
    { schemaVersion: 1, effectClass: "unknown" },
    { schemaVersion: 1, effectClass: "provider", extra: true },
    { schemaVersion: 1, effectClass: "provider", workId: "bad id" },
  ])("fails malformed or unknown input closed without a diagnostic identity", (input) => {
    const refusal = createProductionAdmissionGate().evaluate(input);
    expect(refusal.requestFingerprint).toBeNull();
    expect(refusal.ruleIds[0]).toBe("admission.request.invalid");
    expect(refusal.admitted).toBe(false);
  });

  it("has a finite closed rule vocabulary and cannot be resumed by human approval", () => {
    expect(PRODUCTION_ADMISSION_RULE_IDS).toEqual([
      "admission.request.invalid",
      "admission.stage18d.production-disabled",
      "admission.stage17.evidence-unavailable",
      "admission.effect.not-wired",
    ]);
    const gate = createProductionAdmissionGate();
    expect(() => gate.assertAdmitted({
      schemaVersion: 1,
      effectClass: "production-registration",
      humanApproved: true,
    })).toThrowError(expect.objectContaining({ code: "PRODUCTION_DISABLED" }));
    const { assertAdmitted } = gate;
    expect(() => assertAdmitted({
      schemaVersion: 1,
      effectClass: "production-registration",
    })).toThrowError(expect.objectContaining({ code: "PRODUCTION_DISABLED" }));
  });

  it("refuses before usage/provider callbacks or any application effect", async () => {
    let reads = 0;
    const application = createProductionDisabledApplication({
      persistence: createMemoryPersistenceAdapter(),
      usageAdapter: {
        adapterId: "adapter:admission-test",
        schemaVersion: 3,
        readAuthorizedSnapshot: async () => {
          reads += 1;
          return null;
        },
      },
    });
    expect(() => application.admission.assertAdmitted({
      schemaVersion: 1,
      effectClass: "network",
    })).toThrowError(expect.objectContaining({ code: "PRODUCTION_DISABLED" }));
    expect(() => application.assertProductionEffectDisabled("git")).toThrowError(
      expect.objectContaining({ code: "PRODUCTION_DISABLED" }),
    );
    expect(reads).toBe(0);
    await application.close();
  });
});
