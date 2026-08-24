import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_ENDPOINT,
} from "@ai-dev-os/provider-anthropic";
import {
  ANTHROPIC_LIVE_CANARY_MAX_TOKENS,
  ANTHROPIC_LIVE_CANARY_MODEL,
  ANTHROPIC_LIVE_CANARY_REQUEST_SHA256,
  ANTHROPIC_LIVE_CANARY_TIMEOUT_MS,
  AnthropicLiveCanaryError,
  createProductionDisabledAnthropicValidation,
  type AnthropicLiveCanaryDiagnosticCategory,
  type AnthropicLiveCanaryPreflightRequest,
  type AnthropicLiveCanaryResult,
} from "@ai-dev-os/provider-anthropic/validation";
import {
  secretRefFingerprint,
  type SecretAccessContext,
  type SecretAuditRecord,
  type SecretBroker,
  type SecretMaterial,
  type SecretRef,
} from "@ai-dev-os/secrets";
import { appVaultReferenceForSlot } from "@ai-dev-os/secrets-app-vault";
import {
  AnthropicValidationAuthorizationError,
  ANTHROPIC_VALIDATION_OPERATION_VERSION,
  ANTHROPIC_VALIDATION_RETENTION_MODE,
  serializeAnthropicValidationAuthorizationPacket,
  type AnthropicValidationAuthorizationGate,
  type AnthropicValidationAuthorizationPacket,
  type ConsumedAnthropicValidationAuthorization,
} from "./anthropic-validation-authorization.js";
import {
  ANTHROPIC_SUCCESS_RECEIPT_DIGEST_CONVENTION,
  ANTHROPIC_SUCCESS_RECEIPT_VERSION,
  type AnthropicValidationSuccessReceipt,
} from "./anthropic-validation-receipt.js";
import type { AnthropicValidationSuccessReceiptStore } from "./anthropic-validation-receipt-store.js";
import { CredentialHostError } from "./host-error.js";
import {
  validationResultCode,
  type CredentialValidationInput,
  type CredentialValidationPort,
  type CredentialValidationResult,
} from "./validation.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const EXPECTED_REFERENCE = appVaultReferenceForSlot("anthropic");
const EXPECTED_REFERENCE_FINGERPRINT = secretRefFingerprint(EXPECTED_REFERENCE);

const AMBIGUOUS: CredentialValidationResult = Object.freeze({
  outcome: "ambiguous",
  resultCode: "RESULT_AMBIGUOUS",
});

const EVIDENCE_INCOMPLETE: CredentialValidationResult = Object.freeze({
  outcome: "evidence-incomplete",
  resultCode: "EVIDENCE_RECEIPT_UNAVAILABLE",
});

const PENDING_SUCCESS_RECEIPT =
  "ai-dev-os.stage-18e-i.anthropic-success-receipt-pending.v1" as const;

interface PendingAnthropicValidationSuccessReceipt {
  readonly kind: typeof PENDING_SUCCESS_RECEIPT;
  readonly receipt: AnthropicValidationSuccessReceipt;
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  try {
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    ) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const projected: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) return null;
      projected[key] = descriptor.value;
    }
    return projected;
  } catch {
    return null;
  }
}

/**
 * The only envelope allowed to promote this exact ANT-02 validation profile.
 * The producer and validator intentionally differ: every field is projected
 * through own data descriptors, and transport kind is independently pinned.
 */
