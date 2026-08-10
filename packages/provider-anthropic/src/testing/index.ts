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
