import { request as httpRequest } from "node:http";
import { parseSuccessEnvelope, type SuccessEnvelope } from "@ai-dev-os/api";
import { canonicalizeJson, type JsonValue } from "@ai-dev-os/domain";
import type { ControlArtifactStore } from "./artifacts.js";
import type { ConnectionDescriptor } from "./contracts.js";
import { ControlServiceError, controlFail } from "./errors.js";
import { CONTROL_HOST, START_NONCE_PATTERN } from "./identity.js";
import { exactString, readExactRecord } from "./structural.js";

export const ADOPTION_RESPONSE_LIMIT = 8_192;
export const ADOPTION_TIMEOUT_MS = 1_000;

export interface AdoptionTransportResponse {
  readonly statusCode: number;
  readonly contentType: string;
  readonly body: Uint8Array;
}

export interface AdoptionTransport {
  get(request: Readonly<{
    port: number;
    path: "/v1/health" | "/v1/session";
    bearerToken?: string;
    timeoutMs: number;
  }>): Promise<AdoptionTransportResponse>;
}

function exactJsonMediaType(value: string): boolean {
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

export function createLoopbackAdoptionTransport(): AdoptionTransport {
  return Object.freeze({
    async get(input: Readonly<{
      port: number;
      path: "/v1/health" | "/v1/session";
      bearerToken?: string;
      timeoutMs: number;
    }>) {
      return await new Promise<AdoptionTransportResponse>((resolve, reject) => {
        const headers: Record<string, string> = { accept: "application/json" };
        if (input.bearerToken !== undefined) headers["authorization"] = `Bearer ${input.bearerToken}`;
        const request = httpRequest({
          method: "GET",
          host: CONTROL_HOST,
          port: input.port,
          path: input.path,
          headers,
          timeout: input.timeoutMs,
          agent: false,
        }, (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on("data", (chunk: Buffer) => {
            length += chunk.byteLength;
            if (length > ADOPTION_RESPONSE_LIMIT) {
              request.destroy(new ControlServiceError("ADOPTION_REFUSED"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => resolve(Object.freeze({
            statusCode: response.statusCode ?? 0,
            contentType: typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : "",
            body: Buffer.concat(chunks),
          })));
        });
        request.once("timeout", () => request.destroy(new ControlServiceError("ADOPTION_TIMEOUT")));
        request.once("error", reject);
        request.end();
      });
    },
  });
}

function parseResponse<T extends JsonValue>(response: AdoptionTransportResponse, payloadParser: (value: unknown) => T): SuccessEnvelope<T> {
  if (response.statusCode !== 200 || !exactJsonMediaType(response.contentType) || response.body.byteLength > ADOPTION_RESPONSE_LIMIT) {
    controlFail("ADOPTION_REFUSED");
  }
  let document: unknown;
  try { document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)) as unknown; }
  catch { controlFail("ADOPTION_REFUSED"); }
  try {
    return parseSuccessEnvelope(document, (value) => canonicalizeJson(payloadParser(value), "payload") as T);
  } catch {
    controlFail("ADOPTION_REFUSED");
  }
}

function healthPayload(value: unknown): JsonValue {
  const record = readExactRecord(value, ["serviceVersion", "startNonce", "ready"]);
  if (record["ready"] !== true) controlFail("ADOPTION_REFUSED");
  return Object.freeze({
    serviceVersion: exactString(record["serviceVersion"], /^\d+\.\d+\.\d+$/u, 32),
    startNonce: exactString(record["startNonce"], START_NONCE_PATTERN, 32),
    ready: true,
  });
}

function sessionPayload(value: unknown): JsonValue {
  const record = readExactRecord(value, ["serviceVersion", "startNonce", "state"]);
  if (record["state"] !== "active") controlFail("ADOPTION_REFUSED");
  return Object.freeze({
    serviceVersion: exactString(record["serviceVersion"], /^\d+\.\d+\.\d+$/u, 32),
    startNonce: exactString(record["startNonce"], START_NONCE_PATTERN, 32),
    state: "active",
  });
}

export async function adoptExistingControlService(options: Readonly<{
  store: ControlArtifactStore;
  transport?: AdoptionTransport;
  timeoutMs?: number;
}>): Promise<ConnectionDescriptor> {
  const descriptor = (await options.store.readDescriptor()).value;
  const transport = options.transport ?? createLoopbackAdoptionTransport();
  const timeoutMs = options.timeoutMs ?? ADOPTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 5_000) controlFail("ADOPTION_REFUSED");
  try {
    const probe = parseResponse(await transport.get({
      port: descriptor.port,
      path: "/v1/health",
      timeoutMs,
    }), healthPayload);
    const payload = probe.payload as Record<string, JsonValue>;
    if (payload["startNonce"] !== descriptor.startNonce || payload["serviceVersion"] !== descriptor.serviceVersion) {
      controlFail("ADOPTION_REFUSED");
    }
    const session = parseResponse(await transport.get({
      port: descriptor.port,
      path: "/v1/session",
      bearerToken: descriptor.bearerToken,
      timeoutMs,
    }), sessionPayload);
    const sessionRecord = session.payload as Record<string, JsonValue>;
    if (sessionRecord["startNonce"] !== descriptor.startNonce || sessionRecord["serviceVersion"] !== descriptor.serviceVersion) {
      controlFail("ADOPTION_REFUSED");
    }
    return descriptor;
  } catch (error) {
    if (error instanceof ControlServiceError) throw error;
    controlFail("ADOPTION_REFUSED");
  }
}
