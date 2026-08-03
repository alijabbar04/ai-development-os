#!/usr/bin/env node
/** Process-level Codex fake. It is always reached through the real broker as node + this pinned script. */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const scenarioPath = process.argv[2];
const adapterArgs = process.argv.slice(3);
if (scenarioPath === undefined) process.exit(64);
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

const record = (path, value) => { if (typeof path === "string") writeFileSync(path, JSON.stringify(value), "utf8"); };
if (typeof scenario.startMarker === "string") { mkdirSync(dirname(scenario.startMarker), { recursive: true }); writeFileSync(scenario.startMarker, "started", "utf8"); }
record(scenario.argvOut, adapterArgs);
record(scenario.environmentOut, { names: Object.keys(process.env).sort(), values: (scenario.environmentCanaryNames ?? []).map((name) => process.env[name] ?? null), cwd: process.cwd() });

if (adapterArgs.includes("--version")) {
  process.stdout.write(`codex-cli ${scenario.version ?? "0.146.0-alpha.9.2"}\n`);
  process.exit(scenario.versionExitCode ?? 0);
}

if (adapterArgs.includes("generate-json-schema")) {
  const outIndex = adapterArgs.indexOf("--out");
  const out = outIndex >= 0 ? adapterArgs[outIndex + 1] : null;
  if (typeof out !== "string") process.exit(65);
  mkdirSync(out, { recursive: true });
  const methods = scenario.schemaMethods ?? [
    "initialize", "initialized", "thread/start", "thread/resume", "turn/start", "turn/interrupt",
    "turn/started", "item/started", "item/completed", "turn/completed", "account/read",
    "account/rateLimits/read", "account/rateLimits/updated", "account/usage/read",
  ];
  writeFileSync(resolve(out, "protocol.json"), JSON.stringify({ oneOf: methods.map((method) => ({ properties: { method: { const: method } } })) }), "utf8");
  process.exit(scenario.schemaExitCode ?? 0);
}

const received = [];
let initialized = false;
let turnStarted = false;
let approvalRequestId = null;
let heldRequests = [];
let terminal = false;
if (scenario.stderrOnStart === true && typeof scenario.stderr === "string") process.stderr.write(scenario.stderr);

function saveReceived() { record(scenario.receivedOut, received); }
function applyFilesystem(entries) {
  for (const entry of entries ?? []) {
    const target = resolve(process.cwd(), entry.path);
    if (entry.action === "delete") rmSync(target, { recursive: true, force: true });
    else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, entry.content ?? "", "utf8"); }
  }
}
async function writeBytes(bytes) {
  const split = Number.isSafeInteger(scenario.splitBytes) && scenario.splitBytes > 0 ? scenario.splitBytes : bytes.byteLength;
  for (let offset = 0; offset < bytes.byteLength; offset += split) {
    process.stdout.write(bytes.subarray(offset, Math.min(bytes.byteLength, offset + split)));
    if (split < bytes.byteLength) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
  }
}
async function emit(value) { await writeBytes(Buffer.from(`${JSON.stringify(value)}\n`, "utf8")); }
async function complete(status = "completed") {
  if (terminal) return;
  terminal = true;
  applyFilesystem(scenario.afterFiles);
  if (scenario.usage !== false) await emit({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { total: scenario.usage ?? { totalTokens: 177, inputTokens: 120, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: 45, reasoningOutputTokens: 7 } } } });
  if (scenario.stderrOnStart !== true && typeof scenario.stderr === "string") process.stderr.write(scenario.stderr);
  await emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status, ...(scenario.turnError === undefined ? {} : { error: { codexErrorInfo: scenario.turnError } }) } } });
  if (typeof scenario.doneMarker === "string") appendFileSync(scenario.doneMarker, "done\n", "utf8");
}
async function runTurn() {
  turnStarted = true;
  applyFilesystem(scenario.beforeFiles);
  await emit({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
  if (scenario.unknownMethod === true) { await emit({ method: "thread/shellCommand", params: {} }); return; }
  if (scenario.unknownId === true) { await emit({ id: 999999, result: {} }); return; }
  if (scenario.malformed === true) { await writeBytes(Buffer.from("{not-json}\n")); return; }
  if (scenario.invalidUtf8 === true) { await writeBytes(Buffer.from([0xff, 0x0a])); return; }
  if (typeof scenario.oversized === "number" && scenario.oversized > 0) { await writeBytes(Buffer.from(`${"x".repeat(scenario.oversized)}\n`)); return; }
  if (scenario.agentText !== false) await emit({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: scenario.agentText ?? "Done." } });
  if (scenario.plan === true) await emit({ method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1", plan: [] } });
  for (const warning of scenario.warnings ?? []) await emit({ method: warning, params: { threadId: "thread-1", turnId: "turn-1", message: "fixture warning" } });
  if (scenario.modelRerouted === true) { await emit({ method: "model/rerouted", params: { threadId: "thread-1", turnId: "turn-1", fromModel: "gpt-5.2-codex", toModel: "other", reason: "fixture" } }); return; }
  if (scenario.command === true) await emit({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "command-1", type: "commandExecution", command: "npm test" } } });
  if (scenario.fileClaim === true) await emit({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "file-1", type: "fileChange", changes: [{ path: scenario.claimedPath ?? "claimed-only.txt", kind: { type: "add" } }] } } });
  if (scenario.approval !== undefined) {
    approvalRequestId = "approval-rpc-1";
    const method = scenario.approval === "file" ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval";
    await emit({ method, id: approvalRequestId, params: { threadId: "thread-1", turnId: "turn-1", itemId: "approval-item-1", command: "npm test", cwd: process.cwd(), grantRoot: process.cwd(), reason: "fixture" } });
    return;
  }
  if (scenario.turnError !== undefined) { await complete("failed"); return; }
  if (scenario.hang === true) return;
  await complete();
}

