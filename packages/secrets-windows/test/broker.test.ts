import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  SecretBrokerError,
  parseSecretAccessContext,
  parseSecretRef,
  type SecretAuditRecord,
  type SecretMaterial,
  type SecretRef,
} from "@ai-dev-os/secrets";
import { windowsCredentialTargetBinding } from "../src/target.js";
import { parseProductionOptions } from "../src/broker.js";
import { WINDOWS_CREDENTIAL_MAX_SECRET_BYTES } from "../src/contracts.js";
import { parseWindowsCredentialReference } from "../src/target.js";
import {
  createWindowsCredentialSecretBrokerForTesting,
  type WindowsCredentialNativePort,
  type WindowsCredentialNativeReadResult,
} from "../src/testing/index.js";

const MARKER = "SYNTHETIC-WINDOWS-CREDENTIAL-DO-NOT-USE-7F4A1E";
const REFERENCE = parseSecretRef({
  schemaVersion: 1,
  type: "keychain",
  namespace: "anthropic",
  service: "api-key",
  account: "operator",
  version: null,
  expectedKind: "text",
  providerInstanceId: "anthropic:primary",
});

class Clock {
  value = Date.parse("2026-08-14T00:00:00.000Z");
  now(): Date { return new Date(this.value); }
}

function context(overrides: Record<string, unknown> = {}) {
  return parseSecretAccessContext({
    operationId: "operation-1",
    providerInstanceId: "anthropic:primary",
    purpose: "provider-authentication",
    requestedLifetimeMs: 30_000,
    accessForm: "text",
    classification: "internal",
    projectId: "project-1",
    taskId: "task-1",
    approvalEvidenceRefs: [],
    disclosureDecisionFingerprint: "a".repeat(64),
    locality: "local",
    trace: { traceId: "trace-1", runId: "run-1", taskId: "task-1", taskRunId: "attempt-1" },
    deadline: null,
    signal: undefined,
    ...overrides,
  });
}

function native(options: {
  availability?: () => unknown | Promise<unknown>;
  read?: () => unknown | Promise<unknown>;
} = {}) {
  const calls: Array<{ operation: "availability" | "read"; target: string }> = [];
  const port: WindowsCredentialNativePort = {
    async availability(target) {
      calls.push({ operation: "availability", target });
      return (await options.availability?.() ?? { status: "ok" }) as { status: "ok" };
    },
    async read(target) {
      calls.push({ operation: "read", target });
      return (await options.read?.() ?? { status: "ok", bytes: new TextEncoder().encode(MARKER) }) as WindowsCredentialNativeReadResult;
    },
  };
  return { port, calls };
}

function broker(options: {
  native?: ReturnType<typeof native>;
  audit?: (record: SecretAuditRecord) => void;
  clock?: Clock;
  onZero?: (record: { stage: "native-copy" | "material-copy"; byteLength: number; allZero: boolean }) => void;
} = {}) {
  const backend = options.native ?? native();
  const clock = options.clock ?? new Clock();
  return {
    backend,
    clock,
    value: createWindowsCredentialSecretBrokerForTesting({
      schemaVersion: 1,
      reference: REFERENCE,
      clock,
      native: backend.port,
      ...(options.audit === undefined ? {} : { audit: options.audit }),
      ...(options.onZero === undefined ? {} : { onZero: options.onZero }),
    }),
  };
}

