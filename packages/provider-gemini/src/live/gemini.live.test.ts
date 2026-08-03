import { describe, expect, it } from "vitest";
import { createInferenceRequest, createTrace } from "@ai-dev-os/providers";
import { createGeminiProvider, defaultGeminiConfiguration, type GeminiAuthorizationPort, type GeminiCredentialPort } from "../index.js";

const enabled = process.env["AI_DEV_OS_LIVE_GEMINI"] === "1" && typeof process.env["GEMINI_API_KEY"] === "string";
describe.skipIf(!enabled)("Gemini live canary", () => {
  it("performs one low-token native explicit-model request", async () => {
    const key = process.env["GEMINI_API_KEY"]!;
    const authorization: GeminiAuthorizationPort = { authorize: async () => ({ decisionFingerprint: "live-canary" }) };
    const credentials: GeminiCredentialPort = { withApiKey: async <T>(_request: unknown, use: (value: string) => Promise<T>) => use(key) };
    const provider = createGeminiProvider({ configuration: defaultGeminiConfiguration({ instanceId: "gemini-live", streaming: "never" }), authorization, credentials });
    const operation = await provider.start(createInferenceRequest({ requestId: "gemini-live", modelId: "gemini-3.5-flash", messages: [{ role: "user", parts: [{ type: "text", text: `Reply with stage12-gemini-${Date.now()}` }] }], maxOutputTokens: 24, disclosure: { classification: "public", requiredLocality: "any", redactionApplied: false, decisionRef: null, retentionAllowed: false, loggingAllowed: false }, trace: createTrace("trace-gemini-live") }));
    expect((await operation.result).messages.length).toBeGreaterThan(0); await provider.close();
  });
});
