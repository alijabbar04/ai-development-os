import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANTHROPIC_SUCCESS_RECEIPT_DIGEST_CONVENTION,
  ANTHROPIC_SUCCESS_RECEIPT_MAX_BYTES,
  ANTHROPIC_SUCCESS_RECEIPT_VERSION,
  anthropicValidationSuccessReceiptSha256,
  parseAnthropicValidationSuccessReceipt,
  parseCanonicalAnthropicValidationSuccessReceipt,
  serializeAnthropicValidationSuccessReceipt,
  type AnthropicValidationSuccessReceipt,
} from "../src/main/anthropic-validation-receipt.js";
import {
  anthropicValidationReceiptRoot,
  createFileAnthropicValidationSuccessReceiptStore,
  createMemoryAnthropicValidationSuccessReceiptStore,
} from "../src/main/anthropic-validation-receipt-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function receipt(changes: Partial<AnthropicValidationSuccessReceipt> = {}): AnthropicValidationSuccessReceipt {
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
    durationMs: 731,
    inputTokens: 19,
    outputTokens: 1,
    modelSubstitutionRejected: true,
    fixedRequestBody: true,
    repositorySourcePresent: false,
    credentialRetained: false,
    responseBodyRetained: false,
    policyDecisionFingerprint: "7".repeat(64),
    dispatchCount: 1,
    startedAt: "2026-08-24T10:00:00.000Z",
    completedAt: "2026-08-24T10:00:00.900Z",
    terminalState: "validated-success",
    ...changes,
  };
}

