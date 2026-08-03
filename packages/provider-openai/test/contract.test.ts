import {
  type InferenceEvent,
  type InferenceOperation,
  type InferenceProvider,
  type InferenceRequest,
} from "@ai-dev-os/providers";
import { runInferenceProviderContractSuite } from "@ai-dev-os/providers/testing";
import type {
  InferenceContractHarness,
  InferenceScenarioName,
} from "@ai-dev-os/providers/testing";
import { TESTKIT_SECRET_CANARY, createManualScheduler } from "@ai-dev-os/provider-testkit";
import {
  functionCallItem,
  messageItem,
  resetSequence,
  responseObject,
  sse,
  textStreamScript,
  usageObject,
  type ScriptedResponse,
} from "./helpers/fake-openai.js";
import {
  READ_TOOL,
  TESTKIT_EPOCH,
  createTestProvider,
  testCatalog,
  testRequest,
  type TestProviderHandle,
} from "./helpers/fixtures.js";

function minutesAfterEpoch(minutes: number): string {
  return new Date(new Date(TESTKIT_EPOCH).valueOf() + minutes * 60_000).toISOString();
}

type EventTransform = (event: InferenceEvent) => InferenceEvent | null;

/**
 * Contract-negative wrapper simulating a MISBEHAVING provider: events are
 * tampered with after the correct adapter produced them, proving
 * guardProviderOperation rejects such streams. The adapter itself cannot
 * emit these shapes — its operation controller enforces the invariants.
 */
function corruptingProvider(provider: InferenceProvider, transform: EventTransform): InferenceProvider {
  return {
    kind: "inference",
    describe: () => provider.describe(),
    health: () => provider.health(),
    listModels: () => provider.listModels(),
    close: () => provider.close(),
    async start(request: InferenceRequest, options = {}): Promise<InferenceOperation> {
      const operation = await provider.start(request, options);
      return {
        operationId: operation.operationId,
        result: operation.result,
        cancel: (reason) => operation.cancel(reason),
        events(): AsyncIterable<InferenceEvent> {
          const source = operation.events();
          return (async function* corrupted(): AsyncIterable<InferenceEvent> {
            for await (const event of source) {
              const mapped = transform(event);
              if (mapped !== null) {
                yield mapped;
              }
            }
          })();
        },
      };
    },
  };
}

