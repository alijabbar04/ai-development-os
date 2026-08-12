import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { validation } from "@ai-dev-os/domain";
import { createTrace } from "@ai-dev-os/providers";
import {
  parseSecretRef,
  type SecretAccessContext,
  type SecretBroker,
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

const FIXED_PROMPT = "Reply with exactly OK.";
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const ANTHROPIC_LIVE_CANARY_ERROR_CODES = Object.freeze([
  "NOT_OPTED_IN",
  "ALREADY_ATTEMPTED",
  "INVALID_CONFIGURATION",
  "PREFLIGHT_DENIED",
  "SECRET_UNAVAILABLE",
  "TRANSPORT_FAILURE",
  "TIMEOUT",
  "RESPONSE_INVALID",
] as const);
export type AnthropicLiveCanaryErrorCode =
  (typeof ANTHROPIC_LIVE_CANARY_ERROR_CODES)[number];

const MESSAGES: Record<AnthropicLiveCanaryErrorCode, string> = Object.freeze({
  NOT_OPTED_IN: "The Anthropic live canary was not explicitly enabled.",
  ALREADY_ATTEMPTED: "The Anthropic live canary permits only one attempt.",
  INVALID_CONFIGURATION: "The Anthropic live canary configuration is invalid.",
  PREFLIGHT_DENIED: "The Anthropic live canary preflight was denied.",
  SECRET_UNAVAILABLE: "The scoped Anthropic credential is unavailable.",
  TRANSPORT_FAILURE: "The Anthropic live canary transport failed.",
  TIMEOUT: "The Anthropic live canary exceeded its wall-time bound.",
  RESPONSE_INVALID: "The Anthropic live canary response was invalid.",
});

export class AnthropicLiveCanaryError extends Error {
  readonly code: AnthropicLiveCanaryErrorCode;

  constructor(code: AnthropicLiveCanaryErrorCode) {
    super(MESSAGES[code]);
    this.name = "AnthropicLiveCanaryError";
    this.code = code;
  }

  toJSON(): object {
    return { name: this.name, code: this.code, message: this.message };
  }
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
  readonly transport: AnthropicLiveCanaryTransport;
  readonly now: () => Date;
}

function fail(code: AnthropicLiveCanaryErrorCode): never {
  throw new AnthropicLiveCanaryError(code);
}

function directTransport(
  requestFunction: typeof httpsRequest = httpsRequest,
): AnthropicLiveCanaryTransport {
  return Object.freeze({
    kind: "direct-anthropic-https" as const,
    post(
      request: AnthropicLiveCanaryTransportRequest,
      apiKey: string,
    ): Promise<AnthropicLiveCanaryTransportResponse> {
      return new Promise((resolve, reject) => {
        if (request.signal.aborted) {
          reject(new AnthropicLiveCanaryError("TIMEOUT"));
          return;
        }
        const bodyBytes = Buffer.from(request.body, "utf8");
        const responseBytes = Buffer.alloc(request.maximumResponseBytes);
        let settled = false;
        let req: ReturnType<typeof httpsRequest>;
        const rejectBounded = (error: unknown): void => {
          if (settled) return;
          settled = true;
          responseBytes.fill(0);
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
        const abort = (): void => {
          const error = new AnthropicLiveCanaryError("TIMEOUT");
          rejectBounded(error);
          req.destroy(error);
        };
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
                  const error = new AnthropicLiveCanaryError("RESPONSE_INVALID");
                  rejectBounded(error);
                  req.destroy(error);
                  return;
                }
                chunk.copy(responseBytes, bytes);
                bytes += chunk.byteLength;
              } finally {
                chunk.fill(0);
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
              rejectBounded(new AnthropicLiveCanaryError("TRANSPORT_FAILURE"));
            });
            response.once("error", () => {
              rejectBounded(new AnthropicLiveCanaryError("TRANSPORT_FAILURE"));
            });
          },
        );
        request.signal.addEventListener("abort", abort, { once: true });
        req.once("close", () => {
          request.signal.removeEventListener("abort", abort);
        });
        req.once("error", rejectBounded);
        req.end(bodyBytes);
      });
    },
  });
}

