import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

/**
 * Deterministic fake Ollama HTTP server for Stage 7 tests.
 *
 * - binds an ephemeral port on 127.0.0.1 ONLY (never 0.0.0.0/::/LAN);
 * - scripts /api/tags, /api/show, /api/ps, /api/version, /api/generate and
 *   /api/chat, with per-route overrides for hostile scenarios;
 * - chat scripts are chunk lists: strings are written verbatim, holds park
 *   the response until release() or client abort, destroys drop the socket;
 * - records SAFE structural request summaries only (never prompt content,
 *   tool arguments, or generated text);
 * - close() destroys every open socket so no listener outlives a test.
 */

export interface FakeModelSpec {
  readonly name: string;
  readonly digest?: string;
  readonly size?: number;
  readonly modifiedAt?: string;
  readonly capabilities?: readonly string[];
  readonly contextLength?: number;
  readonly family?: string;
  readonly families?: readonly string[];
  readonly parameterSize?: string;
  readonly quantizationLevel?: string;
}

export interface FakeRunningModelSpec {
  readonly name: string;
  readonly digest?: string;
  readonly size?: number;
  readonly sizeVram?: number;
  readonly expiresAt?: string;
  readonly contextLength?: number;
}

export type FakeChatChunk =
  | string
  | { readonly holdUntilRelease: true }
  | { readonly destroySocket: true };

export interface FakeRoute {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly contentType?: string;
  /** Whole body for JSON routes. */
  readonly body?: string;
  /** Streamed chunks for the chat route. */
  readonly chunks?: readonly FakeChatChunk[];
}

export type FakeRouteFactory = FakeRoute | ((requestBody: Record<string, unknown>) => FakeRoute);

export interface FakeRequestSummary {
  readonly method: string;
  readonly path: string;
  readonly model: string | null;
  readonly messageCount: number | null;
  readonly hasTools: boolean;
  readonly format: "none" | "json" | "schema";
  readonly think: boolean | string | null;
  readonly keepAlive: string | number | null;
  readonly stream: boolean | null;
}

export interface FakeOllamaServerOptions {
  readonly models?: readonly FakeModelSpec[];
  readonly running?: readonly FakeRunningModelSpec[];
  readonly version?: string;
  readonly chat?: FakeRouteFactory;
  readonly overrides?: Partial<
    Record<"tags" | "show" | "ps" | "version" | "generate" | "chat", FakeRouteFactory>
  >;
}

export interface FakeOllamaServer {
  readonly url: string;
  readonly requests: readonly FakeRequestSummary[];
  /** Resolves every parked hold (idempotent). */
  release(): void;
  close(): Promise<void>;
}

export function fakeDigest(seed: number): string {
  return seed.toString(16).padStart(2, "0").repeat(32).slice(0, 64);
}

export const DEFAULT_FAKE_MODEL_SPEC: FakeModelSpec = Object.freeze({
  name: "fake-model",
  digest: fakeDigest(1),
  size: 1_000_000,
  modifiedAt: "2026-08-01T00:00:00.000Z",
  capabilities: Object.freeze(["completion", "tools", "thinking"]),
  contextLength: 8_192,
  family: "llama",
  families: Object.freeze(["llama"]),
  parameterSize: "3.2B",
  quantizationLevel: "Q4_K_M",
});

function tagsBody(models: readonly FakeModelSpec[]): string {
  return JSON.stringify({
    models: models.map((model) => ({
      name: model.name,
      model: model.name,
      modified_at: model.modifiedAt ?? "2026-08-01T00:00:00.000Z",
      size: model.size ?? 1_000_000,
      digest: model.digest ?? fakeDigest(9),
      details: {
        format: "gguf",
        family: model.family ?? "llama",
        families: model.families ?? [model.family ?? "llama"],
        parameter_size: model.parameterSize ?? "3.2B",
        quantization_level: model.quantizationLevel ?? "Q4_K_M",
      },
    })),
  });
}

