import { createHash } from "node:crypto";
import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import { parseProviderCatalog, selectCatalogModel, type ProviderCatalogSnapshot } from "@ai-dev-os/provider-catalog";
import { ProviderError, parseInferenceRequest, systemClock, type InferenceProvider } from "@ai-dev-os/providers";
import { parseSecretRef, secretRefFingerprint } from "@ai-dev-os/secrets";
import { createUnknownQuotaPort, parseRuntimeQuotaObservation } from "./quota.js";
import { PROVIDER_GATEWAY_SCHEMA_VERSION, type CreateProviderGatewayOptions, type GatewayAdapterReference, type GatewayInstanceSnapshot, type GatewayPreflight, type GatewayRuntimeStatus, type ProviderGateway, type RuntimeQuotaPort } from "./types.js";

const { ensureEnum, ensureExactKeys, ensureRecord, ensureString } = validation;
const PACKAGES = ["@ai-dev-os/provider-openai", "@ai-dev-os/provider-openai-compatible", "@ai-dev-os/provider-gemini", "@ai-dev-os/provider-ollama", "custom"] as const;
const id = (value: string, path: string) => ensureString(value, path, { maxLength: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, patternName: "stable ID" });
const digest = (value: unknown) => createHash("sha256").update(toCanonicalJson(value as never)).digest("hex");

function adapter(value: GatewayAdapterReference): GatewayAdapterReference {
  const input = ensureRecord(value, "adapter"); ensureExactKeys(input, ["packageName", "profileId", "version"], "adapter");
  return Object.freeze({ packageName: ensureEnum(input["packageName"], "adapter.packageName", PACKAGES), profileId: id(input["profileId"] as string, "adapter.profileId"), version: id(input["version"] as string, "adapter.version") });
}

interface Internal { readonly provider: InferenceProvider; readonly quota: RuntimeQuotaPort; readonly snapshot: GatewayInstanceSnapshot }

