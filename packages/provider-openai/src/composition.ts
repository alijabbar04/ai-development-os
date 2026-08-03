import { createHash } from "node:crypto";
import {
  toCanonicalJson,
  type DataClassification,
  type DataHandlingPolicy,
  type ModelCapabilities,
  type RedactionKind,
  type TaskRisk,
} from "@ai-dev-os/domain";
import type { ProviderDescriptor } from "@ai-dev-os/providers";
import type { PolicyBroker, PolicyCapability, PolicyRequest } from "@ai-dev-os/policy";
import { secretRefFingerprint, type PolicyAwareSecretResolver, type SecretRef } from "@ai-dev-os/secrets";
import { policyDeniedError } from "./errors.js";
import type {
  CredentialPort,
  CredentialRequest,
  DisclosureAuthorization,
  DisclosureAuthorizationRequest,
  DisclosurePort,
} from "./ports.js";

/**
 * Composition helpers that wire this adapter's ports to the Stage 6 policy
 * broker and policy-aware secret resolver.
 *
 * They are deliberately separate from the provider so the package depends
 * on the composition INTERFACES, not on any concrete secret backend, and
 * so a deployment can substitute its own authorization pipeline.
 */

export interface PolicyContextSource {
  /** Data-handling policy for a classification, from Stage 2. */
  handlingPolicy(classification: DataClassification): DataHandlingPolicy;
  readonly risk: TaskRisk;
  readonly projectId: string | null;
}

export interface DisclosurePortOptions {
  readonly policy: PolicyBroker;
  readonly context: PolicyContextSource;
  /** Read lazily: the descriptor is produced by the provider it guards. */
  readonly descriptor: () => ProviderDescriptor;
  /** Model capabilities for the request's model, when known. */
  readonly model?: (modelId: string) => ModelCapabilities | null;
  /**
   * Which redactions were actually applied upstream of this provider.
   *
   * The Stage 5 `DisclosureContext` carries only a boolean
   * `redactionApplied`, but the policy broker matches against specific
   * `RedactionKind`s. A boolean cannot say WHICH transformations ran, and
   * guessing would let an unredacted prompt satisfy a redaction rule. The
   * caller therefore states it explicitly; the default is "none applied",
   * which yields a conditional (not allowed) decision whenever a rule
   * requires a transformation. See the README for the proposed contract
   * change that would remove this hook.
   */
  readonly transformationsApplied?: (
    request: DisclosureAuthorizationRequest,
  ) => readonly RedactionKind[];
}

function subjectDigest(parts: Record<string, unknown>): string {
  return createHash("sha256").update(toCanonicalJson(parts)).digest("hex");
}

/**
 * Evaluates a `provider-disclosure` decision before anything is read or
 * sent. Persistence and background temporary state are evaluated as
 * separate `retention` decisions, because they are distinct commitments:
 * background mode places content in temporary server-side storage even
 * when `store` is false.
 */
export function createPolicyBrokerDisclosurePort(options: DisclosurePortOptions): DisclosurePort {
  return Object.freeze({
    async authorize(request: DisclosureAuthorizationRequest): Promise<DisclosureAuthorization> {
      const descriptor = options.descriptor();
      const handlingPolicy = options.context.handlingPolicy(request.disclosure.classification);
      const model = options.model?.(request.modelId) ?? null;

      const capabilities: PolicyCapability[] = [];
      if (request.requestsArtifactDisclosure) {
        capabilities.push("image-input");
      }
      if (request.requestsPersistence || request.requestsBackground) {
        capabilities.push("data-retention");
      }

      const base = {
        schemaVersion: 1 as const,
        classification: request.disclosure.classification,
        handlingPolicy,
        risk: options.context.risk,
        locality: "cloud" as const,
        provider: descriptor,
        model,
        scope: {
          projectId: options.context.projectId,
          taskId: request.trace.taskId,
          providerInstanceId: request.providerInstanceId,
          workspaceId: null,
          operationId: request.operationId,
          traceId: request.trace.traceId,
        },
        requestedCapabilities: capabilities,
        transformationsApplied: options.transformationsApplied?.(request) ?? [],
        approvalEvidence: [],
        trace: request.trace,
        requesterKind: "system" as const,
      };

      const disclosureRequest = {
        ...base,
        action: "provider-disclosure" as const,
        subjectDigest: subjectDigest({
          providerInstanceId: request.providerInstanceId,
          modelId: request.modelId,
          classification: request.disclosure.classification,
        }),
        retentionDays: null,
      } as unknown as PolicyRequest;

      const decision = options.policy.evaluate(disclosureRequest);
      if (decision.outcome !== "allowed") {
        return Object.freeze({
          allowed: false,
          denialCode: decision.code,
          persistenceAllowed: false,
          temporaryServerStateAllowed: false,
          decisionFingerprint: decision.fingerprint,
        });
      }

      // A retention decision is only sought when the request actually needs
      // one, so an ordinary stateless call never depends on retention rules.
      let persistenceAllowed = false;
      let temporaryServerStateAllowed = false;
      if (request.requestsPersistence || request.requestsBackground) {
        const retentionRequest = {
          ...base,
          action: "retention" as const,
          subjectDigest: subjectDigest({
            providerInstanceId: request.providerInstanceId,
            modelId: request.modelId,
            persistence: request.requestsPersistence,
            background: request.requestsBackground,
          }),
          retentionDays: request.requestsPersistence ? null : 0,
        } as unknown as PolicyRequest;
        const retentionDecision = options.policy.evaluate(retentionRequest);
        const allowed = retentionDecision.outcome === "allowed";
        persistenceAllowed = allowed && retentionDecision.retentionRestrictions.allowed;
        temporaryServerStateAllowed = allowed;
        if (!allowed) {
          return Object.freeze({
            allowed: false,
            denialCode: retentionDecision.code,
            persistenceAllowed: false,
            temporaryServerStateAllowed: false,
            decisionFingerprint: retentionDecision.fingerprint,
          });
        }
      }

      return Object.freeze({
        allowed: true,
        denialCode: null,
        persistenceAllowed,
        temporaryServerStateAllowed,
        decisionFingerprint: decision.fingerprint,
      });
    },
  });
}

