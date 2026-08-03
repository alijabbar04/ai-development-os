import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessBrokerError, createTrustedToolDescriptor, parseCapabilityGrant } from "@ai-dev-os/process-broker";
import {
  CODEX_REQUIRED_METHODS,
  ZERO_CODEX_USAGE,
  classifyCodexBrokerFailure,
  codexConfigurationFingerprint,
  compareCodexVersions,
  createCodexAdapterConfiguration,
  mapCodexAccountState,
  mapCodexAccountUsage,
  mapCodexBrokerFailure,
  mapCodexRateLimits,
  mintCodexResumeToken,
  parseCodexAdapterConfiguration,
  parseCodexTestReport,
  parseCodexTokenUsage,
  parseCodexVersionBanner,
  probeCodex,
  readCodexSchemaBundle,
  reconcileCodexUsage,
  reconcileCodexWorkspace,
  resolveCodexCompatibility,
  toProviderCodexUsage,
  verifyCodexResumeToken,
  decliningCodexApprovalPort,
  denyingCodexArtifactSink,
  permissiveCodexDevelopmentPolicy,
  systemCodexClock,
  systemCodexScheduler,
} from "../src/index.js";
import { CodexJsonlDecoder } from "../src/jsonl.js";
import { KNOWN_CODEX_NOTIFICATIONS, parseCodexWireMessage } from "../src/wire.js";
import { CodexRpcError } from "../src/connection.js";
import {
  codexAuthenticationFailed, codexCancelled, codexContentRejected, codexContextLimit,
  codexDeadlineExceeded, codexInternalFailure, codexMalformedResponse, codexNetworkFailure,
  codexOverloaded, codexProtocolViolation, codexProviderClosed, codexRateLimited,
  codexWorkspaceUnavailable, invalidCodexRequest, unsupportedCodexCapability,
} from "../src/errors.js";

const NOW = new Date("2026-08-03T12:00:00.000Z");
const clock = Object.freeze({ now: () => NOW });

