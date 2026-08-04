import { createHash } from "node:crypto";
import {
  DATA_CLASSIFICATIONS,
  toCanonicalJson,
  validation,
  type DataClassification,
  type RedactionKind,
  type TaskRisk
} from "@ai-dev-os/domain";
import {
  POLICY_CAPABILITIES,
  parsePolicyRequest,
  type PolicyAction,
  type PolicyBroker,
  type PolicyCapability,
  type PolicyDecision,
  type PolicyRequest
} from "@ai-dev-os/policy";
import {
  parseDisclosureContext,
  type DisclosureContext,
  type ExecutionTraceMetadata
} from "@ai-dev-os/providers";
import {
  PROMPT_COMPILER_SCHEMA_VERSION,
  contextEvidenceFingerprint,
  effectivePromptClassification,
  effectivePromptRisk,
  promptCompilationRequestFingerprint,
  type PromptCompilationRequest,
  type PromptPolicyInput,
  type PromptTargetSnapshot
} from "./model.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureString,
  ensureTimestamp,
  fail
} = validation;

export const PROMPT_AUTHORIZATION_SCHEMA_VERSION = 1 as const;
export const PROMPT_AUTHORIZATION_OUTCOMES = Object.freeze([
  "allowed",
  "denied",
  "conditional",
  "unavailable"
] as const);
export type PromptAuthorizationOutcome = (typeof PROMPT_AUTHORIZATION_OUTCOMES)[number];

const POLICY_ACTION_ORDER = Object.freeze([
  "provider-disclosure",
  "model-eligibility"
] as const satisfies readonly PolicyAction[]);
const HEX_64 = /^[0-9a-f]{64}$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function hash(value: unknown, label: string): string {
  return createHash("sha256").update(toCanonicalJson(value, label), "utf8").digest("hex");
}

function hex64(value: unknown, path: string): string {
  return ensureString(value, path, {
    minLength: 64,
    maxLength: 64,
    pattern: HEX_64,
    patternName: "sha-256 digest"
  });
}

export interface PromptAuthorizationRequest {
  readonly schemaVersion: typeof PROMPT_AUTHORIZATION_SCHEMA_VERSION;
  readonly compilationRequestId: string;
  readonly compilationRequestFingerprint: string;
  readonly contextPackFingerprint: string;
  readonly contextRequestFingerprint: string;
  readonly contextEvidenceFingerprint: string;
  readonly contextItemCount: number;
  readonly subjectDigest: string;
  readonly classification: DataClassification;
  readonly risk: TaskRisk;
  readonly target: PromptTargetSnapshot;
  readonly policy: PromptPolicyInput;
  readonly trace: ExecutionTraceMetadata;
  readonly authorizationAt: string;
}

export function createPromptAuthorizationRequest(
  request: PromptCompilationRequest
): PromptAuthorizationRequest {
  return Object.freeze({
    schemaVersion: PROMPT_AUTHORIZATION_SCHEMA_VERSION,
    compilationRequestId: request.requestId,
    compilationRequestFingerprint: promptCompilationRequestFingerprint(request),
    contextPackFingerprint: request.context.pack.fingerprint,
    contextRequestFingerprint: request.context.pack.requestFingerprint,
    contextEvidenceFingerprint: contextEvidenceFingerprint(request.context.pack),
    contextItemCount: request.context.pack.items.length,
    subjectDigest: request.context.request.subjectDigest,
    classification: effectivePromptClassification(request),
    risk: effectivePromptRisk(request),
    target: request.target,
    policy: request.policy,
    trace: request.trace,
    authorizationAt: request.authorizationAt
  });
}

export function promptAuthorizationRequestFingerprint(
  request: PromptAuthorizationRequest
): string {
  return hash(request, "promptAuthorizationRequest");
}

export interface PromptPolicyBinding {
  readonly action: (typeof POLICY_ACTION_ORDER)[number];
  readonly policyVersion: string;
  readonly decisionFingerprint: string;
}

export interface PromptEffectiveRestrictions {
  readonly requiredLocality: "local-only" | "any";
  readonly loggingAllowed: boolean;
  readonly retentionAllowed: boolean;
  readonly capabilityConstraints: readonly PolicyCapability[];
}

