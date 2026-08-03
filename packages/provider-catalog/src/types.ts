export const PROVIDER_CATALOG_SCHEMA_VERSION = 1 as const;

export const TRANSPORT_FAMILIES = Object.freeze([
  "openai-responses",
  "openai-chat-completions",
  "gemini-generate-content",
] as const);
export type TransportFamily = (typeof TRANSPORT_FAMILIES)[number];

export const VERIFICATION_STATES = Object.freeze(["verified", "unknown", "not-applicable"] as const);
export type VerificationState = (typeof VERIFICATION_STATES)[number];

export const FREE_TIER_STATES = Object.freeze(["verified", "unknown", "not-free", "ineligible"] as const);
export type FreeTierState = (typeof FREE_TIER_STATES)[number];

export const CATALOG_ENTRY_STATES = Object.freeze(["enabled", "disabled", "deprecated"] as const);
export type CatalogEntryState = (typeof CATALOG_ENTRY_STATES)[number];

export const CAPABILITY_IDS = Object.freeze([
  "text-input",
  "text-output",
  "streaming",
  "tools",
  "structured-output",
  "image-input",
  "audio-input",
  "video-input",
  "pdf-input",
  "reasoning",
] as const);
export type CatalogCapabilityId = (typeof CAPABILITY_IDS)[number];

export const CAPABILITY_STATUSES = Object.freeze(["supported", "unsupported", "unknown"] as const);
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export interface VerificationWindow {
  readonly lastVerifiedAt: string;
  readonly refreshAfter: string;
}

export interface EvidenceClaim {
  readonly state: VerificationState;
  readonly evidenceUrl: string | null;
  readonly note: string;
}

export interface FreeTierClaim {
  readonly state: FreeTierState;
  readonly evidenceUrl: string;
  readonly restrictions: readonly string[];
}

export interface CapabilityClaim {
  readonly id: CatalogCapabilityId;
  readonly status: CapabilityStatus;
  readonly evidenceUrl: string | null;
  readonly note: string;
}

export interface QuotaObservation {
  readonly sourceUrl: string;
  readonly scope: "account" | "organization" | "project" | "provider-model";
  readonly semantics: "documented-limit" | "response-header-observation" | "unknown";
  readonly note: string;
}

export interface ProviderEndpointPolicy {
  readonly origin: string;
  readonly allowedPaths: readonly string[];
  readonly redirectPolicy: "reject";
}

export interface ProviderDocumentation {
  readonly api: string;
  readonly terms: string;
  readonly privacy: string;
  readonly pricing: string;
  readonly rateLimits: string;
}

export interface DataPracticeMetadata {
  readonly regionality: EvidenceClaim;
  readonly retention: EvidenceClaim;
  readonly training: EvidenceClaim;
  readonly storage: EvidenceClaim;
  readonly zeroDataRetention: EvidenceClaim;
}

export interface ModelLimits {
  readonly contextTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly evidenceUrl: string;
}

export interface CatalogModel {
  readonly schemaVersion: typeof PROVIDER_CATALOG_SCHEMA_VERSION;
  readonly modelId: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly verification: VerificationWindow;
  readonly freeTier: FreeTierClaim;
  readonly capabilities: readonly CapabilityClaim[];
  readonly restrictions: readonly string[];
  readonly limits: ModelLimits;
  readonly state: CatalogEntryState;
  readonly fingerprint: string;
}

export interface CatalogProvider {
  readonly schemaVersion: typeof PROVIDER_CATALOG_SCHEMA_VERSION;
  readonly providerId: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly transportFamily: TransportFamily;
  readonly adapterProfileId: string;
  readonly documentation: ProviderDocumentation;
  readonly verification: VerificationWindow;
  readonly authentication: {
    readonly class: "api-key";
    readonly requiredSecretKind: "text";
    readonly delivery: "bearer" | "x-goog-api-key";
  };
  readonly endpoint: ProviderEndpointPolicy;
  readonly dataPractices: DataPracticeMetadata;
  readonly freeTier: FreeTierClaim;
  readonly quota: QuotaObservation;
  readonly restrictions: readonly string[];
  readonly state: CatalogEntryState;
  readonly models: readonly CatalogModel[];
  readonly fingerprint: string;
}

export interface ProviderCatalogSnapshot {
  readonly schemaVersion: typeof PROVIDER_CATALOG_SCHEMA_VERSION;
  readonly catalogId: string;
  readonly revision: number;
  readonly generatedAt: string;
  readonly providers: readonly CatalogProvider[];
  readonly fingerprint: string;
}

export interface UnsignedProviderCatalogSnapshot extends Omit<ProviderCatalogSnapshot, "fingerprint" | "providers"> {
  readonly providers: readonly UnsignedCatalogProvider[];
}

export type UnsignedCatalogModel = Omit<CatalogModel, "fingerprint">;
export interface UnsignedCatalogProvider extends Omit<CatalogProvider, "fingerprint" | "models"> {
  readonly models: readonly UnsignedCatalogModel[];
}

export interface CatalogSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly value: string;
}

export interface CatalogEnvelope {
  readonly schemaVersion: typeof PROVIDER_CATALOG_SCHEMA_VERSION;
  readonly catalog: ProviderCatalogSnapshot;
  readonly signature: CatalogSignature | null;
}

export interface CatalogSignatureVerifier {
  verify(input: {
    readonly canonicalCatalog: string;
    readonly fingerprint: string;
    readonly signature: CatalogSignature;
  }): boolean | Promise<boolean>;
}

export interface CatalogOverlay {
  readonly schemaVersion: typeof PROVIDER_CATALOG_SCHEMA_VERSION;
  readonly overlayId: string;
  readonly providers: readonly UnsignedCatalogProvider[];
}

export interface CatalogSelection {
  readonly provider: CatalogProvider;
  readonly model: CatalogModel;
  readonly freeTierState: FreeTierState;
  readonly verificationExpired: boolean;
}
