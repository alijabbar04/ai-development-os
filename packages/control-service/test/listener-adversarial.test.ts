import { connect } from "node:net";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_LIMITS,
  assertResponseBound,
  type ControlServiceHandle,
} from "../src/index.js";
import { startControlServiceForTest } from "./testing.js";
import { httpGet, rawHttp } from "./http-helpers.js";
import { createCanonicalTemporaryRoot } from "./temporary-root.js";

const NOW = "2026-08-26T10:00:00.000Z";
const roots: string[] = [];
const handles: ControlServiceHandle[] = [];

async function start(beforeSessionRead?: (signal: AbortSignal) => Promise<void>): Promise<ControlServiceHandle> {
  const storageRoot = await createCanonicalTemporaryRoot("ai-dev-os-c4-hostile-");
  roots.push(storageRoot);
  const handle = await startControlServiceForTest({
    storageRoot,
    clock: () => NOW,
    random: (size) => Buffer.alloc(size, 31),
    ...(beforeSessionRead === undefined ? {} : { beforeSessionRead }),
  });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  for (const handle of handles.splice(0).reverse()) {
    try { await handle.close(); } catch { /* bounded test cleanup */ }
  }
  for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true });
});

function refusal(result: Awaited<ReturnType<typeof httpGet>>, code: string): void {
  expect(result.json).toMatchObject({
    schemaVersion: 1,
    productionEnabled: false,
    ok: false,
    kind: "transport-refusal",
    transportRefusal: { code, details: null },
  });
  expect(result.text).not.toMatch(/Bearer |at .+\.(?:ts|js):\d+|node_modules|[A-Z]:\\/u);
}

