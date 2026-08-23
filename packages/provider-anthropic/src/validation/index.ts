import {
  ANTHROPIC_LIVE_CANARY_OPT_IN,
  createAnthropicLiveCanary,
  type AnthropicLiveCanaryOptions,
  type AnthropicLiveCanaryResult,
} from "./live-canary.js";

/**
 * Stable, fixed-request validation surface. It remains production-disabled:
 * callers must supply a scoped secret broker and an exact preflight decision,
 * and application composition must add its own durable operator gate.
 */
export type ProductionDisabledAnthropicValidationOptions = Omit<
  AnthropicLiveCanaryOptions,
  "transport"
>;

export interface ProductionDisabledAnthropicValidationRunner {
  runOnce(signal?: AbortSignal): Promise<AnthropicLiveCanaryResult>;
}

export function createProductionDisabledAnthropicValidation(
  options: ProductionDisabledAnthropicValidationOptions,
): ProductionDisabledAnthropicValidationRunner {
  const runner = createAnthropicLiveCanary(options);
  return Object.freeze({
    runOnce: async (signal?: AbortSignal) =>
      await runner.run(ANTHROPIC_LIVE_CANARY_OPT_IN, signal),
  });
}

export {
  ANTHROPIC_LIVE_CANARY_CALLBACK_DRAIN_MS,
  ANTHROPIC_LIVE_CANARY_ERROR_CODES,
  ANTHROPIC_LIVE_CANARY_FAILURE_PHASES,
  ANTHROPIC_LIVE_CANARY_MAX_RESPONSE_BYTES,
  ANTHROPIC_LIVE_CANARY_MAX_TOKENS,
  ANTHROPIC_LIVE_CANARY_MODEL,
  ANTHROPIC_LIVE_CANARY_FIXED_PROMPT,
  ANTHROPIC_LIVE_CANARY_REQUEST_BODY,
  ANTHROPIC_LIVE_CANARY_REQUEST_BYTES,
  ANTHROPIC_LIVE_CANARY_REQUEST_SHA256,
  ANTHROPIC_LIVE_CANARY_TIMEOUT_MS,
  AnthropicLiveCanaryError,
  type AnthropicLiveCanaryErrorCode,
  type AnthropicLiveCanaryFailurePhase,
  type AnthropicLiveCanaryPreflightDecision,
  type AnthropicLiveCanaryPreflightRequest,
  type AnthropicLiveCanaryResult,
} from "./live-canary.js";

export {
  ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_CATEGORIES,
  ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_KEYS,
  ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_SCHEMA_VERSION,
  projectAnthropicLiveCanaryDiagnostics,
  type AnthropicLiveCanaryDiagnosticCategory,
  type AnthropicLiveCanaryDiagnostics,
} from "./live-canary-diagnostics.js";
