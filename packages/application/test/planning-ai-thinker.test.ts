import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_PLANNING_PROTOCOL, CLAUDE_PLANNING_PROVIDER_ID, createBlockedPlanningProcessPort,
  planningInferenceFingerprint, type PlanningInferenceObservation, type PlanningProcessPort,
  type PlanningProcessOutcome,
} from "@ai-dev-os/provider-claude-code";
import { parseModelDescriptor } from "@ai-dev-os/providers";
import { prepareAiPlanningInference, runAiPlanningInference } from "../src/planning-ai-thinker.js";

const at = "2026-09-09T12:00:00.000Z";
const clock = { now: () => new Date(at) };
const context = { dataClassification: "internal", description: "A local notes app that keeps field observations after reopening.",
  acceptedBrief: { outcomes: ["Create a field note and retain it after reopening."], audiences: ["Field researcher"] } };
const identity = { requestId: "request-1", sessionId: "session-1", projectId: "prj:owned-notes" };
const digest = "a".repeat(64);
const model = parseModelDescriptor({ availability: "available", model: { schemaVersion: 1,
  providerId: CLAUDE_PLANNING_PROVIDER_ID, modelId: "synthetic-planning-model", contextWindowTokens: 32_768,
  maxOutputTokens: 8_192, supportsToolUse: false, supportsStructuredOutput: true, supportsVision: false,
  locality: "cloud", latencyClass: "standard", codingCapability: 1, reasoningCapability: 1, cost: null,
} });
function proposal(purpose: "understanding" | "proposal") {
  return { schemaVersion: 1, status: purpose === "understanding" ? "clarification-required" : "viable",
    objective: "A local field-notes project", assumptions: ["Audience: Field researcher", "Non-goal: Cloud synchronization", "The operator will review each requirement."],
    risks: ["The storage format still needs an implementation decision."],
    openQuestions: purpose === "understanding" ? ["Should the notes support photographs?"] : [],
    completionCriteria: ["A new field note remains available after reopening."],
    tasks: purpose === "understanding" ? [] : [{ proposalId: "notes-1", kind: "plan", title: "Plan durable field notes",
      description: "Specify note creation and recovery behavior.", dependencies: [],
      acceptanceCriteria: ["A note remains after reopening."], evidence: [],
      unsupportedAssumptions: ["Implementation remains subject to separate scope review."],
      complexity: 2, reasoning: "medium", capabilities: ["reasoning", "structured-output"],
      editScope: "none", risk: "low", classification: "internal" }],
  };
}
function processResult(value: unknown): PlanningProcessOutcome {
  return { state: "exited", exitCode: 0, terminationConfirmed: true, truncated: false, stderrBytes: 0,
    stdout: Buffer.from(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1,
      permission_denials: [], structured_output: value,
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: { "synthetic-planning-model": { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
    })) };
}
function fixture(purpose: "understanding" | "proposal", output: unknown = proposal(purpose)) {
  const admission = Object.freeze({ receiptId: "synthetic-exact-admission" });
  let admittedFingerprint: string | null = null;
  const execute = vi.fn<PlanningProcessPort["execute"]>(async () => processResult(output));
  const host: PlanningProcessPort = {
    status: () => ({ state: "qualified", source: "synthetic-fixture", model, configurationFingerprint: digest,
      qualificationFingerprint: digest, protocol: CLAUDE_PLANNING_PROTOCOL, subscriptionAllowance: "unknown",
      expiresAt: "2026-09-09T13:00:00.000Z", disclosure: { retainsData: false, trainsOnInputs: false, supportedClassifications: ["public", "internal"] } }),
    authorize: async (binding, fingerprint) => {
      expect(binding.projectId).toBe(identity.projectId); expect(binding.requestId).toBe(identity.requestId);
      admittedFingerprint = fingerprint; return admission;
    },
    assertCurrent: (receipt, _binding, fingerprint) => {
      if (receipt !== admission || fingerprint !== admittedFingerprint) throw new Error("wrong admission");
    }, execute,
  };
  return { purpose, context, bindingIdentity: identity, host, clock, execute };
}

