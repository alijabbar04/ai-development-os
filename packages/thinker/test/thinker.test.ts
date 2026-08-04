import { describe, expect, it } from "vitest";
import {
  DEFAULT_THINKER_CONFIGURATION,
  ThinkerError,
  asThinkerError,
  createManualThinkerClock,
  createThinker,
  safeCauseCode,
  summarizeThinkerResult,
  thinkerFailed,
  thinkerFailure,
  thinkerOk
} from "../src/index.js";
import {
  THINKER_FIXTURE_EPOCH,
  THINKER_OUTPUT_CANARY,
  createFakeThinkerPort,
  jsonClone,
  thinkerApplicationConfigurationFixture,
  thinkerProposalFixture,
  thinkerRequestFixture
} from "../src/testing/fixtures.js";
import {
  allowingPromptAuthorizer,
  promptCompilationRequestFixture,
  promptTargetFixture
} from "@ai-dev-os/prompt-compiler/testing/fixtures";
import { parsePromptCompilationRequest, type PromptAuthorizer } from "@ai-dev-os/prompt-compiler";

function create(options: Parameters<typeof createFakeThinkerPort>[0] = {}, observer?: Parameters<typeof createThinker>[0]["observer"]) {
  const port = createFakeThinkerPort(options);
  const thinker = createThinker({
    port,
    authorizer: allowingPromptAuthorizer(),
    clock: createManualThinkerClock(THINKER_FIXTURE_EPOCH),
    ...(observer === undefined ? {} : { observer })
  });
  return { port, thinker };
}