export interface PromptAuthorizationDecision {
  readonly schemaVersion: typeof PROMPT_AUTHORIZATION_SCHEMA_VERSION;
  readonly outcome: PromptAuthorizationOutcome;
  readonly code: string;
  readonly requestFingerprint: string;
  readonly contextPackFingerprint: string;
  readonly contextEvidenceFingerprint: string;
  readonly targetFingerprint: string;
  readonly subjectDigest: string;
  readonly traceId: string;
  readonly classification: DataClassification;
  readonly evaluatedAt: string;
  readonly expiresAt: string;
  readonly policyBindings: readonly PromptPolicyBinding[];
  readonly restrictions: PromptEffectiveRestrictions | null;
  readonly transformationsApplied: readonly RedactionKind[];
  readonly disclosure: DisclosureContext | null;
  readonly fingerprint: string;
}

export interface PromptAuthorizer {
  authorize(
    request: PromptAuthorizationRequest
  ): PromptAuthorizationDecision | Promise<PromptAuthorizationDecision>;
}

function parsePolicyBinding(value: unknown, path: string): PromptPolicyBinding {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["action", "policyVersion", "decisionFingerprint"], path);
  return Object.freeze({
    action: ensureEnum(record["action"], `${path}.action`, POLICY_ACTION_ORDER),
    policyVersion: ensureString(record["policyVersion"], `${path}.policyVersion`, {
      maxLength: 64,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/,
      patternName: "policy version"
    }),
    decisionFingerprint: hex64(record["decisionFingerprint"], `${path}.decisionFingerprint`)
  });
}

function parseRestrictions(value: unknown, path: string): PromptEffectiveRestrictions {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["requiredLocality", "loggingAllowed", "retentionAllowed", "capabilityConstraints"],
    path
  );
  const rawConstraints = ensureArray(
    record["capabilityConstraints"],
    `${path}.capabilityConstraints`,
    POLICY_CAPABILITIES.length
  );
  const selected = new Set<PolicyCapability>();
  rawConstraints.forEach((item, index) =>
    selected.add(ensureEnum(item, `${path}.capabilityConstraints[${index}]`, POLICY_CAPABILITIES))
  );
  return Object.freeze({
    requiredLocality: ensureEnum(
      record["requiredLocality"],
      `${path}.requiredLocality`,
      ["local-only", "any"] as const
    ),
    loggingAllowed: ensureBoolean(record["loggingAllowed"], `${path}.loggingAllowed`),
    retentionAllowed: ensureBoolean(record["retentionAllowed"], `${path}.retentionAllowed`),
    capabilityConstraints: Object.freeze(POLICY_CAPABILITIES.filter((item) => selected.has(item)))
  });
}

function authorizationFingerprintInput(
  decision: Omit<PromptAuthorizationDecision, "fingerprint">
): Omit<PromptAuthorizationDecision, "fingerprint"> {
  return decision;
}

export function promptAuthorizationFingerprint(
  decision: Omit<PromptAuthorizationDecision, "fingerprint">
): string {
  return hash(authorizationFingerprintInput(decision), "promptAuthorization");
}

export function sealPromptAuthorization(
  decision: Omit<PromptAuthorizationDecision, "fingerprint">
): PromptAuthorizationDecision {
  return parsePromptAuthorizationDecision({
    ...decision,
    fingerprint: promptAuthorizationFingerprint(decision)
  });
}