export function exactAnthropicValidationSuccess(
  value: unknown,
  expectedPolicyDecisionFingerprint: string,
): AnthropicLiveCanaryResult | null {
  if (!SHA256.test(expectedPolicyDecisionFingerprint)) return null;
  const result = exactRecord(value, [
    "schemaVersion", "endpoint", "apiVersion", "modelId", "retentionMode",
    "statusCategory", "transportKind", "durationMs", "inputTokens",
    "outputTokens", "modelSubstitutionRejected", "fixedRequestBody",
    "repositorySourcePresent", "credentialRetained", "responseBodyRetained",
    "requestFingerprint", "policyDecisionFingerprint",
  ]);
  if (result === null) return null;
  const durationMs = result["durationMs"];
  const inputTokens = result["inputTokens"];
  const outputTokens = result["outputTokens"];
  if (
    result["schemaVersion"] !== 1 ||
    result["endpoint"] !== ANTHROPIC_MESSAGES_ENDPOINT ||
    result["apiVersion"] !== ANTHROPIC_API_VERSION ||
    result["modelId"] !== ANTHROPIC_LIVE_CANARY_MODEL ||
    result["retentionMode"] !== "standard-30-day" ||
    result["statusCategory"] !== "success" ||
    result["transportKind"] !== "direct-anthropic-https" ||
    !Number.isSafeInteger(durationMs) || (durationMs as number) < 0 ||
    (durationMs as number) >= ANTHROPIC_LIVE_CANARY_TIMEOUT_MS ||
    !Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0 ||
    (inputTokens as number) > 256 ||
    !Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0 ||
    (outputTokens as number) > ANTHROPIC_LIVE_CANARY_MAX_TOKENS ||
    result["modelSubstitutionRejected"] !== true ||
    result["fixedRequestBody"] !== true ||
    result["repositorySourcePresent"] !== false ||
    result["credentialRetained"] !== false ||
    result["responseBodyRetained"] !== false ||
    result["requestFingerprint"] !== ANTHROPIC_LIVE_CANARY_REQUEST_SHA256 ||
    result["policyDecisionFingerprint"] !== expectedPolicyDecisionFingerprint
  ) return null;
  return Object.freeze({
    schemaVersion: 1,
    endpoint: ANTHROPIC_MESSAGES_ENDPOINT,
    apiVersion: ANTHROPIC_API_VERSION,
    modelId: ANTHROPIC_LIVE_CANARY_MODEL,
    retentionMode: "standard-30-day",
    statusCategory: "success",
    transportKind: "direct-anthropic-https",
    durationMs: durationMs as number,
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number,
    modelSubstitutionRejected: true,
    fixedRequestBody: true,
    repositorySourcePresent: false,
    credentialRetained: false,
    responseBodyRetained: false,
    requestFingerprint: ANTHROPIC_LIVE_CANARY_REQUEST_SHA256,
    policyDecisionFingerprint: expectedPolicyDecisionFingerprint,
  });
}

const UNREACHABLE_CATEGORIES = new Set<AnthropicLiveCanaryDiagnosticCategory>([
  "network-transport",
  "local-timeout",
  "rate-limited",
  "provider-internal-error",
  "provider-timeout",
  "provider-overloaded",
]);

export function finiteAnthropicValidationFailure(error: unknown): CredentialValidationResult {
  if (!(error instanceof AnthropicLiveCanaryError)) return AMBIGUOUS;
  const category = error.diagnostics.category;
  if (category === "credential-unauthenticated") {
    return Object.freeze({ outcome: "invalid", resultCode: "AUTHENTICATION_FAILED" });
  }
  if (category === "billing-unavailable" || category === "permission-denied") {
    return Object.freeze({ outcome: "unauthorized", resultCode: "AUTHORIZATION_LIMITED" });
  }
  if (UNREACHABLE_CATEGORIES.has(category)) {
    return Object.freeze({ outcome: "unreachable", resultCode: "PROVIDER_UNREACHABLE" });
  }
  return AMBIGUOUS;
}

function authorizationError(error: AnthropicValidationAuthorizationError): CredentialHostError {
  const code = Object.freeze({
    AUTHORIZATION_UNAVAILABLE: "VALIDATION_AUTHORIZATION_UNAVAILABLE",
    AUTHORIZATION_INVALID: "VALIDATION_AUTHORIZATION_INVALID",
    AUTHORIZATION_EXPIRED: "VALIDATION_AUTHORIZATION_EXPIRED",
    AUTHORIZATION_CONSUMED: "VALIDATION_AUTHORIZATION_CONSUMED",
    AUTHORIZATION_AMBIGUOUS: "VALIDATION_AUTHORIZATION_AMBIGUOUS",
  } as const)[error.code];
  return new CredentialHostError(code);
}

