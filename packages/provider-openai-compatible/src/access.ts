import { createHash } from "node:crypto";
import { toCanonicalJson } from "@ai-dev-os/domain";
import { ProviderError } from "@ai-dev-os/providers";
import { secretRefFingerprint } from "@ai-dev-os/secrets";
import type { PolicyRequest } from "@ai-dev-os/policy";
import type { CreatePolicyAwareProviderAccessOptions, ProviderAccessPort, ProviderAccessRequest } from "./types.js";

function digest(value: Record<string, unknown>): string { return createHash("sha256").update(toCanonicalJson(value)).digest("hex"); }
function assertSecretDecisionFingerprint(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ProviderError("POLICY_DENIED", "Provider credential access was denied.", { decisionCode: "invalid-secret-policy-decision" });
  }
}

export function createPolicyAwareProviderAccess(options: CreatePolicyAwareProviderAccessOptions): ProviderAccessPort {
  const lifetime = options.requestedLifetimeMs ?? 60_000;
  const refFingerprint = secretRefFingerprint(options.apiKeyRef);
  return Object.freeze({
    async withAuthorizedApiKey<T>(request: ProviderAccessRequest, use: (apiKey: string) => Promise<T>): Promise<T> {
      const classification = request.request.disclosure.classification;
      const handlingPolicy = options.context.handlingPolicy(classification);
      const scope = { projectId: options.context.projectId, taskId: request.request.trace.taskId, providerInstanceId: request.descriptor.instanceId, workspaceId: null, operationId: request.operationId, traceId: request.request.trace.traceId };
      const common = { schemaVersion: 1 as const, classification, handlingPolicy, risk: options.context.risk, locality: "cloud" as const, provider: request.descriptor, model: request.model, scope, requestedCapabilities: request.requestedCapabilities, transformationsApplied: [], approvalEvidence: [], retentionDays: null, trace: request.request.trace, requesterKind: "system" as const };
      const disclosureRequest = { ...common, action: "cloud-execution" as const, subjectDigest: digest({ providerInstanceId: request.descriptor.instanceId, modelId: request.model.modelId, capabilities: request.requestedCapabilities }) } as unknown as PolicyRequest;
      const disclosure = options.policy.evaluate(disclosureRequest);
      if (disclosure.outcome !== "allowed") throw new ProviderError("POLICY_DENIED", "Policy denied provider disclosure.", { decisionCode: disclosure.code });
      const secretRequest = { ...common, action: "secret-access" as const, subjectDigest: refFingerprint } as unknown as PolicyRequest;
      try {
        const result = await options.resolver.withSecret({
          ref: options.apiKeyRef,
          context: {
            operationId: request.operationId, providerInstanceId: request.descriptor.instanceId, purpose: "provider-authentication", requestedLifetimeMs: lifetime,
            accessForm: "text", classification, projectId: options.context.projectId, taskId: request.request.trace.taskId, approvalEvidenceRefs: [],
            disclosureDecisionFingerprint: disclosure.fingerprint, locality: "cloud", trace: request.request.trace, deadline: request.request.deadline,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          },
          policyRequest: secretRequest,
        }, async (secret, decisionFingerprint) => {
          assertSecretDecisionFingerprint(decisionFingerprint);
          return secret.useText(use);
        });
        return result.value;
      } catch (error) {
        const code = (error as { readonly code?: unknown }).code;
        if (code === "ACCESS_DENIED" || code === "NOT_FOUND" || code === "KIND_MISMATCH") throw new ProviderError("POLICY_DENIED", "Provider credential access was denied.", { decisionCode: typeof code === "string" ? code : "denied" });
        throw error;
      }
    },
  });
}
