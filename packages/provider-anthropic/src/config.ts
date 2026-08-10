import { createHash } from "node:crypto";
import {
  DATA_CLASSIFICATIONS,
  parseModelCapabilities,
  toCanonicalJson,
  validation,
} from "@ai-dev-os/domain";
import { parseSecretRef } from "@ai-dev-os/secrets";
import {
  ANTHROPIC_ADAPTER_SCHEMA_VERSION,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_ENDPOINT,
  ANTHROPIC_PROVIDER_ID,
  ANTHROPIC_RETENTION_MODES,
  type AnthropicAdapterConfiguration,
  type AnthropicAdapterConfigurationInput,
  type AnthropicBounds,
  type AnthropicRetentionProfile,
} from "./contracts.js";

const {
  ensureBoolean,
  ensureEnum,
  ensureEnumArray,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  fail,
} = validation;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const DEFAULT_ANTHROPIC_BOUNDS: AnthropicBounds = Object.freeze({
  maximumStreamEvents: 2_048,
  maximumWireBytes: 4 * 1_024 * 1_024,
  maximumOutputBytes: 1 * 1_024 * 1_024,
  maximumToolArgumentBytes: 256 * 1_024,
  maximumWallTimeMs: 10 * 60_000,
});

function parseBounds(value: unknown, path: string): AnthropicBounds {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "maximumStreamEvents",
    "maximumWireBytes",
    "maximumOutputBytes",
    "maximumToolArgumentBytes",
    "maximumWallTimeMs",
  ], path);
  return Object.freeze({
    maximumStreamEvents: ensureSafeInteger(input["maximumStreamEvents"], `${path}.maximumStreamEvents`, 1, 10_000),
    maximumWireBytes: ensureSafeInteger(input["maximumWireBytes"], `${path}.maximumWireBytes`, 1_024, 16 * 1_024 * 1_024),
    maximumOutputBytes: ensureSafeInteger(input["maximumOutputBytes"], `${path}.maximumOutputBytes`, 1, 4 * 1_024 * 1_024),
    maximumToolArgumentBytes: ensureSafeInteger(input["maximumToolArgumentBytes"], `${path}.maximumToolArgumentBytes`, 2, 1 * 1_024 * 1_024),
    maximumWallTimeMs: ensureSafeInteger(input["maximumWallTimeMs"], `${path}.maximumWallTimeMs`, 100, 24 * 60 * 60_000),
  });
}

function parseRetention(value: unknown, path: string): AnthropicRetentionProfile {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "mode",
    "promptCachingAllowed",
    "filesAllowed",
    "serverToolsAllowed",
    "trainsOnInputs",
  ], path);
  const promptCachingAllowed = ensureBoolean(input["promptCachingAllowed"], `${path}.promptCachingAllowed`);
  const filesAllowed = ensureBoolean(input["filesAllowed"], `${path}.filesAllowed`);
  const serverToolsAllowed = ensureBoolean(input["serverToolsAllowed"], `${path}.serverToolsAllowed`);
  const trainsOnInputs = ensureBoolean(input["trainsOnInputs"], `${path}.trainsOnInputs`);
  if (promptCachingAllowed || filesAllowed || serverToolsAllowed || trainsOnInputs) {
    fail(path, "unsupported_profile", "Stage 18B supports no caching, Files, server tools, or training profile.");
  }
  return Object.freeze({
    mode: ensureEnum(input["mode"], `${path}.mode`, ANTHROPIC_RETENTION_MODES),
    promptCachingAllowed: false,
    filesAllowed: false,
    serverToolsAllowed: false,
    trainsOnInputs: false,
  });
}

