import { ProviderError } from "@ai-dev-os/providers";
import type { HttpRequest, HttpResponse, HttpTransport } from "./types.js";

async function* responseBytes(response: Response, maximum: number, abortCause: () => "caller" | "timeout" | null, cleanup: () => void): AsyncIterable<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    if (response.body === null) return;
    reader = response.body.getReader();
    let total = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) return;
      total += item.value.byteLength;
      if (total > maximum) throw new ProviderError("MALFORMED_RESPONSE", "The provider response exceeded the configured byte limit.", { maximum });
      yield item.value;
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const cause = abortCause();
    if (cause !== null) throw new ProviderError(cause === "caller" ? "CANCELLED" : "TIMEOUT", "The provider response stream did not complete.", { causeName: error instanceof Error ? error.name : typeof error });
    throw new ProviderError("MALFORMED_RESPONSE", "The provider response stream failed.", { causeName: error instanceof Error ? error.name : typeof error });
  } finally {
    reader?.releaseLock();
    cleanup();
  }
}

export function createFetchHttpTransport(fetchLike: typeof fetch = fetch): HttpTransport {
  return Object.freeze({
    async send(request: HttpRequest): Promise<HttpResponse> {
      const controller = new AbortController();
      let abortCause: "caller" | "timeout" | null = null;
      const abort = (cause: "caller" | "timeout") => { if (abortCause === null) abortCause = cause; controller.abort(); };
      const timer = setTimeout(() => abort("timeout"), request.timeoutMs);
      const cleanup = () => clearTimeout(timer);
      if (request.signal?.aborted === true) abort("caller");
      else request.signal?.addEventListener("abort", () => abort("caller"), { once: true });
      let response: Response;
      try {
        response = await fetchLike(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: "manual", signal: controller.signal });
      } catch (error) {
        cleanup();
        const code = abortCause === "caller" ? "CANCELLED" : abortCause === "timeout" ? "TIMEOUT" : "NETWORK_FAILURE";
        throw new ProviderError(code, "The provider request did not complete.", { causeName: error instanceof Error ? error.name : typeof error });
      }
      if (response.status >= 300 && response.status < 400) { cleanup(); throw new ProviderError("PROTOCOL_VIOLATION", "Provider redirects are rejected.", { status: response.status }); }
      const headers: Record<string, string> = {};
      for (const [key, value] of response.headers.entries()) headers[key.toLowerCase()] = value.slice(0, 2_048);
      return Object.freeze({ status: response.status, headers: Object.freeze(headers), body: responseBytes(response, request.maxResponseBytes, () => abortCause, cleanup) });
    },
  });
}

export async function readBoundedBody(body: AsyncIterable<Uint8Array>, maximum: number): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    for await (const chunk of body) {
      total += chunk.byteLength;
      if (total > maximum) throw new ProviderError("MALFORMED_RESPONSE", "The provider response exceeded the configured byte limit.", { maximum });
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("MALFORMED_RESPONSE", "The provider returned invalid UTF-8.", {});
  }
}
