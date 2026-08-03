import {
  createInferenceRequest,
  type InferenceRequest,
  type ProviderObserver,
  type ToolDefinition,
} from "@ai-dev-os/providers";
import {
  INTERNAL_DISCLOSURE,
  TESTKIT_EPOCH,
  TESTKIT_TRACE,
  createManualScheduler,
  type ManualScheduler,
} from "@ai-dev-os/provider-testkit";
import { parseSecretRef, type SecretRef } from "@ai-dev-os/secrets";
import {
  createFetchOpenAiTransport,
  createOpenAiAdapterConfiguration,
  createOpenAiProvider,
  createStaticSafetyIdentifierPort,
  openAiSchedulerFromManual,
  parseOpenAiEndpoint,
  parseOpenAiModelCatalog,
  fixedJitterSource,
  type ArtifactResolverPort,
  type CredentialPort,
  type CredentialRequest,
  type DisclosureAuthorization,
  type DisclosurePort,
  type IdSource,
  type OpenAiAdapterConfiguration,
  type OpenAiAdapterConfigurationInput,
  type OpenAiInferenceProvider,
  type OpenAiModelCatalog,
  type OpenAiObserver,
} from "../../src/index.js";
import { createFakeOpenAi, type FakeOpenAi } from "./fake-openai.js";

export const TEST_MODEL = "test-model";
export const TEST_API_KEY = "sk-test-CANARY-KEY-must-never-appear";
export const TEST_SAFETY_IDENTIFIER = "abcdef0123456789abcdef0123456789";

export const TEST_API_KEY_REF: SecretRef = parseSecretRef({
  schemaVersion: 1,
  type: "named",
  namespace: "openai",
  version: null,
  expectedKind: "text",
  providerInstanceId: null,
  name: "openai-api-key",
});

/**
 * A catalog snapshot with explicit provenance. The package ships no
 * built-in model facts, so every test states the limits and prices it
 * relies on, exactly as an operator would.
 */
export function testCatalog(
  overrides: {
    readonly pricing?: readonly unknown[];
    readonly supportsReasoning?: boolean;
    readonly supportsVision?: boolean;
    readonly supportsSampling?: boolean;
    readonly supportsStructuredOutput?: boolean;
    readonly supportsToolCalling?: boolean;
    readonly maxOutputTokens?: number;
    readonly effectiveFrom?: string;
    readonly effectiveTo?: string | null;
  } = {},
): OpenAiModelCatalog {
  const supportsReasoning = overrides.supportsReasoning ?? true;
  return parseOpenAiModelCatalog({
    schemaVersion: 1,
    catalogVersion: "test-1",
    source: "operator",
    entries: [
      {
        modelId: TEST_MODEL,
        contextWindowTokens: 400_000,
        maxOutputTokens: overrides.maxOutputTokens ?? 128_000,
        supportsStructuredOutput: overrides.supportsStructuredOutput ?? true,
        supportsToolCalling: overrides.supportsToolCalling ?? true,
        supportsVision: overrides.supportsVision ?? true,
        supportsReasoning,
        supportedReasoningEfforts: supportsReasoning ? ["low", "medium", "high"] : [],
        supportsSampling: overrides.supportsSampling ?? false,
        latencyClass: "standard",
        codingCapability: 5,
        reasoningCapability: 5,
        evidence: {
          source: "operator",
          observedAt: TESTKIT_EPOCH,
          documentRevision: null,
        },
        effectiveFrom: overrides.effectiveFrom ?? "2020-01-01T00:00:00.000Z",
        effectiveTo: overrides.effectiveTo ?? null,
        pricing:
          overrides.pricing ??
          ([
            {
              currency: "USD",
              inputMicrosPerMillionTokens: 1_250_000,
              cachedInputMicrosPerMillionTokens: 125_000,
              cacheWriteMicrosPerMillionTokens: null,
              outputMicrosPerMillionTokens: 10_000_000,
              source: "operator",
              effectiveFrom: "2020-01-01T00:00:00.000Z",
              effectiveTo: null,
            },
          ] as readonly unknown[]),
      },
    ],
  });
}