describe("genuine AI planning thinker composition", () => {
  it("refuses the real unqualified route without host admission or process effects", async () => {
    const host = createBlockedPlanningProcessPort();
    await expect(runAiPlanningInference({ purpose: "understanding", context, bindingIdentity: identity, host, clock })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(host.status()).toMatchObject({ state: "LIVE_ROUTE_BLOCKED", modelId: null });
  });

  it("prepares the full native-review subject without dispatch, preserving internal classification", async () => {
    const input = fixture("understanding");
    const prepared = await prepareAiPlanningInference(input);
    expect(input.execute).not.toHaveBeenCalled();
    expect(prepared.compilation.context.pack.items).toHaveLength(1);
    expect(prepared.compilation.context.pack.items[0]?.classification).toBe("internal");
    expect(prepared.inferenceRequest.disclosure.classification).toBe("internal");
    expect(prepared.inferenceRequest.disclosure.redactionApplied).toBe(false);
    expect(prepared.binding.contextDigest).toBe(planningInferenceFingerprint(prepared.inferenceRequest.messages));
    expect(prepared.inputContextDigest).toBe(planningInferenceFingerprint(context));
    expect(prepared.configuration.providers[0]?.credentialRef).toBeNull();
    expect(prepared.compilation.policy.approvalEvidence).toEqual([]);
    expect(prepared.compilation.policy.transformationsApplied).toEqual([]);
  });

  it("retains a correctly attributed clarification through actual policy/compiler/thinker contracts", async () => {
    const input = fixture("understanding");
    const result = await runAiPlanningInference(input);
    expect(input.execute).toHaveBeenCalledTimes(1);
    expect(result.refusalReason).toBeNull();
    expect(result.output).toMatchObject({ understanding: {
      summary: "A local field-notes project", audiences: ["Field researcher"],
      outcomes: ["A new field note remains available after reopening."], nonGoals: ["Cloud synchronization"],
    }, questions: [{ question: "Should the notes support photographs?", blocking: true }] });
    expect(result.contribution.authority).toBe("none");
    expect(result.contribution.proposal).toEqual(proposal("understanding"));
    expect(result.contribution.receipt.modelId).toBe("synthetic-planning-model");
    expect(result.contributionDigest).toBe(planningInferenceFingerprint(result.contribution));
    expect(result.narrativeRef).toBe(`nar:${result.contributionDigest}`);
    expect(result.routeFingerprint).toBe(result.contribution.target.gatewayFingerprint);
  });

  it("projects an adoptable task plan without replacing original model provenance", async () => {
    const input = fixture("proposal");
    const result = await runAiPlanningInference(input);
    expect(result.refusalReason).toBeNull();
    expect(result.output).toEqual({ title: "A local field-notes project", tasks: [{ taskId: "notes-1", title: "Plan durable field notes",
      objective: "Specify note creation and recovery behavior.", acceptanceCriteria: ["A note remains after reopening."], dependsOn: [] }] });
    expect(result.contribution.proposal.tasks[0]?.unsupportedAssumptions).toEqual(["Implementation remains subject to separate scope review."]);
    expect(result.contribution.receipt.usage.tokens.outputTokens).toBe(20);
    expect(result.contribution.receipt.cost).toEqual({ providerReported: null, locallyComputed: null });
  });

  it.each(["blocked", "clarification-required"])("retains a valid %s proposal contribution without adoption", async (status) => {
    const output = { ...proposal("proposal"), status, tasks: [] };
    const result = await runAiPlanningInference(fixture("proposal", output));
    expect(result.output).toBeNull();
    expect(result.refusalReason).toBeTypeOf("string");
    expect(result.contribution.proposal.status).toBe(status);
    expect(result.contributionDigest).toBe(planningInferenceFingerprint(result.contribution));
  });

  it("retains model content with incomplete audiences instead of inventing a requirement", async () => {
    const output = { ...proposal("understanding"), assumptions: [] };
    const result = await runAiPlanningInference(fixture("understanding", output));
    expect(result.output).toBeNull();
    expect(result.refusalReason).toBeTypeOf("string");
    expect(result.contribution.proposal.assumptions).toEqual([]);
  });

  it.each([
    ["fabricated evidence", (value: any) => { value.tasks[0].evidence = [{ identity: "invented-evidence", digest }]; }],
    ["invented approval", (value: any) => { value.approval = "approved"; }],
    ["lowered classification", (value: any) => { value.tasks[0].classification = "public"; }],
    ["execution capability", (value: any) => { value.tasks[0].capabilities.push("shell"); }],
  ])("rejects %s through genuine validation", async (_label, mutate) => {
    const output = proposal("proposal"); mutate(output);
    const input = fixture("proposal", output);
    await expect(runAiPlanningInference(input)).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    expect(input.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["secret classification", { ...context, dataClassification: "secret" }],
    ["personal classification", { ...context, dataClassification: "personal" }],
    ["source classification", { ...context, dataClassification: "proprietary-source" }],
    ["recognizable token", { ...context, description: `Use sk-ant-${"a".repeat(32)}` }],
    ["oversized input", { ...context, description: "a".repeat(40_000) }],
  ])("refuses %s before inference", async (_label, snapshot) => {
    const input = fixture("understanding");
    await expect(runAiPlanningInference({ ...input, context: snapshot })).rejects.toBeDefined();
    expect(input.execute).not.toHaveBeenCalled();
  });

  it("preserves cancellation and unknown usage when the synthetic host returns late", async () => {
    const input = fixture("proposal");
    let launch!: () => void, finish!: (outcome: PlanningProcessOutcome) => void;
    const launched = new Promise<void>((resolve) => { launch = resolve; });
    input.execute.mockImplementation(async () => { launch(); return await new Promise((resolve) => { finish = resolve; }); });
    const observations: PlanningInferenceObservation[] = [];
    const abort = new AbortController();
    const result = runAiPlanningInference({ ...input, signal: abort.signal, onObservation: (event) => observations.push(event) });
    await launched;
    abort.abort();
    await expect(result).rejects.toMatchObject({ code: "CANCELLED" });
    finish(processResult(proposal("proposal")));
    expect(observations.some((event) => event.state === "succeeded")).toBe(false);
    expect(observations.at(-1)).toMatchObject({ usage: { state: "unknown" } });
  });
});
