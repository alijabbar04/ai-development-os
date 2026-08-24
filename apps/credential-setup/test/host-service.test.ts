import { setImmediate as waitImmediate, setTimeout as waitTimeout } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { CredentialMutationResult, CredentialSlotView, CredentialSlotsResult, CredentialValidatedResult } from "@ai-dev-os/credential-ui";
import type { PolicyRequest } from "@ai-dev-os/policy";
import { SecretBrokerError, type SecretAccessContext, type SecretMaterial, type SecretRef } from "@ai-dev-os/secrets";
import { CREDENTIAL_RESOLVER_BINDING_KEYS, CredentialHostService } from "../src/main/host-service.js";
import { parseCredentialMetadata, type CredentialMetadataSnapshot } from "../src/main/metadata-store.js";
import { CredentialEntrySession } from "../src/main/session-machine.js";
import { createDeterministicCredentialValidationPort, type CredentialValidationPort } from "../src/main/validation.js";
import { createTestCredentialHost, TEST_SUCCESS_RECEIPT_CANDIDATE_BINDING } from "../src/testing/test-host.js";
import { createMemoryAnthropicValidationSuccessReceiptStore, type AnthropicValidationSuccessReceiptStore } from "../src/main/anthropic-validation-receipt-store.js";
import type { AnthropicValidationSuccessReceipt } from "../src/main/anthropic-validation-receipt.js";

const SYNTHETIC = "SYNTHETIC_CREDENTIAL_VALUE_FOR_BOUNDED_TESTS";
const base = Object.freeze({ schemaVersion: 1 as const, requestId: "1".repeat(32), sessionToken: "2".repeat(64) });
const existingRotation = Object.freeze({ entryMode: "rotate" as const, nickname: null, ownership: null, authorizedBy: null });

function syntheticSuccessReceipt(
  changes: Partial<AnthropicValidationSuccessReceipt> = {},
): AnthropicValidationSuccessReceipt {
  return Object.freeze({
    schemaVersion: 1,
    receiptVersion: "ai-dev-os.stage-18e-i.anthropic-success-receipt.v1",
    digestConvention: "sha256-canonical-json-with-trailing-lf.v1",
    operationVersion: "ai-dev-os.stage-18e-i.anthropic-validation.v1",
    operationId: `credential-validate.${"1".repeat(32)}`,
    slotId: "anthropic",
    providerInstanceId: "anthropic-default",
    candidateHead: TEST_SUCCESS_RECEIPT_CANDIDATE_BINDING.head,
    candidateTree: TEST_SUCCESS_RECEIPT_CANDIDATE_BINDING.tree,
    candidateManifestAggregate: TEST_SUCCESS_RECEIPT_CANDIDATE_BINDING.manifestAggregate,
    authorizationPacketSha256: "a".repeat(64),
    authorizationReference: "synthetic-host-receipt",
    markerNamespaceSha256: "3".repeat(64),
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
    durationMs: 100,
    inputTokens: 10,
    outputTokens: 1,
    modelSubstitutionRejected: true,
    fixedRequestBody: true,
    repositorySourcePresent: false,
    credentialRetained: false,
    responseBodyRetained: false,
    policyDecisionFingerprint: "4".repeat(64),
    dispatchCount: 1,
    startedAt: "2026-08-20T10:00:00.000Z",
    completedAt: "2026-08-20T10:00:00.100Z",
    terminalState: "validated-success",
    ...changes,
  });
}

async function slots(service: CredentialHostService, requestId = "1".repeat(32)): Promise<CredentialSlotsResult> {
  const result = await service.describe({ ...base, requestId, operation: "describe" });
  if (!result.ok || result.kind !== "slots") throw new Error("expected-slots");
  return result;
}

async function save(service: CredentialHostService, clearClipboard = true): Promise<CredentialMutationResult> {
  await slots(service);
  const result = await service.save({ ...base, operation: "save", slotId: "anthropic", secret: SYNTHETIC, nickname: "Synthetic", ownership: "owned", authorizedBy: "", clearClipboard });
  if (!result.ok || result.kind !== "saved") throw new Error(`expected-save:${JSON.stringify(result)}`);
  return result;
}

function identity(result: CredentialSlotsResult, slotId: CredentialSlotView["slotId"] = "anthropic") {
  const slot = result.slots.find((item) => item.slotId === slotId)!;
  if (slot.credentialId === null || slot.revision === null || slot.recordToken === null) throw new Error("missing-identity");
  return { slotId: slot.slotId, credentialId: slot.credentialId, recordRevision: slot.revision, recordToken: slot.recordToken };
}

