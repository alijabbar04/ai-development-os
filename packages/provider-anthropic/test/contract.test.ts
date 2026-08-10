import {
  type InferenceEvent,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type ProviderOperation,
} from "@ai-dev-os/providers";
import {
  TESTKIT_SECRET_CANARY,
} from "@ai-dev-os/provider-testkit";
import {
  type InferenceContractHarness,
  type InferenceScenarioName,
  runInferenceProviderContractSuite,
} from "@ai-dev-os/providers/testing";
import {
  AnthropicTransportFailure,
  type AnthropicAdapterConfiguration,
} from "../src/index.js";
import { createAnthropicProviderForTesting } from "../src/testing/index.js";
import {
  READ_TOOL,
  blockStop,
  configuration,
  fakePorts,
  messageDelta,
  messageStart,
  messageStop,
  noRetentionDisclosure,
  request,
  textDelta,
  textScript,
  textStart,
  toolDelta,
  toolStart,
  type FakePorts,
  type FakeTransportScript,
} from "./helpers.js";

function corruptingProvider(
  provider: InferenceProvider,
  transform: (event: InferenceEvent) => InferenceEvent | null,
): InferenceProvider {
  return Object.freeze({
    kind: "inference" as const,
    describe: () => provider.describe(),
    health: () => provider.health(),
    listModels: () => provider.listModels(),
    close: () => provider.close(),
    async start(value: InferenceRequest): Promise<ProviderOperation<InferenceEvent, InferenceResult>> {
      const operation = await provider.start(value);
      return Object.freeze({
        operationId: operation.operationId,
        result: operation.result,
        cancel: (reason?: Parameters<typeof operation.cancel>[0]) => operation.cancel(reason),
        events(): AsyncIterable<InferenceEvent> {
          const source = operation.events();
          return Object.freeze({
            async *[Symbol.asyncIterator](): AsyncGenerator<InferenceEvent> {
              for await (const event of source) {
                const changed = transform(event);
                if (changed !== null) yield changed;
              }
            },
          });
        },
      });
    },
  });
}

function createHarness(): InferenceContractHarness {
  const resources: FakePorts[] = [];

  function build(
    script: FakeTransportScript,
    options: {
      readonly configuration?: AnthropicAdapterConfiguration;
      readonly authorize?: Parameters<typeof fakePorts>[0]["authorize"];
    } = {},
  ) {
    const fake = fakePorts({
      script,
      ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
    });
    resources.push(fake);
    return {
      fake,
      provider: createAnthropicProviderForTesting({
        configuration: options.configuration ?? configuration(),
        ports: fake.ports,
      }),
    };
  }

  let lastClock: FakePorts["time"] | null = null;

  return {
    get clock() {
      return {
        advance(milliseconds: number): void {
          if (lastClock === null) throw new Error("scenario clock not initialized");
          lastClock.advance(milliseconds);
        },
      };
    },
    secretCanary: TESTKIT_SECRET_CANARY,
    async scenario(name: InferenceScenarioName) {
      let built;
      let scenarioRequest: InferenceRequest;
      switch (name) {
        case "basic-text":
          built = build({ events: textScript(["Hello from Anthropic."]) });
          scenarioRequest = request(name);
          break;
        case "streaming-chunks":
          built = build({ events: textScript(["stream", "ed ", "pieces"]) });
          scenarioRequest = request(name);
          break;
        case "structured-output":
          built = build({ events: textScript(['{"answer":42,"ok":true}']) });
          scenarioRequest = request(name, { structuredOutput: { schema: { type: "object" }, strict: true } });
          break;
        case "single-tool-call":
          built = build({ events: [
            messageStart(),
            toolStart("tool:one", "read-file"),
            toolDelta('{"path":"src/index.ts"}'),
            blockStop(),
            messageDelta("tool_use"),
            messageStop,
          ] });
          scenarioRequest = request(name, { tools: [READ_TOOL] });
          break;
        case "multi-tool-call":
          built = build({ events: [
            messageStart(),
            toolStart("tool:one", "read-file", 0),
            toolDelta('{"path":"a.ts"}', 0),
            blockStop(0),
            toolStart("tool:two", "read-file", 1),
            toolDelta('{"path":"b.ts"}', 1),
            blockStop(1),
            messageDelta("tool_use"),
            messageStop,
          ] });
          scenarioRequest = request(name, { tools: [READ_TOOL] });
          break;
        case "usage-updates":
          built = build({ events: textScript(["usage"], { usageUpdates: [25] }) });
          scenarioRequest = request(name);
          break;
        case "pausing":
          built = build({ events: textScript(["before-", "after"]), holdAt: 3 });
          scenarioRequest = request(name);
          break;
        case "deadline-before-start":
          built = build({ events: textScript(["never"]) });
          scenarioRequest = request(name, { deadline: built.fake.time.now().toISOString() });
          break;
        case "deadline-mid-stream":
          built = build(
            { events: textScript(["before-", "after"]), holdAt: 3 },
            { configuration: configuration({ bounds: { maximumWallTimeMs: 2 * 60 * 60_000 } }) },
          );
          scenarioRequest = request(name, { deadline: new Date(built.fake.time.now().valueOf() + 30 * 60_000).toISOString() });
          break;
        case "unsupported-capability":
          built = build({ events: [] }, { configuration: configuration({ toolUse: false }) });
          scenarioRequest = request(name, { tools: [READ_TOOL] });
          break;
        case "classification-rejected":
          built = build({ events: [] }, { authorize: (value) => value.disclosure.classification !== "proprietary-source" });
          scenarioRequest = request(name, {
            disclosure: {
              ...noRetentionDisclosure(),
              classification: "proprietary-source",
              retentionAllowed: true,
            },
          });
          break;
        case "failure-before-stream":
          built = build({ failureBefore: new AnthropicTransportFailure("rate_limit_error", { status: 429, retryAfterMs: 1_500 }) });
          scenarioRequest = request(name);
          break;
        case "failure-mid-stream":
          built = build({ events: [messageStart(), textStart(), textDelta("partial ")], failureAt: 3 });
          scenarioRequest = request(name);
          break;
        case "malformed-stream": {
          built = build({ events: textScript(["Hello"]) });
          const provider = corruptingProvider(built.provider, (value) => value.sequence === 2 ? null : value);
          lastClock = built.fake.time;
          return { provider, request: request(name) };
        }
        case "terminal-mismatch": {
          built = build({ events: textScript(["Hello"]) });
          const provider = corruptingProvider(built.provider, (value) => value.kind === "operation-completed"
            ? ({ ...value, kind: "operation-failed", payload: { code: "INTERNAL_FAILURE", message: "tampered", retryStrategy: "never" } } as InferenceEvent)
            : value);
          lastClock = built.fake.time;
          return { provider, request: request(name) };
        }
        case "secret-probe":
          built = build({ events: [
            messageStart(),
            textStart(),
            textDelta("thinking "),
            { type: "error", error: { type: "api_error", message: `sensitive ${TESTKIT_SECRET_CANARY}` } },
          ] });
          scenarioRequest = request(name, {
            messages: [{ role: "user", parts: [{ type: "text", text: `use ${TESTKIT_SECRET_CANARY}` }] }],
          });
          break;
      }
      lastClock = built.fake.time;
      return { provider: built.provider, request: scenarioRequest };
    },
    async dispose(): Promise<void> {
      for (const resource of resources.splice(0, resources.length)) resource.release();
    },
  };
}

runInferenceProviderContractSuite(
  "direct Anthropic adapter over an injected fake Messages transport",
  async () => createHarness(),
);
