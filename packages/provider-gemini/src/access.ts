import { createHash } from "node:crypto";
import { toCanonicalJson } from "@ai-dev-os/domain";
import type { PolicyRequest } from "@ai-dev-os/policy";
import { ProviderError } from "@ai-dev-os/providers";
import { secretRefFingerprint } from "@ai-dev-os/secrets";
import type { GeminiAccessOptions, GeminiAccessPorts, GeminiAuthorizationRequest } from "./types.js";

const digest = (value: Record<string, unknown>) => createHash("sha256").update(toCanonicalJson(value)).digest("hex");
function assertSecretDecisionFingerprint(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ProviderError("POLICY_DENIED", "Gemini credential access was denied.", { decisionCode: "invalid-secret-policy-decision" });
  }
}
export function createPolicyAwareGeminiAccess(options: GeminiAccessOptions): GeminiAccessPorts {
  const refDigest = secretRefFingerprint(options.apiKeyRef);
  const lifetime = options.requestedLifetimeMs ?? 60_000;
  const common = (request: Parameters<GeminiAccessPorts["authorization"]["authorize"]>[0]) => ({
    schemaVersion: 1 as const, classification: request.request.disclosure.classification, handlingPolicy: options.context.handlingPolicy(request.request.disclosure.classification), risk: options.context.risk,
    locality: "cloud" as const, provider: request.descriptor, model: request.model,
    scope: { projectId: options.context.projectId, taskId: request.request.trace.taskId, providerInstanceId: request.descriptor.instanceId, workspaceId: null, operationId: request.operationId, traceId: request.request.trace.traceId },
    requestedCapabilities: request.requestedCapabilities, transformationsApplied: [], approvalEvidence: [], retentionDays: null, trace: request.request.trace, requesterKind: "system" as const,
  });
  return Object.freeze({
    authorization: Object.freeze({ async authorize(request: GeminiAuthorizationRequest) {
      const decision = options.policy.evaluate({ ...common(request), action: "cloud-execution", subjectDigest: digest({ providerInstanceId: request.descriptor.instanceId, modelId: request.model.modelId, capabilities: request.requestedCapabilities }) } as unknown as PolicyRequest);
      if (decision.outcome !== "allowed") throw new ProviderError("POLICY_DENIED", "Policy denied Gemini disclosure.", { decisionCode: decision.code });
      return Object.freeze({ decisionFingerprint: decision.fingerprint });
    } }),
    credentials: Object.freeze({ async withApiKey<T>(request: Parameters<GeminiAccessPorts["credentials"]["withApiKey"]>[0], use: (apiKey: string) => Promise<T>): Promise<T> {
      try {
        const result = await options.resolver.withSecret({
          ref: options.apiKeyRef,
          context: { operationId: request.operationId, providerInstanceId: request.descriptor.instanceId, purpose: "provider-authentication", requestedLifetimeMs: lifetime, accessForm: "text", classification: request.request.disclosure.classification, projectId: options.context.projectId, taskId: request.request.trace.taskId, approvalEvidenceRefs: [], disclosureDecisionFingerprint: request.authorization.decisionFingerprint, locality: "cloud", trace: request.request.trace, deadline: request.request.deadline, ...(request.signal === undefined ? {} : { signal: request.signal }) },
          policyRequest: { ...common(request), action: "secret-access", subjectDigest: refDigest } as unknown as PolicyRequest,
        }, async (secret, decisionFingerprint) => {
          assertSecretDecisionFingerprint(decisionFingerprint);
          return secret.useText(use);
        });
        return result.value;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === "ACCESS_DENIED" || code === "NOT_FOUND" || code === "KIND_MISMATCH") throw new ProviderError("POLICY_DENIED", "Gemini credential access was denied.", { decisionCode: typeof code === "string" ? code : "denied" });
        throw error;
      }
    } }),
  });
}
