import { toCanonicalJson, type JsonValue } from "@ai-dev-os/domain";
import {
  ProviderError,
  type ChatMessage,
  type ContentPart,
  type InferenceRequest,
  type ProviderExtension,
} from "@ai-dev-os/providers";
import {
  OPENAI_EXTENSION_NAMESPACE,
  type OpenAiAdapterConfiguration,
} from "./config.js";
import {
  OPENAI_REASONING_EFFORTS,
  type OpenAiCatalogEntry,
  type OpenAiReasoningEffort,
} from "./catalog.js";
import { unsupportedCapabilityError } from "./errors.js";
import { assertSafetyIdentifier } from "./safety.js";

/**
 * Mapping from the Stage 5 finite request model onto the Responses API
 * request body.
 *
 * Roles are preserved rather than flattened, structured data keeps its
 * canonical JSON form, artifact references are resolved only through an
 * authorized resolver, and every unsupported construct is rejected BEFORE
 * any network access so nothing is disclosed on a request that cannot be
 * served.
 */

const STRUCTURED_OUTPUT_FORMAT_NAME = "structured_output";

/** Request-scoped adapter options, all of which may only tighten policy. */
export interface OpenAiRequestOptions {
  readonly reasoningEffort: OpenAiReasoningEffort | null;
  readonly discloseReasoning: boolean;
  readonly background: boolean;
  readonly store: boolean;
  readonly maxOutputTokens: number | null;
}

function extensionError(detailCode: string, details: Record<string, string> = {}): ProviderError {
  return unsupportedCapabilityError(detailCode, details);
}

/**
 * Parses `openai` namespace request extensions.
 *
 * Extensions may only tighten: they can lower an output bound, disable
 * reasoning disclosure, decline background execution, and decline
 * persistence. They can never widen a limit, enable persistence, enable
 * background mode the policy forbids, or turn disclosure on.
 */
export function parseRequestExtensions(
  extensions: readonly ProviderExtension[],
  configuration: OpenAiAdapterConfiguration,
  entry: OpenAiCatalogEntry,
  requestMaxOutputTokens: number | null,
): OpenAiRequestOptions {
  let reasoningEffort = configuration.reasoning.effort;
  let discloseReasoning = configuration.reasoning.discloseReasoning;
  let background = configuration.background.mode === "required";
  let store = configuration.storage.store === "when-authorized";
  let maxOutputTokens = requestMaxOutputTokens;

  for (const extension of extensions) {
    if (extension.namespace !== OPENAI_EXTENSION_NAMESPACE) {
      throw extensionError("unknown-extension-namespace", { namespace: extension.namespace });
    }
    const value = extension.value;
    switch (extension.key) {
      case "reasoning-effort": {
        if (typeof value !== "string" || !(OPENAI_REASONING_EFFORTS as readonly string[]).includes(value)) {
          throw extensionError("invalid-reasoning-effort");
        }
        if (!entry.supportedReasoningEfforts.includes(value as OpenAiReasoningEffort)) {
          throw extensionError("reasoning-effort-not-permitted", { effort: value });
        }
        reasoningEffort = value as OpenAiReasoningEffort;
        break;
      }
      case "disclose-reasoning": {
        if (typeof value !== "boolean") {
          throw extensionError("invalid-disclose-reasoning");
        }
        if (value && !configuration.reasoning.discloseReasoning) {
          throw extensionError("cannot-widen-reasoning-disclosure");
        }
        discloseReasoning = discloseReasoning && value;
        break;
      }
      case "background": {
        if (typeof value !== "boolean") {
          throw extensionError("invalid-background");
        }
        if (value) {
          if (configuration.background.mode === "disabled") {
            throw extensionError("background-not-permitted");
          }
          background = true;
        } else {
          if (configuration.background.mode === "required") {
            throw extensionError("background-required");
          }
          background = false;
        }
        break;
      }
      case "store": {
        if (typeof value !== "boolean") {
          throw extensionError("invalid-store");
        }
        if (value) {
          throw extensionError("cannot-widen-storage");
        }
        store = false;
        break;
      }
      case "max-output-tokens": {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
          throw extensionError("invalid-max-output-tokens");
        }
        if (maxOutputTokens !== null && value > maxOutputTokens) {
          throw extensionError("cannot-widen-max-output-tokens");
        }
        maxOutputTokens = value;
        break;
      }
      default:
        throw extensionError("unknown-extension-key", { key: extension.key });
    }
  }

  if (reasoningEffort !== null && !entry.supportsReasoning) {
    // A configured default must not be sent to a model that rejects it.
    reasoningEffort = null;
  }
  if (reasoningEffort !== null && !entry.supportedReasoningEfforts.includes(reasoningEffort)) {
    throw extensionError("configured-reasoning-effort-unsupported", { effort: reasoningEffort });
  }
  if (discloseReasoning && !entry.supportsReasoning) {
    discloseReasoning = false;
  }

  return Object.freeze({ reasoningEffort, discloseReasoning, background, store, maxOutputTokens });
}

