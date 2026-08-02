import {
  createInferenceRequest,
  type InferenceRequest,
  type ProviderObserver,
  type ToolDefinition,
} from "@ai-dev-os/providers";
import {
  INTERNAL_DISCLOSURE,
  TESTKIT_TRACE,
  createManualScheduler,
  type ManualScheduler,
} from "@ai-dev-os/provider-testkit";
import {
  createOllamaAdapterConfiguration,
  createOllamaProvider,
  ollamaSchedulerFromManual,
  type OllamaAdapterConfigurationInput,
  type OllamaInferenceProvider,
  type OllamaObserver,
} from "../../src/index.js";

export const READ_TOOL = {
  name: "read-file",
  description: "Reads a workspace file.",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  risk: "read-only",
  approval: "never",
  executionLocation: "caller",
} as unknown as ToolDefinition;

export function testConfiguration(
  serverUrl: string,
  overrides: Partial<OllamaAdapterConfigurationInput> = {},
): ReturnType<typeof createOllamaAdapterConfiguration> {
  return createOllamaAdapterConfiguration({
    instanceId: "ollama-test-1",
    endpoint: serverUrl,
    discoveryTimeoutMs: 60_000,
    requestTimeoutMs: 3_600_000,
    ...overrides,
  });
}

export interface TestProviderHandle {
  readonly provider: OllamaInferenceProvider;
  readonly manual: ManualScheduler;
}

export function createTestProvider(options: {
  readonly serverUrl: string;
  readonly manual?: ManualScheduler;
  readonly configuration?: Partial<OllamaAdapterConfigurationInput>;
  readonly observer?: ProviderObserver;
  readonly ollamaObserver?: OllamaObserver;
}): TestProviderHandle {
  const manual = options.manual ?? createManualScheduler();
  const provider = createOllamaProvider({
    configuration: testConfiguration(options.serverUrl, options.configuration ?? {}),
    scheduler: ollamaSchedulerFromManual(manual),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
    ...(options.ollamaObserver === undefined ? {} : { ollamaObserver: options.ollamaObserver }),
  });
  return { provider, manual };
}

export function testRequest(
  name: string,
  overrides: Partial<Parameters<typeof createInferenceRequest>[0]> = {},
): InferenceRequest {
  return createInferenceRequest({
    requestId: `req-${name}`,
    modelId: "fake-model",
    messages: [{ role: "user", parts: [{ type: "text", text: `scenario ${name}` }] }],
    disclosure: INTERNAL_DISCLOSURE,
    trace: TESTKIT_TRACE,
    ...overrides,
  });
}
