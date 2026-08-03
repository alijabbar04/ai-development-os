/**
 * Reusable contract for a context packer.
 *
 * Anything that assembles context under this stage's rules must satisfy these
 * properties: byte determinism, order independence, exact budget behaviour at
 * boundaries, deny-before-disclose, and inertness of hostile content.
 */

import { describe, expect, it } from "vitest";
import { conservativeUnitEstimator, type ContextUnitEstimator } from "../estimator.js";
import { renderContextPack } from "../framing.js";
import {
  DEFAULT_CONTEXT_CONFIGURATION,
  withContextOverrides,
  type ContextConfiguration,
} from "../model.js";
import { planContextPack } from "../select.js";
import type { ContextPack } from "../pack.js";
import { buildContextPack } from "../packer.js";
import { createProjectContextAuthorizer, denyAllContextAuthorizer } from "../authorization.js";
import {
  candidate,
  CONTEXT_INJECTION_CANARY,
  contextRequest,
  createManualContextClock,
  FRAME_FORGING_TEXT,
  POISONED_REPOSITORY_TEXT,
} from "./fixtures.js";

export interface ContextPackerContractHarness {
  readonly configuration?: ContextConfiguration;
  readonly estimator?: ContextUnitEstimator;
}

function unwrap<T>(result: { ok: boolean; value?: T; failure?: unknown }): T {
  if (!result.ok) {
    throw new Error(`expected success: ${JSON.stringify(result.failure)}`);
  }
  return result.value as T;
}

