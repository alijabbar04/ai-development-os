import { ProviderError } from "@ai-dev-os/providers";
import type { GeminiHttpRequest, GeminiHttpResponse, GeminiHttpTransport } from "./types.js";

async function* bodyBytes(response: Response, maximum: number, abortCause: () => "caller" | "timeout" | null, cleanup: () => void): AsyncIterable<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    if (response.body === null) return;
    reader = response.body.getReader(); let total = 0;
    for (;;) { const part = await reader.read(); if (part.done) return; total += part.value.byteLength; if (total > maximum) throw new ProviderError("MALFORMED_RESPONSE", "Gemini response exceeded the configured byte bound.", { maximum }); yield part.value; }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const cause = abortCause();
    if (cause !== null) throw new ProviderError(cause === "caller" ? "CANCELLED" : "TIMEOUT", "The Gemini response stream did not complete.", { causeName: error instanceof Error ? error.name : typeof error });
    throw new ProviderError("MALFORMED_RESPONSE", "The Gemini response stream failed.", { causeName: error instanceof Error ? error.name : typeof error });
  } finally { reader?.releaseLock(); cleanup(); }
}

export function createFetchGeminiTransport(fetchLike: typeof fetch = fetch): GeminiHttpTransport {
  return Object.freeze({ async send(request: GeminiHttpRequest): Promise<GeminiHttpResponse> {
    const controller = new AbortController(); let abortCause: "caller" | "timeout" | null = null;
    const abort = (cause: "caller" | "timeout") => { if (abortCause === null) abortCause = cause; controller.abort(); };
    const timer = setTimeout(() => abort("timeout"), request.timeoutMs);
    const cleanup = () => clearTimeout(timer);
    if (request.signal?.aborted === true) abort("caller"); else request.signal?.addEventListener("abort", () => abort("caller"), { once: true });
    try {
      const response = await fetchLike(request.url, { method: "POST", headers: request.headers, body: request.body, redirect: "manual", signal: controller.signal });
      if (response.status >= 300 && response.status < 400) { cleanup(); throw new ProviderError("PROTOCOL_VIOLATION", "Gemini redirects are rejected.", { status: response.status }); }
      const headers: Record<string, string> = {}; for (const [key, value] of response.headers.entries()) headers[key.toLowerCase()] = value.slice(0, 2_048);
      return Object.freeze({ status: response.status, headers: Object.freeze(headers), body: bodyBytes(response, request.maxResponseBytes, () => abortCause, cleanup) });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      cleanup();
      const code = abortCause === "caller" ? "CANCELLED" : abortCause === "timeout" ? "TIMEOUT" : "NETWORK_FAILURE";
      throw new ProviderError(code, "The Gemini request did not complete.", { causeName: error instanceof Error ? error.name : typeof error });
    }
  } });
}

export async function readGeminiBody(body: AsyncIterable<Uint8Array>, maximum: number): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true }); let total = 0; let output = "";
  try { for await (const part of body) { total += part.byteLength; if (total > maximum) throw new ProviderError("MALFORMED_RESPONSE", "Gemini response exceeded the configured byte bound.", { maximum }); output += decoder.decode(part, { stream: true }); } output += decoder.decode(); return output; }
  catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError("MALFORMED_RESPONSE", "Gemini returned invalid UTF-8.", {}); }
}

export async function* parseGeminiSse(body: AsyncIterable<Uint8Array>, limits: { readonly stream: number; readonly event: number }): AsyncIterable<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true }); let total = 0; let buffer = "";
  const block = (raw: string): string | null => { const data: string[] = []; for (const line of raw.replace(/\r\n/gu, "\n").split("\n")) { if (line === "" || line.startsWith(":")) continue; if (!line.startsWith("data:")) throw new ProviderError("PROTOCOL_VIOLATION", "Gemini SSE contained an unsupported field.", {}); data.push(line.slice(5).replace(/^ /u, "")); } if (data.length === 0) return null; const value = data.join("\n"); if (Buffer.byteLength(value) > limits.event) throw new ProviderError("MALFORMED_RESPONSE", "Gemini SSE event exceeded its bound.", {}); return value; };
  try {
    for await (const part of body) { total += part.byteLength; if (total > limits.stream) throw new ProviderError("MALFORMED_RESPONSE", "Gemini SSE stream exceeded its bound.", {}); buffer += decoder.decode(part, { stream: true }); if (Buffer.byteLength(buffer) > limits.event * 2) throw new ProviderError("MALFORMED_RESPONSE", "Gemini SSE buffer exceeded its bound.", {}); for (;;) { const match = /\r?\n\r?\n/u.exec(buffer); if (match === null) break; const value = block(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length); if (value !== null) yield value; } }
    buffer += decoder.decode();
  } catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError("MALFORMED_RESPONSE", "Gemini SSE was invalid UTF-8.", {}); }
  if (buffer.trim().length > 0) { const value = block(buffer); if (value !== null) yield value; }
}