export function parseAnthropicAdapterConfiguration(
  value: unknown,
  path = "anthropicConfiguration",
): AnthropicAdapterConfiguration {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "schemaVersion",
    "instanceId",
    "endpoint",
    "apiVersion",
    "model",
    "apiKeyRef",
    "retention",
    "bounds",
    "supportedClassifications",
  ], path);
  ensureSchemaVersion(input["schemaVersion"], `${path}.schemaVersion`, ANTHROPIC_ADAPTER_SCHEMA_VERSION);
  const instanceId = ensureString(input["instanceId"], `${path}.instanceId`, {
    maxLength: 128,
    pattern: IDENTIFIER,
    patternName: "provider instance identifier",
  });
  const endpoint = ensureEnum(input["endpoint"], `${path}.endpoint`, [ANTHROPIC_MESSAGES_ENDPOINT] as const);
  const apiVersion = ensureEnum(input["apiVersion"], `${path}.apiVersion`, [ANTHROPIC_API_VERSION] as const);
  const modelInput = ensureRecord(input["model"], `${path}.model`);
  ensureExactKeys(modelInput, ["alias", "responseModelId", "capabilities"], `${path}.model`);
  const alias = ensureString(modelInput["alias"], `${path}.model.alias`, {
    maxLength: 128,
    pattern: MODEL_ID,
    patternName: "model alias",
  });
  const responseModelId = ensureString(modelInput["responseModelId"], `${path}.model.responseModelId`, {
    maxLength: 128,
    pattern: MODEL_ID,
    patternName: "Anthropic response model identifier",
  });
  const capabilities = parseModelCapabilities(modelInput["capabilities"], `${path}.model.capabilities`);
  if (capabilities.providerId !== ANTHROPIC_PROVIDER_ID || capabilities.modelId !== alias || capabilities.locality !== "cloud") {
    fail(`${path}.model.capabilities`, "identity_mismatch", "Capabilities must bind the Anthropic provider, configured alias, and cloud locality.");
  }
  if (capabilities.cost !== null) {
    fail(`${path}.model.capabilities.cost`, "unsupported_pricing", "Stage 18B has no reviewed Anthropic pricing catalog.");
  }
  const apiKeyRef = parseSecretRef(input["apiKeyRef"], `${path}.apiKeyRef`);
  if (apiKeyRef.expectedKind !== "text" ||
      (apiKeyRef.providerInstanceId !== null && apiKeyRef.providerInstanceId !== instanceId)) {
    fail(`${path}.apiKeyRef`, "scope_mismatch", "The secret reference must be text and scoped to this provider instance or explicitly unscoped.");
  }
  const supportedClassifications = ensureEnumArray(
    input["supportedClassifications"],
    `${path}.supportedClassifications`,
    DATA_CLASSIFICATIONS,
    DATA_CLASSIFICATIONS.length,
  );
  if (supportedClassifications.length === 0) {
    fail(`${path}.supportedClassifications`, "empty", "At least one supported classification is required.");
  }
  return Object.freeze({
    schemaVersion: ANTHROPIC_ADAPTER_SCHEMA_VERSION,
    instanceId,
    endpoint,
    apiVersion,
    model: Object.freeze({ alias, responseModelId, capabilities }),
    apiKeyRef,
    retention: parseRetention(input["retention"], `${path}.retention`),
    bounds: parseBounds(input["bounds"], `${path}.bounds`),
    supportedClassifications,
  });
}

export function createAnthropicAdapterConfiguration(
  input: AnthropicAdapterConfigurationInput,
): AnthropicAdapterConfiguration {
  return parseAnthropicAdapterConfiguration({
    schemaVersion: input.schemaVersion ?? ANTHROPIC_ADAPTER_SCHEMA_VERSION,
    instanceId: input.instanceId,
    endpoint: input.endpoint ?? ANTHROPIC_MESSAGES_ENDPOINT,
    apiVersion: input.apiVersion ?? ANTHROPIC_API_VERSION,
    model: input.model,
    apiKeyRef: input.apiKeyRef,
    retention: input.retention,
    bounds: { ...DEFAULT_ANTHROPIC_BOUNDS, ...input.bounds },
    supportedClassifications: input.supportedClassifications,
  });
}

export function anthropicConfigurationFingerprint(
  configuration: AnthropicAdapterConfiguration,
): string {
  const parsed = parseAnthropicAdapterConfiguration(configuration);
  return createHash("sha256").update(toCanonicalJson(parsed)).digest("hex");
}