function configuration() {
  return createCodexAdapterConfiguration({
    instanceId: "codex-unit", executable: createTrustedToolDescriptor({ toolId: "codex", executablePath: process.execPath, platform: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux", architecture: process.arch === "arm64" ? "arm64" : "x64", trustSource: "operator-pinned" }),
    compatibility: { minimum: "0.146.0-alpha.1", validatedMaximum: "0.146.0-alpha.99" }, models: [{ modelId: "gpt-5.2-codex", efforts: ["low", "high"] }], defaultModel: "gpt-5.2-codex", defaultEffort: "high",
    ceilings: { maxTurns: 4, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxProcessOutputBytes: 1_048_576, maxCostMicros: 0 }, deadlines: { operationMs: 60_000, handshakeMs: 5_000, requestMs: 10_000, shutdownMs: 1_000 },
    jsonl: { maxRecordBytes: 1_024, maxRecords: 100, maxStreamBytes: 10_000, maxPendingRequests: 8, maxRequestId: 100, maxQueuedEvents: 8, maxQueuedEventBytes: 2_048, maxQueuedWriteBytes: 2_048 },
    sessions: { persistence: "ephemeral-only", retentionMs: 0 }, sandboxMappings: ["read-only", "workspace-write"], approvalMappings: ["never", "on-request"], dataClassifications: ["internal"], capacityStalenessMs: 60_000, authentication: "account-managed",
  });
}

describe("configuration, version, and compatibility", () => {
  it("parses, freezes, and fingerprints a complete configuration", () => {
    const value = configuration();
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.models)).toBe(true);
    expect(codexConfigurationFingerprint(value)).toMatch(/^[0-9a-f]{64}$/);
    expect(codexConfigurationFingerprint(value)).toBe(codexConfigurationFingerprint(configuration()));
  });
  it.each([
    ["unknown field", (value: any) => { value.extra = true; }],
    ["unsafe model", (value: any) => { value.models[0].modelId = "--evil"; }],
    ["unsafe number", (value: any) => { value.ceilings.maxTurns = Number.MAX_VALUE; }],
    ["shell shim", (value: any) => { value.executable.executablePath = "C:\\evil.cmd"; }],
    ["inline option prefix", (value: any) => { value.executable.argumentPolicy.pinnedLeadingArguments = ["--token=secret"]; }],
  ])("rejects %s", (_label, mutate) => {
    const value = JSON.parse(JSON.stringify(configuration())); mutate(value);
    expect(() => parseCodexAdapterConfiguration(value)).toThrow();
  });
  it("rejects polluted prototypes", () => { const value = Object.create({ injected: true }); Object.assign(value, configuration()); expect(() => parseCodexAdapterConfiguration(value)).toThrow(); });
  it("rejects inconsistent defaults, bounds, persistence, duplicates, and missing conservative mappings", () => {
    const cases: Array<(value: any) => void> = [
      (value) => { value.defaultEffort = null; }, (value) => { value.defaultModel = "missing"; },
      (value) => { value.models.push(value.models[0]); }, (value) => { value.jsonl.maxRecordBytes = value.jsonl.maxStreamBytes + 1; },
      (value) => { value.sessions = { persistence: "ephemeral-only", retentionMs: 1 }; },
      (value) => { value.sandboxMappings = ["workspace-write"]; }, (value) => { value.approvalMappings = ["on-request"]; },
      (value) => { value.dataClassifications = []; }, (value) => { value.executable.toolId = "other"; },
    ];
    for (const mutate of cases) { const value = JSON.parse(JSON.stringify(configuration())); mutate(value); expect(() => parseCodexAdapterConfiguration(value)).toThrow(); }
  });
  it("parses installed-style banners and compares prerelease-compatible numeric cores", () => {
    expect(parseCodexVersionBanner("codex-cli 0.146.0-alpha.9.2\n")).toBe("0.146.0-alpha.9.2");
    expect(parseCodexVersionBanner("codex 0.146")).toBeNull();
    expect(compareCodexVersions("0.146.0-alpha.1", "0.146.0-alpha.99")).toBe(0);
    expect(compareCodexVersions("0.145.9", "0.146.0")).toBe(-1); expect(compareCodexVersions("1.0.0", "0.146.0")).toBe(1); expect(compareCodexVersions("bad", "0.1.0")).toBeNull();
  });
  it("gates old, current, future, and incomplete schemas", () => {
    const base = { minimum: "0.146.0", validatedMaximum: "0.146.0", schemaDigest: "a".repeat(64), methods: CODEX_REQUIRED_METHODS };
    expect(resolveCodexCompatibility({ ...base, version: "0.145.0" }).tier).toBe("unsupported-too-old");
    expect(resolveCodexCompatibility({ ...base, version: "0.146.0" }).usableForStateChanging).toBe(true);
    const future = resolveCodexCompatibility({ ...base, version: "0.147.0" }); expect(future.usableForReadOnly).toBe(true); expect(future.usableForStateChanging).toBe(false);
    expect(resolveCodexCompatibility({ ...base, version: "0.146.0", methods: ["initialize"] }).tier).toBe("schema-incompatible");
  });
});

