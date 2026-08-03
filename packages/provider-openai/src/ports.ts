import type { ArtifactId, DataClassification } from "@ai-dev-os/domain";
import type { AbortSignalLike, DisclosureContext, ExecutionTraceMetadata } from "@ai-dev-os/providers";

/**
 * Every external effect this adapter can perform is expressed as an
 * injected port. The package itself performs no ambient I/O, reads no
 * environment variables, opens no files, and never logs.
 */

// ---------------------------------------------------------------------------
// Disclosure authorization (Stage 6 policy composition)
// ---------------------------------------------------------------------------

/** What the adapter is about to disclose, and to whom. */
export interface DisclosureAuthorizationRequest {
  readonly providerInstanceId: string;
  readonly operationId: string;
  readonly modelId: string;
  readonly disclosure: DisclosureContext;
  readonly trace: ExecutionTraceMetadata;
  /** True when the request will ask for server-side persistence (`store`). */
  readonly requestsPersistence: boolean;
  /**
   * True when the request uses background mode, which places content in
   * temporary server-side storage even when `store` is false.
   */
  readonly requestsBackground: boolean;
  /** True when the request carries artifact-derived (image) content. */
  readonly requestsArtifactDisclosure: boolean;
}

export interface DisclosureAuthorization {
  readonly allowed: boolean;
  /** Stable machine reason code when denied; never free-form text. */
  readonly denialCode: string | null;
  /** True when the decision authorizes durable server-side persistence. */
  readonly persistenceAllowed: boolean;
  /**
   * True when the decision authorizes the temporary server-side state that
   * background mode requires. Distinct from `persistenceAllowed`.
   */
  readonly temporaryServerStateAllowed: boolean;
  /** Hex fingerprint of the recorded decision; bound into resume tokens. */
  readonly decisionFingerprint: string | null;
}

export interface DisclosurePort {
  authorize(request: DisclosureAuthorizationRequest): Promise<DisclosureAuthorization>;
}

// ---------------------------------------------------------------------------
// Credentials (Stage 6 policy-aware SecretRef flow)
// ---------------------------------------------------------------------------

export interface CredentialRequest {
  readonly providerInstanceId: string;
  readonly operationId: string;
  readonly classification: DataClassification;
  readonly trace: ExecutionTraceMetadata;
  readonly deadline: string | null;
  readonly disclosureDecisionFingerprint: string | null;
  readonly signal?: AbortSignalLike;
}

/**
 * Resolves the API key for the duration of one callback and no longer.
 *
 * Implementations MUST evaluate policy before touching a secret backend, so
 * a denial provably performs no broker resolve. The adapter calls this
 * immediately before issuing a request and never retains the material.
 */
export interface CredentialPort {
  withApiKey<T>(
    request: CredentialRequest,
    use: (apiKey: string) => Promise<T>,
  ): Promise<T>;
}

// ---------------------------------------------------------------------------
// Artifact resolution
// ---------------------------------------------------------------------------

export interface ResolvedArtifactBytes {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/**
 * Reads artifact bytes for content parts the caller explicitly authorized.
 * The adapter never inlines an artifact that a resolver did not return, and
 * never reads the filesystem itself.
 */
export interface ArtifactResolverPort {
  resolve(input: {
    readonly artifactId: ArtifactId;
    readonly mediaType: string;
    readonly classification: DataClassification;
    readonly trace: ExecutionTraceMetadata;
    readonly maxBytes: number;
  }): Promise<ResolvedArtifactBytes>;
}

// ---------------------------------------------------------------------------
// Safety identifiers
// ---------------------------------------------------------------------------

export interface SafetyIdentifierRequest {
  readonly providerInstanceId: string;
  readonly trace: ExecutionTraceMetadata;
  readonly classification: DataClassification;
}

/**
 * Produces the value sent as `safety_identifier`.
 *
 * The API documents this as "a stable identifier used to help detect users
 * of your application that may be violating usage policies" and recommends
 * hashing a username or email rather than sending identifying information.
 * Implementations MUST therefore be privacy-preserving: derive a bounded,
 * opaque, non-reversible token. It is not an authentication credential and
 * must never be reused as one.
 */
export interface SafetyIdentifierPort {
  identify(request: SafetyIdentifierRequest): string;
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Deterministic id source for operation ids and tool-call ids. */
export type IdSource = (kind: "operation" | "tool-call") => string;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Structural view of the fetch function; the real global satisfies it. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
