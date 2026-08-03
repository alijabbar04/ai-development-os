import {
  PROVIDER_CATALOG_SCHEMA_VERSION,
  type CapabilityClaim,
  type CatalogCapabilityId,
  type EvidenceClaim,
  type UnsignedCatalogModel,
  type UnsignedCatalogProvider,
  type VerificationWindow,
} from "./types.js";
import { createProviderCatalog } from "./validation.js";

const VERIFIED_AT = "2026-08-03T00:00:00.000Z";
const REFRESH_AFTER = "2026-08-10T00:00:00.000Z";
const verification: VerificationWindow = Object.freeze({ lastVerifiedAt: VERIFIED_AT, refreshAfter: REFRESH_AFTER });

function unknown(note: string): EvidenceClaim {
  return { state: "unknown", evidenceUrl: null, note };
}

function verified(evidenceUrl: string, note: string): EvidenceClaim {
  return { state: "verified", evidenceUrl, note };
}

function supported(id: CatalogCapabilityId, evidenceUrl: string, note: string): CapabilityClaim {
  return { id, status: "supported", evidenceUrl, note };
}

function unsupported(id: CatalogCapabilityId, evidenceUrl: string, note: string): CapabilityClaim {
  return { id, status: "unsupported", evidenceUrl, note };
}

const geminiModelDocs = "https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash";
const groqModelDocs = "https://console.groq.com/docs/model/openai/gpt-oss-120b";
const cerebrasModelDocs = "https://inference-docs.cerebras.ai/api-reference/models/public-models";
const openRouterModelDocs = "https://openrouter.ai/api/v1/models";

const geminiModel: UnsignedCatalogModel = {
  schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
  modelId: "gemini-3.5-flash",
  displayName: "Gemini 3.5 Flash",
  aliases: [],
  verification,
  freeTier: {
    state: "verified",
    evidenceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    restrictions: ["Free-tier availability and quotas vary by project, region, account eligibility, and current Google terms."],
  },
  capabilities: [
    supported("text-input", geminiModelDocs, "Official model card lists text input."),
    supported("text-output", geminiModelDocs, "Official model card lists text output."),
    supported("streaming", "https://ai.google.dev/api/generate-content", "Native streamGenerateContent is documented."),
    supported("tools", "https://ai.google.dev/gemini-api/docs/generate-content/function-calling", "Function calling is documented for this model family."),
    supported("structured-output", "https://ai.google.dev/gemini-api/docs/generate-content/structured-output", "JSON Schema structured output is documented."),
    supported("image-input", geminiModelDocs, "Official model card lists image input."),
    supported("audio-input", geminiModelDocs, "Official model card lists audio input."),
    supported("video-input", geminiModelDocs, "Official model card lists video input."),
    supported("pdf-input", geminiModelDocs, "Official model card lists PDF input."),
    supported("reasoning", geminiModelDocs, "Official model card documents thinking support."),
  ],
  restrictions: [
    "This adapter supports text plus bounded inline image data resolved from artifact references; audio, video, PDFs, and Files API uploads are not implemented in Stage 12.",
    "Unpaid-service data terms prohibit sensitive, confidential, or personal information unless another applicable terms path permits it.",
  ],
  limits: { contextTokens: 1_048_576, maxOutputTokens: 65_536, evidenceUrl: geminiModelDocs },
  state: "enabled",
};

const groqModel: UnsignedCatalogModel = {
  schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
  modelId: "openai/gpt-oss-120b",
  displayName: "GPT-OSS 120B on Groq",
  aliases: [],
  verification,
  freeTier: {
    state: "verified",
    evidenceUrl: "https://console.groq.com/docs/rate-limits",
    restrictions: ["Free Plan rate limits are organization-level, model-specific, and subject to change."],
  },
  capabilities: [
    supported("text-input", groqModelDocs, "Official model page documents text chat input."),
    supported("text-output", groqModelDocs, "Official model page documents text output."),
    supported("streaming", "https://console.groq.com/docs/text-chat", "Streaming Chat Completions is documented."),
    supported("tools", "https://console.groq.com/docs/tool-use/local-tool-calling", "Local function tool calling is documented."),
    supported("structured-output", "https://console.groq.com/docs/structured-outputs", "Strict structured output is documented for supported models."),
    unsupported("image-input", groqModelDocs, "The selected model is text-only."),
    unsupported("audio-input", groqModelDocs, "The selected model is text-only."),
    unsupported("video-input", groqModelDocs, "The selected model is text-only."),
    unsupported("pdf-input", groqModelDocs, "The selected model is text-only."),
    supported("reasoning", groqModelDocs, "The model page documents reasoning output."),
  ],
  restrictions: ["OpenAI compatibility is limited to the documented Chat Completions subset; it is not Responses API parity."],
  limits: { contextTokens: 131_072, maxOutputTokens: 65_536, evidenceUrl: groqModelDocs },
  state: "enabled",
};

