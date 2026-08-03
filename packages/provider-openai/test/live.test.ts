import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenUsage } from "@ai-dev-os/domain";
import { createInferenceRequest, createTrace, parseDisclosureContext } from "@ai-dev-os/providers";
import { parseSecretRef, type SecretRef } from "@ai-dev-os/secrets";
import {
  computeCost,
  createOpenAiAdapterConfiguration,
  createOpenAiProvider,
  createStaticSafetyIdentifierPort,
  parseOpenAiModelCatalog,
  selectCatalogEntry,
  type CredentialPort,
  type DisclosurePort,
  type OpenAiInferenceProvider,
} from "../src/index.js";

/**
 * Opt-in, budget-capped live canary against the real OpenAI API.
 *
 * Opt-in requires ALL of the following, with no defaults:
 *
 *   AI_DEV_OS_OPENAI_LIVE=1                 explicit opt-in
 *   AI_DEV_OS_OPENAI_LIVE_API_KEY           the API key to use
 *   AI_DEV_OS_OPENAI_LIVE_MODEL             the exact model id to call
 *   AI_DEV_OS_OPENAI_LIVE_INPUT_MICROS      input price, micros per 1e6 tokens
 *   AI_DEV_OS_OPENAI_LIVE_OUTPUT_MICROS     output price, micros per 1e6 tokens
 *   AI_DEV_OS_OPENAI_LIVE_MAX_COST_MICROS   hard preflight ceiling
 *
 * There is deliberately NO default model: this package ships no model ids
 * or prices, and choosing one implicitly could bill an account for a model
 * the operator never approved. Pricing is required so the preflight can
 * bound the maximum spend BEFORE any request is made.
 *
 * The canary sends a fixed harmless prompt, never any repository content,
 * caps output hard, and records neither the key nor the prompt.
 */
const LIVE = process.env["AI_DEV_OS_OPENAI_LIVE"];
const LIVE_API_KEY = process.env["AI_DEV_OS_OPENAI_LIVE_API_KEY"];
const LIVE_MODEL = process.env["AI_DEV_OS_OPENAI_LIVE_MODEL"];
const LIVE_INPUT_MICROS = process.env["AI_DEV_OS_OPENAI_LIVE_INPUT_MICROS"];
const LIVE_OUTPUT_MICROS = process.env["AI_DEV_OS_OPENAI_LIVE_OUTPUT_MICROS"];
const LIVE_MAX_COST_MICROS = process.env["AI_DEV_OS_OPENAI_LIVE_MAX_COST_MICROS"];

const ENABLED =
  LIVE === "1" &&
  typeof LIVE_API_KEY === "string" &&
  LIVE_API_KEY.length > 0 &&
  typeof LIVE_MODEL === "string" &&
  LIVE_MODEL.length > 0 &&
  typeof LIVE_INPUT_MICROS === "string" &&
  typeof LIVE_OUTPUT_MICROS === "string" &&
  typeof LIVE_MAX_COST_MICROS === "string";

/** Hard output cap for the canary; keeps the worst case tiny. */
const MAX_OUTPUT_TOKENS = 16;
/** Worst-case input assumption for the preflight estimate. */
const ASSUMED_MAX_INPUT_TOKENS = 200;

const LIVE_DISCLOSURE = parseDisclosureContext({
  classification: "public",
  requiredLocality: "any",
  redactionApplied: false,
  decisionRef: null,
  retentionAllowed: false,
  loggingAllowed: false,
});

const LIVE_KEY_REF: SecretRef = parseSecretRef({
  schemaVersion: 1,
  type: "environment",
  namespace: "openai",
  version: null,
  expectedKind: "text",
  providerInstanceId: null,
  variableName: "AI_DEV_OS_OPENAI_LIVE_API_KEY",
});

