import { createServer, request, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  adoptExistingControlService as adoptWithPresentationMode,
  createControlArtifactStore,
  createLaunchIdentity,
  type ControlPresentationMode,
  type ConnectionDescriptor,
} from "../src/index.js";

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const rawServers: NetServer[] = [];
const NOW = "2026-08-26T10:00:00.000Z";

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const server of rawServers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function envelope(payload: Record<string, unknown>, serverNow = NOW): string {
  return JSON.stringify({
    schemaVersion: 1, sequence: 1, serverNow, productionEnabled: false,
    ok: true, kind: "success", payload,
  });
}

async function rawFixture(respond: (socket: Socket) => void): Promise<number> {
  const server = createNetServer((socket) => {
    socket.once("data", () => { respond(socket); });
  });
  rawServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("raw fixture did not bind TCP");
  return address.port;
}

function sendBounded(response: ServerResponse, body: string, contentType = "application/json"): void {
  response.writeHead(200, {
    "content-length": String(Buffer.byteLength(body, "utf8")),
    "content-type": contentType,
  });
  response.end(body);
}

async function fixture(handler: Parameters<typeof createServer>[0]): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture did not bind TCP");
  return { server, port: address.port };
}

async function storeDescriptor(port: number, byte = 11): Promise<{ descriptor: ConnectionDescriptor; store: ReturnType<typeof createControlArtifactStore> }> {
  const directory = await mkdtemp(join(tmpdir(), "ai-dev-os-adopt-"));
  roots.push(directory);
  const store = createControlArtifactStore({ root: directory });
  await store.prepare();
  const identity = createLaunchIdentity({ now: NOW, random: (size) => Buffer.alloc(size, byte) });
  const descriptor: ConnectionDescriptor = {
    schemaVersion: 1, serviceVersion: "0.1.0", host: "127.0.0.1", port,
    presentationMode: "normal", processId: process.pid, ...identity,
  };
  await store.writeDescriptor(descriptor);
  return { descriptor, store };
}

type AdoptionOptions = Parameters<typeof adoptWithPresentationMode>[0];

async function adoptExistingControlService(
  options: Omit<AdoptionOptions, "expectedPresentationMode"> &
    Readonly<{ expectedPresentationMode?: ControlPresentationMode }>,
) {
  return await adoptWithPresentationMode({
    expectedPresentationMode: "normal",
    ...options,
  });
}

