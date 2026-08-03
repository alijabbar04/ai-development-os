import type { ProviderError } from "@ai-dev-os/providers";
import { isProcessBrokerError } from "@ai-dev-os/process-broker";
import type { CodexAdapterConfiguration } from "./config.js";
import { codexCancelled, codexNetworkFailure, codexProtocolViolation } from "./errors.js";
import { CodexJsonlDecoder } from "./jsonl.js";
import type { CodexProcessPort, CodexProcessRequest, CodexScheduler } from "./ports.js";
import { systemCodexScheduler } from "./ports.js";
import { mapCodexBrokerFailure } from "./process.js";
import {
  KNOWN_CODEX_NOTIFICATIONS,
  KNOWN_CODEX_SERVER_REQUESTS,
  parseCodexWireMessage,
  type CodexWireError,
  type CodexWireId,
  type CodexWireNotification,
  type CodexWireRequest,
} from "./wire.js";

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: ProviderError | CodexRpcError) => void;
  readonly timer: { cancel(): void };
  readonly removeAbort: () => void;
}

export class CodexRpcError extends Error {
  readonly rpcCode: number;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
  constructor(error: CodexWireError) {
    super("Codex App Server rejected an RPC request.");
    this.name = "CodexRpcError";
    this.rpcCode = error.code;
    const data = typeof error.data === "object" && error.data !== null && !Array.isArray(error.data) ? error.data as Record<string, unknown> : {};
    this.httpStatus = typeof data["httpStatusCode"] === "number" && Number.isSafeInteger(data["httpStatusCode"]) ? data["httpStatusCode"] : null;
    this.retryAfterMs = typeof data["retryAfterMs"] === "number" && Number.isSafeInteger(data["retryAfterMs"]) && data["retryAfterMs"] >= 0 ? data["retryAfterMs"] : null;
  }
}

export interface CodexConnection {
  request(method: string, params?: unknown, options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal }): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  onNotification(listener: (notification: CodexWireNotification) => void): () => void;
  readonly closed: boolean;
  readonly failure: ProviderError | null;
  readonly done: Promise<void>;
  close(): Promise<void>;
}