export interface CredentialPortOptions {
  readonly resolver: PolicyAwareSecretResolver;
  readonly apiKeyRef: SecretRef;
  readonly context: PolicyContextSource;
  readonly descriptor: () => ProviderDescriptor;
  readonly requestedLifetimeMs?: number;
}

/**
 * Resolves the API key through the Stage 6 policy-aware flow.
 *
 * The resolver evaluates the `secret-access` decision BEFORE it calls the
 * secret broker, so a denial provably performs no backend resolve — and,
 * because this port is invoked only at the moment of the request, no HTTP
 * call has been made either. The material is scoped to the callback and is
 * never returned, stored, or logged.
 */
export function createPolicyAwareCredentialPort(options: CredentialPortOptions): CredentialPort {
  const lifetimeMs = options.requestedLifetimeMs ?? 60_000;
  return Object.freeze({
    async withApiKey<T>(request: CredentialRequest, use: (apiKey: string) => Promise<T>): Promise<T> {
      const descriptor = options.descriptor();
      const handlingPolicy = options.context.handlingPolicy(request.classification);

      const accessContext = {
        operationId: request.operationId,
        providerInstanceId: request.providerInstanceId,
        purpose: "provider-authentication" as const,
        requestedLifetimeMs: lifetimeMs,
        accessForm: "text" as const,
        classification: request.classification,
        projectId: options.context.projectId,
        taskId: request.trace.taskId,
        approvalEvidenceRefs: [],
        disclosureDecisionFingerprint: request.disclosureDecisionFingerprint,
        locality: "cloud" as const,
        trace: request.trace,
        deadline: request.deadline,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      };

      const policyRequest = {
        schemaVersion: 1 as const,
        action: "secret-access" as const,
        classification: request.classification,
        handlingPolicy,
        risk: options.context.risk,
        locality: "cloud" as const,
        provider: descriptor,
        model: null,
        scope: {
          projectId: options.context.projectId,
          taskId: request.trace.taskId,
          providerInstanceId: request.providerInstanceId,
          workspaceId: null,
          operationId: request.operationId,
          traceId: request.trace.traceId,
        },
        // The Stage 6 resolver requires the subject digest to equal the
        // SecretRef fingerprint, binding the decision to this exact
        // reference rather than to secret access in general.
        subjectDigest: secretRefFingerprint(options.apiKeyRef),
        requestedCapabilities: [],
        transformationsApplied: [],
        approvalEvidence: [],
        retentionDays: null,
        trace: request.trace,
        requesterKind: "system" as const,
      } as unknown as PolicyRequest;

      try {
        const outcome = await options.resolver.withSecret(
          {
            ref: options.apiKeyRef,
            context: accessContext as never,
            policyRequest,
          },
          async (secret) => secret.useText(async (apiKey) => use(apiKey)),
        );
        return outcome.value;
      } catch (error) {
        // A denial must not leak the reference, the backend, or the key.
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string" && (code === "ACCESS_DENIED" || code === "NOT_FOUND")) {
          throw policyDeniedError("secret-access-denied", { decisionCode: code });
        }
        throw error;
      }
    },
  });
}