describe("C3 nonce-before-bearer adoption", () => {
  it("refuses a descriptor presentation mismatch before opening a transport", async () => {
    const { store } = await storeDescriptor(45122, 10);
    let calls = 0;
    await expect(adoptExistingControlService({
      store,
      expectedPresentationMode: "developer",
      transport: {
        get: async () => {
          calls += 1;
          throw new Error("transport must remain unused");
        },
      },
    })).rejects.toMatchObject({ code: "ADOPTION_REFUSED" });
    expect(calls).toBe(0);
  });

  it("refuses a live presentation mismatch without sending the bearer", async () => {
    const received: Array<string | undefined> = [];
    let expected: ConnectionDescriptor | undefined;
    const { port } = await fixture((req, res) => {
      received.push(req.headers.authorization);
      sendBounded(res, envelope({
        serviceVersion: expected?.serviceVersion,
        startNonce: expected?.startNonce,
        presentationMode: "developer",
        ready: true,
      }));
    });
    const prepared = await storeDescriptor(port, 18);
    expected = prepared.descriptor;
    await expect(adoptExistingControlService({ store: prepared.store, timeoutMs: 200 }))
      .rejects.toMatchObject({ code: "ADOPTION_REFUSED" });
    expect(received).toEqual([undefined]);
  });

  it("sends no authorization to a nonce-mismatched hostile listener", async () => {
    const received: Array<string | undefined> = [];
    const { port } = await fixture((req, res) => {
      received.push(req.headers.authorization);
      sendBounded(res, envelope({
        serviceVersion: "0.1.0", startNonce: "f".repeat(32), presentationMode: "normal", ready: true,
      }));
    });
    const { descriptor, store } = await storeDescriptor(port);
    await expect(adoptExistingControlService({ store, timeoutMs: 200 })).rejects.toMatchObject({ code: "ADOPTION_REFUSED" });
    expect(received).toEqual([undefined]);
    expect(JSON.stringify(received)).not.toContain(descriptor.bearerToken);
  });

  it("positive control proves the hostile fixture detects a leaked bearer", async () => {
    const received: Array<string | undefined> = [];
    const { port } = await fixture((req, res) => {
      received.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const token = "positive-control-token";
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/", headers: { authorization: `Bearer ${token}` } }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.once("error", reject);
      req.end();
    });
    expect(received).toEqual([`Bearer ${token}`]);
  });

  it("authenticates only the second request after an exact health identity match", async () => {
    const received: Array<{ path: string | undefined; authorization: string | undefined }> = [];
    let expected: ConnectionDescriptor | undefined;
    const { port } = await fixture((req, res) => {
      received.push({ path: req.url, authorization: req.headers.authorization });
      if (req.url === "/v1/health") {
        sendBounded(res, envelope({
          serviceVersion: expected?.serviceVersion,
          startNonce: expected?.startNonce,
          presentationMode: expected?.presentationMode,
          ready: true,
        }), "application/json; charset=utf-8");
      } else {
        sendBounded(res, envelope({
          serviceVersion: expected?.serviceVersion,
          startNonce: expected?.startNonce,
          presentationMode: expected?.presentationMode,
          runningSessions: 3,
          runningSessionsComputedAt: NOW,
          runningSessionsConfidence: "current",
          state: "active",
        }), "application/json; charset=utf-8");
      }
    });
    const prepared = await storeDescriptor(port, 12);
    expected = prepared.descriptor;
    await expect(adoptExistingControlService({ store: prepared.store, timeoutMs: 200 })).resolves.toEqual({
      descriptor: expected,
      presentationMode: "normal",
      runningSessions: 3,
    });
    expect(received).toEqual([
      { path: "/v1/health", authorization: undefined },
      { path: "/v1/session", authorization: `Bearer ${expected.bearerToken}` },
    ]);
  });

  it("never sends the bearer after the verified listener closes and its port is replaced", async () => {
    const foreignAuthorization: Array<string | undefined> = [];
    let expected: ConnectionDescriptor | undefined;
    let foreignReady!: () => void;
    const ready = new Promise<void>((resolve) => { foreignReady = resolve; });
    const first = createServer((_request, response) => {
      const body = envelope({
        serviceVersion: expected?.serviceVersion,
        startNonce: expected?.startNonce,
        presentationMode: expected?.presentationMode,
        ready: true,
      });
      response.writeHead(200, {
        connection: "close",
        "content-length": String(Buffer.byteLength(body, "utf8")),
        "content-type": "application/json",
      });
      response.end(body, () => {
        first.close(() => {
          const foreign = createServer((request, reply) => {
            foreignAuthorization.push(request.headers.authorization);
            sendBounded(reply, "{}");
          });
          servers.push(foreign);
          foreign.listen(expected?.port ?? 0, "127.0.0.1", foreignReady);
        });
      });
    });
    servers.push(first);
    await new Promise<void>((resolve, reject) => {
      first.once("error", reject);
      first.listen(0, "127.0.0.1", resolve);
    });
    const address = first.address();
    if (address === null || typeof address === "string") throw new Error("fixture did not bind TCP");
    const prepared = await storeDescriptor(address.port, 19);
    expected = prepared.descriptor;
    await expect(adoptExistingControlService({ store: prepared.store, timeoutMs: 500 }))
      .rejects.toMatchObject({ code: "ADOPTION_REFUSED" });
    await ready;
    expect(foreignAuthorization).toEqual([]);
  });

  it("applies an absolute deadline even while a responder drips bytes", async () => {
    const { port } = await fixture((_request, response) => {
      const body = envelope({
        serviceVersion: "0.1.0", startNonce: "f".repeat(32), presentationMode: "normal", ready: true,
      });
      response.writeHead(200, {
        "content-length": String(Buffer.byteLength(body, "utf8")),
        "content-type": "application/json",
      });
      let offset = 0;
      const timer = setInterval(() => {
        if (offset < body.length) response.write(body[offset]);
        offset += 1;
      }, 10);
      response.once("close", () => { clearInterval(timer); });
    });
    const { store } = await storeDescriptor(port, 20);
    const started = performance.now();
    await expect(adoptExistingControlService({ store, timeoutMs: 50 }))
      .rejects.toMatchObject({ code: "ADOPTION_TIMEOUT" });
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("strictly refuses malformed or unbounded HTTP response framing", async () => {
    const validBody = envelope({
      serviceVersion: "0.1.0", startNonce: "f".repeat(32), presentationMode: "normal", ready: true,
    });
    const complete = [
      "HTTP/1.0 200 OK\r\nContent-Length: 0\r\nContent-Type: application/json\r\n\r\n",
      "HTTP/1.1 200 OK\r\nBad Header: value\r\nContent-Length: 0\r\nContent-Type: application/json\r\n\r\n",
      "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nContent-Length: 0\r\nContent-Type: application/json\r\n\r\n",
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n0\r\n\r\n",
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n",
      `HTTP/1.1 200 OK\r\nX-Pad: ${"x".repeat(4_100)}\r\nContent-Length: 0\r\n\r\n`,
      "HTTP/1.1 200 OK\r\nX-Non-Ascii: \u0080\r\nContent-Length: 0\r\n\r\n",
    ];
    for (const [index, response] of complete.entries()) {
      const port = await rawFixture((socket) => { socket.write(response); });
      const { store } = await storeDescriptor(port, 30 + index);
      await expect(adoptExistingControlService({ store, timeoutMs: 200 }))
        .rejects.toMatchObject({ code: "ADOPTION_REFUSED" });
    }

    const partialPort = await rawFixture((socket) => {
      const header = `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(validBody, "utf8")}\r\nContent-Type: application/json\r\n\r\n`;
      socket.write(header.slice(0, 12));
      setTimeout(() => { socket.write(`${header.slice(12)}${validBody}`); }, 5);
    });
    const partial = await storeDescriptor(partialPort, 40);
    await expect(adoptExistingControlService({ store: partial.store, timeoutMs: 200 }))
      .rejects.toMatchObject({ code: "ADOPTION_REFUSED" });

    const headerFloodPort = await rawFixture((socket) => {
      socket.write("x".repeat(5_000));
    });
    const headerFlood = await storeDescriptor(headerFloodPort, 41);
    await expect(adoptExistingControlService({ store: headerFlood.store, timeoutMs: 200 }))
      .rejects.toMatchObject({ code: "ADOPTION_REFUSED" });

    const totalFloodPort = await rawFixture((socket) => {
      socket.write("x".repeat(13_000));
    });
    const totalFlood = await storeDescriptor(totalFloodPort, 42);
    await expect(adoptExistingControlService({ store: totalFlood.store, timeoutMs: 200 }))
      .rejects.toMatchObject({ code: "ADOPTION_REFUSED" });
  });

  it("refuses timeout, malformed JSON, and JSON-adjacent media types without a second request", async () => {
    for (const behavior of ["timeout", "malformed", "jsonp"] as const) {
      let requests = 0;
      const { server, port } = await fixture((_req, res) => {
        requests += 1;
        if (behavior === "timeout") return;
        sendBounded(res, "not-json", behavior === "jsonp" ? "application/jsonp" : "application/json");
      });
      const { store } = await storeDescriptor(port, behavior.length);
      await expect(adoptExistingControlService({ store, timeoutMs: 30 })).rejects.toMatchObject({
        code: behavior === "timeout" ? "ADOPTION_TIMEOUT" : "ADOPTION_REFUSED",
      });
      expect(requests).toBe(1);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      servers.splice(servers.indexOf(server), 1);
    }
  });

  it("refuses an oversized hostile reply before parsing it", async () => {
    let requests = 0;
    const { port } = await fixture((_req, res) => {
      requests += 1;
      sendBounded(res, "x".repeat(9_000));
    });
    const { store } = await storeDescriptor(port, 15);
    await expect(adoptExistingControlService({ store, timeoutMs: 200 })).rejects.toMatchObject({ code: "ADOPTION_REFUSED" });
    expect(requests).toBe(1);
  });

  it("refuses invalid health payloads, second-response identity drift, and transport failures", async () => {
    const { descriptor, store } = await storeDescriptor(45123, 16);
    const response = (payload: Record<string, unknown>) => ({
      statusCode: 200,
      contentType: "application/json",
      body: Buffer.from(envelope(payload)),
    });
    await expect(adoptExistingControlService({
      store,
      transport: { get: async () => response({
        serviceVersion: descriptor.serviceVersion,
        startNonce: descriptor.startNonce,
        presentationMode: descriptor.presentationMode,
        ready: false,
      }) },
    })).rejects.toMatchObject({ code: "ADOPTION_REFUSED" });

    let call = 0;
    await expect(adoptExistingControlService({
      store,
      transport: {
        get: async () => {
          call += 1;
          return call === 1
            ? response({
                serviceVersion: descriptor.serviceVersion,
                startNonce: descriptor.startNonce,
                presentationMode: descriptor.presentationMode,
                ready: true,
              })
            : response({
                serviceVersion: descriptor.serviceVersion,
                startNonce: "e".repeat(32),
                presentationMode: descriptor.presentationMode,
                runningSessions: 0,
                runningSessionsComputedAt: NOW,
                runningSessionsConfidence: "current",
                state: "active",
              });
        },
      },
    })).rejects.toMatchObject({ code: "ADOPTION_REFUSED" });

    call = 0;
    await expect(adoptExistingControlService({
      store,
      transport: {
        get: async () => {
          call += 1;
          return call === 1
            ? response({
                serviceVersion: descriptor.serviceVersion,
                startNonce: descriptor.startNonce,
                presentationMode: descriptor.presentationMode,
                ready: true,
              })
            : response({
                serviceVersion: descriptor.serviceVersion,
                startNonce: descriptor.startNonce,
                presentationMode: "developer",
                runningSessions: 0,
                runningSessionsComputedAt: NOW,
                runningSessionsConfidence: "current",
                state: "active",
              });
        },
      },
    })).rejects.toMatchObject({ code: "ADOPTION_REFUSED" });

    call = 0;
    await expect(adoptExistingControlService({
      store,
      transport: {
        get: async () => {
          call += 1;
          return call === 1
            ? response({
                serviceVersion: descriptor.serviceVersion,
                startNonce: descriptor.startNonce,
                presentationMode: descriptor.presentationMode,
                ready: true,
              })
            : response({
                serviceVersion: descriptor.serviceVersion,
                startNonce: descriptor.startNonce,
                presentationMode: descriptor.presentationMode,
                runningSessions: 10_001,
                runningSessionsComputedAt: NOW,
                runningSessionsConfidence: "current",
                state: "active",
              });
        },
      },
    })).rejects.toMatchObject({ code: "ADOPTION_REFUSED" });

    for (const temporalEvidence of [
      { runningSessionsComputedAt: NOW, runningSessionsConfidence: "stale" },
      {
        runningSessionsComputedAt: "2026-08-26T10:01:00.000Z",
        runningSessionsConfidence: "current",
      },
    ] as const) {
      call = 0;
      await expect(adoptExistingControlService({
        store,
        transport: {
          get: async () => {
            call += 1;
            return call === 1
              ? response({
                  serviceVersion: descriptor.serviceVersion,
                  startNonce: descriptor.startNonce,
                  presentationMode: descriptor.presentationMode,
                  ready: true,
                })
              : response({
                  serviceVersion: descriptor.serviceVersion,
                  startNonce: descriptor.startNonce,
                  presentationMode: descriptor.presentationMode,
                  runningSessions: 3,
                  ...temporalEvidence,
                  state: "active",
                });
          },
        },
      }), temporalEvidence.runningSessionsConfidence).rejects.toMatchObject({
        code: "ADOPTION_REFUSED",
      });
    }

    await expect(adoptExistingControlService({
      store,
      transport: { get: async () => { throw new Error("fixture failure"); } },
    })).rejects.toMatchObject({ code: "ADOPTION_REFUSED" });
    await expect(adoptExistingControlService({ store, timeoutMs: 1 })).rejects.toMatchObject({ code: "ADOPTION_REFUSED" });
  });
});
