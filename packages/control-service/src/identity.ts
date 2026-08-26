import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { exactString, exactTimestamp, readExactRecord } from "./structural.js";
import { controlFail } from "./errors.js";

export const CONTROL_DESCRIPTOR_SCHEMA_VERSION = 1 as const;
export const CONTROL_SERVICE_VERSION = "0.1.0" as const;
export const CONTROL_HOST = "127.0.0.1" as const;
export const START_NONCE_PATTERN = /^[a-f0-9]{32}$/u;
export const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const MAX_SESSION_LIFETIME_MS = 60 * 60 * 1_000;

export interface LaunchIdentity {
  readonly startNonce: string;
  readonly bearerToken: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export type RandomBytesPort = (size: number) => Uint8Array;

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function createLaunchIdentity(options: Readonly<{
  now: string;
  lifetimeMs?: number;
  random?: RandomBytesPort;
}>): LaunchIdentity {
  const issuedAt = exactTimestamp(options.now);
  const lifetimeMs = options.lifetimeMs ?? 15 * 60 * 1_000;
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1_000 || lifetimeMs > MAX_SESSION_LIFETIME_MS) {
    controlFail("INVALID_IDENTITY");
  }
  const source = options.random ?? randomBytes;
  const nonceBytes = source(16);
  const tokenBytes = source(32);
  if (nonceBytes.byteLength !== 16 || tokenBytes.byteLength !== 32 || nonceBytes === tokenBytes) {
    controlFail("INVALID_IDENTITY");
  }
  const startNonce = Buffer.from(nonceBytes).toString("hex");
  const bearerToken = base64Url(tokenBytes);
  if (!START_NONCE_PATTERN.test(startNonce) || !BEARER_TOKEN_PATTERN.test(bearerToken)) {
    controlFail("INVALID_IDENTITY");
  }
  return Object.freeze({
    startNonce,
    bearerToken,
    issuedAt,
    expiresAt: new Date(new Date(issuedAt).valueOf() + lifetimeMs).toISOString(),
  });
}

export const SESSION_STATES = Object.freeze(["active", "expired", "refused"] as const);
export type SessionState = (typeof SESSION_STATES)[number];

export interface ServerBearerSession {
  readonly serviceVersion: string;
  readonly startNonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  authenticate(candidate: unknown, now: string): SessionState;
  stateAt(now: string): "active" | "expired";
}

function parseSessionInput(value: unknown): Readonly<{
  serviceVersion: string;
  startNonce: string;
  bearerToken: string;
  issuedAt: string;
  expiresAt: string;
}> {
  const record = readExactRecord(value, ["serviceVersion", "startNonce", "bearerToken", "issuedAt", "expiresAt"]);
  const serviceVersion = exactString(record["serviceVersion"], /^\d+\.\d+\.\d+$/u, 32);
  const startNonce = exactString(record["startNonce"], START_NONCE_PATTERN, 32);
  const bearerToken = exactString(record["bearerToken"], BEARER_TOKEN_PATTERN, 43);
  const issuedAt = exactTimestamp(record["issuedAt"]);
  const expiresAt = exactTimestamp(record["expiresAt"]);
  const issued = new Date(issuedAt).valueOf();
  const expires = new Date(expiresAt).valueOf();
  if (expires <= issued || expires - issued > MAX_SESSION_LIFETIME_MS) controlFail("INVALID_IDENTITY");
  return Object.freeze({ serviceVersion, startNonce, bearerToken, issuedAt, expiresAt });
}

function digestBackedSession(
  binding: Readonly<{
    serviceVersion: string;
    startNonce: string;
    issuedAt: string;
    expiresAt: string;
  }>,
  digest: Buffer,
): ServerBearerSession {
  // This closure is deliberately constructed in a scope that has never
  // received the plaintext bearer. Its only authentication material is the
  // fixed-size digest passed by createServerBearerSession.
  const serviceVersion = binding.serviceVersion;
  const startNonce = binding.startNonce;
  const issuedAt = binding.issuedAt;
  const expiresAt = binding.expiresAt;
  const expiresAtMs = new Date(expiresAt).valueOf();
  const invalidDigest = Buffer.alloc(digest.byteLength);
  return Object.freeze({
    serviceVersion,
    startNonce,
    issuedAt,
    expiresAt,
    stateAt(now: string) {
      const checked = exactTimestamp(now);
      return new Date(checked).valueOf() >= expiresAtMs ? "expired" : "active";
    },
    authenticate(candidate: unknown, now: string) {
      if (this.stateAt(now) === "expired") return "expired";
      const shaped = typeof candidate === "string" && candidate.length === 43 && BEARER_TOKEN_PATTERN.test(candidate);
      const candidateDigest = shaped
        ? createHash("sha256").update(candidate, "utf8").digest()
        : invalidDigest;
      return timingSafeEqual(digest, candidateDigest) && shaped ? "active" : "refused";
    },
  });
}

export function createServerBearerSession(value: unknown): ServerBearerSession {
  const parsed = parseSessionInput(value);
  const digest = createHash("sha256").update(parsed.bearerToken, "utf8").digest();
  return digestBackedSession(Object.freeze({
    serviceVersion: parsed.serviceVersion,
    startNonce: parsed.startNonce,
    issuedAt: parsed.issuedAt,
    expiresAt: parsed.expiresAt,
  }), digest);
}
