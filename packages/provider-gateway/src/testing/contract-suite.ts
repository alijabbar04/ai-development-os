import { describe, expect, it } from "vitest";
import type { InferenceRequest } from "@ai-dev-os/providers";
import type { ProviderGateway } from "../types.js";

export interface ProviderGatewayContractHarness {
  readonly gateway: ProviderGateway;
  readonly primaryInstanceId: string;
  readonly secondaryInstanceId: string;
  readonly request: InferenceRequest;
  readonly mismatchedRequest: InferenceRequest;
  primaryInvocationCount(): number;
  secondaryInvocationCount(): number;
  close(): Promise<void>;
}

export function describeProviderGatewayContract(name: string, create: () => Promise<ProviderGatewayContractHarness>): void {
  describe(`provider gateway contract: ${name}`, () => {
    it("lists immutable deterministic configuration separately from runtime observations", async () => {
      const harness = await create();
      const first = harness.gateway.listInstances();
      expect(Object.isFrozen(first)).toBe(true);
      expect(first.map((item) => item.instanceId)).toEqual([...first.map((item) => item.instanceId)].sort());
      expect(harness.gateway.fingerprint()).toMatch(/^[a-f0-9]{64}$/u);
      await harness.close();
    });

    it("invokes only the explicitly selected instance", async () => {
      const harness = await create();
      const operation = await harness.gateway.invoke({ instanceId: harness.primaryInstanceId, request: harness.request });
      await operation.result.catch(() => undefined);
      expect(harness.primaryInvocationCount()).toBe(1);
      expect(harness.secondaryInvocationCount()).toBe(0);
      await harness.close();
    });

    it("rejects absent instances and model mismatches before provider invocation", async () => {
      const harness = await create();
      expect(() => harness.gateway.preflight({ instanceId: "absent-instance", request: harness.request })).toThrowError(expect.objectContaining({ code: "MODEL_UNAVAILABLE" }));
      expect(() => harness.gateway.preflight({ instanceId: harness.primaryInstanceId, request: harness.mismatchedRequest })).toThrowError(expect.objectContaining({ code: "MODEL_UNAVAILABLE" }));
      expect(harness.primaryInvocationCount()).toBe(0);
      expect(harness.secondaryInvocationCount()).toBe(0);
      await harness.close();
    });
  });
}
