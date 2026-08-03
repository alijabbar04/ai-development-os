import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROVIDER_CATALOG,
  CatalogValidationError,
  PROVIDER_CATALOG_SCHEMA_VERSION,
  applyCatalogOverlay,
  effectiveFreeTierState,
  parseCatalogEnvelope,
  parseProviderCatalog,
  resolveCatalogProvider,
  selectCatalogModel,
  type CatalogOverlay,
} from "./index.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("built-in provider catalog", () => {
  it("is immutable, fingerprinted, finite, and explicitly excludes automatic OpenRouter routing", () => {
    expect(Object.isFrozen(BUILTIN_PROVIDER_CATALOG)).toBe(true);
    expect(Object.isFrozen(BUILTIN_PROVIDER_CATALOG.providers[0]?.models[0])).toBe(true);
    expect(BUILTIN_PROVIDER_CATALOG.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(BUILTIN_PROVIDER_CATALOG.providers.map((provider) => provider.providerId)).toEqual([
      "google-gemini", "groq", "cerebras", "openrouter",
    ]);
    expect(BUILTIN_PROVIDER_CATALOG.providers.flatMap((provider) => provider.models.map((model) => model.modelId))).not.toContain("openrouter/free");
    expect(parseProviderCatalog(BUILTIN_PROVIDER_CATALOG)).toEqual(BUILTIN_PROVIDER_CATALOG);
  });

  it("resolves explicit aliases and fails closed when free verification expires", () => {
    expect(resolveCatalogProvider(BUILTIN_PROVIDER_CATALOG, " GEMINI ")?.providerId).toBe("google-gemini");
    expect(selectCatalogModel({ catalog: BUILTIN_PROVIDER_CATALOG, providerId: "gemini", modelId: "gemini-3.5-flash", now: "2026-08-09T23:59:59.999Z", requireVerifiedFreeTier: true })?.freeTierState).toBe("verified");
    expect(selectCatalogModel({ catalog: BUILTIN_PROVIDER_CATALOG, providerId: "gemini", modelId: "gemini-3.5-flash", now: "2026-08-10T00:00:00.000Z", requireVerifiedFreeTier: true })).toBeUndefined();
    expect(effectiveFreeTierState({ state: "not-free" }, { refreshAfter: "2020-01-01T00:00:00.000Z" }, new Date())).toBe("not-free");
    expect(effectiveFreeTierState({ state: "verified" }, { refreshAfter: "2026-08-10T00:00:00.000Z" }, new Date("2026-08-04T00:00:00.000Z"))).toBe("verified");
    expect(() => effectiveFreeTierState({ state: "verified" }, { refreshAfter: "2026-08-10T00:00:00.000Z" }, "bad-date")).toThrowError(CatalogValidationError);
  });

  it("returns no selection for absent and disabled entries and preserves finite non-free states", () => {
    expect(selectCatalogModel({ catalog: BUILTIN_PROVIDER_CATALOG, providerId: "absent", modelId: "x", now: VERIFIED_NOW })).toBeUndefined();
    expect(selectCatalogModel({ catalog: BUILTIN_PROVIDER_CATALOG, providerId: "groq", modelId: "absent", now: VERIFIED_NOW })).toBeUndefined();
    const value: any = clone(BUILTIN_PROVIDER_CATALOG);
    value.providers[0].state = "disabled";
    expect(selectCatalogModel({ catalog: value, providerId: "google-gemini", modelId: "gemini-3.5-flash", now: VERIFIED_NOW })).toBeUndefined();
    value.providers[0].state = "enabled";
    value.providers[0].models[0].state = "disabled";
    expect(selectCatalogModel({ catalog: value, providerId: "google-gemini", modelId: "gemini-3.5-flash", now: VERIFIED_NOW })).toBeUndefined();
    value.providers[0].models[0].state = "enabled";
    value.providers[0].freeTier.state = "ineligible";
    expect(selectCatalogModel({ catalog: value, providerId: "google-gemini", modelId: "gemini-3.5-flash", now: VERIFIED_NOW })?.freeTierState).toBe("ineligible");
    value.providers[0].freeTier.state = "not-free";
    expect(selectCatalogModel({ catalog: value, providerId: "google-gemini", modelId: "gemini-3.5-flash", now: VERIFIED_NOW })?.freeTierState).toBe("not-free");
  });
});

