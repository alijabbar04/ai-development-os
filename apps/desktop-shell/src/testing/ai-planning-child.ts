import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseModelDescriptor } from "@ai-dev-os/providers";
import type { createSavedPlanningApplication } from "@ai-dev-os/application/planning";
import { runOwnedServiceChild } from "../service/child.js";
import { canonicalServicePath } from "../service/storage-paths.js";
import { exactPlanningRecord } from "../shared/planning-ipc.js";

type ProcessPort = NonNullable<Parameters<typeof createSavedPlanningApplication>[0]["planningProcess"]>;
type Admission = Awaited<ReturnType<ProcessPort["authorize"]>>;
const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// This entry is never selected by production arguments, environment or IPC.
// The qualified source is explicitly synthetic and has no external process.
runOwnedServiceChild(undefined, async (dataRoot): Promise<ProcessPort> => {
  const root = await canonicalServicePath(dirname(resolve(dataRoot))), parent = dirname(root);
  if (basename(root) !== "owned-ai-planning-user-data" || !basename(parent).startsWith("ai-dev-os-desktop-saved-smoke-") || basename(dataRoot) !== "saved-workspace") throw new Error("AI_PLANNING_FIXTURE_NOT_OWNED");
  const marker = join(root, "owned-fixture.json"), stat = await lstat(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256) throw new Error("AI_PLANNING_FIXTURE_INVALID");
  const owned = exactPlanningRecord(JSON.parse(await readFile(marker, "utf8")), ["kind", "version"]);
  if (owned["kind"] !== "owned-synthetic-ai-planning" || owned["version"] !== 1) throw new Error("AI_PLANNING_FIXTURE_INVALID");
  const model = parseModelDescriptor({ availability: "available", model: { schemaVersion: 1, providerId: "claude-code-planning", modelId: "synthetic-planning-model", contextWindowTokens: 32_768,
    maxOutputTokens: 8_192, supportsToolUse: false, supportsStructuredOutput: true, supportsVision: false, locality: "cloud", latencyClass: "standard", codingCapability: 1, reasoningCapability: 1, cost: null } });
  const route = Object.freeze({ state: "qualified" as const, source: "synthetic-fixture" as const, model, configurationFingerprint: sha("owned synthetic planning configuration"), qualificationFingerprint: sha("owned synthetic planning qualification"), protocol: "claude-print-json-2.1.263-v1" as const,
    disclosure: { retainsData: false, trainsOnInputs: false, supportedClassifications: ["public", "internal"] as const },
    subscriptionAllowance: "unknown" as const, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const receipts = new Map<Admission, { subject: string; used: boolean }>(), logPath = join(root, "synthetic-dispatches.jsonl");
  let previous = ""; try { previous = await readFile(logPath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let count = previous.trim().length === 0 ? 0 : previous.trim().split("\n").length;
  const assertCurrent: ProcessPort["assertCurrent"] = (admission, binding, fingerprint) => {
    const receipt = receipts.get(admission);
    if (receipt === undefined || receipt.used || receipt.subject !== sha({ binding, fingerprint }) || Date.parse(binding.deadline) <= Date.now() || binding.modelId !== model.model.modelId
      || binding.configurationFingerprint !== route.configurationFingerprint || binding.qualificationFingerprint !== route.qualificationFingerprint) throw new Error("SYNTHETIC_ADMISSION_REFUSED");
  };
  return {
    status: () => route,
    async authorize(binding, fingerprint) {
      if (count >= 3) throw new Error("SYNTHETIC_JOURNEY_CALL_BOUND");
      const admission = Object.freeze({ receiptId: `synthetic-admission:${randomUUID()}` }); receipts.set(admission, { subject: sha({ binding, fingerprint }), used: false }); return admission;
    },
    assertCurrent,
    async execute(input) {
      await assertCurrent(input.admission, input.binding, input.requestFingerprint);
      if (input.signal.aborted) throw new Error("SYNTHETIC_CANCELLED_BEFORE_DISPATCH");
      const { invocation } = input;
      if (invocation.protocol !== route.protocol || invocation.args[invocation.args.indexOf("--tools") + 1] !== "" || !invocation.args.includes("--safe-mode") || !invocation.args.includes("--no-session-persistence")) throw new Error("SYNTHETIC_PROTOCOL_REFUSED");
      const payload = new TextDecoder("utf-8", { fatal: true }).decode(invocation.stdin);
      if (!payload.toLowerCase().includes("garden") || Buffer.byteLength(payload) > input.binding.maxInputBytes) throw new Error("SYNTHETIC_CONTEXT_REFUSED");
      receipts.get(input.admission)!.used = true;
      const purpose = count < 2 ? "understanding" : "proposal";
      const task = (proposalId: string, title: string, description: string, dependencies: readonly string[], acceptanceCriteria: readonly string[]) => ({ proposalId, kind: "plan", title, description, dependencies, acceptanceCriteria, evidence: [], unsupportedAssumptions: ["Implementation will be reviewed before execution."], complexity: 2, reasoning: "medium", capabilities: ["reasoning", "structured-output"], editScope: "none", risk: "low", classification: "internal" });
      const structured = { schemaVersion: 1, status: purpose === "understanding" ? "clarification-required" : "viable", objective: "Garden journal planning proposal", assumptions: ["Audience: Community gardeners", "Non-goal: No automatic task execution", "Implementation will be reviewed before execution."], risks: [],
        openQuestions: purpose === "understanding" ? [count === 0 ? "Which reminder period should the garden journal support?" : "Which day should the weekly garden reminder appear?"] : [], completionCriteria: ["Capture each garden note and retain it after reopening."],
        tasks: purpose === "understanding" ? [] : [task("capture-notes", "Capture garden notes", "Record dated garden observations", [], ["A saved garden note reopens unchanged"]), task("weekly-reminders", "Review weekly garden reminders", "Review the explicitly selected Monday reminder schedule", ["capture-notes"], ["The Monday weekly schedule is visible with the saved notes"])] };
      const value = { type: "result", subtype: "success", is_error: false, num_turns: 1, permission_denials: [], structured_output: structured,
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 }, modelUsage: { "synthetic-planning-model": { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 2, cacheReadInputTokens: 3 } } };
      const stdout = Buffer.from(JSON.stringify(value)); if (stdout.length > invocation.maxOutputBytes) throw new Error("SYNTHETIC_OUTPUT_BOUND");
      await writeFile(logPath, `${JSON.stringify({ source: "synthetic-owned-fixture", requestId: input.binding.requestId, purpose, modelId: model.model.modelId, outputDigest: sha(value), liveInvocation: false })}\n`, { flag: "a" }); count += 1;
      return { state: "exited", exitCode: 0, stdout, stderrBytes: 0, truncated: false, terminationConfirmed: true };
    },
  };
});
