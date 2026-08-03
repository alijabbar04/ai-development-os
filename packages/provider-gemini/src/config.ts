import { DATA_CLASSIFICATIONS, validation } from "@ai-dev-os/domain";
import { BUILTIN_PROVIDER_CATALOG, resolveCatalogModel, resolveCatalogProvider } from "@ai-dev-os/provider-catalog";
import { ProviderError, parseProviderInstanceId } from "@ai-dev-os/providers";
import type { GeminiConfiguration } from "./types.js";

const { ensureEnum, ensureEnumArray, ensureExactKeys, ensureRecord, ensureSafeInteger, ensureString } = validation;
export const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com";

export function parseGeminiConfiguration(value: unknown): GeminiConfiguration {
  const input = ensureRecord(value, "configuration");
  ensureExactKeys(input, ["instanceId", "modelId", "catalogModelId", "streaming", "safetyMode", "supportedClassifications", "limits"], "configuration");
  const limits = ensureRecord(input["limits"], "configuration.limits");
  ensureExactKeys(limits, ["requestTimeoutMs", "maxResponseBytes", "maxStreamBytes", "maxSseEventBytes", "maxInlineImageBytes", "maxTotalInlineImageBytes"], "configuration.limits");
  const bounded = (key: string, max: number) => ensureSafeInteger(limits[key], `configuration.limits.${key}`, 1, max);
  const parsed = Object.freeze({
    instanceId: parseProviderInstanceId(input["instanceId"]),
    modelId: ensureString(input["modelId"], "configuration.modelId", { maxLength: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, patternName: "provider-contract model ID" }),
    catalogModelId: ensureString(input["catalogModelId"], "configuration.catalogModelId", { maxLength: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u, patternName: "Gemini model ID" }),
    streaming: ensureEnum(input["streaming"], "configuration.streaming", ["always", "never"] as const),
    safetyMode: ensureEnum(input["safetyMode"], "configuration.safetyMode", ["provider-default", "block-medium-and-above"] as const),
    supportedClassifications: ensureEnumArray(input["supportedClassifications"], "configuration.supportedClassifications", DATA_CLASSIFICATIONS, DATA_CLASSIFICATIONS.length),
    limits: Object.freeze({ requestTimeoutMs: bounded("requestTimeoutMs", 600_000), maxResponseBytes: bounded("maxResponseBytes", 32 * 1_024 * 1_024), maxStreamBytes: bounded("maxStreamBytes", 128 * 1_024 * 1_024), maxSseEventBytes: bounded("maxSseEventBytes", 2 * 1_024 * 1_024), maxInlineImageBytes: bounded("maxInlineImageBytes", 20 * 1_024 * 1_024), maxTotalInlineImageBytes: bounded("maxTotalInlineImageBytes", 20 * 1_024 * 1_024) }),
  });
  if (parsed.limits.maxInlineImageBytes > parsed.limits.maxTotalInlineImageBytes) throw new ProviderError("INVALID_REQUEST", "Per-image bytes cannot exceed the aggregate inline-image bound.", {});
  const provider = resolveCatalogProvider(BUILTIN_PROVIDER_CATALOG, "google-gemini");
  const model = provider === undefined ? undefined : resolveCatalogModel(provider, parsed.catalogModelId);
  if (provider === undefined || model === undefined || provider.adapterProfileId !== "google-gemini-native-v1beta") throw new ProviderError("MODEL_UNAVAILABLE", "The Gemini model is absent from the curated native profile.", { modelId: parsed.catalogModelId });
  if (parsed.catalogModelId !== model.modelId) throw new ProviderError("MODEL_UNAVAILABLE", "The Gemini wire model ID must exactly match the canonical curated identity.", { modelId: parsed.catalogModelId, canonicalModelId: model.modelId });
  return parsed;
}

export function defaultGeminiConfiguration(input: { readonly instanceId: string; readonly modelId?: string; readonly catalogModelId?: string; readonly streaming?: "always" | "never"; readonly safetyMode?: "provider-default" | "block-medium-and-above" }): GeminiConfiguration {
  return parseGeminiConfiguration({ instanceId: input.instanceId, modelId: input.modelId ?? "gemini-3.5-flash", catalogModelId: input.catalogModelId ?? "gemini-3.5-flash", streaming: input.streaming ?? "always", safetyMode: input.safetyMode ?? "provider-default", supportedClassifications: ["public", "internal"], limits: { requestTimeoutMs: 120_000, maxResponseBytes: 8 * 1_024 * 1_024, maxStreamBytes: 32 * 1_024 * 1_024, maxSseEventBytes: 512 * 1_024, maxInlineImageBytes: 8 * 1_024 * 1_024, maxTotalInlineImageBytes: 19 * 1_024 * 1_024 } });
}
