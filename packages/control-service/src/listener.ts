import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { RandomBytesPort, ServerBearerSession } from "./identity.js";
import {
  CONTROL_HOST,
  CONTROL_SERVICE_VERSION,
  createLaunchIdentity,
  createServerBearerSession,
} from "./identity.js";
import { createControlArtifactStore, type ArtifactLease, type ControlArtifactStore } from "./artifacts.js";
import type { ConnectionDescriptor, InstanceLock } from "./contracts.js";
import { adoptExistingControlService } from "./adoption.js";
import { ControlServiceError, controlFail, errorCode } from "./errors.js";
import { createControlLifecycle, type ControlLifecycle, type LifecycleSnapshot, type StartupMode } from "./lifecycle.js";
import { establishSingleInstance, type ProcessLivenessPort } from "./single-instance.js";
import {
  CONTROL_ALLOWED_ORIGINS,
  CONTROL_LIMITS,
  assertResponseBound,
  createSessionRateLimiter,
  parseBoundedQuery,
  serializeSuccess,
  serializeTransportRefusal,
  type TransportRefusalCode,
} from "./transport.js";

export interface ControlServiceHandle {
  readonly startupMode: StartupMode;
  readonly descriptor: ConnectionDescriptor;
  readonly ownsListener: boolean;
  lifecycle(): LifecycleSnapshot;
  close(): Promise<void>;
}

export interface StartControlServiceOptions {
  readonly storageRoot: string;
}

export interface InternalControlServiceOptions {
  readonly store: ControlArtifactStore;
  readonly clock: () => string;
  readonly random?: RandomBytesPort;
  readonly processId: number;
  readonly liveness: ProcessLivenessPort;
  readonly testingPort: number;
  readonly beforeSessionRead?: (signal: AbortSignal) => Promise<void>;
}

function systemLiveness(): ProcessLivenessPort {
  return Object.freeze({
    async inspect(processId: number) {
      try {
        process.kill(processId, 0);
        return "live" as const;
      } catch (error) {
        return errorCode(error) === "ESRCH" ? "dead" as const : "ambiguous" as const;
      }
    },
  });
}

function statusFor(code: TransportRefusalCode): number {
  switch (code) {
    case "AUTHENTICATION_REFUSED": return 401;
    case "ORIGIN_REFUSED":
    case "HOST_REFUSED": return 403;
    case "METHOD_NOT_ALLOWED": return 405;
    case "ROUTE_NOT_FOUND": return 404;
    case "BODY_REFUSED":
    case "QUERY_REFUSED": return 400;
    case "REQUEST_LIMIT_REFUSED":
    case "RESPONSE_LIMIT_REFUSED": return 413;
    case "RATE_REFUSED": return 429;
    case "DEADLINE_EXCEEDED":
    case "SERVICE_UNAVAILABLE": return 503;
  }
}

function headerValues(request: FastifyRequest, name: string): readonly string[] {
  const output: string[] = [];
  const target = name.toLowerCase();
  const raw = request.raw.rawHeaders;
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() === target) output.push(raw[index + 1] ?? "");
  }
  return output;
}

function createFixedHttpServer(handler: Parameters<typeof createHttpServer>[1]): HttpServer {
  const server = createHttpServer({
    maxHeaderSize: CONTROL_LIMITS.maxHeaderBytes,
    requireHostHeader: true,
    joinDuplicateHeaders: false,
  }, handler);
  server.requestTimeout = 1_000;
  server.headersTimeout = 1_000;
  server.keepAliveTimeout = 1_000;
  server.setTimeout(1_000);
  server.maxHeadersCount = CONTROL_LIMITS.maxHeaders;
  server.maxRequestsPerSocket = CONTROL_LIMITS.maxRequestsPerSocket;
  return server;
}

interface ListenerComposition {
  readonly app: FastifyInstance;
  setExpectedPort(port: number): void;
}

