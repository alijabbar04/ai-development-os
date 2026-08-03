import { describe, expect, it } from "vitest";
import { createInferenceRequest, createTrace } from "@ai-dev-os/providers";
import { createOpenAiCompatibleProvider, defaultOpenAiCompatibleConfiguration, type ProviderAccessPort } from "../index.js";

const enabled = process.env["AI_DEV_OS_LIVE_CEREBRAS"] === "1" && typeof process.env["CEREBRAS_API_KEY"] === "string";
describe.skipIf(!enabled)("Cerebras live canary", () => {
  it("performs one low-token explicit-model request", async () => {
    const key = process.env["CEREBRAS_API_KEY"]!;
    const access: ProviderAccessPort = { withAuthorizedApiKey: async <T>(_request: unknown, use: (value: string) => Promise<T>) => use(key) };
    const provider = createOpenAiCompatibleProvider({ configuration: defaultOpenAiCompatibleConfiguration({ instanceId: "cerebras-live", profileId: "cerebras-chat-completions-v2", modelId: "gpt-oss-120b", catalogModelId: "gpt-oss-120b", streaming: "never" }), access });
    const operation = await provider.start(createInferenceRequest({ requestId: "cerebras-live", modelId: "gpt-oss-120b", messages: [{ role: "user", parts: [{ type: "text", text: `Reply with stage12-cerebras-${Date.now()}` }] }], maxOutputTokens: 24, disclosure: { classification: "public", requiredLocality: "any", redactionApplied: false, decisionRef: null, retentionAllowed: false, loggingAllowed: false }, trace: createTrace("trace-cerebras-live") }));
    expect((await operation.result).messages.length).toBeGreaterThan(0); await provider.close();
  });
});
