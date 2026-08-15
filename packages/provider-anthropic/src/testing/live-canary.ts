import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { validation } from "@ai-dev-os/domain";
import { createTrace } from "@ai-dev-os/providers";
import {
  parseSecretRef,
  type SecretAccessContext,
  type SecretBroker,
  type SecretMaterial,
  type SecretRef,
} from "@ai-dev-os/secrets";
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_ENDPOINT,
  type AnthropicRetentionMode,
} from "../contracts.js";

const { ensureEnum, ensureExactKeys, ensureRecord, ensureString } = validation;

export const ANTHROPIC_LIVE_CANARY_OPT_IN =
  "AI_DEV_OS_ANTHROPIC_LIVE_CANARY_V1" as const;
export const ANTHROPIC_LIVE_CANARY_MODEL =
  "claude-haiku-4-5-20251001" as const;
export const ANTHROPIC_LIVE_CANARY_MAX_TOKENS = 4 as const;
export const ANTHROPIC_LIVE_CANARY_MAX_RESPONSE_BYTES = 64 * 1024;
export const ANTHROPIC_LIVE_CANARY_TIMEOUT_MS = 15_000;
export const ANTHROPIC_LIVE_CANARY_CALLBACK_DRAIN_MS = 5_000;

const FIXED_PROMPT = "Reply with exactly OK.";
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UINT8_ARRAY_FILL = Uint8Array.prototype.fill;
const UINT8_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  "byteLength",
)!.get!;
const DATE_VALUE_OF = Date.prototype.valueOf;

export const ANTHROPIC_LIVE_CANARY_ERROR_CODES = Object.freeze([
  "NOT_OPTED_IN",
  "ALREADY_ATTEMPTED",
  "INVALID_CONFIGURATION",
  "PREFLIGHT_DENIED",
  "SECRET_UNAVAILABLE",
  "TRANSPORT_FAILURE",
  "TIMEOUT",
  "RESPONSE_INVALID",
  "CALLBACK_RESULT_FAILURE",
] as const);
export type AnthropicLiveCanaryErrorCode =
  (typeof ANTHROPIC_LIVE_CANARY_ERROR_CODES)[number];

export const ANTHROPIC_LIVE_CANARY_FAILURE_PHASES = Object.freeze([
  "pre-dispatch",
  "possibly-dispatched",
  "response-received",
  "post-response",
] as const);
export type AnthropicLiveCanaryFailurePhase =
  (typeof ANTHROPIC_LIVE_CANARY_FAILURE_PHASES)[number];

const MESSAGES: Record<AnthropicLiveCanaryErrorCode, string> = Object.freeze({
  NOT_OPTED_IN: "The Anthropic live canary was not explicitly enabled.",
  ALREADY_ATTEMPTED: "The Anthropic live canary permits only one attempt.",
  INVALID_CONFIGURATION: "The Anthropic live canary configuration is invalid.",
  PREFLIGHT_DENIED: "The Anthropic live canary preflight was denied.",
  SECRET_UNAVAILABLE: "The scoped Anthropic credential is unavailable.",
  TRANSPORT_FAILURE: "The Anthropic live canary transport failed.",
  TIMEOUT: "The Anthropic live canary exceeded its wall-time bound.",
  RESPONSE_INVALID: "The Anthropic live canary response was invalid.",
  CALLBACK_RESULT_FAILURE:
    "The Anthropic live canary callback result could not be finalized.",
});

function defaultFailurePhase(
  code: AnthropicLiveCanaryErrorCode,
): AnthropicLiveCanaryFailurePhase {
  if (code === "RESPONSE_INVALID") return "response-received";
  if (
    code === "TRANSPORT_FAILURE" ||
    code === "TIMEOUT" ||
    code === "CALLBACK_RESULT_FAILURE"
  ) {
    return "possibly-dispatched";
  }
  return "pre-dispatch";
}

export class AnthropicLiveCanaryError extends Error {
  readonly code: AnthropicLiveCanaryErrorCode;
  readonly failurePhase: AnthropicLiveCanaryFailurePhase;

  constructor(
    code: AnthropicLiveCanaryErrorCode,
    failurePhase: AnthropicLiveCanaryFailurePhase = defaultFailurePhase(code),
  ) {
    super(MESSAGES[code]);
    this.name = "AnthropicLiveCanaryError";
    this.code = code;
    this.failurePhase = failurePhase;
  }

  toJSON(): object {
    return {
      name: this.name,
      code: this.code,
      failurePhase: this.failurePhase,
      message: this.message,
    };
  }
}

const INTERNAL_CANARY_ERRORS = new WeakSet<AnthropicLiveCanaryError>();

function internalError(
  code: AnthropicLiveCanaryErrorCode,
  failurePhase?: AnthropicLiveCanaryFailurePhase,
): AnthropicLiveCanaryError {
  const error = new AnthropicLiveCanaryError(code, failurePhase);
  INTERNAL_CANARY_ERRORS.add(error);
  return Object.freeze(error);
}

function isInternalError(error: unknown): error is AnthropicLiveCanaryError {
  return error instanceof AnthropicLiveCanaryError &&
    INTERNAL_CANARY_ERRORS.has(error);
}

function zeroBytes(bytes: Uint8Array): void {
  Reflect.apply(UINT8_ARRAY_FILL, bytes, [0]);
}

function byteLength(bytes: Uint8Array): number {
  return Reflect.apply(UINT8_ARRAY_BYTE_LENGTH, bytes, []) as number;
}

