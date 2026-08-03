import { DATA_CLASSIFICATIONS, validation } from "@ai-dev-os/domain";
import { BUILTIN_PROVIDER_CATALOG, resolveCatalogModel, resolveCatalogProvider, type CatalogModel, type CatalogProvider } from "@ai-dev-os/provider-catalog";
import { ProviderError, parseProviderInstanceId } from "@ai-dev-os/providers";
import { getOpenAiCompatibleProfile } from "./profiles.js";
import type { OpenAiCompatibleConfiguration, OpenAiCompatibleProfileId, ResolvedCompatibleCatalog } from "./types.js";

const { ensureEnum, ensureEnumArray, ensureExactKeys, ensureRecord, ensureSafeInteger, ensureString } = validation;
const PROFILE_IDS = ["groq-chat-completions-v1", "cerebras-chat-completions-v2", "openrouter-chat-completions-v1"] as const;

export function parseOpenAiCompatibleConfiguration(value: unknown): OpenAiCompatibleConfiguration {
  const input = ensureRecord(value, "configuration");
  ensureExactKeys(input, ["instanceId", "profileId", "modelId", "catalogModelId", "streaming", "supportedClassifications", "limits"], "configuration");
  const limits = ensureRecord(input["limits"], "configuration.limits");
  ensureExactKeys(limits, ["requestTimeoutMs", "maxResponseBytes", "maxStreamBytes", "maxSseEventBytes", "maxToolArgumentsBytes"], "configuration.limits");
  const bounded = (key: string, maximum: number): number => ensureSafeInteger(limits[key], `configuration.limits.${key}`, 1, maximum);
  return Object.freeze({
    instanceId: parseProviderInstanceId(input["instanceId"]),
    profileId: ensureEnum(input["profileId"], "configuration.profileId", PROFILE_IDS),
    modelId: ensureString(input["modelId"], "configuration.modelId", { maxLength: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, patternName: "provider-contract model ID" }),
    catalogModelId: ensureString(input["catalogModelId"], "configuration.catalogModelId", { maxLength: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u, patternName: "catalog model ID" }),
    streaming: ensureEnum(input["streaming"], "configuration.streaming", ["always", "never"] as const),
    supportedClassifications: ensureEnumArray(input["supportedClassifications"], "configuration.supportedClassifications", DATA_CLASSIFICATIONS, DATA_CLASSIFICATIONS.length),
    limits: Object.freeze({
      requestTimeoutMs: bounded("requestTimeoutMs", 600_000), maxResponseBytes: bounded("maxResponseBytes", 32 * 1_024 * 1_024),
      maxStreamBytes: bounded("maxStreamBytes", 128 * 1_024 * 1_024), maxSseEventBytes: bounded("maxSseEventBytes", 2 * 1_024 * 1_024),
      maxToolArgumentsBytes: bounded("maxToolArgumentsBytes", 1 * 1_024 * 1_024),
    }),
  });
}

export function defaultOpenAiCompatibleConfiguration(input: { readonly instanceId: string; readonly profileId: OpenAiCompatibleProfileId; readonly modelId: string; readonly catalogModelId: string; readonly streaming?: "always" | "never"; readonly supportedClassifications?: readonly (typeof DATA_CLASSIFICATIONS)[number][] }): OpenAiCompatibleConfiguration {
  return parseOpenAiCompatibleConfiguration({ ...input, streaming: input.streaming ?? "always", supportedClassifications: input.supportedClassifications ?? ["public", "internal"], limits: { requestTimeoutMs: 120_000, maxResponseBytes: 8 * 1_024 * 1_024, maxStreamBytes: 32 * 1_024 * 1_024, maxSseEventBytes: 512 * 1_024, maxToolArgumentsBytes: 256 * 1_024 } });
}

export function resolveCompatibleCatalog(configuration: OpenAiCompatibleConfiguration): ResolvedCompatibleCatalog {
  const profile = getOpenAiCompatibleProfile(configuration.profileId);
  const provider = resolveCatalogProvider(BUILTIN_PROVIDER_CATALOG, profile.providerId);
  const model = provider === undefined ? undefined : resolveCatalogModel(provider, configuration.catalogModelId);
  if (provider === undefined || model === undefined || provider.state !== "enabled" || model.state !== "enabled") throw new ProviderError("MODEL_UNAVAILABLE", "The configured provider/model is absent or disabled in the curated catalog.", { providerId: profile.providerId, modelId: configuration.catalogModelId });
  if (configuration.catalogModelId !== model.modelId) throw new ProviderError("MODEL_UNAVAILABLE", "The wire model ID must exactly match the canonical curated identity.", { modelId: configuration.catalogModelId, canonicalModelId: model.modelId });
  if (provider.adapterProfileId !== profile.profileId || provider.endpoint.origin !== profile.origin || !provider.endpoint.allowedPaths.includes(profile.path)) throw new ProviderError("INTERNAL_FAILURE", "The adapter profile does not match its curated endpoint policy.", { profileId: profile.profileId });
  return Object.freeze({ provider: provider as CatalogProvider, model: model as CatalogModel });
}