export function createDirectAnthropicLiveCanaryTransportForTesting(
  requestFunction?: typeof httpsRequest,
): AnthropicLiveCanaryTransport {
  return directTransport(requestFunction);
}

function parseOptions(raw: AnthropicLiveCanaryOptions): ParsedCanaryOptions {
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
    if (
      raw === null ||
      typeof raw !== "object" ||
      typeof raw.broker?.availability !== "function" ||
      typeof raw.broker?.withSecret !== "function" ||
      typeof raw.preflight?.check !== "function"
    ) {
      fail("INVALID_CONFIGURATION");
    }
    const instanceId = ensureString(raw.instanceId, "canary.instanceId", {
      maxLength: 128,
      pattern: ID,
      patternName: "instance identifier",
    });
    const apiKeyRef = parseSecretRef(raw.apiKeyRef, "canary.apiKeyRef");
    if (
      apiKeyRef.expectedKind !== "text" ||
      (apiKeyRef.providerInstanceId !== null &&
        apiKeyRef.providerInstanceId !== instanceId)
    ) {
      fail("INVALID_CONFIGURATION");
    }
    const retentionMode = ensureEnum(
      raw.retentionMode,
      "canary.retentionMode",
      ["standard-30-day", "contracted-zero"] as const,
    );
    const expectedCatalogFingerprint = ensureString(
      raw.expectedCatalogFingerprint,
      "canary.expectedCatalogFingerprint",
      { maxLength: 64, pattern: SHA256, patternName: "catalog fingerprint" },
    );
    const expectedAuthorizationReference = ensureString(
      raw.expectedAuthorizationReference,
      "canary.expectedAuthorizationReference",
      { maxLength: 128, pattern: ID, patternName: "authorization reference" },
    );
    const transport = raw.transport === undefined
      ? directTransport()
      : raw.transport;
    if (
      (raw.transport !== undefined && transport.kind !== "deterministic-fake") ||
      typeof transport.post !== "function"
    ) {
      fail("INVALID_CONFIGURATION");
    }
    if (raw.now !== undefined && typeof raw.now !== "function") {
      fail("INVALID_CONFIGURATION");
    }
    const broker = raw.broker;
    const preflight = raw.preflight;
    const capturedTransport = transport;
    return Object.freeze({
      instanceId,
      apiKeyRef,
      retentionMode,
      expectedCatalogFingerprint,
      expectedAuthorizationReference,
      availability: broker.availability.bind(broker),
      withSecret: broker.withSecret.bind(broker) as SecretBroker["withSecret"],
      preflightCheck: preflight.check.bind(preflight),
      transport: Object.freeze({
        kind: capturedTransport.kind,
        post: capturedTransport.post.bind(capturedTransport),
      }),
      now: raw.now ?? (() => new Date()),
    });
  } catch (error) {
    if (error instanceof AnthropicLiveCanaryError) throw error;
    fail("INVALID_CONFIGURATION");
  }
}

function readClock(options: ParsedCanaryOptions): number {
  try {
    const value = options.now();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
      fail("INVALID_CONFIGURATION");
    }
    return value.valueOf();
  } catch (error) {
    if (error instanceof AnthropicLiveCanaryError) throw error;
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
  } catch (error) {
    if (error instanceof AnthropicLiveCanaryError) throw error;
    fail("PREFLIGHT_DENIED");
  }
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("RESPONSE_INVALID");
  }
  return value as number;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AnthropicLiveCanaryError("TIMEOUT"));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new AnthropicLiveCanaryError("TIMEOUT"));
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