export function parsePromptAuthorizationDecision(
  value: unknown,
  path = "promptAuthorization"
): PromptAuthorizationDecision {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "outcome",
      "code",
      "requestFingerprint",
      "contextPackFingerprint",
      "contextEvidenceFingerprint",
      "targetFingerprint",
      "subjectDigest",
      "traceId",
      "classification",
      "evaluatedAt",
      "expiresAt",
      "policyBindings",
      "restrictions",
      "transformationsApplied",
      "disclosure",
      "fingerprint"
    ],
    path
  );
  const outcome = ensureEnum(record["outcome"], `${path}.outcome`, PROMPT_AUTHORIZATION_OUTCOMES);
  const evaluatedAt = ensureTimestamp(record["evaluatedAt"], `${path}.evaluatedAt`);
  const expiresAt = ensureTimestamp(record["expiresAt"], `${path}.expiresAt`);
  if (expiresAt <= evaluatedAt) {
    fail(`${path}.expiresAt`, "bad_expiration", "must be after evaluatedAt.");
  }
  const policyBindings = ensureArray(record["policyBindings"], `${path}.policyBindings`, 2).map(
    (binding, index) => parsePolicyBinding(binding, `${path}.policyBindings[${index}]`)
  );
  for (let index = 0; index < policyBindings.length; index += 1) {
    if (policyBindings[index]?.action !== POLICY_ACTION_ORDER[index]) {
      fail(`${path}.policyBindings`, "non_canonical_order", "must use the fixed policy action order.");
    }
  }
  const transformations = ensureArray(
    record["transformationsApplied"],
    `${path}.transformationsApplied`,
    3
  ).map((item, index) =>
    ensureEnum(
      item,
      `${path}.transformationsApplied[${index}]`,
      ["personal-data", "proprietary-identifiers", "secrets"] as const
    )
  );
  if (new Set(transformations).size !== transformations.length) {
    fail(`${path}.transformationsApplied`, "duplicate_transformation", "cannot contain duplicates.");
  }
  const unsealed = Object.freeze({
    schemaVersion: PROMPT_AUTHORIZATION_SCHEMA_VERSION,
    outcome,
    code: ensureString(record["code"], `${path}.code`, {
      maxLength: 64,
      pattern: CODE_PATTERN,
      patternName: "authorization outcome code"
    }),
    requestFingerprint: hex64(record["requestFingerprint"], `${path}.requestFingerprint`),
    contextPackFingerprint: hex64(
      record["contextPackFingerprint"],
      `${path}.contextPackFingerprint`
    ),
    contextEvidenceFingerprint: hex64(
      record["contextEvidenceFingerprint"],
      `${path}.contextEvidenceFingerprint`
    ),
    targetFingerprint: hex64(record["targetFingerprint"], `${path}.targetFingerprint`),
    subjectDigest: hex64(record["subjectDigest"], `${path}.subjectDigest`),
    traceId: ensureString(record["traceId"], `${path}.traceId`, {
      maxLength: 128,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
      patternName: "trace identifier"
    }),
    classification: ensureEnum(
      record["classification"],
      `${path}.classification`,
      DATA_CLASSIFICATIONS
    ),
    evaluatedAt,
    expiresAt,
    policyBindings: Object.freeze(policyBindings),
    restrictions: ensureNullable(record["restrictions"], (raw) =>
      parseRestrictions(raw, `${path}.restrictions`)
    ),
    transformationsApplied: Object.freeze(transformations),
    disclosure: ensureNullable(record["disclosure"], (raw) =>
      parseDisclosureContext(raw, `${path}.disclosure`)
    )
  });
  if (outcome === "allowed") {
    const restrictions = unsealed.restrictions;
    const disclosure = unsealed.disclosure;
    if (unsealed.policyBindings.length !== 2 || restrictions === null || disclosure === null) {
      fail(path, "incomplete_allow", "an allowed decision requires both policy bindings and effective restrictions.");
    }
    const allowedRestrictions = restrictions as PromptEffectiveRestrictions;
    const allowedDisclosure = disclosure as DisclosureContext;
    if (
      allowedDisclosure.classification !== unsealed.classification ||
      allowedDisclosure.requiredLocality !== allowedRestrictions.requiredLocality ||
      allowedDisclosure.loggingAllowed !== allowedRestrictions.loggingAllowed ||
      allowedDisclosure.retentionAllowed !== allowedRestrictions.retentionAllowed
    ) {
      fail(`${path}.disclosure`, "restriction_mismatch", "must equal the effective restrictions.");
    }
  }
  const fingerprint = hex64(record["fingerprint"], `${path}.fingerprint`);
  if (fingerprint !== promptAuthorizationFingerprint(unsealed)) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match the authorization contents.");
  }
  return Object.freeze({ ...unsealed, fingerprint });
}

