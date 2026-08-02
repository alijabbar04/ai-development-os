import { parseModelCapabilities, type ModelCapabilities } from "@ai-dev-os/domain";
import {
  createTrace,
  parseDisclosureContext,
  type DisclosureContext,
  type ExecutionTraceMetadata,
} from "@ai-dev-os/providers";

/** Stage 2 model-capability fixture used by the fakes' default catalog. */
export const DEFAULT_FAKE_MODEL: ModelCapabilities = parseModelCapabilities({
  schemaVersion: 1,
  providerId: "fake-inference",
  modelId: "fake-model",
  contextWindowTokens: 100_000,
  maxOutputTokens: 8_000,
  supportsToolUse: true,
  supportsStructuredOutput: true,
  supportsVision: false,
  locality: "cloud",
  latencyClass: "fast",
  codingCapability: 3,
  reasoningCapability: 4,
  cost: {
    currency: "USD",
    inputMicrosPerMillionTokens: 1_000_000,
    outputMicrosPerMillionTokens: 2_000_000,
    cachedInputMicrosPerMillionTokens: null,
  },
});

export const TESTKIT_TRACE: ExecutionTraceMetadata = createTrace("trace-testkit", {});

export const PUBLIC_DISCLOSURE: DisclosureContext = parseDisclosureContext({
  classification: "public",
  requiredLocality: "any",
  redactionApplied: false,
  decisionRef: null,
  retentionAllowed: true,
  loggingAllowed: true,
});

export const INTERNAL_DISCLOSURE: DisclosureContext = parseDisclosureContext({
  classification: "internal",
  requiredLocality: "any",
  redactionApplied: true,
  decisionRef: "decision-testkit",
  retentionAllowed: false,
  loggingAllowed: false,
});

export const SECRET_DISCLOSURE: DisclosureContext = parseDisclosureContext({
  classification: "secret",
  requiredLocality: "local-only",
  redactionApplied: false,
  decisionRef: null,
  retentionAllowed: false,
  loggingAllowed: false,
});