describe("Windows credential target and admission", () => {
  it("derives one exact independent target vector without raw locator values", () => {
    const binding = windowsCredentialTargetBinding(REFERENCE);
    expect(binding.targetFingerprint).toBe("c15149fca4f1e6f48f8f7f96d0feb0b293980e7a5e76b7531c08ee04c8b79871");
    expect(binding.targetName).toBe(`AI-Dev-OS:v1:anthropic:${binding.targetFingerprint}`);
    expect(binding.targetName).not.toContain("operator");
    expect(binding.targetName).not.toContain("api-key");
    expect(binding.targetName).not.toContain("anthropic:primary");
    expect(binding.referenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("advertises only exact text resolution and availability", () => {
    const value = broker().value;
    expect(value.describeCapabilities()).toEqual({ resolve: true, availability: true, replace: false, revoke: false, versions: false, kinds: ["text"] });
    expect(Object.keys(value)).toEqual([
      "describeCapabilities",
      "describeTargetBinding",
      "availability",
      "withSecret",
      "replace",
      "revoke",
      "close",
      "toString",
      "toJSON",
    ]);
    expect(Object.getOwnPropertySymbols(value)).toEqual([Symbol.for("nodejs.util.inspect.custom")]);
    const binding = value.describeTargetBinding();
    const json = JSON.stringify(value);
    expect(JSON.parse(json)).toEqual({
      broker: "windows-credential",
      reference: `sha256:${binding.referenceFingerprint}`,
      capabilities: { resolve: true, availability: true, replace: false, revoke: false, versions: false, kinds: ["text"] },
    });
    for (const privateValue of [MARKER, "operator", "api-key", "anthropic:primary", binding.targetName]) {
      expect(json).not.toContain(privateValue);
      expect(inspect(value)).not.toContain(privateValue);
    }
  });

  it("rejects every other reference form and unsupported kind/version before native access", async () => {
    const fixture = broker();
    const variants: SecretRef[] = [
      parseSecretRef({ schemaVersion: 1, type: "named", namespace: "anthropic", name: "primary", version: null, expectedKind: "text", providerInstanceId: "anthropic:primary" }),
      parseSecretRef({ schemaVersion: 1, type: "environment", namespace: "anthropic", variableName: "ANTHROPIC_KEY", version: null, expectedKind: "text", providerInstanceId: "anthropic:primary" }),
      parseSecretRef({ schemaVersion: 1, type: "encrypted-file", namespace: "anthropic", containerId: "container", entryName: "primary", version: null, expectedKind: "text", providerInstanceId: "anthropic:primary" }),
      parseSecretRef({ schemaVersion: 1, type: "external-vault", namespace: "anthropic", vaultNamespace: "operator", pathSegments: ["provider"], entryName: "primary", version: null, expectedKind: "text", providerInstanceId: "anthropic:primary" }),
      parseSecretRef({ ...REFERENCE, version: "version-1" }),
      parseSecretRef({ ...REFERENCE, expectedKind: "bytes" }),
    ];
    for (const item of variants) await expect(fixture.value.withSecret(item, context(), () => undefined)).rejects.toBeInstanceOf(SecretBrokerError);
    expect(fixture.backend.calls).toHaveLength(0);
  });

  it("rejects every exact-binding substitution before native access", async () => {
    const fixture = broker();
    const changes = [
      { namespace: "provider" },
      { service: "other" },
      { account: "other" },
      { providerInstanceId: "anthropic:other" },
    ];
    for (const change of changes) {
      const ref = parseSecretRef({ ...REFERENCE, ...change });
      await expect(fixture.value.availability(ref, context())).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    }
    await expect(fixture.value.availability(REFERENCE, context({ providerInstanceId: "anthropic:other" }))).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(fixture.backend.calls).toHaveLength(0);
  });

  it("fails closed on extra keys, accessors, symbols, prototypes, and proxies", () => {
    const base = { schemaVersion: 1, reference: REFERENCE, clock: new Clock(), native: native().port };
    expect(() => createWindowsCredentialSecretBrokerForTesting({ ...base, extra: true })).toThrow(SecretBrokerError);
    expect(() => createWindowsCredentialSecretBrokerForTesting(Object.assign(Object.create({ inherited: true }), base))).toThrow(SecretBrokerError);
    expect(() => createWindowsCredentialSecretBrokerForTesting(new Proxy(base, {}))).toThrow(SecretBrokerError);
    const symbol = { ...base, [Symbol("hidden")]: true };
    expect(() => createWindowsCredentialSecretBrokerForTesting(symbol)).toThrow(SecretBrokerError);
    const accessor = { ...base } as Record<string, unknown>;
    Object.defineProperty(accessor, "reference", { get: () => REFERENCE, enumerable: true });
    expect(() => createWindowsCredentialSecretBrokerForTesting(accessor)).toThrow(SecretBrokerError);
  });

  it("rejects hostile clock/native/audit option projections without invoking them", () => {
    const valid = { schemaVersion: 1, reference: REFERENCE, clock: new Clock(), native: native().port };
    for (const clock of [null, new Proxy(new Clock(), {}), Object.create(null), {}, { now: 1 }, Object.defineProperty({}, "now", { get: () => () => new Date(), enumerable: true })]) {
      expect(() => createWindowsCredentialSecretBrokerForTesting({ ...valid, clock })).toThrow(SecretBrokerError);
    }
    for (const nativePort of [null, new Proxy(native().port, {}), {}, { availability: async () => ({ status: "ok" }) }, Object.defineProperty({ read: async () => ({ status: "not-found" }) }, "availability", { get: () => async () => ({ status: "ok" }), enumerable: true })]) {
      expect(() => createWindowsCredentialSecretBrokerForTesting({ ...valid, native: nativePort })).toThrow(SecretBrokerError);
    }
    expect(() => createWindowsCredentialSecretBrokerForTesting({ ...valid, schemaVersion: 2 })).toThrow(SecretBrokerError);
    expect(() => createWindowsCredentialSecretBrokerForTesting({ ...valid, audit: 1 })).toThrow(SecretBrokerError);
    expect(() => createWindowsCredentialSecretBrokerForTesting({ ...valid, onZero: 1 })).toThrow(SecretBrokerError);
    expect(() => parseProductionOptions({ schemaVersion: 1, reference: REFERENCE, clock: new Clock(), audit: () => undefined })).not.toThrow();
  });

  it("invokes captured clock and hook functions intrinsically without leaking internal options as this", async () => {
    const clock = new Clock();
    const now = function () { return new Date(clock.value); };
    Object.defineProperty(now, "call", { value: () => { throw new Error(MARKER); } });
    Object.defineProperty(clock, "now", { value: now });
    let auditThis: unknown = "not-called";
    let zeroThis: unknown = "not-called";
    const fixture = broker({
      clock,
      audit: function (this: unknown) { auditThis = this; },
      onZero: function (this: unknown) { zeroThis = this; },
    });
    await expect(fixture.value.availability(REFERENCE, context())).resolves.toMatchObject({ available: true });
    await expect(fixture.value.withSecret(REFERENCE, context(), (material) => material.useText((text) => text.length))).resolves.toBe(MARKER.length);
    expect(auditThis).toBeUndefined();
    expect(zeroThis).toBeUndefined();
  });

  it("rejects hostile reference objects through finite exact projections", () => {
    expect(() => parseWindowsCredentialReference(null)).toThrow(SecretBrokerError);
    expect(() => parseWindowsCredentialReference(new Proxy({ ...REFERENCE }, {}))).toThrow(SecretBrokerError);
    expect(() => parseWindowsCredentialReference(Object.assign(Object.create({ inherited: true }), REFERENCE))).toThrow(SecretBrokerError);
    expect(() => parseWindowsCredentialReference({ ...REFERENCE, [Symbol("hidden")]: true })).toThrow(SecretBrokerError);
    const accessor = { ...REFERENCE } as Record<string, unknown>;
    Object.defineProperty(accessor, "account", { get: () => "operator", enumerable: true });
    expect(() => parseWindowsCredentialReference(accessor)).toThrow(SecretBrokerError);
  });
});

describe("Windows credential broker lifecycle", () => {
  it("distinguishes available, missing, denied, and unavailable without material", async () => {
    for (const [status, available, reason, outcome] of [
      ["ok", true, "available", "success"],
      ["not-found", false, "not-found", "not-found"],
      ["access-denied", false, "unavailable", "denied"],
      ["unavailable", false, "unavailable", "failure"],
      ["failure", false, "unavailable", "failure"],
    ] as const) {
      const fixture = broker({ native: native({ availability: () => ({ status }) }) });
      const result = await fixture.value.availability(REFERENCE, context());
      expect(result).toMatchObject({ available, reason, audit: { outcome } });
      expect(fixture.backend.calls).toHaveLength(1);
    }
  });

  it("keeps text callback-scoped and zeroes every owned JavaScript byte copy", async () => {
    const zeroes: Array<{ stage: string; allZero: boolean }> = [];
    const fixture = broker({ onZero: (record) => zeroes.push(record) });
    let retained: SecretMaterial | null = null;
    const length = await fixture.value.withSecret(REFERENCE, context(), async (material) => {
      retained = material;
      expect(Object.keys(material)).not.toContain("value");
      expect(String(material)).toBe("[REDACTED SECRET]");
      return material.useText((text) => text.length);
    });
    expect(length).toBe(MARKER.length);
    await expect((retained as unknown as SecretMaterial).useText((text) => text)).rejects.toMatchObject({ code: "MATERIAL_DISPOSED" });
    expect(zeroes).toEqual([
      expect.objectContaining({ stage: "native-copy", allZero: true }),
      expect.objectContaining({ stage: "material-copy", allZero: true }),
    ]);
  });

  it("zeroes the owned material copy even when a testing zero hook throws", async () => {
    const records: Array<{ stage: string; allZero: boolean }> = [];
    const fixture = broker({ onZero: (record) => {
      records.push(record);
      if (record.stage === "native-copy") throw new Error(MARKER);
    } });
    await expect(fixture.value.withSecret(REFERENCE, context(), () => undefined)).rejects.toMatchObject({ code: "BACKEND_FAILURE" });
    expect(records).toEqual([
      expect.objectContaining({ stage: "native-copy", allZero: true }),
      expect.objectContaining({ stage: "material-copy", allZero: true }),
    ]);
  });

  it("uses intrinsic byte operations when a native view shadows disposal methods", async () => {
    const bytes = new TextEncoder().encode(MARKER);
    Object.defineProperty(bytes, "fill", { value: () => { throw new Error(MARKER); } });
    Object.defineProperty(bytes, "every", { value: () => false });
    const fixture = broker({ native: native({ read: () => ({ status: "ok", bytes }) }) });
    await expect(fixture.value.withSecret(REFERENCE, context(), (material) => material.useText((text) => text.length))).resolves.toBe(MARKER.length);
    expect(Array.from(bytes)).toEqual(new Array(bytes.byteLength).fill(0));
  });

  it("rejects an attacker-shadowed byte length and zeroes the native view before callback", async () => {
    const bytes = new TextEncoder().encode(MARKER);
    const intrinsicLength = bytes.byteLength;
    Object.defineProperty(bytes, "length", { get: () => { throw new Error(MARKER); } });
    let callbacks = 0;
    const fixture = broker({ native: native({ read: () => ({ status: "ok", bytes }) }) });
    await expect(fixture.value.withSecret(REFERENCE, context(), () => { callbacks += 1; })).rejects.toMatchObject({ code: "MALFORMED_BACKEND_RESPONSE", message: "The Windows credential backend returned malformed material." });
    expect(callbacks).toBe(0);
    expect(Array.from(bytes)).toEqual(new Array(intrinsicLength).fill(0));
  });

  it("maps callback failure and keeps errors, JSON, and inspection free of material", async () => {
    const fixture = broker();
    const caught = await fixture.value.withSecret(REFERENCE, context(), () => { throw new Error(MARKER); }).catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: "CONSUMER_FAILURE", message: "The secret consumer callback failed." });
    expect(JSON.stringify(caught)).not.toContain(MARKER);
    expect(inspect(caught)).not.toContain(MARKER);
    expect(JSON.stringify(fixture.value)).not.toContain(MARKER);
    expect(inspect(fixture.value)).not.toContain(MARKER);
  });

  it("disposes retained material before success or failure outcome audit hooks", async () => {
    for (const fail of [false, true]) {
      let retained: SecretMaterial | null = null;
      let auditUse: Promise<unknown> | null = null;
      const fixture = broker({ audit: (record) => {
        if (record.operation === "resolve" && record.phase === "outcome") {
          auditUse = retained!.useText((text) => text);
        }
      } });
      const pending = fixture.value.withSecret(REFERENCE, context(), (material) => {
        retained = material;
        if (fail) throw new Error(MARKER);
        return 1;
      });
      if (fail) await expect(pending).rejects.toMatchObject({ code: "CONSUMER_FAILURE" });
      else await expect(pending).resolves.toBe(1);
      await expect(auditUse).rejects.toMatchObject({ code: "MATERIAL_DISPOSED" });
    }
  });

  it("maps every finite native failure and malformed projection", async () => {
    const malformedBytes = new Uint8Array([0xc0, 0x80]);
    for (const [result, code] of [
      [{ status: "not-found" }, "NOT_FOUND"],
      [{ status: "access-denied" }, "ACCESS_DENIED"],
      [{ status: "unavailable" }, "UNAVAILABLE"],
      [{ status: "failure" }, "BACKEND_FAILURE"],
      [{ status: "malformed" }, "MALFORMED_BACKEND_RESPONSE"],
      [{ status: "ok", bytes: new Uint8Array() }, "MALFORMED_BACKEND_RESPONSE"],
      [{ status: "ok", bytes: malformedBytes }, "MALFORMED_BACKEND_RESPONSE"],
      [{ status: "not-found", bytes: new TextEncoder().encode(MARKER) }, "MALFORMED_BACKEND_RESPONSE"],
      [{ status: "surprise" }, "MALFORMED_BACKEND_RESPONSE"],
    ] as const) {
      const fixture = broker({ native: native({ read: () => result }) });
      await expect(fixture.value.withSecret(REFERENCE, context(), () => undefined)).rejects.toMatchObject({ code });
    }
    expect(malformedBytes.every((byte) => byte === 0)).toBe(true);
    const throwing = broker({ native: native({ read: () => { throw new Error(MARKER); } }) });
    const error = await throwing.value.withSecret(REFERENCE, context(), () => undefined).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "BACKEND_FAILURE" });
    expect(JSON.stringify(error)).not.toContain(MARKER);
  });

  it("zeroes safely discoverable material before rejecting malformed result envelopes", async () => {
    for (const build of [
      (bytes: Uint8Array) => ({ status: "ok", bytes, extra: true }),
      (bytes: Uint8Array) => ({ status: "ok", bytes, [Symbol("hidden")]: true }),
      (bytes: Uint8Array) => Object.defineProperty({ bytes }, "status", { enumerable: true, get: () => "ok" }),
    ]) {
      const bytes = new TextEncoder().encode(MARKER);
      const fixture = broker({ native: native({ read: () => build(bytes) }) });
      await expect(fixture.value.withSecret(REFERENCE, context(), () => undefined)).rejects.toMatchObject({ code: "MALFORMED_BACKEND_RESPONSE", message: "The Windows credential backend returned malformed material." });
      expect(bytes.every((byte) => byte === 0)).toBe(true);
    }
    const bytes = new TextEncoder().encode(MARKER);
    const fixture = broker({ native: native({ availability: () => ({ status: "ok", bytes, extra: true }) }) });
    await expect(fixture.value.availability(REFERENCE, context())).rejects.toMatchObject({ code: "MALFORMED_BACKEND_RESPONSE", message: "The Windows credential backend returned malformed material." });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it("zeroes bare byte views returned or rejected by the hostile native boundary", async () => {
    for (const operation of ["availability", "read"] as const) {
      for (const mode of ["return", "reject"] as const) {
        const bytes = new TextEncoder().encode(MARKER);
        const action = () => mode === "return" ? bytes : Promise.reject(bytes);
        const backend = operation === "availability" ? native({ availability: action }) : native({ read: action });
        const fixture = broker({ native: backend });
        let callbacks = 0;
        const error = await (operation === "availability"
          ? fixture.value.availability(REFERENCE, context())
          : fixture.value.withSecret(REFERENCE, context(), () => { callbacks += 1; }))
          .catch((value: unknown) => value);
        expect(error).toMatchObject({ code: mode === "return" ? "MALFORMED_BACKEND_RESPONSE" : "BACKEND_FAILURE" });
        expect(Array.from(bytes)).toEqual(new Array(MARKER.length).fill(0));
        expect(callbacks).toBe(0);
      }
    }
  });

  it("accepts every canonical UTF-8 width without creating an unbounded validator", async () => {
    for (const bytes of [
      new Uint8Array([0xc2, 0xa2]),
      new Uint8Array([0xe0, 0xa0, 0x80]),
      new Uint8Array([0xe1, 0x80, 0x80]),
      new Uint8Array([0xed, 0x80, 0x80]),
      new Uint8Array([0xf0, 0x90, 0x80, 0x80]),
      new Uint8Array([0xf1, 0x80, 0x80, 0x80]),
      new Uint8Array([0xf4, 0x80, 0x80, 0x80]),
    ]) {
      const fixture = broker({ native: native({ read: () => ({ status: "ok", bytes }) }) });
      await expect(fixture.value.withSecret(REFERENCE, context(), (material) => material.useText((text) => text.length))).resolves.toBeGreaterThan(0);
    }
  });

  it("rejects every independent fatal UTF-8 boundary and zeroes the raw view before callback", async () => {
    for (const vector of [
      [0x80],
      [0xc2],
      [0xe0, 0x80, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf0, 0x80, 0x80, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
    ]) {
      const bytes = new Uint8Array(vector);
      let callbacks = 0;
      const fixture = broker({ native: native({ read: () => ({ status: "ok", bytes }) }) });
      await expect(fixture.value.withSecret(REFERENCE, context(), () => { callbacks += 1; })).rejects.toMatchObject({ code: "MALFORMED_BACKEND_RESPONSE" });
      expect(callbacks).toBe(0);
      expect(Array.from(bytes)).toEqual(new Array(vector.length).fill(0));
    }
  });

  it("zeroes byte-bearing native rejections and finitely rebuilds hostile backend errors", async () => {
    for (const operation of ["availability", "read"] as const) {
      for (const buildError of [
        (bytes: Uint8Array) => Object.assign(new SecretBrokerError("BACKEND_FAILURE", MARKER, { leaked: MARKER }, MARKER), { bytes }),
        (bytes: Uint8Array) => {
          const error = Object.assign(new SecretBrokerError("BACKEND_FAILURE", MARKER), { bytes });
          Object.defineProperty(error, "code", { get: () => { throw new Error(MARKER); } });
          return error;
        },
      ]) {
        const bytes = new TextEncoder().encode(MARKER);
        const thrown = buildError(bytes);
        const records: SecretAuditRecord[] = [];
        const backend = operation === "availability"
          ? native({ availability: () => { throw thrown; } })
          : native({ read: () => { throw thrown; } });
        const fixture = broker({ native: backend, audit: (record) => records.push(record) });
        let callbacks = 0;
        const error = await (operation === "availability"
          ? fixture.value.availability(REFERENCE, context())
          : fixture.value.withSecret(REFERENCE, context(), () => { callbacks += 1; }))
          .catch((value: unknown) => value);
        expect(error).toMatchObject({ code: "BACKEND_FAILURE", message: "The Windows credential backend failed.", details: {}, causeCategory: null });
        expect(JSON.stringify(error)).not.toContain(MARKER);
        expect(inspect(error)).not.toContain(MARKER);
        expect(Array.from(bytes)).toEqual(new Array(MARKER.length).fill(0));
        expect(callbacks).toBe(0);
        expect(records.map((record) => `${record.phase}:${record.outcome ?? "none"}`)).toEqual(["attempt:none", "outcome:failure"]);
      }
      const proxyError = new Proxy(new SecretBrokerError("BACKEND_FAILURE", MARKER, { leaked: MARKER }, MARKER), {});
      const proxyBackend = operation === "availability"
        ? native({ availability: () => { throw proxyError; } })
        : native({ read: () => { throw proxyError; } });
      const proxyFixture = broker({ native: proxyBackend });
      const projected = await (operation === "availability"
        ? proxyFixture.value.availability(REFERENCE, context())
        : proxyFixture.value.withSecret(REFERENCE, context(), () => undefined))
        .catch((value: unknown) => value);
      expect(projected).toMatchObject({ code: "BACKEND_FAILURE", message: "The Windows credential backend failed.", details: {}, causeCategory: null });
      expect(JSON.stringify(projected)).not.toContain(MARKER);
    }
  });

  it("accepts the exact secret byte ceiling and rejects and zeroes ceiling plus one before callback", async () => {
    const exact = new Uint8Array(WINDOWS_CREDENTIAL_MAX_SECRET_BYTES).fill(0x61);
    let exactCallbacks = 0;
    const accepted = broker({ native: native({ read: () => ({ status: "ok", bytes: exact }) }) });
    await expect(accepted.value.withSecret(REFERENCE, context(), (material) => { exactCallbacks += 1; return material.useText((text) => text.length); })).resolves.toBe(WINDOWS_CREDENTIAL_MAX_SECRET_BYTES);
    expect(exactCallbacks).toBe(1);
    expect(exact.every((byte) => byte === 0)).toBe(true);

    const oversized = new Uint8Array(WINDOWS_CREDENTIAL_MAX_SECRET_BYTES + 1).fill(0x61);
    let oversizedCallbacks = 0;
    const refused = broker({ native: native({ read: () => ({ status: "ok", bytes: oversized }) }) });
    await expect(refused.value.withSecret(REFERENCE, context(), () => { oversizedCallbacks += 1; })).rejects.toMatchObject({ code: "MALFORMED_BACKEND_RESPONSE" });
    expect(oversizedCallbacks).toBe(0);
    expect(oversized.every((byte) => byte === 0)).toBe(true);
  });

  it("maps invalid contexts, clocks, callbacks, and availability backend failures finitely", async () => {
    const invalidClock = broker({ clock: Object.assign(new Clock(), { now: () => new Date(Number.NaN) }) });
    await expect(invalidClock.value.availability(REFERENCE, context())).rejects.toMatchObject({ code: "AUDIT_FAILURE" });
    const throwingClock = broker({ clock: Object.assign(new Clock(), { now: () => { throw new Error(MARKER); } }) });
    await expect(throwingClock.value.availability(REFERENCE, context())).rejects.toMatchObject({ code: "AUDIT_FAILURE" });
    const shadowedAudits: SecretAuditRecord[] = [];
    const shadowedDate = new Date("2026-08-14T00:00:00.000Z");
    Object.defineProperty(shadowedDate, "valueOf", { value: () => { throw new Error(MARKER); } });
    Object.defineProperty(shadowedDate, "toISOString", { value: () => MARKER });
    const shadowedClock = broker({ clock: Object.assign(new Clock(), { now: () => shadowedDate }), audit: (record) => shadowedAudits.push(record) });
    const shadowedError = await shadowedClock.value.availability(REFERENCE, context()).catch((value: unknown) => value);
    expect(shadowedError).toMatchObject({ code: "AUDIT_FAILURE", message: "The secret clock failed." });
    expect(JSON.stringify(shadowedError)).not.toContain(MARKER);
    expect(shadowedAudits).toHaveLength(0);
    expect(shadowedClock.backend.calls).toHaveLength(0);
    const fixture = broker();
    await expect(fixture.value.availability(REFERENCE, {} as never)).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    await expect(fixture.value.availability(REFERENCE, context({ deadline: "2026-08-13T23:59:59.000Z" }))).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });
    await expect(fixture.value.withSecret(REFERENCE, context(), 1 as never)).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    const throwing = broker({ native: native({ availability: () => { throw new Error(MARKER); } }) });
    await expect(throwing.value.availability(REFERENCE, context())).rejects.toMatchObject({ code: "BACKEND_FAILURE" });
    const invalid = broker({ native: native({ availability: () => ({ status: "surprise" }) }) });
    await expect(invalid.value.availability(REFERENCE, context())).rejects.toMatchObject({ code: "MALFORMED_BACKEND_RESPONSE" });
    const leaked = new TextEncoder().encode(MARKER);
    const material = broker({ native: native({ availability: () => ({ status: "ok", bytes: leaked }) }) });
    await expect(material.value.availability(REFERENCE, context())).rejects.toMatchObject({ code: "MALFORMED_BACKEND_RESPONSE" });
    expect(leaked.every((byte) => byte === 0)).toBe(true);
    expect(fixture.value.describeTargetBinding().targetName).toMatch(/^AI-Dev-OS:v1:/);
    expect(String(fixture.value)).toBe("[WindowsCredentialSecretBroker]");
  });

  it("checks cancellation and deadlines before and after native access and clears late material", async () => {
    const controller = new AbortController(); controller.abort();
    const pre = broker();
    await expect(pre.value.withSecret(REFERENCE, context({ signal: controller.signal }), () => undefined)).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });
    expect(pre.backend.calls).toHaveLength(0);

    const lateController = new AbortController();
    let release!: () => void;
    const lateBytes = new TextEncoder().encode(MARKER);
    const late = broker({ native: native({ read: async () => { await new Promise<void>((resolve) => { release = resolve; }); return { status: "ok", bytes: lateBytes }; } }) });
    const pending = late.value.withSecret(REFERENCE, context({ signal: lateController.signal }), () => undefined);
    await Promise.resolve();
    lateController.abort(); release();
    await expect(pending).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });
    expect(lateBytes.every((byte) => byte === 0)).toBe(true);

    const availabilityController = new AbortController();
    let releaseAvailability!: () => void;
    const availabilityBytes = new TextEncoder().encode(MARKER);
    const availability = broker({ native: native({ availability: async () => {
      await new Promise<void>((resolve) => { releaseAvailability = resolve; });
      return { status: "ok", bytes: availabilityBytes };
    } }) });
    const availabilityPending = availability.value.availability(REFERENCE, context({ signal: availabilityController.signal }));
    await Promise.resolve();
    availabilityController.abort(); releaseAvailability();
    await expect(availabilityPending).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });
    expect(availabilityBytes.every((byte) => byte === 0)).toBe(true);

    const clock = new Clock();
    const deadline = new Date(clock.value + 1).toISOString();
    const timed = broker({ clock, native: native({ read: () => { clock.value += 1; return { status: "ok", bytes: new TextEncoder().encode(MARKER) }; } }) });
    await expect(timed.value.withSecret(REFERENCE, context({ deadline }), () => undefined)).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });
  });

  it("preserves and audits a late cancellation when the testing zero hook also throws", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const bytes = new TextEncoder().encode(MARKER);
    const records: SecretAuditRecord[] = [];
    const fixture = broker({
      native: native({ read: async () => { await new Promise<void>((resolve) => { release = resolve; }); return { status: "ok", bytes }; } }),
      audit: (record) => records.push(record),
      onZero: () => { throw new Error(MARKER); },
    });
    const pending = fixture.value.withSecret(REFERENCE, context({ signal: controller.signal }), () => undefined);
    while (release === undefined) await Promise.resolve();
    controller.abort();
    release();
    await expect(pending).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT", message: "The Windows credential operation timed out or was cancelled." });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(records.map((record) => `${record.phase}:${record.outcome ?? "none"}`)).toEqual(["attempt:none", "outcome:failure"]);
  });

  it("runs attempt before backend, records exact outcomes, and fails closed on either audit hook", async () => {
    const order: string[] = [];
    const backend = native({ read: () => { order.push("native"); return { status: "ok", bytes: new TextEncoder().encode(MARKER) }; } });
    const fixture = broker({ native: backend, audit: (record) => order.push(`${record.phase}:${record.outcome ?? "none"}`) });
    await fixture.value.withSecret(REFERENCE, context(), () => { order.push("callback"); });
    expect(order).toEqual(["attempt:none", "native", "callback", "outcome:success"]);

    const attemptBackend = native();
    const attempt = broker({ native: attemptBackend, audit: (record) => { if (record.phase === "attempt") throw new Error(MARKER); } });
    await expect(attempt.value.withSecret(REFERENCE, context(), () => undefined)).rejects.toMatchObject({ code: "AUDIT_FAILURE" });
    expect(attemptBackend.calls).toHaveLength(0);

    const outcome = broker({ audit: (record) => { if (record.phase === "outcome") throw new Error(MARKER); } });
    await expect(outcome.value.withSecret(REFERENCE, context(), () => undefined)).rejects.toMatchObject({ code: "AUDIT_FAILURE" });
  });

  it("emits only the exact finite audit projection for resolve and close", async () => {
    const records: SecretAuditRecord[] = [];
    const fixture = broker({ audit: (record) => records.push(record) });
    await fixture.value.withSecret(REFERENCE, context(), (material) => material.useText((text) => text.length));
    await fixture.value.close();
    expect(records).toHaveLength(4);
    for (const record of records) {
      expect(Object.keys(record)).toEqual(["schemaVersion", "operation", "phase", "outcome", "occurredAt", "reference", "operationId", "providerInstanceId", "purpose", "traceId"]);
    }
    expect(records[0]).toEqual({
      schemaVersion: 1,
      operation: "resolve",
      phase: "attempt",
      outcome: null,
      occurredAt: "2026-08-14T00:00:00.000Z",
      reference: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      operationId: "operation-1",
      providerInstanceId: "anthropic:primary",
      purpose: "provider-authentication",
      traceId: "trace-1",
    });
    expect(records[1]).toMatchObject({ operation: "resolve", phase: "outcome", outcome: "success" });
    expect(records[2]).toEqual({ schemaVersion: 1, operation: "close", phase: "attempt", outcome: null, occurredAt: "2026-08-14T00:00:00.000Z", reference: null, operationId: null, providerInstanceId: null, purpose: null, traceId: null });
    expect(records[3]).toEqual({ schemaVersion: 1, operation: "close", phase: "outcome", outcome: "closed", occurredAt: "2026-08-14T00:00:00.000Z", reference: null, operationId: null, providerInstanceId: null, purpose: null, traceId: null });
    const serialized = JSON.stringify(records);
    for (const privateValue of [MARKER, "operator", "api-key", fixture.value.describeTargetBinding().targetName]) expect(serialized).not.toContain(privateValue);
  });

  it("rechecks close, cancellation, and deadline after the attempt audit before native access", async () => {
    const clock = new Clock();
    const deadline = new Date(clock.value + 1).toISOString();
    const timedRecords: string[] = [];
    const timed = broker({ clock, audit: (record) => { timedRecords.push(`${record.phase}:${record.outcome ?? "none"}`); if (record.phase === "attempt") clock.value += 1; } });
    await expect(timed.value.withSecret(REFERENCE, context({ deadline }), () => undefined)).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });
    expect(timed.backend.calls).toHaveLength(0);
    expect(timedRecords).toEqual(["attempt:none", "outcome:failure"]);

    const controller = new AbortController();
    const cancelledRecords: string[] = [];
    const cancelled = broker({ audit: (record) => { cancelledRecords.push(`${record.phase}:${record.outcome ?? "none"}`); if (record.phase === "attempt") controller.abort(); } });
    await expect(cancelled.value.availability(REFERENCE, context({ signal: controller.signal }))).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });
    expect(cancelled.backend.calls).toHaveLength(0);
    expect(cancelledRecords).toEqual(["attempt:none", "outcome:failure"]);

    let closing!: ReturnType<typeof broker>;
    closing = broker({ audit: (record) => { if (record.operation === "resolve" && record.phase === "attempt") void closing.value.close(); } });
    await expect(closing.value.withSecret(REFERENCE, context(), () => undefined)).rejects.toMatchObject({ code: "BROKER_CLOSED" });
    expect(closing.backend.calls).toHaveLength(0);
    await closing.value.close();
  });

  it("makes audit-reentrant close single-flight and wait for the entered operation", async () => {
    let release!: () => void;
    let closeFromAudit: Promise<void> | null = null;
    let fixture!: ReturnType<typeof broker>;
    fixture = broker({
      native: native({ read: async () => { await new Promise<void>((resolve) => { release = resolve; }); return { status: "ok", bytes: new TextEncoder().encode(MARKER) }; } }),
      audit: (record) => { if (record.operation === "resolve" && record.phase === "attempt") closeFromAudit = fixture.value.close(); },
    });
    const active = fixture.value.withSecret(REFERENCE, context(), (material) => material.useText((text) => text.length));
    while (closeFromAudit === null) await Promise.resolve();
    let closed = false;
    void closeFromAudit.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(fixture.backend.calls).toHaveLength(0);
    // The close reentrancy intentionally blocks boundary entry, so no native read starts.
    await expect(active).rejects.toMatchObject({ code: "BROKER_CLOSED" });
    await closeFromAudit;
    expect(closed).toBe(true);
  });

  it("publishes the close promise before close audit reentrancy", async () => {
    let reentered: Promise<void> | null = null;
    let fixture!: ReturnType<typeof broker>;
    fixture = broker({ audit: (record) => { if (record.operation === "close" && record.phase === "attempt") reentered = fixture.value.close(); } });
    const first = fixture.value.close();
    while (reentered === null) await Promise.resolve();
    await expect(Promise.all([first, reentered])).resolves.toHaveLength(2);
  });

  it("drains entered native and callback work before reporting a close-attempt audit failure", async () => {
    let releaseRead!: () => void;
    let releaseCallback!: () => void;
    const fixture = broker({
      native: native({ read: async () => { await new Promise<void>((resolve) => { releaseRead = resolve; }); return { status: "ok", bytes: new TextEncoder().encode(MARKER) }; } }),
      audit: (record) => { if (record.operation === "close" && record.phase === "attempt") throw new Error(MARKER); },
    });
    const active = fixture.value.withSecret(REFERENCE, context(), async () => new Promise<void>((resolve) => { releaseCallback = resolve; }));
    while (releaseRead === undefined) await Promise.resolve();
    const closing = fixture.value.close();
    let settled = false;
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseRead();
    while (releaseCallback === undefined) await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCallback();
    await active;
    await expect(closing).rejects.toMatchObject({ code: "AUDIT_FAILURE", message: "The secret audit hook failed." });
    expect(settled).toBe(true);
  });

  it("captures native methods, isolates concurrent reads, and makes close idempotent", async () => {
    const mutable = native();
    const fixture = broker({ native: mutable });
    mutable.port.read = async () => ({ status: "not-found" });
    expect(await fixture.value.withSecret(REFERENCE, context(), (material) => material.useText((text) => text.length))).toBe(MARKER.length);

    let releaseRead!: () => void;
    let releaseCallback!: () => void;
    const held = broker({ native: native({ read: async () => { await new Promise<void>((resolve) => { releaseRead = resolve; }); return { status: "ok", bytes: new TextEncoder().encode(MARKER) }; } }) });
    const active = held.value.withSecret(REFERENCE, context(), async () => new Promise<void>((resolve) => { releaseCallback = resolve; }));
    await Promise.resolve();
    const closing = held.value.close();
    let closed = false; void closing.then(() => { closed = true; });
    await expect(held.value.availability(REFERENCE, context())).rejects.toMatchObject({ code: "BROKER_CLOSED" });
    releaseRead();
    while (releaseCallback === undefined) await Promise.resolve();
    await Promise.resolve(); expect(closed).toBe(false);
    releaseCallback(); await active; await closing;
    await expect(held.value.close()).resolves.toBeUndefined();
  });

  it("refuses callback-reentrant close finitely instead of deadlocking", async () => {
    const fixture = broker();
    await fixture.value.withSecret(REFERENCE, context(), async () => {
      await expect(fixture.value.close()).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    });
    await expect(fixture.value.close()).resolves.toBeUndefined();
  });

  it("implements interface-mandated replace/revoke as audited unsupported operations with zero native access", async () => {
    const records: SecretAuditRecord[] = [];
    const fixture = broker({ audit: (record) => records.push(record) });
    await expect(fixture.value.replace(REFERENCE, { kind: "text", text: MARKER }, context())).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(fixture.value.revoke(REFERENCE, context())).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    expect(fixture.backend.calls).toHaveLength(0);
    expect(records.filter((record) => record.outcome === "unsupported")).toHaveLength(2);
  });
});