function policyRequest(
  request: PromptAuthorizationRequest,
  action: (typeof POLICY_ACTION_ORDER)[number]
): PolicyRequest {
  return parsePolicyRequest({
    schemaVersion: 1,
    action,
    classification: request.classification,
    handlingPolicy: request.policy.handlingPolicy,
    risk: request.risk,
    locality: request.target.provider.locality,
    provider: request.target.provider,
    model: request.target.model,
    scope: request.policy.scope,
    subjectDigest: request.subjectDigest,
    requestedCapabilities: ["structured-output"],
    transformationsApplied: request.policy.transformationsApplied,
    approvalEvidence: request.policy.approvalEvidence,
    retentionDays: request.policy.retentionDays,
    trace: request.trace,
    requesterKind: "system"
  });
}

function decisionIsBound(
  decision: PolicyDecision,
  action: (typeof POLICY_ACTION_ORDER)[number],
  request: PromptAuthorizationRequest
): boolean {
  return (
    decision.audit.action === action &&
    decision.audit.classification === request.classification &&
    decision.audit.traceId === request.trace.traceId &&
    decision.audit.outcome === decision.outcome &&
    decision.audit.code === decision.code &&
    HEX_64.test(decision.fingerprint) &&
    (decision.outcome !== "allowed" ||
      (decision.requiredTransformations.length === 0 && decision.requiredApprovals.length === 0))
  );
}

function intersectRestrictions(decisions: readonly PolicyDecision[]): PromptEffectiveRestrictions {
  const constrained = new Set<PolicyCapability>();
  for (const decision of decisions) {
    for (const capability of decision.capabilityConstraints) constrained.add(capability);
  }
  return Object.freeze({
    requiredLocality: decisions.some((decision) => decision.requiredLocality === "local")
      ? "local-only"
      : "any",
    loggingAllowed: decisions.every(
      (decision) =>
        decision.loggingRestrictions.inputAllowed && decision.loggingRestrictions.outputAllowed
    ),
    retentionAllowed: decisions.every((decision) => decision.retentionRestrictions.allowed),
    capabilityConstraints: Object.freeze(
      POLICY_CAPABILITIES.filter((capability) => constrained.has(capability))
    )
  });
}

function policyBindingFingerprint(bindings: readonly PromptPolicyBinding[]): string {
  return hash(bindings, "promptPolicyBindings");
}

function outcomeOf(decisions: readonly PolicyDecision[]): PromptAuthorizationOutcome {
  if (decisions.some((decision) => decision.outcome === "denied")) return "denied";
  if (decisions.some((decision) => decision.outcome === "conditional")) return "conditional";
  return "allowed";
}

function failedAuthorization(
  request: PromptAuthorizationRequest,
  outcome: Exclude<PromptAuthorizationOutcome, "allowed">,
  code: string,
  evaluatedAt: string,
  expiresAt: string,
  bindings: readonly PromptPolicyBinding[] = []
): PromptAuthorizationDecision {
  return sealPromptAuthorization({
    schemaVersion: PROMPT_AUTHORIZATION_SCHEMA_VERSION,
    outcome,
    code,
    requestFingerprint: promptAuthorizationRequestFingerprint(request),
    contextPackFingerprint: request.contextPackFingerprint,
    contextEvidenceFingerprint: request.contextEvidenceFingerprint,
    targetFingerprint: request.target.fingerprint,
    subjectDigest: request.subjectDigest,
    traceId: request.trace.traceId,
    classification: request.classification,
    evaluatedAt,
    expiresAt,
    policyBindings: bindings,
    restrictions: null,
    transformationsApplied: request.policy.transformationsApplied,
    disclosure: null
  });
}

