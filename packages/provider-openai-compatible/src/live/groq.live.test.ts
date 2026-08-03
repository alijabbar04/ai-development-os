import { describe, expect, it } from "vitest";
import { createInferenceRequest, createTrace } from "@ai-dev-os/providers";
import { createOpenAiCompatibleProvider, defaultOpenAiCompatibleConfiguration, type ProviderAccessPort } from "../index.js";

const enabled = process.env["AI_DEV_OS_LIVE_GROQ"] === "1" && typeof process.env["GROQ_API_KEY"] === "string";
describe.skipIf(!enabled)("Groq live canary", () => {
  it("performs one low-token explicit-model request", async () => {
    const key = process.env["GROQ_API_KEY"]!;
    const access: ProviderAccessPort = { withAuthorizedApiKey: async <T>(_request: unknown, use: (value: string) => Promise<T>) => use(key) };
    const provider = createOpenAiCompatibleProvider({ configuration: defaultOpenAiCompatibleConfiguration({ instanceId: "groq-live", profileId: "groq-chat-completions-v1", modelId: "gpt-oss-120b", catalogModelId: "openai/gpt-oss-120b", streaming: "never" }), access });
    const marker = `stage12-groq-${Date.now()}`;
    const operation = await provider.start(createInferenceRequest({ requestId: "groq-live", modelId: "gpt-oss-120b", messages: [{ role: "user", parts: [{ type: "text", text: `Reply with ${marker}` }] }], maxOutputTokens: 24, disclosure: { classification: "public", requiredLocality: "any", redactionApplied: false, decisionRef: null, retentionAllowed: false, loggingAllowed: false }, trace: createTrace("trace-groq-live") }));
    const result = await operation.result; expect(result.messages.length).toBeGreaterThan(0); expect(result.usage.tokens.outputTokens + result.usage.tokens.reasoningTokens).toBeGreaterThanOrEqual(0); await provider.close();
  });
});