function composeListener(options: Readonly<{
  session: ServerBearerSession;
  clock: () => string;
  beforeSessionRead?: (signal: AbortSignal) => Promise<void>;
}>): ListenerComposition {
  let sequence = 0;
  let expectedPort = 0;
  let activeRequests = 0;
  const tracked = new WeakSet<object>();
  const limiter = createSessionRateLimiter();
  const nextSequence = (): number => {
    sequence += 1;
    return sequence;
  };
  const app = fastify({
    logger: false,
    exposeHeadRoutes: false,
    bodyLimit: CONTROL_LIMITS.maxBodyBytes,
    handlerTimeout: CONTROL_LIMITS.requestDeadlineMs,
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error",
    requestIdHeader: false,
    forceCloseConnections: "idle",
    serverFactory: createFixedHttpServer,
    clientErrorHandler: (_error, socket) => {
      if (!socket.writable) return;
      const payload = assertResponseBound(serializeTransportRefusal(
        "REQUEST_LIMIT_REFUSED",
        nextSequence(),
        options.clock(),
      ));
      socket.end([
        "HTTP/1.1 400 Bad Request",
        "Content-Type: application/json; charset=utf-8",
        "Cache-Control: no-store",
        "X-Content-Type-Options: nosniff",
        "Connection: close",
        `Content-Length: ${Buffer.byteLength(payload, "utf8")}`,
        "",
        payload,
      ].join("\r\n"));
    },
    routerOptions: {
      ignoreTrailingSlash: false,
      ignoreDuplicateSlashes: false,
      caseSensitive: true,
      maxParamLength: 64,
    },
  });

  const sendRefusal = (reply: FastifyReply, code: TransportRefusalCode): void => {
    const payload = assertResponseBound(serializeTransportRefusal(code, nextSequence(), options.clock()));
    reply.code(statusFor(code)).type("application/json; charset=utf-8").send(payload);
  };
  const sendSuccess = (reply: FastifyReply, payload: Parameters<typeof serializeSuccess>[0]): void => {
    reply.code(200).type("application/json; charset=utf-8")
      .send(assertResponseBound(serializeSuccess(payload, nextSequence(), options.clock())));
  };
  const release = (request: FastifyRequest): void => {
    if (tracked.delete(request.raw)) activeRequests -= 1;
  };

  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("content-security-policy", "default-src 'none'");
    reply.header("x-content-type-options", "nosniff");

    if (activeRequests >= CONTROL_LIMITS.maxConcurrentRequests) {
      sendRefusal(reply, "RATE_REFUSED");
      return;
    }
    tracked.add(request.raw);
    activeRequests += 1;
    reply.raw.once("close", () => { release(request); });

    const rawHeaders = request.raw.rawHeaders;
    let headerBytes = 0;
    if (rawHeaders.length % 2 !== 0 || rawHeaders.length / 2 > CONTROL_LIMITS.maxHeaders) {
      sendRefusal(reply, "REQUEST_LIMIT_REFUSED");
      return;
    }
    for (let index = 0; index < rawHeaders.length; index += 2) {
      const name = rawHeaders[index] ?? "";
      const value = rawHeaders[index + 1] ?? "";
      const nameBytes = Buffer.byteLength(name, "utf8");
      const valueBytes = Buffer.byteLength(value, "utf8");
      headerBytes += nameBytes + valueBytes;
      if (nameBytes > CONTROL_LIMITS.maxHeaderNameBytes || valueBytes > CONTROL_LIMITS.maxHeaderValueBytes) {
        sendRefusal(reply, "REQUEST_LIMIT_REFUSED");
        return;
      }
    }
    if (headerBytes > CONTROL_LIMITS.maxOwnedHeaderBytes) {
      sendRefusal(reply, "REQUEST_LIMIT_REFUSED");
      return;
    }

    const rawUrl = request.raw.url ?? "";
    if (
      Buffer.byteLength(rawUrl, "utf8") === 0 || Buffer.byteLength(rawUrl, "utf8") > CONTROL_LIMITS.maxUrlBytes ||
      rawUrl.includes("\u0000") || rawUrl.includes("%") || rawUrl.includes("#")
    ) {
      sendRefusal(reply, "REQUEST_LIMIT_REFUSED");
      return;
    }
    if (request.method !== "GET") {
      sendRefusal(reply, "METHOD_NOT_ALLOWED");
      return;
    }
    const host = headerValues(request, "host");
    if (host.length !== 1 || host[0] !== `${CONTROL_HOST}:${expectedPort}`) {
      sendRefusal(reply, "HOST_REFUSED");
      return;
    }
    const origins = headerValues(request, "origin");
    if (origins.length !== 0 || CONTROL_ALLOWED_ORIGINS.length !== 0) {
      sendRefusal(reply, "ORIGIN_REFUSED");
      return;
    }
    const contentTypes = headerValues(request, "content-type");
    const transferEncoding = headerValues(request, "transfer-encoding");
    const contentLength = headerValues(request, "content-length");
    if (
      contentTypes.length !== 0 || transferEncoding.length !== 0 ||
      contentLength.length > 1 || (contentLength.length === 1 && contentLength[0] !== "0")
    ) {
      sendRefusal(reply, "BODY_REFUSED");
      return;
    }

    const path = rawUrl.split("?", 1)[0] ?? "";
    const authorization = headerValues(request, "authorization");
    if (path === "/v1/health") {
      if (authorization.length !== 0) sendRefusal(reply, "AUTHENTICATION_REFUSED");
      return;
    }
    if (authorization.length !== 1 || !/^Bearer [A-Za-z0-9_-]{43}$/u.test(authorization[0] ?? "")) {
      sendRefusal(reply, "AUTHENTICATION_REFUSED");
      return;
    }
    const token = (authorization[0] ?? "").slice(7);
    const serverNow = options.clock();
    if (options.session.authenticate(token, serverNow) !== "active") {
      sendRefusal(reply, "AUTHENTICATION_REFUSED");
      return;
    }
    if (!limiter.consume(serverNow)) {
      sendRefusal(reply, "RATE_REFUSED");
      return;
    }
  });

  app.addHook("onResponse", async (request) => { release(request); });
  app.addHook("onSend", async (_request, reply, payload) => {
    const bytes = typeof payload === "string" || Buffer.isBuffer(payload)
      ? Buffer.byteLength(payload)
      : CONTROL_LIMITS.maxResponseBytes + 1;
    if (bytes <= CONTROL_LIMITS.maxResponseBytes) return payload;
    reply.code(500).type("application/json; charset=utf-8");
    return serializeTransportRefusal("RESPONSE_LIMIT_REFUSED", nextSequence(), options.clock());
  });

  app.setErrorHandler((error, _request, reply) => {
    sendRefusal(reply, errorCode(error) === "FST_ERR_HANDLER_TIMEOUT" ? "DEADLINE_EXCEEDED" : "SERVICE_UNAVAILABLE");
  });
  app.setNotFoundHandler((request, reply) => {
    const rawUrl = request.raw.url ?? "";
    try { parseBoundedQuery(rawUrl, []); }
    catch { sendRefusal(reply, "QUERY_REFUSED"); return; }
    sendRefusal(reply, "ROUTE_NOT_FOUND");
  });

  app.route({
    method: "GET",
    url: "/v1/health",
    exposeHeadRoute: false,
    handlerTimeout: CONTROL_LIMITS.requestDeadlineMs,
    handler(request, reply) {
      try { parseBoundedQuery(request.raw.url ?? "", []); }
      catch { sendRefusal(reply, "QUERY_REFUSED"); return; }
      sendSuccess(reply, {
        ready: true,
        serviceVersion: options.session.serviceVersion,
        startNonce: options.session.startNonce,
      });
    },
  });
  app.route({
    method: "GET",
    url: "/v1/session",
    exposeHeadRoute: false,
    handlerTimeout: CONTROL_LIMITS.requestDeadlineMs,
    async handler(request, reply) {
      try { parseBoundedQuery(request.raw.url ?? "", []); }
      catch { sendRefusal(reply, "QUERY_REFUSED"); return; }
      await options.beforeSessionRead?.(request.signal);
      if (request.signal.aborted) return;
      sendSuccess(reply, {
        serviceVersion: options.session.serviceVersion,
        startNonce: options.session.startNonce,
        state: "active",
      });
    },
  });

  return Object.freeze({
    app,
    setExpectedPort(port: number) { expectedPort = port; },
  });
}