function parseResponse(
  response: AnthropicLiveCanaryTransportResponse,
): { readonly inputTokens: number; readonly outputTokens: number } {
  const body = response.body;
  try {
    if (
      !Number.isSafeInteger(response.status) ||
      response.status !== 200 ||
      response.contentType === null ||
      !response.contentType.toLowerCase().startsWith("application/json") ||
      !(body instanceof Uint8Array) ||
      body.byteLength < 2 ||
      body.byteLength > ANTHROPIC_LIVE_CANARY_MAX_RESPONSE_BYTES
    ) {
      fail("TRANSPORT_FAILURE");
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      fail("RESPONSE_INVALID");
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
        fail("RESPONSE_INVALID");
      }
      const block = ensureRecord(message["content"][0], "canary.response.content[0]");
      if (
        block["type"] !== "text" ||
        typeof block["text"] !== "string" ||
        block["text"].length > 32 ||
        block["text"] !== "OK"
      ) {
        fail("RESPONSE_INVALID");
      }
      const usage = ensureRecord(message["usage"], "canary.response.usage");
      const inputTokens = safeInteger(usage["input_tokens"]);
      const outputTokens = safeInteger(usage["output_tokens"]);
      if (inputTokens > 256 || outputTokens > ANTHROPIC_LIVE_CANARY_MAX_TOKENS) {
        fail("RESPONSE_INVALID");
      }
      return Object.freeze({ inputTokens, outputTokens });
    } catch (error) {
      if (error instanceof AnthropicLiveCanaryError) throw error;
      fail("RESPONSE_INVALID");
    }
  } finally {
    if (body instanceof Uint8Array) {
      body.fill(0);
    }
  }
  fail("RESPONSE_INVALID");
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

export function createAnthropicLiveCanary(raw: AnthropicLiveCanaryOptions): {
  run(optIn: string): Promise<AnthropicLiveCanaryResult>;
} {
  const options = parseOptions(raw);
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
      try {
        const decision = finiteDecision(
          await abortable(options.preflightCheck(Object.freeze({
            endpoint: ANTHROPIC_MESSAGES_ENDPOINT,
            apiVersion: ANTHROPIC_API_VERSION,
            modelId: ANTHROPIC_LIVE_CANARY_MODEL,
            retentionMode: options.retentionMode,
            catalogFingerprint: options.expectedCatalogFingerprint,
            authorizationReference: options.expectedAuthorizationReference,
            requestFingerprint,
            signal: controller.signal,
          })), controller.signal),
          options,
        );
        if (controller.signal.aborted) fail("TIMEOUT");
        const context = accessContext(
          options,
          decision.decisionFingerprint,
          controller.signal,
        );
        const availability = await abortable(options.availability(
          options.apiKeyRef,
          context,
        ), controller.signal);
        if (controller.signal.aborted) fail("TIMEOUT");
        if (!availability.available || availability.reason !== "available") {
          fail("SECRET_UNAVAILABLE");
        }
        const usage = await abortable(options.withSecret(
          options.apiKeyRef,
          context,
          (secret) =>
            secret.useText(async (apiKey) => {
              if (controller.signal.aborted) fail("TIMEOUT");
              if (apiKey.length < 1 || apiKey.length > 4096) {
                fail("SECRET_UNAVAILABLE");
              }
              const response = await options.transport.post(
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
              );
              try {
                if (controller.signal.aborted) fail("TIMEOUT");
                return parseResponse(response);
              } finally {
                if (response.body instanceof Uint8Array) response.body.fill(0);
              }
            }),
        ), controller.signal);
        const finished = readClock(options);
        if (finished < started) {
          fail("INVALID_CONFIGURATION");
        }
        if (finished - started >= ANTHROPIC_LIVE_CANARY_TIMEOUT_MS) {
          fail("TIMEOUT");
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
        if (error instanceof AnthropicLiveCanaryError) throw error;
        if (controller.signal.aborted) fail("TIMEOUT");
        fail("TRANSPORT_FAILURE");
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