export function createPolicyAwarePromptAuthorizer(options: {
  readonly broker: PolicyBroker;
  readonly authorizationTtlMs?: number;
}): PromptAuthorizer {
  const authorizationTtlMs = options.authorizationTtlMs ?? 300_000;
  if (!Number.isSafeInteger(authorizationTtlMs) || authorizationTtlMs < 1 || authorizationTtlMs > 86_400_000) {
    fail("authorizationTtlMs", "bad_integer", "must be a safe integer between 1 and 86400000.");
  }
  return Object.freeze({
    authorize(request: PromptAuthorizationRequest): PromptAuthorizationDecision {
      try {
        const decisions = POLICY_ACTION_ORDER.map((action) =>
          options.broker.evaluate(policyRequest(request, action))
        );
        const evaluatedAt = decisions[0]?.audit.evaluatedAt;
        if (
          evaluatedAt === undefined ||
          !decisions.every(
            (decision, index) =>
              decision.audit.evaluatedAt === evaluatedAt &&
              decisionIsBound(decision, POLICY_ACTION_ORDER[index]!, request)
          )
        ) {
          return failedAuthorization(
            request,
            "unavailable",
            "POLICY_BINDING_INVALID",
            request.authorizationAt,
            new Date(new Date(request.authorizationAt).valueOf() + authorizationTtlMs).toISOString()
          );
        }
        const bindings = Object.freeze(
          decisions.map((decision, index) =>
            Object.freeze({
              action: POLICY_ACTION_ORDER[index]!,
              policyVersion: decision.policyVersion,
              decisionFingerprint: decision.fingerprint
            })
          )
        );
        const expiresAt = new Date(
          new Date(evaluatedAt).valueOf() + authorizationTtlMs
        ).toISOString();
        const outcome = outcomeOf(decisions);
        if (outcome !== "allowed") {
          return failedAuthorization(
            request,
            outcome,
            outcome === "denied" ? "POLICY_DENIED" : "POLICY_CONDITIONAL",
            evaluatedAt,
            expiresAt,
            bindings
          );
        }
        const restrictions = intersectRestrictions(decisions);
        const disclosure = parseDisclosureContext({
          classification: request.classification,
          requiredLocality: restrictions.requiredLocality,
          redactionApplied: request.policy.transformationsApplied.length > 0,
          decisionRef: policyBindingFingerprint(bindings),
          retentionAllowed: restrictions.retentionAllowed,
          loggingAllowed: restrictions.loggingAllowed
        });
        return sealPromptAuthorization({
          schemaVersion: PROMPT_AUTHORIZATION_SCHEMA_VERSION,
          outcome: "allowed",
          code: "POLICY_ALLOWED",
          requestFingerprint: promptAuthorizationRequestFingerprint(request),
          contextPackFingerprint: request.contextPackFingerprint,
          contextEvidenceFingerprint: request.contextEvidenceFingerprint,
          targetFingerprint: request.target.fingerprint,
          subjectDigest: request.subjectDigest,
          traceId: request.trace.traceId,
          classification: request.classification,
          evaluatedAt,
          expiresAt,
          policyBindings: bindings,
          restrictions,
          transformationsApplied: request.policy.transformationsApplied,
          disclosure
        });
      } catch {
        return failedAuthorization(
          request,
          "unavailable",
          "POLICY_UNAVAILABLE",
          request.authorizationAt,
          new Date(new Date(request.authorizationAt).valueOf() + authorizationTtlMs).toISOString()
        );
      }
    }
  });
}

export const denyAllPromptAuthorizer: PromptAuthorizer = Object.freeze({
  authorize(request: PromptAuthorizationRequest): PromptAuthorizationDecision {
    return failedAuthorization(
      request,
      "denied",
      "DEFAULT_DENY",
      request.authorizationAt,
      new Date(new Date(request.authorizationAt).valueOf() + 1).toISOString()
    );
  }
});

export function authorizationMatchesRequest(
  authorization: PromptAuthorizationDecision,
  request: PromptAuthorizationRequest
): boolean {
  return (
    authorization.requestFingerprint === promptAuthorizationRequestFingerprint(request) &&
    authorization.contextPackFingerprint === request.contextPackFingerprint &&
    authorization.contextEvidenceFingerprint === request.contextEvidenceFingerprint &&
    authorization.targetFingerprint === request.target.fingerprint &&
    authorization.subjectDigest === request.subjectDigest &&
    authorization.traceId === request.trace.traceId &&
    authorization.classification === request.classification &&
    toCanonicalJson(authorization.transformationsApplied) ===
      toCanonicalJson(request.policy.transformationsApplied)
  );
}

export function authorizationIsFresh(
  authorization: PromptAuthorizationDecision,
  authorizationAt: string,
  maxAgeMs: number
): boolean {
  const evaluated = new Date(authorization.evaluatedAt).valueOf();
  const requiredAt = new Date(authorizationAt).valueOf();
  const expires = new Date(authorization.expiresAt).valueOf();
  return requiredAt >= evaluated && requiredAt < expires && requiredAt - evaluated <= maxAgeMs;
}