describe("exact vault composition", () => {
  it("describes four authoritative slots and production-disabled truthful defaults", async () => {
    const control = createTestCredentialHost();
    const service = control.createService({ validationEnabled: false });
    const result = await slots(service);
    expect(result.slots.map((item) => item.slotId)).toEqual(["anthropic", "openai", "gemini", "openrouter"]);
    expect(result.slots.every((item) => item.state === "absent" && item.credentialId === null)).toBe(true);
    expect(result).toMatchObject({ vaultState: "absent", revision: null, validationEnabled: false, productionDisabled: true, metadataAvailable: true });
    expect(result.slots.every((item) => item.developer.referenceFingerprint.length === 64 && item.developer.containerBinding.length === 64)).toBe(true);
    await service.close();
  });

  it("exposes only the narrow policy-aware resolver boundary", () => {
    const control = createTestCredentialHost();
    const binding = control.resolvers.anthropic;
    expect(Reflect.ownKeys(binding).sort()).toEqual([...CREDENTIAL_RESOLVER_BINDING_KEYS].sort());
    expect("broker" in binding).toBe(false);
    expect("resolver" in binding).toBe(false);
    expect("withSecret" in binding).toBe(false);
    expect(Object.values(binding).some((value) => typeof value === "object" && value !== null && "withSecret" in value)).toBe(false);
  });

  it("projects secure-storage unavailability before soliciting any credential action", async () => {
    const control = createTestCredentialHost();
    const service = control.createService({ encryptionAvailable: false });
    const result = await slots(service);
    expect(result).toMatchObject({
      vaultState: "encryption-unavailable",
      recovery: { issueCode: "ENCRYPTION_UNAVAILABLE", primaryDigest: null, backupDigest: null, actions: [] },
    });
    expect(result.slots.every((slot) => slot.state === "absent")).toBe(true);
    await service.close();
  });

  it("saves once without validation, clears only after commit, returns no fragment, and rejects replay", async () => {
    const control = createTestCredentialHost();
    const validation = createDeterministicCredentialValidationPort();
    const service = control.createService({ validation });
    const result = await save(service);
    expect(result.slot).toMatchObject({ state: "present", nickname: "Synthetic", validation: null });
    expect(result.clipboard).toEqual({ requested: true, outcome: "cleared" });
    expect(control.clipboard.clears).toBe(1);
    expect(validation.dispatches()).toBe(0);
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC);
    expect(JSON.stringify(control.metadata.snapshot())).not.toContain(SYNTHETIC);
    expect(JSON.stringify(control.audit)).not.toContain(SYNTHETIC);
    expect(new TextDecoder().decode(control.storage.snapshot().primary!)).not.toContain(SYNTHETIC);
    const replay = await service.save({ ...base, requestId: "3".repeat(32), operation: "save", slotId: "openai", secret: "SYNTHETIC_SECOND_VALUE", nickname: "Second", ownership: "owned", authorizedBy: "", clearClipboard: false });
    expect(replay).toMatchObject({ ok: false, code: "REPLAYED" });
    await service.close();
  });

  it("refuses renderer-bypassed secret metadata before staging and leaves no plaintext deputy trace", async () => {
    const cases = [
      { secret: "abc", nickname: "Label abc", ownership: "owned" as const, authorizedBy: "" },
      { secret: "SYNTHETIC_FRAGMENT_1234", nickname: "1234", ownership: "owned" as const, authorizedBy: "" },
      { secret: "SYNTHETIC_SAMPLE_ALPHA", nickname: "SYNTHETIC_SAMPLE_ALPHA", ownership: "owned" as const, authorizedBy: "" },
      { secret: "NEUTRAL_SAMPLE_ALPHA", nickname: "Label NEUTRAL_SAMPLE_ALPHA", ownership: "owned" as const, authorizedBy: "" },
      { secret: "SYNTHETIC_CREDENTIAL_VALUE", nickname: "SYNTHETIC_CREDENTIAL_", ownership: "authorized" as const, authorizedBy: "VALUE" },
    ] as const;
    for (const candidate of cases) {
      const control = createTestCredentialHost();
      const service = control.createService();
      await slots(service);
      const result = await service.save({ ...base, operation: "save", slotId: "anthropic", ...candidate, clearClipboard: false });
      expect(result).toMatchObject({ ok: false, code: "SCHEMA_REJECTED" });
      expect(await control.manager.describeSnapshot()).toMatchObject({ vaultState: "absent", revision: null });
      const observable = JSON.stringify({ result, metadata: control.metadata.snapshot(), audit: control.audit, storage: control.storage.snapshot() });
      expect(observable).not.toContain(candidate.secret);
      expect(control.metadata.snapshot().activity).toEqual([]);
      await service.close();
    }
  });

  it("refuses rotation into persisted metadata labels without changing vault or sidecar", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const service = control.createService();
    const current = await slots(service);
    const beforeVault = await control.manager.describeSnapshot();
    const beforeMetadata = control.metadata.snapshot();
    const beforeAuditLength = control.audit.length;
    const result = await service.rotate({ ...base, requestId: "4".repeat(32), operation: "rotate", ...identity(current), secret: "Synthetic", clearClipboard: false, ...existingRotation });
    expect(result).toMatchObject({ ok: false, code: "SCHEMA_REJECTED" });
    expect(await control.manager.describeSnapshot()).toEqual(beforeVault);
    expect(control.metadata.snapshot()).toEqual(beforeMetadata);
    expect(control.audit).toHaveLength(beforeAuditLength);
    expect(JSON.stringify({ result, metadata: control.metadata.snapshot(), audit: control.audit })).not.toContain('"secret":"Synthetic"');
    await service.close();
  });

  it("refuses rotation when a persisted label contains the whole replacement secret", async () => {
    for (const candidate of [
      { secret: "abc", nickname: "Label abc" },
      { secret: "SYNTHETIC_ROTATION_1234", nickname: "1234" },
      { secret: "NEUTRAL_ROTATION_1234", nickname: "Label NEUTRAL_ROTATION_1234" },
    ]) {
      const control = createTestCredentialHost();
      const entry = control.createService();
      await slots(entry);
      expect(await entry.save({ ...base, operation: "save", slotId: "anthropic", secret: "SYNTHETIC_INITIAL_VALUE", nickname: candidate.nickname, ownership: "owned", authorizedBy: "", clearClipboard: false })).toMatchObject({ ok: true, kind: "saved" });
      const service = control.createService();
      const current = await slots(service, "4".repeat(32));
      const beforeVault = await control.manager.describeSnapshot();
      const beforeMetadata = control.metadata.snapshot();
      const beforeAuditLength = control.audit.length;
      const result = await service.rotate({ ...base, requestId: "5".repeat(32), operation: "rotate", ...identity(current), secret: candidate.secret, clearClipboard: false, ...existingRotation });
      expect(result).toMatchObject({ ok: false, code: "SCHEMA_REJECTED" });
      expect(await control.manager.describeSnapshot()).toEqual(beforeVault);
      expect(control.metadata.snapshot()).toEqual(beforeMetadata);
      expect(control.audit).toHaveLength(beforeAuditLength);
      expect(JSON.stringify({ result, metadata: control.metadata.snapshot(), audit: control.audit })).not.toContain(`"secret":"${candidate.secret}"`);
      await service.close();
    }
  });

  it("does not let a rejected concurrent write release the active writer's M1 reservation", async () => {
    const control = createTestCredentialHost();
    const session = new CredentialEntrySession();
    const service = new CredentialHostService({ manager: control.manager, resolvers: control.resolvers, metadata: control.metadata, validation: createDeterministicCredentialValidationPort(), validationEnabled: false, clock: control.clock, clipboard: { async clear() { return true; } }, session });
    await slots(service);
    const first = service.save({ ...base, operation: "save", slotId: "anthropic", secret: SYNTHETIC, nickname: "Synthetic", ownership: "owned", authorizedBy: "", clearClipboard: false });
    const duplicate = await service.save({ ...base, requestId: "3".repeat(32), operation: "save", slotId: "openai", secret: "SYNTHETIC_DUPLICATE_WRITE", nickname: "Duplicate", ownership: "owned", authorizedBy: "", clearClipboard: false });
    expect(duplicate).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(await first).toMatchObject({ ok: true, kind: "saved" });
    expect(session.state).toBe("committed");
    await service.close();
  });

  it("builds a committed success from the manager mutation summary without a fallible post-commit vault read", async () => {
    const control = createTestCredentialHost();
    let describes = 0;
    const manager = Object.freeze({
      ...control.manager,
      async describeSnapshot() {
        describes += 1;
        if (describes > 2) throw new Error("post-commit-describe-refused");
        return await control.manager.describeSnapshot();
      },
    });
    const service = new CredentialHostService({ manager, resolvers: control.resolvers, metadata: control.metadata, validation: createDeterministicCredentialValidationPort(), validationEnabled: false, clock: control.clock, clipboard: { async clear() { return true; } } });
    await slots(service);
    const result = await service.save({ ...base, operation: "save", slotId: "anthropic", secret: SYNTHETIC, nickname: "Synthetic", ownership: "owned", authorizedBy: "", clearClipboard: false });
    expect(result).toMatchObject({ ok: true, kind: "saved", slot: { state: "present" } });
    expect(describes).toBe(2);
    await service.close();
  });

  it("reports actual clipboard outcomes and never clears when the operator opts out", async () => {
    const failedControl = createTestCredentialHost();
    const failedService = failedControl.createService({ clipboardSucceeds: false });
    expect((await save(failedService)).clipboard).toEqual({ requested: true, outcome: "failed" });
    await failedService.close();

    const untouchedControl = createTestCredentialHost();
    const untouchedService = untouchedControl.createService();
    expect((await save(untouchedService, false)).clipboard).toEqual({ requested: false, outcome: "not-requested" });
    expect(untouchedControl.clipboard.clears).toBe(0);
    await untouchedService.close();
  });

  it("persists disable/enable as nonsecret metadata and preserves the exact action set across fresh sessions", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const disableService = control.createService();
    const beforeDisable = await slots(disableService);
    const disabled = await disableService.setEnabled({ ...base, requestId: "3".repeat(32), operation: "set-enabled", ...identity(beforeDisable), enabled: false });
    expect(disabled).toMatchObject({ ok: true, kind: "disabled", slot: { enabled: false, state: "present" } });
    const enableService = control.createService();
    const beforeEnable = await slots(enableService);
    const enabled = await enableService.setEnabled({ ...base, requestId: "4".repeat(32), operation: "set-enabled", ...identity(beforeEnable), enabled: true });
    expect(enabled).toMatchObject({ ok: true, kind: "enabled", slot: { enabled: true } });
    expect(JSON.stringify(control.metadata.snapshot())).not.toContain(SYNTHETIC);
    await enableService.close();
  });

  it("preserves disabled state across rotation while recovery re-entry enables the replacement", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const disableService = control.createService();
    const beforeDisable = await slots(disableService);
    await disableService.setEnabled({ ...base, requestId: "3".repeat(32), operation: "set-enabled", ...identity(beforeDisable), enabled: false });
    const deniedService = control.createService();
    const beforeDenied = await slots(deniedService, "4".repeat(32));
    const deniedRename = await deniedService.rotate({ ...base, requestId: "5".repeat(32), operation: "rotate", ...identity(beforeDenied), secret: "SYNTHETIC_DISABLED_ROTATION_VALUE", clearClipboard: false, entryMode: "reenter", nickname: "Rename denied", ownership: "owned", authorizedBy: "" });
    expect(deniedRename).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    const rotateService = control.createService();
    const beforeRotate = await slots(rotateService, "6".repeat(32));
    const rotated = await rotateService.rotate({ ...base, requestId: "7".repeat(32), operation: "rotate", ...identity(beforeRotate), secret: "SYNTHETIC_DISABLED_ROTATION_VALUE", clearClipboard: false, ...existingRotation });
    expect(rotated).toMatchObject({ ok: true, kind: "rotated", slot: { state: "present", enabled: false } });
    expect(rotated).toMatchObject({ slot: { nickname: "Synthetic", ownership: "owned" } });
    expect(control.metadata.snapshot().activity[0]?.text).toContain("Rotated Anthropic credential");
    await rotateService.close();
  });

  it("removes ciphertext without claiming provider revocation and genuinely permits re-entry", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const removeService = control.createService();
    const beforeRemove = await slots(removeService);
    const removed = await removeService.remove({ ...base, requestId: "3".repeat(32), operation: "remove", ...identity(beforeRemove), acknowledgedRemoval: true });
    expect(removed).toMatchObject({ ok: true, kind: "removed", slot: { state: "revoked", enabled: false } });
    expect(control.metadata.snapshot().activity[0]?.text).toContain("not revoked at provider");
    const refusedService = control.createService();
    const beforeRefused = await slots(refusedService);
    const refusedRotation = await refusedService.rotate({ ...base, requestId: "4".repeat(32), operation: "rotate", ...identity(beforeRefused), secret: "SYNTHETIC_REENTRY_VALUE", clearClipboard: false, ...existingRotation });
    expect(refusedRotation).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    const reenterService = control.createService();
    const beforeReenter = await slots(reenterService, "5".repeat(32));
    const reentered = await reenterService.rotate({ ...base, requestId: "6".repeat(32), operation: "rotate", ...identity(beforeReenter), secret: "SYNTHETIC_REENTRY_VALUE", clearClipboard: false, entryMode: "reenter", nickname: "Corrected nickname", ownership: "authorized", authorizedBy: "Platform lead" });
    expect(reentered).toMatchObject({ ok: true, kind: "rotated", slot: { state: "present", enabled: true, validation: null, nickname: "Corrected nickname", ownership: "authorized", authorizedBy: "Platform lead" } });
    expect(control.metadata.snapshot().slots.anthropic).toMatchObject({ nickname: "Corrected nickname", ownership: "authorized", authorizedBy: "Platform lead" });
    expect(control.metadata.snapshot().activity[0]?.text).toContain("Re-entered Anthropic credential");
    await reenterService.close();
  });

  it("reports an unknown re-entry outcome if corrected labels cannot commit after secure storage", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const removeService = control.createService();
    const beforeRemove = await slots(removeService);
    await removeService.remove({ ...base, requestId: "3".repeat(32), operation: "remove", ...identity(beforeRemove), acknowledgedRemoval: true });
    const service = new CredentialHostService({
      manager: control.manager,
      resolvers: control.resolvers,
      metadata: {
        read: () => control.metadata.read(),
        write: (snapshot) => control.metadata.write(snapshot),
        async update() { throw new Error("synthetic-reentry-metadata-failure"); },
      },
      validation: createDeterministicCredentialValidationPort(),
      validationEnabled: false,
      clock: control.clock,
      clipboard: { async clear() { return true; } },
    });
    const beforeReentry = await slots(service, "4".repeat(32));
    const result = await service.rotate({ ...base, requestId: "5".repeat(32), operation: "rotate", ...identity(beforeReentry), secret: "SYNTHETIC_REENTRY_UNKNOWN", clearClipboard: false, entryMode: "reenter", nickname: "Requested correction", ownership: "owned", authorizedBy: "" });
    expect(result).toMatchObject({ ok: false, kind: "unknown", code: "UNKNOWN_OUTCOME" });
    expect((await control.manager.describeSnapshot()).slots[0]).toMatchObject({ state: "present" });
    expect(control.metadata.snapshot().slots.anthropic).toMatchObject({ nickname: "Synthetic", enabled: false });
    await service.close();
  });

  it("rejects stale renderer identity/revision/token and uses the current main-held revision", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const service = control.createService();
    const before = await slots(service);
    const stale = identity(before);
    const snapshot = await control.manager.describeSnapshot();
    await control.manager.create({ slotId: "openai", secret: "SYNTHETIC_UNRELATED_VALUE", expectRevision: snapshot.revision });
    const result = await service.rotate({ ...base, requestId: "3".repeat(32), operation: "rotate", ...stale, secret: "SYNTHETIC_ROTATION_VALUE", clearClipboard: false, ...existingRotation });
    expect(result).toMatchObject({ ok: false, code: "VAULT_REVISION_CONFLICT", retryable: true });
    expect(service.session.state).toBe("editing");
    await service.close();
  });
});