const VERIFIED_NOW = "2026-08-04T00:00:00.000Z";

describe("catalog validation", () => {
  it.each([
    ["newer schema", (value: any) => { value.schemaVersion = 2; }, "UNSUPPORTED_SCHEMA"],
    ["fingerprint mutation", (value: any) => { value.catalogId = "mutated"; }, "FINGERPRINT_MISMATCH"],
    ["non-HTTPS origin", (value: any) => { value.providers[0].endpoint.origin = "http://example.com"; }, "UNSAFE_ENDPOINT"],
    ["URL credentials", (value: any) => { value.providers[0].endpoint.origin = "https://key@example.com"; }, "UNSAFE_ENDPOINT"],
    ["wildcard origin", (value: any) => { value.providers[0].endpoint.origin = "https://*.example.com"; }, "UNSAFE_ENDPOINT"],
    ["malformed origin", (value: any) => { value.providers[0].endpoint.origin = "not a url"; }, "UNSAFE_ENDPOINT"],
    ["unbounded redirects", (value: any) => { value.providers[0].endpoint.redirectPolicy = "follow"; }, "UNSAFE_ENDPOINT"],
    ["unknown field", (value: any) => { value.providers[0].endpoint.headers = {}; }, "INVALID_CATALOG"],
    ["missing capability evidence", (value: any) => { value.providers[0].models[0].capabilities[0].evidenceUrl = null; }, "UNSAFE_CAPABILITY_ESCALATION"],
    ["impossible expiry", (value: any) => { value.providers[0].verification.refreshAfter = value.providers[0].verification.lastVerifiedAt; }, "INVALID_VERIFICATION_WINDOW"],
    ["ambiguous alias", (value: any) => { value.providers[1].aliases = ["same", " SAME "]; }, "AMBIGUOUS_ALIAS"],
  ])("rejects %s", (_label, mutate, code) => {
    const value = clone(BUILTIN_PROVIDER_CATALOG);
    mutate(value);
    expect(() => parseProviderCatalog(value)).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects duplicate model identities before accepting a recomputed outer fingerprint", () => {
    const value: any = clone(BUILTIN_PROVIDER_CATALOG);
    value.providers[0]!.models.push(value.providers[0]!.models[0]!);
    expect(() => parseProviderCatalog(value)).toThrowError(expect.objectContaining({ code: "DUPLICATE_IDENTITY" }));
  });
});

