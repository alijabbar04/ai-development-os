import { createServer, request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adoptExistingControlService,
  createControlArtifactStore,
  createLaunchIdentity,
  type ConnectionDescriptor,
} from "../src/index.js";

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const NOW = "2026-08-26T10:00:00.000Z";

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function envelope(payload: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: 1, sequence: 1, serverNow: NOW, productionEnabled: false,
    ok: true, kind: "success", payload,
  });
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
    processId: process.pid, ...identity,
  };
  await store.writeDescriptor(descriptor);
  return { descriptor, store };
}

describe("C3 nonce-before-bearer adoption", () => {
  it("sends no authorization to a nonce-mismatched hostile listener", async () => {
    const received: Array<string | undefined> = [];
    const { port } = await fixture((req, res) => {
      received.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(envelope({ serviceVersion: "0.1.0", startNonce: "f".repeat(32), ready: true }));
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
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      if (req.url === "/v1/health") {
        res.end(envelope({ serviceVersion: expected?.serviceVersion, startNonce: expected?.startNonce, ready: true }));
      } else {
        res.end(envelope({ serviceVersion: expected?.serviceVersion, startNonce: expected?.startNonce, state: "active" }));
      }
    });
    const prepared = await storeDescriptor(port, 12);
    expected = prepared.descriptor;
    await expect(adoptExistingControlService({ store: prepared.store, timeoutMs: 200 })).resolves.toEqual(expected);
    expect(received).toEqual([
      { path: "/v1/health", authorization: undefined },
      { path: "/v1/session", authorization: `Bearer ${expected.bearerToken}` },
    ]);
  });

  it("refuses timeout, malformed JSON, and JSON-adjacent media types without a second request", async () => {
    for (const behavior of ["timeout", "malformed", "jsonp"] as const) {
      let requests = 0;
      const { server, port } = await fixture((_req, res) => {
        requests += 1;
        if (behavior === "timeout") return;
        res.writeHead(200, { "content-type": behavior === "jsonp" ? "application/jsonp" : "application/json" });
        res.end("not-json");
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
      res.writeHead(200, { "content-type": "application/json" });
      res.end("x".repeat(9_000));
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
      transport: { get: async () => response({ serviceVersion: descriptor.serviceVersion, startNonce: descriptor.startNonce, ready: false }) },
    })).rejects.toMatchObject({ code: "ADOPTION_REFUSED" });

    let call = 0;
    await expect(adoptExistingControlService({
      store,
      transport: {
        get: async () => {
          call += 1;
          return call === 1
            ? response({ serviceVersion: descriptor.serviceVersion, startNonce: descriptor.startNonce, ready: true })
            : response({ serviceVersion: descriptor.serviceVersion, startNonce: "e".repeat(32), state: "active" });
        },
      },
    })).rejects.toMatchObject({ code: "ADOPTION_REFUSED" });

    await expect(adoptExistingControlService({
      store,
      transport: { get: async () => { throw new Error("fixture failure"); } },
    })).rejects.toMatchObject({ code: "ADOPTION_REFUSED" });
    await expect(adoptExistingControlService({ store, timeoutMs: 1 })).rejects.toMatchObject({ code: "ADOPTION_REFUSED" });
  });
});