export async function connectCodexAppServer(input: {
  readonly configuration: CodexAdapterConfiguration;
  readonly process: CodexProcessPort;
  readonly request: CodexProcessRequest;
  readonly scheduler?: CodexScheduler;
  readonly handleServerRequest: (request: CodexWireRequest) => Promise<unknown>;
}): Promise<CodexConnection> {
  const scheduler = input.scheduler ?? systemCodexScheduler;
  const processSession = await input.process.open({ ...input.request, kind: "app-server", args: ["app-server", "--stdio", "--strict-config"] });
  const decoder = new CodexJsonlDecoder(input.configuration.jsonl);
  const pending = new Map<CodexWireId, Pending>();
  const completedIds = new Set<CodexWireId>();
  const listeners = new Set<(notification: CodexWireNotification) => void>();
  let nextId = 1;
  let initialized = false;
  let closing = false;
  let closed = false;
  let connectionFailure: ProviderError | null = null;

  const send = async (message: unknown): Promise<void> => {
    if (closed) throw connectionFailure ?? codexNetworkFailure({ phase: "write" });
    const text = JSON.stringify(message);
    const bytes = new TextEncoder().encode(`${text}\n`);
    if (bytes.byteLength > input.configuration.jsonl.maxRecordBytes) throw codexProtocolViolation("record-oversized");
    await processSession.write(bytes);
  };

  const fatal = (error: ProviderError): void => {
    if (closed) return;
    connectionFailure = error;
    closed = true;
    for (const entry of pending.values()) { entry.timer.cancel(); entry.removeAbort(); entry.reject(error); }
    pending.clear();
    void processSession.terminate();
  };

  const receive = async (text: string): Promise<void> => {
    const message = parseCodexWireMessage(text);
    if (message.kind === "response") {
      const entry = pending.get(message.id);
      if (entry === undefined) throw codexProtocolViolation(completedIds.has(message.id) ? "duplicate-response" : "unknown-request-id");
      pending.delete(message.id); entry.timer.cancel(); entry.removeAbort(); completedIds.add(message.id);
      if (completedIds.size > input.configuration.jsonl.maxPendingRequests * 4) completedIds.delete(completedIds.values().next().value!);
      if (message.error !== undefined) entry.reject(new CodexRpcError(message.error));
      else {
        if (entry.method === "initialize") initialized = true;
        entry.resolve(message.result);
      }
      return;
    }
    if (!initialized) throw codexProtocolViolation("not-initialized");
    if (message.kind === "request") {
      if (!KNOWN_CODEX_SERVER_REQUESTS.has(message.method)) throw codexProtocolViolation("unknown-state-changing-method");
      try { await send({ id: message.id, result: await input.handleServerRequest(message) }); }
      catch { await send({ id: message.id, error: { code: -32000, message: "Request declined by host policy." } }); }
      return;
    }
    if (!KNOWN_CODEX_NOTIFICATIONS.has(message.method)) throw codexProtocolViolation("unknown-state-changing-method");
    for (const listener of listeners) { try { listener(message); } catch { /* observers cannot break transport */ } }
  };

  const pump = async (): Promise<void> => {
    try {
      for await (const event of processSession.events) {
        if (event.stream !== "stdout") continue;
        for (const text of decoder.push(event.chunk)) await receive(text);
      }
      for (const text of decoder.finish()) await receive(text);
      const result = await processSession.result;
      if (!closing) fatal(result.failure === null
        ? codexNetworkFailure({ phase: "exit", processState: result.state })
        : mapCodexBrokerFailure(result.failure));
    } catch (error) {
      fatal(error instanceof Error && error.name === "ProviderError"
        ? error as ProviderError
        : isProcessBrokerError(error) ? mapCodexBrokerFailure(error) : codexProtocolViolation("connection-lost"));
    }
  };
  void pump();

  const request = async (method: string, params: unknown = undefined, options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<unknown> => {
    if (closed) throw connectionFailure ?? codexNetworkFailure();
    if (!initialized && method !== "initialize") throw codexProtocolViolation("not-initialized");
    if (pending.size >= input.configuration.jsonl.maxPendingRequests) throw codexProtocolViolation("pending-request-limit");
    if (nextId > input.configuration.jsonl.maxRequestId) throw codexProtocolViolation("pending-request-limit");
    const id = nextId++;
    const timeout = options.timeoutMs ?? (method === "initialize" ? input.configuration.deadlines.handshakeMs : input.configuration.deadlines.requestMs);
    return await new Promise<unknown>((resolve, reject) => {
      const timer = scheduler.delay(timeout);
      const onAbort = (): void => {
        const entry = pending.get(id); if (entry === undefined) return;
        pending.delete(id); timer.cancel(); entry.removeAbort(); reject(codexCancelled({ method }));
      };
      const removeAbort = (): void => options.signal?.removeEventListener("abort", onAbort);
      pending.set(id, { method, resolve, reject, timer, removeAbort });
      void timer.promise.then(() => {
        const entry = pending.get(id); if (entry === undefined) return;
        pending.delete(id); removeAbort(); reject(codexProtocolViolation("request-timeout", { method }));
      });
      if (options.signal?.aborted === true) { onAbort(); return; }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      void send(params === undefined ? { method, id } : { method, id, params }).catch((error) => {
        const entry = pending.get(id); if (entry === undefined) return;
        pending.delete(id); timer.cancel(); removeAbort(); reject(error);
      });
    });
  };

  await request("initialize", {
    clientInfo: { name: "ai_dev_os", title: "AI Development OS", version: "0.1.0" },
    capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: ["item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded"] },
  }, {
    timeoutMs: input.configuration.deadlines.handshakeMs,
    ...(input.request.signal === undefined ? {} : { signal: input.request.signal }),
  });
  await send({ method: "initialized" });

  return Object.freeze({
    request,
    notify: async (method: string, params?: unknown): Promise<void> => { if (!initialized) throw codexProtocolViolation("not-initialized"); await send(params === undefined ? { method } : { method, params }); },
    onNotification(listener: (notification: CodexWireNotification) => void): (() => void) { listeners.add(listener); return () => listeners.delete(listener); },
    get closed(): boolean { return closed; },
    get failure(): ProviderError | null { return connectionFailure; },
    done: processSession.result.then(() => undefined),
    async close(): Promise<void> {
      if (closing) { await processSession.result; return; }
      closing = true;
      for (const entry of pending.values()) { entry.timer.cancel(); entry.removeAbort(); entry.reject(codexCancelled({ phase: "connection-close" })); }
      pending.clear();
      await processSession.closeStdin();
      const timeout = scheduler.delay(input.configuration.deadlines.shutdownMs);
      await Promise.race([processSession.result.then(() => undefined), timeout.promise.then(async () => { await processSession.terminate(); })]);
      timeout.cancel(); closed = true;
    },
  });
}