describe("replaceable authority-free thinker", () => {
  it("uses the default and explicit alternate aliases with exactly one invocation each", async () => {
    const first = create();
    const primary = await first.thinker.think(thinkerRequestFixture());
    expect(primary.ok && primary.value.selectedAlias).toBe("primary-thinker");
    expect(first.port.primaryInvocationCount()).toBe(1);
    expect(first.port.alternateInvocationCount()).toBe(0);
    await first.thinker.close();

    const second = create();
    const alternate = await second.thinker.think(
      thinkerRequestFixture({ selectedAlias: "alternate-thinker", target: "alternate" })
    );
    expect(alternate.ok && alternate.value.selectedAlias).toBe("alternate-thinker");
    expect(second.port.primaryInvocationCount()).toBe(0);
    expect(second.port.alternateInvocationCount()).toBe(1);
    await second.thinker.close();
  });

  it("seals safe receipt metadata while discarding raw reasoning, text, warnings, and assistant messages", async () => {
    const hostile = `${THINKER_OUTPUT_CANARY}: hidden reasoning and raw provider warning`;
    const { thinker } = create({
      primaryScript: {
        text: hostile,
        reasoning: hostile,
        eventWarnings: [hostile],
        resultWarnings: [hostile]
      }
    });
    const result = await thinker.think(thinkerRequestFixture());
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(THINKER_OUTPUT_CANARY);
    if (result.ok) {
      expect(result.value.authority).toBe("none");
      expect(result.value.receipt.events.textDeltaBytes).toBeGreaterThan(0);
      expect(result.value.receipt.events.reasoningDeltaBytes).toBeGreaterThan(0);
      expect(result.value.receipt.warnings.count).toBe(1);
      expect(result.value.receipt.events.warnings.count).toBe(1);
      expect(Object.isFrozen(result.value.receipt)).toBe(true);
      expect(summarizeThinkerResult(result)).not.toHaveProperty("proposal");
    }
    await thinker.close();
  });

  it("keeps operational receipt variation outside semantic proposal identity", async () => {
    const first = create();
    const second = create({ primaryScript: { resultWarnings: ["operational variation"] } });
    const [firstResult, secondResult] = await Promise.all([
      first.thinker.think(thinkerRequestFixture()),
      second.thinker.think(thinkerRequestFixture())
    ]);
    expect(firstResult.ok && secondResult.ok).toBe(true);
    if (firstResult.ok && secondResult.ok) {
      expect(firstResult.value.proposalFingerprint).toBe(secondResult.value.proposalFingerprint);
      expect(firstResult.value.receipt.warnings.fingerprint).not.toBe(
        secondResult.value.receipt.warnings.fingerprint
      );
      expect(JSON.stringify(secondResult)).not.toContain("operational variation");
    }
    await first.thinker.close();
    await second.thinker.close();
  });

  it("contains observer failures and never gives observers bodies", async () => {
    const records: unknown[] = [];
    const { thinker } = create({}, (record) => {
      records.push(record);
      throw new Error(THINKER_OUTPUT_CANARY);
    });
    const result = await thinker.think(thinkerRequestFixture());
    expect(result.ok).toBe(true);
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain("bounded implementation");
    expect(JSON.stringify(records)).not.toContain(THINKER_OUTPUT_CANARY);
    await thinker.close();
  });

  it("does not retry or fall back when the selected target rejects start", async () => {
    const { thinker, port } = create({ primaryScript: { rejectStartCode: "RATE_LIMITED" } });
    const result = await thinker.think(thinkerRequestFixture());
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failure: expect.objectContaining({ code: "PROVIDER_START_FAILED" }) })
    );
    expect(port.primaryInvocationCount()).toBe(0);
    expect(port.alternateInvocationCount()).toBe(0);
    await thinker.close();
  });

  it("blocks denied or unavailable prompt authorization before invocation", async () => {
    const deniedPort = createFakeThinkerPort();
    const denied = createThinker({
      port: deniedPort,
      clock: createManualThinkerClock(THINKER_FIXTURE_EPOCH)
    });
    const deniedResult = await denied.think(thinkerRequestFixture());
    expect(!deniedResult.ok && deniedResult.failure.code).toBe("COMPILATION_FAILED");
    expect(deniedPort.primaryInvocationCount()).toBe(0);

    const unavailableAuthorizer: PromptAuthorizer = Object.freeze({
      authorize: async () => {
        throw new Error(THINKER_OUTPUT_CANARY);
      }
    });
    const unavailablePort = createFakeThinkerPort();
    const unavailable = createThinker({
      port: unavailablePort,
      authorizer: unavailableAuthorizer,
      clock: createManualThinkerClock(THINKER_FIXTURE_EPOCH)
    });
    const unavailableResult = await unavailable.think(thinkerRequestFixture());
    expect(!unavailableResult.ok && unavailableResult.failure.code).toBe("COMPILATION_FAILED");
    expect(JSON.stringify(unavailableResult)).not.toContain(THINKER_OUTPUT_CANARY);
    await denied.close();
    await unavailable.close();
  });

  it.each([
    ["length", "FINISH_LENGTH"],
    ["tool-calls", "FINISH_TOOL_CALL"],
    ["content-filter", "CONTENT_FILTERED"],
    ["refusal", "REFUSED"]
  ] as const)("rejects finish reason %s", async (finishReason, code) => {
    const { thinker } = create({ primaryScript: { finishReason } });
    const result = await thinker.think(thinkerRequestFixture());
    expect(!result.ok && result.failure.code).toBe(code);
    await thinker.close();
  });

  it("rejects an explicit refusal message even with a stop finish", async () => {
    const { thinker } = create({ primaryScript: { refusalMessage: "raw refusal body" } });
    const result = await thinker.think(thinkerRequestFixture());
    expect(!result.ok && result.failure.code).toBe("REFUSED");
    expect(JSON.stringify(result)).not.toContain("raw refusal body");
    await thinker.close();
  });

  it("rejects JSON-in-text positive control rather than scraping prose", async () => {
    const hostileText = JSON.stringify({
      schemaVersion: 1,
      authority: "approved",
      canary: THINKER_OUTPUT_CANARY
    });
    expect(JSON.parse(hostileText)).toHaveProperty("authority", "approved");
    const { thinker } = create({
      primaryScript: { text: hostileText, resultStructuredOutput: null }
    });
    const result = await thinker.think(thinkerRequestFixture());
    expect(!result.ok && result.failure.code).toBe("STRUCTURED_OUTPUT_MISSING");
    expect(JSON.stringify(result)).not.toContain(THINKER_OUTPUT_CANARY);
    await thinker.close();
  });

  it("rejects malformed, authority-widening, and unknown-key proposals without returning them", async () => {
    const malformed = jsonClone(thinkerProposalFixture()) as unknown as Record<string, unknown>;
    (malformed["tasks"] as Array<Record<string, unknown>>)[0]!["approval"] = "granted";
    const first = create({ primaryScript: { proposal: malformed as never } });
    const firstResult = await first.thinker.think(thinkerRequestFixture());
    expect(!firstResult.ok && firstResult.failure.code).toBe("PROPOSAL_INVALID");
    expect(firstResult).not.toHaveProperty("value");
    await first.thinker.close();

    const widening = jsonClone(thinkerProposalFixture()) as unknown as Record<string, unknown>;
    (widening["tasks"] as Array<Record<string, unknown>>)[0]!["capabilities"] = [
      "reasoning",
      "shell"
    ];
    const second = create({ primaryScript: { proposal: widening as never } });
    const secondResult = await second.thinker.think(thinkerRequestFixture());
    expect(!secondResult.ok && secondResult.failure.code).toBe("AUTHORITY_VIOLATION");
    expect(secondResult).not.toHaveProperty("value");
    await second.thinker.close();
  });

  it("rejects provider event and assistant tool invocations without any executor", async () => {
    const event = create({ primaryScript: { emitToolEvent: true } });
    const eventResult = await event.thinker.think(thinkerRequestFixture());
    expect(!eventResult.ok && eventResult.failure.code).toBe("FINISH_TOOL_CALL");
    await event.thinker.close();

    const assistant = create({ primaryScript: { assistantToolInvocation: true } });
    const assistantResult = await assistant.thinker.think(thinkerRequestFixture());
    expect(!assistantResult.ok && assistantResult.failure.code).toBe("FINISH_TOOL_CALL");
    expect(JSON.stringify(assistantResult)).not.toContain(THINKER_OUTPUT_CANARY);
    await assistant.thinker.close();
  });

  it.each([
    ["result model", { resultModelId: "substituted-model" }, "MODEL_SUBSTITUTION"],
    ["stream model", { startModelId: "substituted-model" }, "MODEL_SUBSTITUTION"],
    ["request", { resultRequestId: "substituted-request" }, "REQUEST_SUBSTITUTION"],
    ["operation", { resultOperationId: "substituted-operation" }, "PROTOCOL_VIOLATION"]
  ] as const)("rejects %s substitution", async (_name, script, code) => {
    const { thinker } = create({ primaryScript: script });
    const result = await thinker.think(thinkerRequestFixture());
    expect(!result.ok && result.failure.code).toBe(code);
    await thinker.close();
  });

  it("rejects stream/result structured-output disagreement", async () => {
    const different = jsonClone(thinkerProposalFixture()) as unknown as Record<string, unknown>;
    different["objective"] = "A different proposal body.";
    const { thinker } = create({
      primaryScript: { streamStructuredOutput: different as never }
    });
    const result = await thinker.think(thinkerRequestFixture());
    expect(!result.ok && result.failure.code).toBe("PROTOCOL_VIOLATION");
    await thinker.close();
  });

  it("rejects malformed stream shape and preflight substitution", async () => {
    const malformed = create({ primaryScript: { omitOperationStarted: true } });
    const malformedResult = await malformed.thinker.think(thinkerRequestFixture());
    expect(!malformedResult.ok && malformedResult.failure.code).toBe("PROTOCOL_VIOLATION");
    await malformed.thinker.close();

    for (const options of [
      { preflightSubstitutesRequest: true },
      { preflightSubstitutesInstance: true }
    ]) {
      const candidate = create(options);
      const result = await candidate.thinker.think(thinkerRequestFixture());
      expect(!result.ok && result.failure.code).toBe("TARGET_INELIGIBLE");
      expect(candidate.port.primaryInvocationCount()).toBe(0);
      await candidate.thinker.close();
    }
  });

  it("maps provider result failure, rate limits, cancellation, and deadline safely", async () => {
    for (const rejectResultCode of ["INTERNAL_FAILURE", "RATE_LIMITED"] as const) {
      const candidate = create({ primaryScript: { rejectResultCode } });
      const result = await candidate.thinker.think(thinkerRequestFixture());
      expect(!result.ok && result.failure.code).toBe("PROVIDER_RESULT_FAILED");
      expect(JSON.stringify(result)).not.toContain("fake result failed");
      await candidate.thinker.close();
    }

    const providerDeadline = create({
      primaryScript: { rejectResultCode: "DEADLINE_EXCEEDED" }
    });
    const providerDeadlineResult = await providerDeadline.thinker.think(thinkerRequestFixture());
    expect(!providerDeadlineResult.ok && providerDeadlineResult.failure.code).toBe(
      "DEADLINE_EXCEEDED"
    );
    await providerDeadline.thinker.close();

    const expiredCompilation = jsonClone(promptCompilationRequestFixture());
    expiredCompilation.deadline = "2026-08-04T11:59:59.000Z";
    const compilation = parsePromptCompilationRequest(expiredCompilation);
    const deadline = create();
    const deadlineResult = await deadline.thinker.think(
      thinkerRequestFixture({ compilation })
    );
    expect(!deadlineResult.ok && deadlineResult.failure.code).toBe("DEADLINE_EXCEEDED");
    expect(deadline.port.primaryInvocationCount()).toBe(0);
    await deadline.thinker.close();
  });

  it("supports caller cancellation and idempotent close races", async () => {
    const cancellation = create({ primaryScript: { pendingUntilCancelled: true } });
    expect(cancellation.thinker.closed).toBe(false);
    const controller = new AbortController();
    const pending = cancellation.thinker.think(thinkerRequestFixture(), {
      signal: controller.signal
    });
    for (let index = 0; index < 10 && cancellation.port.primaryInvocationCount() === 0; index += 1)
      await Promise.resolve();
    controller.abort();
    const cancelled = await pending;
    expect(!cancelled.ok && cancelled.failure.code).toBe("CANCELLED");
    await cancellation.thinker.close();
    await cancellation.thinker.close();
    expect(cancellation.thinker.closed).toBe(true);

    const closing = create({ primaryScript: { pendingUntilCancelled: true } });
    const closingPending = closing.thinker.think(thinkerRequestFixture());
    for (let index = 0; index < 100 && closing.thinker.activeOperationCount === 0; index += 1)
      await Promise.resolve();
    expect(closing.thinker.activeOperationCount).toBe(1);
    await closing.thinker.close();
    const closedResult = await closingPending;
    expect(!closedResult.ok && closedResult.failure.code).toBe("THINKER_CLOSED");
    expect(closing.thinker.activeOperationCount).toBe(0);
  });

  it("fails already-aborted and post-close calls without compilation or invocation", async () => {
    const first = create();
    const controller = new AbortController();
    controller.abort();
    const cancelled = await first.thinker.think(thinkerRequestFixture(), {
      signal: controller.signal
    });
    expect(!cancelled.ok && cancelled.failure.code).toBe("CANCELLED");
    expect(first.port.primaryInvocationCount()).toBe(0);
    await first.thinker.close();
    const closed = await first.thinker.think(thinkerRequestFixture());
    expect(!closed.ok && closed.failure.code).toBe("THINKER_CLOSED");
  });

  it("enforces event, delta, warning, assistant, and output bounds", async () => {
    const eventWarning = create({ primaryScript: { eventWarnings: ["warning"] } });
    const strictWarnings = createThinker({
      port: eventWarning.port,
      authorizer: allowingPromptAuthorizer(),
      clock: createManualThinkerClock(THINKER_FIXTURE_EPOCH),
      configuration: { ...DEFAULT_THINKER_CONFIGURATION, maxWarnings: 0 }
    });
    const warningResult = await strictWarnings.think(thinkerRequestFixture());
    expect(!warningResult.ok && warningResult.failure.code).toBe("EVENT_BOUNDS_EXCEEDED");
    await strictWarnings.close();

    const bytesPort = createFakeThinkerPort({ primaryScript: { reasoning: "x".repeat(1_025) } });
    const bytesThinker = createThinker({
      port: bytesPort,
      authorizer: allowingPromptAuthorizer(),
      clock: createManualThinkerClock(THINKER_FIXTURE_EPOCH),
      configuration: { ...DEFAULT_THINKER_CONFIGURATION, maxObservedDeltaBytes: 1_024 }
    });
    const bytesResult = await bytesThinker.think(thinkerRequestFixture());
    expect(!bytesResult.ok && bytesResult.failure.code).toBe("EVENT_BOUNDS_EXCEEDED");
    await bytesThinker.close();

    const eventPort = createFakeThinkerPort({ primaryScript: { text: "extra event" } });
    const eventThinker = createThinker({
      port: eventPort,
      authorizer: allowingPromptAuthorizer(),
      clock: createManualThinkerClock(THINKER_FIXTURE_EPOCH),
      configuration: { ...DEFAULT_THINKER_CONFIGURATION, maxEvents: 3 }
    });
    const eventResult = await eventThinker.think(thinkerRequestFixture());
    expect(!eventResult.ok && eventResult.failure.code).toBe("EVENT_BOUNDS_EXCEEDED");
    await eventThinker.close();

    const assistantPort = createFakeThinkerPort({ primaryScript: { text: "assistant text" } });
    const assistantThinker = createThinker({
      port: assistantPort,
      authorizer: allowingPromptAuthorizer(),
      clock: createManualThinkerClock(THINKER_FIXTURE_EPOCH),
      configuration: { ...DEFAULT_THINKER_CONFIGURATION, maxAssistantMessages: 0 }
    });
    const assistantResult = await assistantThinker.think(thinkerRequestFixture());
    expect(!assistantResult.ok && assistantResult.failure.code).toBe("EVENT_BOUNDS_EXCEEDED");
    await assistantThinker.close();

    const resultWarningPort = createFakeThinkerPort({ primaryScript: { resultWarnings: ["warning"] } });
    const resultWarningThinker = createThinker({
      port: resultWarningPort,
      authorizer: allowingPromptAuthorizer(),
      clock: createManualThinkerClock(THINKER_FIXTURE_EPOCH),
      configuration: { ...DEFAULT_THINKER_CONFIGURATION, maxWarnings: 0 }
    });
    const resultWarning = await resultWarningThinker.think(thinkerRequestFixture());
    expect(!resultWarning.ok && resultWarning.failure.code).toBe("EVENT_BOUNDS_EXCEEDED");
    await resultWarningThinker.close();

    const tasksProposal = jsonClone(thinkerProposalFixture()) as unknown as Record<string, unknown>;
    const outputPort = createFakeThinkerPort({ primaryScript: { proposal: tasksProposal as never } });
    const outputThinker = createThinker({
      port: outputPort,
      authorizer: allowingPromptAuthorizer(),
      clock: createManualThinkerClock(THINKER_FIXTURE_EPOCH),
      configuration: { ...DEFAULT_THINKER_CONFIGURATION, maxTasks: 0 }
    });
    const outputResult = await outputThinker.think(thinkerRequestFixture());
    expect(!outputResult.ok && outputResult.failure.code).toBe("PROPOSAL_INVALID");
    await outputThinker.close();

    const tokenPort = createFakeThinkerPort();
    const tokenThinker = createThinker({
      port: tokenPort,
      authorizer: allowingPromptAuthorizer(),
      clock: createManualThinkerClock(THINKER_FIXTURE_EPOCH),
      configuration: { ...DEFAULT_THINKER_CONFIGURATION, maxOutputTokens: 8_191 }
    });
    const tokenResult = await tokenThinker.think(thinkerRequestFixture());
    expect(!tokenResult.ok && tokenResult.failure.code).toBe("INVALID_CONFIGURATION");
    expect(tokenPort.primaryInvocationCount()).toBe(0);
    await tokenThinker.close();
  });

  it("rejects invalid requests and serializes only safe codes", async () => {
    const { thinker } = create();
    const result = await thinker.think({
      canary: THINKER_OUTPUT_CANARY,
      compilation: { taskDescription: THINKER_OUTPUT_CANARY }
    });
    expect(!result.ok && result.failure.code).toBe("INVALID_REQUEST");
    expect(JSON.stringify(result)).not.toContain(THINKER_OUTPUT_CANARY);
    expect(summarizeThinkerResult(result)).toEqual({ outcome: "failed", code: "INVALID_REQUEST" });
    await thinker.close();
  });
});

