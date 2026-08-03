import { describe, expect, it } from "vitest";
import { createInferenceRequest, createTrace, ProviderError, type InferenceRequest } from "@ai-dev-os/providers";
import { createOpenAiCompatibleProvider } from "../provider.js";
import { defaultOpenAiCompatibleConfiguration } from "../config.js";
import { getOpenAiCompatibleProfile } from "../profiles.js";
import type { HttpRequest, HttpResponse, HttpTransport, OpenAiCompatibleProfileId, ProviderAccessPort } from "../types.js";

const encoder = new TextEncoder();
async function* bytes(value: string): AsyncIterable<Uint8Array> { yield encoder.encode(value); }

export interface OpenAiCompatibleProfileContractCase {
  readonly profileId: OpenAiCompatibleProfileId;
  readonly instanceId: string;
  readonly contractModelId: string;
  readonly catalogModelId: string;
}

class ProbeTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly response: HttpResponse) {}
  async send(request: HttpRequest): Promise<HttpResponse> { this.requests.push(request); return this.response; }
}

function request(item: OpenAiCompatibleProfileContractCase, suffix: string, overrides: Record<string, unknown> = {}): InferenceRequest {
  return createInferenceRequest({
    requestId: `${item.instanceId}-${suffix}`,
    modelId: item.contractModelId,
    messages: [{ role: "user", parts: [{ type: "text", text: "synthetic contract probe" }] }],
    disclosure: { classification: "public", requiredLocality: "any", redactionApplied: false, decisionRef: null, retentionAllowed: false, loggingAllowed: false },
    trace: createTrace(`trace-${item.instanceId}-${suffix}`),
    ...overrides,
  });
}

function completion(item: OpenAiCompatibleProfileContractCase): HttpResponse {
  return Object.freeze({
    status: 200,
    headers: Object.freeze({}),
    body: bytes(JSON.stringify({ model: item.catalogModelId, choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 2, completion_tokens: 1 } })),
  });
}

/** Reusable finite-profile contract. Call once with every profile a package ships. */
export function runOpenAiCompatibleProfileContractSuite(cases: readonly OpenAiCompatibleProfileContractCase[]): void {
  for (const item of cases) describe(`OpenAI-compatible profile contract: ${item.profileId}`, () => {
    it("invokes only its fixed endpoint, headers, and exact upstream model", async () => {
      const profile = getOpenAiCompatibleProfile(item.profileId);
      const transport = new ProbeTransport(completion(item));
      let accessCalls = 0;
      const access: ProviderAccessPort = { async withAuthorizedApiKey(_request, use) { accessCalls += 1; return use("profile-contract-key"); } };
      const provider = createOpenAiCompatibleProvider({
        configuration: defaultOpenAiCompatibleConfiguration({ instanceId: item.instanceId, profileId: item.profileId, modelId: item.contractModelId, catalogModelId: item.catalogModelId, streaming: "never" }),
        access,
        transport,
        clock: { now: () => new Date("2026-08-03T12:00:00.000Z") },
      });
      const operation = await provider.start(request(item, "success"));
      expect((await operation.result).messages[0]?.parts[0]).toEqual({ type: "text", text: "ok" });
      expect(accessCalls).toBe(1);
      expect(transport.requests).toHaveLength(1);
      const sent = transport.requests[0]!;
      expect(sent).toMatchObject({ url: `${profile.origin}${profile.path}`, method: "POST", redirect: "reject" });
      expect(sent.headers).toMatchObject({ Authorization: "Bearer profile-contract-key", ...profile.fixedHeaders });
      const body = JSON.parse(sent.body) as Record<string, unknown>;
      expect(body["model"]).toBe(item.catalogModelId);
      expect(JSON.stringify(body)).not.toContain("profile-contract-key");
      if (item.profileId === "openrouter-chat-completions-v1") expect(body["provider"]).toEqual({ allow_fallbacks: false, require_parameters: true, data_collection: "deny" });
      await provider.close();
    });

    it("rejects a model mismatch before policy, secret, or network effects", async () => {
      const transport = new ProbeTransport(completion(item));
      let accessCalls = 0;
      const provider = createOpenAiCompatibleProvider({
        configuration: defaultOpenAiCompatibleConfiguration({ instanceId: item.instanceId, profileId: item.profileId, modelId: item.contractModelId, catalogModelId: item.catalogModelId, streaming: "never" }),
        access: { async withAuthorizedApiKey() { accessCalls += 1; throw new Error("must not run"); } },
        transport,
      });
      await expect(provider.start(request(item, "mismatch", { modelId: "different-model" }))).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
      expect(accessCalls).toBe(0);
      expect(transport.requests).toHaveLength(0);
      await provider.close();
    });

    it("keeps a denied credential canary out of events and transport", async () => {
      const transport = new ProbeTransport(completion(item));
      const provider = createOpenAiCompatibleProvider({
        configuration: defaultOpenAiCompatibleConfiguration({ instanceId: item.instanceId, profileId: item.profileId, modelId: item.contractModelId, catalogModelId: item.catalogModelId, streaming: "never" }),
        access: { async withAuthorizedApiKey() { throw new ProviderError("POLICY_DENIED", "profile access denied", {}); } },
        transport,
      });
      const operation = await provider.start(request(item, "denied"));
      await expect(operation.result).rejects.toMatchObject({ code: "POLICY_DENIED" });
      const events: unknown[] = [];
      for await (const event of operation.events()) events.push(event);
      expect(JSON.stringify(events)).not.toContain("profile-contract-key");
      expect(transport.requests).toHaveLength(0);
      await provider.close();
    });
  });
}
