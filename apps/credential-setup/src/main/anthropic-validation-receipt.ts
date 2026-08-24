import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { toCanonicalJson } from "@ai-dev-os/domain";
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_ENDPOINT,
} from "@ai-dev-os/provider-anthropic";
import {
  ANTHROPIC_LIVE_CANARY_MAX_TOKENS,
  ANTHROPIC_LIVE_CANARY_MODEL,
  ANTHROPIC_LIVE_CANARY_REQUEST_SHA256,
  ANTHROPIC_LIVE_CANARY_TIMEOUT_MS,
} from "@ai-dev-os/provider-anthropic/validation";
import {
  ANTHROPIC_VALIDATION_OPERATION_VERSION,
  ANTHROPIC_VALIDATION_RETENTION_MODE,
} from "./anthropic-validation-authorization.js";

export const ANTHROPIC_SUCCESS_RECEIPT_VERSION =
  "ai-dev-os.stage-18e-i.anthropic-success-receipt.v1" as const;
export const ANTHROPIC_SUCCESS_RECEIPT_DIGEST_CONVENTION =
  "sha256-canonical-json-with-trailing-lf.v1" as const;
export const ANTHROPIC_SUCCESS_RECEIPT_MAX_BYTES = 16_384 as const;

const HASH = /^[a-f0-9]{64}$/u;
const GIT_OBJECT = /^[a-f0-9]{40}$/u;
const OPERATION_ID = /^credential-validate\.[a-f0-9]{32}$/u;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export interface AnthropicValidationSuccessReceipt {
  readonly schemaVersion: 1;
  readonly receiptVersion: typeof ANTHROPIC_SUCCESS_RECEIPT_VERSION;
  readonly digestConvention: typeof ANTHROPIC_SUCCESS_RECEIPT_DIGEST_CONVENTION;
  readonly operationVersion: typeof ANTHROPIC_VALIDATION_OPERATION_VERSION;
  readonly operationId: string;
  readonly slotId: "anthropic";
  readonly providerInstanceId: "anthropic-default";
  readonly candidateHead: string;
  readonly candidateTree: string;
  readonly candidateManifestAggregate: string;
  readonly authorizationPacketSha256: string;
  readonly authorizationReference: string;
  readonly markerNamespaceSha256: string;
  readonly authorizationRetentionMode: typeof ANTHROPIC_VALIDATION_RETENTION_MODE;
  readonly attemptLimit: 1;
  readonly retryPolicy: "none";
  readonly authorizationState: "consumed-before-dispatch";
  readonly resultSchemaVersion: 1;
  readonly requestFingerprint: typeof ANTHROPIC_LIVE_CANARY_REQUEST_SHA256;
  readonly endpoint: typeof ANTHROPIC_MESSAGES_ENDPOINT;
  readonly apiVersion: typeof ANTHROPIC_API_VERSION;
  readonly modelId: typeof ANTHROPIC_LIVE_CANARY_MODEL;
  readonly retentionMode: "standard-30-day";
  readonly statusCategory: "success";
  readonly transportKind: "direct-anthropic-https";
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelSubstitutionRejected: true;
  readonly fixedRequestBody: true;
  readonly repositorySourcePresent: false;
  readonly credentialRetained: false;
  readonly responseBodyRetained: false;
  readonly policyDecisionFingerprint: string;
  readonly dispatchCount: 1;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly terminalState: "validated-success";
}

export class AnthropicValidationReceiptError extends Error {
  readonly code:
    | "RECEIPT_INVALID"
    | "RECEIPT_MISSING"
    | "RECEIPT_INCOMPLETE"
    | "RECEIPT_CONFLICT"
    | "RECEIPT_UNAVAILABLE";

  constructor(code: AnthropicValidationReceiptError["code"]) {
    super("The sanitized Anthropic validation receipt is unavailable.");
    this.name = "AnthropicValidationReceiptError";
    this.code = code;
  }
}

function invalid(): never {
  throw new AnthropicValidationReceiptError("RECEIPT_INVALID");
}

/**
 * Independent receipt validation. The producer does not consume this key list:
 * it constructs a literal from the independently validated provider envelope.
 */