describe("policy-gated validation", () => {
  it("records an actual committed receipt pointer before Valid and rejects it after a changed-candidate restart", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const receiptStore = createMemoryAnthropicValidationSuccessReceiptStore();
    const reference = await receiptStore.commit(syntheticSuccessReceipt());
    const validation: CredentialValidationPort = Object.freeze({
      requiresSuccessReceipt: true as const,
      async validate() { return Object.freeze({ outcome: "valid" as const, resultCode: "VALIDATION_OK" as const, successReceiptId: reference.receiptId, successReceiptSha256: reference.receiptSha256 }); },
    });
    const service = control.createService({ validation, successReceiptStore: receiptStore });
    const current = await slots(service);
    const result = await service.validate({ ...base, operation: "validate", ...identity(current), acknowledgedDisclosure: true });
    expect(result).toMatchObject({ ok: true, kind: "validated", outcome: "valid", definitive: true, resultRecording: "recorded" });
    expect(control.metadata.snapshot().slots.anthropic?.validation).toMatchObject({ outcome: "valid", receiptState: "committed", successReceiptId: reference.receiptId, successReceiptSha256: reference.receiptSha256 });
    expect((await slots(service, "6".repeat(32))).slots[0]).toMatchObject({ validation: { outcome: "valid", receiptState: "committed" }, developer: { successReceiptState: "committed", successReceiptId: reference.receiptId, successReceiptSha256: reference.receiptSha256 } });
    const changedCandidate = control.createService({
      validationEnabled: false,
      successReceiptStore: receiptStore,
      successReceiptCandidateBinding: Object.freeze({
        ...TEST_SUCCESS_RECEIPT_CANDIDATE_BINDING,
        head: "9".repeat(40),
      }),
    });
    expect((await slots(changedCandidate, "7".repeat(32))).slots[0]).toMatchObject({ validation: { outcome: "evidence-incomplete", definitive: false, receiptState: "mismatch" }, developer: { resultCode: "EVIDENCE_RECEIPT_MISMATCH", successReceiptState: "mismatch" } });
    await changedCandidate.close();
    await service.close();
  });

  it("rejects an actual Anthropic receipt substituted into an OpenAI slot on restart", async () => {
    const control = createTestCredentialHost();
    const saver = control.createService();
    await slots(saver);
    const saved = await saver.save({ ...base, operation: "save", slotId: "openai", secret: SYNTHETIC, nickname: "Synthetic OpenAI", ownership: "owned", authorizedBy: "", clearClipboard: false });
    expect(saved).toMatchObject({ ok: true, kind: "saved", slot: { slotId: "openai" } });
    if (!saved.ok || saved.kind !== "saved" || saved.slot.revision === null || saved.slot.recordToken === null) throw new Error("expected-openai-save");
    const receiptStore = createMemoryAnthropicValidationSuccessReceiptStore();
    const reference = await receiptStore.commit(syntheticSuccessReceipt());
    const storedValidation = Object.freeze({
      outcome: "valid" as const,
      checkedAt: "2026-08-20T10:00:01.000Z",
      recordRevision: saved.slot.revision,
      recordToken: saved.slot.recordToken,
      definitive: true,
      resultCode: "VALIDATION_OK",
      policyDecisionFingerprint: "8".repeat(64),
      receiptState: "committed" as const,
      successReceiptId: reference.receiptId,
      successReceiptSha256: reference.receiptSha256,
    });
    const currentMetadata = control.metadata.snapshot();
    const openaiMetadata = currentMetadata.slots.openai;
    if (openaiMetadata === null) throw new Error("expected-openai-metadata");
    const substituted: CredentialMetadataSnapshot = Object.freeze({
      ...currentMetadata,
      slots: Object.freeze({
        ...currentMetadata.slots,
        openai: Object.freeze({
          ...openaiMetadata,
          validation: storedValidation,
          lastValidationAttempt: storedValidation,
        }),
      }),
    });
    expect(() => parseCredentialMetadata(substituted)).toThrowError(expect.objectContaining({ code: "METADATA_UNAVAILABLE" }));
    const substitutedMetadata = Object.freeze({
      async read() { return substituted; },
      async write() { throw new Error("not-writable"); },
      async update() { throw new Error("not-writable"); },
    });
    const restarted = new CredentialHostService({
      manager: control.manager,
      resolvers: control.resolvers,
      metadata: substitutedMetadata,
      validation: createDeterministicCredentialValidationPort(),
      successReceiptStore: receiptStore,
      successReceiptCandidateBinding: TEST_SUCCESS_RECEIPT_CANDIDATE_BINDING,
      validationEnabled: false,
      clock: control.clock,
      clipboard: { async clear() { return true; } },
    });
    const projected = (await slots(restarted, "8".repeat(32))).slots.find((slot) => slot.slotId === "openai");
    expect(projected).toMatchObject({ validation: { outcome: "evidence-incomplete", definitive: false, receiptState: "mismatch" }, developer: { resultCode: "EVIDENCE_RECEIPT_MISMATCH", successReceiptState: "mismatch" } });
    await restarted.close();
    await saver.close();
  });

  it("turns missing receipt evidence into a finite consumed-attempt outcome and preserves prior definitive knowledge", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const receiptStore = createMemoryAnthropicValidationSuccessReceiptStore();
    const committed = await receiptStore.commit(syntheticSuccessReceipt());
    const initialValidation: CredentialValidationPort = Object.freeze({
      requiresSuccessReceipt: true as const,
      async validate() {
        return Object.freeze({
          outcome: "valid" as const,
          resultCode: "VALIDATION_OK" as const,
          successReceiptId: committed.receiptId,
          successReceiptSha256: committed.receiptSha256,
        });
      },
    });
    const initial = control.createService({ validation: initialValidation, successReceiptStore: receiptStore });
    await initial.validate({ ...base, operation: "validate", ...identity(await slots(initial)), acknowledgedDisclosure: true });
    const incompletePort: CredentialValidationPort = Object.freeze({
      requiresSuccessReceipt: true as const,
      async validate() { return Object.freeze({ outcome: "valid" as const, resultCode: "VALIDATION_OK" as const }); },
    });
    const service = control.createService({ validation: incompletePort, successReceiptStore: receiptStore });
    const result = await service.validate({ ...base, requestId: "7".repeat(32), operation: "validate", ...identity(await slots(service, "8".repeat(32))), acknowledgedDisclosure: true });
    expect(result).toMatchObject({ outcome: "evidence-incomplete", definitive: false, providerDispatched: true, resultRecording: "prior-definitive-preserved" });
    const after = await slots(service, "9".repeat(32));
    expect(after.slots[0]?.validation).toMatchObject({ outcome: "valid", definitive: true, receiptState: "committed" });
    expect(after.slots[0]?.lastValidationAttempt).toMatchObject({ outcome: "evidence-incomplete", definitive: false, receiptState: "write-failed" });
    expect(after.slots[0]?.developer).toMatchObject({
      resultCode: "EVIDENCE_RECEIPT_UNAVAILABLE",
      successReceiptState: "write-failed",
      successReceiptId: null,
      successReceiptSha256: null,
    });
    await service.close();
  });

  it("awaits post-secret receipt settlement past the provider deadline and lets close drain it without late Valid metadata", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const backing = createMemoryAnthropicValidationSuccessReceiptStore();
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let markCommitStarted!: () => void;
    const commitStarted = new Promise<void>((resolve) => { markCommitStarted = resolve; });
    let commits = 0;
    let resolverReleased = false;
    const receiptStore: AnthropicValidationSuccessReceiptStore = Object.freeze({
      async commit(value) {
        expect(resolverReleased).toBe(true);
        markCommitStarted();
        await commitGate;
        commits += 1;
        return await backing.commit(value);
      },
      readCommitted: backing.readCommitted,
    });
    const original = control.resolvers.anthropic;
    const binding = Object.freeze({
      ...original,
      async resolve<T>(input: { readonly ref: SecretRef; readonly context: SecretAccessContext; readonly policyRequest: PolicyRequest }, callback: (secret: SecretMaterial, decisionFingerprint: string) => T | Promise<T>) {
        const resolved = await original.resolve(input, callback);
        resolverReleased = true;
        return resolved;
      },
    });
    const validation: CredentialValidationPort = Object.freeze({
      requiresSuccessReceipt: true as const,
      async validate(input) {
        await input.secret.useText((value) => {
          expect(value).toBe(SYNTHETIC);
        });
        return syntheticSuccessReceipt();
      },
      async settleAfterSecretRelease(effectResult) {
        const reference = await receiptStore.commit(effectResult);
        return Object.freeze({ outcome: "valid" as const, resultCode: "VALIDATION_OK" as const, successReceiptId: reference.receiptId, successReceiptSha256: reference.receiptSha256 });
      },
    });
    const service = new CredentialHostService({
      manager: control.manager,
      resolvers: Object.freeze({ ...control.resolvers, anthropic: binding }),
      metadata: control.metadata,
      validation,
      successReceiptStore: receiptStore,
      successReceiptCandidateBinding: TEST_SUCCESS_RECEIPT_CANDIDATE_BINDING,
      validationEnabled: true,
      validationTimeoutMs: 50,
      clock: control.clock,
      clipboard: { async clear() { return true; } },
    });
    const current = await slots(service);
    let responseSettled = false;
    const pending = service.validate({ ...base, operation: "validate", ...identity(current), acknowledgedDisclosure: true })
      .then((value) => { responseSettled = true; return value; });
    await commitStarted;
    await waitTimeout(75);
    expect(responseSettled).toBe(false);
    expect(commits).toBe(0);
    expect(control.metadata.snapshot().slots.anthropic?.validation).toBeNull();

    let closeSettled = false;
    const closing = service.close().then(() => { closeSettled = true; });
    await waitImmediate();
    expect(closeSettled).toBe(false);
    releaseCommit();
    const result = await pending;
    await closing;
    expect(result).toMatchObject({ ok: true, kind: "validated", outcome: "unreachable", definitive: false, providerDispatched: true });
    expect(commits).toBe(1);
    expect(backing.commits).toBe(1);
    expect(control.metadata.snapshot().slots.anthropic?.validation).toBeNull();
    const commitsAtResponse = commits;
    await waitTimeout(10);
    expect(commits).toBe(commitsAtResponse);
  });

  it("clears the provider deadline after the effect settles and commits Valid after receipt settlement crosses that deadline", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const backing = createMemoryAnthropicValidationSuccessReceiptStore();
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let markCommitStarted!: () => void;
    const commitStarted = new Promise<void>((resolve) => { markCommitStarted = resolve; });
    let resolverReleased = false;
    let reference: Awaited<ReturnType<AnthropicValidationSuccessReceiptStore["commit"]>> | undefined;
    const receiptStore: AnthropicValidationSuccessReceiptStore = Object.freeze({
      async commit(value) {
        expect(resolverReleased).toBe(true);
        markCommitStarted();
        await commitGate;
        reference = await backing.commit(value);
        return reference;
      },
      readCommitted: backing.readCommitted,
    });
    const original = control.resolvers.anthropic;
    const binding = Object.freeze({
      ...original,
      async resolve<T>(input: { readonly ref: SecretRef; readonly context: SecretAccessContext; readonly policyRequest: PolicyRequest }, callback: (secret: SecretMaterial, decisionFingerprint: string) => T | Promise<T>) {
        const resolved = await original.resolve(input, callback);
        resolverReleased = true;
        return resolved;
      },
    });
    const validation: CredentialValidationPort = Object.freeze({
      requiresSuccessReceipt: true as const,
      async validate(input) {
        await input.secret.useText((value) => {
          expect(value).toBe(SYNTHETIC);
        });
        return syntheticSuccessReceipt();
      },
      async settleAfterSecretRelease(effectResult) {
        const committed = await receiptStore.commit(effectResult);
        return Object.freeze({ outcome: "valid" as const, resultCode: "VALIDATION_OK" as const, successReceiptId: committed.receiptId, successReceiptSha256: committed.receiptSha256 });
      },
    });
    const service = new CredentialHostService({
      manager: control.manager,
      resolvers: Object.freeze({ ...control.resolvers, anthropic: binding }),
      metadata: control.metadata,
      validation,
      successReceiptStore: receiptStore,
      successReceiptCandidateBinding: TEST_SUCCESS_RECEIPT_CANDIDATE_BINDING,
      validationEnabled: true,
      validationTimeoutMs: 50,
      clock: control.clock,
      clipboard: { async clear() { return true; } },
    });
    const current = await slots(service);
    let responseSettled = false;
    const pending = service.validate({ ...base, requestId: "a".repeat(32), operation: "validate", ...identity(current), acknowledgedDisclosure: true })
      .then((value) => { responseSettled = true; return value; });
    await commitStarted;
    await waitTimeout(75);
    expect(responseSettled).toBe(false);
    expect(backing.commits).toBe(0);
    expect(control.metadata.snapshot().slots.anthropic?.validation).toBeNull();

    releaseCommit();
    const result = await pending;
    expect(result).toMatchObject({
      ok: true,
      kind: "validated",
      outcome: "valid",
      definitive: true,
      providerDispatched: true,
      deadlineExpired: false,
      workSettled: true,
      resultRecording: "recorded",
    });
    expect(reference).toBeDefined();
    expect(backing.commits).toBe(1);
    expect(control.metadata.snapshot().slots.anthropic?.validation).toMatchObject({
      outcome: "valid",
      definitive: true,
      receiptState: "committed",
      successReceiptId: reference?.receiptId,
      successReceiptSha256: reference?.receiptSha256,
    });
    const projected = await slots(service, "b".repeat(32));
    expect(projected.slots[0]?.developer).toMatchObject({
      successReceiptState: "committed",
      successReceiptId: reference?.receiptId,
      successReceiptSha256: reference?.receiptSha256,
    });
    await service.close();
  });

  it("refuses a receipt-requiring port when no verifier store is composed", () => {
    const control = createTestCredentialHost();
    expect(() => control.createService({ validation: Object.freeze({ requiresSuccessReceipt: true as const, async validate() { return { outcome: "valid" as const, resultCode: "VALIDATION_OK" as const }; } }) })).toThrowError(expect.objectContaining({ code: "REFUSED" }));
  });

  it("dispatches exactly once only after explicit disclosure and records a finite result", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const validation = createDeterministicCredentialValidationPort({ outcome: "valid" });
    const service = control.createService({ validation, validationEnabled: true });
    const current = await slots(service);
    const result = await service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...identity(current), acknowledgedDisclosure: true });
    expect(result).toMatchObject({ ok: true, kind: "validated", outcome: "valid", definitive: true, discarded: false });
    expect(validation.dispatches()).toBe(1);
    expect(control.policyActions).toEqual(["provider-disclosure", "secret-access"]);
    expect(control.policyTraceIds[0]).toBe(control.policyTraceIds[1]);
    expect(control.audit.filter((record) => record.operation === "resolve" && record.phase === "attempt")).toHaveLength(1);
    const operationId = control.audit.find((record) => record.operation === "resolve" && record.phase === "attempt")?.operationId;
    expect(operationId).toMatch(/^credential-validate\.[a-f0-9]{32}$/u);
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC);
    const refreshed = await slots(service, "6".repeat(32));
    expect(refreshed.slots[0]?.validation?.outcome).toBe("valid");
    await service.close();
  });

  it("binds the preceding disclosure fingerprint into a host-minted secret-access context", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const observed: SecretAccessContext[] = [];
    const original = control.resolvers.anthropic;
    const binding = Object.freeze({
      ...original,
      async resolve<T>(input: { readonly ref: SecretRef; readonly context: SecretAccessContext; readonly policyRequest: PolicyRequest }, callback: (secret: SecretMaterial, decisionFingerprint: string) => T | Promise<T>) {
        observed.push(input.context);
        return await original.resolve(input, callback);
      },
    });
    const service = new CredentialHostService({
      manager: control.manager,
      resolvers: Object.freeze({ ...control.resolvers, anthropic: binding }),
      metadata: control.metadata,
      validation: createDeterministicCredentialValidationPort({ outcome: "valid" }),
      validationEnabled: true,
      clock: control.clock,
      clipboard: { async clear() { return true; } },
    });
    const current = await slots(service);
    expect(await service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...identity(current), acknowledgedDisclosure: true })).toMatchObject({ ok: true, kind: "validated" });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ providerInstanceId: "anthropic-default", purpose: "provider-authentication", classification: "internal", locality: "cloud", projectId: null, taskId: null, approvalEvidenceRefs: [] });
    expect(observed[0]?.disclosureDecisionFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(observed[0]?.operationId).toMatch(/^credential-validate\.[a-f0-9]{32}$/u);
    expect(observed[0]?.operationId).not.toContain("5".repeat(32));
    await service.close();
  });

  it("mints a fresh host-only operation identity for each two-decision validation", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const service = control.createService({ validationEnabled: true });
    const first = await slots(service);
    expect(await service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...identity(first), acknowledgedDisclosure: true })).toMatchObject({ ok: true, kind: "validated" });
    const second = await slots(service, "6".repeat(32));
    expect(await service.validate({ ...base, requestId: "7".repeat(32), operation: "validate", ...identity(second), acknowledgedDisclosure: true })).toMatchObject({ ok: true, kind: "validated" });
    expect(control.policyActions).toEqual(["provider-disclosure", "secret-access", "provider-disclosure", "secret-access"]);
    const operationIds = control.audit.filter((record) => record.operation === "resolve" && record.phase === "attempt").map((record) => record.operationId);
    expect(operationIds).toHaveLength(2);
    expect(new Set(operationIds).size).toBe(2);
    expect(operationIds.every((value) => /^credential-validate\.[a-f0-9]{32}$/u.test(value ?? ""))).toBe(true);
    await service.close();
  });

  it("uses the authoritative vault revision in validation facts instead of the renderer claim", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    let observedRevision: number | null = null;
    const validation: CredentialValidationPort = Object.freeze({
      async validate(input) {
        observedRevision = input.recordRevision;
        return Object.freeze({ outcome: "valid", resultCode: "VALIDATION_OK" });
      },
    });
    const service = control.createService({ validation, validationEnabled: true });
    const current = await slots(service);
    const bound = identity(current);
    const forgedRevision = bound.recordRevision + 1_000;
    const result = await service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...bound, recordRevision: forgedRevision, acknowledgedDisclosure: true });
    expect(result).toMatchObject({ ok: true, kind: "validated", recordRevision: bound.recordRevision });
    expect(observedRevision).toBe(bound.recordRevision);
    expect(control.metadata.snapshot().slots.anthropic?.validation?.recordRevision).toBe(bound.recordRevision);
    await service.close();
  });

  it("refuses a denied disclosure before resolver access or validation dispatch", async () => {
    const control = createTestCredentialHost({ validationPolicyEffect: "deny" });
    await save(control.createService());
    const validation = createDeterministicCredentialValidationPort({ outcome: "valid" });
    const service = control.createService({ validation, validationEnabled: true });
    const current = await slots(service);
    const result = await service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...identity(current), acknowledgedDisclosure: true });
    expect(result).toMatchObject({ ok: false, code: "VALIDATION_POLICY_DENIED" });
    expect(control.policyActions).toEqual(["provider-disclosure"]);
    expect(control.audit.filter((record) => record.operation === "resolve" && record.phase === "attempt")).toHaveLength(0);
    expect(validation.dispatches()).toBe(0);
    expect(control.metadata.snapshot().activity[0]?.text).toBe("Validation wasn't allowed by policy for Anthropic — nothing was sent.");
    await service.close();
  });

  it("records a secret-access policy denial as no-send before validation dispatch", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const original = control.resolvers.anthropic;
    const deniedBinding = Object.freeze({
      ...original,
      async resolve() { throw new SecretBrokerError("ACCESS_DENIED", "synthetic-policy-denial"); },
    });
    const validation = createDeterministicCredentialValidationPort({ outcome: "valid" });
    const service = new CredentialHostService({
      manager: control.manager,
      resolvers: Object.freeze({ ...control.resolvers, anthropic: deniedBinding }),
      metadata: control.metadata,
      validation,
      validationEnabled: true,
      clock: control.clock,
      clipboard: { async clear() { return true; } },
    });
    const current = await slots(service);
    const result = await service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...identity(current), acknowledgedDisclosure: true });
    expect(result).toMatchObject({ ok: false, code: "VALIDATION_POLICY_DENIED" });
    expect(validation.dispatches()).toBe(0);
    expect(control.metadata.snapshot().activity[0]?.text).toBe("Validation wasn't allowed by policy for Anthropic — nothing was sent.");
    await service.close();
  });

  it("finitely refuses invalid host randomness, disclosure decisions, and pre-dispatch resolver failures", async () => {
    {
      const control = createTestCredentialHost();
      await save(control.createService());
      const service = new CredentialHostService({ manager: control.manager, resolvers: control.resolvers, metadata: control.metadata, validation: createDeterministicCredentialValidationPort(), validationEnabled: true, clock: control.clock, random: { hex() { return "invalid"; } }, clipboard: { async clear() { return true; } } });
      const current = await slots(service);
      expect(await service.validate({ ...base, operation: "validate", ...identity(current), acknowledgedDisclosure: true })).toMatchObject({ ok: false, code: "REFUSED" });
      await service.close();
    }
    {
      const control = createTestCredentialHost();
      await save(control.createService());
      const original = control.resolvers.anthropic;
      const service = new CredentialHostService({ manager: control.manager, resolvers: Object.freeze({ ...control.resolvers, anthropic: Object.freeze({ ...original, evaluatePolicy() { throw new Error("synthetic-policy-failure"); } }) }), metadata: control.metadata, validation: createDeterministicCredentialValidationPort(), validationEnabled: true, clock: control.clock, clipboard: { async clear() { return true; } } });
      const current = await slots(service);
      expect(await service.validate({ ...base, operation: "validate", ...identity(current), acknowledgedDisclosure: true })).toMatchObject({ ok: false, code: "REFUSED" });
      await service.close();
    }
    {
      const control = createTestCredentialHost();
      await save(control.createService());
      const original = control.resolvers.anthropic;
      const service = new CredentialHostService({ manager: control.manager, resolvers: Object.freeze({ ...control.resolvers, anthropic: Object.freeze({ ...original, evaluatePolicy(request) { return Object.freeze({ ...original.evaluatePolicy(request), fingerprint: "invalid" }); } }) }), metadata: control.metadata, validation: createDeterministicCredentialValidationPort(), validationEnabled: true, clock: control.clock, clipboard: { async clear() { return true; } } });
      const current = await slots(service);
      expect(await service.validate({ ...base, operation: "validate", ...identity(current), acknowledgedDisclosure: true })).toMatchObject({ ok: false, code: "REFUSED" });
      await service.close();
    }
    {
      const control = createTestCredentialHost();
      await save(control.createService());
      const original = control.resolvers.anthropic;
      const validation = createDeterministicCredentialValidationPort();
      const binding = Object.freeze({ ...original, async resolve() { throw new Error("synthetic-pre-dispatch-resolver-failure"); } });
      const service = new CredentialHostService({ manager: control.manager, resolvers: Object.freeze({ ...control.resolvers, anthropic: binding }), metadata: control.metadata, validation, validationEnabled: true, clock: control.clock, clipboard: { async clear() { return true; } } });
      const current = await slots(service);
      expect(await service.validate({ ...base, operation: "validate", ...identity(current), acknowledgedDisclosure: true })).toMatchObject({ ok: false, code: "REFUSED" });
      expect(validation.dispatches()).toBe(0);
      await service.close();
    }
  });

  it("maps decrypt failures finitely and genuinely re-enters the exact unrecoverable state", async () => {
    const control = createTestCredentialHost({ failDecrypt: true });
    await save(control.createService());
    const validation = createDeterministicCredentialValidationPort();
    const service = control.createService({ validation, validationEnabled: true });
    const current = await slots(service);
    const bound = identity(current);
    const first = await service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...bound, acknowledgedDisclosure: true });
    expect(first).toMatchObject({ ok: false, code: "DECRYPT_FAILED" });
    expect(validation.dispatches()).toBe(0);
    expect((await slots(service, "6".repeat(32))).slots[0]).toMatchObject({ state: "present", recordToken: bound.recordToken });
    const second = await service.validate({ ...base, requestId: "7".repeat(32), operation: "validate", ...bound, acknowledgedDisclosure: true });
    expect(second).toMatchObject({ ok: false, code: "DECRYPT_FAILED" });
    expect(validation.dispatches()).toBe(0);
    const refreshed = await slots(service, "8".repeat(32));
    expect(refreshed.slots[0]).toMatchObject({ state: "unrecoverable", credentialId: bound.credentialId, generation: 1 });
    expect(refreshed.slots[0]?.recordToken).not.toBe(bound.recordToken);
    const reentered = await service.rotate({ ...base, requestId: "9".repeat(32), operation: "rotate", ...identity(refreshed), secret: "SYNTHETIC_UNRECOVERABLE_REENTRY", clearClipboard: false, entryMode: "reenter", nickname: "Recovered credential", ownership: "owned", authorizedBy: "" });
    expect(reentered).toMatchObject({ ok: true, kind: "rotated", slot: { state: "present", enabled: true, nickname: "Recovered credential" } });
    expect(control.metadata.snapshot().activity[0]?.text).toContain("Re-entered Anthropic credential");
    await service.close();
  });

  it("collapses a hostile validation-port result to one finite ambiguous post-dispatch outcome", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const providerText = "PRIVATE_PROVIDER_RESPONSE_CANARY";
    let dispatches = 0;
    const service = control.createService({ validation: { async validate() { dispatches += 1; return Object.freeze({ outcome: "valid", resultCode: providerText }); } }, validationEnabled: true });
    const current = await slots(service);
    const result = await service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...identity(current), acknowledgedDisclosure: true });
    expect(result).toMatchObject({ ok: true, kind: "validated", outcome: "ambiguous", definitive: false, providerDispatched: true, applicability: "current", resultRecording: "recorded", activityRecording: "recorded", discarded: false });
    expect(dispatches).toBe(1);
    expect(JSON.stringify(result)).not.toContain(providerText);
    expect(JSON.stringify(control.metadata.snapshot())).not.toContain(providerText);
    expect(control.metadata.snapshot().slots.anthropic?.validation).toMatchObject({ outcome: "ambiguous", resultCode: "RESULT_AMBIGUOUS" });
    const projected = await slots(service, "6".repeat(32));
    expect(projected.slots[0]?.developer).toMatchObject({ resultCode: "RESULT_AMBIGUOUS" });
    expect(JSON.stringify(projected)).not.toContain(providerText);
    await service.close();
  });

  it("records dispatch only when a precise validation port reports the dispatch boundary", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    let observations = 0;
    const validation: CredentialValidationPort = Object.freeze({
      preciseDispatchObservation: true,
      async validate(input) {
        expect(input.observeProviderDispatch).toBeTypeOf("function");
        input.observeProviderDispatch?.();
        observations += 1;
        return Object.freeze({ outcome: "valid", resultCode: "VALIDATION_OK" });
      },
    });
    const service = control.createService({ validation, validationEnabled: true });
    const current = await slots(service);
    const result = await service.validate({
      ...base,
      requestId: "5".repeat(32),
      operation: "validate",
      ...identity(current),
      acknowledgedDisclosure: true,
    });
    expect(result).toMatchObject({
      ok: true,
      kind: "validated",
      outcome: "valid",
      providerDispatched: true,
      definitive: true,
    });
    expect(observations).toBe(1);
    await service.close();
  });

  it("does not invent a deadline or provider response for a settled pre-dispatch failure", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const validation: CredentialValidationPort = Object.freeze({
      preciseDispatchObservation: true,
      async validate() {
        return Object.freeze({ outcome: "unreachable", resultCode: "PROVIDER_UNREACHABLE" });
      },
    });
    const service = control.createService({ validation, validationEnabled: true });
    const current = await slots(service);
    const result = await service.validate({
      ...base,
      requestId: "e".repeat(32),
      operation: "validate",
      ...identity(current),
      acknowledgedDisclosure: true,
    });
    expect(result).toMatchObject({
      ok: true,
      kind: "validated",
      outcome: "unreachable",
      providerDispatched: false,
      deadlineExpired: false,
      workSettled: true,
    });
    const activity = control.metadata.snapshot().activity[0]?.text ?? "";
    expect(activity).toContain("Validation ended for Anthropic before provider dispatch");
    expect(activity).toContain("No provider request was sent; nothing was retried");
    expect(activity).not.toMatch(/deadline|provider response/iu);
    await service.close();
  });

  it("uses reserved finite host facts when clock and randomness become unavailable after provider dispatch", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    let providerDispatched = false;
    let randomCalls = 0;
    let clockCalls = 0;
    const random = Object.freeze({
      hex(bytes: number): string {
        if (providerDispatched) throw new Error("post-dispatch-random-failure");
        randomCalls += 1;
        return randomCalls.toString(16).padStart(bytes * 2, "0").slice(-bytes * 2);
      },
    });
    const clock = Object.freeze({
      now(): Date {
        clockCalls += 1;
        if (providerDispatched) throw new Error("post-dispatch-clock-failure");
        return new Date("2026-08-20T10:00:00.000Z");
      },
    });
    const service = new CredentialHostService({
      manager: control.manager,
      resolvers: control.resolvers,
      metadata: control.metadata,
      validation: {
        async validate() {
          providerDispatched = true;
          return Object.freeze({ outcome: "valid" as const, resultCode: "VALIDATION_OK" as const });
        },
      },
      validationEnabled: true,
      clock,
      random,
      clipboard: { async clear() { return true; } },
    });
    const current = await slots(service);
    const result = await service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...identity(current), acknowledgedDisclosure: true });
    expect(result).toMatchObject({
      ok: true,
      kind: "validated",
      outcome: "valid",
      checkedAt: "2026-08-20T10:00:00.000Z",
      providerDispatched: true,
      resultRecording: "recorded",
      activityRecording: "recorded",
    });
    expect(randomCalls).toBe(3);
    expect(clockCalls).toBeGreaterThanOrEqual(2);
    expect(control.metadata.snapshot().activity[0]).toMatchObject({ at: "2026-08-20T10:00:00.000Z", tone: "ok" });
    await service.close();
  });

  it("keeps validation relevant across an unrelated slot revision", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const openaiEntry = control.createService();
    await slots(openaiEntry);
    expect(await openaiEntry.save({ ...base, requestId: "4".repeat(32), operation: "save", slotId: "openai", secret: "SYNTHETIC_OTHER_SLOT_VALUE", nickname: "Other synthetic", ownership: "owned", authorizedBy: "", clearClipboard: false })).toMatchObject({ ok: true, kind: "saved" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const validation = createDeterministicCredentialValidationPort({ outcome: "valid", gate });
    const service = control.createService({ validation, validationEnabled: true });
    const current = await slots(service);
    const pending = service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...identity(current, "anthropic"), acknowledgedDisclosure: true });
    while (validation.dispatches() === 0) await waitImmediate();
    const vault = await control.manager.describeSnapshot();
    await control.manager.rotate({ slotId: "openai", secret: "SYNTHETIC_UNRELATED_ROTATION", expectRevision: vault.revision! });
    release();
    expect(await pending).toMatchObject({ ok: true, kind: "validated", outcome: "valid", discarded: false });
    const after = await slots(service, "6".repeat(32));
    expect(after.slots.find((slot) => slot.slotId === "anthropic")?.validation?.outcome).toBe("valid");
    await service.close();
  });

  it("keeps validation relevant across same-generation ciphertext maintenance", async () => {
    const control = createTestCredentialHost({ shouldReEncrypt: true });
    await save(control.createService());
    const service = control.createService({ validationEnabled: true });
    const before = await slots(service);
    const beforeSlot = before.slots.find((slot) => slot.slotId === "anthropic")!;
    const writesBefore = control.storage.snapshot().writes;
    expect(await service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...identity(before), acknowledgedDisclosure: true })).toMatchObject({ ok: true, kind: "validated", outcome: "valid", discarded: false });
    while (control.storage.snapshot().writes === writesBefore) await waitImmediate();
    const after = await slots(service, "6".repeat(32));
    const afterSlot = after.slots.find((slot) => slot.slotId === "anthropic")!;
    expect(after.revision).toBeGreaterThan(before.revision!);
    expect(afterSlot.generation).toBe(beforeSlot.generation);
    expect(afterSlot.recordToken).toBe(beforeSlot.recordToken);
    expect(afterSlot.validation?.outcome).toBe("valid");
    await service.close();
  });

  it("reserves validation before its first await and only its owner can release the guard", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const validation = createDeterministicCredentialValidationPort({ outcome: "valid", gate });
    const service = control.createService({ validation, validationEnabled: true });
    const current = await slots(service);
    const bound = identity(current);
    const pending = service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...bound, acknowledgedDisclosure: true });
    const duplicate = await service.validate({ ...base, requestId: "6".repeat(32), operation: "validate", ...bound, acknowledgedDisclosure: true });
    expect(duplicate).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    const stillBlocked = await service.validate({ ...base, requestId: "7".repeat(32), operation: "validate", ...bound, acknowledgedDisclosure: true });
    expect(stillBlocked).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    while (validation.dispatches() === 0) await waitImmediate();
    expect(validation.dispatches()).toBe(1);
    release();
    expect(await pending).toMatchObject({ ok: true, kind: "validated", outcome: "valid", discarded: false });
    expect(validation.dispatches()).toBe(1);
    await service.close();
  });

  it("maps a single transport failure and a bounded timeout to one inconclusive attempt", async () => {
    const rejectedControl = createTestCredentialHost();
    await save(rejectedControl.createService());
    const rejected = rejectedControl.createService({ validation: { async validate() { throw new Error("PRIVATE_TRANSPORT_CANARY"); } } });
    const rejectedCurrent = await slots(rejected);
    const rejectedResult = await rejected.validate({ ...base, operation: "validate", ...identity(rejectedCurrent), acknowledgedDisclosure: true });
    expect(rejectedResult).toMatchObject({ ok: true, kind: "validated", outcome: "unreachable", definitive: false, discarded: false });
    expect(JSON.stringify(rejectedResult)).not.toContain("PRIVATE_TRANSPORT_CANARY");
    await rejected.close();

    const timeoutControl = createTestCredentialHost();
    await save(timeoutControl.createService());
    let releaseTransport!: () => void;
    const transportGate = new Promise<void>((resolve) => { releaseTransport = resolve; });
    const transport = createDeterministicCredentialValidationPort({ gate: transportGate });
    const timed = timeoutControl.createService({ validation: transport, validationTimeoutMs: 5 });
    const timedCurrent = await slots(timed);
    vi.useFakeTimers();
    let timedResult: CredentialValidatedResult;
    try {
      const pendingTimeout = timed.validate({ ...base, operation: "validate", ...identity(timedCurrent), acknowledgedDisclosure: true });
      await vi.advanceTimersByTimeAsync(5);
      timedResult = await pendingTimeout as CredentialValidatedResult;
    } finally {
      vi.useRealTimers();
    }
    expect(timedResult).toMatchObject({ ok: true, kind: "validated", outcome: "unreachable", definitive: false, providerDispatched: true, discarded: false });
    expect(transport.dispatches()).toBe(1);
    expect(await timed.validate({ ...base, requestId: "8".repeat(32), operation: "validate", ...identity(timedCurrent), acknowledgedDisclosure: true })).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    let closeSettled = false;
    const closing = timed.close().then(() => { closeSettled = true; });
    await waitTimeout(10);
    expect(closeSettled).toBe(false);
    expect(transport.dispatches()).toBe(1);
    releaseTransport();
    await closing;
    expect(closeSettled).toBe(true);
    expect(transport.dispatches()).toBe(1);
  });

  it("never begins post-secret receipt settlement when the provider effect loses the deadline", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const receiptStore = createMemoryAnthropicValidationSuccessReceiptStore();
    let releaseEffect!: () => void;
    const effectGate = new Promise<void>((resolve) => { releaseEffect = resolve; });
    let markEffectStarted!: () => void;
    const effectStarted = new Promise<void>((resolve) => { markEffectStarted = resolve; });
    let markEffectFinished!: () => void;
    const effectFinished = new Promise<void>((resolve) => { markEffectFinished = resolve; });
    let settlements = 0;
    const validation: CredentialValidationPort = Object.freeze({
      requiresSuccessReceipt: true as const,
      async validate(input) {
        markEffectStarted();
        await effectGate;
        await input.secret.useText((value) => {
          expect(value).toBe(SYNTHETIC);
        });
        markEffectFinished();
        return syntheticSuccessReceipt();
      },
      async settleAfterSecretRelease() {
        settlements += 1;
        throw new Error("receipt settlement must not start for a deadline loser");
      },
    });
    const service = new CredentialHostService({
      manager: control.manager,
      resolvers: control.resolvers,
      metadata: control.metadata,
      validation,
      successReceiptStore: receiptStore,
      successReceiptCandidateBinding: TEST_SUCCESS_RECEIPT_CANDIDATE_BINDING,
      validationEnabled: true,
      validationTimeoutMs: 5,
      clock: control.clock,
      clipboard: { async clear() { return true; } },
    });
    const current = await slots(service);
    vi.useFakeTimers();
    let result: CredentialValidatedResult;
    try {
      const pending = service.validate({ ...base, requestId: "c".repeat(32), operation: "validate", ...identity(current), acknowledgedDisclosure: true });
      await effectStarted;
      await vi.advanceTimersByTimeAsync(5);
      result = await pending as CredentialValidatedResult;
    } finally {
      vi.useRealTimers();
    }
    expect(result).toMatchObject({
      ok: true,
      kind: "validated",
      outcome: "unreachable",
      definitive: false,
      providerDispatched: true,
      deadlineExpired: true,
      workSettled: false,
    });
    expect(settlements).toBe(0);
    expect(receiptStore.commits).toBe(0);

    releaseEffect();
    await effectFinished;
    await waitImmediate();
    expect(settlements).toBe(0);
    expect(receiptStore.commits).toBe(0);
    expect(control.metadata.snapshot().slots.anthropic?.validation).toMatchObject({ outcome: "unreachable", definitive: false });
    await service.close();
  });

  it("uses one absolute deadline across delayed secret resolution and never dispatches after expiry", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    let startedNow!: () => void;
    let releaseNow!: () => void;
    const started = new Promise<void>((resolve) => { startedNow = resolve; });
    const gate = new Promise<void>((resolve) => { releaseNow = resolve; });
    const original = control.resolvers.anthropic;
    let callbackInvocations = 0;
    let observedAborted = false;
    const binding = Object.freeze({
      ...original,
      async resolve<T>(input: { readonly ref: SecretRef; readonly context: SecretAccessContext; readonly policyRequest: PolicyRequest }, callback: (secret: SecretMaterial, decisionFingerprint: string) => T | Promise<T>) {
        startedNow();
        await gate;
        observedAborted = input.context.signal?.aborted === true;
        return await original.resolve(input, async (secret, decisionFingerprint) => {
          callbackInvocations += 1;
          return await callback(secret, decisionFingerprint);
        });
      },
    });
    const validation = createDeterministicCredentialValidationPort({ outcome: "valid" });
    const service = new CredentialHostService({
      manager: control.manager,
      resolvers: Object.freeze({ ...control.resolvers, anthropic: binding }),
      metadata: control.metadata,
      validation,
      validationEnabled: true,
      validationTimeoutMs: 5,
      clock: control.clock,
      clipboard: { async clear() { return true; } },
    });
    const current = await slots(service);
    const pending = service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...identity(current), acknowledgedDisclosure: true });
    await started;
    expect(await pending).toMatchObject({ ok: true, kind: "validated", outcome: "unreachable", definitive: false, providerDispatched: false, deadlineExpired: true, workSettled: false, discarded: false });
    expect(callbackInvocations).toBe(0);
    expect(validation.dispatches()).toBe(0);
    expect(control.metadata.snapshot().activity[0]?.text).toContain("while credential access was closing");
    expect(control.metadata.snapshot().activity[0]?.text).toContain("No provider request was sent");
    let closeSettled = false;
    const closing = service.close().then(() => { closeSettled = true; });
    await waitTimeout(10);
    expect(closeSettled).toBe(false);
    releaseNow();
    await closing;
    expect(closeSettled).toBe(true);
    expect(observedAborted).toBe(true);
    expect(callbackInvocations).toBe(0);
    expect(validation.dispatches()).toBe(0);
  });

  it("rechecks the absolute deadline immediately before dispatch and after a resolver settlement", async () => {
    {
      const control = createTestCredentialHost();
      await save(control.createService());
      let wallNow = 1_000;
      const now = vi.spyOn(Date, "now").mockImplementation(() => wallNow);
      let dispatches = 0;
      const original = control.resolvers.anthropic;
      const binding = Object.freeze({
        ...original,
        async resolve<T>(input: { readonly ref: SecretRef; readonly context: SecretAccessContext; readonly policyRequest: PolicyRequest }, callback: (secret: SecretMaterial, decisionFingerprint: string) => T | Promise<T>) {
          return await original.resolve(input, async (secret, decisionFingerprint) => {
            const pending = callback(secret, decisionFingerprint);
            wallNow = 11_000;
            return await pending;
          });
        },
      });
      const service = new CredentialHostService({
        manager: control.manager,
        resolvers: Object.freeze({ ...control.resolvers, anthropic: binding }),
        metadata: control.metadata,
        validation: { async validate() { dispatches += 1; return Object.freeze({ outcome: "valid" as const, resultCode: "VALIDATION_OK" as const }); } },
        validationEnabled: true,
        validationTimeoutMs: 10_000,
        clock: control.clock,
        clipboard: { async clear() { return true; } },
      });
      try {
        const current = await slots(service);
        const result = await service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...identity(current), acknowledgedDisclosure: true });
        expect(result).toMatchObject({ ok: true, kind: "validated", outcome: "unreachable", providerDispatched: false, deadlineExpired: true, workSettled: true });
        expect(dispatches).toBe(0);
        expect(control.metadata.snapshot().activity[0]?.text).toContain("before provider dispatch");
      } finally {
        now.mockRestore();
        await service.close();
      }
    }

    {
      const control = createTestCredentialHost();
      await save(control.createService());
      let wallNow = 1_000;
      const now = vi.spyOn(Date, "now").mockImplementation(() => wallNow);
      let dispatches = 0;
      const service = control.createService({
        validation: {
          async validate() {
            dispatches += 1;
            wallNow = 11_000;
            return Object.freeze({ outcome: "valid" as const, resultCode: "VALIDATION_OK" as const });
          },
        },
        validationEnabled: true,
        validationTimeoutMs: 10_000,
      });
      try {
        const current = await slots(service);
        const result = await service.validate({ ...base, requestId: "6".repeat(32), operation: "validate", ...identity(current), acknowledgedDisclosure: true });
        expect(result).toMatchObject({ ok: true, kind: "validated", outcome: "unreachable", providerDispatched: true, deadlineExpired: true, workSettled: true });
        expect(dispatches).toBe(1);
        expect(control.metadata.snapshot().activity[0]?.text).toContain("settled beyond the absolute limit");
        expect(control.metadata.snapshot().slots.anthropic?.validation).toMatchObject({ outcome: "unreachable", resultCode: "PROVIDER_UNREACHABLE" });
      } finally {
        now.mockRestore();
        await service.close();
      }
    }
  });

  it("reports one dispatched result with unconfirmed local recording when the atomic metadata commit fails", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const receiptId = "c".repeat(64);
    const receiptSha256 = "d".repeat(64);
    let dispatches = 0;
    let projections = 0;
    const validation: CredentialValidationPort = Object.freeze({
      requiresSuccessReceipt: true as const,
      async validate() { dispatches += 1; return Object.freeze({ outcome: "valid" as const, resultCode: "VALIDATION_OK" as const, successReceiptId: receiptId, successReceiptSha256: receiptSha256 }); },
    });
    const successReceiptStore: AnthropicValidationSuccessReceiptStore = Object.freeze({
      async commit() { throw new Error("already-committed-by-validation-port"); },
      async readCommitted() { projections += 1; return Object.freeze({ receipt: syntheticSuccessReceipt({ authorizationPacketSha256: receiptId }), reference: Object.freeze({ receiptId, receiptSha256 }), canonicalDocument: "{}\n" }); },
    });
    const service = new CredentialHostService({
      manager: control.manager,
      resolvers: control.resolvers,
      metadata: { read: () => control.metadata.read(), async write() { throw new Error("metadata-failure"); }, async update() { throw new Error("metadata-failure"); } },
      validation,
      successReceiptStore,
      validationEnabled: true,
      clock: control.clock,
      clipboard: { async clear() { return true; } },
    });
    const current = await slots(service);
    const result = await service.validate({ ...base, operation: "validate", ...identity(current), acknowledgedDisclosure: true });
    expect(result).toMatchObject({ ok: true, kind: "validated", outcome: "valid", providerDispatched: true, applicability: "current", resultRecording: "unknown", activityRecording: "unknown", discarded: false });
    expect(dispatches).toBe(1);
    expect(control.metadata.snapshot().slots.anthropic?.validation).toBeNull();
    await successReceiptStore.readCommitted(receiptId, { receiptSha256 });
    expect(projections).toBe(1);
    await service.close();
  });

  it("returns the known provider result when its post-result vault observation fails", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    let describes = 0;
    const manager = Object.freeze({
      ...control.manager,
      async describeSnapshot() {
        describes += 1;
        if (describes === 4) throw new Error("post-result-describe-failure");
        return await control.manager.describeSnapshot();
      },
    });
    const validation = createDeterministicCredentialValidationPort({ outcome: "valid" });
    const service = new CredentialHostService({ manager, resolvers: control.resolvers, metadata: control.metadata, validation, validationEnabled: true, clock: control.clock, clipboard: { async clear() { return true; } } });
    const current = await slots(service);
    const result = await service.validate({ ...base, operation: "validate", ...identity(current), acknowledgedDisclosure: true });
    expect(result).toMatchObject({ ok: true, kind: "validated", outcome: "valid", providerDispatched: true, applicability: "unknown", resultRecording: "recorded", activityRecording: "recorded", discarded: false });
    expect(validation.dispatches()).toBe(1);
    expect(control.metadata.snapshot().slots.anthropic?.validation?.outcome).toBe("valid");
    expect(control.metadata.snapshot().activity[0]?.text).toContain("current-version attribution is unconfirmed");
    await service.close();
  });

  it("returns the known provider result when only its Activity write fails", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    let updates = 0;
    const validation = createDeterministicCredentialValidationPort({ outcome: "valid" });
    const service = new CredentialHostService({
      manager: control.manager,
      resolvers: control.resolvers,
      metadata: {
        read: () => control.metadata.read(),
        write: (snapshot) => control.metadata.write(snapshot),
        async update(transform) {
          updates += 1;
          if (updates === 2) throw new Error("activity-write-failure");
          return await control.metadata.update(transform);
        },
      },
      validation,
      validationEnabled: true,
      clock: control.clock,
      clipboard: { async clear() { return true; } },
    });
    const current = await slots(service);
    const result = await service.validate({ ...base, operation: "validate", ...identity(current), acknowledgedDisclosure: true });
    expect(result).toMatchObject({ ok: true, kind: "validated", outcome: "valid", providerDispatched: true, applicability: "current", resultRecording: "recorded", activityRecording: "unknown", discarded: false });
    expect(validation.dispatches()).toBe(1);
    expect(control.metadata.snapshot().slots.anthropic?.validation?.outcome).toBe("valid");
    expect(control.metadata.snapshot().activity.some((item) => item.text.includes("Validation finished"))).toBe(false);
    await service.close();
  });

  it("keeps a completed finite result when the resolver fails after its one callback", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const original = control.resolvers.anthropic;
    const binding = Object.freeze({
      ...original,
      async resolve<T>(input: { readonly ref: SecretRef; readonly context: SecretAccessContext; readonly policyRequest: PolicyRequest }, callback: (secret: SecretMaterial, decisionFingerprint: string) => T | Promise<T>) {
        await original.resolve(input, callback);
        throw new Error("synthetic-post-callback-resolver-failure");
      },
    });
    const validation = createDeterministicCredentialValidationPort({ outcome: "valid" });
    const service = new CredentialHostService({ manager: control.manager, resolvers: Object.freeze({ ...control.resolvers, anthropic: binding }), metadata: control.metadata, validation, validationEnabled: true, clock: control.clock, clipboard: { async clear() { return true; } } });
    const current = await slots(service);
    const result = await service.validate({ ...base, operation: "validate", ...identity(current), acknowledgedDisclosure: true });
    expect(result).toMatchObject({ ok: true, kind: "validated", outcome: "valid", providerDispatched: true, resultRecording: "recorded", activityRecording: "recorded" });
    expect(validation.dispatches()).toBe(1);
    await service.close();
  });

  it("refuses disabled validation before policy resolution or transport dispatch", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const validation = createDeterministicCredentialValidationPort();
    const service = control.createService({ validation, validationEnabled: false });
    const current = await slots(service);
    const attemptsBefore = control.audit.filter((record) => record.operation === "resolve" && record.phase === "attempt").length;
    const result = await service.validate({ ...base, operation: "validate", ...identity(current), acknowledgedDisclosure: true });
    expect(result).toMatchObject({ ok: false, code: "VALIDATION_DISABLED" });
    expect(validation.dispatches()).toBe(0);
    expect(control.audit.filter((record) => record.operation === "resolve" && record.phase === "attempt")).toHaveLength(attemptsBefore);
    await service.close();
  });

  it("preserves prior definitive information when a later single attempt is inconclusive", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const validService = control.createService({ validation: createDeterministicCredentialValidationPort({ outcome: "valid" }) });
    const first = await slots(validService);
    await validService.validate({ ...base, operation: "validate", ...identity(first), acknowledgedDisclosure: true });
    const ambiguousTransport = createDeterministicCredentialValidationPort({ outcome: "ambiguous" });
    const ambiguousService = control.createService({ validation: ambiguousTransport });
    const second = await slots(ambiguousService);
    const result = await ambiguousService.validate({ ...base, requestId: "7".repeat(32), operation: "validate", ...identity(second), acknowledgedDisclosure: true }) as CredentialValidatedResult;
    expect(result).toMatchObject({ outcome: "ambiguous", definitive: false, discarded: false });
    expect(ambiguousTransport.dispatches()).toBe(1);
    const after = await slots(ambiguousService, "8".repeat(32));
    expect(after.slots[0]?.validation?.outcome).toBe("valid");
    expect(after.slots[0]?.lastValidationAttempt).toMatchObject({ outcome: "ambiguous", definitive: false });
    await ambiguousService.close();
  });

  it("blocks rotate/remove/enable while a check is in flight and discards a late result if the record changes", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const validation = createDeterministicCredentialValidationPort({ outcome: "valid", gate });
    const service = control.createService({ validation });
    const current = await slots(service);
    const bound = identity(current);
    const pending = service.validate({ ...base, operation: "validate", ...bound, acknowledgedDisclosure: true });
    while (validation.dispatches() === 0) await waitImmediate();
    const blockedRotate = await service.rotate({ ...base, requestId: "3".repeat(32), operation: "rotate", ...bound, secret: "SYNTHETIC_BLOCKED_ROTATION", clearClipboard: false, ...existingRotation });
    const blockedRemove = await service.remove({ ...base, requestId: "4".repeat(32), operation: "remove", ...bound, acknowledgedRemoval: true });
    expect(blockedRotate).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(blockedRemove).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    const snapshot = await control.manager.describeSnapshot();
    await control.manager.rotate({ slotId: "anthropic", secret: "SYNTHETIC_EXTERNAL_ROTATION", expectRevision: snapshot.revision! });
    release();
    const result = await pending;
    expect(result).toMatchObject({ ok: true, kind: "validated", discarded: true });
    const after = await slots(service, "9".repeat(32));
    expect(after.slots[0]?.validation).toBeNull();
    await service.close();
  });

  it("rechecks the record after validation metadata commits and hides stale Developer facts", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    let injected = false;
    const service = new CredentialHostService({
      manager: control.manager,
      resolvers: control.resolvers,
      metadata: {
        read: () => control.metadata.read(),
        write: (snapshot) => control.metadata.write(snapshot),
        async update(transform) {
          if (!injected) {
            injected = true;
            const snapshot = await control.manager.describeSnapshot();
            await control.manager.rotate({ slotId: "anthropic", secret: "SYNTHETIC_GAP_ROTATION", expectRevision: snapshot.revision! });
          }
          return await control.metadata.update(transform);
        },
      },
      validation: createDeterministicCredentialValidationPort({ outcome: "valid" }),
      validationEnabled: true,
      clock: control.clock,
      clipboard: { async clear() { return true; } },
    });
    const current = await slots(service);
    const prior = identity(current);
    const result = await service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...prior, acknowledgedDisclosure: true });
    expect(result).toMatchObject({ ok: true, kind: "validated", outcome: "valid", discarded: true });
    expect(control.metadata.snapshot().slots.anthropic?.validation).toBeNull();
    expect(control.metadata.snapshot().activity[0]?.text).toContain("Discarded the Anthropic validation result");
    expect(control.metadata.snapshot().activity.some((item) => item.text.includes("provider accepted"))).toBe(false);
    const projected = await slots(service, "6".repeat(32));
    expect(projected.slots[0]?.recordToken).not.toBe(prior.recordToken);
    expect(projected.slots[0]?.validation).toBeNull();
    expect(projected.slots[0]?.developer).toMatchObject({ resultCode: null, policyDecisionFingerprint: null });
    await service.close();
  });

  it("replaces a just-recorded Activity outcome when the vault changes in the final observation gap", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    let describes = 0;
    const manager = Object.freeze({
      ...control.manager,
      async describeSnapshot() {
        describes += 1;
        if (describes === 5) {
          const before = await control.manager.describeSnapshot();
          await control.manager.rotate({ slotId: "anthropic", secret: "SYNTHETIC_FINAL_GAP_ROTATION", expectRevision: before.revision! });
        }
        return await control.manager.describeSnapshot();
      },
    });
    const validation = createDeterministicCredentialValidationPort({ outcome: "valid" });
    const service = new CredentialHostService({ manager, resolvers: control.resolvers, metadata: control.metadata, validation, validationEnabled: true, clock: control.clock, clipboard: { async clear() { return true; } } });
    const current = await slots(service);
    const result = await service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...identity(current), acknowledgedDisclosure: true });
    expect(result).toMatchObject({ ok: true, kind: "validated", providerDispatched: true, applicability: "discarded", resultRecording: "not-recorded", activityRecording: "recorded", discarded: true });
    expect(validation.dispatches()).toBe(1);
    expect(control.metadata.snapshot().slots.anthropic?.validation).toBeNull();
    expect(control.metadata.snapshot().activity[0]?.text).toContain("Discarded the Anthropic validation result");
    expect(control.metadata.snapshot().activity.some((item) => item.text.includes("provider accepted"))).toBe(false);
    await service.close();
  });

  it("allows only one validation globally and releases the reservation after it finishes", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    const openaiEntry = control.createService();
    await slots(openaiEntry);
    expect(await openaiEntry.save({ ...base, requestId: "4".repeat(32), operation: "save", slotId: "openai", secret: "SYNTHETIC_OTHER_SLOT_VALUE", nickname: "Other synthetic", ownership: "owned", authorizedBy: "", clearClipboard: false })).toMatchObject({ ok: true, kind: "saved" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const validation = createDeterministicCredentialValidationPort({ outcome: "valid", gate });
    const service = control.createService({ validation, validationEnabled: true });
    const current = await slots(service);
    const anthropicValidation = service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...identity(current, "anthropic"), acknowledgedDisclosure: true });
    const refusedOpenai = await service.validate({ ...base, requestId: "6".repeat(32), operation: "validate", ...identity(current, "openai"), acknowledgedDisclosure: true });
    expect(refusedOpenai).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    while (validation.dispatches() < 1) await waitImmediate();
    release();
    expect(await anthropicValidation).toMatchObject({ ok: true, kind: "validated", outcome: "valid", discarded: false });
    const refreshed = await slots(service, "7".repeat(32));
    expect(await service.validate({ ...base, requestId: "8".repeat(32), operation: "validate", ...identity(refreshed, "openai"), acknowledgedDisclosure: true })).toMatchObject({ ok: true, kind: "validated", outcome: "valid", discarded: false });
    expect(validation.dispatches()).toBe(2);
    expect(control.metadata.snapshot().slots.anthropic?.validation?.outcome).toBe("valid");
    expect(control.metadata.snapshot().slots.openai?.validation?.outcome).toBe("valid");
    await service.close();
  });
});

