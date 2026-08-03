import { ProviderError } from "@ai-dev-os/providers";
import type { HttpRequest, HttpResponse, HttpTransport } from "./types.js";

async function* responseBytes(response: Response, maximum: number): AsyncIterable<Uint8Array> {
  if (response.body === null) return;
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return;
      total += item.value.byteLength;
      if (total > maximum) throw new ProviderError("MALFORMED_RESPONSE", "The provider response exceeded the configured byte limit.", { maximum });
      yield item.value;
    }
  } finally { reader.releaseLock(); }
}

export function createFetchHttpTransport(fetchLike: typeof fetch = fetch): HttpTransport {
  return Object.freeze({
    async send(request: HttpRequest): Promise<HttpResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      request.signal?.addEventListener("abort", () => controller.abort(), { once: true });
      let response: Response;
      try {
        response = await fetchLike(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: "manual", signal: controller.signal });
      } catch (error) {
        throw new ProviderError(controller.signal.aborted ? "TIMEOUT" : "NETWORK_FAILURE", "The provider request did not complete.", { causeName: error instanceof Error ? error.name : typeof error });
      } finally { clearTimeout(timer); }
      if (response.status >= 300 && response.status < 400) throw new ProviderError("PROTOCOL_VIOLATION", "Provider redirects are rejected.", { status: response.status });
      const headers: Record<string, string> = {};
      for (const [key, value] of response.headers.entries()) headers[key.toLowerCase()] = value.slice(0, 2_048);
      return Object.freeze({ status: response.status, headers: Object.freeze(headers), body: responseBytes(response, request.maxResponseBytes) });
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