export function testConfiguration(
  overrides: Partial<OpenAiAdapterConfigurationInput> = {},
): OpenAiAdapterConfiguration {
  return createOpenAiAdapterConfiguration({
    instanceId: "openai-test-1",
    apiKeyRef: TEST_API_KEY_REF,
    permittedModels: [TEST_MODEL],
    catalog: testCatalog(),
    supportedClassifications: ["public", "internal"],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Recording test ports
// ---------------------------------------------------------------------------

export interface RecordingCredentialPort extends CredentialPort {
  readonly resolveCount: number;
  readonly requests: readonly CredentialRequest[];
}

export function createTestCredentialPort(
  options: { readonly deny?: boolean; readonly apiKey?: string } = {},
): RecordingCredentialPort {
  let resolveCount = 0;
  const requests: CredentialRequest[] = [];
  return {
    get resolveCount(): number {
      return resolveCount;
    },
    get requests(): readonly CredentialRequest[] {
      return requests;
    },
    async withApiKey<T>(request: CredentialRequest, use: (apiKey: string) => Promise<T>): Promise<T> {
      requests.push(request);
      if (options.deny === true) {
        // Mirrors the Stage 6 flow: the decision is evaluated BEFORE any
        // broker resolve, so a denial never touches secret material.
        const { policyDeniedError } = await import("../../src/errors.js");
        throw policyDeniedError("secret-access-denied");
      }
      resolveCount += 1;
      return use(options.apiKey ?? TEST_API_KEY);
    },
  };
}

export interface RecordingDisclosurePort extends DisclosurePort {
  readonly calls: readonly unknown[];
}

export function createTestDisclosurePort(
  overrides: Partial<DisclosureAuthorization> = {},
): RecordingDisclosurePort {
  const calls: unknown[] = [];
  return {
    get calls(): readonly unknown[] {
      return calls;
    },
    async authorize(request): Promise<DisclosureAuthorization> {
      calls.push(request);
      return Object.freeze({
        allowed: overrides.allowed ?? true,
        denialCode: overrides.denialCode ?? null,
        persistenceAllowed: overrides.persistenceAllowed ?? false,
        temporaryServerStateAllowed: overrides.temporaryServerStateAllowed ?? true,
        decisionFingerprint: overrides.decisionFingerprint ?? "a".repeat(64),
      });
    },
  };
}

export interface RecordingArtifactPort extends ArtifactResolverPort {
  readonly reads: readonly string[];
}

export function createTestArtifactPort(bytes = new Uint8Array([1, 2, 3, 4])): RecordingArtifactPort {
  const reads: string[] = [];
  return {
    get reads(): readonly string[] {
      return reads;
    },
    async resolve(input): Promise<{ bytes: Uint8Array; mediaType: string }> {
      reads.push(input.artifactId as string);
      return { bytes, mediaType: input.mediaType };
    },
  };
}

export function createTestIdSource(): IdSource {
  let operations = 0;
  let toolCalls = 0;
  return (kind) => {
    if (kind === "operation") {
      operations += 1;
      return `op-openai-${operations.toString().padStart(6, "0")}`;
    }
    toolCalls += 1;
    return `tc-openai-${toolCalls.toString().padStart(6, "0")}`;
  };
}

// ---------------------------------------------------------------------------
// Provider harness
// ---------------------------------------------------------------------------

export interface TestProviderHandle {
  readonly provider: OpenAiInferenceProvider;
  readonly fake: FakeOpenAi;
  readonly manual: ManualScheduler;
  readonly credentials: RecordingCredentialPort;
  readonly disclosure: RecordingDisclosurePort;
  readonly artifacts: RecordingArtifactPort;
  readonly observations: readonly unknown[];
}

export function createTestProvider(
  options: {
    readonly configuration?: Partial<OpenAiAdapterConfigurationInput>;
    readonly fake?: FakeOpenAi;
    readonly manual?: ManualScheduler;
    readonly credentials?: RecordingCredentialPort;
    readonly disclosure?: RecordingDisclosurePort;
    readonly withArtifacts?: boolean;
    readonly withSafetyIdentifier?: boolean;
    readonly observer?: ProviderObserver;
  } = {},
): TestProviderHandle {
  const fake = options.fake ?? createFakeOpenAi();
  const manual = options.manual ?? createManualScheduler();
  const scheduler = openAiSchedulerFromManual(manual);
  const configuration = testConfiguration(options.configuration ?? {});
  const credentials = options.credentials ?? createTestCredentialPort();
  const disclosure = options.disclosure ?? createTestDisclosurePort();
  const artifacts = createTestArtifactPort();
  const observations: unknown[] = [];
  const openAiObserver: OpenAiObserver = (observation) => {
    observations.push(observation);
  };

  const provider = createOpenAiProvider({
    configuration,
    credentials,
    disclosure,
    scheduler,
    jitter: fixedJitterSource([0.5]),
    ids: createTestIdSource(),
    openAiObserver,
    transport: createFetchOpenAiTransport({
      endpoint: parseOpenAiEndpoint("openai-api"),
      organizationId: configuration.organizationId,
      projectId: configuration.projectId,
      scheduler,
      fetchImpl: fake.fetchImpl,
    }),
    ...(options.withArtifacts === true ? { artifacts } : {}),
    ...(options.withSafetyIdentifier === false
      ? {}
      : { safetyIdentifier: createStaticSafetyIdentifierPort(TEST_SAFETY_IDENTIFIER) }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
  });

  return { provider, fake, manual, credentials, disclosure, artifacts, observations };
}

export const READ_TOOL = {
  name: "read-file",
  description: "Reads a workspace file.",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  risk: "read-only",
  approval: "never",
  executionLocation: "caller",
} as unknown as ToolDefinition;

export function testRequest(
  name: string,
  overrides: Partial<Parameters<typeof createInferenceRequest>[0]> = {},
): InferenceRequest {
  return createInferenceRequest({
    requestId: `req-${name}`,
    modelId: TEST_MODEL,
    messages: [{ role: "user", parts: [{ type: "text", text: `scenario ${name}` }] }],
    disclosure: INTERNAL_DISCLOSURE,
    trace: TESTKIT_TRACE,
    ...overrides,
  });
}

export { TESTKIT_EPOCH, TESTKIT_TRACE, INTERNAL_DISCLOSURE };
