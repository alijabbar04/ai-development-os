import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANTHROPIC_SUCCESS_RECEIPT_DIGEST_CONVENTION,
  ANTHROPIC_SUCCESS_RECEIPT_VERSION,
  serializeAnthropicValidationSuccessReceipt,
  type AnthropicValidationSuccessReceipt,
} from "../src/main/anthropic-validation-receipt.js";
import { createFileAnthropicValidationSuccessReceiptStore } from "../src/main/anthropic-validation-receipt-store.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(packageRoot, "scripts", "project-anthropic-validation-receipt.mjs");

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function syntheticReceipt(): AnthropicValidationSuccessReceipt {
  return {
    schemaVersion: 1,
    receiptVersion: ANTHROPIC_SUCCESS_RECEIPT_VERSION,
    digestConvention: ANTHROPIC_SUCCESS_RECEIPT_DIGEST_CONVENTION,
    operationVersion: "ai-dev-os.stage-18e-i.anthropic-validation.v1",
    operationId: `credential-validate.${"1".repeat(32)}`,
    slotId: "anthropic",
    providerInstanceId: "anthropic-default",
    candidateHead: "2".repeat(40),
    candidateTree: "3".repeat(40),
    candidateManifestAggregate: "4".repeat(64),
    authorizationPacketSha256: "5".repeat(64),
    authorizationReference: "synthetic-reviewed-attempt",
    markerNamespaceSha256: "6".repeat(64),
    authorizationRetentionMode: "standard-commercial-api",
    attemptLimit: 1,
    retryPolicy: "none",
    authorizationState: "consumed-before-dispatch",
    resultSchemaVersion: 1,
    requestFingerprint: "0982d0a5d19ff6bf01bc87a40b96da6a33e84bccd294846ea7ecf1ccd2d7a13a",
    endpoint: "https://api.anthropic.com/v1/messages",
    apiVersion: "2023-06-01",
    modelId: "claude-haiku-4-5-20251001",
    retentionMode: "standard-30-day",
    statusCategory: "success",
    transportKind: "direct-anthropic-https",
    durationMs: 411,
    inputTokens: 18,
    outputTokens: 1,
    modelSubstitutionRejected: true,
    fixedRequestBody: true,
    repositorySourcePresent: false,
    credentialRetained: false,
    responseBodyRetained: false,
    policyDecisionFingerprint: "7".repeat(64),
    dispatchCount: 1,
    startedAt: "2026-08-24T10:00:00.000Z",
    completedAt: "2026-08-24T10:00:00.500Z",
    terminalState: "validated-success",
  };
}

describe("isolated read-only receipt projection command", () => {
  it("returns only exact canonical receipt bytes and a stable digest without touching sibling state", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ai-dev-os-receipt-cli-"));
    roots.push(parent);
    const receiptRoot = join(parent, "receipts");
    const sentinelPaths = [join(parent, "marker.attempt"), join(parent, "credential-ui.v1.json"), join(parent, "vault.synthetic")];
    for (const path of sentinelPaths) await writeFile(path, `unchanged-${path.split(/[\\/]/u).at(-1)}`, "utf8");
    const store = createFileAnthropicValidationSuccessReceiptStore({ root: receiptRoot });
    const value = syntheticReceipt();
    const reference = await store.commit(value);
    const before = await Promise.all(sentinelPaths.map(async (path) => ({ bytes: await readFile(path, "utf8"), modified: (await stat(path)).mtimeMs })));
    const result = await execFile(process.execPath, [
      script,
      "--root", receiptRoot,
      "--receipt-id", reference.receiptId,
      "--candidate-head", value.candidateHead,
      "--candidate-tree", value.candidateTree,
      "--manifest-aggregate", value.candidateManifestAggregate,
    ], { cwd: packageRoot, windowsHide: true, maxBuffer: 32_768 });
    expect(result.stdout).toBe(serializeAnthropicValidationSuccessReceipt(value));
    expect(result.stderr).toBe(`receipt-sha256=${reference.receiptSha256}\n`);
    await expect(execFile(process.execPath, [
      script,
      "--root", receiptRoot,
      "--receipt-id", reference.receiptId,
      "--candidate-head", "9".repeat(40),
      "--candidate-tree", value.candidateTree,
      "--manifest-aggregate", value.candidateManifestAggregate,
    ], { cwd: packageRoot, windowsHide: true, maxBuffer: 32_768 })).rejects.toMatchObject({ stderr: "RECEIPT_INVALID\n" });
    const after = await Promise.all(sentinelPaths.map(async (path) => ({ bytes: await readFile(path, "utf8"), modified: (await stat(path)).mtimeMs })));
    expect(after).toEqual(before);
  });

  it("rejects missing explicit binding, changed candidate binding, and extra arguments", async () => {
    const source = await readFile(script, "utf8");
    expect(source).not.toMatch(/readdir|opendir|clipboard|safeStorage|electron|fetch|https\.request|http\.request/u);
    await expect(execFile(process.execPath, [script], { cwd: packageRoot, windowsHide: true })).rejects.toMatchObject({ stderr: "RECEIPT_PROJECTION_ARGUMENTS_INVALID\n" });
    await expect(execFile(process.execPath, [script, "--root", packageRoot, "--receipt-id", "5".repeat(64), "--candidate-head", "2".repeat(40), "--candidate-tree", "3".repeat(40), "--manifest-aggregate", "4".repeat(64), "--extra", "no"], { cwd: packageRoot, windowsHide: true })).rejects.toMatchObject({ stderr: "RECEIPT_PROJECTION_ARGUMENTS_INVALID\n" });
  });
});
