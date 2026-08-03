import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { invalidConfigurationError } from "./errors.js";
import type { SafetyIdentifierPort, SafetyIdentifierRequest } from "./ports.js";

/**
 * Privacy-preserving `safety_identifier` derivation.
 *
 * The API documents this field as "a stable identifier used to help detect
 * users of your application that may be violating usage policies", with a
 * 64-character maximum, and recommends hashing a username or email "in
 * order to avoid sending us any identifying information".
 *
 * This module therefore never transmits a raw subject: it derives an
 * opaque, bounded, one-way token locally. The value is an abuse-monitoring
 * correlator, NOT an authentication credential, and must never be used as
 * one; nothing here accepts it as proof of identity.
 */

/** The API's documented maximum length for `safety_identifier`. */
export const MAX_SAFETY_IDENTIFIER_LENGTH = 64;

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
// Conservative personal-data shapes that must never be sent verbatim.
const EMAIL_LIKE = /@/;
const WHITESPACE_LIKE = /\s/;

/**
 * Validates an already-derived identifier. Rejects anything unbounded,
 * whitespace-bearing, or email-shaped so a caller cannot accidentally send
 * identifying information through this field.
 */
export function assertSafetyIdentifier(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_SAFETY_IDENTIFIER_LENGTH ||
    EMAIL_LIKE.test(value) ||
    WHITESPACE_LIKE.test(value) ||
    !SAFE_IDENTIFIER_PATTERN.test(value)
  ) {
    throw invalidConfigurationError("unsafe-safety-identifier");
  }
  return value;
}

export interface HashedSafetyIdentifierOptions {
  /**
   * Deployment-scoped salt. A salt makes the derived token unlinkable
   * across deployments and defeats dictionary attacks on small subject
   * spaces. It is not a credential and is never transmitted.
   */
  readonly salt: string;
  /**
   * Returns an opaque, stable subject key for the request, for example an
   * internal account id. Callers must NOT return an email address or
   * username; the value never leaves this process either way, but keeping
   * subjects opaque limits what a salt compromise could reveal.
   */
  readonly subject: (request: SafetyIdentifierRequest) => string;
  /** Derived length in hex characters; defaults to the documented maximum. */
  readonly length?: number;
}

/**
 * Derives `safety_identifier` as a salted HMAC-SHA-256 of the subject.
 * The result is stable for a given (salt, subject) pair, opaque, bounded,
 * and non-reversible.
 */
export function createHashedSafetyIdentifierPort(
  options: HashedSafetyIdentifierOptions,
): SafetyIdentifierPort {
  if (typeof options.salt !== "string" || options.salt.length < 16) {
    throw invalidConfigurationError("safety-identifier-salt-too-short");
  }
  const length = options.length ?? MAX_SAFETY_IDENTIFIER_LENGTH;
  if (!Number.isSafeInteger(length) || length < 16 || length > MAX_SAFETY_IDENTIFIER_LENGTH) {
    throw invalidConfigurationError("safety-identifier-length-out-of-range");
  }
  const salt = options.salt;
  return Object.freeze({
    identify(request: SafetyIdentifierRequest): string {
      const subject = options.subject(request);
      if (typeof subject !== "string" || subject.length === 0 || subject.length > 512) {
        throw invalidConfigurationError("safety-identifier-subject-invalid");
      }
      const digest = createHmac("sha256", salt)
        .update(request.providerInstanceId)
        .update(" ")
        .update(subject)
        .digest("hex");
      return assertSafetyIdentifier(digest.slice(0, length));
    },
  });
}

/**
 * A fixed, already-opaque identifier, appropriate for a single-tenant
 * deployment where there is exactly one subject.
 */
export function createStaticSafetyIdentifierPort(value: string): SafetyIdentifierPort {
  const validated = assertSafetyIdentifier(value);
  return Object.freeze({ identify: (): string => validated });
}

/**
 * Proves a value could not have been produced by hashing a given raw
 * subject with this deployment's salt, used by the privacy tests to show
 * that no raw identifier is ever transmitted. Comparison is constant-time.
 */
export function safetyIdentifierMatchesSubject(
  identifier: string,
  salt: string,
  providerInstanceId: string,
  subject: string,
): boolean {
  const digest = createHmac("sha256", salt)
    .update(providerInstanceId)
    .update(" ")
    .update(subject)
    .digest("hex")
    .slice(0, identifier.length);
  if (digest.length !== identifier.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(identifier, "utf8"));
}

/**
 * Stable, non-secret fingerprint of a value, used to bind resume tokens to
 * the configuration and policy context that produced them.
 */
export function bindingFingerprint(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update(" ");
  }
  return hash.digest("hex");
}