export interface AnthropicLiveCanaryPreflightRequest {
  readonly endpoint: typeof ANTHROPIC_MESSAGES_ENDPOINT;
  readonly apiVersion: typeof ANTHROPIC_API_VERSION;
  readonly modelId: typeof ANTHROPIC_LIVE_CANARY_MODEL;
  readonly retentionMode: AnthropicRetentionMode;
  readonly catalogFingerprint: string;
  readonly authorizationReference: string;
  readonly requestFingerprint: string;
  readonly signal: AbortSignal;
}

export interface AnthropicLiveCanaryPreflightDecision {
  readonly allowed: boolean;
  readonly decisionFingerprint: string | null;
  readonly catalogFingerprint: string | null;
  readonly authorizationReference: string | null;
  readonly retentionMode: AnthropicRetentionMode;
}

export interface AnthropicLiveCanaryTransportRequest {
  readonly endpoint: typeof ANTHROPIC_MESSAGES_ENDPOINT;
  readonly apiVersion: typeof ANTHROPIC_API_VERSION;
  readonly modelId: typeof ANTHROPIC_LIVE_CANARY_MODEL;
  readonly body: string;
  readonly maximumResponseBytes: number;
  readonly signal: AbortSignal;
}

export interface AnthropicLiveCanaryTransportResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: Uint8Array;
}

export interface AnthropicLiveCanaryTransport {
  readonly kind: "direct-anthropic-https" | "deterministic-fake";
  post(
    request: AnthropicLiveCanaryTransportRequest,
    apiKey: string,
  ): Promise<AnthropicLiveCanaryTransportResponse>;
}

type FailurePhaseObserver = (phase: AnthropicLiveCanaryFailurePhase) => void;

interface InternalAnthropicLiveCanaryTransport
  extends AnthropicLiveCanaryTransport {
  readonly trustedInternalErrors: boolean;
  post(
    request: AnthropicLiveCanaryTransportRequest,
    apiKey: string,
    observeFailurePhase?: FailurePhaseObserver,
  ): Promise<AnthropicLiveCanaryTransportResponse>;
}

export interface AnthropicLiveCanaryOptions {
  readonly instanceId: string;
  readonly apiKeyRef: SecretRef;
  readonly retentionMode: AnthropicRetentionMode;
  readonly expectedCatalogFingerprint: string;
  readonly expectedAuthorizationReference: string;
  readonly broker: SecretBroker;
  readonly preflight: {
    check(
      request: AnthropicLiveCanaryPreflightRequest,
    ): Promise<AnthropicLiveCanaryPreflightDecision>;
  };
  readonly transport?: AnthropicLiveCanaryTransport;
  readonly now?: () => Date;
}

export interface AnthropicLiveCanaryResult {
  readonly schemaVersion: 1;
  readonly endpoint: typeof ANTHROPIC_MESSAGES_ENDPOINT;
  readonly apiVersion: typeof ANTHROPIC_API_VERSION;
  readonly modelId: typeof ANTHROPIC_LIVE_CANARY_MODEL;
  readonly retentionMode: AnthropicRetentionMode;
  readonly statusCategory: "success";
  readonly transportKind: AnthropicLiveCanaryTransport["kind"];
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelSubstitutionRejected: true;
  readonly fixedRequestBody: true;
  readonly repositorySourcePresent: false;
  readonly credentialRetained: false;
  readonly responseBodyRetained: false;
  readonly requestFingerprint: string;
  readonly policyDecisionFingerprint: string;
}

interface ParsedCanaryOptions {
  readonly instanceId: string;
  readonly apiKeyRef: SecretRef;
  readonly retentionMode: AnthropicRetentionMode;
  readonly expectedCatalogFingerprint: string;
  readonly expectedAuthorizationReference: string;
  readonly availability: SecretBroker["availability"];
  readonly withSecret: SecretBroker["withSecret"];
  readonly preflightCheck: AnthropicLiveCanaryOptions["preflight"]["check"];
  readonly transport: InternalAnthropicLiveCanaryTransport;
  readonly now: () => Date;
}

function fail(
  code: AnthropicLiveCanaryErrorCode,
  failurePhase?: AnthropicLiveCanaryFailurePhase,
): never {
  throw internalError(code, failurePhase);
}

