import {
  canonicalizeJson,
  toCanonicalJson,
  validation,
  type ArtifactId,
  type JsonValue,
} from "@ai-dev-os/domain";
import { ProviderError } from "./errors.js";
import { parseToolInvocation, parseToolResult, type ToolInvocation, type ToolResult } from "./tools.js";

const { ensureArray, ensureEnum, ensureExactKeys, ensureRecord, ensureString } = validation;

export const MESSAGE_ROLES = Object.freeze([
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
] as const);

export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const MAX_TEXT_PART_LENGTH = 262_144;
export const MAX_PARTS_PER_MESSAGE = 64;
export const MAX_MESSAGES = 256;
const MAX_JSON_PART_TEXT = 65_536;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

/**
 * Finite, runtime-validated content union. Binary payloads travel as
 * artifact references (Stage 4 byte store), never as unbounded inline
 * base64. Model-generated tool invocations and caller-provided tool
 * results are distinct part types and are legal only in the roles that
 * produce them.
 */
export type ContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "artifact";
      readonly artifactId: ArtifactId;
      readonly mediaType: string;
    }
  | {
      readonly type: "image-artifact";
      readonly artifactId: ArtifactId;
      readonly mediaType: string;
    }
  | { readonly type: "json"; readonly value: JsonValue }
  | { readonly type: "tool-invocation"; readonly invocation: ToolInvocation }
  | { readonly type: "tool-result"; readonly result: ToolResult };

const PART_TYPES = Object.freeze([
  "text",
  "artifact",
  "image-artifact",
  "json",
  "tool-invocation",
  "tool-result",
] as const);

function parseArtifactRef(record: Record<string, unknown>, path: string, image: boolean): {
  readonly artifactId: ArtifactId;
  readonly mediaType: string;
} {
  const mediaType = ensureString(record["mediaType"], `${path}.mediaType`, {
    maxLength: 128,
    pattern: MEDIA_TYPE_PATTERN,
    patternName: "media type",
  });
  if (image && !mediaType.startsWith("image/")) {
    throw new ProviderError("INVALID_REQUEST", "Image artifact parts require an image media type.", {
      path,
    });
  }
  return {
    artifactId: ensureString(record["artifactId"], `${path}.artifactId`, {
      maxLength: 128,
      pattern: ID_PATTERN,
      patternName: "ArtifactId",
    }) as ArtifactId,
    mediaType,
  };
}

export function parseContentPart(value: unknown, path = "contentPart"): ContentPart {
  const record = ensureRecord(value, path);
  const type = ensureEnum(record["type"], `${path}.type`, PART_TYPES);
  switch (type) {
    case "text": {
      ensureExactKeys(record, ["type", "text"], path);
      return Object.freeze({
        type,
        text: ensureString(record["text"], `${path}.text`, {
          minLength: 0,
          maxLength: MAX_TEXT_PART_LENGTH,
        }),
      });
    }
    case "artifact": {
      ensureExactKeys(record, ["type", "artifactId", "mediaType"], path);
      return Object.freeze({ type, ...parseArtifactRef(record, path, false) });
    }
    case "image-artifact": {
      ensureExactKeys(record, ["type", "artifactId", "mediaType"], path);
      return Object.freeze({ type, ...parseArtifactRef(record, path, true) });
    }
    case "json": {
      ensureExactKeys(record, ["type", "value"], path);
      const canonical = canonicalizeJson(record["value"], `${path}.value`);
      if (toCanonicalJson(canonical).length > MAX_JSON_PART_TEXT) {
        throw new ProviderError("INVALID_REQUEST", "A JSON content part is oversized.", {
          path,
          maximum: MAX_JSON_PART_TEXT,
        });
      }
      return Object.freeze({ type, value: canonical });
    }
    case "tool-invocation": {
      ensureExactKeys(record, ["type", "invocation"], path);
      return Object.freeze({
        type,
        invocation: parseToolInvocation(record["invocation"], `${path}.invocation`),
      });
    }
    case "tool-result": {
      ensureExactKeys(record, ["type", "result"], path);
      return Object.freeze({
        type,
        result: parseToolResult(record["result"], `${path}.result`),
      });
    }
  }
}

export interface ChatMessage {
  readonly role: MessageRole;
  readonly parts: readonly ContentPart[];
}

export function parseChatMessage(value: unknown, path = "message"): ChatMessage {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["role", "parts"], path);
  const role = ensureEnum(record["role"], `${path}.role`, MESSAGE_ROLES);
  const rawParts = ensureArray(record["parts"], `${path}.parts`, MAX_PARTS_PER_MESSAGE);
  if (rawParts.length === 0) {
    throw new ProviderError("INVALID_REQUEST", "A message requires at least one content part.", {
      path,
    });
  }
  const parts = rawParts.map((part, index) => {
    const parsed = parseContentPart(part, `${path}.parts[${index}]`);
    if (parsed.type === "tool-invocation" && role !== "assistant") {
      throw new ProviderError(
        "INVALID_REQUEST",
        "Tool invocations are model output and belong only to assistant messages.",
        { path: `${path}.parts[${index}]`, role },
      );
    }
    if (parsed.type === "tool-result" && role !== "tool") {
      throw new ProviderError(
        "INVALID_REQUEST",
        "Tool results are caller input and belong only to tool messages.",
        { path: `${path}.parts[${index}]`, role },
      );
    }
    return parsed;
  });
  return Object.freeze({ role, parts: Object.freeze(parts) });
}

/**
 * Validates a full conversation with the portable ordering rules:
 *
 * - system/developer messages appear only before the first other role;
 * - a tool message's results must reference tool-call ids introduced by an
 *   earlier assistant tool invocation, each at most once.
 */
export function parseConversation(value: unknown, path = "messages"): readonly ChatMessage[] {
  const rawMessages = ensureArray(value, path, MAX_MESSAGES);
  if (rawMessages.length === 0) {
    throw new ProviderError("INVALID_REQUEST", "A request requires at least one message.", { path });
  }
  const messages = rawMessages.map((message, index) =>
    parseChatMessage(message, `${path}[${index}]`),
  );

  let preambleEnded = false;
  const pendingToolCalls = new Set<string>();
  messages.forEach((message, index) => {
    if (message.role === "system" || message.role === "developer") {
      if (preambleEnded) {
        throw new ProviderError(
          "INVALID_REQUEST",
          "System and developer messages must precede the conversation.",
          { path: `${path}[${index}]` },
        );
      }
      return;
    }
    preambleEnded = true;
    for (const part of message.parts) {
      if (part.type === "tool-invocation") {
        pendingToolCalls.add(part.invocation.toolCallId);
      }
      if (part.type === "tool-result") {
        if (!pendingToolCalls.has(part.result.toolCallId)) {
          throw new ProviderError(
            "INVALID_REQUEST",
            "A tool result must answer a prior assistant tool invocation.",
            { path: `${path}[${index}]`, toolCallId: part.result.toolCallId },
          );
        }
        pendingToolCalls.delete(part.result.toolCallId);
      }
    }
  });

  return Object.freeze(messages);
}

/** Convenience constructors used pervasively in tests and callers. */
export function textPart(text: string): ContentPart {
  return parseContentPart({ type: "text", text });
}

export function userMessage(text: string): ChatMessage {
  return parseChatMessage({ role: "user", parts: [{ type: "text", text }] });
}

export function systemMessage(text: string): ChatMessage {
  return parseChatMessage({ role: "system", parts: [{ type: "text", text }] });
}
