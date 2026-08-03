import { PROVIDER_CATALOG_SCHEMA_VERSION, type CatalogOverlay, type ProviderCatalogSnapshot } from "./types.js";
import { CatalogValidationError, createProviderCatalog } from "./validation.js";

export function applyCatalogOverlay(base: ProviderCatalogSnapshot, overlay: CatalogOverlay): ProviderCatalogSnapshot {
  if (overlay.schemaVersion !== PROVIDER_CATALOG_SCHEMA_VERSION) throw new CatalogValidationError("UNSUPPORTED_SCHEMA", "overlay.schemaVersion", "unsupported overlay schema");
  if (!/^[a-z0-9][a-z0-9._/-]{0,126}[a-z0-9]$/u.test(overlay.overlayId)) throw new CatalogValidationError("INVALID_CATALOG", "overlay.overlayId", "must be a normalized stable identity");
  const byId = new Map(base.providers.map((provider) => [provider.providerId, provider] as const));
  const seen = new Set<string>();
  for (const provider of overlay.providers) {
    if (seen.has(provider.providerId)) throw new CatalogValidationError("DUPLICATE_IDENTITY", "overlay.providers", `duplicates ${provider.providerId}`);
    seen.add(provider.providerId);
    byId.set(provider.providerId, provider as never);
  }
  const providers = [...byId.values()]
    .sort((left, right) => left.providerId.localeCompare(right.providerId))
    .map((provider) => {
      const { fingerprint: _fingerprint, models, ...rest } = provider;
      return { ...rest, models: models.map(({ fingerprint: _modelFingerprint, ...model }) => model) };
    });
  return createProviderCatalog({
    schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
    catalogId: `${base.catalogId}/overlay/${overlay.overlayId}`,
    revision: base.revision + 1,
    generatedAt: base.generatedAt,
    providers,
  });
}