function directTransport(
  requestFunction: typeof httpsRequest = httpsRequest,
): InternalAnthropicLiveCanaryTransport {
  return Object.freeze({
    kind: "direct-anthropic-https" as const,
    trustedInternalErrors: true,
    post(
      request: AnthropicLiveCanaryTransportRequest,
      apiKey: string,
      observeFailurePhase: FailurePhaseObserver = () => undefined,
    ): Promise<AnthropicLiveCanaryTransportResponse> {
      return new Promise((resolve, reject) => {
        if (request.signal.aborted) {
          reject(internalError("TIMEOUT", "pre-dispatch"));
          return;
        }
        const bodyBytes = Buffer.from(request.body, "utf8");
        const responseBytes = Buffer.alloc(request.maximumResponseBytes);
        let settled = false;
        let requestSubmitted = false;
        let responseReceived = false;
        let req: ReturnType<typeof httpsRequest> | null = null;
        const failurePhase = (): AnthropicLiveCanaryFailurePhase =>
          responseReceived
            ? "response-received"
            : requestSubmitted
              ? "possibly-dispatched"
              : "pre-dispatch";
        const rejectBounded = (error: unknown): void => {
          if (settled) return;
          settled = true;
          zeroBytes(responseBytes);
          request.signal.removeEventListener("abort", abort);
          reject(error);
        };
        const resolveBounded = (
          response: AnthropicLiveCanaryTransportResponse,
        ): void => {
          if (settled) return;
          settled = true;
          request.signal.removeEventListener("abort", abort);
          resolve(response);
        };
        const destroyRequest = (error: AnthropicLiveCanaryError): void => {
          try {
            req?.destroy(error);
          } catch {
            // The primary finite error remains authoritative.
          }
        };
        const abort = (): void => {
          const error = internalError(
            "TIMEOUT",
            failurePhase(),
          );
          rejectBounded(error);
          destroyRequest(error);
        };
        try {
          req = requestFunction(
            {
              protocol: "https:",
              hostname: "api.anthropic.com",
              port: 443,
              path: "/v1/messages",
              method: "POST",
              agent: false,
              headers: {
                "content-type": "application/json",
                "content-length": bodyBytes.byteLength,
                "anthropic-version": request.apiVersion,
                "x-api-key": apiKey,
              },
            },
            (response) => {
              responseReceived = true;
              observeFailurePhase("response-received");
              let bytes = 0;
              let chunkCount = 0;
              response.on("data", (chunk: Buffer) => {
                try {
                  if (settled) return;
                  chunkCount += 1;
                  if (
                    chunkCount > 128 ||
                    bytes + chunk.byteLength > request.maximumResponseBytes
                  ) {
                    const error = internalError(
                      "RESPONSE_INVALID",
                      "response-received",
                    );
                    rejectBounded(error);
                    destroyRequest(error);
                    return;
                  }
                  chunk.copy(responseBytes, bytes);
                  bytes += chunk.byteLength;
                } finally {
                  zeroBytes(chunk);
                }
              });
              response.on("end", () => {
                resolveBounded(Object.freeze({
                  status: response.statusCode ?? 0,
                  contentType:
                    typeof response.headers["content-type"] === "string"
                      ? response.headers["content-type"]
                      : null,
                  body: new Uint8Array(
                    responseBytes.buffer,
                    responseBytes.byteOffset,
                    bytes,
                  ),
                }));
              });
              response.once("aborted", () => {
                rejectBounded(internalError(
                  "TRANSPORT_FAILURE",
                  "response-received",
                ));
              });
              response.once("error", () => {
                rejectBounded(internalError(
                  "TRANSPORT_FAILURE",
                  "response-received",
                ));
              });
            },
          );
        } catch {
          rejectBounded(internalError(
            "TRANSPORT_FAILURE",
            "pre-dispatch",
          ));
          return;
        }
        request.signal.addEventListener("abort", abort, { once: true });
        req.once("close", () => {
          request.signal.removeEventListener("abort", abort);
        });
        req.once("error", () => rejectBounded(internalError(
          "TRANSPORT_FAILURE",
          failurePhase(),
        )));
        requestSubmitted = true;
        observeFailurePhase("possibly-dispatched");
        try {
          req.end(bodyBytes);
        } catch {
          const error = internalError(
            "TRANSPORT_FAILURE",
            "possibly-dispatched",
          );
          rejectBounded(error);
          destroyRequest(error);
        }
      });
    },
  });
}

export function createDirectAnthropicLiveCanaryTransportForTesting(
  requestFunction?: typeof httpsRequest,
): AnthropicLiveCanaryTransport {
  return directTransport(requestFunction);
}