describe("sanitized Anthropic success receipt contract", () => {
  it("round-trips the exact flat field set and computes the digest independently", () => {
    const value = receipt();
    const parsed = parseAnthropicValidationSuccessReceipt(value);
    expect(parsed).toEqual(value);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(value).sort());
    const document = serializeAnthropicValidationSuccessReceipt(value);
    const independent = createHash("sha256").update(Buffer.from(document, "utf8")).digest("hex");
    expect(anthropicValidationSuccessReceiptSha256(value)).toBe(independent);
    expect(parseCanonicalAnthropicValidationSuccessReceipt(Buffer.from(document, "utf8"))).toEqual({ receipt: parsed, canonicalDocument: document, sha256: independent });
    expect(Object.values(parsed).every((field) => field === null || ["string", "number", "boolean"].includes(typeof field))).toBe(true);
  });

  it("keeps different real duration and token observations distinct, eliminating the historical reduced-metadata collision", () => {
    const first = receipt({ durationMs: 731, inputTokens: 19, outputTokens: 1 });
    const second = receipt({ durationMs: 912, inputTokens: 21, outputTokens: 2, completedAt: "2026-08-24T10:00:01.000Z" });
    expect(parseAnthropicValidationSuccessReceipt(first)).toMatchObject({ durationMs: 731, inputTokens: 19, outputTokens: 1 });
    expect(parseAnthropicValidationSuccessReceipt(second)).toMatchObject({ durationMs: 912, inputTokens: 21, outputTokens: 2 });
    expect(anthropicValidationSuccessReceiptSha256(first)).not.toBe(anthropicValidationSuccessReceiptSha256(second));
    const historicalReduction = (_value: AnthropicValidationSuccessReceipt) => Object.freeze({ outcome: "valid", resultCode: "VALIDATION_OK" });
    expect(historicalReduction(first)).toEqual(historicalReduction(second));
  });

  it("binds provider duration to a strictly sub-deadline host timestamp interval", () => {
    expect(parseAnthropicValidationSuccessReceipt(receipt({
      durationMs: 14_999,
      completedAt: "2026-08-24T10:00:19.999Z",
    }))).toMatchObject({ durationMs: 14_999 });
    expect(() => parseAnthropicValidationSuccessReceipt(receipt({
      durationMs: 1,
      completedAt: "2026-08-24T10:00:00.000Z",
    }))).toThrowError(expect.objectContaining({ code: "RECEIPT_INVALID" }));
    expect(() => parseAnthropicValidationSuccessReceipt(receipt({
      durationMs: 901,
      completedAt: "2026-08-24T10:00:00.900Z",
    }))).toThrowError(expect.objectContaining({ code: "RECEIPT_INVALID" }));
    expect(() => parseAnthropicValidationSuccessReceipt(receipt({
      durationMs: 14_999,
      completedAt: "2026-08-24T10:00:20.000Z",
    }))).toThrowError(expect.objectContaining({ code: "RECEIPT_INVALID" }));
  });

  it("refuses an inverse mutation of every fixed or bounded promoting field", () => {
    const mutations: Readonly<Record<keyof AnthropicValidationSuccessReceipt, unknown>> = {
      schemaVersion: 2,
      receiptVersion: "wrong",
      digestConvention: "wrong",
      operationVersion: "wrong",
      operationId: "credential-validate.bad",
      slotId: "openai",
      providerInstanceId: "anthropic-secondary",
      candidateHead: "z".repeat(40),
      candidateTree: "3".repeat(39),
      candidateManifestAggregate: "4".repeat(63),
      authorizationPacketSha256: "5".repeat(65),
      authorizationReference: "contains a space",
      markerNamespaceSha256: "G".repeat(64),
      authorizationRetentionMode: "contracted-zero",
      attemptLimit: 2,
      retryPolicy: "automatic",
      authorizationState: "available",
      resultSchemaVersion: 2,
      requestFingerprint: "0".repeat(64),
      endpoint: "https://example.invalid/v1/messages",
      apiVersion: "future",
      modelId: "substituted-model",
      retentionMode: "contracted-zero",
      statusCategory: "failure",
      transportKind: "deterministic-fake",
      durationMs: 15_000,
      inputTokens: 257,
      outputTokens: 5,
      modelSubstitutionRejected: false,
      fixedRequestBody: false,
      repositorySourcePresent: true,
      credentialRetained: true,
      responseBodyRetained: true,
      policyDecisionFingerprint: "7".repeat(63),
      dispatchCount: 2,
      startedAt: "2026-08-24T10:00:01.000Z",
      completedAt: "2026-08-24T09:59:59.000Z",
      terminalState: "pending",
    };
    expect(Object.keys(mutations).sort()).toEqual(Object.keys(receipt()).sort());
    for (const [field, invalid] of Object.entries(mutations)) {
      expect(() => parseAnthropicValidationSuccessReceipt({ ...receipt(), [field]: invalid }), field).toThrowError(expect.objectContaining({ code: "RECEIPT_INVALID" }));
    }
  });

  it("rejects unknown keys, duplicate JSON keys, proxies, accessors, abnormal prototypes, unsafe numbers, and oversized bytes", () => {
    expect(() => parseAnthropicValidationSuccessReceipt({ ...receipt(), unknown: true })).toThrow();
    expect(() => parseAnthropicValidationSuccessReceipt(new Proxy(receipt(), {}))).toThrow();
    expect(() => parseAnthropicValidationSuccessReceipt(Object.assign(Object.create({ polluted: true }), receipt()))).toThrow();
    const accessor = { ...receipt() } as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(accessor, "durationMs", { enumerable: true, get() { reads += 1; return 731; } });
    expect(() => parseAnthropicValidationSuccessReceipt(accessor)).toThrow();
    expect(reads).toBe(0);
    for (const unsafe of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, -1]) {
      expect(() => parseAnthropicValidationSuccessReceipt({ ...receipt(), durationMs: unsafe })).toThrow();
    }
    const canonical = serializeAnthropicValidationSuccessReceipt(receipt());
    const duplicate = canonical.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
    expect(() => parseCanonicalAnthropicValidationSuccessReceipt(Buffer.from(duplicate, "utf8"))).toThrow();
    expect(() => parseCanonicalAnthropicValidationSuccessReceipt(Buffer.from("{\n", "utf8"))).toThrowError(expect.objectContaining({ code: "RECEIPT_INVALID" }));
    expect(() => parseCanonicalAnthropicValidationSuccessReceipt(Buffer.alloc(ANTHROPIC_SUCCESS_RECEIPT_MAX_BYTES + 1, 0x20))).toThrow();
  });

  it("contains none of the forbidden secret, request, response, header, credential-record, or provider-prose material", () => {
    const document = serializeAnthropicValidationSuccessReceipt(receipt());
    for (const forbidden of [
      "SYNTHETIC_PRIVATE_CREDENTIAL",
      "x-api-key",
      "authorization: Bearer",
      "Reply with exactly OK.",
      "provider response body",
      `cred-${"8".repeat(32)}`,
      "recordToken",
      "clipboard",
      "PRIVATE_PROVIDER_PROSE",
    ]) expect(document.toLocaleLowerCase("en-US")).not.toContain(forbidden.toLocaleLowerCase("en-US"));
  });
});

