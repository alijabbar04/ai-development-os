/**
 * Opt-in live canaries. Every stateful/model test has its own flag; setting a
 * generic live flag never starts model work. All work uses the harness's
 * disposable managed repository, never the AI Development OS checkout.
 */
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createCodingAgentRequest } from "@ai-dev-os/providers";
import { probeCodex } from "../src/index.js";
import { INTERNAL_DISCLOSURE, TEST_TRACE, WORKSPACE_ID, cleanupCodexFixtures, createCodexHarness } from "./helpers/harness.js";

afterAll(cleanupCodexFixtures);

const executable = process.env["AI_DEV_OS_CODEX_EXECUTABLE"];
const model = process.env["AI_DEV_OS_CODEX_LIVE_MODEL"];
const enabled = (name: string): boolean => process.env[name] === "1" && typeof executable === "string" && isAbsolute(executable);
const modelEnabled = (name: string): boolean => enabled(name) && typeof model === "string" && model.length > 0 && !model.startsWith("-");

async function liveHarness() {
  return await createCodexHarness({
    scenario: {}, executablePath: executable!, pinnedArguments: null,
    configuration: model === undefined ? {} : { models: [{ modelId: model, efforts: ["low", "medium", "high"] }], defaultModel: model, defaultEffort: "high" },
  });
}

it.skipIf(!enabled("AI_DEV_OS_CODEX_LIVE_PROBE"))("live: probes installed Codex version and generated schema", async () => {
  const harness = await liveHarness(); const schema = join(harness.base, "live-schema"); await mkdir(schema);
  const result = await probeCodex({ configuration: harness.configuration, process: harness.process, workspaceId: WORKSPACE_ID, schemaOutputDirectory: schema, trace: TEST_TRACE });
  expect(result.status).toBe("ready"); expect(result.version).toEqual(expect.any(String)); await harness.close();
}, 120_000);

it.skipIf(!enabled("AI_DEV_OS_CODEX_LIVE_ACCOUNT"))("live: reads account and rate-limit state without mutations", async () => {
  const harness = await liveHarness(); expect(await harness.provider.accountState()).toBeDefined(); expect(await harness.provider.rateLimits()).toBeDefined(); await harness.close();
}, 120_000);

it.skipIf(!modelEnabled("AI_DEV_OS_CODEX_LIVE_READ_ONLY"))("live: runs a bounded read-only turn in a disposable managed repository", async () => {
  const harness = await liveHarness(); const operation = await harness.provider.start(createCodingAgentRequest({ requestId: "req-live-codex-read", workspaceId: WORKSPACE_ID, instructions: "Read tracked.txt and briefly report whether it exists. Do not change any file.", capabilities: ["read-files"], disclosure: INTERNAL_DISCLOSURE, trace: TEST_TRACE, deadline: new Date(Date.now() + 300_000).toISOString() }));
  for await (const _event of operation.events()) { /* bounded drain */ } expect((await operation.result).changedFiles).toHaveLength(0); await harness.close();
}, 360_000);

it.skipIf(!modelEnabled("AI_DEV_OS_CODEX_LIVE_EDIT"))("live: makes one bounded edit only in a disposable managed repository", async () => {
  const harness = await liveHarness(); const operation = await harness.provider.start(createCodingAgentRequest({ requestId: "req-live-codex-edit", workspaceId: WORKSPACE_ID, instructions: "Create live-canary.txt containing exactly: codex live canary\n", capabilities: ["read-files", "edit-files"], fileAccess: { allowedPathPrefixes: ["live-canary.txt"] }, maxChangedFiles: 1, maxProducedBytes: 1024, disclosure: INTERNAL_DISCLOSURE, trace: TEST_TRACE, deadline: new Date(Date.now() + 300_000).toISOString() }));
  for await (const _event of operation.events()) { /* bounded drain */ } expect((await operation.result).changedFiles).toEqual([{ path: "live-canary.txt", changeKind: "added" }]); await harness.close();
}, 360_000);
