/** Owned synthetic test port. Never imported by normal application composition. */
import { randomUUID } from "node:crypto";
import { CLAUDE_PLANNING_PROTOCOL, CLAUDE_PLANNING_PROVIDER_ID, type PlanningAdmission, type PlanningProcessPort, type PlanningProcessOutcome } from "@ai-dev-os/provider-claude-code";
import { parseModelDescriptor } from "@ai-dev-os/providers";
import { digestPlanning } from "../planning-validation.js";

export function ownedAiOutput(purpose: "understanding" | "proposal") {
  return { schemaVersion: 1, status: purpose === "understanding" ? "clarification-required" : "viable", objective: "Plan a local field journal",
    assumptions: ["Audience: Field researchers", "Non-goal: Cloud synchronization", "The operator reviews all proposed requirements."], risks: ["A storage design still needs separate implementation."],
    openQuestions: purpose === "understanding" ? ["Should field notes include photographs?"] : [], completionCriteria: ["Retain a field note after reopening."],
    tasks: purpose === "understanding" ? [] : [
      { proposalId: "capture", kind: "plan", title: "Capture a field note", description: "Retain a field note after reopening.", dependencies: [], acceptanceCriteria: ["A saved note is visible after reopening."], evidence: [], unsupportedAssumptions: [], complexity: 1, reasoning: "low", capabilities: ["reasoning", "structured-output"], editScope: "none", risk: "low", classification: "internal" },
      { proposalId: "find", kind: "plan", title: "Find a field note", description: "Find a previously saved observation.", dependencies: ["capture"], acceptanceCriteria: ["A saved observation can be found by its date."], evidence: [], unsupportedAssumptions: [], complexity: 1, reasoning: "low", capabilities: ["reasoning", "structured-output"], editScope: "none", risk: "low", classification: "internal" },
    ] };
}
export function ownedAiResult(output: unknown): PlanningProcessOutcome {
  return { state: "exited", exitCode: 0, stdout: Buffer.from(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, permission_denials: [], structured_output: output,
    usage: { input_tokens: 12, output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, modelUsage: { "synthetic-owned-model": { inputTokens: 12, outputTokens: 25, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } } })), stderrBytes: 0, truncated: false, terminationConfirmed: true };
}
export function createOwnedAiTestPort(options: { execute?: (input: Parameters<PlanningProcessPort["execute"]>[0], result: PlanningProcessOutcome) => Promise<PlanningProcessOutcome> } = {}) {
  let purpose: "understanding" | "proposal" = "understanding", output: unknown | undefined, drift = false;
  const dispatched: Parameters<PlanningProcessPort["execute"]>[0][] = [], tokens = new Map<PlanningAdmission, { fingerprint: string; binding: string; used: boolean }>();
  const model = parseModelDescriptor({ availability: "available", model: { schemaVersion: 1, providerId: CLAUDE_PLANNING_PROVIDER_ID, modelId: "synthetic-owned-model", contextWindowTokens: 32_768, maxOutputTokens: 8192, supportsToolUse: false, supportsStructuredOutput: true, supportsVision: false, locality: "cloud", latencyClass: "standard", codingCapability: 1, reasoningCapability: 1, cost: null } });
  const route = { state: "qualified" as const, source: "synthetic-fixture" as const, model, configurationFingerprint: "a".repeat(64), qualificationFingerprint: "b".repeat(64), protocol: CLAUDE_PLANNING_PROTOCOL as typeof CLAUDE_PLANNING_PROTOCOL, subscriptionAllowance: "unknown" as const, expiresAt: new Date(Date.now() + 120_000).toISOString(), disclosure: { retainsData: false, trainsOnInputs: false, supportedClassifications: ["public", "internal"] as const } };
  const host: PlanningProcessPort = { status: () => drift ? { ...route, qualificationFingerprint: "c".repeat(64) } : route,
    async authorize(binding, fingerprint) { const token = Object.freeze({ receiptId: `owned-test-admission:${randomUUID()}` }); tokens.set(token, { fingerprint, binding: digestPlanning(binding), used: false }); return token; },
    assertCurrent(admission, binding, fingerprint) { const token = tokens.get(admission); if (token === undefined || token.used || token.binding !== digestPlanning(binding) || token.fingerprint !== fingerprint || drift) throw new Error("OWNED_FIXTURE_ADMISSION_REFUSED"); },
    async execute(input) {
      host.assertCurrent(input.admission, input.binding, input.requestFingerprint); tokens.get(input.admission)!.used = true;
      if (input.signal.aborted) return { state: "cancelled", exitCode: null, stdout: new Uint8Array(), stderrBytes: 0, truncated: false, terminationConfirmed: true };
      dispatched.push(input); const result = ownedAiResult(output ?? ownedAiOutput(purpose));
      return options.execute === undefined ? result : options.execute(input, result);
    } };
  return { host, dispatched, setPurpose(value: typeof purpose) { purpose = value; }, setOutput(value: unknown) { output = value; }, drift() { drift = true; } };
}
