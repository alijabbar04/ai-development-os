import {
  guardProviderOperation as _guard,
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
import {
  TESTKIT_EPOCH,
  TESTKIT_SECRET_CANARY,
  createManualScheduler,
  parseDisclosureContext,
} from "./helpers/testkit-reexports.js";
import {
  DEFAULT_FAKE_MODEL_SPEC,
  contentRecord,
  doneRecord,
  startFakeOllamaServer,
  toolCallRecord,
  type FakeOllamaServer,
  type FakeOllamaServerOptions,
} from "./helpers/fake-ollama-server.js";
import { READ_TOOL, createTestProvider, testRequest } from "./helpers/fixtures.js";

function minutesAfterEpoch(minutes: number): string {
  return new Date(new Date(TESTKIT_EPOCH).valueOf() + minutes * 60_000).toISOString();
}

type EventTransform = (event: InferenceEvent) => InferenceEvent | null;

/**
 * Contract-negative wrapper simulating a MISBEHAVING transport/provider:
 * events are tampered with after the correct adapter produced them, to
 * prove guardProviderOperation rejects such streams. The adapter itself
 * cannot emit these shapes (its controller enforces the invariants).
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

function createOllamaContractHarness(): InferenceContractHarness {
  const manual = createManualScheduler();
  const servers: FakeOllamaServer[] = [];

  async function scenarioProvider(options: {
    readonly server?: FakeOllamaServerOptions;
    readonly configuration?: Parameters<typeof createTestProvider>[0]["configuration"];
  }): Promise<{ server: FakeOllamaServer; provider: InferenceProvider }> {
    const server = await startFakeOllamaServer(options.server ?? {});
    servers.push(server);
    const { provider } = createTestProvider({
      serverUrl: server.url,
      manual,
      ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
    });
    return { server, provider };
  }

  return {
    clock: manual,
    secretCanary: TESTKIT_SECRET_CANARY,
    async scenario(name: InferenceScenarioName) {
      switch (name) {
        case "basic-text": {
          const { provider } = await scenarioProvider({
            server: { chat: { chunks: [contentRecord("Hello from the fake provider."), doneRecord()] } },
          });
          return { provider, request: testRequest(name) };
        }
        case "streaming-chunks": {
          const { provider } = await scenarioProvider({
            server: {
              chat: {
                chunks: [
                  contentRecord("streamed"),
                  contentRecord(" in many"),
                  contentRecord(" pieces"),
                  doneRecord(),
                ],
              },
            },
          });
          return { provider, request: testRequest(name) };
        }
        case "structured-output": {
          const { provider } = await scenarioProvider({
            server: {
              chat: { chunks: [contentRecord('{"answer":42,'), contentRecord('"ok":true}'), doneRecord()] },
            },
          });
          return {
            provider,
            request: testRequest(name, {
              structuredOutput: { schema: { type: "object" }, strict: true },
            }),
          };
        }
        case "single-tool-call": {
          const { provider } = await scenarioProvider({
            server: {
              chat: {
                chunks: [
                  toolCallRecord([{ name: "read-file", arguments: { path: "src/index.ts" } }]),
                  doneRecord(),
                ],
              },
            },
          });
          return { provider, request: testRequest(name, { tools: [READ_TOOL] }) };
        }
        case "multi-tool-call": {
          const { provider } = await scenarioProvider({
            server: {
              chat: {
                chunks: [
                  toolCallRecord([
                    { name: "read-file", arguments: { path: "a.ts" } },
                    { name: "read-file", arguments: { path: "b.ts" } },
                  ]),
                  doneRecord(),
                ],
              },
            },
          });
          return { provider, request: testRequest(name, { tools: [READ_TOOL] }) };
        }
        case "usage-updates": {
          const { provider } = await scenarioProvider({
            server: {
              chat: {
                chunks: [
                  contentRecord("working"),
                  doneRecord({ prompt_eval_count: 10, eval_count: 25 }),
                ],
              },
            },
          });
          return { provider, request: testRequest(name) };
        }
        case "pausing": {
          const { provider } = await scenarioProvider({
            server: { chat: { chunks: [contentRecord("before-"), { holdUntilRelease: true }] } },
          });
          return { provider, request: testRequest(name) };
        }
        case "deadline-before-start": {
          const { provider } = await scenarioProvider({});
          return { provider, request: testRequest(name, { deadline: TESTKIT_EPOCH }) };
        }
        case "deadline-mid-stream": {
          const { provider } = await scenarioProvider({
            server: { chat: { chunks: [contentRecord("before-"), { holdUntilRelease: true }] } },
          });
          return { provider, request: testRequest(name, { deadline: minutesAfterEpoch(30) }) };
        }
        case "unsupported-capability": {
          const { provider } = await scenarioProvider({
            server: {
              models: [{ ...DEFAULT_FAKE_MODEL_SPEC, capabilities: ["completion"] }],
            },
          });
          return { provider, request: testRequest(name, { tools: [READ_TOOL] }) };
        }
        case "classification-rejected": {
          const { provider } = await scenarioProvider({
            configuration: { supportedClassifications: ["public", "internal"] },
          });
          return {
            provider,
            request: testRequest(name, {
              disclosure: parseDisclosureContext({
                classification: "proprietary-source",
                requiredLocality: "any",
                redactionApplied: true,
                decisionRef: null,
                retentionAllowed: false,
                loggingAllowed: false,
              }),
            }),
          };
        }
        case "failure-before-stream": {
          const { provider } = await scenarioProvider({
            server: {
              chat: {
                status: 429,
                headers: { "retry-after": "2" },
                contentType: "application/json",
                body: '{"error":"throttled"}',
              },
            },
          });
          return { provider, request: testRequest(name) };
        }
        case "failure-mid-stream": {
          const { provider } = await scenarioProvider({
            server: {
              chat: { chunks: [contentRecord("partial "), '{"error":"scripted overload"}\n'] },
            },
          });
          return { provider, request: testRequest(name) };
        }
        case "malformed-stream": {
          const { provider } = await scenarioProvider({
            server: { chat: { chunks: [contentRecord("Hello"), doneRecord()] } },
          });
          // Drop the second event: the guard must reject the sequence gap.
          return {
            provider: corruptingProvider(provider, (event) => (event.sequence === 2 ? null : event)),
            request: testRequest(name),
          };
        }
        case "terminal-mismatch": {
          const { provider } = await scenarioProvider({
            server: { chat: { chunks: [contentRecord("Hello"), doneRecord()] } },
          });
          // Rewrite the successful terminal into a failure while the result
          // still resolves: the guard must detect the disagreement.
          return {
            provider: corruptingProvider(provider, (event) =>
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
          const { provider } = await scenarioProvider({
            server: {
              chat: {
                chunks: [
                  contentRecord("thinking "),
                  `{"error":"backend crashed while reading ${TESTKIT_SECRET_CANARY}"}\n`,
                ],
              },
            },
          });
          return {
            provider,
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
      for (const server of servers.splice(0, servers.length)) {
        await server.close();
      }
    },
  };
}

runInferenceProviderContractSuite("ollama adapter over fake HTTP server", async () =>
  createOllamaContractHarness(),
);