describe("C4 authentication, origin, method, and malformed-request boundary", () => {
  it("strictly refuses missing/wrong/alternate bearer forms and authorization on health", async () => {
    const handle = await start();
    for (const token of [null, "x".repeat(43), handle.descriptor.startNonce]) {
      const result = await httpGet(handle.descriptor, "/v1/session", { token });
      expect(result.statusCode).toBe(401);
      refusal(result, "AUTHENTICATION_REFUSED");
      if (token !== null) expect(result.text).not.toContain(token);
    }
    const health = await httpGet(handle.descriptor, "/v1/health");
    expect(health.statusCode).toBe(401);
    refusal(health, "AUTHENTICATION_REFUSED");
    const alternate = await rawHttp(handle.descriptor.port,
      `GET /v1/session HTTP/1.1\r\nHost: 127.0.0.1:${handle.descriptor.port}\r\nAuthorization: bearer ${handle.descriptor.bearerToken}\r\nConnection: close\r\n\r\n`);
    expect(alternate).toContain("401 Unauthorized");
    expect(alternate).not.toContain(handle.descriptor.bearerToken);
  });

  it("refuses duplicate Authorization and Host headers", async () => {
    const handle = await start();
    const duplicateAuth = await rawHttp(handle.descriptor.port,
      `GET /v1/session HTTP/1.1\r\nHost: 127.0.0.1:${handle.descriptor.port}\r\nAuthorization: Bearer ${handle.descriptor.bearerToken}\r\nAuthorization: Bearer ${handle.descriptor.bearerToken}\r\nConnection: close\r\n\r\n`);
    expect(duplicateAuth).toContain("401 Unauthorized");
    expect(duplicateAuth).not.toContain(handle.descriptor.bearerToken);
    const wrongHost = await httpGet(handle.descriptor, "/v1/session", { headers: { host: "localhost" } });
    expect(wrongHost.statusCode).toBe(403);
    refusal(wrongHost, "HOST_REFUSED");
  });

  it("keeps the origin allowlist empty with no reflective or credentialed CORS", async () => {
    const handle = await start();
    const result = await httpGet(handle.descriptor, "/v1/session", { headers: { origin: "http://127.0.0.1:9999" } });
    expect(result.statusCode).toBe(403);
    refusal(result, "ORIGIN_REFUSED");
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
    expect(result.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("returns finite owned refusals for methods, routes, queries, media types, bodies, and encodings", async () => {
    const handle = await start();
    const cases = [
      [await httpGet(handle.descriptor, "/v1/session", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), 405, "METHOD_NOT_ALLOWED"],
      [await httpGet(handle.descriptor, "/v1/missing"), 404, "ROUTE_NOT_FOUND"],
      [await httpGet(handle.descriptor, "/v1/session?extra=1"), 400, "QUERY_REFUSED"],
      [await httpGet(handle.descriptor, "/v1/session", { headers: { "content-type": "application/jsonp" } }), 400, "BODY_REFUSED"],
      [await httpGet(handle.descriptor, `/v1/%${"2f"}`), 413, "REQUEST_LIMIT_REFUSED"],
      [await httpGet(handle.descriptor, `/v1/${"x".repeat(CONTROL_LIMITS.maxUrlBytes)}`), 413, "REQUEST_LIMIT_REFUSED"],
    ] as const;
    for (const [result, status, code] of cases) {
      expect(result.statusCode).toBe(status);
      refusal(result, code);
    }
  });

  it("uses an owned header limit below Node's parser ceiling", async () => {
    const handle = await start();
    const response = await rawHttp(handle.descriptor.port,
      `GET /v1/session HTTP/1.1\r\nHost: 127.0.0.1:${handle.descriptor.port}\r\nX-Pad: ${"p".repeat(1_200)}\r\nAuthorization: Bearer ${handle.descriptor.bearerToken}\r\nConnection: close\r\n\r\n`);
    expect(response).toContain("413 Payload Too Large");
    expect(response).toContain("REQUEST_LIMIT_REFUSED");
    expect(response).not.toContain(handle.descriptor.bearerToken);

    const parserResponse = await rawHttp(handle.descriptor.port,
      `GET /v1/session HTTP/1.1\r\nHost: 127.0.0.1:${handle.descriptor.port}\r\nX-Pad: ${"p".repeat(CONTROL_LIMITS.maxHeaderBytes + 100)}\r\nConnection: close\r\n\r\n`);
    expect(parserResponse).toContain("400 Bad Request");
    expect(parserResponse).toContain("REQUEST_LIMIT_REFUSED");
  });

  it("owns missing-Host, Expect, and CONNECT protocol refusals", async () => {
    const handle = await start();
    const documents = [
      "GET /v1/health HTTP/1.1\r\nConnection: close\r\n\r\n",
      `GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1:${handle.descriptor.port}\r\nExpect: 100-continue\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      `GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1:${handle.descriptor.port}\r\nExpect: unsupported\r\nConnection: close\r\n\r\n`,
      `CONNECT /v1/session HTTP/1.1\r\nHost: 127.0.0.1:${handle.descriptor.port}\r\nConnection: close\r\n\r\n`,
    ];
    for (const document of documents) {
      const response = await rawHttp(handle.descriptor.port, document);
      expect(response).toContain("HTTP/1.1");
      expect(response).toContain('"kind":"transport-refusal"');
      expect(response).toMatch(/"code":"(?:HOST_REFUSED|REQUEST_LIMIT_REFUSED)"/u);
      expect(response).not.toMatch(/Fastify|node_modules|at .+\.(?:ts|js):\d+/u);
    }
  });
});

describe("C4 concurrency, rate, deadline, response, and teardown limits", () => {
  it("enforces the exact per-session request window", async () => {
    const handle = await start();
    for (let count = 0; count < CONTROL_LIMITS.maxRequestsPerWindow; count += 1) {
      expect((await httpGet(handle.descriptor, "/v1/session")).statusCode).toBe(200);
    }
    const refused = await httpGet(handle.descriptor, "/v1/session");
    expect(refused.statusCode).toBe(429);
    refusal(refused, "RATE_REFUSED");
  });

  it("caps concurrent reads and drains in-flight work before shutdown", async () => {
    let entered = 0;
    let release!: () => void;
    let allEntered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { allEntered = resolve; });
    const handle = await start(async (signal) => {
      entered += 1;
      if (entered === CONTROL_LIMITS.maxConcurrentRequests) allEntered();
      await Promise.race([
        barrier,
        new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
      ]);
    });
    const pending = Array.from({ length: CONTROL_LIMITS.maxConcurrentRequests }, async () => await httpGet(handle.descriptor, "/v1/session"));
    await ready;
    const excess = await httpGet(handle.descriptor, "/v1/session");
    expect(excess.statusCode).toBe(429);
    refusal(excess, "RATE_REFUSED");
    let closed = false;
    const closing = handle.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    release();
    expect((await Promise.all(pending)).every((result) => result.statusCode === 200)).toBe(true);
    await closing;
    expect(closed).toBe(true);
    handles.splice(handles.indexOf(handle), 1);
  });

  it("turns deadline expiry and handler exceptions into finite responses without killing the host", async () => {
    const timed = await start(async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const deadline = await httpGet(timed.descriptor, "/v1/session");
    expect(deadline.statusCode).toBe(503);
    refusal(deadline, "DEADLINE_EXCEEDED");
    expect((await httpGet(timed.descriptor, "/v1/health", { token: null })).statusCode).toBe(200);

    const throwing = await start(async () => { throw new Error("planted path C:\\secret\\fixture"); });
    const contained = await httpGet(throwing.descriptor, "/v1/session");
    expect(contained.statusCode).toBe(503);
    refusal(contained, "SERVICE_UNAVAILABLE");
    expect(contained.text).not.toContain("planted");
    expect((await httpGet(throwing.descriptor, "/v1/health", { token: null })).statusCode).toBe(200);
  });

  it("releases an abruptly lost client and leaves the listener usable", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const handle = await start(async (signal) => {
      entered();
      await Promise.race([
        barrier,
        new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
      ]);
    });
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: handle.descriptor.port });
      socket.once("connect", () => {
        socket.write(`GET /v1/session HTTP/1.1\r\nHost: 127.0.0.1:${handle.descriptor.port}\r\nAuthorization: Bearer ${handle.descriptor.bearerToken}\r\n\r\n`);
        void started.then(() => {
          socket.destroy();
          resolve();
        });
      });
      socket.once("error", reject);
    });
    release();
    expect((await httpGet(handle.descriptor, "/v1/health", { token: null })).statusCode).toBe(200);
  });

  it("has a positive response-size guard control", () => {
    expect(assertResponseBound("x")).toBe("x");
    expect(() => assertResponseBound("x".repeat(CONTROL_LIMITS.maxResponseBytes + 1))).toThrow(/response/u);
  });
});