function parseOptions(
  raw: AnthropicLiveCanaryOptions,
  directRequestFunction: typeof httpsRequest = httpsRequest,
): ParsedCanaryOptions {
  try {
    const input = ensureRecord(raw, "canary");
    ensureExactKeys(
      input,
      [
        "instanceId",
        "apiKeyRef",
        "retentionMode",
        "expectedCatalogFingerprint",
        "expectedAuthorizationReference",
        "broker",
        "preflight",
        "transport",
        "now",
      ],
      "canary",
    );
    const broker = input["broker"] as SecretBroker;
    const preflight = input["preflight"] as
      AnthropicLiveCanaryOptions["preflight"];
    const availabilityMethod = broker?.availability;
    const withSecretMethod = broker?.withSecret;
    const preflightMethod = preflight?.check;
    if (
      typeof availabilityMethod !== "function" ||
      typeof withSecretMethod !== "function" ||
      typeof preflightMethod !== "function"
    ) {
      fail("INVALID_CONFIGURATION");
    }
    const instanceId = ensureString(input["instanceId"], "canary.instanceId", {
      maxLength: 128,
      pattern: ID,
      patternName: "instance identifier",
    });
    const apiKeyRef = parseSecretRef(input["apiKeyRef"], "canary.apiKeyRef");
    if (
      apiKeyRef.expectedKind !== "text" ||
      (apiKeyRef.providerInstanceId !== null &&
        apiKeyRef.providerInstanceId !== instanceId)
    ) {
      fail("INVALID_CONFIGURATION");
    }
    const retentionMode = ensureEnum(
      input["retentionMode"],
      "canary.retentionMode",
      ["standard-30-day", "contracted-zero"] as const,
    );
    const expectedCatalogFingerprint = ensureString(
      input["expectedCatalogFingerprint"],
      "canary.expectedCatalogFingerprint",
      { maxLength: 64, pattern: SHA256, patternName: "catalog fingerprint" },
    );
    const expectedAuthorizationReference = ensureString(
      input["expectedAuthorizationReference"],
      "canary.expectedAuthorizationReference",
      { maxLength: 128, pattern: ID, patternName: "authorization reference" },
    );
    const configuredTransport = input["transport"] as
      AnthropicLiveCanaryTransport | undefined;
    const transport = configuredTransport === undefined
      ? directTransport(directRequestFunction)
      : configuredTransport;
    const transportKind = transport.kind;
    const transportMethod = transport.post;
    if (
      (configuredTransport !== undefined &&
        transportKind !== "deterministic-fake") ||
      typeof transportMethod !== "function"
    ) {
      fail("INVALID_CONFIGURATION");
    }
    const configuredClock = input["now"] as (() => Date) | undefined;
    if (configuredClock !== undefined && typeof configuredClock !== "function") {
      fail("INVALID_CONFIGURATION");
    }
    const capturedTransport = transport;
    const clockMethod = configuredClock ?? (() => new Date());
    return Object.freeze({
      instanceId,
      apiKeyRef,
      retentionMode,
      expectedCatalogFingerprint,
      expectedAuthorizationReference,
      availability: (ref: SecretRef, context: SecretAccessContext) =>
        Reflect.apply(availabilityMethod, broker, [ref, context]),
      withSecret: (<T>(
        ref: SecretRef,
        context: SecretAccessContext,
        callback: Parameters<SecretBroker["withSecret"]>[2],
      ): Promise<T> => Reflect.apply(withSecretMethod, broker, [
        ref,
        context,
        callback,
      ]) as Promise<T>) as SecretBroker["withSecret"],
      preflightCheck: (request: AnthropicLiveCanaryPreflightRequest) =>
        Reflect.apply(preflightMethod, preflight, [request]),
      transport: Object.freeze({
        kind: transportKind,
        trustedInternalErrors: configuredTransport === undefined,
        post: (
          request: AnthropicLiveCanaryTransportRequest,
          apiKey: string,
          observeFailurePhase?: FailurePhaseObserver,
        ) => Reflect.apply(
          transportMethod,
          capturedTransport,
          configuredTransport === undefined
            ? [request, apiKey, observeFailurePhase]
            : [request, apiKey],
        ),
      }),
      now: () => Reflect.apply(clockMethod, undefined, []),
    });
  } catch {
    fail("INVALID_CONFIGURATION");
  }
}

function readClock(options: ParsedCanaryOptions): number {
  try {
    const value = options.now();
    if (!(value instanceof Date)) {
      fail("INVALID_CONFIGURATION");
    }
    const milliseconds = Reflect.apply(DATE_VALUE_OF, value, []) as number;
    if (!Number.isFinite(milliseconds)) fail("INVALID_CONFIGURATION");
    return milliseconds;
  } catch {
    fail("INVALID_CONFIGURATION");
  }
}

function finiteDecision(
  value: unknown,
  options: ParsedCanaryOptions,
): AnthropicLiveCanaryPreflightDecision & { readonly decisionFingerprint: string } {
  try {
    const decision = ensureRecord(value, "canary.preflightDecision");
    ensureExactKeys(
      decision,
      [
        "allowed",
        "decisionFingerprint",
        "catalogFingerprint",
        "authorizationReference",
        "retentionMode",
      ],
      "canary.preflightDecision",
    );
    if (
      decision["allowed"] !== true ||
      decision["catalogFingerprint"] !== options.expectedCatalogFingerprint ||
      decision["authorizationReference"] !==
        options.expectedAuthorizationReference ||
      decision["retentionMode"] !== options.retentionMode
    ) {
      fail("PREFLIGHT_DENIED");
    }
    const decisionFingerprint = ensureString(
      decision["decisionFingerprint"],
      "canary.preflightDecision.decisionFingerprint",
      { maxLength: 64, pattern: SHA256, patternName: "decision fingerprint" },
    );
    return Object.freeze({
      allowed: true,
      decisionFingerprint,
      catalogFingerprint: options.expectedCatalogFingerprint,
      authorizationReference: options.expectedAuthorizationReference,
      retentionMode: options.retentionMode,
    });
  } catch {
    fail("PREFLIGHT_DENIED");
  }
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("RESPONSE_INVALID");
  }
  return value as number;
}