export function parseAnthropicValidationSuccessReceipt(value: unknown): AnthropicValidationSuccessReceipt {
  const expectedKeys = [
    "schemaVersion", "receiptVersion", "digestConvention", "operationVersion",
    "operationId", "slotId", "providerInstanceId", "candidateHead",
    "candidateTree", "candidateManifestAggregate", "authorizationPacketSha256",
    "authorizationReference", "markerNamespaceSha256", "authorizationRetentionMode",
    "attemptLimit", "retryPolicy", "authorizationState", "resultSchemaVersion",
    "requestFingerprint", "endpoint", "apiVersion", "modelId", "retentionMode",
    "statusCategory", "transportKind", "durationMs", "inputTokens", "outputTokens",
    "modelSubstitutionRejected", "fixedRequestBody", "repositorySourcePresent",
    "credentialRetained", "responseBodyRetained", "policyDecisionFingerprint",
    "dispatchCount", "startedAt", "completedAt", "terminalState",
  ] as const;
  try {
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    ) invalid();
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key as never))
    ) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const field = (name: typeof expectedKeys[number]): unknown => {
      const descriptor = descriptors[name];
      if (descriptor === undefined || !("value" in descriptor)) invalid();
      return descriptor.value;
    };
    const startedAt = field("startedAt");
    const completedAt = field("completedAt");
    if (
      field("schemaVersion") !== 1 ||
      field("receiptVersion") !== ANTHROPIC_SUCCESS_RECEIPT_VERSION ||
      field("digestConvention") !== ANTHROPIC_SUCCESS_RECEIPT_DIGEST_CONVENTION ||
      field("operationVersion") !== ANTHROPIC_VALIDATION_OPERATION_VERSION ||
      typeof field("operationId") !== "string" || !OPERATION_ID.test(field("operationId") as string) ||
      field("slotId") !== "anthropic" || field("providerInstanceId") !== "anthropic-default" ||
      typeof field("candidateHead") !== "string" || !GIT_OBJECT.test(field("candidateHead") as string) ||
      typeof field("candidateTree") !== "string" || !GIT_OBJECT.test(field("candidateTree") as string) ||
      typeof field("candidateManifestAggregate") !== "string" || !HASH.test(field("candidateManifestAggregate") as string) ||
      typeof field("authorizationPacketSha256") !== "string" || !HASH.test(field("authorizationPacketSha256") as string) ||
      typeof field("authorizationReference") !== "string" || !REFERENCE.test(field("authorizationReference") as string) ||
      typeof field("markerNamespaceSha256") !== "string" || !HASH.test(field("markerNamespaceSha256") as string) ||
      field("authorizationRetentionMode") !== ANTHROPIC_VALIDATION_RETENTION_MODE ||
      field("attemptLimit") !== 1 || field("retryPolicy") !== "none" ||
      field("authorizationState") !== "consumed-before-dispatch" ||
      field("resultSchemaVersion") !== 1 ||
      field("requestFingerprint") !== ANTHROPIC_LIVE_CANARY_REQUEST_SHA256 ||
      field("endpoint") !== ANTHROPIC_MESSAGES_ENDPOINT ||
      field("apiVersion") !== ANTHROPIC_API_VERSION ||
      field("modelId") !== ANTHROPIC_LIVE_CANARY_MODEL ||
      field("retentionMode") !== "standard-30-day" ||
      field("statusCategory") !== "success" ||
      field("transportKind") !== "direct-anthropic-https" ||
      !Number.isSafeInteger(field("durationMs")) || (field("durationMs") as number) < 0 || (field("durationMs") as number) >= ANTHROPIC_LIVE_CANARY_TIMEOUT_MS ||
      !Number.isSafeInteger(field("inputTokens")) || (field("inputTokens") as number) < 0 || (field("inputTokens") as number) > 256 ||
      !Number.isSafeInteger(field("outputTokens")) || (field("outputTokens") as number) < 0 || (field("outputTokens") as number) > ANTHROPIC_LIVE_CANARY_MAX_TOKENS ||
      field("modelSubstitutionRejected") !== true || field("fixedRequestBody") !== true ||
      field("repositorySourcePresent") !== false || field("credentialRetained") !== false ||
      field("responseBodyRetained") !== false ||
      typeof field("policyDecisionFingerprint") !== "string" || !HASH.test(field("policyDecisionFingerprint") as string) ||
      field("dispatchCount") !== 1 ||
      typeof startedAt !== "string" || !ISO.test(startedAt) ||
      typeof completedAt !== "string" || !ISO.test(completedAt) ||
      field("terminalState") !== "validated-success"
    ) invalid();
    const startMs = Date.parse(startedAt as string);
    const completeMs = Date.parse(completedAt as string);
    const durationMs = field("durationMs") as number;
    const hostIntervalMs = completeMs - startMs;
    if (
      !Number.isFinite(startMs) || !Number.isFinite(completeMs) ||
      new Date(startMs).toISOString() !== startedAt ||
      new Date(completeMs).toISOString() !== completedAt ||
      hostIntervalMs < 0 || hostIntervalMs >= 20_000 ||
      durationMs > hostIntervalMs
    ) invalid();

    return Object.freeze({
      schemaVersion: 1,
      receiptVersion: ANTHROPIC_SUCCESS_RECEIPT_VERSION,
      digestConvention: ANTHROPIC_SUCCESS_RECEIPT_DIGEST_CONVENTION,
      operationVersion: ANTHROPIC_VALIDATION_OPERATION_VERSION,
      operationId: field("operationId") as string,
      slotId: "anthropic",
      providerInstanceId: "anthropic-default",
      candidateHead: field("candidateHead") as string,
      candidateTree: field("candidateTree") as string,
      candidateManifestAggregate: field("candidateManifestAggregate") as string,
      authorizationPacketSha256: field("authorizationPacketSha256") as string,
      authorizationReference: field("authorizationReference") as string,
      markerNamespaceSha256: field("markerNamespaceSha256") as string,
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
      durationMs: field("durationMs") as number,
      inputTokens: field("inputTokens") as number,
      outputTokens: field("outputTokens") as number,
      modelSubstitutionRejected: true,
      fixedRequestBody: true,
      repositorySourcePresent: false,
      credentialRetained: false,
      responseBodyRetained: false,
      policyDecisionFingerprint: field("policyDecisionFingerprint") as string,
      dispatchCount: 1,
      startedAt: startedAt as string,
      completedAt: completedAt as string,
      terminalState: "validated-success",
    });
  } catch (error) {
    if (error instanceof AnthropicValidationReceiptError) throw error;
    invalid();
  }
}

