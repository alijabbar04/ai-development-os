import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toCanonicalJson } from "@ai-dev-os/domain";
import { secretRefFingerprint } from "@ai-dev-os/secrets";
import { appVaultReferenceForSlot } from "@ai-dev-os/secrets-app-vault";
import {
  ANTHROPIC_VALIDATION_AUTHORIZATION_RELATIVE_PATH,
  ANTHROPIC_VALIDATION_MARKER_NAMESPACE_PREFIX,
  STAGE_18E_I_CANDIDATE_BINDING_PATH,
  anthropicValidationAuthorizationRoot,
  createAnthropicValidationAuthorizationGate,
  createAnthropicValidationAuthorizationPacket,
  loadStage18eICandidateBinding,
  parseStage18eICandidateBinding,
  serializeAnthropicValidationAuthorizationPacket,
  type AnthropicValidationAuthorizationPacket,
  type Stage18eICandidateBinding,
} from "../src/main/anthropic-validation-authorization.js";

const roots: string[] = [];
const ISSUED = "2026-08-23T12:00:00.000Z";
const EXPIRES = "2026-08-23T13:00:00.000Z";
const MARKER_NAMESPACE = `${ANTHROPIC_VALIDATION_MARKER_NAMESPACE_PREFIX}${"9".repeat(32)}`;
const candidate: Stage18eICandidateBinding = Object.freeze({
  schemaVersion: 1,
  status: "published",
  head: "1".repeat(40),
  tree: "2".repeat(40),
  sourceCommit: "3".repeat(40),
  sourceTree: "4".repeat(40),
  manifestPath: "docs/release-evidence/stage-18e-i-sanitized-success-receipt-subject-manifest.json",
  manifestSha256: "5".repeat(64),
  manifestAggregate: "6".repeat(64),
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "ai-dev-os-anthropic-authorization-test-"));
  roots.push(value);
  return value;
}

function packet(overrides: Partial<Parameters<typeof createAnthropicValidationAuthorizationPacket>[0]> = {}): AnthropicValidationAuthorizationPacket {
  return createAnthropicValidationAuthorizationPacket({
    candidate,
    authorizationReference: "operator-review-stage-18e-i",
    markerNamespace: MARKER_NAMESPACE,
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    ...overrides,
  });
}

async function writePacket(targetRoot: string, value: string = serializeAnthropicValidationAuthorizationPacket(packet())): Promise<void> {
  const path = join(targetRoot, ...ANTHROPIC_VALIDATION_AUTHORIZATION_RELATIVE_PATH.split("/"));
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, value, { encoding: "utf8", flag: "wx" });
}

function canonical(value: unknown): string {
  return `${toCanonicalJson(value, "testAuthorization")}\n`;
}