interface CanaryCallbackSuccess {
  readonly status: "success";
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

interface CanaryCallbackFailure {
  readonly status: "failure";
  readonly code: AnthropicLiveCanaryErrorCode;
  readonly failurePhase: AnthropicLiveCanaryFailurePhase;
}

type CanaryCallbackOutcome = CanaryCallbackSuccess | CanaryCallbackFailure;

function projectCallbackOutcome(value: unknown): CanaryCallbackOutcome | null {
  try {
    const outcome = ensureRecord(value, "canary.callbackOutcome");
    if (outcome["status"] === "failure") {
      ensureExactKeys(
        outcome,
        ["status", "code", "failurePhase"],
        "canary.callbackOutcome",
      );
      const code = ensureEnum(
        outcome["code"],
        "canary.callbackOutcome.code",
        ANTHROPIC_LIVE_CANARY_ERROR_CODES,
      );
      const failurePhase = ensureEnum(
        outcome["failurePhase"],
        "canary.callbackOutcome.failurePhase",
        ANTHROPIC_LIVE_CANARY_FAILURE_PHASES,
      );
      return Object.freeze({ status: "failure", code, failurePhase });
    }
    ensureExactKeys(
      outcome,
      ["status", "usage"],
      "canary.callbackOutcome",
    );
    if (outcome["status"] !== "success") throw new Error("invalid outcome");
    const usage = ensureRecord(outcome["usage"], "canary.callbackOutcome.usage");
    ensureExactKeys(
      usage,
      ["inputTokens", "outputTokens"],
      "canary.callbackOutcome.usage",
    );
    const inputTokens = safeInteger(usage["inputTokens"]);
    const outputTokens = safeInteger(usage["outputTokens"]);
    if (
      inputTokens > 256 ||
      outputTokens > ANTHROPIC_LIVE_CANARY_MAX_TOKENS
    ) {
      throw new Error("invalid usage");
    }
    return Object.freeze({
      status: "success",
      usage: Object.freeze({ inputTokens, outputTokens }),
    });
  } catch {
    return null;
  }
}

function callbackOutcomesEqual(
  left: CanaryCallbackOutcome,
  right: CanaryCallbackOutcome,
): boolean {
  if (left.status !== right.status) return false;
  if (left.status === "failure" && right.status === "failure") {
    return left.code === right.code && left.failurePhase === right.failurePhase;
  }
  if (left.status === "success" && right.status === "success") {
    return left.usage.inputTokens === right.usage.inputTokens &&
      left.usage.outputTokens === right.usage.outputTokens;
  }
  return false;
}

function failureOutcome(
  code: AnthropicLiveCanaryErrorCode,
  failurePhase: AnthropicLiveCanaryFailurePhase,
): CanaryCallbackFailure {
  return Object.freeze({ status: "failure", code, failurePhase });
}

function callbackFailure(
  error: unknown,
  fallbackCode: AnthropicLiveCanaryErrorCode,
  fallbackPhase: AnthropicLiveCanaryFailurePhase,
  trustInternalError = false,
): CanaryCallbackFailure {
  try {
    if (!trustInternalError || !isInternalError(error)) {
      throw new Error("untrusted");
    }
    const code = Object.getOwnPropertyDescriptor(error, "code");
    const phase = Object.getOwnPropertyDescriptor(error, "failurePhase");
    if (
      code === undefined ||
      !("value" in code) ||
      !ANTHROPIC_LIVE_CANARY_ERROR_CODES.includes(
        code.value as AnthropicLiveCanaryErrorCode,
      ) ||
      phase === undefined ||
      !("value" in phase) ||
      !ANTHROPIC_LIVE_CANARY_FAILURE_PHASES.includes(
        phase.value as AnthropicLiveCanaryFailurePhase,
      )
    ) {
      throw new Error("untrusted");
    }
    return Object.freeze({
      status: "failure" as const,
      code: code.value as AnthropicLiveCanaryErrorCode,
      failurePhase: phase.value as AnthropicLiveCanaryFailurePhase,
    });
  } catch {
    return Object.freeze({
      status: "failure" as const,
      code: fallbackCode,
      failurePhase: fallbackPhase,
    });
  }
}

function finiteAvailability(value: unknown): boolean {
  try {
    const availability = ensureRecord(value, "canary.availability");
    ensureExactKeys(
      availability,
      ["available", "reason", "audit"],
      "canary.availability",
    );
    const available = availability["available"];
    const reason = availability["reason"];
    if (
      Object.keys(availability).length !== 3 ||
      typeof available !== "boolean" ||
      ![
        "available",
        "not-found",
        "revoked",
        "version-unavailable",
        "unavailable",
      ].includes(reason as string)
    ) {
      fail("SECRET_UNAVAILABLE", "pre-dispatch");
    }
    return available === true && reason === "available";
  } catch {
    fail("SECRET_UNAVAILABLE", "pre-dispatch");
  }
}

const CALLBACK_DRAIN_EXPIRED = Object.freeze({
  kind: "callback-drain-expired",
});

interface CallbackDrain {
  wait<T>(promise: Promise<T>): Promise<T>;
  close(): void;
}

function createCallbackDrain(signal: AbortSignal): CallbackDrain {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let rejectExpiry!: (reason: unknown) => void;
  const expiry = new Promise<never>((_resolve, reject) => {
    rejectExpiry = reject;
  });
  const begin = (): void => {
    if (closed || timer !== null) return;
    timer = setTimeout(
      () => rejectExpiry(CALLBACK_DRAIN_EXPIRED),
      ANTHROPIC_LIVE_CANARY_CALLBACK_DRAIN_MS,
    );
  };
  signal.addEventListener("abort", begin, { once: true });
  if (signal.aborted) begin();
  return Object.freeze({
    wait<T>(promise: Promise<T>): Promise<T> {
      return Promise.race([promise, expiry]);
    },
    close(): void {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", begin);
      if (timer !== null) clearTimeout(timer);
    },
  });
}

async function exactOutcomeBoundary<T>(
  invoke: (
    callback: (value: T) => Promise<CanaryCallbackOutcome>,
  ) => unknown,
  consume: (value: T) => Promise<CanaryCallbackOutcome>,
  controller: AbortController,
  drain: CallbackDrain,
  phase: () => AnthropicLiveCanaryFailurePhase,
  beforeCallbackFailureCode: AnthropicLiveCanaryErrorCode,
): Promise<CanaryCallbackOutcome> {
  let callbackOpen = true;
  let callbackCount = 0;
  let capturedOutcome: CanaryCallbackOutcome | null = null;
  let callbackCompletion: Promise<CanaryCallbackOutcome> | null = null;
  let sequence = 0;
  let callbackSettlementOrder = 0;
  let invocationSettlementOrder = 0;

  const callback = (value: T): Promise<CanaryCallbackOutcome> => {
    callbackCount += 1;
    if (!callbackOpen || callbackCount !== 1) {
      return Promise.resolve(failureOutcome(
        "CALLBACK_RESULT_FAILURE",
        phase(),
      ));
    }
    const completion = (async (): Promise<CanaryCallbackOutcome> => {
      let outcome: CanaryCallbackOutcome;
      try {
        const consumed = await consume(value);
        outcome = projectCallbackOutcome(consumed) ?? failureOutcome(
          "CALLBACK_RESULT_FAILURE",
          phase(),
        );
      } catch {
        outcome = failureOutcome("CALLBACK_RESULT_FAILURE", phase());
      }
      capturedOutcome = outcome;
      return outcome;
    })();
    callbackCompletion = completion;
    void completion.then(
      () => { callbackSettlementOrder = ++sequence; },
      () => { callbackSettlementOrder = ++sequence; },
    );
    return completion;
  };

  let rawResult: unknown;
  let invocationError: unknown;
  let invocationFailed = false;
  try {
    const invocation = Promise.resolve(invoke(callback)).then(
      (value) => {
        invocationSettlementOrder = ++sequence;
        return value;
      },
      (error: unknown) => {
        invocationSettlementOrder = ++sequence;
        throw error;
      },
    );
    rawResult = await drain.wait(invocation);
  } catch (error) {
    invocationFailed = true;
    invocationError = error;
  } finally {
    callbackOpen = false;
  }

  const completion = callbackCompletion as
    Promise<CanaryCallbackOutcome> | null;
  if (
    completion !== null &&
    callbackCount > 0 &&
    (callbackSettlementOrder === 0 ||
      (invocationSettlementOrder !== 0 &&
        invocationSettlementOrder < callbackSettlementOrder))
  ) {
    controller.abort();
    try {
      await drain.wait(completion);
    } catch {
      // The single shared drain ceiling is authoritative.
    }
    fail("CALLBACK_RESULT_FAILURE", phase());
  }

  if (invocationFailed) {
    if (invocationError === CALLBACK_DRAIN_EXPIRED) {
      fail("CALLBACK_RESULT_FAILURE", phase());
    }
    if (controller.signal.aborted) fail("TIMEOUT", phase());
    fail(
      callbackCount > 0
        ? "CALLBACK_RESULT_FAILURE"
        : beforeCallbackFailureCode,
      phase(),
    );
  }

  const observedOutcome = capturedOutcome as CanaryCallbackOutcome | null;
  const returnedOutcome = projectCallbackOutcome(rawResult);
  if (
    callbackCount !== 1 ||
    observedOutcome === null ||
    returnedOutcome === null ||
    !callbackOutcomesEqual(observedOutcome, returnedOutcome)
  ) {
    fail("CALLBACK_RESULT_FAILURE", phase());
  }
  return observedOutcome;
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  phase: AnthropicLiveCanaryFailurePhase | (() => AnthropicLiveCanaryFailurePhase),
): Promise<T> {
  const failurePhase = (): AnthropicLiveCanaryFailurePhase =>
    typeof phase === "function" ? phase() : phase;
  if (signal.aborted) {
    return Promise.reject(internalError(
      "TIMEOUT",
      failurePhase(),
    ));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(internalError(
      "TIMEOUT",
      failurePhase(),
    ));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function projectTransportResponse(
  value: unknown,
): AnthropicLiveCanaryTransportResponse {
  try {
    const response = ensureRecord(value, "canary.transportResponse");
    ensureExactKeys(
      response,
      ["status", "contentType", "body"],
      "canary.transportResponse",
    );
    const status = response["status"];
    const contentType = response["contentType"];
    const body = response["body"];
    if (
      Object.keys(response).length !== 3 ||
      !Number.isSafeInteger(status) ||
      status !== 200 ||
      typeof contentType !== "string" ||
      !contentType.toLowerCase().startsWith("application/json") ||
      !(body instanceof Uint8Array)
    ) {
      fail("TRANSPORT_FAILURE", "response-received");
    }
    const bodyLength = byteLength(body);
    if (
      bodyLength < 2 ||
      bodyLength > ANTHROPIC_LIVE_CANARY_MAX_RESPONSE_BYTES
    ) {
      fail("TRANSPORT_FAILURE", "response-received");
    }
    return Object.freeze({
      status: status as number,
      contentType,
      body,
    });
  } catch {
    fail("TRANSPORT_FAILURE", "response-received");
  }
}

function zeroResponseBody(value: unknown): void {
  try {
    if (value instanceof Uint8Array) {
      zeroBytes(value);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const descriptor = Object.getOwnPropertyDescriptor(value, "body");
    const body = descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : null;
    if (body instanceof Uint8Array) zeroBytes(body);
  } catch {
    // A hostile response shape cannot widen the fixed cleanup boundary.
  }
}

function parseResponse(
  value: unknown,
): { readonly inputTokens: number; readonly outputTokens: number } {
  const response = projectTransportResponse(value);
  const body = response.body;
  try {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      fail("RESPONSE_INVALID", "response-received");
    }
    try {
      const message = ensureRecord(value, "canary.response");
      if (
        message["type"] !== "message" ||
        message["role"] !== "assistant" ||
        message["model"] !== ANTHROPIC_LIVE_CANARY_MODEL ||
        !Array.isArray(message["content"]) ||
        message["content"].length !== 1
      ) {
        fail("RESPONSE_INVALID", "response-received");
      }
      const block = ensureRecord(message["content"][0], "canary.response.content[0]");
      if (
        block["type"] !== "text" ||
        typeof block["text"] !== "string" ||
        block["text"].length > 32 ||
        block["text"] !== "OK"
      ) {
        fail("RESPONSE_INVALID", "response-received");
      }
      const usage = ensureRecord(message["usage"], "canary.response.usage");
      const inputTokens = safeInteger(usage["input_tokens"]);
      const outputTokens = safeInteger(usage["output_tokens"]);
      if (inputTokens > 256 || outputTokens > ANTHROPIC_LIVE_CANARY_MAX_TOKENS) {
        fail("RESPONSE_INVALID", "response-received");
      }
      return Object.freeze({ inputTokens, outputTokens });
    } catch (error) {
      if (isInternalError(error)) throw error;
      fail("RESPONSE_INVALID", "response-received");
    }
  } finally {
    if (body instanceof Uint8Array) {
      zeroBytes(body);
    }
  }
  fail("RESPONSE_INVALID", "response-received");
}

function accessContext(
  options: ParsedCanaryOptions,
  decisionFingerprint: string,
  signal: AbortSignal,
): SecretAccessContext {
  return Object.freeze({
    operationId: "anthropic-live-canary-v1",
    providerInstanceId: options.instanceId,
    purpose: "provider-authentication",
    requestedLifetimeMs: ANTHROPIC_LIVE_CANARY_TIMEOUT_MS,
    accessForm: "text",
    classification: "public",
    projectId: null,
    taskId: null,
    approvalEvidenceRefs: Object.freeze([
      options.expectedAuthorizationReference,
    ]),
    disclosureDecisionFingerprint: decisionFingerprint,
    locality: "cloud",
    trace: createTrace("trace:anthropic-live-canary-v1"),
    deadline: null,
    signal,
  });
}

type AnthropicLiveCanaryRunner = {
  run(optIn: string): Promise<AnthropicLiveCanaryResult>;
};

function createAnthropicLiveCanaryInternal(
  raw: AnthropicLiveCanaryOptions,
  directRequestFunction?: typeof httpsRequest,
): AnthropicLiveCanaryRunner {
  const options = parseOptions(raw, directRequestFunction);
  const fixedBody = JSON.stringify({
    model: ANTHROPIC_LIVE_CANARY_MODEL,
    max_tokens: ANTHROPIC_LIVE_CANARY_MAX_TOKENS,
    messages: [{ role: "user", content: FIXED_PROMPT }],
  });
  const requestFingerprint = createHash("sha256")
    .update(fixedBody)
    .digest("hex");
  let attempted = false;

  return Object.freeze({
    async run(optIn: string): Promise<AnthropicLiveCanaryResult> {
      if (optIn !== ANTHROPIC_LIVE_CANARY_OPT_IN) fail("NOT_OPTED_IN");
      if (attempted) fail("ALREADY_ATTEMPTED");
      attempted = true;
      const started = readClock(options);
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        ANTHROPIC_LIVE_CANARY_TIMEOUT_MS,
      );
      const callbackDrain = createCallbackDrain(controller.signal);
      let failurePhase: AnthropicLiveCanaryFailurePhase = "pre-dispatch";
      const advanceFailurePhase = (
        next: AnthropicLiveCanaryFailurePhase,
      ): void => {
        if (
          ANTHROPIC_LIVE_CANARY_FAILURE_PHASES.indexOf(next) >
          ANTHROPIC_LIVE_CANARY_FAILURE_PHASES.indexOf(failurePhase)
        ) {
          failurePhase = next;
        }
      };
      let callbackBoundaryEntered = false;
      try {
        let preflightResult: unknown;
        try {
          preflightResult = await abortable(options.preflightCheck(Object.freeze({
            endpoint: ANTHROPIC_MESSAGES_ENDPOINT,
            apiVersion: ANTHROPIC_API_VERSION,
            modelId: ANTHROPIC_LIVE_CANARY_MODEL,
            retentionMode: options.retentionMode,
            catalogFingerprint: options.expectedCatalogFingerprint,
            authorizationReference: options.expectedAuthorizationReference,
            requestFingerprint,
            signal: controller.signal,
          })), controller.signal, "pre-dispatch");
        } catch {
          if (controller.signal.aborted) fail("TIMEOUT", "pre-dispatch");
          fail("PREFLIGHT_DENIED", "pre-dispatch");
        }
        const decision = finiteDecision(preflightResult, options);
        if (controller.signal.aborted) fail("TIMEOUT", "pre-dispatch");
        const context = accessContext(
          options,
          decision.decisionFingerprint,
          controller.signal,
        );
        let availability: unknown;
        try {
          availability = await abortable(options.availability(
            options.apiKeyRef,
            context,
          ), controller.signal, "pre-dispatch");
        } catch {
          if (controller.signal.aborted) fail("TIMEOUT", "pre-dispatch");
          fail("SECRET_UNAVAILABLE", "pre-dispatch");
        }
        if (controller.signal.aborted) fail("TIMEOUT", "pre-dispatch");
        if (!finiteAvailability(availability)) {
          fail("SECRET_UNAVAILABLE", "pre-dispatch");
        }
        callbackBoundaryEntered = true;
        const callbackOutcome = await exactOutcomeBoundary<SecretMaterial>(
          (callback) => options.withSecret(
            options.apiKeyRef,
            context,
            callback,
          ),
          async (secret): Promise<CanaryCallbackOutcome> => {
            let useTextMethod: SecretMaterial["useText"];
            try {
              if (secret.kind !== "text") {
                return failureOutcome(
                  "SECRET_UNAVAILABLE",
                  "pre-dispatch",
                );
              }
              useTextMethod = secret.useText;
              if (typeof useTextMethod !== "function") {
                return failureOutcome(
                  "CALLBACK_RESULT_FAILURE",
                  failurePhase,
                );
              }
            } catch {
              return failureOutcome(
                "CALLBACK_RESULT_FAILURE",
                failurePhase,
              );
            }
            return exactOutcomeBoundary<string>(
              (callback) => Reflect.apply(useTextMethod, secret, [callback]),
              async (apiKey): Promise<CanaryCallbackOutcome> => {
                if (controller.signal.aborted) {
                  return failureOutcome("TIMEOUT", failurePhase);
                }
                if (
                  typeof apiKey !== "string" ||
                  apiKey.length < 1 ||
                  apiKey.length > 4096
                ) {
                  return failureOutcome(
                    "SECRET_UNAVAILABLE",
                    "pre-dispatch",
                  );
                }
                if (!options.transport.trustedInternalErrors) {
                  advanceFailurePhase("possibly-dispatched");
                }
                let response: AnthropicLiveCanaryTransportResponse;
                try {
                  response = await options.transport.post(
                    Object.freeze({
                      endpoint: ANTHROPIC_MESSAGES_ENDPOINT,
                      apiVersion: ANTHROPIC_API_VERSION,
                      modelId: ANTHROPIC_LIVE_CANARY_MODEL,
                      body: fixedBody,
                      maximumResponseBytes:
                        ANTHROPIC_LIVE_CANARY_MAX_RESPONSE_BYTES,
                      signal: controller.signal,
                    }),
                    apiKey,
                    advanceFailurePhase,
                  );
                } catch (error) {
                  zeroResponseBody(error);
                  return callbackFailure(
                    error,
                    "TRANSPORT_FAILURE",
                    failurePhase,
                    options.transport.trustedInternalErrors,
                  );
                }
                advanceFailurePhase("response-received");
                try {
                  if (controller.signal.aborted) {
                    fail("TIMEOUT", "response-received");
                  }
                  const usage = parseResponse(response);
                  advanceFailurePhase("post-response");
                  return Object.freeze({
                    status: "success" as const,
                    usage,
                  });
                } catch (error) {
                  return callbackFailure(
                    error,
                    "RESPONSE_INVALID",
                    failurePhase,
                    true,
                  );
                } finally {
                  zeroResponseBody(response);
                }
              },
              controller,
              callbackDrain,
              () => failurePhase,
              "CALLBACK_RESULT_FAILURE",
            );
          },
          controller,
          callbackDrain,
          () => failurePhase,
          "SECRET_UNAVAILABLE",
        );
        if (callbackOutcome.status === "failure") {
          fail(callbackOutcome.code, callbackOutcome.failurePhase);
        }
        const usage = callbackOutcome.usage;
        let finished: number;
        try {
          finished = readClock(options);
        } catch {
          fail("CALLBACK_RESULT_FAILURE", "post-response");
        }
        if (finished < started) {
          fail("CALLBACK_RESULT_FAILURE", "post-response");
        }
        if (finished - started >= ANTHROPIC_LIVE_CANARY_TIMEOUT_MS) {
          fail("TIMEOUT", "post-response");
        }
        return Object.freeze({
          schemaVersion: 1 as const,
          endpoint: ANTHROPIC_MESSAGES_ENDPOINT,
          apiVersion: ANTHROPIC_API_VERSION,
          modelId: ANTHROPIC_LIVE_CANARY_MODEL,
          retentionMode: options.retentionMode,
          statusCategory: "success" as const,
          transportKind: options.transport.kind,
          durationMs: Math.round(finished - started),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          modelSubstitutionRejected: true as const,
          fixedRequestBody: true as const,
          repositorySourcePresent: false as const,
          credentialRetained: false as const,
          responseBodyRetained: false as const,
          requestFingerprint,
          policyDecisionFingerprint: decision.decisionFingerprint,
        });
      } catch (error) {
        if (isInternalError(error)) throw error;
        if (controller.signal.aborted) fail("TIMEOUT", failurePhase);
        if (callbackBoundaryEntered) {
          fail("CALLBACK_RESULT_FAILURE", failurePhase);
        }
        fail("TRANSPORT_FAILURE", failurePhase);
      } finally {
        clearTimeout(timer);
        callbackDrain.close();
      }
    },
  });
}

export function createAnthropicLiveCanary(
  raw: AnthropicLiveCanaryOptions,
): AnthropicLiveCanaryRunner {
  return createAnthropicLiveCanaryInternal(raw);
}

export function createAnthropicLiveCanaryWithDirectTransportForTesting(
  raw: AnthropicLiveCanaryOptions,
  requestFunction: typeof httpsRequest,
): AnthropicLiveCanaryRunner {
  return createAnthropicLiveCanaryInternal(raw, requestFunction);
}