// ---------------------------------------------------------------------------
// Content mapping
// ---------------------------------------------------------------------------

/** An image already resolved to inline bytes by an authorized resolver. */
export interface ResolvedImage {
  readonly artifactId: string;
  readonly dataUrl: string;
}

function textOfPart(part: ContentPart): string | null {
  if (part.type === "text") {
    return part.text;
  }
  if (part.type === "json") {
    // Structured input keeps its canonical form rather than being
    // re-serialized with arbitrary key ordering.
    return toCanonicalJson(part.value);
  }
  return null;
}

function assistantText(message: ChatMessage): string {
  const pieces: string[] = [];
  for (const part of message.parts) {
    const text = textOfPart(part);
    if (text !== null) {
      pieces.push(text);
    }
  }
  return pieces.join("\n\n");
}

export interface InputMappingOptions {
  readonly entry: OpenAiCatalogEntry;
  /** Images pre-resolved by the caller, keyed by artifact id. */
  readonly resolvedImages: ReadonlyMap<string, ResolvedImage>;
}

/**
 * Reports which artifact ids a request needs resolved, so the provider can
 * run disclosure checks and authorized reads BEFORE mapping and before any
 * network access. Non-image artifacts are rejected here: no current
 * provider-neutral contract authorizes uploading arbitrary files.
 */
export function collectImageArtifacts(request: InferenceRequest, entry: OpenAiCatalogEntry): readonly {
  readonly artifactId: string;
  readonly mediaType: string;
}[] {
  const needed: { artifactId: string; mediaType: string }[] = [];
  for (const message of request.messages) {
    for (const part of message.parts) {
      if (part.type === "artifact") {
        throw unsupportedCapabilityError("artifact-content-unsupported", { partType: part.type });
      }
      if (part.type !== "image-artifact") {
        continue;
      }
      if (message.role !== "user") {
        throw unsupportedCapabilityError("image-only-in-user-messages", { role: message.role });
      }
      if (!entry.supportsVision) {
        throw unsupportedCapabilityError("model-lacks-vision", { modelId: entry.modelId });
      }
      needed.push({ artifactId: part.artifactId as string, mediaType: part.mediaType });
    }
  }
  return Object.freeze(needed);
}

function mapUserContent(message: ChatMessage, options: InputMappingOptions): readonly JsonValue[] {
  const content: JsonValue[] = [];
  for (const part of message.parts) {
    if (part.type === "image-artifact") {
      const resolved = options.resolvedImages.get(part.artifactId as string);
      if (resolved === undefined) {
        // Never inline an artifact the authorized resolver did not return.
        throw unsupportedCapabilityError("unresolved-image-artifact");
      }
      content.push({ type: "input_image", image_url: resolved.dataUrl, detail: "auto" } as JsonValue);
      continue;
    }
    const text = textOfPart(part);
    if (text === null) {
      throw unsupportedCapabilityError("unsupported-content-part", { partType: part.type });
    }
    content.push({ type: "input_text", text } as JsonValue);
  }
  return content;
}

function mapInstructionContent(message: ChatMessage): readonly JsonValue[] {
  const content: JsonValue[] = [];
  for (const part of message.parts) {
    const text = textOfPart(part);
    if (text === null) {
      throw unsupportedCapabilityError("unsupported-instruction-part", { partType: part.type });
    }
    content.push({ type: "input_text", text } as JsonValue);
  }
  return content;
}