describe("Stage 18E-I candidate-bound Anthropic authorization", () => {
  it("pins the exact request, provider reference, retention, bounds, candidate, and one-attempt vocabulary", () => {
    const value = packet();
    expect(value).toMatchObject({
      schemaVersion: 1,
      operationVersion: "ai-dev-os.stage-18e-i.anthropic-validation.v1",
      candidate: {
        head: candidate.head,
        tree: candidate.tree,
        sourceCommit: candidate.sourceCommit,
        sourceTree: candidate.sourceTree,
        manifestSha256: candidate.manifestSha256,
        manifestAggregate: candidate.manifestAggregate,
      },
      provider: {
        slotId: "anthropic",
        providerInstanceId: "anthropic-default",
        secretRef: {
          containerId: "app-vault.v1",
          entryName: "anthropic",
          fingerprint: secretRefFingerprint(appVaultReferenceForSlot("anthropic")),
        },
      },
      request: {
        endpoint: "https://api.anthropic.com/v1/messages",
        apiVersion: "2023-06-01",
        model: "claude-haiku-4-5-20251001",
        requestSha256: "0982d0a5d19ff6bf01bc87a40b96da6a33e84bccd294846ea7ecf1ccd2d7a13a",
        requestBytes: 116,
        maximumOutputTokens: 4,
        maximumResponseBytes: 65_536,
        effectTimeoutMs: 15_000,
        callbackDrainMs: 5_000,
        transport: "direct-anthropic-https",
        retentionMode: "standard-commercial-api",
      },
      attemptLimit: 1,
      retryPolicy: "none",
      expectedResult: {
        successTransport: "direct-anthropic-https",
        exactAssistantText: "OK",
        finiteOutcomes: ["valid", "invalid", "unauthorized", "ambiguous", "unreachable"],
      },
    });
    expect(Buffer.byteLength(serializeAnthropicValidationAuthorizationPacket(value), "utf8")).toBeLessThan(32_768);
  });

  it("loads only canonical candidate bytes from the fixed application-relative path", async () => {
    const applicationRoot = await root();
    const path = join(applicationRoot, ...STAGE_18E_I_CANDIDATE_BINDING_PATH.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, canonical(candidate), "utf8");
    await expect(loadStage18eICandidateBinding(applicationRoot)).resolves.toEqual(candidate);
    await writeFile(path, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    await expect(loadStage18eICandidateBinding(applicationRoot)).resolves.toBeNull();
  });

  it("is unavailable without a published binding or packet and never creates a marker while merely loading", async () => {
    const targetRoot = await root();
    const noBinding = await createAnthropicValidationAuthorizationGate({ root: targetRoot, candidateBinding: null, now: () => new Date(ISSUED) });
    expect(noBinding.authorization()).toMatchObject({ state: "unavailable", packetFingerprint: null });
    expect(await readdir(targetRoot)).toEqual([]);
    const noPacket = await createAnthropicValidationAuthorizationGate({ root: targetRoot, candidateBinding: candidate, now: () => new Date(ISSUED) });
    expect(noPacket.authorization().state).toBe("unavailable");
    expect(await readdir(targetRoot)).toEqual([]);
  });

  it("creates one marker atomically before yielding a single-use claim and stays consumed across restart", async () => {
    const targetRoot = await root();
    await writePacket(targetRoot);
    const first = await createAnthropicValidationAuthorizationGate({ root: targetRoot, candidateBinding: candidate, now: () => new Date(ISSUED) });
    const second = await createAnthropicValidationAuthorizationGate({ root: targetRoot, candidateBinding: candidate, now: () => new Date(ISSUED) });
    expect(first.authorization().state).toBe("available");
    const inputs = { slotId: "anthropic" as const, providerInstanceId: "anthropic-default" as const, secretRefFingerprint: secretRefFingerprint(appVaultReferenceForSlot("anthropic")) };
    const settled = await Promise.allSettled([first.consume(inputs), second.consume(inputs)]);
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(1);
    const winningIndex = settled.findIndex((item) => item.status === "fulfilled");
    const winningGate = winningIndex === 0 ? first : second;
    const claim = (settled[winningIndex] as PromiseFulfilledResult<Awaited<ReturnType<typeof first.consume>>>).value;
    expect(winningGate.claim(claim)).toEqual(packet());
    expect(() => winningGate.claim(claim)).toThrowError(expect.objectContaining({ code: "AUTHORIZATION_CONSUMED" }));
    const markerFiles = await readdir(join(targetRoot, "markers-v1"));
    expect(markerFiles).toHaveLength(1);
    expect(markerFiles[0]).toBe(`${createHash("sha256").update(MARKER_NAMESPACE).digest("hex")}.attempt`);
    const markerPath = join(targetRoot, "markers-v1", markerFiles[0]!);
    const markerStat = await lstat(markerPath);
    expect(markerStat.isFile()).toBe(true);
    expect(markerStat.isSymbolicLink()).toBe(false);
    expect(await readFile(markerPath, "utf8")).toBe(canonical({
      schemaVersion: 1,
      operationVersion: "ai-dev-os.stage-18e-i.anthropic-validation.v1",
      packetFingerprint: createHash("sha256")
        .update(serializeAnthropicValidationAuthorizationPacket(packet()))
        .digest("hex"),
      authorizationReference: "operator-review-stage-18e-i",
      markerNamespace: MARKER_NAMESPACE,
      consumedAt: ISSUED,
      state: "consumed-before-dispatch",
    }));
    const restarted = await createAnthropicValidationAuthorizationGate({ root: targetRoot, candidateBinding: candidate, now: () => new Date(ISSUED) });
    expect(restarted.authorization().state).toBe("consumed");
    await expect(restarted.consume(inputs)).rejects.toMatchObject({ code: "AUTHORIZATION_CONSUMED" });
  });

  it("accepts a stable Windows lexical alias while pinning its canonical marker-directory identity", async () => {
    if (process.platform !== "win32") return;
    const targetRoot = await root();
    const canonicalRoot = await realpath(targetRoot);
    if (canonicalRoot.toLowerCase() === targetRoot.toLowerCase()) return;

    await writePacket(targetRoot);
    const gate = await createAnthropicValidationAuthorizationGate({
      root: targetRoot,
      candidateBinding: candidate,
      now: () => new Date(ISSUED),
    });
    const inputs = {
      slotId: "anthropic" as const,
      providerInstanceId: "anthropic-default" as const,
      secretRefFingerprint: secretRefFingerprint(appVaultReferenceForSlot("anthropic")),
    };
    const consumed = await gate.consume(inputs);
    expect(gate.claim(consumed)).toEqual(packet());
    const restarted = await createAnthropicValidationAuthorizationGate({
      root: targetRoot,
      candidateBinding: candidate,
      now: () => new Date(ISSUED),
    });
    expect(restarted.authorization().state).toBe("consumed");
  });

  it("treats a crash-left empty or non-file marker as consumed rather than restoring eligibility", async () => {
    for (const markerKind of ["empty-file", "directory"] as const) {
      const targetRoot = await root();
      await writePacket(targetRoot);
      const marker = join(targetRoot, "markers-v1", `${createHash("sha256").update(MARKER_NAMESPACE).digest("hex")}.attempt`);
      await mkdir(join(marker, ".."), { recursive: true });
      if (markerKind === "empty-file") await writeFile(marker, new Uint8Array(), { flag: "wx" });
      else await mkdir(marker);
      const gate = await createAnthropicValidationAuthorizationGate({ root: targetRoot, candidateBinding: candidate, now: () => new Date(ISSUED) });
      expect(gate.authorization().state).toBe("consumed");
    }
  });

  it("reports a proven pre-marker filesystem refusal without claiming durable consumption", async () => {
    const targetRoot = await root();
    await writePacket(targetRoot);
    const gate = await createAnthropicValidationAuthorizationGate({ root: targetRoot, candidateBinding: candidate, now: () => new Date(ISSUED) });
    expect(gate.authorization().state).toBe("available");
    await writeFile(join(targetRoot, "markers-v1"), "synthetic-precondition-block", { encoding: "utf8", flag: "wx" });
    const inputs = { slotId: "anthropic" as const, providerInstanceId: "anthropic-default" as const, secretRefFingerprint: secretRefFingerprint(appVaultReferenceForSlot("anthropic")) };
    await expect(gate.consume(inputs)).rejects.toMatchObject({ code: "AUTHORIZATION_UNAVAILABLE" });
    expect(gate.authorization().state).toBe("unavailable");
    const restarted = await createAnthropicValidationAuthorizationGate({ root: targetRoot, candidateBinding: candidate, now: () => new Date(ISSUED) });
    expect(restarted.authorization().state).toBe("invalid");
  });

  it("enforces issuance, expiry, and maximum lifetime boundaries", async () => {
    const cases = [
      { now: "2026-08-23T11:59:59.999Z", state: "invalid" },
      { now: ISSUED, state: "available" },
      { now: "2026-08-23T12:59:59.999Z", state: "available" },
      { now: EXPIRES, state: "expired" },
    ] as const;
    for (const testCase of cases) {
      const targetRoot = await root();
      await writePacket(targetRoot);
      const gate = await createAnthropicValidationAuthorizationGate({ root: targetRoot, candidateBinding: candidate, now: () => new Date(testCase.now) });
      expect(gate.authorization().state).toBe(testCase.state);
    }
    const targetRoot = await root();
    const tooLongPacket: any = structuredClone(packet());
    tooLongPacket.expiresAt = "2026-08-24T12:00:00.001Z";
    await writePacket(targetRoot, canonical(tooLongPacket));
    const tooLong = await createAnthropicValidationAuthorizationGate({ root: targetRoot, candidateBinding: candidate, now: () => new Date(ISSUED) });
    expect(tooLong.authorization().state).toBe("invalid");
  });

  it("rejects every material binding mutation independently", async () => {
    const mutations: Array<(value: any) => void> = [
      (value) => { value.candidate.head = "a".repeat(40); },
      (value) => { value.candidate.tree = "b".repeat(40); },
      (value) => { value.candidate.manifestAggregate = "c".repeat(64); },
      (value) => { value.provider.slotId = "openai"; },
      (value) => { value.provider.secretRef.entryName = "openai"; },
      (value) => { value.request.endpoint = "https://example.invalid/v1/messages"; },
      (value) => { value.request.apiVersion = "future"; },
      (value) => { value.request.model = "substituted"; },
      (value) => { value.request.requestSha256 = "0".repeat(64); },
      (value) => { value.request.maximumOutputTokens = 5; },
      (value) => { value.request.maximumResponseBytes = 65_537; },
      (value) => { value.request.effectTimeoutMs = 15_001; },
      (value) => { value.request.callbackDrainMs = 5_001; },
      (value) => { value.request.transport = "deterministic-fake"; },
      (value) => { value.request.retentionMode = "contracted-zero"; },
      (value) => { value.attemptLimit = 2; },
      (value) => { value.retryPolicy = "once"; },
      (value) => { value.expectedResult.successTransport = "deterministic-fake"; },
    ];
    for (const mutate of mutations) {
      const targetRoot = await root();
      const changed: any = structuredClone(packet());
      mutate(changed);
      await writePacket(targetRoot, canonical(changed));
      const gate = await createAnthropicValidationAuthorizationGate({ root: targetRoot, candidateBinding: candidate, now: () => new Date(ISSUED) });
      expect(gate.authorization().state).toBe("invalid");
    }
  });

  it("rejects malformed, noncanonical, duplicate, oversized, accessor, proxy, and prototype-polluted inputs", async () => {
    for (const raw of [
      "{not-json}\n",
      `${JSON.stringify(packet(), null, 2)}\n`,
      serializeAnthropicValidationAuthorizationPacket(packet()).replace('{"attemptLimit":1', '{"attemptLimit":1,"attemptLimit":1'),
      `${" ".repeat(32_769)}\n`,
    ]) {
      const targetRoot = await root();
      await writePacket(targetRoot, raw);
      const gate = await createAnthropicValidationAuthorizationGate({ root: targetRoot, candidateBinding: candidate, now: () => new Date(ISSUED) });
      expect(gate.authorization().state).toBe("invalid");
    }
    expect(() => parseStage18eICandidateBinding(new Proxy(candidate, {}))).toThrow();
    expect(() => parseStage18eICandidateBinding(Object.assign(Object.create({ polluted: true }), candidate))).toThrow();
    const accessor = { ...candidate } as any;
    Object.defineProperty(accessor, "head", { get() { throw new Error("must-not-run"); }, enumerable: true });
    expect(() => parseStage18eICandidateBinding(accessor)).toThrow();
  });

  it("fixes the authorization root beneath the supplied appData identity", () => {
    const appData = join(tmpdir(), "synthetic-app-data-only");
    expect(anthropicValidationAuthorizationRoot(appData, "AI Development OS")).toBe(join(appData, "AI Development OS", "credential-setup", "anthropic-validation"));
    expect(() => anthropicValidationAuthorizationRoot(appData, "..")).toThrow();
  });
});