describe.skipIf(!ENABLED)("live OpenAI Responses canary (opt-in)", () => {
  let provider: OpenAiInferenceProvider;

  beforeAll(() => {
    const catalog = parseOpenAiModelCatalog({
      schemaVersion: 1,
      catalogVersion: "live-canary",
      source: "operator",
      entries: [
        {
          modelId: LIVE_MODEL!,
          contextWindowTokens: 8_000,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          supportsStructuredOutput: false,
          supportsToolCalling: false,
          supportsVision: false,
          supportsReasoning: false,
          supportedReasoningEfforts: [],
          supportsSampling: false,
          latencyClass: "standard",
          codingCapability: 3,
          reasoningCapability: 3,
          evidence: {
            source: "operator",
            observedAt: "1970-01-01T00:00:00.000Z",
            documentRevision: null,
          },
          effectiveFrom: "1970-01-01T00:00:00.000Z",
          effectiveTo: null,
          pricing: [
            {
              currency: "USD",
              inputMicrosPerMillionTokens: Number.parseInt(LIVE_INPUT_MICROS!, 10),
              cachedInputMicrosPerMillionTokens: null,
              cacheWriteMicrosPerMillionTokens: null,
              outputMicrosPerMillionTokens: Number.parseInt(LIVE_OUTPUT_MICROS!, 10),
              source: "operator",
              effectiveFrom: "1970-01-01T00:00:00.000Z",
              effectiveTo: null,
            },
          ],
        },
      ],
    });

    // PREFLIGHT: refuse to spend more than the declared ceiling.
    const entry = selectCatalogEntry(catalog, LIVE_MODEL!, new Date().toISOString());
    expect(entry, "the canary model must be effective in the catalog").not.toBeNull();
    const worstCase = computeCost(
      entry!,
      createTokenUsage({ inputTokens: ASSUMED_MAX_INPUT_TOKENS, outputTokens: MAX_OUTPUT_TOKENS }),
      0,
      new Date().toISOString(),
    );
    const ceiling = Number.parseInt(LIVE_MAX_COST_MICROS!, 10);
    expect(worstCase.money, "pricing must be known before spending").not.toBeNull();
    expect(
      worstCase.money!.amountMicros,
      `estimated worst-case cost ${worstCase.money!.amountMicros} micros exceeds the ceiling ${ceiling}`,
    ).toBeLessThanOrEqual(ceiling);

    const credentials: CredentialPort = {
      async withApiKey(_request, use) {
        return use(LIVE_API_KEY!);
      },
    };
    const disclosure: DisclosurePort = {
      async authorize() {
        return {
          allowed: true,
          denialCode: null,
          persistenceAllowed: false,
          temporaryServerStateAllowed: false,
          decisionFingerprint: null,
        };
      },
    };

    provider = createOpenAiProvider({
      configuration: createOpenAiAdapterConfiguration({
        instanceId: "openai-live-canary",
        apiKeyRef: LIVE_KEY_REF,
        permittedModels: [LIVE_MODEL!],
        catalog,
        supportedClassifications: ["public"],
        // No persistence, no background state, no reasoning disclosure.
        storage: { store: "never" },
        background: { mode: "disabled" },
      }),
      credentials,
      disclosure,
      safetyIdentifier: createStaticSafetyIdentifierPort("livecanary0000000000000000000000"),
    });
  });

  afterAll(async () => {
    await provider?.close();
  });

  it("completes a minimal request within the output cap", async () => {
    const request = createInferenceRequest({
      requestId: "live-canary-1",
      modelId: LIVE_MODEL!,
      // A fixed, harmless prompt. No repository content is ever sent.
      messages: [{ role: "user", parts: [{ type: "text", text: "Reply with the single word: ready" }] }],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      deadline: new Date(Date.now() + 120_000).toISOString(),
      disclosure: LIVE_DISCLOSURE,
      trace: createTrace("trace-live-openai"),
    });

    const operation = await provider.start(request);
    const result = await operation.result;

    expect(result.requestId).toBe(request.requestId);
    expect(result.usage.tokens.outputTokens).toBeLessThanOrEqual(MAX_OUTPUT_TOKENS * 4);
    expect(["stop", "length"]).toContain(result.finishReason);
    // Cost must be computable from the operator's pricing snapshot.
    expect(result.cost.locallyComputed).not.toBeNull();

    // Neither the key nor generated content is recorded anywhere here.
    const serialized = JSON.stringify({
      usage: result.usage,
      cost: result.cost,
      finishReason: result.finishReason,
    });
    expect(serialized).not.toContain(LIVE_API_KEY!);
  });

  it("reports models from the operator-supplied catalog only", async () => {
    const models = await provider.listModels();
    expect(models.map((descriptor) => descriptor.model.modelId)).toEqual([LIVE_MODEL!]);
  });
});

describe.skipIf(ENABLED)("live OpenAI Responses canary (skipped)", () => {
  it("is skipped without explicit opt-in, a key, a model, and a cost ceiling", () => {
    // Documents WHY the live suite did not run, so a green run is never
    // mistaken for live verification.
    expect(ENABLED).toBe(false);
  });
});