describe("bounded JSONL and wire parsing", () => {
  it("decodes split multibyte UTF-8 and CRLF records", () => {
    const decoder = new CodexJsonlDecoder({ maxRecordBytes: 64, maxRecords: 4, maxStreamBytes: 128 }); const bytes = Buffer.from('{"text":"é"}\r\n');
    expect(decoder.push(bytes.subarray(0, bytes.length - 2))).toEqual([]); expect(decoder.push(bytes.subarray(bytes.length - 2))).toEqual(['{"text":"é"}']); expect(decoder.finish()).toEqual([]);
    expect(decoder.recordCount).toBe(1); expect(decoder.byteCount).toBe(bytes.byteLength);
  });
  it("enforces UTF-8, record, count, and stream bounds", () => {
    expect(() => new CodexJsonlDecoder({ maxRecordBytes: 8, maxRecords: 1, maxStreamBytes: 20 }).push(Buffer.from("123456789"))).toThrowError(/protocol/i);
    expect(() => new CodexJsonlDecoder({ maxRecordBytes: 8, maxRecords: 1, maxStreamBytes: 20 }).push(Buffer.from([0xff, 0x0a]))).toThrowError(/protocol/i);
    const count = new CodexJsonlDecoder({ maxRecordBytes: 8, maxRecords: 1, maxStreamBytes: 20 }); expect(() => count.push(Buffer.from("{}\n{}\n"))).toThrow();
    expect(() => new CodexJsonlDecoder({ maxRecordBytes: 8, maxRecords: 9, maxStreamBytes: 3 }).push(Buffer.from("{}\n{}"))).toThrow();
    expect(() => new CodexJsonlDecoder({ maxRecordBytes: 8, maxRecords: 9, maxStreamBytes: 20 }).push(Buffer.from("\n"))).toThrow();
    const final = new CodexJsonlDecoder({ maxRecordBytes: 8, maxRecords: 2, maxStreamBytes: 20 }); final.push(Buffer.from("{}")); expect(final.finish()).toEqual(["{}"]);
  });
  it("accepts exact response/request/notification envelopes", () => {
    expect(parseCodexWireMessage('{"id":1,"result":{"ok":true}}')).toMatchObject({ kind: "response", id: 1 });
    expect(parseCodexWireMessage('{"id":"host-1","method":"item/fileChange/requestApproval","params":{}}')).toMatchObject({ kind: "request" });
    expect(parseCodexWireMessage('{"method":"turn/started","params":{}}')).toMatchObject({ kind: "notification" });
    expect(parseCodexWireMessage('{"method":"remoteControl/status/changed","params":{},"emittedAtMs":1785781729000}')).toMatchObject({ kind: "notification", method: "remoteControl/status/changed" });
    expect(KNOWN_CODEX_NOTIFICATIONS.has("remoteControl/status/changed")).toBe(true);
    expect(parseCodexWireMessage('{"id":2,"error":{"code":429,"message":"limited","data":{"retryAfterMs":5}}}')).toMatchObject({ error: { code: 429 } });
  });
  it.each([
    '{"jsonrpc":"2.0","id":1,"result":{}}', '{"id":1,"result":{},"extra":true}', '{"id":1,"result":{},"error":{}}', '{"id":1.5,"result":{}}',
    '{"method":"--bad","params":{}}', '{"method":"turn/started","params":{},"emittedAtMs":-1}', '{"method":"turn/started","params":{},"emittedAtMs":1,"extra":true}', '{"__proto__":{"polluted":true}}', '{"id":9007199254740992,"result":{}}', "[]", "not-json",
  ])("rejects hostile wire input", (text) => expect(() => parseCodexWireMessage(text)).toThrow());
});

describe("usage and telemetry", () => {
  it("maps cumulative token categories without double counting", () => {
    const usage = parseCodexTokenUsage({ inputTokens: 10, cachedInputTokens: 3, cacheWriteInputTokens: 2, outputTokens: 8, reasoningOutputTokens: 5 })!;
    expect(toProviderCodexUsage(usage, 2)).toMatchObject({ tokens: { inputTokens: 9, cachedInputTokens: 3, outputTokens: 3, reasoningTokens: 5 }, toolCalls: 2 });
    expect(reconcileCodexUsage(ZERO_CODEX_USAGE, usage)).toBe(usage); expect(reconcileCodexUsage(usage, ZERO_CODEX_USAGE)).toBeNull(); expect(parseCodexTokenUsage({})).toBeNull();
  });
  it("classifies signed-out and documented account modes without exposing identity", () => {
    expect(mapCodexAccountState({ account: null, requiresOpenaiAuth: true }, clock).kind).toBe("signed-out");
    expect(mapCodexAccountState({ account: { type: "apiKey", email: "secret@example.com" }, requiresOpenaiAuth: false }, clock)).toMatchObject({ kind: "api-key", planType: null });
    expect(mapCodexAccountState({ account: { type: "chatgpt", planType: "plus" } }, clock)).toMatchObject({ kind: "chatgpt", planType: "plus" });
    expect(mapCodexAccountState({ account: { type: "amazonBedrock" } }, clock).kind).toBe("amazon-bedrock");
  });
  it("keeps multiple rate windows separate and marks expired observations stale", () => {
    const snapshot = mapCodexRateLimits({ rateLimitsByLimitId: { codex: { limitId: "codex", limitName: "Codex", planType: "plus", credits: { hasCredits: true, unlimited: false, balance: "12.5" }, primary: { usedPercent: 25.5, windowDurationMins: 300, resetsAt: 1_700_000_000 }, secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_900_000_000 } } }, rateLimitResetCredits: { availableCount: 2 } }, { clock, stalenessMs: 1_000, source: "account/rateLimits/updated" });
    expect(snapshot.status).toBe("reported"); expect(snapshot.windows).toHaveLength(2); expect(snapshot.windows[0]).toMatchObject({ window: "primary", usedPercent: 25.5, stale: true, source: "account/rateLimits/updated" }); expect(snapshot.resetCreditsAvailable).toBe(2);
    expect(mapCodexRateLimits(null, { clock, stalenessMs: 1_000, source: "account/rateLimits/read" }).status).toBe("unknown");
  });
  it("reports account usage as unsupported rather than zero for key auth", () => {
    expect(mapCodexAccountUsage(null, clock, "api-key").status).toBe("unsupported");
    const usage = mapCodexAccountUsage({ summary: { lifetimeTokens: 100, peakDailyTokens: 20, longestRunningTurnSec: 30, currentStreakDays: 2, longestStreakDays: 4 }, dailyUsageBuckets: [{ startDate: "2026-08-02", tokens: 20 }, { startDate: "bad", tokens: 5 }] }, clock, "chatgpt");
    expect(usage).toMatchObject({ status: "reported", summary: { lifetimeTokens: 100 }, dailyBuckets: [{ startDate: "2026-08-02", tokens: 20 }] });
    expect(mapCodexAccountUsage({}, clock, "chatgpt").status).toBe("unknown");
  });
});