function showBody(model: FakeModelSpec): string {
  return JSON.stringify({
    details: {
      format: "gguf",
      family: model.family ?? "llama",
      families: model.families ?? [model.family ?? "llama"],
      parameter_size: model.parameterSize ?? "3.2B",
      quantization_level: model.quantizationLevel ?? "Q4_K_M",
    },
    capabilities: model.capabilities ?? ["completion"],
    model_info: {
      "general.architecture": model.family ?? "llama",
      [`${model.family ?? "llama"}.context_length`]: model.contextLength ?? 8_192,
    },
    modified_at: model.modifiedAt ?? "2026-08-01T00:00:00.000Z",
  });
}

function psBody(running: readonly FakeRunningModelSpec[]): string {
  return JSON.stringify({
    models: running.map((model) => ({
      name: model.name,
      model: model.name,
      size: model.size ?? 1_000_000,
      digest: model.digest ?? fakeDigest(9),
      details: {},
      expires_at: model.expiresAt ?? "2026-08-02T13:00:00.000Z",
      size_vram: model.sizeVram ?? model.size ?? 1_000_000,
      context_length: model.contextLength ?? 8_192,
    })),
  });
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const pieces: Buffer[] = [];
  for await (const chunk of request) {
    pieces.push(chunk as Buffer);
    if (Buffer.concat(pieces).byteLength > 10_000_000) {
      return {};
    }
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(pieces).toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function summarize(method: string, path: string, body: Record<string, unknown>): FakeRequestSummary {
  const format = body["format"];
  return Object.freeze({
    method,
    path,
    model: typeof body["model"] === "string" ? body["model"] : null,
    messageCount: Array.isArray(body["messages"]) ? body["messages"].length : null,
    hasTools: Array.isArray(body["tools"]) && body["tools"].length > 0,
    format: format === undefined || format === null ? ("none" as const) : format === "json" ? ("json" as const) : ("schema" as const),
    think:
      typeof body["think"] === "boolean" || typeof body["think"] === "string"
        ? (body["think"] as boolean | string)
        : null,
    keepAlive:
      typeof body["keep_alive"] === "string" || typeof body["keep_alive"] === "number"
        ? (body["keep_alive"] as string | number)
        : null,
    stream: typeof body["stream"] === "boolean" ? body["stream"] : null,
  });
}

export async function startFakeOllamaServer(
  options: FakeOllamaServerOptions = {},
): Promise<FakeOllamaServer> {
  const models = options.models ?? [DEFAULT_FAKE_MODEL_SPEC];
  const running = options.running ?? [];
  const requests: FakeRequestSummary[] = [];
  const sockets = new Set<Socket>();
  let released = false;
  const releaseWaiters: Array<() => void> = [];

  const releasePromise = (): Promise<void> =>
    released
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          releaseWaiters.push(resolve);
        });

  function resolveRoute(factory: FakeRouteFactory | undefined, body: Record<string, unknown>): FakeRoute | null {
    if (factory === undefined) {
      return null;
    }
    return typeof factory === "function" ? factory(body) : factory;
  }

  async function writeChatRoute(response: ServerResponse, route: FakeRoute): Promise<void> {
    const status = route.status ?? 200;
    response.writeHead(status, {
      "content-type": route.contentType ?? "application/x-ndjson",
      ...route.headers,
    });
    if (route.body !== undefined) {
      response.end(route.body);
      return;
    }
    for (const chunk of route.chunks ?? []) {
      if (response.destroyed || response.writableEnded) {
        return;
      }
      if (typeof chunk === "string") {
        response.write(chunk);
      } else if ("holdUntilRelease" in chunk) {
        await Promise.race([
          releasePromise(),
          new Promise<void>((resolve) => response.once("close", () => resolve())),
        ]);
        if (response.destroyed) {
          return;
        }
      } else {
        response.destroy();
        return;
      }
    }
    if (!response.destroyed && !response.writableEnded) {
      response.end();
    }
  }

  function writeJsonRoute(response: ServerResponse, route: FakeRoute): void {
    response.writeHead(route.status ?? 200, {
      "content-type": route.contentType ?? "application/json",
      ...route.headers,
    });
    response.end(route.body ?? "{}");
  }

  const server: Server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const method = request.method ?? "GET";
      const path = request.url ?? "/";
      const body = method === "POST" ? await readBody(request) : {};
      requests.push(summarize(method, path, body));

      const overrides = options.overrides ?? {};
      if (path === "/api/tags") {
        const route = resolveRoute(overrides.tags, body);
        writeJsonRoute(response, route ?? { body: tagsBody(models) });
        return;
      }
      if (path === "/api/show") {
        const route = resolveRoute(overrides.show, body);
        if (route !== null) {
          writeJsonRoute(response, route);
          return;
        }
        const model = models.find((candidate) => candidate.name === body["model"]);
        if (model === undefined) {
          writeJsonRoute(response, { status: 404, body: '{"error":"model not found"}' });
          return;
        }
        writeJsonRoute(response, { body: showBody(model) });
        return;
      }
      if (path === "/api/ps") {
        const route = resolveRoute(overrides.ps, body);
        writeJsonRoute(response, route ?? { body: psBody(running) });
        return;
      }
      if (path === "/api/version") {
        const route = resolveRoute(overrides.version, body);
        writeJsonRoute(response, route ?? { body: JSON.stringify({ version: options.version ?? "0.12.0" }) });
        return;
      }
      if (path === "/api/generate") {
        const route = resolveRoute(overrides.generate, body);
        writeJsonRoute(
          response,
          route ?? {
            body: JSON.stringify({
              model: body["model"] ?? "unknown",
              created_at: "2026-08-02T12:00:00.000Z",
              response: "",
              done: true,
              done_reason: body["keep_alive"] === 0 ? "unload" : "load",
            }),
          },
        );
        return;
      }
      if (path === "/api/chat") {
        const route =
          resolveRoute(overrides.chat, body) ?? resolveRoute(options.chat, body) ?? {
            chunks: ['{"model":"fake-model","message":{"role":"assistant","content":"ok"},"done":false}\n'],
          };
        await writeChatRoute(response, route);
        return;
      }
      writeJsonRoute(response, { status: 404, body: '{"error":"unknown route"}' });
    })().catch(() => {
      if (!response.destroyed && !response.writableEnded) {
        response.destroy();
      }
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    release(): void {
      released = true;
      for (const wake of releaseWaiters.splice(0, releaseWaiters.length)) {
        wake();
      }
    },
    async close(): Promise<void> {
      released = true;
      for (const wake of releaseWaiters.splice(0, releaseWaiters.length)) {
        wake();
      }
      for (const socket of [...sockets]) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/** Builds one NDJSON chat record line. */
export function chatLine(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

export function contentRecord(content: string, model = "fake-model"): string {
  return chatLine({
    model,
    created_at: "2026-08-02T12:00:00.000Z",
    message: { role: "assistant", content },
    done: false,
  });
}

export function thinkingRecord(thinking: string, model = "fake-model"): string {
  return chatLine({
    model,
    created_at: "2026-08-02T12:00:00.000Z",
    message: { role: "assistant", content: "", thinking },
    done: false,
  });
}

export function toolCallRecord(
  calls: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[],
  model = "fake-model",
): string {
  return chatLine({
    model,
    created_at: "2026-08-02T12:00:00.000Z",
    message: {
      role: "assistant",
      content: "",
      tool_calls: calls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })),
    },
    done: false,
  });
}

export function doneRecord(
  overrides: Record<string, unknown> = {},
  model = "fake-model",
): string {
  return chatLine({
    model,
    created_at: "2026-08-02T12:00:01.000Z",
    message: { role: "assistant", content: "" },
    done: true,
    done_reason: "stop",
    total_duration: 1_000_000_000,
    load_duration: 50_000_000,
    prompt_eval_count: 10,
    prompt_eval_duration: 100_000_000,
    eval_count: 5,
    eval_duration: 200_000_000,
    ...overrides,
  });
}
