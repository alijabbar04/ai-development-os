import type { JsonValue } from "@ai-dev-os/domain";
import type { InferenceProvider } from "@ai-dev-os/providers";
import type { AnthropicAdapterConfiguration, AnthropicTestingPorts } from "../contracts.js";
import { createAnthropicProviderInternal } from "../provider.js";
import { assertStructuredSchemaWellFormed } from "../structured-schema.js";

export function createAnthropicProviderForTesting(options: {
  readonly configuration: AnthropicAdapterConfiguration;
  readonly ports: AnthropicTestingPorts;
}): InferenceProvider {
  return createAnthropicProviderInternal({
    configuration: options.configuration,
    executionMode: "deterministic-fake",
    ports: options.ports,
  });
}

export function assertAnthropicStructuredSchemaForTesting(schema: JsonValue): void {
  assertStructuredSchemaWellFormed(schema);
}

export type { AnthropicTestingPorts } from "../contracts.js";

export {
  ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_CATEGORIES,
  ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_KEYS,
  ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_SCHEMA_VERSION,
  ANTHROPIC_LIVE_CANARY_MAX_RETRY_AFTER_SECONDS,
  ANTHROPIC_LIVE_CANARY_TRANSPORT_ERROR_KINDS,
  ANTHROPIC_PROVIDER_ERROR_TYPES,
  ANTHROPIC_PROVIDER_STOP_REASONS,
  anthropicLiveCanaryDiagnosticsEqual,
  classifyAnthropicLiveCanaryDiagnostics,
  normalizeHttpStatus,
  normalizeRetryAfterSeconds,
  projectAnthropicLiveCanaryDiagnostics,
  readProviderResponseFacts,
  transportErrorKindOf,
  unknownAnthropicLiveCanaryDiagnostics,
  type AnthropicLiveCanaryDiagnosticCategory,
  type AnthropicLiveCanaryDiagnosticFacts,
  type AnthropicLiveCanaryDiagnostics,
  type AnthropicLiveCanaryTransportErrorKind,
  type AnthropicProviderErrorType,
  type AnthropicProviderResponseFacts,
  type AnthropicProviderStopReason,
} from "./live-canary-diagnostics.js";

export {
  ANTHROPIC_LIVE_CANARY_ERROR_CODES,
  ANTHROPIC_LIVE_CANARY_FAILURE_PHASES,
  ANTHROPIC_LIVE_CANARY_CALLBACK_DRAIN_MS,
  ANTHROPIC_LIVE_CANARY_MAX_RESPONSE_BYTES,
  ANTHROPIC_LIVE_CANARY_MAX_TOKENS,
  ANTHROPIC_LIVE_CANARY_MODEL,
  ANTHROPIC_LIVE_CANARY_OPT_IN,
  ANTHROPIC_LIVE_CANARY_TIMEOUT_MS,
  AnthropicLiveCanaryError,
  createAnthropicLiveCanary,
  type AnthropicLiveCanaryErrorCode,
  type AnthropicLiveCanaryFailurePhase,
  type AnthropicLiveCanaryOptions,
  type AnthropicLiveCanaryPreflightDecision,
  type AnthropicLiveCanaryPreflightRequest,
  type AnthropicLiveCanaryResult,
  type AnthropicLiveCanaryTransport,
  type AnthropicLiveCanaryTransportRequest,
  type AnthropicLiveCanaryTransportResponse,
} from "./live-canary.js";