const cerebrasModel: UnsignedCatalogModel = {
  schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
  modelId: "gpt-oss-120b",
  displayName: "GPT-OSS 120B on Cerebras",
  aliases: [],
  verification,
  freeTier: {
    state: "verified",
    evidenceUrl: "https://inference-docs.cerebras.ai/support/rate-limits",
    restrictions: [
      "The Free Trial grants $5 in credits only after a verified payment method is added; API access is inactive without it.",
      "Trial credits expire 30 days after grant, and organization/model quotas may change.",
    ],
  },
  capabilities: [
    supported("text-input", cerebrasModelDocs, "Official public-model table lists this text model."),
    supported("text-output", cerebrasModelDocs, "Official public-model table lists text generation."),
    supported("streaming", "https://inference-docs.cerebras.ai/capabilities/streaming", "Chat Completions SSE streaming is documented."),
    supported("tools", "https://inference-docs.cerebras.ai/capabilities/tool-use", "Function tool use is documented."),
    supported("structured-output", "https://inference-docs.cerebras.ai/capabilities/structured-outputs", "JSON Schema output is documented."),
    unsupported("image-input", cerebrasModelDocs, "The selected public model is text-only."),
    unsupported("audio-input", cerebrasModelDocs, "The selected public model is text-only."),
    unsupported("video-input", cerebrasModelDocs, "The selected public model is text-only."),
    unsupported("pdf-input", cerebrasModelDocs, "The selected public model is text-only."),
    supported("reasoning", "https://inference-docs.cerebras.ai/api-reference/chat-completions", "Reasoning fields are documented for chat completions."),
  ],
  restrictions: ["OpenAI compatibility is a finite Chat Completions profile and does not imply Responses API support."],
  limits: { contextTokens: 131_072, maxOutputTokens: 40_960, evidenceUrl: cerebrasModelDocs },
  state: "enabled",
};

const openRouterModel: UnsignedCatalogModel = {
  schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
  modelId: "openai/gpt-oss-20b:free",
  displayName: "GPT-OSS 20B Free on OpenRouter",
  aliases: [],
  verification,
  freeTier: {
    state: "verified",
    evidenceUrl: openRouterModelDocs,
    restrictions: [
      "The model listing reported zero token price at verification time.",
      "API-key eligibility, daily free-model limits, account-credit requirements, and upstream availability remain governed by current OpenRouter terms.",
    ],
  },
  capabilities: [
    supported("text-input", openRouterModelDocs, "The dated models API entry declares text input."),
    supported("text-output", openRouterModelDocs, "The dated models API entry declares text output."),
    supported("streaming", "https://openrouter.ai/docs/api/reference/streaming", "SSE streaming is documented."),
    supported("tools", openRouterModelDocs, "The dated models API entry lists tools among supported parameters."),
    supported("structured-output", openRouterModelDocs, "The dated models API entry lists structured-response parameters."),
    unsupported("image-input", openRouterModelDocs, "The selected concrete model entry declares text input only."),
    unsupported("audio-input", openRouterModelDocs, "The selected concrete model entry declares text input only."),
    unsupported("video-input", openRouterModelDocs, "The selected concrete model entry declares text input only."),
    unsupported("pdf-input", openRouterModelDocs, "The selected concrete model entry declares text input only."),
    supported("reasoning", openRouterModelDocs, "The dated model entry lists reasoning parameters."),
  ],
  restrictions: [
    "The random openrouter/free router is intentionally excluded; this entry pins one concrete model ID.",
    "OpenRouter forwards requests to an upstream model provider whose data terms also apply.",
  ],
  limits: { contextTokens: 131_072, maxOutputTokens: 32_768, evidenceUrl: openRouterModelDocs },
  state: "enabled",
};

