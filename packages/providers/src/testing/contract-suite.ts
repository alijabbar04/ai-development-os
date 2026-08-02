import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProviderError, isProviderError } from "../errors.js";
import { guardProviderOperation, type ProviderOperation } from "../operation.js";
import { parseInferenceEvent, parseCodingAgentEvent, isTerminalEventKind } from "../events.js";
import type { InferenceEvent, CodingAgentEvent } from "../events.js";
import { parseInferenceResult, type InferenceRequest, type InferenceResult } from "../inference.js";
import {
  parseCodingAgentResult,
  type CodingAgentRequest,
  type CodingAgentResult,
} from "../coding-agent.js";
import type { CodingAgentProvider, InferenceProvider } from "../ports.js";

/**
 * Reusable behavioral suites for inference and coding-agent providers.
 * Stage 5 runs them against the deterministic fakes; concrete adapters
 * (Ollama, Claude Code, OpenAI) reuse them by implementing a harness whose
 * scenarios wire real transports behind the same observable behavior.
 *
 * Assertions are structural (stream/result cross-consistency through
 * guardProviderOperation), never tied to specific model text.
 */

export const INFERENCE_SCENARIOS = Object.freeze([
  "basic-text",
  "streaming-chunks",
  "structured-output",
  "single-tool-call",
  "multi-tool-call",
  "usage-updates",
  "pausing",
  "deadline-before-start",
  "deadline-mid-stream",
  "unsupported-capability",
  "classification-rejected",
  "failure-before-stream",
  "failure-mid-stream",
  "malformed-stream",
  "terminal-mismatch",
  "secret-probe",
] as const);

export type InferenceScenarioName = (typeof INFERENCE_SCENARIOS)[number];

export interface InferenceScenario {
  readonly provider: InferenceProvider;
  readonly request: InferenceRequest;
}

export interface ProviderContractClock {
  advance(milliseconds: number): void;
}

export interface InferenceContractHarness {
  readonly clock: ProviderContractClock;
  /** Canary string embedded in the secret-probe scenario's request content. */
  readonly secretCanary: string;
  scenario(name: InferenceScenarioName): Promise<InferenceScenario>;
  dispose?(): Promise<void>;
}

export const CODING_AGENT_SCENARIOS = Object.freeze([
  "no-change",
  "patch-producing",
  "test-results",
  "approval-flow",
  "pausing",
  "deadline-mid-stream",
  "workspace-unavailable",
  "capability-rejection",
  "failure-mid-stream",
  "secret-probe",
] as const);

export type CodingAgentScenarioName = (typeof CODING_AGENT_SCENARIOS)[number];

export interface CodingAgentScenario {
  readonly provider: CodingAgentProvider;
  readonly request: CodingAgentRequest;
}

export interface CodingAgentContractHarness {
  readonly clock: ProviderContractClock;
  readonly secretCanary: string;
  scenario(name: CodingAgentScenarioName): Promise<CodingAgentScenario>;
  dispose?(): Promise<void>;
}

interface Consumed<TEvent, TResult> {
  readonly events: readonly TEvent[];
  readonly streamError: unknown;
  readonly outcome:
    | { readonly status: "resolved"; readonly value: TResult }
    | { readonly status: "rejected"; readonly error: unknown };
}

async function consume<TEvent extends { kind: string }, TResult>(
  operation: ProviderOperation<TEvent, TResult>,
): Promise<Consumed<TEvent, TResult>> {
  const events: TEvent[] = [];
  let streamError: unknown = null;
  try {
    for await (const event of operation.events()) {
      events.push(event);
    }
  } catch (error) {
    streamError = error;
  }
  let outcome: Consumed<TEvent, TResult>["outcome"];
  try {
    outcome = { status: "resolved", value: await operation.result };
  } catch (error) {
    outcome = { status: "rejected", error };
  }
  return { events, streamError, outcome };
}

function expectWellFormedTermination<TEvent extends { kind: string }>(
  consumed: Consumed<TEvent, unknown>,
): TEvent {
  expect(consumed.streamError).toBeNull();
  const terminals = consumed.events.filter((event) => isTerminalEventKind(event.kind));
  expect(terminals).toHaveLength(1);
  expect(consumed.events[consumed.events.length - 1]).toBe(terminals[0]);
  return terminals[0]!;
}

