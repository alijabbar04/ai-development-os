import { APP_VAULT_CONTAINER_ID } from "./contracts.js";
import { AppVaultError } from "./errors.js";
import type { SecretRef } from "@ai-dev-os/secrets";

export const APP_VAULT_SLOTS = Object.freeze([
  Object.freeze({ slotId: "anthropic", displayName: "Anthropic", namespace: "provider", providerInstanceId: "anthropic-default" }),
  Object.freeze({ slotId: "openai", displayName: "OpenAI", namespace: "provider", providerInstanceId: "openai-default" }),
  Object.freeze({ slotId: "gemini", displayName: "Google Gemini", namespace: "provider", providerInstanceId: "gemini-default" }),
  Object.freeze({ slotId: "openrouter", displayName: "OpenRouter", namespace: "provider", providerInstanceId: "openrouter-default" }),
] as const);

export type AppVaultSlotId = (typeof APP_VAULT_SLOTS)[number]["slotId"];
export type AppVaultSlot = (typeof APP_VAULT_SLOTS)[number];

export function parseAppVaultSlotId(value: unknown): AppVaultSlotId {
  if (typeof value !== "string" || !APP_VAULT_SLOTS.some((slot) => slot.slotId === value)) {
    throw new AppVaultError("SLOT_UNKNOWN", "The credential slot is not supported.");
  }
  return value as AppVaultSlotId;
}

export function appVaultSlot(value: unknown): AppVaultSlot {
  const slotId = parseAppVaultSlotId(value);
  return APP_VAULT_SLOTS.find((candidate) => candidate.slotId === slotId)!;
}

export function appVaultReferenceForSlot(value: unknown): SecretRef {
  const slot = appVaultSlot(value);
  return Object.freeze({
    schemaVersion: 1,
    type: "encrypted-file",
    namespace: slot.namespace,
    version: null,
    expectedKind: "text",
    providerInstanceId: slot.providerInstanceId,
    containerId: APP_VAULT_CONTAINER_ID,
    entryName: slot.slotId,
  });
}
