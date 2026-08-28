import { describe, expect, it, vi } from "vitest";
import {
  BEARER_TOKEN_PATTERN,
  CONTROL_HOST,
  START_NONCE_PATTERN,
  createLaunchIdentity,
  createServerBearerSession,
  parseConnectionDescriptor,
  parseInstanceLock,
  serializeConnectionDescriptor,
  serializeInstanceLock,
} from "../src/index.js";

const NOW = "2026-08-26T10:00:00.000Z";
const LATER = "2026-08-26T10:15:00.000Z";
const EXPIRED = "2026-08-26T10:15:00.001Z";

function deterministicIdentity() {
  let call = 0;
  return createLaunchIdentity({
    now: NOW,
    random(size) {
      call += 1;
      return Buffer.alloc(size, call);
    },
  });
}

function descriptor() {
  return {
    schemaVersion: 1,
    serviceVersion: "0.1.0",
    presentationMode: "normal",
    host: CONTROL_HOST,
    port: 43123,
    processId: 772,
    ...deterministicIdentity(),
  };
}

describe("C3 per-launch identity and session", () => {
  it("uses independent random calls and incompatible exact nonce/token shapes", () => {
    const random = vi.fn((size: number) => Buffer.alloc(size, size));
    const identity = createLaunchIdentity({ now: NOW, random });
    expect(random.mock.calls).toEqual([[16], [32]]);
    expect(identity.startNonce).toMatch(START_NONCE_PATTERN);
    expect(identity.startNonce).toHaveLength(32);
    expect(identity.bearerToken).toMatch(BEARER_TOKEN_PATTERN);
    expect(identity.bearerToken).toHaveLength(43);
    expect(BEARER_TOKEN_PATTERN.test(identity.startNonce)).toBe(false);
    expect(START_NONCE_PATTERN.test(identity.bearerToken)).toBe(false);
    expect(identity.expiresAt).toBe(LATER);
  });

  it("retains only closure-backed digest authentication and has finite states", () => {
    const value = descriptor();
    const session = createServerBearerSession({
      serviceVersion: value.serviceVersion,
      startNonce: value.startNonce,
      bearerToken: value.bearerToken,
      issuedAt: value.issuedAt,
      expiresAt: value.expiresAt,
    });
    expect(Object.keys(session).sort()).toEqual([
      "authenticate", "expiresAt", "issuedAt", "serviceVersion", "startNonce", "stateAt",
    ]);
    expect(JSON.stringify(session)).not.toContain(value.bearerToken);
    expect(session.authenticate(value.bearerToken, NOW)).toBe("active");
    expect(session.authenticate(value.startNonce, NOW)).toBe("refused");
    expect(session.authenticate("x".repeat(43), NOW)).toBe("refused");
    expect(session.authenticate(value.bearerToken, EXPIRED)).toBe("expired");
    expect(session.stateAt(EXPIRED)).toBe("expired");
  });

  it("refuses invalid entropy, lifetime, shape, and accessor/proxy input", () => {
    expect(() => createLaunchIdentity({ now: NOW, lifetimeMs: 1 })).toThrow(/identity/u);
    expect(() => createLaunchIdentity({ now: NOW, random: () => Buffer.alloc(1) })).toThrow(/identity/u);
    expect(() => createServerBearerSession({ ...descriptor(), bearerToken: descriptor().startNonce })).toThrow();
    expect(() => parseConnectionDescriptor(new Proxy(descriptor(), {}))).toThrow();
    const accessor = descriptor() as Record<string, unknown>;
    Object.defineProperty(accessor, "host", { get: () => CONTROL_HOST, enumerable: true });
    expect(() => parseConnectionDescriptor(accessor)).toThrow();
  });
});

describe("C3 strict descriptor and lock contracts", () => {
  it("round-trips only exact reviewed fields in canonical form", () => {
    const parsed = parseConnectionDescriptor(descriptor());
    expect(parsed.host).toBe("127.0.0.1");
    expect(Object.keys(parsed)).toEqual([
      "schemaVersion", "serviceVersion", "presentationMode", "host", "port", "processId",
      "startNonce", "bearerToken", "issuedAt", "expiresAt",
    ]);
    expect(serializeConnectionDescriptor(parsed).endsWith("\n")).toBe(true);
    const lock = parseInstanceLock({
      schemaVersion: 1, serviceVersion: parsed.serviceVersion,
      processId: parsed.processId, startNonce: parsed.startNonce, issuedAt: parsed.issuedAt,
    });
    expect(Object.keys(lock)).toEqual(["schemaVersion", "serviceVersion", "processId", "startNonce", "issuedAt"]);
    expect(serializeInstanceLock(lock)).toContain('"schemaVersion":1');
  });

  it("refuses unknown/missing fields, non-loopback hosts, bad ports, and unbounded expiry", () => {
    const value = descriptor();
    expect(() => parseConnectionDescriptor({ ...value, extra: true })).toThrow();
    const { host: _host, ...missing } = value;
    expect(() => parseConnectionDescriptor(missing)).toThrow();
    expect(() => parseConnectionDescriptor({ ...value, host: "0.0.0.0" })).toThrow();
    expect(() => parseConnectionDescriptor({ ...value, presentationMode: "diagnostic" })).toThrow();
    expect(() => parseConnectionDescriptor({ ...value, port: 0 })).toThrow();
    expect(() => parseConnectionDescriptor({ ...value, expiresAt: "2026-08-26T12:00:00.000Z" })).toThrow();
    expect(() => parseInstanceLock({ schemaVersion: 1, serviceVersion: "0.1.0", processId: 1, startNonce: value.startNonce, issuedAt: NOW, age: 1 })).toThrow();
  });

  it("refuses non-enumerable record fields", () => {
    const value = descriptor();
    Object.defineProperty(value, "presentationMode", {
      value: "normal",
      enumerable: false,
      configurable: true,
    });
    expect(() => parseConnectionDescriptor(value)).toThrow();
  });
});