describe("signed envelopes and overlays", () => {
  it("requires and verifies signatures for remote catalogs", async () => {
    await expect(parseCatalogEnvelope({ schemaVersion: 1, catalog: BUILTIN_PROVIDER_CATALOG, signature: null }, { source: "remote" })).rejects.toMatchObject({ code: "INVALID_CATALOG" });
    const signature = { algorithm: "ed25519" as const, keyId: "catalog-key", value: "bounded-signature" };
    let canonical = "";
    await expect(parseCatalogEnvelope(
      { schemaVersion: 1, catalog: BUILTIN_PROVIDER_CATALOG, signature },
      { source: "remote", verifier: { verify(input) { canonical = input.canonicalCatalog; return true; } } },
    )).resolves.toMatchObject({ catalog: BUILTIN_PROVIDER_CATALOG, signature });
    expect(canonical).toContain(BUILTIN_PROVIDER_CATALOG.fingerprint);
    await expect(parseCatalogEnvelope(
      { schemaVersion: 1, catalog: BUILTIN_PROVIDER_CATALOG, signature },
      { source: "remote", verifier: { verify: () => false } },
    )).rejects.toMatchObject({ code: "INVALID_CATALOG" });
  });

  it.each([
    [null, "INVALID_CATALOG"],
    [{ schemaVersion: 1, catalog: BUILTIN_PROVIDER_CATALOG }, "INVALID_CATALOG"],
    [{ schemaVersion: 2, catalog: BUILTIN_PROVIDER_CATALOG, signature: null }, "UNSUPPORTED_SCHEMA"],
    [{ schemaVersion: 1, catalog: BUILTIN_PROVIDER_CATALOG, signature: "bad" }, "INVALID_CATALOG"],
    [{ schemaVersion: 1, catalog: BUILTIN_PROVIDER_CATALOG, signature: { algorithm: "ed25519", keyId: "k" } }, "INVALID_CATALOG"],
    [{ schemaVersion: 1, catalog: BUILTIN_PROVIDER_CATALOG, signature: { algorithm: "rsa", keyId: "k", value: "v" } }, "INVALID_CATALOG"],
    [{ schemaVersion: 1, catalog: BUILTIN_PROVIDER_CATALOG, signature: { algorithm: "ed25519", keyId: "", value: "v" } }, "INVALID_CATALOG"],
  ])("rejects malformed envelope %#", async (value, code) => {
    await expect(parseCatalogEnvelope(value, { source: "local" })).rejects.toMatchObject({ code });
  });

  it("accepts a local unsigned envelope and does not imply verification for an unchecked local signature", async () => {
    await expect(parseCatalogEnvelope({ schemaVersion: 1, catalog: BUILTIN_PROVIDER_CATALOG, signature: null }, { source: "local" })).resolves.toMatchObject({ signature: null });
    const signature = { algorithm: "ed25519" as const, keyId: "local", value: "unchecked" };
    await expect(parseCatalogEnvelope({ schemaVersion: 1, catalog: BUILTIN_PROVIDER_CATALOG, signature }, { source: "local" })).resolves.toMatchObject({ signature });
  });

  it("applies deterministic whole-provider overlays and revalidates escalation", () => {
    const groq = clone(BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.providerId === "groq")!);
    const { fingerprint: _providerFingerprint, models, ...provider } = groq;
    const unsignedModels = models.map(({ fingerprint: _modelFingerprint, ...model }) => model);
    const overlay: CatalogOverlay = { schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION, overlayId: "operator-1", providers: [{ ...provider, displayName: "Operator Groq", models: unsignedModels }] };
    const first = applyCatalogOverlay(BUILTIN_PROVIDER_CATALOG, overlay);
    const second = applyCatalogOverlay(BUILTIN_PROVIDER_CATALOG, overlay);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.providers.find((item) => item.providerId === "groq")?.displayName).toBe("Operator Groq");

    const unsafe: any = clone(overlay);
    unsafe.providers[0]!.models[0]!.capabilities[0] = { ...unsafe.providers[0]!.models[0]!.capabilities[0]!, status: "supported", evidenceUrl: null };
    expect(() => applyCatalogOverlay(BUILTIN_PROVIDER_CATALOG, unsafe)).toThrowError(CatalogValidationError);
  });

  it("rejects invalid, newer, and duplicate overlay identities", () => {
    const base: CatalogOverlay = { schemaVersion: 1, overlayId: "valid-1", providers: [] };
    expect(() => applyCatalogOverlay(BUILTIN_PROVIDER_CATALOG, { ...base, schemaVersion: 2 as 1 })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_SCHEMA" }));
    expect(() => applyCatalogOverlay(BUILTIN_PROVIDER_CATALOG, { ...base, overlayId: "INVALID" })).toThrowError(expect.objectContaining({ code: "INVALID_CATALOG" }));
    const groq: any = clone(BUILTIN_PROVIDER_CATALOG.providers[1]);
    delete groq.fingerprint;
    for (const model of groq.models) delete model.fingerprint;
    expect(() => applyCatalogOverlay(BUILTIN_PROVIDER_CATALOG, { ...base, providers: [groq, groq] })).toThrowError(expect.objectContaining({ code: "DUPLICATE_IDENTITY" }));
  });
});