export async function createProviderGateway(options: CreateProviderGatewayOptions): Promise<ProviderGateway> {
  const catalog: ProviderCatalogSnapshot = parseProviderCatalog(options.catalog); const clock = options.clock ?? systemClock; const records = new Map<string, Internal>(); const secretFingerprints = new Set<string>();
  for (const [index, registration] of options.registrations.entries()) {
    const descriptor = registration.provider.describe(); const instanceId = descriptor.instanceId as string;
    if (records.has(instanceId)) throw new ProviderError("INVALID_REQUEST", "Provider gateway instance IDs must be unique.", { instanceId, index });
    const selected = selectCatalogModel({ catalog, providerId: registration.catalogProviderId, modelId: registration.catalogModelId, now: clock.now() });
    if (selected === undefined) throw new ProviderError("MODEL_UNAVAILABLE", "A gateway registration must reference one enabled catalog provider/model.", { providerId: registration.catalogProviderId, modelId: registration.catalogModelId });
    if (descriptor.providerId !== selected.provider.providerId) throw new ProviderError("INVALID_REQUEST", "The provider descriptor does not match the catalog provider identity.", { descriptorProviderId: descriptor.providerId, catalogProviderId: selected.provider.providerId });
    const models = await registration.provider.listModels(); const model = models.find((item) => item.model.modelId === registration.contractModelId);
    if (model === undefined || model.model.providerId !== descriptor.providerId) throw new ProviderError("MODEL_UNAVAILABLE", "The registered provider does not offer the declared contract model.", { contractModelId: registration.contractModelId });
    const ref = parseSecretRef(registration.secretRef); if (ref.providerInstanceId !== null && ref.providerInstanceId !== instanceId) throw new ProviderError("INVALID_REQUEST", "The SecretRef is bound to a different provider instance.", { instanceId });
    const refFingerprint = secretRefFingerprint(ref); if (secretFingerprints.has(refFingerprint)) throw new ProviderError("INVALID_REQUEST", "A SecretRef cannot be reused across gateway instances.", { instanceId }); secretFingerprints.add(refFingerprint);
    const parsedAdapter = adapter(registration.adapter); if (parsedAdapter.profileId !== selected.provider.adapterProfileId) throw new ProviderError("INVALID_REQUEST", "The adapter reference does not match the catalog profile.", { profileId: parsedAdapter.profileId, catalogProfileId: selected.provider.adapterProfileId });
    const eligibility = ensureEnum(registration.eligibility, "registration.eligibility", ["any", "verified-free-only"] as const); const userPreference = ensureEnum(registration.userPreference, "registration.userPreference", ["enabled", "disabled"] as const);
    const base = { schemaVersion: PROVIDER_GATEWAY_SCHEMA_VERSION, instanceId, contractModelId: registration.contractModelId, catalog: { catalogId: catalog.catalogId, catalogFingerprint: catalog.fingerprint, providerId: selected.provider.providerId, providerFingerprint: selected.provider.fingerprint, modelId: selected.model.modelId, modelFingerprint: selected.model.fingerprint, adapterProfileId: selected.provider.adapterProfileId, lastVerifiedAt: selected.model.verification.lastVerifiedAt, refreshAfter: selected.model.verification.refreshAfter }, descriptor, model, secretRefFingerprint: refFingerprint, eligibility, userPreference, adapter: parsedAdapter };
    const snapshot: GatewayInstanceSnapshot = Object.freeze({ ...base, fingerprint: digest(base) }); records.set(instanceId, Object.freeze({ provider: registration.provider, quota: registration.quota ?? createUnknownQuotaPort(clock), snapshot }));
  }
  const ordered = Object.freeze([...records.values()].map((item) => item.snapshot).sort((a, b) => a.instanceId.localeCompare(b.instanceId))); const gatewayFingerprint = digest({ schemaVersion: 1, catalogFingerprint: catalog.fingerprint, instances: ordered.map((item) => item.fingerprint) }); let closed = false;
  const find = (instanceId: string): Internal => { if (closed) throw new ProviderError("PROVIDER_CLOSED", "The provider gateway is closed.", {}); const normalized = id(instanceId, "instanceId"); const value = records.get(normalized); if (value === undefined) throw new ProviderError("MODEL_UNAVAILABLE", "The explicitly selected provider instance is not registered.", { instanceId: normalized }); return value; };
  const preflight = (input: { readonly instanceId: string; readonly request: Parameters<typeof parseInferenceRequest>[0] }): GatewayPreflight => {
    const record = find(input.instanceId); const request = parseInferenceRequest(input.request); const snapshot = record.snapshot;
    if (snapshot.userPreference !== "enabled") throw new ProviderError("POLICY_DENIED", "The explicitly selected provider instance is disabled by user preference.", { instanceId: snapshot.instanceId });
    if (request.modelId !== snapshot.contractModelId) throw new ProviderError("MODEL_UNAVAILABLE", "The request model does not match the explicitly selected gateway instance.", { requestedModelId: request.modelId, contractModelId: snapshot.contractModelId });
    const selected = selectCatalogModel({ catalog, providerId: snapshot.catalog.providerId, modelId: snapshot.catalog.modelId, now: clock.now(), requireVerifiedFreeTier: snapshot.eligibility === "verified-free-only" });
    if (selected === undefined) throw new ProviderError("MODEL_UNAVAILABLE", "The catalog entry is disabled, missing, or no longer verified for the configured eligibility policy.", { instanceId: snapshot.instanceId, eligibility: snapshot.eligibility });
    return Object.freeze({ instance: snapshot, request, catalogFreeTierState: selected.freeTierState });
  };
  return Object.freeze({ schemaVersion: PROVIDER_GATEWAY_SCHEMA_VERSION, catalog: () => catalog, fingerprint: () => gatewayFingerprint, listInstances: () => ordered, getInstance(instanceId: string) { return records.get(instanceId)?.snapshot; }, preflight, async invoke(input: Parameters<ProviderGateway["invoke"]>[0]) { const checked = preflight(input); return find(checked.instance.instanceId).provider.start(checked.request, input.options); }, async status(instanceId: string): Promise<GatewayRuntimeStatus> { const record = find(instanceId); const [health, quota] = await Promise.all([record.provider.health(), record.quota.observe({ instanceId: record.snapshot.instanceId, providerId: record.snapshot.catalog.providerId, catalogModelId: record.snapshot.catalog.modelId })]); return Object.freeze({ instance: record.snapshot, health, quota: parseRuntimeQuotaObservation(quota) }); }, async close() { if (closed) return; closed = true; await Promise.all([...new Set([...records.values()].map((item) => item.provider))].map((provider) => provider.close())); } });
}