export function serializeAnthropicValidationSuccessReceipt(value: unknown): string {
  const receipt = parseAnthropicValidationSuccessReceipt(value);
  const text = `${toCanonicalJson(receipt, "anthropicValidationSuccessReceipt")}\n`;
  if (Buffer.byteLength(text, "utf8") > ANTHROPIC_SUCCESS_RECEIPT_MAX_BYTES) invalid();
  return text;
}

export function parseCanonicalAnthropicValidationSuccessReceipt(
  bytes: Uint8Array,
): Readonly<{ receipt: AnthropicValidationSuccessReceipt; canonicalDocument: string; sha256: string }> {
  try {
    if (bytes.byteLength < 2 || bytes.byteLength > ANTHROPIC_SUCCESS_RECEIPT_MAX_BYTES) invalid();
    const document = UTF8.decode(bytes);
    const receipt = parseAnthropicValidationSuccessReceipt(JSON.parse(document) as unknown);
    const canonicalDocument = serializeAnthropicValidationSuccessReceipt(receipt);
    if (document !== canonicalDocument) invalid();
    return Object.freeze({
      receipt,
      canonicalDocument,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } catch (error) {
    if (error instanceof AnthropicValidationReceiptError) throw error;
    invalid();
  }
}

export function anthropicValidationSuccessReceiptSha256(value: unknown): string {
  return createHash("sha256")
    .update(serializeAnthropicValidationSuccessReceipt(value), "utf8")
    .digest("hex");
}
