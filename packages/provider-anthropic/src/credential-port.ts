import { types } from "node:util";
import { DATA_CLASSIFICATIONS, validation } from "@ai-dev-os/domain";
import { PROVIDER_ERROR_CODES, ProviderError, parseExecutionTraceMetadata } from "@ai-dev-os/providers";
import {
  SecretBrokerError,
  parseSecretRef,
  secretRefFingerprint,
  type PolicyAwareSecretResolver,
  type SecretAccessContext,
} from "@ai-dev-os/secrets";
import { parsePolicyRequest, type PolicyRequest } from "@ai-dev-os/policy";
import {
  ANTHROPIC_TRANSPORT_FAILURE_KINDS,
  AnthropicTransportFailure,
  type AnthropicCredentialPort,
  type AnthropicCredentialRequest,
  type AnthropicTransportFailureKind,
} from "./contracts.js";

const { ensureEnum, ensureNullable, ensureString, ensureTimestamp } = validation;

const RESOLVER_ERROR_MESSAGES = Object.freeze({
  INVALID_REFERENCE: "The Anthropic credential reference is invalid.",
  NOT_FOUND: "The Anthropic credential was not found.",
  UNAVAILABLE: "The Anthropic credential backend is unavailable.",
  ACCESS_DENIED: "The Anthropic credential access was denied.",
  VERSION_UNAVAILABLE: "The Anthropic credential version is unavailable.",
  UNSUPPORTED_OPERATION: "The Anthropic credential operation is unsupported.",
  EXPIRED: "The Anthropic credential expired.",
  REVOKED: "The Anthropic credential was revoked.",
  BROKER_CLOSED: "The Anthropic credential broker is closed.",
  RESOLUTION_TIMEOUT: "The Anthropic credential resolution timed out.",
  BACKEND_FAILURE: "The Anthropic credential backend failed.",
  MALFORMED_BACKEND_RESPONSE: "The Anthropic credential backend response was malformed.",
  CONSUMER_FAILURE: "The Anthropic credential consumer failed.",
  KIND_MISMATCH: "The Anthropic credential kind is invalid.",
  MATERIAL_DISPOSED: "The Anthropic credential material is unavailable.",
  AUDIT_FAILURE: "The Anthropic credential audit failed.",
} as const);

function finiteResolverError(error: unknown): SecretBrokerError {
  try {
    if (!(error instanceof SecretBrokerError) || types.isProxy(error)) throw new Error("untrusted-error");
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string" || !Object.hasOwn(RESOLVER_ERROR_MESSAGES, descriptor.value)) throw new Error("untrusted-error");
    const code = descriptor.value as keyof typeof RESOLVER_ERROR_MESSAGES;
    return new SecretBrokerError(code, RESOLVER_ERROR_MESSAGES[code]);
  } catch {
    return new SecretBrokerError("BACKEND_FAILURE", "The Anthropic credential resolution failed.");
  }
}

function finiteConsumerError(error: unknown): AnthropicTransportFailure | ProviderError | SecretBrokerError {
  try {
    if (types.isProxy(error)) throw new Error("untrusted-error");
    if (error instanceof AnthropicTransportFailure) {
      const kindDescriptor = Object.getOwnPropertyDescriptor(error, "kind");
      const statusDescriptor = Object.getOwnPropertyDescriptor(error, "status");
      const retryDescriptor = Object.getOwnPropertyDescriptor(error, "retryAfterMs");
      if (kindDescriptor === undefined || !("value" in kindDescriptor) || !ANTHROPIC_TRANSPORT_FAILURE_KINDS.includes(kindDescriptor.value as AnthropicTransportFailureKind) || statusDescriptor === undefined || !("value" in statusDescriptor) || retryDescriptor === undefined || !("value" in retryDescriptor)) throw new Error("untrusted-error");
      const status = Number.isSafeInteger(statusDescriptor.value) && statusDescriptor.value >= 100 && statusDescriptor.value <= 599 ? statusDescriptor.value as number : null;
      const retryAfterMs = Number.isSafeInteger(retryDescriptor.value) && retryDescriptor.value >= 0 && retryDescriptor.value <= 86_400_000 ? retryDescriptor.value as number : null;
      return new AnthropicTransportFailure(kindDescriptor.value as AnthropicTransportFailureKind, { status, retryAfterMs });
    }
    if (error instanceof ProviderError) {
      const codeDescriptor = Object.getOwnPropertyDescriptor(error, "code");
      if (codeDescriptor === undefined || !("value" in codeDescriptor) || !PROVIDER_ERROR_CODES.includes(codeDescriptor.value as (typeof PROVIDER_ERROR_CODES)[number])) throw new Error("untrusted-error");
      return new ProviderError(codeDescriptor.value as (typeof PROVIDER_ERROR_CODES)[number], "The Anthropic credential consumer returned a redacted provider classification.", {}, { causeCategory: "credential-consumer" });
    }
  } catch { /* fall through to one fixed consumer failure */ }
  return new SecretBrokerError("CONSUMER_FAILURE", "The Anthropic credential consumer failed.");
}

