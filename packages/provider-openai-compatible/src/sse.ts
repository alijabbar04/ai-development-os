import { parseJsonText, type JsonValue } from "@ai-dev-os/domain";
import { ProviderError } from "@ai-dev-os/providers";

export async function* parseChatCompletionSse(body: AsyncIterable<Uint8Array>, limits: { readonly maxStreamBytes: number; readonly maxEventBytes: number }): AsyncIterable<JsonValue> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let total = 0;
  let done = false;
  function parseBlock(block: string): JsonValue | null {
    const lines = block.replace(/\r\n/gu, "\n").split("\n");
    const data: string[] = [];
    for (const line of lines) {
      if (line === "" || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) throw new ProviderError("PROTOCOL_VIOLATION", "The SSE stream contained an unsupported field.", {});
      data.push(line.slice(5).replace(/^ /u, ""));
    }
    if (data.length === 0) return null;
    const payload = data.join("\n");
    if (Buffer.byteLength(payload, "utf8") > limits.maxEventBytes) throw new ProviderError("MALFORMED_RESPONSE", "An SSE event exceeded the configured byte limit.", { maximum: limits.maxEventBytes });
    if (payload === "[DONE]") { done = true; return null; }
    if (done) throw new ProviderError("PROTOCOL_VIOLATION", "The SSE stream continued after [DONE].", {});
    try { return parseJsonText(payload, "sse.data"); } catch { throw new ProviderError("MALFORMED_RESPONSE", "An SSE data event was not valid bounded JSON.", {}); }
  }
  try {
    for await (const chunk of body) {
      total += chunk.byteLength;
      if (total > limits.maxStreamBytes) throw new ProviderError("MALFORMED_RESPONSE", "The SSE stream exceeded the configured byte limit.", { maximum: limits.maxStreamBytes });
      buffer += decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(buffer, "utf8") > limits.maxEventBytes * 2) throw new ProviderError("MALFORMED_RESPONSE", "The unterminated SSE buffer exceeded its bound.", {});
      for (;;) {
        const match = /\r?\n\r?\n/u.exec(buffer);
        if (match === null) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = parseBlock(block);
        if (parsed !== null) yield parsed;
      }
    }
    buffer += decoder.decode();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("MALFORMED_RESPONSE", "The SSE stream was not valid UTF-8.", {});
  }
  if (buffer.trim().length > 0) {
    const parsed = parseBlock(buffer);
    if (parsed !== null) yield parsed;
  }
  if (!done) throw new ProviderError("PROTOCOL_VIOLATION", "The SSE stream ended without [DONE].", {});
}
