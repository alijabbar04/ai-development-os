import type { ArtifactId, DataClassification, DataHandlingPolicy, ModelCapabilities, TaskRisk } from "@ai-dev-os/domain";
import type { PolicyBroker, PolicyCapability } from "@ai-dev-os/policy";
import type { AbortSignalLike, Clock, InferenceRequest, ProviderDescriptor, ProviderOperationId } from "@ai-dev-os/providers";
import type { PolicyAwareSecretResolver, SecretRef } from "@ai-dev-os/secrets";

export interface GeminiConfiguration {
  readonly instanceId: string;
  readonly modelId: string;
  readonly catalogModelId: string;
  readonly streaming: "always" | "never";
  readonly safetyMode: "provider-default" | "block-medium-and-above";
  readonly supportedClassifications: readonly DataClassification[];
  readonly limits: { readonly requestTimeoutMs: number; readonly maxResponseBytes: number; readonly maxStreamBytes: number; readonly maxSseEventBytes: number; readonly maxInlineImageBytes: number; readonly maxTotalInlineImageBytes: number };
}

export interface GeminiAuthorizationRequest { readonly descriptor: ProviderDescriptor; readonly model: ModelCapabilities; readonly request: InferenceRequest; readonly operationId: ProviderOperationId; readonly requestedCapabilities: readonly PolicyCapability[] }
export interface GeminiAuthorization { readonly decisionFingerprint: string }
export interface GeminiAuthorizationPort { authorize(request: GeminiAuthorizationRequest): Promise<GeminiAuthorization> }
export interface GeminiCredentialPort { withApiKey<T>(request: GeminiAuthorizationRequest & { readonly authorization: GeminiAuthorization; readonly signal?: AbortSignalLike }, use: (apiKey: string) => Promise<T>): Promise<T> }
export interface GeminiAccessPorts { readonly authorization: GeminiAuthorizationPort; readonly credentials: GeminiCredentialPort }
export interface GeminiPolicyContext { handlingPolicy(classification: DataClassification): DataHandlingPolicy; readonly risk: TaskRisk; readonly projectId: string | null }
export interface GeminiAccessOptions { readonly policy: PolicyBroker; readonly resolver: PolicyAwareSecretResolver; readonly apiKeyRef: SecretRef; readonly context: GeminiPolicyContext; readonly requestedLifetimeMs?: number }

export interface GeminiArtifactResolver {
  resolve(input: { readonly artifactId: ArtifactId; readonly mediaType: string; readonly classification: DataClassification; readonly maxBytes: number }): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }>;
}

export interface GeminiHttpRequest { readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly body: string; readonly timeoutMs: number; readonly maxResponseBytes: number; readonly signal?: AbortSignalLike }
export interface GeminiHttpResponse { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: AsyncIterable<Uint8Array> }
export interface GeminiHttpTransport { send(request: GeminiHttpRequest): Promise<GeminiHttpResponse> }

export interface CreateGeminiProviderOptions {
  readonly configuration: GeminiConfiguration;
  readonly authorization: GeminiAuthorizationPort;
  readonly credentials: GeminiCredentialPort;
  readonly artifacts?: GeminiArtifactResolver;
  readonly transport?: GeminiHttpTransport;
  readonly clock?: Clock;
  readonly ids?: (kind: "operation" | "tool-call") => string;
}
