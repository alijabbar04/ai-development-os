import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCodingAgentRequest, isProviderError, type CodingAgentEvent } from "@ai-dev-os/providers";
import { connectCodexAppServer } from "../src/connection.js";
import { probeCodex } from "../src/index.js";
import {
  INTERNAL_DISCLOSURE, SCRATCH, TEST_TRACE, WORKSPACE_ID,
  cleanupCodexFixtures, createCodexHarness, markerExists,
} from "./helpers/harness.js";

afterAll(cleanupCodexFixtures);

const request = (suffix: string, extra: Record<string, unknown> = {}) => createCodingAgentRequest({ requestId: `req-behavior-${suffix}`, workspaceId: WORKSPACE_ID, instructions: "perform bounded fixture work", capabilities: ["read-files", "edit-files"], disclosure: INTERNAL_DISCLOSURE, trace: TEST_TRACE, ...extra });
async function consume(provider: Awaited<ReturnType<typeof createCodexHarness>>["provider"], value: ReturnType<typeof request>) {
  const operation = await provider.start(value); const events: CodingAgentEvent[] = [];
  for await (const event of operation.events()) events.push(event);
  try { return { events, result: await operation.result, error: null }; } catch (error) { return { events, result: null, error }; }
}

describe("real JSONL process transport", () => {
  it("performs initialize/initialized in order and preserves split UTF-8", async () => {
    const receivedOut = join(SCRATCH, "handshake.json");
    const harness = await createCodexHarness({ scenario: { receivedOut, splitBytes: 3, agentText: "héllo 🌍" } });
    const outcome = await consume(harness.provider, request("split"));
    expect(outcome.result?.completion).toBe("completed-no-changes");
    expect(outcome.events.filter((event) => event.kind === "output-chunk").map((event: any) => event.payload.text).join("")) .toBe("héllo 🌍");
    const received = JSON.parse(await readFile(receivedOut, "utf8"));
    expect(received.slice(0, 4).map((entry: any) => entry.method)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(received.some((entry: any) => entry.method === "thread/shellCommand" || entry.method === "command/exec")).toBe(false);
    await harness.close();
  }, 15_000);
  it("correlates concurrent out-of-order responses", async () => {
    const harness = await createCodexHarness({ scenario: { outOfOrder: true } });
    const connection = await connectCodexAppServer({ configuration: harness.configuration, process: harness.process, scheduler: { delay: (milliseconds) => ({ promise: harness.scheduler.wait(milliseconds), cancel() {} }) }, request: { kind: "app-server", args: [], deadline: null, wallClockMs: 60_000, outputBytes: 1_000_000, environment: [], workspaceId: WORKSPACE_ID, trace: TEST_TRACE }, handleServerRequest: async () => ({ decision: "decline" }) });
    const [account, usage] = await Promise.all([connection.request("account/read"), connection.request("account/usage/read")]);
    expect(account).toEqual({ echoed: "account/read" }); expect(usage).toEqual({ echoed: "account/usage/read" });
    await connection.close(); await harness.close();
  });
  it("accepts a known timestamped status notification after initialize is accepted", async () => {
    const harness = await createCodexHarness({ scenario: { afterInitializeNotification: true } });
    expect(await harness.provider.accountState()).toMatchObject({ kind: "chatgpt" });
    await harness.close();
  });
  it.each([
    ["early notification", { beforeInitialize: true }, "PROTOCOL_VIOLATION"],
    ["unknown response id", { unknownId: true }, "PROTOCOL_VIOLATION"],
    ["unknown method", { unknownMethod: true }, "PROTOCOL_VIOLATION"],
    ["malformed JSON", { malformed: true }, "PROTOCOL_VIOLATION"],
    ["invalid UTF-8", { invalidUtf8: true }, "PROTOCOL_VIOLATION"],
    ["oversized record", { oversized: 300_000 }, "PROTOCOL_VIOLATION"],
    ["duplicate response", { duplicateResponse: true }, "PROTOCOL_VIOLATION"],
  ] as const)("fails closed on %s", async (_label, scenario, code) => {
    const harness = await createCodexHarness({ scenario }); const outcome = await consume(harness.provider, request(`hostile-${_label.replaceAll(" ", "-")}`));
    expect((outcome.error as { code?: string } | null)?.code).toBe(code); expect(outcome.events.at(-1)?.kind).toBe("operation-failed"); await harness.close();
  });
});

describe("provider mapping, approvals, resume, and telemetry", () => {
  it("exposes bounded descriptor and health states", async () => {
    const harness = await createCodexHarness({ scenario: {} }); expect(harness.provider.describe()).toMatchObject({ providerId: "codex", kind: "coding-agent", capabilities: { repositoryEditing: true, networkAccess: false } });
    expect(await harness.provider.health()).toMatchObject({ status: "ready", activeOperations: 0 }); await harness.provider.close(); expect(await harness.provider.health()).toMatchObject({ status: "closed" }); await harness.close();
    const degraded = await createCodexHarness({ scenario: {}, probeResult: { status: "incompatible", version: "0.147.0", schemaDigest: "d".repeat(64), schemaFileCount: 1, methods: [], detailCode: "schema-incompatible", compatibility: { matrixVersion: 1, tier: "schema-incompatible", version: "0.147.0", schemaDigest: "d".repeat(64), missingRequiredMethods: ["turn/start"], usableForReadOnly: false, usableForStateChanging: false } } });
    expect(await degraded.provider.health()).toMatchObject({ status: "degraded", detailCode: "schema-incompatible" }); await degraded.close();
  });
  it("maps read-only sandbox, plan, and redacted warnings without broad tools", async () => {
    const receivedOut = join(SCRATCH, "read-only.json"); const harness = await createCodexHarness({ scenario: { receivedOut, plan: true, warnings: ["warning", "guardianWarning", "configWarning"] } });
    const outcome = await consume(harness.provider, request("read-only", { capabilities: ["read-files"] })); expect(outcome.result?.warnings).toHaveLength(3); expect(outcome.events.filter((event) => event.kind === "status-update")).toHaveLength(2);
    const received = JSON.parse(await readFile(receivedOut, "utf8")); const turn = received.find((entry: any) => entry.method === "turn/start"); expect(turn.params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
    const thread = received.find((entry: any) => entry.method === "thread/start"); expect(thread.params.config).toMatchObject({ mcp_servers: {}, skills: { config: [] }, web_search: "disabled", features: { apps: false, remote_plugin: false, multi_agent: false } }); await harness.close();
  });
  it("rejects model and effort substitution", async () => {
    for (const scenario of [{ reportedModel: "substituted" }, { reportedEffort: "low" }]) {
      const harness = await createCodexHarness({ scenario }); const outcome = await consume(harness.provider, request(`substitution-${Object.keys(scenario)[0]}`));
      expect(isProviderError(outcome.error, "PROTOCOL_VIOLATION")).toBe(true); await harness.close();
    }
  });
  it("uses actual workspace state instead of claimed diffs", async () => {
    const harness = await createCodexHarness({ scenario: { fileClaim: true, claimedPath: "fiction.txt", afterFiles: [{ path: "src/actual.ts", action: "write", content: "export {};\n" }] } });
    const outcome = await consume(harness.provider, request("reconcile"));
    expect(outcome.result?.changedFiles).toEqual([{ path: "src/actual.ts", changeKind: "added" }]);
    expect(outcome.result?.changedFiles.some((entry) => entry.path === "fiction.txt")).toBe(false); await harness.close();
  });
  it("never converts a partial edit plus connection loss into success", async () => {
    const harness = await createCodexHarness({ scenario: { beforeFiles: [{ path: "src/partial.ts", action: "write", content: "partial\n" }], malformed: true } });
    const outcome = await consume(harness.provider, request("partial"));
    expect(outcome.result).toBeNull(); expect(isProviderError(outcome.error, "PROTOCOL_VIOLATION")).toBe(true);
    expect(outcome.events.some((event) => event.kind === "file-change-applied")).toBe(true); await harness.close();
  });
  it.each([
    ["approved", "accept"], ["repeated", "acceptForSession"], ["denied", "decline"], ["forged", "decline"], ["expired", "decline"], ["cancelled", "cancel"],
  ] as const)("translates %s exact-scope approval evidence", async (decision, expected) => {
    const approvalOut = join(SCRATCH, `approval-${decision}.json`);
    const harness = await createCodexHarness({ scenario: { command: true, approval: "command", approvalOut }, approval: decision });
    const outcome = await consume(harness.provider, request(`approval-${decision}`, { capabilities: ["read-files", "edit-files", "run-commands"], commandPolicy: { mode: "sandboxed", allowedCommands: [] }, approvalMode: "always" }));
    const response = JSON.parse(await readFile(approvalOut, "utf8")); expect(response.result.decision).toBe(expected);
    if (decision === "cancelled") expect(isProviderError(outcome.error, "CANCELLED")).toBe(true); else expect(outcome.result?.approvalDecisions).toHaveLength(1);
    await harness.close();
  });
  it("mints and consumes only a bound explicit thread resume token", async () => {
    const receivedOut = join(SCRATCH, "resume.json");
    const harness = await createCodexHarness({ scenario: { receivedOut }, configuration: { sessions: { persistence: "policy-controlled", retentionMs: 3_600_000 } }, persistenceAllowed: true });
    const first = await consume(harness.provider, request("persist")); expect(first.result?.resumeToken).toEqual(expect.any(String));
    const second = await consume(harness.provider, request("resume", { resumeToken: first.result!.resumeToken })); expect(second.result?.completion).toBe("completed-no-changes");
    const received = JSON.parse(await readFile(receivedOut, "utf8")); expect(received.some((entry: any) => entry.method === "thread/resume")).toBe(true);
    await expect(harness.provider.start(request("forged-resume", { resumeToken: `${first.result!.resumeToken}x` }))).rejects.toMatchObject({ code: "INVALID_REQUEST" }); await harness.close();
  });
  it("reads account, multi-window limits, usage, and unsupported key usage", async () => {
    const harness = await createCodexHarness({ scenario: {} });
    expect(await harness.provider.accountState()).toMatchObject({ kind: "chatgpt", planType: "plus" });
    const rates = await harness.provider.rateLimits(); expect(rates.status).toBe("reported"); expect(rates.windows).toHaveLength(2); expect(rates.resetCreditsAvailable).toBe(2);
    expect(await harness.provider.accountUsage()).toMatchObject({ status: "reported", summary: { lifetimeTokens: 1000 } }); await harness.close();
    const key = await createCodexHarness({ scenario: { account: { account: { type: "apiKey" }, requiresOpenaiAuth: true }, unsupportedUsage: true } });
    expect(await key.provider.accountUsage()).toMatchObject({ status: "unsupported", summary: null }); await key.close();
    const unsupported = await createCodexHarness({ scenario: { unsupportedRate: true } }); expect(await unsupported.provider.rateLimits()).toMatchObject({ status: "unsupported", windows: [] }); await unsupported.close();
  });
  it("creates private workspace commits and honors denied artifact persistence", async () => {
    const committed = await createCodexHarness({ scenario: { afterFiles: [{ path: "src/committed.ts", action: "write", content: "export {};\n" }] } });
    const commitOutcome = await consume(committed.provider, request("commit", { capabilities: ["read-files", "edit-files", "git-commit"] })); expect(commitOutcome.result?.resultRevision).toMatch(/^[0-9a-f]{40,64}$/); await committed.close();
    const report = await createCodexHarness({ scenario: { afterFiles: [{ path: "reports/tests.json", action: "write", content: JSON.stringify({ suite: "unit", passed: 1, failed: 0, skipped: 0 }) }] }, artifactPersistenceAllowed: false });
    const reportOutcome = await consume(report.provider, request("no-artifacts", { capabilities: ["read-files", "edit-files", "run-commands", "run-tests"], commandPolicy: { mode: "sandboxed", allowedCommands: [] } })); expect(reportOutcome.result?.testResults?.artifactId).toBeNull(); expect(report.artifacts.writes).toHaveLength(0); await report.close();
  });
  it("rejects unsafe request translations before process creation", async () => {
    const marker = join(SCRATCH, "translation-refused.marker"); const harness = await createCodexHarness({ scenario: { startMarker: marker } });
    const cases = [
      request("bad-base", { baseRevision: "a".repeat(40) }), request("proxied", { networkPolicy: "proxied" }),
      request("bad-model", { modelId: "other-model" }), request("bad-extension", { extensions: [{ namespace: "other", key: "effort", value: "high" }] }),
      request("unbound-resume", { resumeToken: "opaque" }),
    ];
    const codes: string[] = []; for (const candidate of cases) { try { await harness.provider.start(candidate); } catch (error: any) { codes.push(error.code); } }
    expect(codes).toEqual(["WORKSPACE_UNAVAILABLE", "UNSUPPORTED_CAPABILITY", "INVALID_REQUEST", "INVALID_REQUEST", "UNSUPPORTED_CAPABILITY"]); expect(markerExists(marker)).toBe(false); await harness.close();
    const sandbox = await createCodexHarness({ scenario: {}, configuration: { sandboxMappings: ["read-only"] } }); await expect(sandbox.provider.start(request("missing-write-map"))).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" }); await sandbox.close();
    const approval = await createCodexHarness({ scenario: {}, configuration: { approvalMappings: ["never"] } }); await expect(approval.provider.start(request("missing-approval-map", { capabilities: ["read-files"] }))).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" }); await approval.close();
    const denied = await createCodexHarness({ scenario: {}, policyOutcome: "denied" }); await expect(denied.provider.start(request("policy-denied"))).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" }); await denied.close();
  }, 20_000);
  it.each([
    ["contextWindowExceeded", "CONTEXT_LIMIT_EXCEEDED"], ["usageLimitExceeded", "RATE_LIMITED"], ["serverOverloaded", "PROVIDER_OVERLOADED"],
    ["unauthorized", "AUTHENTICATION_FAILED"], ["badRequest", "CONTENT_REJECTED"], [{ httpConnectionFailed: {} }, "NETWORK_FAILURE"], ["unknownFailure", "INTERNAL_FAILURE"],
  ] as const)("maps structured turn error %j", async (turnError, code) => {
    const harness = await createCodexHarness({ scenario: { turnError } }); const outcome = await consume(harness.provider, request(`turn-error-${code}`)); expect((outcome.error as any)?.code).toBe(code); await harness.close();
  });
  it.each([
    [{ code: -32001, message: "busy", data: { retryAfterMs: 10 } }, "PROVIDER_OVERLOADED"],
    [{ code: -32000, message: "auth", data: { httpStatusCode: 401 } }, "AUTHENTICATION_FAILED"],
    [{ code: -32000, message: "rate", data: { httpStatusCode: 429, retryAfterMs: 20 } }, "RATE_LIMITED"],
    [{ code: -32000, message: "network", data: { httpStatusCode: 503 } }, "NETWORK_FAILURE"],
    [{ code: -32602, message: "bad" }, "PROTOCOL_VIOLATION"],
  ] as const)("maps structured RPC errors", async (threadStartError, code) => {
    const harness = await createCodexHarness({ scenario: { threadStartError } }); const outcome = await consume(harness.provider, request(`rpc-error-${code}`)); expect((outcome.error as any)?.code).toBe(code); await harness.close();
  });
  it("acknowledges an in-flight interrupt and supports pre-aborted starts", async () => {
    const harness = await createCodexHarness({ scenario: { hang: true } }); const operation = await harness.provider.start(request("interrupt")); const iterator = operation.events()[Symbol.asyncIterator]();
    for (;;) { const step = await iterator.next(); if (step.done || step.value.kind === "status-update") break; }
    await operation.cancel("test-cancel"); for (;;) { const step = await iterator.next(); if (step.done) break; } await expect(operation.result).rejects.toMatchObject({ code: "CANCELLED" }); await harness.close();
    const pre = await createCodexHarness({ scenario: {} }); const controller = new AbortController(); controller.abort(); const preOperation = await pre.provider.start(request("pre-abort"), { signal: controller.signal }); for await (const _event of preOperation.events()) { /* drain */ } await expect(preOperation.result).rejects.toMatchObject({ code: "CANCELLED" }); await pre.close();
  });
});

describe("probe and production admission", () => {
  it("probes version plus generated schema through supervised processes", async () => {
    const harness = await createCodexHarness({ scenario: {} }); const schema = join(harness.base, "schema-ok"); await mkdir(schema);
    const result = await probeCodex({ configuration: harness.configuration, process: harness.process, workspaceId: WORKSPACE_ID, schemaOutputDirectory: schema, trace: TEST_TRACE });
    expect(result).toMatchObject({ status: "ready", version: "0.146.0-alpha.9.2", schemaFileCount: 1 }); expect(result.methods).toEqual(expect.arrayContaining(["thread/start", "account/usage/read"])); await harness.close();
  });
  it("reports old versions and incomplete schemas as incompatible", async () => {
    const old = await createCodexHarness({ scenario: { version: "0.145.0" } }); const oldDir = join(old.base, "schema-old"); await mkdir(oldDir);
    expect(await probeCodex({ configuration: old.configuration, process: old.process, workspaceId: WORKSPACE_ID, schemaOutputDirectory: oldDir, trace: TEST_TRACE })).toMatchObject({ status: "incompatible", detailCode: "version-unsupported" }); await old.close();
    const missing = await createCodexHarness({ scenario: { schemaMethods: ["initialize"] } }); const missingDir = join(missing.base, "schema-missing"); await mkdir(missingDir);
    expect(await probeCodex({ configuration: missing.configuration, process: missing.process, workspaceId: WORKSPACE_ID, schemaOutputDirectory: missingDir, trace: TEST_TRACE })).toMatchObject({ status: "incompatible", detailCode: "schema-incompatible" }); await missing.close();
  });
  it("refuses production before spawn with a development positive control", async () => {
    const refusedMarker = join(SCRATCH, "production-refused.marker"); const production = await createCodexHarness({ scenario: { startMarker: refusedMarker }, mode: "production" });
    const refused = await consume(production.provider, request("production")); expect(isProviderError(refused.error, "UNSUPPORTED_CAPABILITY")).toBe(true); expect(markerExists(refusedMarker)).toBe(false); await production.close();
    const controlMarker = join(SCRATCH, "development-control.marker"); const development = await createCodexHarness({ scenario: { startMarker: controlMarker } });
    expect((await consume(development.provider, request("development"))).result?.completion).toBe("completed-no-changes"); expect(markerExists(controlMarker)).toBe(true); await development.close();
  });
});