async function respond(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    if (scenario.beforeInitialize === true) await emit({ method: "warning", params: { message: "early" } });
    const initializedResponse = { id, result: { userAgent: "fake-codex/0.146" } };
    const statusNotification = { method: "remoteControl/status/changed", params: { status: "disconnected", serverName: null, installationId: null, environmentId: null }, emittedAtMs: 1_785_781_729_000 };
    if (scenario.afterInitializeNotification === true) await writeBytes(Buffer.from(`${JSON.stringify(initializedResponse)}\n${JSON.stringify(statusNotification)}\n`, "utf8"));
    else await emit(initializedResponse);
    return;
  }
  if (method === "initialized") { initialized = true; return; }
  if (!initialized) { await emit({ id, error: { code: -32000, message: "not initialized" } }); return; }
  if (scenario.outOfOrder === true && (method === "account/read" || method === "account/usage/read")) {
    heldRequests.push(message);
    if (heldRequests.length === 2) {
      for (const held of heldRequests.reverse()) await emit({ id: held.id, result: { echoed: held.method } });
      heldRequests = [];
    }
    return;
  }
  if (method === "thread/start" || method === "thread/resume") {
    if (scenario.threadStartError !== undefined) { await emit({ id, error: scenario.threadStartError }); return; }
    const model = scenario.reportedModel ?? params?.model ?? "gpt-5.2-codex";
    const effort = scenario.reportedEffort ?? "high";
    const response = { id, result: { thread: { id: "thread-1", sessionId: "session-1" }, model, reasoningEffort: effort, modelProvider: "openai", cwd: process.cwd(), approvalPolicy: params?.approvalPolicy, sandbox: params?.sandbox } };
    await emit(response); if (scenario.duplicateResponse === true) await emit(response);
    return;
  }
  if (method === "turn/start") { await emit({ id, result: { turn: { id: "turn-1", status: "inProgress" } } }); await runTurn(); return; }
  if (method === "turn/interrupt") { await emit({ id, result: {} }); await complete("interrupted"); return; }
  if (method === "account/read") { await emit({ id, result: scenario.account ?? { account: { type: "chatgpt", email: "redacted@example.invalid", planType: "plus" }, requiresOpenaiAuth: true } }); return; }
  if (method === "account/rateLimits/read") { if (scenario.unsupportedRate === true) await emit({ id, error: { code: -32601, message: "unsupported" } }); else await emit({ id, result: scenario.rateLimits ?? { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_800_604_800 } }, rateLimitResetCredits: { availableCount: 2 } } }); return; }
  if (method === "account/usage/read") { if (scenario.unsupportedUsage === true) await emit({ id, error: { code: -32601, message: "unsupported" } }); else await emit({ id, result: scenario.accountUsage ?? { summary: { lifetimeTokens: 1000, peakDailyTokens: 200, longestRunningTurnSec: 30, currentStreakDays: 2, longestStreakDays: 5 }, dailyUsageBuckets: [{ startDate: "2026-08-02", tokens: 200 }] } }); return; }
  await emit({ id, error: { code: -32601, message: "unknown" } });
}

if (scenario.spawnChild === true) {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  child.unref(); record(scenario.childMarker, { pid: child.pid });
}
if (scenario.ignoreSignals === true) { process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); }

let buffered = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  void (async () => {
    for (;;) {
      const newline = buffered.indexOf(0x0a); if (newline < 0) break;
      const line = buffered.subarray(0, newline).toString("utf8"); buffered = buffered.subarray(newline + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line); received.push(message); saveReceived();
      if (message.id === approvalRequestId && ("result" in message || "error" in message)) { record(scenario.approvalOut, message); await complete(message.result?.decision === "cancel" ? "interrupted" : "completed"); }
      else await respond(message);
    }
  })().catch((error) => { process.stderr.write(`fake failure: ${error?.name ?? "Error"}\n`); process.exitCode = 70; });
});
process.stdin.on("end", () => { if (scenario.hangAfterClose !== true) process.exit(scenario.exitCode ?? 0); });