function exactPreflight(
  request: AnthropicLiveCanaryPreflightRequest,
  packet: AnthropicValidationAuthorizationPacket,
  policyDecisionFingerprint: string,
): boolean {
  return request.endpoint === packet.request.endpoint &&
    request.apiVersion === packet.request.apiVersion &&
    request.modelId === packet.request.model &&
    request.retentionMode === "standard-30-day" &&
    request.catalogFingerprint === packet.candidate.manifestAggregate &&
    request.authorizationReference === packet.authorizationReference &&
    request.requestFingerprint === packet.request.requestSha256 &&
    request.signal.aborted === false &&
    SHA256.test(policyDecisionFingerprint);
}

function audit(context: SecretAccessContext, outcome: SecretAuditRecord["outcome"], occurredAt: string): SecretAuditRecord {
  return Object.freeze({
    schemaVersion: 1,
    operation: "availability",
    phase: "outcome",
    outcome,
    occurredAt,
    reference: null,
    operationId: context.operationId,
    providerInstanceId: context.providerInstanceId,
    purpose: context.purpose,
    traceId: context.trace.traceId,
  });
}

function callbackScopedBroker(
  material: SecretMaterial,
  expectedDecisionFingerprint: string,
  expectedAuthorizationReference: string,
  canarySignal: () => AbortSignal | null,
  now: () => Date,
): SecretBroker {
  let supplied = false;
  const accepts = (ref: SecretRef, context: SecretAccessContext): boolean =>
    secretRefFingerprint(ref) === EXPECTED_REFERENCE_FINGERPRINT &&
    context.providerInstanceId === "anthropic-default" &&
    context.purpose === "provider-authentication" &&
    context.accessForm === "text" &&
    context.classification === "public" &&
    context.operationId === "anthropic-live-canary-v1" &&
    Array.isArray(context.approvalEvidenceRefs) &&
    context.approvalEvidenceRefs.length === 1 &&
    context.approvalEvidenceRefs[0] === expectedAuthorizationReference &&
    context.disclosureDecisionFingerprint === expectedDecisionFingerprint &&
    context.signal === canarySignal() &&
    context.locality === "cloud";
  return Object.freeze({
    describeCapabilities: () => Object.freeze({
      resolve: true,
      availability: true,
      replace: false,
      revoke: false,
      versions: false,
      kinds: Object.freeze(["text"] as const),
    }),
    async availability(ref: SecretRef, context: SecretAccessContext) {
      const available = !supplied && canarySignal()?.aborted === false && accepts(ref, context);
      let occurredAt: string;
      try { occurredAt = now().toISOString(); }
      catch { throw new CredentialHostError("REFUSED"); }
      return Object.freeze({
        available,
        reason: available ? "available" as const : "unavailable" as const,
        audit: audit(context, available ? "success" : "failure", occurredAt),
      });
    },
    async withSecret<T>(ref: SecretRef, context: SecretAccessContext, use: (secret: SecretMaterial) => T | Promise<T>): Promise<T> {
      if (supplied || canarySignal()?.aborted !== false || !accepts(ref, context)) {
        throw new CredentialHostError("REFUSED");
      }
      supplied = true;
      return await use(material);
    },
    async replace() { throw new CredentialHostError("REFUSED"); },
    async revoke() { throw new CredentialHostError("REFUSED"); },
    async close() { return undefined; },
  });
}

