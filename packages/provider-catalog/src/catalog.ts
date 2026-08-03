import { toCanonicalJson } from "@ai-dev-os/domain";
import {
  PROVIDER_CATALOG_SCHEMA_VERSION,
  type CatalogEnvelope,
  type CatalogModel,
  type CatalogProvider,
  type CatalogSelection,
  type CatalogSignature,
  type CatalogSignatureVerifier,
  type FreeTierState,
  type ProviderCatalogSnapshot,
} from "./types.js";
import { CatalogValidationError, parseProviderCatalog } from "./validation.js";

export function normalizeCatalogIdentity(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveCatalogProvider(catalog: ProviderCatalogSnapshot, identity: string): CatalogProvider | undefined {
  const normalized = normalizeCatalogIdentity(identity);
  return catalog.providers.find((provider) => provider.providerId === normalized || provider.aliases.some((alias) => normalizeCatalogIdentity(alias) === normalized));
}

export function resolveCatalogModel(provider: CatalogProvider, identity: string): CatalogModel | undefined {
  const normalized = normalizeCatalogIdentity(identity);
  return provider.models.find((model) => model.modelId === normalized || model.aliases.some((alias) => normalizeCatalogIdentity(alias) === normalized));
}

export function effectiveFreeTierState(claim: { readonly state: FreeTierState }, verification: { readonly refreshAfter: string }, now: string | Date): FreeTierState {
  if (claim.state !== "verified") return claim.state;
  const nowMillis = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMillis)) throw new CatalogValidationError("INVALID_VERIFICATION_WINDOW", "now", "must be a valid instant");
  return nowMillis >= Date.parse(verification.refreshAfter) ? "unknown" : "verified";
}

export function selectCatalogModel(input: {
  readonly catalog: ProviderCatalogSnapshot;
  readonly providerId: string;
  readonly modelId: string;
  readonly now: string | Date;
  readonly requireVerifiedFreeTier?: boolean;
}): CatalogSelection | undefined {
  const provider = resolveCatalogProvider(input.catalog, input.providerId);
  if (provider === undefined || provider.state !== "enabled") return undefined;
  const model = resolveCatalogModel(provider, input.modelId);
  if (model === undefined || model.state !== "enabled") return undefined;
  const providerFree = effectiveFreeTierState(provider.freeTier, provider.verification, input.now);
  const modelFree = effectiveFreeTierState(model.freeTier, model.verification, input.now);
  const freeTierState: FreeTierState = providerFree === "verified" && modelFree === "verified" ? "verified" : modelFree === "ineligible" || providerFree === "ineligible" ? "ineligible" : modelFree === "not-free" || providerFree === "not-free" ? "not-free" : "unknown";
  if (input.requireVerifiedFreeTier === true && freeTierState !== "verified") return undefined;
  return Object.freeze({ provider, model, freeTierState, verificationExpired: provider.freeTier.state === "verified" && providerFree !== "verified" || model.freeTier.state === "verified" && modelFree !== "verified" });
}

function parseSignature(value: unknown): CatalogSignature {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CatalogValidationError("INVALID_CATALOG", "envelope.signature", "must be an object");
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== 3 || !keys.includes("algorithm") || !keys.includes("keyId") || !keys.includes("value")) throw new CatalogValidationError("INVALID_CATALOG", "envelope.signature", "contains missing or unknown fields");
  if (
    input["algorithm"] !== "ed25519"
    || typeof input["keyId"] !== "string"
    || !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(input["keyId"])
    || typeof input["value"] !== "string"
    || input["value"].length === 0
    || input["value"].length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(input["value"])
  ) throw new CatalogValidationError("INVALID_CATALOG", "envelope.signature", "is invalid or exceeds its bound");
  return Object.freeze({ algorithm: "ed25519", keyId: input["keyId"], value: input["value"] });
}

export async function parseCatalogEnvelope(value: unknown, options: {
  readonly source: "bundled" | "local" | "remote";
  readonly requireSignature?: boolean;
  readonly verifier?: CatalogSignatureVerifier;
}): Promise<CatalogEnvelope> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CatalogValidationError("INVALID_CATALOG", "envelope", "must be an object");
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== 3 || !keys.includes("schemaVersion") || !keys.includes("catalog") || !keys.includes("signature")) throw new CatalogValidationError("INVALID_CATALOG", "envelope", "contains missing or unknown fields");
  if (input["schemaVersion"] !== PROVIDER_CATALOG_SCHEMA_VERSION) throw new CatalogValidationError("UNSUPPORTED_SCHEMA", "envelope.schemaVersion", "unsupported envelope schema");
  const catalog = parseProviderCatalog(input["catalog"]);
  const signature = input["signature"] === null ? null : parseSignature(input["signature"]);
  const required = options.requireSignature === true || options.source === "remote";
  if (required && (signature === null || options.verifier === undefined)) throw new CatalogValidationError("INVALID_CATALOG", "envelope.signature", "signed remote catalog and verifier are required");
  if (signature !== null && options.verifier !== undefined) {
    const verified = await options.verifier.verify({ canonicalCatalog: toCanonicalJson(catalog), fingerprint: catalog.fingerprint, signature });
    if (!verified) throw new CatalogValidationError("INVALID_CATALOG", "envelope.signature", "signature verification failed");
  }
  return Object.freeze({ schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION, catalog, signature });
}
