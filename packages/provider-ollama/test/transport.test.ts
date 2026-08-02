import { describe, expect, it } from "vitest";
import { isProviderError } from "@ai-dev-os/providers";
import { createManualScheduler } from "@ai-dev-os/provider-testkit";
import {
  MAX_ERROR_BODY_BYTES,
  createFetchOllamaTransport,
  ollamaSchedulerFromManual,
  parseOllamaEndpoint,
  systemOllamaScheduler,
  type OllamaTransport,
} from "../src/index.js";
import { startFakeOllamaServer, type FakeOllamaServer } from "./helpers/fake-ollama-server.js";

async function withTransport(
  serverOptions: Parameters<typeof startFakeOllamaServer>[0],
  run: (transport: OllamaTransport, server: FakeOllamaServer) => Promise<void>,
): Promise<void> {
  const server = await startFakeOllamaServer(serverOptions);
  const transport = createFetchOllamaTransport({ endpoint: parseOllamaEndpoint(server.url) });
  try {
    await run(transport, server);
  } finally {
    transport.close();
    await server.close();
  }
}

describe("fetch transport", () => {
  it("returns parsed JSON with retry-after metadata on non-success statuses", async () => {
    await withTransport(
      {
        overrides: {
          version: { status: 429, headers: { "retry-after": "3" }, body: '{"error":"slow down"}' },
        },
      },
      async (transport) => {
        const response = await transport.requestJson("version", null, { timeoutMs: 5_000 });
        expect(response.status).toBe(429);
        expect(response.retryAfterMs).toBe(3_000);
        expect(response.value).toEqual({ error: "slow down" });
      },
    );
  });

  it("ignores malformed retry-after headers and unparsable error bodies", async () => {
    await withTransport(
      {
        overrides: {
          version: { status: 500, headers: { "retry-after": "soon" }, body: "not json at all" },
        },
      },
      async (transport) => {
        const response = await transport.requestJson("version", null, { timeoutMs: 5_000 });
        expect(response.status).toBe(500);
        expect(response.retryAfterMs).toBeNull();
        expect(response.value).toBeNull();
      },
    );
  });

  it("rejects unexpected content types and unparsable success bodies", async () => {
    await withTransport(
      { overrides: { version: { contentType: "text/html", body: "<html></html>" } } },
      async (transport) => {
        await expect(transport.requestJson("version", null, { timeoutMs: 5_000 })).rejects.toSatisfy(
          (error: unknown) => isProviderError(error, "MALFORMED_RESPONSE"),
        );
      },
    );
    await withTransport(
      { overrides: { version: { body: "{broken" } } },
      async (transport) => {
        await expect(transport.requestJson("version", null, { timeoutMs: 5_000 })).rejects.toSatisfy(
          (error: unknown) => isProviderError(error, "MALFORMED_RESPONSE"),
        );
      },
    );
  });

  it("bounds error response bodies", async () => {
    await withTransport(
      {
        overrides: {
          version: { status: 500, body: `{"pad":"${"x".repeat(MAX_ERROR_BODY_BYTES * 2)}"}` },
        },
      },
      async (transport) => {
        await expect(transport.requestJson("version", null, { timeoutMs: 5_000 })).rejects.toSatisfy(
          (error: unknown) => isProviderError(error, "MALFORMED_RESPONSE"),
        );
      },
    );
  });

  it("aborts requests whose scheduler timeout fires", async () => {
    const manual = createManualScheduler();
    const server = await startFakeOllamaServer({
      chat: { chunks: ['{"model":"fake-model","done":false}\n', { holdUntilRelease: true }] },
    });
    const transport = createFetchOllamaTransport({
      endpoint: parseOllamaEndpoint(server.url),
      scheduler: ollamaSchedulerFromManual(manual),
    });
    try {
      const response = await transport.requestStream("chat", { model: "fake-model" } as never, {
        timeoutMs: 10_000,
      });
      expect(response.ok).toBe(true);
      const reads = (async () => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of response.chunks()) {
          chunks.push(chunk);
        }
        return chunks;
      })();
      manual.advance(10_000);
      await expect(reads).rejects.toSatisfy((error: unknown) => isProviderError(error, "TIMEOUT"));
    } finally {
      transport.close();
      await server.close();
    }
  });

  it("honors caller abort signals during header wait", async () => {
    await withTransport({}, async (transport) => {
      await expect(
        transport.requestJson("version", null, {
          timeoutMs: 5_000,
          signal: { aborted: true, addEventListener: () => undefined },
        }),
      ).rejects.toSatisfy((error: unknown) => isProviderError(error, "CANCELLED"));
    });
  });

  it("stream responses are single-use and expose no stream on failure statuses", async () => {
    await withTransport(
      { chat: { chunks: ['{"model":"fake-model","done":true}\n'] } },
      async (transport) => {
        const response = await transport.requestStream("chat", { model: "fake-model" } as never, {
          timeoutMs: 5_000,
        });
        for await (const chunk of response.chunks()) {
          expect(chunk.byteLength).toBeGreaterThan(0);
        }
        expect(() => response.chunks()).toThrow();
        response.abort();
      },
    );
    await withTransport(
      { overrides: { chat: { status: 500, body: '{"error":"boom"}' } } },
      async (transport) => {
        const response = await transport.requestStream("chat", { model: "fake-model" } as never, {
          timeoutMs: 5_000,
        });
        expect(response.ok).toBe(false);
        expect(response.errorValue).toEqual({ error: "boom" });
        expect(() => response.chunks()).toThrow();
      },
    );
  });

  it("the system scheduler measures real time and cancels delays", async () => {
    expect(systemOllamaScheduler.now().valueOf()).toBeGreaterThan(0);
    const delay = systemOllamaScheduler.delay(0);
    await delay.promise;
    const cancelled = systemOllamaScheduler.delay(60_000);
    cancelled.cancel();
    cancelled.cancel();
  });
});