export function createAnthropicCredentialValidationPort(options: Readonly<{
  gate: AnthropicValidationAuthorizationGate;
  receiptStore: AnthropicValidationSuccessReceiptStore;
  now?: () => Date;
}>): CredentialValidationPort {
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    preciseDispatchObservation: true as const,
    requiresSuccessReceipt: true as const,
    authorization: () => options.gate.authorization(),
    async prepare(input: Readonly<{
      slotId: CredentialValidationInput["slotId"];
      providerInstanceId: string;
      secretRefFingerprint: string;
      signal: AbortSignal;
    }>) {
      if (input.signal.aborted) throw new CredentialHostError("VALIDATION_CANCELLED");
      if (
        input.slotId !== "anthropic" ||
        input.providerInstanceId !== "anthropic-default" ||
        input.secretRefFingerprint !== EXPECTED_REFERENCE_FINGERPRINT
      ) throw new CredentialHostError("VALIDATION_AUTHORIZATION_INVALID");
      try {
        return await options.gate.consume({
          slotId: "anthropic",
          providerInstanceId: "anthropic-default",
          secretRefFingerprint: EXPECTED_REFERENCE_FINGERPRINT,
        });
      } catch (error) {
        if (error instanceof AnthropicValidationAuthorizationError) {
          throw authorizationError(error);
        }
        throw new CredentialHostError("VALIDATION_AUTHORIZATION_AMBIGUOUS");
      }
    },
    async settleAfterSecretRelease(effectResult: unknown): Promise<unknown> {
      const pending = exactRecord(effectResult, ["kind", "receipt"]);
      if (pending?.["kind"] !== PENDING_SUCCESS_RECEIPT) return effectResult;
      try {
        const reference = await options.receiptStore.commit(pending["receipt"]);
        return Object.freeze({
          outcome: "valid" as const,
          resultCode: "VALIDATION_OK" as const,
          successReceiptId: reference.receiptId,
          successReceiptSha256: reference.receiptSha256,
        });
      } catch {
        return EVIDENCE_INCOMPLETE;
      }
    },
    async validate(input: CredentialValidationInput): Promise<unknown> {
      if (input.signal.aborted) throw new CredentialHostError("VALIDATION_CANCELLED");
      if (
        input.slotId !== "anthropic" ||
        !SHA256.test(input.policyDecisionFingerprint ?? "")
      ) throw new CredentialHostError("VALIDATION_AUTHORIZATION_INVALID");
      let packet: AnthropicValidationAuthorizationPacket;
      let consumed: ConsumedAnthropicValidationAuthorization;
      try {
        consumed = input.authorizationAttempt as ConsumedAnthropicValidationAuthorization;
        packet = options.gate.claim(
          consumed,
        );
      } catch (error) {
        if (error instanceof AnthropicValidationAuthorizationError) {
          throw authorizationError(error);
        }
        throw new CredentialHostError("VALIDATION_AUTHORIZATION_AMBIGUOUS");
      }

      const policyDecisionFingerprint = input.policyDecisionFingerprint!;
      if (
        typeof input.operationId !== "string" ||
        typeof input.validationStartedAt !== "string"
      ) throw new CredentialHostError("VALIDATION_AUTHORIZATION_INVALID");
      let boundedCanarySignal: AbortSignal | null = null;
      let dispatchCount = 0;
      const broker = callbackScopedBroker(
        input.secret,
        policyDecisionFingerprint,
        packet.authorizationReference,
        () => boundedCanarySignal,
        now,
      );
      const runner = createProductionDisabledAnthropicValidation({
        instanceId: "anthropic-default",
        apiKeyRef: EXPECTED_REFERENCE,
        retentionMode: "standard-30-day",
        expectedCatalogFingerprint: packet.candidate.manifestAggregate,
        expectedAuthorizationReference: packet.authorizationReference,
        broker,
        preflight: Object.freeze({
          async check(request) {
            const allowed = exactPreflight(request, packet, policyDecisionFingerprint);
            if (allowed) boundedCanarySignal = request.signal;
            return Object.freeze({
              allowed,
              decisionFingerprint: allowed ? policyDecisionFingerprint : null,
              catalogFingerprint: allowed ? packet.candidate.manifestAggregate : null,
              authorizationReference: allowed ? packet.authorizationReference : null,
              retentionMode: "standard-30-day" as const,
            });
          },
        }),
        now,
        observeFailurePhase(phase) {
          if (phase === "possibly-dispatched") {
            dispatchCount += 1;
            input.observeProviderDispatch?.();
          }
        },
      });
      try {
        const result: AnthropicLiveCanaryResult = await runner.runOnce(input.signal);
        const success = exactAnthropicValidationSuccess(result, policyDecisionFingerprint);
        if (success === null) return AMBIGUOUS;
        if (dispatchCount !== 1) return EVIDENCE_INCOMPLETE;
        let completedAt: string;
        try { completedAt = now().toISOString(); }
        catch { return EVIDENCE_INCOMPLETE; }
        const observedPacketSha256 = createHash("sha256")
          .update(serializeAnthropicValidationAuthorizationPacket(packet), "utf8")
          .digest("hex");
        if (
          consumed.packetFingerprint !== observedPacketSha256 ||
          consumed.authorizationReference !== packet.authorizationReference ||
          consumed.candidateManifestAggregate !== packet.candidate.manifestAggregate
        ) return EVIDENCE_INCOMPLETE;
        // This literal is deliberately separate from the receipt validator's
        // exact-key projection. The store independently validates it before IO.
        const receipt: AnthropicValidationSuccessReceipt = Object.freeze({
          schemaVersion: 1,
          receiptVersion: ANTHROPIC_SUCCESS_RECEIPT_VERSION,
          digestConvention: ANTHROPIC_SUCCESS_RECEIPT_DIGEST_CONVENTION,
          operationVersion: ANTHROPIC_VALIDATION_OPERATION_VERSION,
          operationId: input.operationId,
          slotId: "anthropic",
          providerInstanceId: "anthropic-default",
          candidateHead: packet.candidate.head,
          candidateTree: packet.candidate.tree,
          candidateManifestAggregate: packet.candidate.manifestAggregate,
          authorizationPacketSha256: observedPacketSha256,
          authorizationReference: packet.authorizationReference,
          markerNamespaceSha256: createHash("sha256").update(packet.markerNamespace, "utf8").digest("hex"),
          authorizationRetentionMode: ANTHROPIC_VALIDATION_RETENTION_MODE,
          attemptLimit: 1,
          retryPolicy: "none",
          authorizationState: "consumed-before-dispatch",
          resultSchemaVersion: 1,
          requestFingerprint: ANTHROPIC_LIVE_CANARY_REQUEST_SHA256,
          endpoint: ANTHROPIC_MESSAGES_ENDPOINT,
          apiVersion: ANTHROPIC_API_VERSION,
          modelId: ANTHROPIC_LIVE_CANARY_MODEL,
          retentionMode: "standard-30-day",
          statusCategory: "success",
          transportKind: "direct-anthropic-https",
          durationMs: success.durationMs,
          inputTokens: success.inputTokens,
          outputTokens: success.outputTokens,
          modelSubstitutionRejected: true,
          fixedRequestBody: true,
          repositorySourcePresent: false,
          credentialRetained: false,
          responseBodyRetained: false,
          policyDecisionFingerprint: success.policyDecisionFingerprint,
          dispatchCount: 1,
          startedAt: input.validationStartedAt,
          completedAt,
          terminalState: "validated-success",
        });
        const pending: PendingAnthropicValidationSuccessReceipt = Object.freeze({
          kind: PENDING_SUCCESS_RECEIPT,
          receipt,
        });
        return pending;
      } catch (error) {
        if (input.signal.aborted && !(error instanceof AnthropicLiveCanaryError)) {
          throw new CredentialHostError("VALIDATION_CANCELLED");
        }
        return finiteAnthropicValidationFailure(error);
      }
    },
  });
}

export function finiteResultForAnthropicOutcome(
  outcome: CredentialValidationResult["outcome"],
): CredentialValidationResult {
  return Object.freeze({ outcome, resultCode: validationResultCode(outcome) });
}