describe("bounded fallback and failure projections", () => {
  it("uses an opaque fallback when presentation metadata is unavailable and exposes finite recovery state", async () => {
    const fallbackControl = createTestCredentialHost();
    const before = await fallbackControl.manager.describeSnapshot();
    await fallbackControl.manager.create({ slotId: "anthropic", secret: SYNTHETIC, expectRevision: before.revision });
    const fallback = new CredentialHostService({
      manager: fallbackControl.manager,
      resolvers: fallbackControl.resolvers,
      metadata: { async read() { throw new Error("metadata-read-failure"); }, async write() { throw new Error("metadata-write-failure"); }, async update() { throw new Error("metadata-write-failure"); } },
      validation: createDeterministicCredentialValidationPort(),
      validationEnabled: false,
      clock: fallbackControl.clock,
      clipboard: { async clear() { return true; } },
    });
    const projected = await slots(fallback);
    expect(projected.metadataAvailable).toBe(false);
    expect(projected.slots[0]).toMatchObject({ state: "present", nickname: "Anthropic credential", ownership: null, enabled: false });
    expect(projected.slots[0]?.credentialId).toMatch(/^cred-[0-9a-f]{32}$/u);
    await fallback.close();

    const corruptControl = createTestCredentialHost();
    corruptControl.storage.replacePrimary(new TextEncoder().encode("{corrupt"));
    const corrupt = corruptControl.createService();
    const recovery = await slots(corrupt);
    expect(recovery).toMatchObject({ vaultState: "corrupt", recovery: { issueCode: "VAULT_CORRUPT" } });
    expect(recovery.slots.every((slot) => slot.state === "unrecoverable" && slot.credentialId === null && slot.recordToken === null)).toBe(true);
    await corrupt.close();
  });

  it.each(["save", "rotate", "set-enabled", "remove", "validate"] as const)("refuses a corrupt vault with the exact finite code before %s", async (operation) => {
    const control = createTestCredentialHost();
    let currentIdentity: ReturnType<typeof identity> | null = null;
    if (operation !== "save") {
      await save(control.createService());
      currentIdentity = identity(await slots(control.createService()));
    }
    control.storage.replacePrimary(new TextEncoder().encode("{corrupt"));
    const service = control.createService({ validationEnabled: true });
    const requestId = "9".repeat(32);
    expect(await slots(service, "8".repeat(32))).toMatchObject({ vaultState: "corrupt", recovery: { issueCode: "VAULT_CORRUPT" } });
    const result = operation === "save"
      ? await service.save({ ...base, requestId, operation, slotId: "openai", secret: "SYNTHETIC_CORRUPT_SAVE", nickname: "Synthetic", ownership: "owned", authorizedBy: "", clearClipboard: false })
      : operation === "rotate"
        ? await service.rotate({ ...base, requestId, operation, ...currentIdentity!, secret: "SYNTHETIC_CORRUPT_ROTATE", clearClipboard: false, ...existingRotation })
        : operation === "set-enabled"
          ? await service.setEnabled({ ...base, requestId, operation, ...currentIdentity!, enabled: false })
          : operation === "remove"
            ? await service.remove({ ...base, requestId, operation, ...currentIdentity!, acknowledgedRemoval: true })
            : await service.validate({ ...base, requestId, operation, ...currentIdentity!, acknowledgedDisclosure: true });
    expect(result).toMatchObject({ ok: false, kind: "refused", code: "VAULT_CORRUPT", retryable: false });
  });

  it("uses host randomness, reports metadata/clipboard failures, and rejects unavailable enable metadata", async () => {
    const control = createTestCredentialHost();
    let metadataUpdates = 0;
    const service = new CredentialHostService({
      manager: control.manager,
      resolvers: control.resolvers,
      metadata: {
        read: () => control.metadata.read(),
        write: (snapshot) => control.metadata.write(snapshot),
        async update(transform) {
          metadataUpdates += 1;
          if (metadataUpdates === 2) throw new Error("metadata-activity-write-failure");
          return await control.metadata.update(transform);
        },
      },
      validation: createDeterministicCredentialValidationPort(),
      validationEnabled: false,
      clock: control.clock,
      clipboard: { async clear() { throw new Error("clipboard-clear-failure"); } },
    });
    await slots(service);
    const result = await service.save({ ...base, operation: "save", slotId: "anthropic", secret: SYNTHETIC, nickname: "Synthetic", ownership: "owned", authorizedBy: "", clearClipboard: true });
    expect(result).toMatchObject({ ok: true, kind: "saved", metadataWarning: true, clipboard: { requested: true, outcome: "failed" } });
    if (result.ok && result.kind === "saved") expect(result.slot.credentialId).toMatch(/^cred-[0-9a-f]{32}$/u);
    expect(metadataUpdates).toBe(2);
    expect(control.metadata.snapshot().slots.anthropic).toMatchObject({ nickname: "Synthetic", ownership: "owned", enabled: true });
    const recovery = control.createService();
    const recoverable = await slots(recovery, "4".repeat(32));
    expect(recoverable.metadataAvailable).toBe(true);
    const rotated = await recovery.rotate({ ...base, requestId: "5".repeat(32), operation: "rotate", ...identity(recoverable), secret: "SYNTHETIC_RECOVERY_ROTATION", clearClipboard: false, ...existingRotation });
    expect(rotated).toMatchObject({ ok: true, kind: "rotated", slot: { state: "present", nickname: "Synthetic" } });
    await recovery.close();
    await service.close();

    const metadataControl = createTestCredentialHost();
    await save(metadataControl.createService());
    let reads = 0;
    const enable = new CredentialHostService({
      manager: metadataControl.manager,
      resolvers: metadataControl.resolvers,
      metadata: {
        async read() { reads += 1; if (reads === 3) throw new Error("metadata-read-failure"); return await metadataControl.metadata.read(); },
        write: (snapshot) => metadataControl.metadata.write(snapshot),
        async update(transform) { reads += 1; if (reads === 3) throw new Error("metadata-update-failure"); return await metadataControl.metadata.update(transform); },
      },
      validation: createDeterministicCredentialValidationPort(),
      validationEnabled: false,
      clock: metadataControl.clock,
      clipboard: { async clear() { return true; } },
    });
    const current = await slots(enable);
    const refused = await enable.setEnabled({ ...base, operation: "set-enabled", ...identity(current), enabled: false });
    expect(refused).toMatchObject({ ok: false, code: "METADATA_UNAVAILABLE" });
    await enable.close();
  });

  it("returns finite cancel and describe-after-destroy refusals", async () => {
    const control = createTestCredentialHost();
    const service = control.createService();
    expect(service.cancel({ ...base, operation: "cancel" })).toMatchObject({ ok: true, kind: "cancelled" });
    expect(service.cancel({ ...base, requestId: "3".repeat(32), operation: "cancel" })).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    await service.close();
    expect(await service.describe({ ...base, requestId: "4".repeat(32), operation: "describe" })).toMatchObject({ ok: false, code: "APP_NOT_READY" });
  });

  it("refuses corrupt presentation metadata before a vault mutation and keeps the vault absent", async () => {
    const control = createTestCredentialHost();
    const service = new CredentialHostService({
      manager: control.manager,
      resolvers: control.resolvers,
      metadata: { async read() { throw new Error("corrupt-metadata"); }, async write() { throw new Error("corrupt-metadata"); }, async update() { throw new Error("corrupt-metadata"); } },
      validation: createDeterministicCredentialValidationPort(),
      validationEnabled: false,
      clock: control.clock,
      clipboard: { async clear() { return true; } },
    });
    await slots(service);
    const result = await service.save({ ...base, operation: "save", slotId: "anthropic", secret: SYNTHETIC, nickname: "Synthetic", ownership: "owned", authorizedBy: "", clearClipboard: false });
    expect(result).toMatchObject({ ok: false, code: "METADATA_UNAVAILABLE" });
    expect(await control.manager.describeSnapshot()).toMatchObject({ vaultState: "absent", revision: null });
    await service.close();
  });

  it("removes pre-staged metadata when the vault create definitively fails", async () => {
    const control = createTestCredentialHost();
    const manager = Object.freeze({
      ...control.manager,
      async create() { throw new Error("synthetic-create-failure"); },
    });
    const service = new CredentialHostService({ manager, resolvers: control.resolvers, metadata: control.metadata, validation: createDeterministicCredentialValidationPort(), validationEnabled: false, clock: control.clock, clipboard: { async clear() { return true; } } });
    await slots(service);
    const result = await service.save({ ...base, operation: "save", slotId: "anthropic", secret: SYNTHETIC, nickname: "Synthetic", ownership: "owned", authorizedBy: "", clearClipboard: false });
    expect(result).toMatchObject({ ok: false, code: "REFUSED" });
    expect(control.metadata.snapshot().slots.anthropic).toBeNull();
    expect(await control.manager.describeSnapshot()).toMatchObject({ vaultState: "absent", revision: null });
    await service.close();
  });

  it("drains post-commit clipboard work before close settles", async () => {
    const control = createTestCredentialHost();
    let clearStarted!: () => void;
    let releaseClear!: () => void;
    const started = new Promise<void>((resolve) => { clearStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseClear = resolve; });
    const service = new CredentialHostService({ manager: control.manager, resolvers: control.resolvers, metadata: control.metadata, validation: createDeterministicCredentialValidationPort(), validationEnabled: false, clock: control.clock, clipboard: { async clear() { clearStarted(); await gate; return true; } } });
    await slots(service);
    const pending = service.save({ ...base, operation: "save", slotId: "anthropic", secret: SYNTHETIC, nickname: "Synthetic", ownership: "owned", authorizedBy: "", clearClipboard: true });
    await started;
    let closeSettled = false;
    const closing = service.close().then(() => { closeSettled = true; });
    await waitImmediate();
    expect(closeSettled).toBe(false);
    releaseClear();
    expect(await pending).toMatchObject({ ok: true, kind: "saved" });
    await closing;
    expect(closeSettled).toBe(true);
  });

  it("drains an in-flight validation before closing its resolver and manager", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const validation = createDeterministicCredentialValidationPort({ gate });
    const service = control.createService({ validation, validationEnabled: true });
    const current = await slots(service);
    const pending = service.validate({ ...base, requestId: "5".repeat(32), operation: "validate", ...identity(current), acknowledgedDisclosure: true });
    while (validation.dispatches() === 0) await waitImmediate();
    let closeSettled = false;
    const closing = service.close().then(() => { closeSettled = true; });
    await waitImmediate();
    expect(closeSettled).toBe(false);
    release();
    expect(await pending).toMatchObject({ ok: true, kind: "validated" });
    await closing;
    expect(closeSettled).toBe(true);
  });

  it("cannot prepare authorization or dispatch when close wins during the first authoritative read", async () => {
    const control = createTestCredentialHost();
    const setup = control.createService();
    await save(setup);
    const current = await slots(setup);
    let authoritativeStarted!: () => void;
    const atAuthoritative = new Promise<void>((resolve) => { authoritativeStarted = resolve; });
    let releaseAuthoritative!: () => void;
    const authoritativeGate = new Promise<void>((resolve) => { releaseAuthoritative = resolve; });
    const manager = Object.freeze({
      ...control.manager,
      async describeSnapshot() {
        authoritativeStarted();
        await authoritativeGate;
        return await control.manager.describeSnapshot();
      },
    });
    let preparations = 0;
    let dispatches = 0;
    const validation: CredentialValidationPort = Object.freeze({
      async prepare() { preparations += 1; return Object.freeze({ schemaVersion: 1 }); },
      async validate() {
        dispatches += 1;
        return Object.freeze({ outcome: "valid", resultCode: "VALIDATION_OK" });
      },
    });
    const session = new CredentialEntrySession();
    session.begin("describe");
    session.described();
    const service = new CredentialHostService({
      manager,
      resolvers: control.resolvers,
      metadata: control.metadata,
      validation,
      validationEnabled: true,
      clock: control.clock,
      clipboard: { async clear() { return true; } },
      session,
    });
    const pending = service.validate({ ...base, requestId: "c".repeat(32), operation: "validate", ...identity(current), acknowledgedDisclosure: true });
    await atAuthoritative;
    let closeSettled = false;
    const closing = service.close().then(() => { closeSettled = true; });
    await waitImmediate();
    expect({ preparations, dispatches, closeSettled }).toEqual({ preparations: 0, dispatches: 0, closeSettled: false });
    releaseAuthoritative();
    expect(await pending).toMatchObject({ ok: false, code: "APP_NOT_READY" });
    await closing;
    expect({ preparations, dispatches, closeSettled }).toEqual({ preparations: 0, dispatches: 0, closeSettled: true });
  });

  it("does not persist a definitive result when close wins after provider settlement", async () => {
    const control = createTestCredentialHost();
    await save(control.createService());
    let recordingStarted!: () => void;
    const atRecording = new Promise<void>((resolve) => { recordingStarted = resolve; });
    let releaseRecording!: () => void;
    const recordingGate = new Promise<void>((resolve) => { releaseRecording = resolve; });
    let updates = 0;
    const service = new CredentialHostService({
      manager: control.manager,
      resolvers: control.resolvers,
      metadata: {
        read: () => control.metadata.read(),
        write: (snapshot) => control.metadata.write(snapshot),
        async update(transform, commitAllowed) {
          updates += 1;
          if (updates === 1) {
            recordingStarted();
            await recordingGate;
          }
          return await control.metadata.update(transform, commitAllowed);
        },
      },
      validation: createDeterministicCredentialValidationPort({ outcome: "valid" }),
      validationEnabled: true,
      clock: control.clock,
      clipboard: { async clear() { return true; } },
    });
    const current = await slots(service);
    const pending = service.validate({ ...base, requestId: "d".repeat(32), operation: "validate", ...identity(current), acknowledgedDisclosure: true });
    await atRecording;
    const closing = service.close();
    releaseRecording();
    const result = await pending;
    await closing;
    expect(result).toMatchObject({ ok: true, kind: "validated", outcome: "unreachable", definitive: false, providerDispatched: true, deadlineExpired: true });
    expect(control.metadata.snapshot().slots.anthropic?.validation).toBeNull();
    expect(control.metadata.snapshot().slots.anthropic?.lastValidationAttempt).toBeNull();
  });

  it("attempts every manager and broker close before returning one finite failure", async () => {
    const closes: string[] = [];
    const manager = Object.freeze({ close() { closes.push("manager"); throw new Error("PRIVATE_MANAGER_CLOSE"); } });
    const binding = (name: string, reject = false) => Object.freeze({
      async close() { closes.push(name); if (reject) throw new Error(`PRIVATE_${name.toUpperCase()}_CLOSE`); },
      describeContainerBinding() { throw new Error("unused"); },
      async resolve() { throw new Error("unused"); },
      evaluatePolicy() { throw new Error("unused"); },
    });
    const service = new CredentialHostService({
      manager: manager as never,
      resolvers: Object.freeze({ anthropic: binding("anthropic", true), openai: binding("openai"), gemini: binding("gemini"), openrouter: binding("openrouter") }) as never,
      metadata: Object.freeze({ async read() { throw new Error("unused"); }, async write() { throw new Error("unused"); }, async update() { throw new Error("unused"); } }),
      validation: createDeterministicCredentialValidationPort(),
      validationEnabled: false,
      clock: Object.freeze({ now: () => new Date("2026-08-20T10:00:00.000Z") }),
      clipboard: Object.freeze({ async clear() { return true; } }),
    });
    await expect(service.close()).rejects.toMatchObject({ code: "REFUSED", message: "Credential operation refused." });
    expect(closes.sort()).toEqual(["anthropic", "gemini", "manager", "openai", "openrouter"]);
    await expect(service.close()).rejects.toMatchObject({ code: "REFUSED" });
    expect(closes).toHaveLength(5);
  });
});
