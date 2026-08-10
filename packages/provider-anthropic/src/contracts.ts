import type { DataClassification, JsonObject, ModelCapabilities } from "@ai-dev-os/domain";
import type {
  AbortSignalLike,
  Clock,
  DisclosureContext,
  ExecutionTraceMetadata,
  ProviderObserver,
} from "@ai-dev-os/providers";
import type { SecretRef } from "@ai-dev-os/secrets";

export const ANTHROPIC_ADAPTER_SCHEMA_VERSION = 1 as const;
export const ANTHROPIC_PROVIDER_ID = "anthropic" as const;
export const ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages" as const;
export const ANTHROPIC_API_VERSION = "2023-06-01" as const;
export const ANTHROPIC_PRODUCTION_ENABLED = false as const;

export const ANTHROPIC_RETENTION_MODES = Object.freeze([
  "standard-30-day",
  "contracted-zero",
] as const);
export type AnthropicRetentionMode = (typeof ANTHROPIC_RETENTION_MODES)[number];

export interface AnthropicModelProfile {
  readonly alias: string;
  readonly responseModelId: string;
  readonly capabilities: ModelCapabilities;
}

export interface AnthropicRetentionProfile {
  readonly mode: AnthropicRetentionMode;
  readonly promptCachingAllowed: false;
  readonly filesAllowed: false;
  readonly serverToolsAllowed: false;
  readonly trainsOnInputs: false;
}

export interface AnthropicBounds {
  readonly maximumStreamEvents: number;
  readonly maximumWireBytes: number;
  readonly maximumOutputBytes: number;
  readonly maximumToolArgumentBytes: number;
  readonly maximumWallTimeMs: number;
}

export interface AnthropicAdapterConfiguration {
  readonly schemaVersion: typeof ANTHROPIC_ADAPTER_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly endpoint: typeof ANTHROPIC_MESSAGES_ENDPOINT;
  readonly apiVersion: typeof ANTHROPIC_API_VERSION;
  readonly model: AnthropicModelProfile;
  readonly apiKeyRef: SecretRef;
  readonly retention: AnthropicRetentionProfile;
  readonly bounds: AnthropicBounds;
  readonly supportedClassifications: readonly DataClassification[];
}

export interface AnthropicAdapterConfigurationInput {
  readonly schemaVersion?: 1;
  readonly instanceId: string;
  readonly endpoint?: typeof ANTHROPIC_MESSAGES_ENDPOINT;
  readonly apiVersion?: typeof ANTHROPIC_API_VERSION;
  readonly model: AnthropicModelProfile;
  readonly apiKeyRef: SecretRef;
  readonly retention: AnthropicRetentionProfile;
  readonly bounds?: Partial<AnthropicBounds>;
  readonly supportedClassifications: readonly DataClassification[];
}

export interface AnthropicAuthorizationRequest {
  readonly instanceId: string;
  readonly operationId: string;
  readonly modelAlias: string;
  readonly responseModelId: string;
  readonly requestFingerprint: string;
  readonly disclosure: DisclosureContext;
  readonly retentionMode: AnthropicRetentionMode;
  readonly trace: ExecutionTraceMetadata;
  /** Absolute caller deadline; policy work must not outlive it. */
  readonly deadline: string | null;
  /** Aborted on caller cancellation, provider close, deadline, or wall timeout. */
  readonly signal: AbortSignalLike;
}

export interface AnthropicAuthorizationDecision {
  readonly allowed: boolean;
  readonly code: string;
  readonly decisionFingerprint: string | null;
  readonly retentionAllowed: boolean;
}

export interface AnthropicPolicyPort {
  authorize(request: AnthropicAuthorizationRequest): Promise<AnthropicAuthorizationDecision>;
}

export interface AnthropicCredentialRequest {
  readonly instanceId: string;
  readonly operationId: string;
  readonly secretRef: SecretRef;
  readonly classification: DataClassification;
  readonly policyDecisionFingerprint: string;
  readonly deadline: string | null;
  readonly trace: ExecutionTraceMetadata;
  readonly signal?: AbortSignalLike;
}

export interface AnthropicCredentialPort {
  withApiKey<T>(
    request: AnthropicCredentialRequest,
    use: (secretText: string) => Promise<T>,
  ): Promise<T>;
}

export interface AnthropicTransportRequest {
  readonly endpoint: typeof ANTHROPIC_MESSAGES_ENDPOINT;
  readonly apiVersion: typeof ANTHROPIC_API_VERSION;
  readonly requestFingerprint: string;
  readonly body: JsonObject;
  readonly signal: AbortSignal;
}

export interface AnthropicTransportResponse {
  readonly events: AsyncIterable<unknown>;
}

export interface AnthropicTransport {
  readonly kind: "deterministic-fake";
  open(request: AnthropicTransportRequest, secretText: string): Promise<AnthropicTransportResponse>;
  close(): Promise<void>;
}

export const ANTHROPIC_TRANSPORT_FAILURE_KINDS = Object.freeze([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
  "rate_limit_error",
  "api_error",
  "timeout_error",
  "overloaded_error",
  "connection_error",
] as const);
export type AnthropicTransportFailureKind =
  (typeof ANTHROPIC_TRANSPORT_FAILURE_KINDS)[number];

export class AnthropicTransportFailure extends Error {
  readonly kind: AnthropicTransportFailureKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    kind: AnthropicTransportFailureKind,
    options: { readonly status?: number | null; readonly retryAfterMs?: number | null } = {},
  ) {
    super("The Anthropic transport failed.");
    this.name = "AnthropicTransportFailure";
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export interface AnthropicTimerHandle {
  cancel(): void;
}

export interface AnthropicTimer {
  schedule(milliseconds: number, callback: () => void): AnthropicTimerHandle;
}

export interface AnthropicTestingPorts {
  readonly policy: AnthropicPolicyPort;
  readonly credentials: AnthropicCredentialPort;
  readonly transport: AnthropicTransport;
  readonly clock: Clock;
  readonly timer: AnthropicTimer;
  readonly observer?: ProviderObserver;
}
