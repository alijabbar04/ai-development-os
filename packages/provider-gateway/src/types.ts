import type { ProviderCatalogSnapshot } from "@ai-dev-os/provider-catalog";
import type { Clock, InferenceOperation, InferenceProvider, InferenceRequest, ModelDescriptor, ProviderDescriptor, ProviderHealth, StartOperationOptions } from "@ai-dev-os/providers";
import type { SecretRef } from "@ai-dev-os/secrets";

export const PROVIDER_GATEWAY_SCHEMA_VERSION = 1 as const;
export type GatewayEligibility = "any" | "verified-free-only";
export type GatewayUserPreference = "enabled" | "disabled";
export type GatewayAdapterPackage = "@ai-dev-os/provider-openai" | "@ai-dev-os/provider-openai-compatible" | "@ai-dev-os/provider-gemini" | "@ai-dev-os/provider-ollama" | "custom";

export interface GatewayAdapterReference { readonly packageName: GatewayAdapterPackage; readonly profileId: string; readonly version: string }
export interface RuntimeQuotaObservation {
  readonly schemaVersion: typeof PROVIDER_GATEWAY_SCHEMA_VERSION;
  readonly state: "unknown" | "available" | "limited" | "exhausted";
  readonly checkedAt: string;
  readonly source: "response-headers" | "provider-api" | "operator" | "unobserved";
  readonly requestsRemaining: number | null;
  readonly tokensRemaining: number | null;
  readonly resetsAt: string | null;
  readonly detailCode: string | null;
}
export interface RuntimeQuotaPort { observe(input: { readonly instanceId: string; readonly providerId: string; readonly catalogModelId: string }): Promise<RuntimeQuotaObservation> }

export interface ProviderGatewayRegistration {
  readonly provider: InferenceProvider;
  readonly catalogProviderId: string;
  readonly catalogModelId: string;
  readonly contractModelId: string;
  readonly secretRef: SecretRef;
  readonly eligibility: GatewayEligibility;
  readonly userPreference: GatewayUserPreference;
  readonly adapter: GatewayAdapterReference;
  readonly quota?: RuntimeQuotaPort;
}

export interface GatewayCatalogReference {
  readonly catalogId: string; readonly catalogFingerprint: string; readonly providerId: string; readonly providerFingerprint: string;
  readonly modelId: string; readonly modelFingerprint: string; readonly adapterProfileId: string; readonly lastVerifiedAt: string; readonly refreshAfter: string;
}
export interface GatewayInstanceSnapshot {
  readonly schemaVersion: typeof PROVIDER_GATEWAY_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly contractModelId: string;
  readonly catalog: GatewayCatalogReference;
  readonly descriptor: ProviderDescriptor;
  readonly model: ModelDescriptor;
  readonly secretRefFingerprint: string;
  readonly eligibility: GatewayEligibility;
  readonly userPreference: GatewayUserPreference;
  readonly adapter: GatewayAdapterReference;
  readonly fingerprint: string;
}
export interface GatewayRuntimeStatus { readonly instance: GatewayInstanceSnapshot; readonly health: ProviderHealth; readonly quota: RuntimeQuotaObservation }
export interface GatewayPreflight { readonly instance: GatewayInstanceSnapshot; readonly request: InferenceRequest; readonly catalogFreeTierState: "verified" | "unknown" | "not-free" | "ineligible" }

export interface ProviderGateway {
  readonly schemaVersion: typeof PROVIDER_GATEWAY_SCHEMA_VERSION;
  catalog(): ProviderCatalogSnapshot;
  fingerprint(): string;
  listInstances(): readonly GatewayInstanceSnapshot[];
  getInstance(instanceId: string): GatewayInstanceSnapshot | undefined;
  preflight(input: { readonly instanceId: string; readonly request: InferenceRequest }): GatewayPreflight;
  invoke(input: { readonly instanceId: string; readonly request: InferenceRequest; readonly options?: StartOperationOptions }): Promise<InferenceOperation>;
  status(instanceId: string): Promise<GatewayRuntimeStatus>;
  close(): Promise<void>;
}

export interface CreateProviderGatewayOptions { readonly catalog: ProviderCatalogSnapshot; readonly registrations: readonly ProviderGatewayRegistration[]; readonly clock?: Clock }