/**
 * Maps the conversation onto Responses input items.
 *
 * `system` and `developer` keep their distinct roles — the API defines both
 * and documents their precedence over `user`, so collapsing them would
 * change instruction-following semantics. Assistant tool invocations become
 * `function_call` items and tool results become `function_call_output`
 * items, which is the only shape the API accepts for a continuation.
 */
export function mapMessagesToInput(
  request: InferenceRequest,
  options: InputMappingOptions,
): readonly JsonValue[] {
  const input: JsonValue[] = [];
  for (const message of request.messages) {
    switch (message.role) {
      case "system":
      case "developer":
        input.push({
          type: "message",
          role: message.role,
          content: mapInstructionContent(message),
        } as JsonValue);
        break;
      case "user":
        input.push({
          type: "message",
          role: "user",
          content: mapUserContent(message, options),
        } as JsonValue);
        break;
      case "assistant": {
        const text = assistantText(message);
        if (text.length > 0) {
          input.push({ type: "message", role: "assistant", content: text } as JsonValue);
        }
        for (const part of message.parts) {
          if (part.type !== "tool-invocation") {
            continue;
          }
          input.push({
            type: "function_call",
            call_id: part.invocation.toolCallId as string,
            name: part.invocation.toolName as string,
            arguments: toCanonicalJson(part.invocation.arguments),
          } as JsonValue);
        }
        break;
      }
      case "tool":
        for (const part of message.parts) {
          if (part.type !== "tool-result") {
            throw unsupportedCapabilityError("tool-message-requires-tool-result");
          }
          const output =
            part.result.status === "succeeded"
              ? toCanonicalJson(part.result.output)
              : toCanonicalJson({ error: part.result.failure });
          input.push({
            type: "function_call_output",
            call_id: part.result.toolCallId as string,
            output,
          } as JsonValue);
        }
        break;
    }
  }
  return Object.freeze(input);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Maps provider-neutral tool declarations onto custom function tools with
 * exact names and schemas. Only caller-executed function tools are in
 * scope: a provider-executed (hosted) tool has no representation here and
 * is rejected before any disclosure.
 */
export function mapTools(request: InferenceRequest, entry: OpenAiCatalogEntry): readonly JsonValue[] {
  if (request.tools.length === 0) {
    return Object.freeze([]);
  }
  if (!entry.supportsToolCalling) {
    throw unsupportedCapabilityError("model-lacks-tool-calling", { modelId: entry.modelId });
  }
  return Object.freeze(
    request.tools.map((tool) => {
      if (tool.executionLocation !== "caller") {
        throw unsupportedCapabilityError("hosted-tools-unsupported", {
          toolName: tool.name as string,
        });
      }
      return {
        type: "function",
        name: tool.name as string,
        description: tool.description,
        parameters: tool.inputSchema,
        // Strict mode is not enabled implicitly: it constrains the schema
        // subset and would change tool-call semantics silently.
        strict: false,
      } as JsonValue;
    }),
  );
}

export function mapToolChoice(request: InferenceRequest): JsonValue | null {
  if (request.toolChoice === null) {
    return null;
  }
  switch (request.toolChoice.mode) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "required":
      return "required";
    case "named":
      return { type: "function", name: request.toolChoice.toolName as string } as JsonValue;
  }
}

// ---------------------------------------------------------------------------
// Full request body
// ---------------------------------------------------------------------------

export interface BuildRequestInput {
  readonly request: InferenceRequest;
  readonly configuration: OpenAiAdapterConfiguration;
  readonly entry: OpenAiCatalogEntry;
  readonly options: OpenAiRequestOptions;
  readonly resolvedImages: ReadonlyMap<string, ResolvedImage>;
  readonly safetyIdentifier: string | null;
  readonly stream: boolean;
  /** Only set when storage and retention are authorized. */
  readonly previousResponseId: string | null;
}

/**
 * Validates output bounds against the effective catalog limits and builds
 * the request body. Every field sent is either required by the API or
 * explicitly configured; nothing is sent speculatively.
 */
