import { describe, expect, it } from "vitest";
import { COMPILED_DEFAULT_CONFIGURATION, ConfigError, parseApplicationConfiguration, parseConfigurationLayer, planConfigurationChange, resolveConfiguration } from "../src/index.js";

const clock = { now: () => new Date("2026-08-02T00:00:00.000Z") };
describe("configuration parser edges", () => {
  it("rejects unsupported versions, duplicate identifiers, non-loopback endpoints, invalid extensions, and dangling references", () => {
    expect(() => parseApplicationConfiguration({ ...COMPILED_DEFAULT_CONFIGURATION, schemaVersion: 2 })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_SCHEMA_VERSION" }));
    expect(() => parseConfigurationLayer({ schemaVersion: 2, kind: "project", sourceName: "project", lockedFields: [], settings: {} })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_SCHEMA_VERSION" }));
    expect(() => parseApplicationConfiguration({ ...COMPILED_DEFAULT_CONFIGURATION, localModelEndpoints: [{ endpointId: "e", baseUrl: "https://example.com", timeoutMs: 1_000 }] })).toThrow(ConfigError);
    expect(() => parseConfigurationLayer({ schemaVersion: 1, kind: "project", sourceName: "project", lockedFields: [], settings: { providers: { mode: "merge-by-id", items: [{ instanceId: "p", providerId: "p", kind: "inference", enabled: true, locality: "cloud", credentialRef: null, endpointId: null, extensions: [{ namespace: "provider", schemaVersion: 1, value: { token: "no" } }] }] } } })).toThrowError(expect.objectContaining({ code: "INLINE_SECRET_FORBIDDEN" }));
    const duplicate = { ...COMPILED_DEFAULT_CONFIGURATION, modelAliases: [{ alias: "a", providerInstanceId: "missing", modelId: "m" }, { alias: "a", providerInstanceId: "missing", modelId: "m2" }] };
    expect(() => parseApplicationConfiguration(duplicate)).toThrow(ConfigError);
  });
  it("bounds extension depth and canonical size", () => {
    let deep: unknown = "leaf"; for (let index = 0; index < 10; index += 1) deep = { child: deep };
    expect(() => parseConfigurationLayer({ schemaVersion: 1, kind: "project", sourceName: "project", lockedFields: [], settings: { providers: { mode: "merge-by-id", items: [{ instanceId: "p", providerId: "p", kind: "inference", enabled: true, locality: "cloud", credentialRef: null, endpointId: null, extensions: [{ namespace: "provider", schemaVersion: 1, value: deep }] }] } } })).toThrow(ConfigError);
    expect(() => parseConfigurationLayer({ schemaVersion: 1, kind: "project", sourceName: "project", lockedFields: [], settings: { providers: { mode: "merge-by-id", items: [{ instanceId: "p", providerId: "p", kind: "inference", enabled: true, locality: "cloud", credentialRef: null, endpointId: null, extensions: [{ namespace: "provider", schemaVersion: 1, value: "x".repeat(17_000) }] }] } } })).toThrow(ConfigError);
  });
  it("orders resolution errors and returns canonical replay bytes", () => { const layers = [{ schemaVersion: 1, kind: "user", sourceName: "bad/path", lockedFields: [], settings: {} }, { schemaVersion: 1, kind: "system", sourceName: "bad:path", lockedFields: [], settings: {} }]; const first = resolveConfiguration(layers, { clock }); const second = resolveConfiguration(layers, { clock }); expect(first.errors.map((item) => item.code)).toEqual([...first.errors.map((item) => item.code)].sort()); expect(JSON.stringify(first)).toBe(JSON.stringify(second)); });
  it("produces an empty plan for identical configurations", () => { const plan = planConfigurationChange(COMPILED_DEFAULT_CONFIGURATION, COMPILED_DEFAULT_CONFIGURATION, { clock, activeOperations: 0 }); expect(plan.changes).toEqual([]); expect(plan.requiredActions).toEqual([]); expect(plan.audit.changeCount).toBe(0); });
  it("validates every optional layer field and its field-specific parser", () => {
    const budget = COMPILED_DEFAULT_CONFIGURATION.budgets.run;
    const handling = COMPILED_DEFAULT_CONFIGURATION.data.handlingPolicies;
    const parsed = parseConfigurationLayer({ schemaVersion: 1, kind: "runtime", sourceName: "complete runtime", lockedFields: ["approvals"], settings: {
      application: { installationId: "installation-2", displayName: "Configured" },
      localModelEndpoints: { mode: "replace", items: [{ endpointId: "endpoint", baseUrl: "http://localhost:11434/api", timeoutMs: 2_000 }] },
      providers: { mode: "replace", items: [{ instanceId: "provider", providerId: "provider", kind: "coding-agent", enabled: false, locality: "local", credentialRef: { schemaVersion: 1, type: "named", namespace: "provider", name: "credential", version: "v1", expectedKind: "text", providerInstanceId: "provider" }, endpointId: "endpoint", extensions: [{ namespace: "provider", schemaVersion: 1, value: { mode: "safe" } }] }] },
      modelAliases: { mode: "replace", items: [{ alias: "model", providerInstanceId: "provider", modelId: "model-id" }] },
      modelPreferences: { mode: "replace", items: [{ role: "review", aliases: ["model"] }] },
      routing: { defaultAlias: "model", fallbackAliases: ["model"], preferLocal: false },
      budgets: { run: budget, task: COMPILED_DEFAULT_CONFIGURATION.budgets.task },
      data: { defaultClassification: "internal", handlingPolicies: { mode: "merge-by-id", items: [handling[0]] }, forbidCloudByDefault: false },
      approvals: { defaultMode: "require-approval", rules: { mode: "replace", items: [{ ruleId: "write-approval", action: "workspace-write", minimumRisk: "medium", approverClass: "organization-admin" }] } },
      workspace: { requireIsolation: false, readOnlyByDefault: false, allowNetwork: true, maxWritableFiles: 10, maxOutputBytes: 1_000 },
      artifactStore: { storeId: "store-2", maxObjectBytes: 2_000, encryptionRequired: false },
      persistence: { adapter: "postgresql", locationId: "team-state", durability: "strict" },
      observability: { enabled: false, level: "debug", inputLogging: true, outputLogging: true, retentionDays: 2 },
      featureFlags: { localModels: false, plugins: true, experimentalRouting: true },
      preferences: { theme: "light", locale: "en-US", preferredLocality: "cloud", costPriority: 1, latencyPriority: 99, telemetryOptIn: true },
    } });
    const resolved = resolveConfiguration([parsed], { clock });
    expect(resolved.errors).toEqual([]);
    expect(resolved.configuration).toEqual(expect.objectContaining({ schemaVersion: 1 }));
  });
  it("serializes configuration errors safely", () => { expect(new ConfigError("INVALID_CONFIGURATION", "Invalid.", { causeCode: "fixture" }).toJSON()).toEqual(expect.objectContaining({ code: "INVALID_CONFIGURATION" })); });
});