const providers: readonly UnsignedCatalogProvider[] = [
  {
    schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
    providerId: "google-gemini",
    displayName: "Google Gemini API",
    aliases: ["gemini"],
    transportFamily: "gemini-generate-content",
    adapterProfileId: "google-gemini-native-v1beta",
    documentation: {
      api: "https://ai.google.dev/api",
      terms: "https://ai.google.dev/gemini-api/terms",
      privacy: "https://policies.google.com/privacy",
      pricing: "https://ai.google.dev/gemini-api/docs/pricing",
      rateLimits: "https://ai.google.dev/gemini-api/docs/rate-limits",
    },
    verification,
    authentication: { class: "api-key", requiredSecretKind: "text", delivery: "x-goog-api-key" },
    endpoint: {
      origin: "https://generativelanguage.googleapis.com",
      allowedPaths: ["/v1beta/models/{model}:generateContent", "/v1beta/models/{model}:streamGenerateContent"],
      redirectPolicy: "reject",
    },
    dataPractices: {
      regionality: unknown("The public API overview does not promise a fixed inference region for this profile."),
      retention: unknown("Unpaid-service terms describe use and human review but do not provide one universal request-retention interval."),
      training: verified("https://ai.google.dev/gemini-api/terms", "Unpaid-service inputs and outputs may be used to improve Google products; EEA/UK/CH treatment depends on billing and terms."),
      storage: unknown("Storage behavior varies by feature and service tier."),
      zeroDataRetention: unknown("No universal ZDR guarantee was verified for the unpaid Gemini API profile."),
    },
    freeTier: {
      state: "verified",
      evidenceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
      restrictions: ["Only models and projects shown as eligible in current pricing and quota documentation qualify."],
    },
    quota: {
      sourceUrl: "https://ai.google.dev/gemini-api/docs/rate-limits",
      scope: "project",
      semantics: "documented-limit",
      note: "RPM, TPM, and RPD vary by model and project tier; runtime observations are separate from this catalog claim.",
    },
    restrictions: ["Official API keys only; no consumer-session, browser-cookie, or unofficial OAuth access."],
    state: "enabled",
    models: [geminiModel],
  },
  {
    schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
    providerId: "groq",
    displayName: "GroqCloud",
    aliases: ["groqcloud"],
    transportFamily: "openai-chat-completions",
    adapterProfileId: "groq-chat-completions-v1",
    documentation: {
      api: "https://console.groq.com/docs/api-reference",
      terms: "https://console.groq.com/docs/legal/services-agreement",
      privacy: "https://console.groq.com/docs/your-data",
      pricing: "https://groq.com/pricing",
      rateLimits: "https://console.groq.com/docs/rate-limits",
    },
    verification,
    authentication: { class: "api-key", requiredSecretKind: "text", delivery: "bearer" },
    endpoint: { origin: "https://api.groq.com", allowedPaths: ["/openai/v1/chat/completions"], redirectPolicy: "reject" },
    dataPractices: {
      regionality: verified("https://console.groq.com/docs/your-data", "Groq documents US processing for this service."),
      retention: verified("https://console.groq.com/docs/your-data", "Inference data is not retained by default except documented reliability/abuse cases, which may retain up to 30 days."),
      training: verified("https://console.groq.com/docs/your-data", "Groq documents that customer data is not used to train models."),
      storage: verified("https://console.groq.com/docs/your-data", "Usage metadata is always retained; inference-content retention follows the documented exceptions."),
      zeroDataRetention: verified("https://console.groq.com/docs/your-data", "A Zero Data Retention option is documented but is not implied to be enabled on every account."),
    },
    freeTier: { state: "verified", evidenceUrl: "https://console.groq.com/docs/rate-limits", restrictions: ["Free Plan quotas vary by model and organization."] },
    quota: { sourceUrl: "https://console.groq.com/docs/rate-limits", scope: "organization", semantics: "documented-limit", note: "Headers expose remaining request/token quotas and reset observations." },
    restrictions: ["The profile exposes only the fixed official Groq Chat Completions endpoint."],
    state: "enabled",
    models: [groqModel],
  },
  {
    schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
    providerId: "cerebras",
    displayName: "Cerebras Inference",
    aliases: ["cerebras-cloud"],
    transportFamily: "openai-chat-completions",
    adapterProfileId: "cerebras-chat-completions-v2",
    documentation: {
      api: "https://inference-docs.cerebras.ai/api-reference/chat-completions",
      terms: "https://cloud.cerebras.ai/terms",
      privacy: "https://cloud.cerebras.ai/privacy",
      pricing: "https://inference-docs.cerebras.ai/support/pricing",
      rateLimits: "https://inference-docs.cerebras.ai/support/rate-limits",
    },
    verification,
    authentication: { class: "api-key", requiredSecretKind: "text", delivery: "bearer" },
    endpoint: { origin: "https://api.cerebras.ai", allowedPaths: ["/v1/chat/completions"], redirectPolicy: "reject" },
    dataPractices: {
      regionality: unknown("No fixed processing region was verified in the selected first-party sources."),
      retention: verified("https://support.cerebras.net/articles/1811589793-does-cerebras-retain-my-data", "Cerebras states that inference inputs and outputs are not retained."),
      training: unknown("Non-retention does not by itself establish a separately stated training policy."),
      storage: verified("https://support.cerebras.net/articles/1811589793-does-cerebras-retain-my-data", "The support statement says inference inputs and outputs are not stored."),
      zeroDataRetention: unknown("The source describes non-retention but does not establish a separately contracted ZDR mode."),
    },
    freeTier: {
      state: "verified",
      evidenceUrl: "https://inference-docs.cerebras.ai/support/rate-limits",
      restrictions: ["Free Trial API access requires a verified payment method; the $5 credit grant expires after 30 days and is not recurring free capacity."],
    },
    quota: { sourceUrl: "https://inference-docs.cerebras.ai/support/rate-limits", scope: "organization", semantics: "documented-limit", note: "Published Free Trial limits include per-minute, hourly, and daily windows and vary by model." },
    restrictions: ["The finite profile sends the documented API version header and does not accept caller-defined headers."],
    state: "enabled",
    models: [cerebrasModel],
  },
  {
    schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
    providerId: "openrouter",
    displayName: "OpenRouter",
    aliases: [],
    transportFamily: "openai-chat-completions",
    adapterProfileId: "openrouter-chat-completions-v1",
    documentation: {
      api: "https://openrouter.ai/docs/quickstart",
      terms: "https://openrouter.ai/terms",
      privacy: "https://openrouter.ai/privacy/",
      pricing: "https://openrouter.ai/api/v1/models",
      rateLimits: "https://openrouter.ai/docs/faq",
    },
    verification,
    authentication: { class: "api-key", requiredSecretKind: "text", delivery: "bearer" },
    endpoint: { origin: "https://openrouter.ai", allowedPaths: ["/api/v1/chat/completions"], redirectPolicy: "reject" },
    dataPractices: {
      regionality: unknown("OpenRouter and the selected upstream provider may process in different regions."),
      retention: verified("https://openrouter.ai/docs/guides/privacy/data-collection", "Content logging is off by default at OpenRouter, while request metadata is retained; upstream-provider terms vary."),
      training: unknown("Training practices depend on the selected upstream provider and account routing policy."),
      storage: verified("https://openrouter.ai/docs/guides/privacy/data-collection", "OpenRouter documents metadata storage even when content logging is disabled."),
      zeroDataRetention: verified("https://openrouter.ai/docs/guides/features/zdr", "A ZDR routing setting is documented, but provider availability is constrained and the setting is not assumed enabled."),
    },
    freeTier: {
      state: "verified",
      evidenceUrl: "https://openrouter.ai/api/v1/models",
      restrictions: ["Only the pinned zero-price model entry qualifies; API eligibility and daily limits remain subject to current terms and account state."],
    },
    quota: { sourceUrl: "https://openrouter.ai/docs/faq", scope: "account", semantics: "documented-limit", note: "Daily free-model request limits depend on account credit history and current policy." },
    restrictions: [
      "The adapter pins a concrete model and disables fallback; it does not expose OpenRouter automatic model selection.",
      "Upstream model-provider privacy and usage terms also apply.",
    ],
    state: "enabled",
    models: [openRouterModel],
  },
];

export const BUILTIN_PROVIDER_CATALOG = createProviderCatalog({
  schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
  catalogId: "ai-dev-os/stage-12/builtin",
  revision: 1,
  generatedAt: VERIFIED_AT,
  providers,
});