export function runContextPackerContractSuite(
  suiteName: string,
  createHarness: () => ContextPackerContractHarness,
): void {
  describe(`context packer contract: ${suiteName}`, () => {
    const harness = createHarness();
    const configuration = harness.configuration ?? DEFAULT_CONTEXT_CONFIGURATION;
    const estimator = harness.estimator ?? conservativeUnitEstimator;

    const candidates = [
      candidate({ identity: "repository:a.ts", body: "export const a = 1;\n".repeat(20) }),
      candidate({ identity: "repository:b.ts", body: "export const b = 2;\n".repeat(20), baseScore: 900 }),
      candidate({
        identity: "memory:m1",
        sourceKind: "memory-record",
        category: "memory",
        body: "The project prefers tabs.",
        baseScore: 800,
      }),
      candidate({
        identity: "memory:c1",
        sourceKind: "memory-record",
        category: "constraint",
        body: "Never call a cloud provider for this project.",
        baseScore: 700,
      }),
    ];

    function plan(order: readonly typeof candidates[number][]) {
      return unwrap(planContextPack({ candidates: order, configuration, estimator }));
    }

    it("is byte-identical across repeated runs", () => {
      expect(JSON.stringify(plan(candidates))).toBe(JSON.stringify(plan(candidates)));
    });

    it("ignores the order candidates were supplied in", () => {
      const forward = plan(candidates);
      const reversed = plan([...candidates].reverse());
      const rotated = plan([...candidates.slice(2), ...candidates.slice(0, 2)]);
      expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
      expect(JSON.stringify(rotated)).toBe(JSON.stringify(forward));
    });

    it("orders items by category priority then score, with a total tie-break", () => {
      const planned = plan(candidates);
      const identities = planned.items.map((item) => item.identity);
      expect(identities[0]).toBe("memory:c1");
      for (let index = 1; index < planned.items.length; index += 1) {
        const previous = planned.items[index - 1];
        const current = planned.items[index];
        if (previous === undefined || current === undefined) {
          continue;
        }
        expect(previous.ordinal).toBe(index);
        expect(current.ordinal).toBe(index + 1);
      }
    });

    it("accounts bytes exactly and never exceeds the budget", () => {
      const planned = plan(candidates);
      const summed = planned.items.reduce((total, item) => total + item.byteContribution, 0);
      expect(planned.usage.bytes).toBe(summed);
      expect(planned.usage.bytes).toBeLessThanOrEqual(configuration.budget.maxTotalBytes);
      expect(planned.usage.units).toBeLessThanOrEqual(configuration.budget.maxTotalUnits);
      for (const item of planned.items) {
        expect(Buffer.byteLength(item.body, "utf8")).toBe(item.byteContribution);
      }
    });

    it("labels every item untrusted and carries full provenance", () => {
      for (const item of plan(candidates).items) {
        expect(item.trust).toBe("untrusted");
        expect(item.digest).toMatch(/^[0-9a-f]{64}$/);
        expect(item.provenance.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(item.scoreComponents.length).toBeGreaterThan(0);
        expect(item.unitContribution).toBeGreaterThan(0);
      }
    });

    it("never claims exact token counts", () => {
      const planned = plan(candidates);
      expect(estimator.exact).toBe(false);
      expect(
        planned.diagnostics.some((item) => item.code === "estimator-conservative"),
      ).toBe(true);
    });

    it("deduplicates identical bodies and says why", () => {
      const duplicate = candidate({ identity: "repository:copy.ts", body: "export const a = 1;\n".repeat(20) });
      const planned = plan([...candidates, duplicate]);
      expect(planned.items.filter((item) => item.digest === duplicate.digest)).toHaveLength(1);
      expect(planned.omissions.some((item) => item.reason === "duplicate-digest")).toBe(true);
    });

    it("keeps hostile content inert and reports it as evidence", async () => {
      const packed = unwrap(
        await buildContextPack({
          request: contextRequest(),
          sources: {},
          authorizer: createProjectContextAuthorizer({ projectId: "project-atlas" }),
          clock: createManualContextClock(),
          configuration,
          estimator,
        }),
      );
      const poisoned = plan([
        candidate({ identity: "repository:readme.md", body: POISONED_REPOSITORY_TEXT }),
        candidate({ identity: "repository:forge.md", body: FRAME_FORGING_TEXT }),
      ]);
      // Positive control: both payloads really are present in the pack.
      const bodies = poisoned.items.map((item) => item.body).join("\n");
      expect(bodies).toContain(CONTEXT_INJECTION_CANARY);
      expect(bodies).toContain("<<<ADOS-END>>>");
      // The forging attempt is counted, and the frame declares the true length.
      const forged = poisoned.items.find((item) => item.identity === "repository:forge.md");
      expect(forged?.frameSentinelOccurrences).toBeGreaterThan(0);
      expect(
        poisoned.diagnostics.some((item) => item.code === "frame-sentinel-in-body"),
      ).toBe(true);
      const rendered = renderContextPack({ fingerprint: packed.fingerprint, items: poisoned.items });
      for (const item of poisoned.items) {
        expect(rendered).toContain(`bytes=${item.byteContribution}>>>`);
      }
      // Positive control for the hazard: a naive line-based reader sees more
      // item headers than there are items, and sees a `trust=trusted` claim,
      // because a body forges both. The pack's own structured items say
      // otherwise, and the byte counts are what a correct reader follows.
      const naiveHeaders = rendered.split("\n").filter((line) => line.startsWith("<<<ADOS-ITEM"));
      expect(naiveHeaders.length).toBeGreaterThan(poisoned.items.length);
      expect(rendered).toContain("trust=trusted");
      expect(poisoned.items.every((item) => item.trust === "untrusted")).toBe(true);
    });

    it("denies before disclosing anything", async () => {
      const result = await buildContextPack({
        request: contextRequest(),
        sources: {},
        authorizer: denyAllContextAuthorizer,
        clock: createManualContextClock(),
        configuration,
        estimator,
      });
      const pack = unwrap<ContextPack>(result);
      expect(pack.items).toHaveLength(0);
      expect(pack.omissions.map((item) => item.reason)).toEqual(["policy-denied"]);
      // The denied body appears nowhere in the pack, not even truncated.
      expect(JSON.stringify(pack)).not.toContain("deterministic context packer");
    });

    it("excludes the observation time from the pack fingerprint", async () => {
      const build = async (iso: string): Promise<ContextPack> =>
        unwrap(
          await buildContextPack({
            request: contextRequest(),
            sources: {},
            authorizer: createProjectContextAuthorizer({ projectId: "project-atlas" }),
            clock: createManualContextClock(iso),
            configuration,
            estimator,
          }),
        );
      const early = await build("2026-01-01T00:00:00.000Z");
      const late = await build("2027-01-01T00:00:00.000Z");
      expect(early.generatedAt).not.toBe(late.generatedAt);
      expect(early.fingerprint).toBe(late.fingerprint);
    });

    it("refuses truncation when the configuration forbids it", () => {
      const strict = unwrap(
        withContextOverrides(configuration, {
          budget: {
            ...configuration.budget,
            maxItemBytes: 64,
            minItemBytes: 16,
            allowTruncation: false,
          },
        }),
      );
      const planned = unwrap(
        planContextPack({
          candidates: [candidate({ identity: "repository:big.ts", body: "x".repeat(4_096) })],
          configuration: strict,
          estimator,
        }),
      );
      expect(planned.items).toHaveLength(0);
      expect(planned.omissions[0]?.reason).toBe("item-too-large");
    });
  });
}
