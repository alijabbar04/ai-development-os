import { describe, expect, it } from "vitest";
import { summarizeThinkerResult } from "../thinker.js";
import type { ThinkerContractHarness } from "./fixtures.js";

export function describeThinkerBackendContract(
  name: string,
  create: () => ThinkerContractHarness
): void {
  describe(`thinker backend contract: ${name}`, () => {
    it("invokes exactly one selected inference target and seals an authority-free proposal", async () => {
      const harness = create();
      const result = await harness.thinker.think(harness.request);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.authority).toBe("none");
      expect(result.value.proposal.tasks).toHaveLength(1);
      expect(result.value.proposalFingerprint).toMatch(/^[0-9a-f]{64}$/u);
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.proposal.tasks[0])).toBe(true);
      const totalInvocations =
        harness.port.primaryInvocationCount() + harness.port.alternateInvocationCount();
      expect(totalInvocations).toBe(1);
      expect(harness.port.preflightCount()).toBe(1);
      await harness.close();
    });

    it("sends a strict structured-output request with no tools", async () => {
      const harness = create();
      const result = await harness.thinker.think(harness.request);
      expect(result.ok).toBe(true);
      const request = harness.port.capturedRequests[0]!;
      expect(request.tools).toEqual([]);
      expect(request.toolChoice).toEqual({ mode: "none" });
      expect(request.structuredOutput?.strict).toBe(true);
      expect(request.messages.map((message) => message.role)).toEqual([
        "system",
        "developer",
        "user"
      ]);
      await harness.close();
    });

    it("returns only body-free summaries and stable target metadata", async () => {
      const harness = create();
      const result = await harness.thinker.think(harness.request);
      const summary = summarizeThinkerResult(result);
      expect(JSON.stringify(summary)).not.toContain("bounded implementation proposal");
      if (summary.outcome === "succeeded") {
        expect(summary.authority).toBe("none");
        expect(summary.targetFingerprint).toMatch(/^[0-9a-f]{64}$/u);
        expect(summary.totalTokens).toBe(200);
      }
      await harness.close();
    });
  });
}