export interface PolicyAwareAnthropicCredentialPortOptions {
  readonly resolver: PolicyAwareSecretResolver;
  readonly policyRequestFor: (request: AnthropicCredentialRequest) => PolicyRequest;
  readonly requestedLifetimeMs: number;
}

function snapshotRecord(value: unknown, allowedKeys: readonly string[], requiredKeys: readonly string[], path: string): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      throw new SecretBrokerError("INVALID_REFERENCE", `${path} must be a plain data object.`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string") || keys.length > allowedKeys.length || (keys as string[]).some((key) => !allowedKeys.includes(key)) || requiredKeys.some((key) => !keys.includes(key))) {
      throw new SecretBrokerError("INVALID_REFERENCE", `${path} has an invalid key set.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) throw new SecretBrokerError("INVALID_REFERENCE", `${path} must contain data properties only.`);
      output[key] = descriptor.value;
    }
    return Object.freeze(output);
  } catch (error) {
    if (error instanceof SecretBrokerError) throw error;
    throw new SecretBrokerError("INVALID_REFERENCE", `${path} could not be inspected safely.`);
  }
}

function parseRequest(value: AnthropicCredentialRequest): AnthropicCredentialRequest {
  const keys = ["instanceId", "operationId", "secretRef", "classification", "policyDecisionFingerprint", "deadline", "trace", "signal"] as const;
  const record = snapshotRecord(value, keys, keys.filter((key) => key !== "signal"), "anthropicCredentialRequest");
  const signal = record["signal"];
  if (signal !== undefined && (typeof signal !== "object" || signal === null || types.isProxy(signal) || Reflect.get(signal, "aborted") === undefined || typeof Reflect.get(signal, "addEventListener") !== "function")) {
    throw new SecretBrokerError("INVALID_REFERENCE", "The Anthropic credential cancellation signal is invalid.");
  }
  return Object.freeze({
    instanceId: ensureString(record["instanceId"], "anthropicCredentialRequest.instanceId", { maxLength: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, patternName: "provider instance id" }),
    operationId: ensureString(record["operationId"], "anthropicCredentialRequest.operationId", { maxLength: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, patternName: "operation id" }),
    secretRef: parseSecretRef(record["secretRef"], "anthropicCredentialRequest.secretRef"),
    classification: ensureEnum(record["classification"], "anthropicCredentialRequest.classification", DATA_CLASSIFICATIONS),
    policyDecisionFingerprint: ensureString(record["policyDecisionFingerprint"], "anthropicCredentialRequest.policyDecisionFingerprint", { maxLength: 64, pattern: /^[a-f0-9]{64}$/, patternName: "policy decision fingerprint" }),
    deadline: ensureNullable(record["deadline"], (raw) => ensureTimestamp(raw, "anthropicCredentialRequest.deadline")),
    trace: parseExecutionTraceMetadata(record["trace"], "anthropicCredentialRequest.trace"),
    ...(signal === undefined ? {} : { signal: signal as Exclude<AnthropicCredentialRequest["signal"], undefined> }),
  });
}

function parseOptions(value: PolicyAwareAnthropicCredentialPortOptions): Required<PolicyAwareAnthropicCredentialPortOptions> {
  const keys = ["resolver", "policyRequestFor", "requestedLifetimeMs"] as const;
  const record = snapshotRecord(value, keys, keys, "options");
  const resolver = record["resolver"];
  if (typeof resolver !== "object" || resolver === null || types.isProxy(resolver)) {
    throw new SecretBrokerError("INVALID_REFERENCE", "options.resolver is invalid.");
  }
  const resolverDescriptor = Object.getOwnPropertyDescriptor(resolver, "withSecret");
  if (resolverDescriptor === undefined || !("value" in resolverDescriptor) || typeof resolverDescriptor.value !== "function") {
    throw new SecretBrokerError("INVALID_REFERENCE", "options.resolver.withSecret must be an own data method.");
  }
  const resolverMethod = resolverDescriptor.value as PolicyAwareSecretResolver["withSecret"];
  const policyRequestFor = record["policyRequestFor"];
  if (typeof policyRequestFor !== "function") throw new SecretBrokerError("INVALID_REFERENCE", "options.policyRequestFor is invalid.");
  const requestedLifetimeMs = record["requestedLifetimeMs"];
  if (!Number.isSafeInteger(requestedLifetimeMs) || (requestedLifetimeMs as number) < 1 || (requestedLifetimeMs as number) > 60_000) {
    throw new SecretBrokerError("INVALID_REFERENCE", "options.requestedLifetimeMs is outside the supported bound.");
  }
  return Object.freeze({
    resolver: Object.freeze({
      withSecret: <T>(input: Parameters<PolicyAwareSecretResolver["withSecret"]>[0], callback: Parameters<PolicyAwareSecretResolver["withSecret"]>[1]) => Reflect.apply(resolverMethod, resolver, [input, callback]) as ReturnType<PolicyAwareSecretResolver["withSecret"]>,
    }) as PolicyAwareSecretResolver,
    policyRequestFor: (request: AnthropicCredentialRequest) => Reflect.apply(policyRequestFor, undefined, [request]) as PolicyRequest,
    requestedLifetimeMs: requestedLifetimeMs as number,
  });
}

export function createPolicyAwareAnthropicCredentialPort(rawOptions: PolicyAwareAnthropicCredentialPortOptions): AnthropicCredentialPort {
  const options = parseOptions(rawOptions);
  return Object.freeze({
    async withApiKey<T>(rawRequest: AnthropicCredentialRequest, use: (secretText: string) => Promise<T>): Promise<T> {
      if (typeof use !== "function") throw new SecretBrokerError("INVALID_REFERENCE", "The Anthropic secret consumer is invalid.");
      let request: AnthropicCredentialRequest;
      try { request = parseRequest(rawRequest); }
      catch (error) { if (error instanceof SecretBrokerError) throw error; throw new SecretBrokerError("INVALID_REFERENCE", "The Anthropic credential request is invalid."); }
      let policyRequest: PolicyRequest;
      try { policyRequest = parsePolicyRequest(options.policyRequestFor(request)); }
      catch { throw new SecretBrokerError("ACCESS_DENIED", "The Anthropic secret-access policy request could not be constructed."); }
      const context: SecretAccessContext = Object.freeze({
        operationId: request.operationId,
        providerInstanceId: request.instanceId,
        purpose: "provider-authentication",
        requestedLifetimeMs: options.requestedLifetimeMs,
        accessForm: "text",
        classification: request.classification,
        projectId: policyRequest.scope.projectId,
        taskId: request.trace.taskId,
        approvalEvidenceRefs: Object.freeze(policyRequest.approvalEvidence.map((item) => item.evidenceRef).sort()),
        disclosureDecisionFingerprint: request.policyDecisionFingerprint,
        locality: "cloud",
        trace: request.trace,
        deadline: request.deadline,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      let callbackDecisionFingerprint: string | null = null;
      let callbackCompleted = false;
      let callbackValue: T | undefined;
      let callbackFailure: AnthropicTransportFailure | ProviderError | SecretBrokerError | null = null;
      try {
        await options.resolver.withSecret(Object.freeze({ ref: request.secretRef, context, policyRequest }), async (material, decisionFingerprint) => {
          if (callbackDecisionFingerprint !== null || typeof decisionFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(decisionFingerprint)) {
            throw new SecretBrokerError("ACCESS_DENIED", "The secret-access policy decision is invalid.");
          }
          callbackDecisionFingerprint = decisionFingerprint;
          try { callbackValue = await material.useText(use); }
          catch (error) { callbackFailure = finiteConsumerError(error); }
          callbackCompleted = true;
          return callbackValue as T;
        });
      } catch (error) {
        throw finiteResolverError(error);
      }
      if (callbackDecisionFingerprint === null || !callbackCompleted) {
        throw new SecretBrokerError("ACCESS_DENIED", "The secret-access policy decision is invalid.");
      }
      if (callbackFailure !== null) throw callbackFailure;
      return callbackValue as T;
    },
  });
}