describe("lifecycle and finite helper behavior", () => {
  it("provides a deterministic mutable test clock without ambient time", () => {
    const clock = createManualThinkerClock("2026-01-01T00:00:00.000Z");
    clock.advance(1_000);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:01.000Z");
    clock.set("2026-02-01T00:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(() => clock.advance(-1)).toThrow(TypeError);
  });

  it("normalizes safe errors and result constructors", () => {
    const error = new ThinkerError("INTERNAL_FAILURE", "Safe failure.");
    expect(asThinkerError(error, "INVALID_REQUEST", "fallback")).toBe(error);
    expect(asThinkerError(new Error("raw"), "INVALID_REQUEST", "fallback").code).toBe(
      "INVALID_REQUEST"
    );
    expect(safeCauseCode({ code: "RATE_LIMITED" })).toBe("RATE_LIMITED");
    expect(safeCauseCode({ code: "bad code" })).toBe("UNKNOWN_FAILURE");
    expect(safeCauseCode("raw")).toBe("UNKNOWN_FAILURE");
    expect(thinkerOk(1)).toEqual({ ok: true, value: 1 });
    const failure = thinkerFailure("INVALID_REQUEST", "Safe.");
    expect(thinkerFailed(failure)).toEqual({ ok: false, failure });
  });
});
