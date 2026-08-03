import type { OpenAiCompatibleProfile, OpenAiCompatibleProfileId } from "./types.js";

const profiles: Readonly<Record<OpenAiCompatibleProfileId, OpenAiCompatibleProfile>> = Object.freeze({
  "groq-chat-completions-v1": Object.freeze({
    profileId: "groq-chat-completions-v1", providerId: "groq", displayName: "GroqCloud (Chat Completions)",
    origin: "https://api.groq.com", path: "/openai/v1/chat/completions", auth: "bearer", fixedHeaders: Object.freeze({}),
    supportsSeed: true, supportsStrictStructuredOutput: true, requestPolicy: "standard",
  }),
  "cerebras-chat-completions-v2": Object.freeze({
    profileId: "cerebras-chat-completions-v2", providerId: "cerebras", displayName: "Cerebras Inference (Chat Completions)",
    origin: "https://api.cerebras.ai", path: "/v1/chat/completions", auth: "bearer", fixedHeaders: Object.freeze({ "X-Cerebras-Version-Patch": "2" }),
    supportsSeed: true, supportsStrictStructuredOutput: true, requestPolicy: "standard",
  }),
  "openrouter-chat-completions-v1": Object.freeze({
    profileId: "openrouter-chat-completions-v1", providerId: "openrouter", displayName: "OpenRouter (Chat Completions)",
    origin: "https://openrouter.ai", path: "/api/v1/chat/completions", auth: "bearer", fixedHeaders: Object.freeze({}),
    supportsSeed: true, supportsStrictStructuredOutput: true, requestPolicy: "openrouter-no-fallback",
  }),
});

export function getOpenAiCompatibleProfile(profileId: OpenAiCompatibleProfileId): OpenAiCompatibleProfile {
  return profiles[profileId];
}

export const OPENAI_COMPATIBLE_PROFILES = Object.freeze(Object.values(profiles));