describe("resume binding, reconciliation, and failure mapping", () => {
  const binding = Object.freeze({ threadId: "thread-1", sessionId: "session-1", instanceId: "codex-unit", projectId: "project-1", workspaceId: "workspace-1", snapshotId: "snapshot-1", model: "gpt-5.2-codex", effort: "high", configurationFingerprint: "f".repeat(64), expiresAt: "2026-08-03T13:00:00.000Z" });
  it("binds resume tokens to every session dimension and expiry", () => {
    const token = mintCodexResumeToken(binding); const base = { token, ...binding, now: NOW, sessionPersistenceAllowed: true };
    expect(verifyCodexResumeToken(base)).toMatchObject({ ok: true, binding: { threadId: "thread-1" } });
    expect(verifyCodexResumeToken({ ...base, workspaceId: "other" })).toMatchObject({ ok: false, detailCode: "resume-binding-mismatch" });
    expect(verifyCodexResumeToken({ ...base, now: new Date(binding.expiresAt) })).toMatchObject({ ok: false, detailCode: "resume-token-expired" });
    expect(verifyCodexResumeToken({ ...base, sessionPersistenceAllowed: false })).toMatchObject({ ok: false, detailCode: "session-persistence-denied" });
    expect(verifyCodexResumeToken({ ...base, token: "bad" })).toMatchObject({ ok: false, detailCode: "resume-token-invalid" });
  });
  it("parses only bounded machine-verifiable test reports", () => {
    expect(parseCodexTestReport('{"suite":"unit","passed":2,"failed":0,"skipped":1}')).toEqual({ suite: "unit", passed: 2, failed: 0, skipped: 1 });
    expect(parseCodexTestReport("not-json")).toBeNull(); expect(parseCodexTestReport('{"passed":-1,"failed":0,"skipped":0}')).toBeNull();
  });
  it("maps broker terminal classes without sensitive messages", () => {
    expect(mapCodexBrokerFailure(new ProcessBrokerError("DEADLINE_EXCEEDED", "secret")).code).toBe("DEADLINE_EXCEEDED");
    expect(mapCodexBrokerFailure(new ProcessBrokerError("PRODUCTION_ISOLATION_REQUIRED", "secret")).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(mapCodexBrokerFailure(new ProcessBrokerError("LEASE_EXPIRED", "secret")).code).toBe("WORKSPACE_UNAVAILABLE");
    expect(JSON.stringify(mapCodexBrokerFailure(new Error("secret")).toJSON())).not.toContain("secret");
    expect(classifyCodexBrokerFailure(new ProcessBrokerError("PRODUCTION_ISOLATION_REQUIRED", "no"))).toEqual({ code: "PRODUCTION_ISOLATION_REQUIRED", productionRefusal: true });
    expect(classifyCodexBrokerFailure(new Error("x"))).toEqual({ code: "UNKNOWN", productionRefusal: false });
    const classes = ["CANCELLED", "OUTPUT_QUOTA_EXCEEDED", "EVENT_QUEUE_QUOTA_EXCEEDED", "EXECUTABLE_UNSAFE", "BROKER_CLOSED"] as const;
    expect(classes.map((code) => mapCodexBrokerFailure(new ProcessBrokerError(code, "redacted")).code)).toEqual(["CANCELLED", "MALFORMED_RESPONSE", "MALFORMED_RESPONSE", "UNSUPPORTED_CAPABILITY", "INTERNAL_FAILURE"]);
  });
  it("makes actual managed-workspace changes authoritative", async () => {
    const grant = parseCapabilityGrant({ schemaVersion: 1, grantId: "grant-unit", projectId: "project-1", runId: null, taskId: null, attemptId: "attempt-1", snapshotId: "snapshot-1", workspaceId: "workspace-1", operations: ["workspace-read", "workspace-write"], readablePrefixes: [""], writablePrefixes: ["src"], tools: [], network: { mode: "denied", egressDomains: [] }, quotas: { wallClockMs: 1_000, cpuTimeMs: null, memoryBytes: null, processCount: null, outputBytes: 1_000, diskBytes: null, fileCount: null }, issuedAt: "2026-08-03T11:00:00.000Z", expiresAt: "2026-08-03T13:00:00.000Z", nonce: "a".repeat(32), policyFingerprint: "b".repeat(64), approvalEvidenceRefs: [] });
    const entry = (path: string, extra: Record<string, unknown> = {}) => ({ path, previousPath: null, changeKind: "modified", oldObjectId: null, newObjectId: null, oldMode: null, newMode: null, similarityPercent: null, isSubmodule: false, isSymlink: false, sizeBytes: 5, binary: false, diffArtifactDigest: null, ...extra });
    const workspace = { captureChanges: async () => ({ schemaVersion: 1, entries: [entry("src/good.ts"), entry("outside.txt"), entry("src/link.ts", { isSymlink: true }), entry(".git/config")], truncated: false, fingerprint: "x" }), linkMetadata: async () => ({ isLink: false }) } as any;
    const result = await reconcileCodexWorkspace({ workspace, grant, allowedPathPrefixes: ["src"], maxChangedFiles: 10, maxProducedBytes: 100, editingGranted: true });
    expect(result.changedFiles).toEqual([{ path: "src/good.ts", changeKind: "modified" }]); expect(result.clean).toBe(false); expect(result.violations.map((item) => item.detailCode)).toEqual(expect.arrayContaining(["reconciliation-administrative-path", "reconciliation-link-escape", "reconciliation-path-violation"]));
  });
  it("covers reconciliation unavailability, change kinds, link races, and hard limits", async () => {
    const grant = parseCapabilityGrant({ schemaVersion: 1, grantId: "grant-kinds", projectId: "project-1", runId: null, taskId: null, attemptId: "attempt-1", snapshotId: "snapshot-1", workspaceId: "workspace-1", operations: ["workspace-read", "workspace-write"], readablePrefixes: [""], writablePrefixes: [""], tools: [], network: { mode: "denied", egressDomains: [] }, quotas: { wallClockMs: 1_000, cpuTimeMs: null, memoryBytes: null, processCount: null, outputBytes: 1_000, diskBytes: null, fileCount: null }, issuedAt: "2026-08-03T11:00:00.000Z", expiresAt: "2026-08-03T13:00:00.000Z", nonce: "c".repeat(32), policyFingerprint: "d".repeat(64), approvalEvidenceRefs: [] });
    const make = (path: string, changeKind: string, extra: Record<string, unknown> = {}) => ({ path, previousPath: null, changeKind, oldObjectId: null, newObjectId: null, oldMode: null, newMode: null, similarityPercent: null, isSubmodule: false, isSymlink: false, sizeBytes: 10, binary: false, diffArtifactDigest: null, ...extra });
    const unavailable = await reconcileCodexWorkspace({ workspace: { captureChanges: async () => { throw new Error("gone"); } } as any, grant, allowedPathPrefixes: [], maxChangedFiles: 1, maxProducedBytes: 1, editingGranted: true });
    expect(unavailable).toMatchObject({ clean: false, unavailable: true, violations: [{ detailCode: "workspace-missing" }] });
    const workspace = { captureChanges: async () => ({ schemaVersion: 1, entries: [make("copy.ts", "copied"), make("delete.ts", "deleted"), make("rename.ts", "renamed", { previousPath: "old.ts" }), make("type.ts", "type-changed"), make("race.ts", "added"), make("bad\\path", "added"), make("../escape", "added")], truncated: true, fingerprint: "x" }), linkMetadata: async (path: string) => { if (path === "race.ts") throw new Error("race"); return { isLink: false }; } } as any;
    const result = await reconcileCodexWorkspace({ workspace, grant, allowedPathPrefixes: [], maxChangedFiles: 2, maxProducedBytes: 5, editingGranted: true });
    expect(result.changedFiles).toEqual(expect.arrayContaining([{ path: "copy.ts", changeKind: "added" }, { path: "delete.ts", changeKind: "deleted" }, { path: "rename.ts", changeKind: "renamed" }, { path: "type.ts", changeKind: "modified" }]));
    expect(result.violations.map((entry) => entry.detailCode)).toEqual(expect.arrayContaining(["reconciliation-path-violation", "reconciliation-link-escape", "reconciliation-file-limit", "reconciliation-byte-limit"]));
  });
});

describe("small public seams and redacted error constructors", () => {
  it("provides safe default ports", async () => {
    expect(systemCodexClock.now()).toBeInstanceOf(Date);
    await systemCodexScheduler.delay(1).promise; systemCodexScheduler.delay(1000).cancel();
    expect(await denyingCodexArtifactSink.write({} as never)).toBeNull();
    expect(await permissiveCodexDevelopmentPolicy.evaluateSession({} as never)).toMatchObject({ outcome: "allowed", sessionPersistenceAllowed: false });
    expect(await decliningCodexApprovalPort.evidence({} as never)).toBeNull();
  });
  it("constructs the full stable error vocabulary without copying raw payloads", () => {
    const errors = [
      invalidCodexRequest("model-not-permitted"), unsupportedCodexCapability("approval-unrepresentable"), codexWorkspaceUnavailable("workspace-missing"),
      codexProtocolViolation("malformed-json"), codexMalformedResponse("invalid-utf8"), codexDeadlineExceeded(), codexCancelled(), codexProviderClosed(),
      codexInternalFailure(), codexAuthenticationFailed(), codexRateLimited(50), codexOverloaded(60), codexNetworkFailure(), codexContextLimit(), codexContentRejected(),
    ];
    expect(errors.map((error) => error.code)).toEqual(expect.arrayContaining(["INVALID_REQUEST", "UNSUPPORTED_CAPABILITY", "RATE_LIMITED", "NETWORK_FAILURE"]));
    expect(errors.every((error) => !JSON.stringify(error.toJSON()).includes("credential"))).toBe(true);
    const rpc = new CodexRpcError({ code: -32001, message: "secret", data: { httpStatusCode: 429, retryAfterMs: 25 } });
    expect(rpc).toMatchObject({ rpcCode: -32001, httpStatus: 429, retryAfterMs: 25 });
    expect(new CodexRpcError({ code: -1, message: "x" })).toMatchObject({ httpStatus: null, retryAfterMs: null });
  });
  it("reads a bounded recursive generated-schema bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-schema-unit-")); await mkdir(join(root, "v2"));
    await writeFile(join(root, "v2", "protocol.json"), JSON.stringify({ oneOf: [{ properties: { method: { const: "turn/start" } } }, { properties: { method: { enum: ["turn/completed", 42] } } }] }));
    const bundle = await readCodexSchemaBundle(root, { maxFiles: 2, maxBytes: 10_000 });
    expect(bundle.methods).toEqual(["turn/completed", "turn/start"]); expect(bundle.fileCount).toBe(1); expect(bundle.digest).toMatch(/^[0-9a-f]{64}$/);
    await expect(readCodexSchemaBundle(root, { maxFiles: 0, maxBytes: 10_000 })).rejects.toThrow("schema-file-limit");
    await expect(readCodexSchemaBundle(root, { maxFiles: 2, maxBytes: 1 })).rejects.toThrow("schema-byte-limit");
  });
  it("returns bounded probe failures for process failure, bad banners, and thrown seams", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-probe-failure-")); const base = { configuration: configuration(), workspaceId: "workspace-unit", schemaOutputDirectory: root, trace: { traceId: "trace-unit", runId: null, taskId: null, taskRunId: null } };
    const failed = await probeCodex({ ...base, process: { execute: async () => ({ succeeded: false } as any), open: async () => { throw new Error("unused"); } } }); expect(failed).toMatchObject({ status: "failed", detailCode: "probe-failed" });
    const badBanner = await probeCodex({ ...base, process: { execute: async () => ({ succeeded: true, output: { stdout: { bytes: Buffer.from("not codex") } } } as any), open: async () => { throw new Error("unused"); } } }); expect(badBanner).toMatchObject({ status: "failed", detailCode: "probe-unparseable" });
    const thrown = await probeCodex({ ...base, process: { execute: async () => { throw new Error("secret"); }, open: async () => { throw new Error("unused"); } } }); expect(thrown).toMatchObject({ status: "failed", detailCode: "probe-failed" });
  });
});