async function cleanupLease(store: ControlArtifactStore, lease: ArtifactLease | null): Promise<void> {
  if (lease === null) return;
  try { await store.removeOwned(lease); }
  catch (error) {
    if (!(error instanceof ControlServiceError && error.code === "ARTIFACT_MISSING")) throw error;
  }
}

function adoptedHandle(descriptor: ConnectionDescriptor, lifecycle: ControlLifecycle): ControlServiceHandle {
  let closed = false;
  return Object.freeze({
    startupMode: "adopted" as const,
    descriptor,
    ownsListener: false,
    lifecycle: () => lifecycle.snapshot(),
    async close() {
      if (closed) return;
      lifecycle.transition("begin-drain");
      lifecycle.transition("close");
      closed = true;
    },
  });
}

export async function startControlServiceInternal(options: InternalControlServiceOptions): Promise<ControlServiceHandle> {
  if (!Number.isSafeInteger(options.testingPort) || options.testingPort < 0 || options.testingPort > 65_535) {
    controlFail("BIND_REFUSED");
  }
  await options.store.prepare();
  const identity = createLaunchIdentity({
    now: options.clock(),
    ...(options.random === undefined ? {} : { random: options.random }),
  });
  const requestedLock: InstanceLock = Object.freeze({
    schemaVersion: 1,
    serviceVersion: CONTROL_SERVICE_VERSION,
    processId: options.processId,
    startNonce: identity.startNonce,
    issuedAt: identity.issuedAt,
  });
  const lifecycle = createControlLifecycle();
  const disposition = await establishSingleInstance({
    store: options.store,
    requestedLock,
    liveness: options.liveness,
  });
  if (disposition.kind === "adopt") {
    lifecycle.transition("begin-adoption");
    const descriptor = await adoptExistingControlService({ store: options.store });
    lifecycle.transition("adoption-ready");
    return adoptedHandle(descriptor, lifecycle);
  }

  lifecycle.transition("begin-fresh");
  const lockLease = disposition.lockLease;
  const session = createServerBearerSession({
    serviceVersion: CONTROL_SERVICE_VERSION,
    startNonce: identity.startNonce,
    bearerToken: identity.bearerToken,
    issuedAt: identity.issuedAt,
    expiresAt: identity.expiresAt,
  });
  const listener = composeListener({
    session,
    clock: options.clock,
    ...(options.beforeSessionRead === undefined ? {} : { beforeSessionRead: options.beforeSessionRead }),
  });
  let descriptorLease: ArtifactLease | null = null;
  try {
    await listener.app.listen({ port: options.testingPort, host: CONTROL_HOST });
    const address = listener.app.server.address();
    if (
      address === null || typeof address === "string" || address.address !== CONTROL_HOST ||
      address.family !== "IPv4" || address.port < 1 || address.port > 65_535
    ) controlFail("BIND_REFUSED");
    listener.setExpectedPort(address.port);
    const descriptor: ConnectionDescriptor = Object.freeze({
      schemaVersion: 1,
      serviceVersion: CONTROL_SERVICE_VERSION,
      host: CONTROL_HOST,
      port: address.port,
      processId: options.processId,
      startNonce: identity.startNonce,
      bearerToken: identity.bearerToken,
      issuedAt: identity.issuedAt,
      expiresAt: identity.expiresAt,
    });
    descriptorLease = await options.store.writeDescriptor(descriptor);
    lifecycle.transition("fresh-ready");
    let closed = false;
    return Object.freeze({
      startupMode: "fresh" as const,
      descriptor,
      ownsListener: true,
      lifecycle: () => lifecycle.snapshot(),
      async close() {
        if (closed) return;
        lifecycle.transition("begin-drain");
        await listener.app.close();
        await cleanupLease(options.store, descriptorLease);
        await cleanupLease(options.store, lockLease);
        lifecycle.transition("close");
        closed = true;
      },
    });
  } catch (error) {
    try { await listener.app.close(); } catch { /* close even a partially initialized listener */ }
    try { await cleanupLease(options.store, descriptorLease); } catch { /* exact cleanup attempted */ }
    try { await cleanupLease(options.store, lockLease); } catch { /* exact cleanup attempted */ }
    if (error instanceof ControlServiceError) throw error;
    controlFail("BIND_REFUSED");
  }
}

export async function startControlService(options: StartControlServiceOptions): Promise<ControlServiceHandle> {
  const store = createControlArtifactStore({ root: options.storageRoot });
  return await startControlServiceInternal({
    store,
    clock: () => new Date().toISOString(),
    processId: process.pid,
    liveness: systemLiveness(),
    testingPort: 0,
  });
}