export function buildResponsesRequest(input: BuildRequestInput): JsonValue {
  const { request, configuration, entry, options } = input;

  const effectiveMaxOutput =
    options.maxOutputTokens === null
      ? null
      : Math.min(options.maxOutputTokens, entry.maxOutputTokens);
  if (options.maxOutputTokens !== null && options.maxOutputTokens > entry.maxOutputTokens) {
    throw unsupportedCapabilityError("max-output-tokens-exceeds-model", {
      modelId: entry.modelId,
      requested: String(options.maxOutputTokens),
    });
  }

  const body: Record<string, JsonValue> = {
    model: entry.modelId,
    input: mapMessagesToInput(request, { entry, resolvedImages: input.resolvedImages }) as JsonValue,
    stream: input.stream,
    // Persistence is opt-in and policy-gated; the default is always false.
    store: options.store,
  };

  if (options.background) {
    body["background"] = true;
  }
  if (effectiveMaxOutput !== null) {
    body["max_output_tokens"] = effectiveMaxOutput;
  }
  if (input.previousResponseId !== null) {
    body["previous_response_id"] = input.previousResponseId;
  }

  const tools = mapTools(request, entry);
  if (tools.length > 0) {
    body["tools"] = tools as JsonValue;
    // Parallel tool calls change how many invocations a turn may produce
    // and are never enabled implicitly.
    body["parallel_tool_calls"] = configuration.parallelToolCallsEnabled;
  }
  const toolChoice = mapToolChoice(request);
  if (toolChoice !== null) {
    if (tools.length === 0 && toolChoice !== "none") {
      throw unsupportedCapabilityError("tool-choice-without-tools");
    }
    body["tool_choice"] = toolChoice;
  }

  const text: Record<string, JsonValue> = {};
  if (request.structuredOutput !== null) {
    if (!entry.supportsStructuredOutput) {
      throw unsupportedCapabilityError("model-lacks-structured-output", { modelId: entry.modelId });
    }
    text["format"] = {
      type: "json_schema",
      name: STRUCTURED_OUTPUT_FORMAT_NAME,
      schema: request.structuredOutput.schema,
      strict: request.structuredOutput.strict,
    } as JsonValue;
  }
  if (configuration.verbosity !== null) {
    text["verbosity"] = configuration.verbosity;
  }
  if (Object.keys(text).length > 0) {
    body["text"] = text as JsonValue;
  }

  if (options.reasoningEffort !== null || (options.discloseReasoning && configuration.reasoning.summary !== null)) {
    const reasoning: Record<string, JsonValue> = {};
    if (options.reasoningEffort !== null) {
      reasoning["effort"] = options.reasoningEffort;
    }
    // A summary is requested only when disclosure is actually permitted;
    // otherwise reasoning stays internal to the provider.
    if (options.discloseReasoning && configuration.reasoning.summary !== null) {
      reasoning["summary"] = configuration.reasoning.summary;
    }
    body["reasoning"] = reasoning as JsonValue;
  }

  // Sampling fields are omitted entirely for models that do not accept
  // them; sending an unsupported knob is a 400, not a graceful degrade.
  if (request.sampling !== null && entry.supportsSampling) {
    if (request.sampling.temperature !== null) {
      body["temperature"] = request.sampling.temperature;
    }
    if (request.sampling.topP !== null) {
      body["top_p"] = request.sampling.topP;
    }
  }
  if (request.sampling !== null && !entry.supportsSampling) {
    const requested =
      request.sampling.temperature !== null || request.sampling.topP !== null || request.sampling.seed !== null;
    if (requested) {
      throw unsupportedCapabilityError("model-rejects-sampling-parameters", { modelId: entry.modelId });
    }
  }
  if (request.sampling?.seed != null) {
    // The Responses API exposes no seed parameter; silently dropping a
    // determinism request would misrepresent the result.
    throw unsupportedCapabilityError("seed-unsupported");
  }
  if (request.stopSequences.length > 0) {
    // The Responses API exposes no stop-sequence parameter.
    throw unsupportedCapabilityError("stop-sequences-unsupported");
  }

  if (configuration.serviceTier !== null) {
    body["service_tier"] = configuration.serviceTier;
  }
  if (input.safetyIdentifier !== null) {
    body["safety_identifier"] = assertSafetyIdentifier(input.safetyIdentifier);
  }

  return body as JsonValue;
}