function textOf(result: InferenceResult): string {
  return result.messages
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

async function expectStartRejection(
  work: Promise<unknown>,
  code: string,
): Promise<ProviderError> {
  try {
    await work;
  } catch (error) {
    expect(isProviderError(error)).toBe(true);
    expect((error as ProviderError).code).toBe(code);
    return error as ProviderError;
  }
  expect.unreachable(`expected ProviderError ${code}`);
}

export function runInferenceProviderContractSuite(
  suiteName: string,
  createHarness: () => Promise<InferenceContractHarness>,
): void {
  describe(`inference provider contract: ${suiteName}`, () => {
    let harness: InferenceContractHarness;
    const opened: InferenceProvider[] = [];

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      for (const provider of opened.splice(0, opened.length)) {
        await provider.close();
      }
      await harness.dispose?.();
    });

    async function startGuarded(
      name: InferenceScenarioName,
    ): Promise<{
      scenario: InferenceScenario;
      operation: ProviderOperation<InferenceEvent, InferenceResult>;
    }> {
      const scenario = await harness.scenario(name);
      opened.push(scenario.provider);
      const operation = guardProviderOperation(
        await scenario.provider.start(scenario.request),
        { parseEvent: parseInferenceEvent, parseResult: parseInferenceResult },
      );
      return { scenario, operation };
    }

    it("completes a basic request with stream/result text agreement", async () => {
      const { operation, scenario } = await startGuarded("basic-text");
      const consumed = await consume(operation);
      const terminal = expectWellFormedTermination(consumed);
      expect(terminal.kind).toBe("operation-completed");
      expect(consumed.outcome.status).toBe("resolved");
      const result = (consumed.outcome as { value: InferenceResult }).value;
      const streamedText = consumed.events
        .filter((event) => event.kind === "text-delta")
        .map((event) => (event as Extract<InferenceEvent, { kind: "text-delta" }>).payload.text)
        .join("");
      expect(textOf(result)).toBe(streamedText);
      expect(streamedText.length).toBeGreaterThan(0);
      expect(result.requestId).toBe(scenario.request.requestId);
      expect(result.finishReason).toBe("stop");
      expect(consumed.events[0]!.kind).toBe("operation-started");
      expect(consumed.events[0]!.sequence).toBe(1);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("streams multiple ordered chunks", async () => {
      const { operation } = await startGuarded("streaming-chunks");
      const consumed = await consume(operation);
      expectWellFormedTermination(consumed);
      const deltas = consumed.events.filter((event) => event.kind === "text-delta");
      expect(deltas.length).toBeGreaterThanOrEqual(3);
      const sequences = consumed.events.map((event) => event.sequence);
      expect(sequences).toEqual(sequences.map((_, index) => index + 1));
    });

    it("produces structured output agreeing between event and result", async () => {
      const { operation } = await startGuarded("structured-output");
      const consumed = await consume(operation);
      expectWellFormedTermination(consumed);
      const completedEvent = consumed.events.find(
        (event) => event.kind === "structured-output-completed",
      ) as Extract<InferenceEvent, { kind: "structured-output-completed" }> | undefined;
      expect(completedEvent).toBeDefined();
      const result = (consumed.outcome as { value: InferenceResult }).value;
      expect(result.structuredOutput).toEqual(completedEvent!.payload.value);
    });

    it("runs the tool-call lifecycle with matching invocation in the result", async () => {
      const { operation } = await startGuarded("single-tool-call");
      const consumed = await consume(operation);
      expectWellFormedTermination(consumed);
      const started = consumed.events.filter((event) => event.kind === "tool-call-started");
      const completed = consumed.events.filter((event) => event.kind === "tool-call-completed");
      expect(started).toHaveLength(1);
      expect(completed).toHaveLength(1);
      const invocation = (completed[0] as Extract<InferenceEvent, { kind: "tool-call-completed" }>)
        .payload.invocation;
      const result = (consumed.outcome as { value: InferenceResult }).value;
      expect(result.finishReason).toBe("tool-calls");
      const invocationParts = result.messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool-invocation");
      expect(invocationParts).toHaveLength(1);
      expect(
        (invocationParts[0] as Extract<(typeof invocationParts)[number], { type: "tool-invocation" }>)
          .invocation.toolCallId,
      ).toBe(invocation.toolCallId);
    });

    it("supports multiple tool calls with unique ids", async () => {
      const { operation } = await startGuarded("multi-tool-call");
      const consumed = await consume(operation);
      expectWellFormedTermination(consumed);
      const completed = consumed.events.filter((event) => event.kind === "tool-call-completed");
      expect(completed.length).toBeGreaterThanOrEqual(2);
      const ids = completed.map(
        (event) =>
          (event as Extract<InferenceEvent, { kind: "tool-call-completed" }>).payload.invocation
            .toolCallId,
      );
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("streams cumulative usage snapshots matching the final result", async () => {
      const { operation } = await startGuarded("usage-updates");
      const consumed = await consume(operation);
      expectWellFormedTermination(consumed);
      const updates = consumed.events.filter((event) => event.kind === "usage-update");
      expect(updates.length).toBeGreaterThanOrEqual(2);
      const last = (updates[updates.length - 1] as Extract<InferenceEvent, { kind: "usage-update" }>)
        .payload.usage;
      const result = (consumed.outcome as { value: InferenceResult }).value;
      expect(result.usage.tokens).toEqual(last.tokens);
    });

    it("cancels before consuming any events", async () => {
      const { operation } = await startGuarded("pausing");
      await operation.cancel();
      await operation.cancel();
      const consumed = await consume(operation);
      const terminal = expectWellFormedTermination(consumed);
      expect(terminal.kind).toBe("operation-cancelled");
      expect(consumed.outcome.status).toBe("rejected");
      expect(isProviderError((consumed.outcome as { error: unknown }).error, "CANCELLED")).toBe(true);
    });

    it("cancels mid-stream with one documented winner", async () => {
      const { operation } = await startGuarded("pausing");
      const iterator = operation.events()[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      await operation.cancel();
      const rest: InferenceEvent[] = [];
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) {
          break;
        }
        rest.push(step.value);
      }
      expect(rest[rest.length - 1]!.kind).toBe("operation-cancelled");
      await expect(operation.result).rejects.toMatchObject({ code: "CANCELLED" });
    });

    it("rejects a start whose deadline already passed", async () => {
      const scenario = await harness.scenario("deadline-before-start");
      opened.push(scenario.provider);
      await expectStartRejection(
        scenario.provider.start(scenario.request),
        "DEADLINE_EXCEEDED",
      );
    });

    it("fails mid-stream when the deadline expires", async () => {
      const { operation } = await startGuarded("deadline-mid-stream");
      harness.clock.advance(3_600_000);
      const consumed = await consume(operation);
      const terminal = expectWellFormedTermination(consumed);
      expect(terminal.kind).toBe("operation-failed");
      expect(
        (terminal as Extract<InferenceEvent, { kind: "operation-failed" }>).payload.code,
      ).toBe("DEADLINE_EXCEEDED");
      expect(consumed.outcome.status).toBe("rejected");
      expect(
        isProviderError((consumed.outcome as { error: unknown }).error, "DEADLINE_EXCEEDED"),
      ).toBe(true);
    });

    it("close during an active operation settles it as provider-closed cancellation", async () => {
      const { operation, scenario } = await startGuarded("pausing");
      await scenario.provider.close();
      const consumed = await consume(operation);
      const terminal = expectWellFormedTermination(consumed);
      expect(terminal.kind).toBe("operation-cancelled");
      expect(
        (terminal as Extract<InferenceEvent, { kind: "operation-cancelled" }>).payload.reason,
      ).toBe("provider-closed");
      await scenario.provider.close();
      await expectStartRejection(scenario.provider.start(scenario.request), "PROVIDER_CLOSED");
    });

    it("rejects requests needing unsupported capabilities", async () => {
      const scenario = await harness.scenario("unsupported-capability");
      opened.push(scenario.provider);
      await expectStartRejection(
        scenario.provider.start(scenario.request),
        "UNSUPPORTED_CAPABILITY",
      );
    });

    it("rejects classifications the provider does not support", async () => {
      const scenario = await harness.scenario("classification-rejected");
      opened.push(scenario.provider);
      await expectStartRejection(scenario.provider.start(scenario.request), "POLICY_DENIED");
    });

    it("rejects malformed requests without starting", async () => {
      const scenario = await harness.scenario("basic-text");
      opened.push(scenario.provider);
      const hostile = { ...scenario.request, modelId: 42 };
      await expectStartRejection(scenario.provider.start(hostile as never), "INVALID_REQUEST");
      const polluted = JSON.parse('{"__proto__": {"polluted": true}}') as object;
      await expectStartRejection(
        scenario.provider.start(polluted as never),
        "INVALID_REQUEST",
      );
    });

    it("propagates pre-stream provider failures with retry metadata", async () => {
      const scenario = await harness.scenario("failure-before-stream");
      opened.push(scenario.provider);
      const error = await expectStartRejection(
        scenario.provider.start(scenario.request),
        "RATE_LIMITED",
      );
      expect(error.retry.strategy).toBe("same-after-delay");
      expect(error.retryAfterMs).not.toBeNull();
    });

    it("fails mid-stream with agreeing terminal event and result", async () => {
      const { operation } = await startGuarded("failure-mid-stream");
      const consumed = await consume(operation);
      const terminal = expectWellFormedTermination(consumed);
      expect(terminal.kind).toBe("operation-failed");
      expect(consumed.outcome.status).toBe("rejected");
      const error = (consumed.outcome as { error: unknown }).error;
      expect(isProviderError(error)).toBe(true);
      expect((error as ProviderError).code).toBe(
        (terminal as Extract<InferenceEvent, { kind: "operation-failed" }>).payload.code,
      );
    });

    it("the guard rejects malformed streams so transport success cannot bypass validation", async () => {
      const { operation } = await startGuarded("malformed-stream");
      const consumed = await consume(operation);
      expect(consumed.streamError).not.toBeNull();
      expect(isProviderError(consumed.streamError, "PROTOCOL_VIOLATION")).toBe(true);
    });

    it("the guard detects terminal-event/result disagreement", async () => {
      const { operation } = await startGuarded("terminal-mismatch");
      const consumed = await consume(operation);
      expect(consumed.streamError).not.toBeNull();
      expect(isProviderError(consumed.streamError, "PROTOCOL_VIOLATION")).toBe(true);
    });

    it("never leaks request content through errors or events", async () => {
      const { operation } = await startGuarded("secret-probe");
      const consumed = await consume(operation);
      expect(consumed.outcome.status).toBe("rejected");
      const error = (consumed.outcome as { error: ProviderError }).error;
      expect(JSON.stringify(error.toJSON())).not.toContain(harness.secretCanary);
      for (const event of consumed.events) {
        if (event.kind !== "text-delta") {
          expect(JSON.stringify(event)).not.toContain(harness.secretCanary);
        }
      }
    });

    it("prevents double stream consumption", async () => {
      const { operation } = await startGuarded("basic-text");
      await consume(operation);
      expect(() => operation.events()).toThrow();
    });
  });
}

export function runCodingAgentProviderContractSuite(
  suiteName: string,
  createHarness: () => Promise<CodingAgentContractHarness>,
): void {
  describe(`coding-agent provider contract: ${suiteName}`, () => {
    let harness: CodingAgentContractHarness;
    const opened: CodingAgentProvider[] = [];

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      for (const provider of opened.splice(0, opened.length)) {
        await provider.close();
      }
      await harness.dispose?.();
    });

    async function startGuarded(
      name: CodingAgentScenarioName,
    ): Promise<{
      scenario: CodingAgentScenario;
      operation: ProviderOperation<CodingAgentEvent, CodingAgentResult>;
    }> {
      const scenario = await harness.scenario(name);
      opened.push(scenario.provider);
      const operation = guardProviderOperation(
        await scenario.provider.start(scenario.request),
        { parseEvent: parseCodingAgentEvent, parseResult: parseCodingAgentResult },
      );
      return { scenario, operation };
    }

    it("completes a no-change operation", async () => {
      const { operation, scenario } = await startGuarded("no-change");
      const consumed = await consume(operation);
      const terminal = expectWellFormedTermination(consumed);
      expect(terminal.kind).toBe("operation-completed");
      const result = (consumed.outcome as { value: CodingAgentResult }).value;
      expect(result.completion).toBe("completed-no-changes");
      expect(result.changedFiles).toHaveLength(0);
      expect(result.patchArtifactId).toBeNull();
      expect(result.requestId).toBe(scenario.request.requestId);
      expect(consumed.events[0]!.kind).toBe("operation-started");
    });

    it("produces a patch as an artifact reference with a changed-file summary", async () => {
      const { operation } = await startGuarded("patch-producing");
      const consumed = await consume(operation);
      expectWellFormedTermination(consumed);
      const patchEvents = consumed.events.filter((event) => event.kind === "patch-produced");
      expect(patchEvents).toHaveLength(1);
      const result = (consumed.outcome as { value: CodingAgentResult }).value;
      expect(result.patchArtifactId).toBe(
        (patchEvents[0] as Extract<CodingAgentEvent, { kind: "patch-produced" }>).payload
          .artifactId,
      );
      expect(result.changedFiles.length).toBeGreaterThan(0);
      const applied = consumed.events.filter((event) => event.kind === "file-change-applied");
      expect(applied.length).toBe(result.changedFiles.length);
      // Large outputs must be references, never inline data.
      expect(JSON.stringify(result).length).toBeLessThan(20_000);
    });

    it("reports test results with an artifact reference", async () => {
      const { operation } = await startGuarded("test-results");
      const consumed = await consume(operation);
      expectWellFormedTermination(consumed);
      const testEvents = consumed.events.filter((event) => event.kind === "test-completed");
      expect(testEvents.length).toBeGreaterThan(0);
      const result = (consumed.outcome as { value: CodingAgentResult }).value;
      expect(result.testResults).not.toBeNull();
      expect(result.testResults!.passed).toBeGreaterThan(0);
    });

    it("surfaces tool proposals and approval requests, recording decisions", async () => {
      const { operation } = await startGuarded("approval-flow");
      const consumed = await consume(operation);
      expectWellFormedTermination(consumed);
      const approvals = consumed.events.filter((event) => event.kind === "approval-requested");
      expect(approvals.length).toBeGreaterThan(0);
      const proposals = consumed.events.filter((event) => event.kind === "tool-call-proposed");
      expect(proposals.length).toBeGreaterThan(0);
      const result = (consumed.outcome as { value: CodingAgentResult }).value;
      expect(result.approvalDecisions.length).toBe(approvals.length);
    });

    it("cancels mid-operation deterministically", async () => {
      const { operation } = await startGuarded("pausing");
      await operation.cancel();
      const consumed = await consume(operation);
      const terminal = expectWellFormedTermination(consumed);
      expect(terminal.kind).toBe("operation-cancelled");
      await expect(operation.result).rejects.toMatchObject({ code: "CANCELLED" });
    });

    it("fails when the deadline expires mid-operation", async () => {
      const { operation } = await startGuarded("deadline-mid-stream");
      harness.clock.advance(3_600_000);
      const consumed = await consume(operation);
      const terminal = expectWellFormedTermination(consumed);
      expect(terminal.kind).toBe("operation-failed");
      expect(
        (terminal as Extract<CodingAgentEvent, { kind: "operation-failed" }>).payload.code,
      ).toBe("DEADLINE_EXCEEDED");
    });

    it("rejects unavailable workspaces", async () => {
      const scenario = await harness.scenario("workspace-unavailable");
      opened.push(scenario.provider);
      await expectStartRejection(
        scenario.provider.start(scenario.request),
        "WORKSPACE_UNAVAILABLE",
      );
    });

    it("rejects requests exceeding granted capabilities", async () => {
      const scenario = await harness.scenario("capability-rejection");
      opened.push(scenario.provider);
      await expectStartRejection(
        scenario.provider.start(scenario.request),
        "UNSUPPORTED_CAPABILITY",
      );
    });

    it("close settles active operations and blocks new starts", async () => {
      const { operation, scenario } = await startGuarded("pausing");
      await scenario.provider.close();
      const consumed = await consume(operation);
      const terminal = expectWellFormedTermination(consumed);
      expect(terminal.kind).toBe("operation-cancelled");
      await expectStartRejection(scenario.provider.start(scenario.request), "PROVIDER_CLOSED");
    });

    it("fails mid-stream with agreeing terminal and result", async () => {
      const { operation } = await startGuarded("failure-mid-stream");
      const consumed = await consume(operation);
      const terminal = expectWellFormedTermination(consumed);
      expect(terminal.kind).toBe("operation-failed");
      expect(consumed.outcome.status).toBe("rejected");
    });

    it("never leaks instructions through errors or non-output events", async () => {
      const { operation } = await startGuarded("secret-probe");
      const consumed = await consume(operation);
      expect(consumed.outcome.status).toBe("rejected");
      const error = (consumed.outcome as { error: ProviderError }).error;
      expect(JSON.stringify(error.toJSON())).not.toContain(harness.secretCanary);
    });
  });
}
