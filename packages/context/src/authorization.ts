/**
 * Authorization for context assembly.
 *
 * One decision per candidate, taken **before** the body reaches the plan. A
 * denial produces an omission carrying an identity, a digest, and a reason —
 * never a fragment of what was denied.
 *
 * As in the memory package, this is a narrow injected port rather than a
 * direct dependency on the Stage 6 broker: that broker's request type needs
 * provider and trace metadata this stage has no business knowing, and
 * importing it would pull the provider contracts into a package that must not
 * have them. Deny-by-default is enforced here, not delegated: anything that is
 * not an explicit, well-formed `allowed` refuses.
 */

import { createHash } from "node:crypto";
import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import type { DataClassification } from "@ai-dev-os/domain";
import type { DisclosureScope } from "@ai-dev-os/memory";
import { contextFailure, type ContextFailure } from "./errors.js";
import type { ContextPurpose, ContextSourceKind } from "./model.js";

const { ensureEnum, ensureExactKeys, ensureNullable, ensureRecord, ensureString } = validation;

export interface ContextAuthorizationRequest {
  readonly purpose: ContextPurpose;
  readonly projectId: string;
  readonly workspaceId: string | null;
  readonly sourceKind: ContextSourceKind;
  readonly identity: string;
  readonly classification: DataClassification;
  readonly disclosure: DisclosureScope;
  readonly scopeLabel: string;
}

export const CONTEXT_AUTHORIZATION_OUTCOMES = Object.freeze([
  "allowed",
  "denied",
  "conditional",
] as const);

export type ContextAuthorizationOutcome = (typeof CONTEXT_AUTHORIZATION_OUTCOMES)[number];

export interface ContextAuthorizationDecision {
  readonly outcome: ContextAuthorizationOutcome;
  readonly reasonCode: string;
  readonly decisionFingerprint: string | null;
}

export interface ContextAuthorizer {
  authorize(
    request: ContextAuthorizationRequest,
  ): ContextAuthorizationDecision | Promise<ContextAuthorizationDecision>;
}

export function parseContextAuthorizationDecision(
  value: unknown,
  path = "contextAuthorizationDecision",
): ContextAuthorizationDecision {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["outcome", "reasonCode", "decisionFingerprint"], path);
  return Object.freeze({
    outcome: ensureEnum(record["outcome"], `${path}.outcome`, CONTEXT_AUTHORIZATION_OUTCOMES),
    reasonCode: ensureString(record["reasonCode"], `${path}.reasonCode`, {
      maxLength: 64,
      pattern: /^[A-Z][A-Z0-9_]{0,63}$/,
      patternName: "reason code",
    }),
    decisionFingerprint: ensureNullable(record["decisionFingerprint"], (raw) =>
      ensureString(raw, `${path}.decisionFingerprint`, {
        minLength: 64,
        maxLength: 64,
        pattern: /^[0-9a-f]{64}$/,
        patternName: "decision fingerprint",
      }),
    ),
  });
}

export interface AuthorizationOutcomeSet {
  readonly deniedIdentities: readonly string[];
  /**
   * Combined fingerprint over every decision, in candidate order. It binds the
   * pack to the exact policy answers that produced it.
   */
  readonly decisionFingerprint: string | null;
  readonly failure: ContextFailure | null;
}

/**
 * Authorizes every candidate. An authorizer that throws or answers
 * unintelligibly aborts the whole assembly rather than silently denying one
 * item: a pack built while policy was unavailable would look complete when it
 * is not.
 */
export async function authorizeCandidates(
  authorizer: ContextAuthorizer,
  requests: readonly ContextAuthorizationRequest[],
): Promise<AuthorizationOutcomeSet> {
  const denied: string[] = [];
  const decisions: { readonly identity: string; readonly outcome: string; readonly reasonCode: string }[] = [];
  for (const request of requests) {
    let decision: ContextAuthorizationDecision;
    try {
      decision = parseContextAuthorizationDecision(await authorizer.authorize(request));
    } catch (error) {
      return Object.freeze({
        deniedIdentities: Object.freeze([]),
        decisionFingerprint: null,
        failure: contextFailure(
          "AUTHORIZATION_UNAVAILABLE",
          "The authorizer failed or answered unintelligibly; no pack was assembled.",
          { sourceKind: request.sourceKind, causeName: error instanceof Error ? error.name : typeof error },
        ),
      });
    }
    decisions.push(
      Object.freeze({
        identity: request.identity,
        outcome: decision.outcome,
        reasonCode: decision.reasonCode,
      }),
    );
    if (decision.outcome !== "allowed") {
      denied.push(request.identity);
    }
  }
  // Sorted by identity before hashing: the fingerprint must describe *which*
  // decisions were taken, not the order the collector happened to offer
  // candidates in. Hashing arrival order would make the whole pack fingerprint
  // depend on source iteration order.
  const orderedDecisions = [...decisions].sort((a, b) =>
    a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0,
  );
  return Object.freeze({
    deniedIdentities: Object.freeze([...denied].sort()),
    decisionFingerprint:
      orderedDecisions.length === 0
        ? null
        : createHash("sha256")
            .update(toCanonicalJson(orderedDecisions, "contextDecisions"), "utf8")
            .digest("hex"),
    failure: null,
  });
}

/** The safe default. */
export const denyAllContextAuthorizer: ContextAuthorizer = Object.freeze({
  authorize: (): ContextAuthorizationDecision =>
    Object.freeze({ outcome: "denied" as const, reasonCode: "DEFAULT_DENY", decisionFingerprint: null }),
});

/**
 * Allows candidates for one project whose classification is at or below a
 * ceiling, optionally excluding named identities. For tests and for callers
 * with a single project; real deployments wire the Stage 6 broker.
 */
export function createProjectContextAuthorizer(options: {
  readonly projectId: string;
  readonly deniedIdentities?: readonly string[];
  readonly deniedSourceKinds?: readonly ContextSourceKind[];
}): ContextAuthorizer {
  const denied = new Set(options.deniedIdentities ?? []);
  const deniedKinds = new Set(options.deniedSourceKinds ?? []);
  return Object.freeze({
    authorize: (request: ContextAuthorizationRequest): ContextAuthorizationDecision => {
      const allowed =
        request.projectId === options.projectId &&
        !denied.has(request.identity) &&
        !deniedKinds.has(request.sourceKind);
      return Object.freeze({
        outcome: allowed ? ("allowed" as const) : ("denied" as const),
        reasonCode: allowed ? "PROJECT_MATCH" : "NOT_AUTHORIZED",
        decisionFingerprint: createHash("sha256")
          .update(
            toCanonicalJson({ projectId: request.projectId, identity: request.identity }),
            "utf8",
          )
          .digest("hex"),
      });
    },
  });
}
