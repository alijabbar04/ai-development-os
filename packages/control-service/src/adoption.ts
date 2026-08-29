import { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { parseSuccessEnvelope, type SuccessEnvelope } from "@ai-dev-os/api";
import { canonicalizeJson, type JsonValue } from "@ai-dev-os/domain";
import type { ControlArtifactStore } from "./artifacts.js";
import type { ConnectionDescriptor } from "./contracts.js";
import { ControlServiceError, controlFail } from "./errors.js";
import { CONTROL_HOST, START_NONCE_PATTERN } from "./identity.js";
import {
  CONTROL_PRESENTATION_MODES,
  type ControlPresentationMode,
} from "./routes.js";
import { exactInteger, exactString, exactTimestamp, readExactRecord } from "./structural.js";

export const ADOPTION_RESPONSE_LIMIT = 8_192;
export const ADOPTION_TIMEOUT_MS = 1_000;
const ADOPTION_HEADER_LIMIT = 4_096;

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
  close?(): void;
}

function exactJsonMediaType(value: string): boolean {
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

export function createLoopbackAdoptionTransport(): AdoptionTransport {
  // Both HTTP exchanges are serialized over this one socket. The second
  // request is not written until the caller validates the first response.
  // If the peer closes, get() refuses instead of reconnecting to the port.
  let socket: Socket | null = null;
  let boundPort: number | null = null;
  let pending = false;
  let closed = false;

  const parseBufferedResponse = (bytes: Buffer): AdoptionTransportResponse | null => {
    const split = bytes.indexOf("\r\n\r\n");
    if (split < 0) {
      if (bytes.byteLength > ADOPTION_HEADER_LIMIT) controlFail("ADOPTION_REFUSED");
      return null;
    }
    if (split > ADOPTION_HEADER_LIMIT) controlFail("ADOPTION_REFUSED");
    const headerText = bytes.subarray(0, split).toString("latin1");
    if (!/^[\x20-\x7e\r\n]*$/u.test(headerText)) controlFail("ADOPTION_REFUSED");
    const lines = headerText.split("\r\n");
    const status = /^(?:HTTP\/1\.1) ([1-5][0-9]{2})(?: [\x20-\x7e]{0,64})?$/u.exec(lines.shift() ?? "");
    if (status === null || lines.length > 32) controlFail("ADOPTION_REFUSED");
    const headers: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon < 1 || /^[ \t]/u.test(line)) controlFail("ADOPTION_REFUSED");
      const name = line.slice(0, colon).toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/u.test(name) || value.length > 1_024 || Object.hasOwn(headers, name)) {
        controlFail("ADOPTION_REFUSED");
      }
      headers[name] = value;
    }
    if (Object.hasOwn(headers, "transfer-encoding")) controlFail("ADOPTION_REFUSED");
    const contentLength = headers["content-length"];
    if (contentLength === undefined || !/^(?:0|[1-9][0-9]{0,4})$/u.test(contentLength)) {
      controlFail("ADOPTION_REFUSED");
    }
    const length = Number(contentLength);
    if (length > ADOPTION_RESPONSE_LIMIT) controlFail("ADOPTION_REFUSED");
    const expected = split + 4 + length;
    if (bytes.byteLength < expected) return null;
    if (bytes.byteLength !== expected) controlFail("ADOPTION_REFUSED");
    return Object.freeze({
      statusCode: Number(status[1] ?? 0),
      contentType: headers["content-type"] ?? "",
      body: Buffer.from(bytes.subarray(split + 4)),
    });
  };

  return Object.freeze({
    async get(input: Readonly<{
      port: number;
      path: "/v1/health" | "/v1/session";
      bearerToken?: string;
      timeoutMs: number;
    }>) {
      if (closed || pending || (boundPort !== null && boundPort !== input.port)) controlFail("ADOPTION_REFUSED");
      if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) controlFail("ADOPTION_REFUSED");
      pending = true;
      return await new Promise<AdoptionTransportResponse>((resolve, reject) => {
        let settled = false;
        let bytes = Buffer.alloc(0);
        const active = socket ?? new Socket();
        const cleanup = (): void => {
          clearTimeout(timer);
          active.off("data", onData);
          active.off("error", onSocketFailure);
          active.off("close", onSocketFailure);
          pending = false;
        };
        const fail = (error: ControlServiceError): void => {
          if (settled) return;
          settled = true;
          cleanup();
          closed = true;
          active.destroy();
          reject(error);
        };
        const onSocketFailure = (): void => { fail(new ControlServiceError("ADOPTION_REFUSED")); };
        const onData = (chunk: Buffer): void => {
          if (settled) return;
          if (bytes.byteLength + chunk.byteLength > ADOPTION_HEADER_LIMIT + 4 + ADOPTION_RESPONSE_LIMIT) {
            fail(new ControlServiceError("ADOPTION_REFUSED"));
            return;
          }
          bytes = Buffer.concat([bytes, chunk]);
          try {
            const response = parseBufferedResponse(bytes);
            if (response === null) return;
            settled = true;
            cleanup();
            resolve(response);
          } catch {
            fail(new ControlServiceError("ADOPTION_REFUSED"));
          }
        };
        const timer = setTimeout(() => fail(new ControlServiceError("ADOPTION_TIMEOUT")), input.timeoutMs);
        active.on("data", onData);
        active.once("error", onSocketFailure);
        active.once("close", onSocketFailure);
        const writeRequest = (): void => {
          if (active.destroyed || !active.writable) {
            fail(new ControlServiceError("ADOPTION_REFUSED"));
            return;
          }
          const authorization = input.bearerToken === undefined
            ? ""
            : `Authorization: Bearer ${input.bearerToken}\r\n`;
          active.write([
            `GET ${input.path} HTTP/1.1`,
            `Host: ${CONTROL_HOST}:${input.port}`,
            "Accept: application/json",
            "Connection: keep-alive",
            authorization.trimEnd(),
            "",
            "",
          ].filter((line, index) => index !== 4 || line.length > 0).join("\r\n"));
        };
        if (socket === null) {
          socket = active;
          boundPort = input.port;
          const markClosed = (): void => { closed = true; };
          active.on("error", markClosed);
          active.on("close", markClosed);
          active.once("connect", writeRequest);
          active.connect({ host: CONTROL_HOST, port: input.port });
        } else {
          writeRequest();
        }
      });
    },
    close() {
      closed = true;
      socket?.destroy();
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
  const record = readExactRecord(value, ["serviceVersion", "startNonce", "presentationMode", "ready"]);
  if (record["ready"] !== true) controlFail("ADOPTION_REFUSED");
  return Object.freeze({
    serviceVersion: exactString(record["serviceVersion"], /^\d+\.\d+\.\d+$/u, 32),
    startNonce: exactString(record["startNonce"], START_NONCE_PATTERN, 32),
    presentationMode: exactPresentationMode(record["presentationMode"]),
    ready: true,
  });
}

function sessionPayload(value: unknown): JsonValue {
  const record = readExactRecord(value, [
    "serviceVersion", "startNonce", "presentationMode", "runningSessions",
    "runningSessionsComputedAt", "runningSessionsConfidence", "state",
  ]);
  if (record["state"] !== "active" || record["runningSessionsConfidence"] !== "current") {
    controlFail("ADOPTION_REFUSED");
  }
  return Object.freeze({
    serviceVersion: exactString(record["serviceVersion"], /^\d+\.\d+\.\d+$/u, 32),
    startNonce: exactString(record["startNonce"], START_NONCE_PATTERN, 32),
    presentationMode: exactPresentationMode(record["presentationMode"]),
    runningSessions: exactInteger(record["runningSessions"], 0, 10_000),
    runningSessionsComputedAt: exactTimestamp(record["runningSessionsComputedAt"]),
    runningSessionsConfidence: "current",
    state: "active",
  });
}

function exactPresentationMode(value: unknown): ControlPresentationMode {
  if (
    typeof value !== "string" ||
    !(CONTROL_PRESENTATION_MODES as readonly string[]).includes(value)
  ) controlFail("ADOPTION_REFUSED");
  return value as ControlPresentationMode;
}

export interface AdoptedControlService {
  readonly descriptor: ConnectionDescriptor;
  readonly presentationMode: ControlPresentationMode;
  readonly runningSessions: number;
}

export async function adoptExistingControlService(options: Readonly<{
  store: ControlArtifactStore;
  expectedPresentationMode: ControlPresentationMode;
  transport?: AdoptionTransport;
  timeoutMs?: number;
}>): Promise<AdoptedControlService> {
  const descriptor = (await options.store.readDescriptor()).value;
  const expectedPresentationMode = exactPresentationMode(options.expectedPresentationMode);
  if (descriptor.presentationMode !== expectedPresentationMode) controlFail("ADOPTION_REFUSED");
  const transport = options.transport ?? createLoopbackAdoptionTransport();
  const timeoutMs = options.timeoutMs ?? ADOPTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 5_000) controlFail("ADOPTION_REFUSED");
  const deadline = performance.now() + timeoutMs;
  const remaining = (): number => {
    const value = Math.ceil(deadline - performance.now());
    if (value <= 0) controlFail("ADOPTION_TIMEOUT");
    return value;
  };
  try {
    const probe = parseResponse(await transport.get({
      port: descriptor.port,
      path: "/v1/health",
      timeoutMs: remaining(),
    }), healthPayload);
    const payload = probe.payload as Record<string, JsonValue>;
    if (
      payload["startNonce"] !== descriptor.startNonce ||
      payload["serviceVersion"] !== descriptor.serviceVersion ||
      payload["presentationMode"] !== descriptor.presentationMode
    ) {
      controlFail("ADOPTION_REFUSED");
    }
    // Yield only after the full health response has been parsed; the next
    // write still uses the same private socket and the same total deadline.
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const session = parseResponse(await transport.get({
      port: descriptor.port,
      path: "/v1/session",
      bearerToken: descriptor.bearerToken,
      timeoutMs: remaining(),
    }), sessionPayload);
    const sessionRecord = session.payload as Record<string, JsonValue>;
    if (
      sessionRecord["startNonce"] !== descriptor.startNonce ||
      sessionRecord["serviceVersion"] !== descriptor.serviceVersion ||
      sessionRecord["presentationMode"] !== descriptor.presentationMode ||
      new Date(sessionRecord["runningSessionsComputedAt"] as string).valueOf() >
        new Date(session.serverNow).valueOf()
    ) {
      controlFail("ADOPTION_REFUSED");
    }
    return Object.freeze({
      descriptor,
      presentationMode: descriptor.presentationMode,
      runningSessions: sessionRecord["runningSessions"] as number,
    });
  } catch (error) {
    if (error instanceof ControlServiceError) throw error;
    throw new ControlServiceError("ADOPTION_REFUSED");
  } finally {
    transport.close?.();
  }
}
