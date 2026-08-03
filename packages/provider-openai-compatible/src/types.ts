import type { DataClassification, DataHandlingPolicy, ModelCapabilities, TaskRisk } from "@ai-dev-os/domain";
import type { PolicyBroker, PolicyCapability } from "@ai-dev-os/policy";
import type { CatalogModel, CatalogProvider } from "@ai-dev-os/provider-catalog";
import type { AbortSignalLike, Clock, InferenceRequest, ProviderDescriptor, ProviderOperationId } from "@ai-dev-os/providers";
import type { PolicyAwareSecretResolver, SecretRef } from "@ai-dev-os/secrets";

export type OpenAiCompatibleProfileId = "groq-chat-completions-v1" | "cerebras-chat-completions-v2" | "openrouter-chat-completions-v1";

export interface OpenAiCompatibleProfile {
  readonly profileId: OpenAiCompatibleProfileId;
  readonly providerId: "groq" | "cerebras" | "openrouter";
  readonly displayName: string;
  readonly origin: string;
  readonly path: string;
  readonly auth: "bearer";
  readonly fixedHeaders: Readonly<Record<string, string>>;
  readonly supportsSeed: boolean;
  readonly supportsStrictStructuredOutput: boolean;
  readonly requestPolicy: "standard" | "openrouter-no-fallback";
}

export interface OpenAiCompatibleLimits {
  readonly requestTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxStreamBytes: number;
  readonly maxSseEventBytes: number;
  readonly maxToolArgumentsBytes: number;
}

export interface OpenAiCompatibleConfiguration {
  readonly instanceId: string;
  readonly profileId: OpenAiCompatibleProfileId;
  /** Provider-contract-safe local identity used by InferenceRequest. */
  readonly modelId: string;
  /** Exact curated upstream identity placed on the wire. */
  readonly catalogModelId: string;
  readonly streaming: "always" | "never";
  readonly supportedClassifications: readonly DataClassification[];
  readonly limits: OpenAiCompatibleLimits;
}

export interface ProviderAccessRequest {
  readonly descriptor: ProviderDescriptor;
  readonly model: ModelCapabilities;
  readonly request: InferenceRequest;
  readonly operationId: ProviderOperationId;
  readonly requestedCapabilities: readonly PolicyCapability[];
  readonly signal?: AbortSignalLike;
}

export interface ProviderAccessPort {
  withAuthorizedApiKey<T>(request: ProviderAccessRequest, use: (apiKey: string) => Promise<T>): Promise<T>;
}

export interface PolicyContextSource {
  handlingPolicy(classification: DataClassification): DataHandlingPolicy;
  readonly risk: TaskRisk;
  readonly projectId: string | null;
}

export interface CreatePolicyAwareProviderAccessOptions {
  readonly policy: PolicyBroker;
  readonly resolver: PolicyAwareSecretResolver;
  readonly apiKeyRef: SecretRef;
  readonly context: PolicyContextSource;
  readonly requestedLifetimeMs?: number;
}

export interface HttpRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly redirect: "reject";
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignalLike;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface HttpTransport { send(request: HttpRequest): Promise<HttpResponse> }

export interface OpenAiCompatibleProviderOptions {
  readonly configuration: OpenAiCompatibleConfiguration;
  readonly access: ProviderAccessPort;
  readonly transport?: HttpTransport;
  readonly clock?: Clock;
  readonly ids?: (kind: "operation" | "tool-call") => string;
}

export interface ResolvedCompatibleCatalog {
  readonly provider: CatalogProvider;
  readonly model: CatalogModel;
}