describe("crash-safe exact receipt store and projection", () => {
  it("commits the body before the terminal sidecar and reads one exact pre-named receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-dev-os-success-receipt-"));
    roots.push(root);
    const phases: string[] = [];
    const store = createFileAnthropicValidationSuccessReceiptStore({
      root,
      durability: Object.freeze({ async syncDirectoryEntry(_directory, target) { phases.push(target.endsWith(".receipt.json") ? "receipt-durable" : "commit-durable"); } }),
    });
    const reference = await store.commit(receipt());
    expect(phases).toEqual(["receipt-durable", "commit-durable"]);
    expect(reference.receiptId).toBe("5".repeat(64));
    const projected = await store.readCommitted(reference.receiptId, {
      receiptSha256: reference.receiptSha256,
      candidateHead: "2".repeat(40),
      candidateTree: "3".repeat(40),
      candidateManifestAggregate: "4".repeat(64),
    });
    expect(projected.receipt).toEqual(receipt());
    expect(projected.canonicalDocument).toBe(serializeAnthropicValidationSuccessReceipt(receipt()));
    expect((await readdir(root)).sort()).toEqual([`${reference.receiptId}.commit.json`, `${reference.receiptId}.receipt.json`]);
    await expect(store.commit(receipt())).rejects.toMatchObject({ code: "RECEIPT_CONFLICT" });
  });

  it("accepts a stable Windows lexical alias while pinning its canonical receipt-root identity", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "ai-dev-os-success-receipt-alias-"));
    roots.push(root);
    const canonicalRoot = await realpath(root);
    if (canonicalRoot.toLowerCase() === root.toLowerCase()) return;

    const store = createFileAnthropicValidationSuccessReceiptStore({ root });
    const reference = await store.commit(receipt());
    await expect(store.readCommitted(reference.receiptId, {
      receiptSha256: reference.receiptSha256,
      candidateHead: "2".repeat(40),
      candidateTree: "3".repeat(40),
      candidateManifestAggregate: "4".repeat(64),
    })).resolves.toMatchObject({ reference, receipt: receipt() });
  });

  it("fails closed on directory durability failure and leaves no terminally projectable receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-dev-os-success-receipt-durability-"));
    roots.push(root);
    const store = createFileAnthropicValidationSuccessReceiptStore({
      root,
      durability: Object.freeze({ async syncDirectoryEntry() { throw new Error("synthetic-directory-durability-failure"); } }),
    });
    await expect(store.commit(receipt())).rejects.toMatchObject({ code: "RECEIPT_UNAVAILABLE" });
    await expect(store.readCommitted("5".repeat(64))).rejects.toMatchObject({ code: "RECEIPT_INCOMPLETE" });
  });

  it("rejects a replaced receipt root at the post-promotion identity barrier", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ai-dev-os-success-receipt-root-replaced-"));
    roots.push(parent);
    const root = join(parent, "receipts");
    const displaced = join(parent, "displaced-receipts");
    const store = createFileAnthropicValidationSuccessReceiptStore({
      root,
      durability: Object.freeze({
        async syncDirectoryEntry() {
          await (await import("node:fs/promises")).rename(root, displaced);
          await (await import("node:fs/promises")).mkdir(root);
        },
      }),
    });
    await expect(store.commit(receipt())).rejects.toMatchObject({ code: "RECEIPT_UNAVAILABLE" });
  });

  it("refuses a promoted target replaced during the durability barrier", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-dev-os-success-receipt-replaced-"));
    roots.push(root);
    const store = createFileAnthropicValidationSuccessReceiptStore({
      root,
      durability: Object.freeze({
        async syncDirectoryEntry(_directory, target) {
          if (target.endsWith(".receipt.json")) {
            await rm(target);
            await writeFile(target, "{}\n", { encoding: "utf8", flag: "wx" });
          }
        },
      }),
    });
    await expect(store.commit(receipt())).rejects.toMatchObject({ code: "RECEIPT_UNAVAILABLE" });
    await expect(store.readCommitted("5".repeat(64))).rejects.toMatchObject({ code: "RECEIPT_INCOMPLETE" });
  });

  it("re-identifies the named path after reading and refuses a concurrent replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-dev-os-success-receipt-read-race-"));
    roots.push(root);
    const writer = createFileAnthropicValidationSuccessReceiptStore({ root });
    const reference = await writer.commit(receipt());
    let replaced = false;
    const reader = createFileAnthropicValidationSuccessReceiptStore({
      root,
      testingHooks: Object.freeze({
        async afterReadBeforePathIdentity(path) {
          if (replaced || !path.endsWith(".commit.json")) return;
          replaced = true;
          const displaced = `${path}.displaced`;
          await rename(path, displaced);
          await writeFile(path, await readFile(displaced), { flag: "wx" });
        },
      }),
    });
    await expect(reader.readCommitted(reference.receiptId)).rejects.toMatchObject({ code: "RECEIPT_INVALID" });
    expect(replaced).toBe(true);
  });

  it("rejects missing, truncated, corrupt, oversized, mismatched, and noncanonical committed state", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-dev-os-success-receipt-corrupt-"));
    roots.push(root);
    const absentRoot = join(root, "absent-receipt-root");
    const absentStore = createFileAnthropicValidationSuccessReceiptStore({ root: absentRoot });
    await expect(absentStore.readCommitted("5".repeat(64))).rejects.toMatchObject({ code: "RECEIPT_MISSING" });
    const store = createFileAnthropicValidationSuccessReceiptStore({ root });
    await expect(store.readCommitted("5".repeat(64))).rejects.toMatchObject({ code: "RECEIPT_INCOMPLETE" });
    await expect(store.readCommitted("5".repeat(64), { receiptSha256: "not-a-digest" })).rejects.toMatchObject({ code: "RECEIPT_INVALID" });
    const reference = await store.commit(receipt());
    const commit = join(root, `${reference.receiptId}.commit.json`);
    const body = join(root, `${reference.receiptId}.receipt.json`);
    await expect(store.readCommitted(reference.receiptId, { candidateHead: "9".repeat(40) })).rejects.toMatchObject({ code: "RECEIPT_INVALID" });
    await writeFile(body, "{}\n", "utf8");
    await expect(store.readCommitted(reference.receiptId)).rejects.toMatchObject({ code: "RECEIPT_INVALID" });
    await writeFile(body, "x".repeat(ANTHROPIC_SUCCESS_RECEIPT_MAX_BYTES + 1), "utf8");
    await expect(store.readCommitted(reference.receiptId)).rejects.toMatchObject({ code: "RECEIPT_INVALID" });
    await writeFile(commit, "{\n", "utf8");
    await expect(store.readCommitted(reference.receiptId)).rejects.toMatchObject({ code: "RECEIPT_INVALID" });
  });

  it("refuses a root junction/symlink and a named receipt symlink without following either", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ai-dev-os-success-receipt-link-"));
    roots.push(parent);
    const target = join(parent, "target");
    const linkedRoot = join(parent, "linked-root");
    await writeFile(join(parent, "outside-receipt.json"), serializeAnthropicValidationSuccessReceipt(receipt()), "utf8");
    await (await import("node:fs/promises")).mkdir(target);
    await symlink(target, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const linked = createFileAnthropicValidationSuccessReceiptStore({ root: linkedRoot });
    await expect(linked.commit(receipt())).rejects.toMatchObject({ code: "RECEIPT_UNAVAILABLE" });

    const clean = createFileAnthropicValidationSuccessReceiptStore({ root: target });
    const id = "5".repeat(64);
    try {
      await symlink(join(parent, "outside-receipt.json"), join(target, `${id}.commit.json`), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      await (await import("node:fs/promises")).mkdir(join(target, `${id}.commit.json`));
    }
    await expect(clean.readCommitted(id)).rejects.toMatchObject({ code: "RECEIPT_INVALID" });
  });

  it("projects read-only without changing sibling marker, metadata, or vault sentinels and without directory enumeration in implementation", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ai-dev-os-success-receipt-readonly-"));
    roots.push(parent);
    const root = join(parent, "receipts");
    const sentinels = ["marker.attempt", "credential-ui.v1.json", "application-vault.synthetic"];
    for (const name of sentinels) await writeFile(join(parent, name), `unchanged-${name}`, "utf8");
    const store = createFileAnthropicValidationSuccessReceiptStore({ root });
    const reference = await store.commit(receipt());
    const before = await Promise.all(sentinels.map(async (name) => ({ name, bytes: await readFile(join(parent, name), "utf8"), modified: (await stat(join(parent, name))).mtimeMs })));
    const projected = await store.readCommitted(reference.receiptId);
    expect(projected.reference).toEqual(reference);
    const after = await Promise.all(sentinels.map(async (name) => ({ name, bytes: await readFile(join(parent, name), "utf8"), modified: (await stat(join(parent, name))).mtimeMs })));
    expect(after).toEqual(before);
    const implementation = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main", "anthropic-validation-receipt-store.ts"), "utf8");
    expect(implementation).not.toMatch(/\breaddir\b|\bopendir\b/u);
  });

  it("keeps the memory store exact, create-only, and binding-aware for synthetic host tests", async () => {
    const store = createMemoryAnthropicValidationSuccessReceiptStore();
    const reference = await store.commit(receipt());
    expect(store.commits).toBe(1);
    await expect(store.readCommitted(reference.receiptId)).resolves.toMatchObject({ reference, receipt: receipt() });
    await expect(store.readCommitted(reference.receiptId, { receiptSha256: "0".repeat(64) })).rejects.toMatchObject({ code: "RECEIPT_INVALID" });
    await expect(store.commit(receipt())).rejects.toMatchObject({ code: "RECEIPT_CONFLICT" });
  });

  it("fixes the receipt root beneath the supplied appData identity", () => {
    const appData = join(tmpdir(), "synthetic-receipt-app-data-only");
    expect(anthropicValidationReceiptRoot(appData, "AI Development OS")).toBe(join(appData, "AI Development OS", "credential-setup", "anthropic-validation", "success-receipts-v1"));
    expect(() => anthropicValidationReceiptRoot(appData, "..")).toThrowError(expect.objectContaining({ code: "RECEIPT_UNAVAILABLE" }));
    expect(() => createFileAnthropicValidationSuccessReceiptStore({ root: "relative-receipt-root" })).toThrowError(expect.objectContaining({ code: "RECEIPT_UNAVAILABLE" }));
  });
});