function createOpenAiContractHarness(): InferenceContractHarness {
  const manual = createManualScheduler();
  const handles: TestProviderHandle[] = [];

  function build(
    script: ScriptedResponse | null,
    options: Parameters<typeof createTestProvider>[0] = {},
  ): TestProviderHandle {
    const handle = createTestProvider({ ...options, manual });
    handles.push(handle);
    if (script !== null) {
      handle.fake.script("create", script);
    }
    return handle;
  }

  return {
    clock: manual,
    secretCanary: TESTKIT_SECRET_CANARY,

    async scenario(name: InferenceScenarioName) {
      switch (name) {
        case "basic-text": {
          const handle = build({ stream: textStreamScript(["Hello from ", "the fake API."]) });
          return { provider: handle.provider, request: testRequest(name) };
        }

        case "streaming-chunks": {
          const handle = build({
            stream: textStreamScript(["streamed", " in many", " separate", " pieces"]),
          });
          return { provider: handle.provider, request: testRequest(name) };
        }

        case "structured-output": {
          resetSequence();
          const json = '{"answer":42,"ok":true}';
          const handle = build({
            stream: [
              sse("response.created", { response: responseObject({ status: "in_progress" }) }),
              sse("response.output_text.delta", {
                item_id: "msg_1",
                output_index: 0,
                content_index: 0,
                delta: '{"answer":42,',
                logprobs: [],
              }),
              sse("response.output_text.delta", {
                item_id: "msg_1",
                output_index: 0,
                content_index: 0,
                delta: '"ok":true}',
                logprobs: [],
              }),
              sse("response.completed", {
                response: responseObject({
                  status: "completed",
                  output: [messageItem(json)],
                  usage: usageObject(),
                }),
              }),
            ],
          });
          return {
            provider: handle.provider,
            request: testRequest(name, {
              structuredOutput: { schema: { type: "object" }, strict: true },
            }),
          };
        }

        case "single-tool-call": {
          resetSequence();
          const handle = build({
            stream: [
              sse("response.created", { response: responseObject({ status: "in_progress" }) }),
              sse("response.output_item.added", {
                output_index: 0,
                item: {
                  id: "fc_1",
                  type: "function_call",
                  call_id: "call_1",
                  name: "read-file",
                  arguments: "",
                  status: "in_progress",
                },
              }),
              sse("response.function_call_arguments.done", {
                item_id: "fc_1",
                output_index: 0,
                name: "read-file",
                arguments: '{"path":"src/index.ts"}',
              }),
              sse("response.completed", {
                response: responseObject({
                  status: "completed",
                  output: [functionCallItem("read-file", '{"path":"src/index.ts"}')],
                  usage: usageObject(),
                }),
              }),
            ],
          });
          return { provider: handle.provider, request: testRequest(name, { tools: [READ_TOOL] }) };
        }

        case "multi-tool-call": {
          resetSequence();
          const handle = build({
            stream: [
              sse("response.created", { response: responseObject({ status: "in_progress" }) }),
              sse("response.output_item.added", {
                output_index: 0,
                item: {
                  id: "fc_1",
                  type: "function_call",
                  call_id: "call_1",
                  name: "read-file",
                  arguments: "",
                  status: "in_progress",
                },
              }),
              sse("response.function_call_arguments.done", {
                item_id: "fc_1",
                output_index: 0,
                name: "read-file",
                arguments: '{"path":"a.ts"}',
              }),
              sse("response.output_item.added", {
                output_index: 1,
                item: {
                  id: "fc_2",
                  type: "function_call",
                  call_id: "call_2",
                  name: "read-file",
                  arguments: "",
                  status: "in_progress",
                },
              }),
              sse("response.function_call_arguments.done", {
                item_id: "fc_2",
                output_index: 1,
                name: "read-file",
                arguments: '{"path":"b.ts"}',
              }),
              sse("response.completed", {
                response: responseObject({
                  status: "completed",
                  output: [
                    functionCallItem("read-file", '{"path":"a.ts"}', "call_1", "fc_1"),
                    functionCallItem("read-file", '{"path":"b.ts"}', "call_2", "fc_2"),
                  ],
                  usage: usageObject(),
                }),
              }),
            ],
          });
          return { provider: handle.provider, request: testRequest(name, { tools: [READ_TOOL] }) };
        }

        case "usage-updates": {
          const handle = build({
            stream: textStreamScript(["working"], {
              usage: usageObject({ inputTokens: 120, outputTokens: 45, reasoningTokens: 5 }),
            }),
          });
          return { provider: handle.provider, request: testRequest(name) };
        }

        case "pausing": {
          resetSequence();
          const handle = build({
            stream: [
              sse("response.created", { response: responseObject({ status: "in_progress" }) }),
              sse("response.output_text.delta", {
                item_id: "msg_1",
                output_index: 0,
                content_index: 0,
                delta: "before-",
                logprobs: [],
              }),
              { holdUntilRelease: true },
            ],
          });
          return { provider: handle.provider, request: testRequest(name) };
        }

        case "deadline-before-start": {
          const handle = build(null);
          return { provider: handle.provider, request: testRequest(name, { deadline: TESTKIT_EPOCH }) };
        }

        case "deadline-mid-stream": {
          resetSequence();
          const handle = build({
            stream: [
              sse("response.created", { response: responseObject({ status: "in_progress" }) }),
              sse("response.output_text.delta", {
                item_id: "msg_1",
                output_index: 0,
                content_index: 0,
                delta: "before-",
                logprobs: [],
              }),
              { holdUntilRelease: true },
            ],
          });
          return {
            provider: handle.provider,
            request: testRequest(name, { deadline: minutesAfterEpoch(30) }),
          };
        }

        case "unsupported-capability": {
          // The catalog snapshot says this model cannot call tools.
          const handle = build(null, {
            configuration: { catalog: testCatalog({ supportsToolCalling: false }) },
          });
          return { provider: handle.provider, request: testRequest(name, { tools: [READ_TOOL] }) };
        }

        case "classification-rejected": {
          const handle = build(null, {
            configuration: { supportedClassifications: ["public"] },
          });
          return {
            provider: handle.provider,
            request: testRequest(name, {
              disclosure: {
                classification: "proprietary-source",
                requiredLocality: "any",
                redactionApplied: true,
                decisionRef: null,
                retentionAllowed: false,
                loggingAllowed: false,
              },
            }),
          };
        }

        case "failure-before-stream": {
          const handle = build({
            status: 429,
            headers: { "retry-after": "2" },
            json: { error: { type: "rate_limit_error", code: "rate_limit_exceeded" } },
          });
          return { provider: handle.provider, request: testRequest(name) };
        }

        case "failure-mid-stream": {
          resetSequence();
          const handle = build({
            stream: [
              sse("response.created", { response: responseObject({ status: "in_progress" }) }),
              sse("response.output_text.delta", {
                item_id: "msg_1",
                output_index: 0,
                content_index: 0,
                delta: "partial ",
                logprobs: [],
              }),
              sse("response.failed", {
                response: responseObject({
                  status: "failed",
                  error: { code: "server_error", message: "scripted overload" },
                }),
              }),
            ],
          });
          return { provider: handle.provider, request: testRequest(name) };
        }

        case "malformed-stream": {
          const handle = build({ stream: textStreamScript(["Hello"]) });
          // Drop the second event: the guard must reject the sequence gap.
          return {
            provider: corruptingProvider(handle.provider, (event) =>
              event.sequence === 2 ? null : event,
            ),
            request: testRequest(name),
          };
        }

        case "terminal-mismatch": {
          const handle = build({ stream: textStreamScript(["Hello"]) });
          // Rewrite a successful terminal into a failure while the result
          // still resolves: the guard must detect the disagreement.
          return {
            provider: corruptingProvider(handle.provider, (event) =>
              event.kind === "operation-completed"
                ? ({
                    ...event,
                    kind: "operation-failed",
                    payload: { code: "INTERNAL_FAILURE", message: "tampered", retryStrategy: "never" },
                  } as InferenceEvent)
                : event,
            ),
            request: testRequest(name),
          };
        }

        case "secret-probe": {
          resetSequence();
          const handle = build({
            stream: [
              sse("response.created", { response: responseObject({ status: "in_progress" }) }),
              sse("response.output_text.delta", {
                item_id: "msg_1",
                output_index: 0,
                content_index: 0,
                delta: "thinking ",
                logprobs: [],
              }),
              // The upstream failure text embeds the canary; it must never
              // reach an error, an event payload, or an observation.
              sse("response.failed", {
                response: responseObject({
                  status: "failed",
                  error: {
                    code: "server_error",
                    message: `backend crashed while reading ${TESTKIT_SECRET_CANARY}`,
                  },
                }),
              }),
            ],
          });
          return {
            provider: handle.provider,
            request: testRequest(name, {
              messages: [
                {
                  role: "user",
                  parts: [{ type: "text", text: `use this token: ${TESTKIT_SECRET_CANARY}` }],
                },
              ],
            }),
          };
        }
      }
    },

    async dispose(): Promise<void> {
      for (const handle of handles.splice(0, handles.length)) {
        // Release any held stream so close() can settle deterministically.
        handle.fake.release();
        await handle.provider.close();
      }
    },
  };
}

runInferenceProviderContractSuite("openai responses adapter over a fake HTTPS endpoint", async () =>
  createOpenAiContractHarness(),
);
