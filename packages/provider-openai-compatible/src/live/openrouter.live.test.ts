import { describe, expect, it } from "vitest";
import { createInferenceRequest, createTrace } from "@ai-dev-os/providers";
import { createOpenAiCompatibleProvider, defaultOpenAiCompatibleConfiguration, type ProviderAccessPort } from "../index.js";

const enabled = process.env["AI_DEV_OS_LIVE_OPENROUTER"] === "1" && typeof process.env["OPENROUTER_API_KEY"] === "string";
describe.skipIf(!enabled)("OpenRouter live canary", () => {
  it("performs one low-token pinned-model no-fallback request", async () => {
    const key = process.env["OPENROUTER_API_KEY"]!;
    const access: ProviderAccessPort = { withAuthorizedApiKey: async <T>(_request: unknown, use: (value: string) => Promise<T>) => use(key) };
    const provider = createOpenAiCompatibleProvider({ configuration: defaultOpenAiCompatibleConfiguration({ instanceId: "openrouter-live", profileId: "openrouter-chat-completions-v1", modelId: "gpt-oss-20b-free", catalogModelId: "openai/gpt-oss-20b:free", streaming: "never" }), access });
    const operation = await provider.start(createInferenceRequest({ requestId: "openrouter-live", modelId: "gpt-oss-20b-free", messages: [{ role: "user", parts: [{ type: "text", text: `Reply with stage12-openrouter-${Date.now()}` }] }], maxOutputTokens: 24, disclosure: { classification: "public", requiredLocality: "any", redactionApplied: false, decisionRef: null, retentionAllowed: false, loggingAllowed: false }, trace: createTrace("trace-openrouter-live") }));
    expect((await operation.result).messages.length).toBeGreaterThan(0); await provider.close();
  });
});
