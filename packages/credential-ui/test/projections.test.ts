import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_ERROR_CODES,
  actionSetForSlot,
  aggregateSummary,
  captureModeActionSet,
  credentialErrorCopy,
  hasCompleteCredentialErrorCopy,
  projectCredentialActions,
  projectCredentialMode,
  projectCredentialStatus,
  validationIsDefinitive,
  type CredentialSlotView,
  type CredentialSlotsResult,
} from "../src/index.js";

const NOW = new Date("2026-08-20T11:00:00.000Z");
const AUTHORIZATION = Object.freeze({
  schemaVersion: 1 as const,
  state: "available" as const,
  slotId: "anthropic" as const,
  providerInstanceId: "anthropic-default" as const,
  modelId: "claude-haiku-4-5-20251001" as const,
  requestFingerprint: "d".repeat(64),
  packetFingerprint: "e".repeat(64),
  authorizationReference: "review-stage-18e-i",
  expiresAt: "2026-08-20T12:00:00.000Z",
  maximumOutputTokens: 4 as const,
  effectTimeoutMs: 15_000 as const,
  callbackDrainMs: 5_000 as const,
  retentionMode: "standard-commercial-api" as const,
});

function slot(patch: Partial<CredentialSlotView> = {}): CredentialSlotView {
  return {
    slotId: "anthropic",
    displayName: "Anthropic",
    productName: "Claude",
    providerHost: "api.anthropic.test",
    credentialId: "cred-0d8f3e4a",
    nickname: "Synthetic",
    ownership: "owned",
    authorizedBy: null,
    enabled: true,
    state: "present",
    revision: 2,
    generation: 1,
    createdAt: "2026-08-20T10:00:00.000Z",
    rotatedAt: null,
    revokedAt: null,
    recordToken: "a".repeat(64),
    validation: null,
    lastValidationAttempt: null,
    developer: {
      referenceDisplay: "encrypted-file:provider:anthropic:[text]",
      referenceFingerprint: "b".repeat(64),
      containerBinding: "c".repeat(64),
      backendKind: "deterministic-fake",
      documentRevision: 2,
      recordToken: "a".repeat(64),
      operationPhase: "idle",
      resultCode: null,
      policyDecisionFingerprint: null,
      successReceiptState: null,
      successReceiptId: null,
      successReceiptSha256: null,
    },
    ...patch,
  };
}

function response(slots: readonly CredentialSlotView[]): CredentialSlotsResult {
  return {
    schemaVersion: 1,
    requestId: "0".repeat(32),
    ok: true,
    kind: "slots",
    vaultState: "ready",
    revision: 2,
    slots,
    recovery: null,
    activity: [],
    clipboardClearDefault: true,
    validationEnabled: true,
    validationAuthorization: AUTHORIZATION,
    productionDisabled: true,
    metadataAvailable: true,
  };
}

describe("truthful credential projections", () => {
  it("counts only accepted enabled outcomes as connected, including accepted-but-limited permission", () => {
    const cases = [
      slot({ state: "absent", credentialId: null, nickname: null, ownership: null, revision: null, generation: null, recordToken: null }),
      slot(),
      slot({ validation: { outcome: "invalid", checkedAt: "2026-08-20T10:01:00.000Z", recordRevision: 2, recordToken: "a".repeat(64), definitive: true } }),
      slot({ validation: { outcome: "unauthorized", checkedAt: "2026-08-20T10:01:00.000Z", recordRevision: 2, recordToken: "a".repeat(64), definitive: true } }),
      slot({ validation: { outcome: "ambiguous", checkedAt: "2026-08-20T10:01:00.000Z", recordRevision: 2, recordToken: "a".repeat(64), definitive: false } }),
      slot({ enabled: false, validation: { outcome: "valid", checkedAt: "2026-08-20T10:01:00.000Z", recordRevision: 2, recordToken: "a".repeat(64), definitive: true } }),
    ];
    expect(cases.map((item) => projectCredentialStatus(item).connected)).toEqual([false, false, false, true, false, false]);
    expect(projectCredentialStatus(slot({ validation: { outcome: "valid", checkedAt: "2026-08-20T10:01:00.000Z", recordRevision: 2, recordToken: "a".repeat(64), definitive: true } })).connected).toBe(true);
  });

  it("keeps inconclusive attempts separate and applies seven-day staleness only to prior success", () => {
    const accepted = { outcome: "valid" as const, checkedAt: "2026-08-13T10:00:00.000Z", recordRevision: 2, recordToken: "a".repeat(64), definitive: true };
    const inconclusive = { outcome: "ambiguous" as const, checkedAt: "2026-08-20T09:59:00.000Z", recordRevision: 2, recordToken: "a".repeat(64), definitive: false };
    const threshold = new Date("2026-08-20T10:00:00.000Z");
    expect(projectCredentialStatus(slot({ validation: accepted }), true, "ready", new Date(threshold.valueOf() - 1)).connected).toBe(true);
    expect(projectCredentialStatus(slot({ validation: accepted }), true, "ready", threshold)).toMatchObject({ label: "Check needed", connected: true });
    expect(projectCredentialStatus(slot({ validation: accepted, lastValidationAttempt: inconclusive }), true, "ready", threshold)).toMatchObject({ label: "Check inconclusive", connected: false });
    expect(projectCredentialStatus(slot({ validation: accepted, lastValidationAttempt: inconclusive }), true, "ready", threshold).sentence).toContain("Last known: accepted");
    expect(projectCredentialStatus(slot({ validation: { ...accepted, outcome: "unauthorized" }, lastValidationAttempt: inconclusive }), true, "ready", threshold).sentence).toContain("Last known: accepted with limited permission");
    expect(projectCredentialStatus(slot({ validation: { ...accepted, outcome: "invalid" }, lastValidationAttempt: inconclusive }), true, "ready", threshold).sentence).toContain("Last known: not accepted");
    expect(projectCredentialStatus(slot({ validation: { ...accepted, outcome: "invalid" } }), true, "ready", threshold)).toMatchObject({ label: "Not accepted", connected: false });
    expect(projectCredentialStatus(slot({ validation: { ...accepted, outcome: "unauthorized" } }), true, "ready", threshold)).toMatchObject({ label: "Permission limited", connected: true });
    expect(projectCredentialStatus(slot({ validation: { ...accepted, checkedAt: "invalid-time" } }), true, "ready", threshold)).toMatchObject({ label: "Check needed", connected: false });
    expect(projectCredentialStatus(slot({ validation: { ...accepted, outcome: "unauthorized", checkedAt: "2026-08-21T10:00:00.000Z" } }), true, "ready", threshold)).toMatchObject({ label: "Check needed", connected: false });
    expect(aggregateSummary(response([slot({ validation: accepted })]), threshold)).toContain("1 accepted provider");
    expect(aggregateSummary(response([slot({ validation: accepted })]), threshold)).toContain("1 credential needs a check");
  });

  it("treats provider success without a durable audit receipt as evidence-incomplete, not invalid or connected", () => {
    const prior = { outcome: "valid" as const, checkedAt: "2026-08-20T09:00:00.000Z", recordRevision: 2, recordToken: "a".repeat(64), definitive: true, receiptState: "historical-missing" as const };
    const incomplete = { outcome: "evidence-incomplete" as const, checkedAt: "2026-08-20T10:00:00.000Z", recordRevision: 2, recordToken: "a".repeat(64), definitive: false, receiptState: "write-failed" as const };
    const projected = projectCredentialStatus(slot({ validation: prior, lastValidationAttempt: incomplete }), true, "ready", new Date("2026-08-20T10:01:00.000Z"));
    expect(projected).toMatchObject({ tone: "warn", label: "Receipt not saved", connected: false });
    expect(projected.sentence).toContain("Provider validation succeeded, but its audit receipt could not be saved");
    expect(projected.sentence).toContain("one-shot attempt was consumed and cannot be retried");
    expect(projected.sentence).toContain("Last known: accepted");
    const persisted = response([slot({ validation: prior, lastValidationAttempt: incomplete })]);
    for (const mode of ["normal", "developer"] as const) {
      const reopened = projectCredentialMode(structuredClone(persisted), mode, new Date("2026-08-20T10:01:00.000Z"))[0]!;
      expect(reopened.status).toMatchObject({ tone: "warn", label: "Receipt not saved", connected: false });
      expect(reopened.status.sentence).toContain("Provider validation succeeded");
      expect(reopened.status.sentence).toContain("consumed and cannot be retried");
      expect(reopened.developerFacts === null).toBe(mode === "normal");
    }
    expect(validationIsDefinitive("evidence-incomplete")).toBe(false);
  });

  it("distinguishes an unverifiable saved receipt from a receipt that was not saved after restart in both modes", () => {
    const prior = { outcome: "valid" as const, checkedAt: "2026-08-20T09:00:00.000Z", recordRevision: 2, recordToken: "a".repeat(64), definitive: true, receiptState: "committed" as const };
    const mismatch = { outcome: "evidence-incomplete" as const, checkedAt: "2026-08-20T10:00:00.000Z", recordRevision: 2, recordToken: "a".repeat(64), definitive: false, receiptState: "mismatch" as const };
    const persisted = response([slot({ validation: prior, lastValidationAttempt: mismatch })]);
    for (const mode of ["normal", "developer"] as const) {
      const reopened = projectCredentialMode(structuredClone(persisted), mode, new Date("2026-08-20T10:01:00.000Z"))[0]!;
      expect(reopened.status).toMatchObject({ tone: "warn", label: "Receipt not verifiable", connected: false });
      expect(reopened.status.sentence).toContain("saved audit receipt could not be verified for this build");
      expect(reopened.status.sentence).toContain("consumed and cannot be retried");
      expect(reopened.status.sentence).not.toContain("could not be saved");
      expect(reopened.developerFacts === null).toBe(mode === "normal");
    }
  });

  it("projects removed, unreadable, unreachable, and every definitive validation outcome without optimistic wording", () => {
    expect(projectCredentialStatus(slot({ state: "revoked" })).label).toBe("Removed");
    expect(projectCredentialStatus(slot({ state: "unrecoverable" })).label).toBe("Re-entry required");
    expect(projectCredentialStatus(slot({ state: "unrecoverable", credentialId: null, revision: null, recordToken: null })).label).toBe("Storage unavailable");
    expect(projectCredentialStatus(slot({ validation: { outcome: "unreachable", checkedAt: "2026-08-20T10:01:00.000Z", recordRevision: 2, recordToken: "a".repeat(64), definitive: false } })).label).toBe("Check inconclusive");
    expect(validationIsDefinitive("valid")).toBe(true);
    expect(validationIsDefinitive("invalid")).toBe(true);
    expect(validationIsDefinitive("unauthorized")).toBe(true);
    expect(validationIsDefinitive("ambiguous")).toBe(false);
    expect(validationIsDefinitive("unreachable")).toBe(false);

    const unsupportedRuntimeOutcome = slot({
      validation: {
        outcome: "future-outcome",
        checkedAt: "2026-08-20T10:01:00.000Z",
        recordRevision: 2,
        recordToken: "a".repeat(64),
        definitive: true,
      } as CredentialSlotView["validation"],
    });
    expect(projectCredentialStatus(unsupportedRuntimeOutcome)).toMatchObject({ label: "Check inconclusive", connected: false });
  });

  it("counts one provider once when a future model contains multiple credentials for that provider", () => {
    const slots = [
      slot({ slotId: "anthropic", validation: { outcome: "valid", checkedAt: "2026-08-20T10:01:00.000Z", recordRevision: 2, recordToken: "a".repeat(64), definitive: true } }),
      slot({ slotId: "anthropic", credentialId: "cred-anthropic-second", validation: null }),
      slot({ slotId: "openai", credentialId: "cred-openai", validation: { outcome: "valid", checkedAt: "2026-08-20T10:02:00.000Z", recordRevision: 2, recordToken: "d".repeat(64), definitive: true } }),
      slot({ slotId: "openrouter", enabled: false, validation: { outcome: "valid", checkedAt: "2026-08-20T10:01:00.000Z", recordRevision: 2, recordToken: "a".repeat(64), definitive: true } }),
    ];
    expect(aggregateSummary({ slots, metadataAvailable: true, vaultState: "ready" }, NOW)).toBe("2 accepted providers · 4 saved credentials · 1 credential not validated · 0 credentials need a check · 0 credentials need attention · 1 disabled credential");
    expect(aggregateSummary({ slots, metadataAvailable: false, vaultState: "ready" }, NOW)).toBe("4 saved credentials · Connection and validation details unavailable");
    expect(aggregateSummary({ slots: [slots[0]!], metadataAvailable: true, vaultState: "ready" }, NOW)).toBe("1 accepted provider · 1 saved credential · 0 credentials not validated · 0 credentials need a check · 0 credentials need attention · 0 disabled credentials");
    expect(aggregateSummary({ slots: [slots[0]!], metadataAvailable: false, vaultState: "ready" }, NOW)).toBe("1 saved credential · Connection and validation details unavailable");
  });
});

describe("action authority", () => {
  it("captures Normal and Developer actions independently and proves exact parity", () => {
    const input = response([
      slot({ slotId: "anthropic" }),
      slot({ slotId: "openai", enabled: false }),
      slot({ slotId: "gemini", state: "absent", credentialId: null, nickname: null, ownership: null, revision: null, generation: null, recordToken: null }),
      slot({ slotId: "openrouter", state: "unrecoverable" }),
    ]);
    const normal = captureModeActionSet(structuredClone(input), "normal");
    const developer = captureModeActionSet(structuredClone(input), "developer");
    const normalPresentation = projectCredentialMode(structuredClone(input), "normal");
    const developerPresentation = projectCredentialMode(structuredClone(input), "developer");
    expect(normal).not.toHaveLength(0);
    expect(developer).toEqual(normal);
    expect(normalPresentation.every((slot) => slot.developerFacts === null)).toBe(true);
    expect(developerPresentation.every((slot) => slot.developerFacts !== null)).toBe(true);
    expect(developerPresentation).not.toEqual(normalPresentation);
    expect(developer).not.toContain("anthropic:reveal");
    expect(developer).not.toContain("anthropic:export");
  });

  it("exposes finite actions per lifecycle with visible validation and in-flight blocking reasons", () => {
    expect(actionSetForSlot(slot({ state: "absent" }), true, null)).toEqual(["save"]);
    expect(actionSetForSlot(slot({ state: "revoked" }), true, null)).toEqual(["reenter"]);
    expect(actionSetForSlot(slot({ state: "unrecoverable", credentialId: null, revision: null, recordToken: null }), true, null)).toEqual([]);
    expect(actionSetForSlot(slot({ enabled: false }), true, null, AUTHORIZATION)).toEqual(["validate", "rotate", "enable", "remove"]);
    expect(actionSetForSlot(slot(), false, null, AUTHORIZATION)).toEqual(["rotate", "disable", "remove"]);
    expect(actionSetForSlot(slot({ slotId: "openai" }), true, null, AUTHORIZATION)).toEqual(["rotate", "disable", "remove"]);
    expect(projectCredentialActions(slot(), true, "cred-0d8f3e4a", true, "ready", AUTHORIZATION).every((item) => item.disabledReason === "Check in progress")).toBe(true);
    const otherCheck = projectCredentialActions(slot(), true, "cred-other", true, "ready", AUTHORIZATION);
    expect(otherCheck[0]).toEqual({ action: "validate", disabledReason: "Another check is in progress" });
    expect(otherCheck.slice(1).every((item) => item.disabledReason === null)).toBe(true);
    const authoritativeInFlight = slot({ developer: { ...slot().developer, operationPhase: "validation-in-flight" } });
    expect(projectCredentialActions(authoritativeInFlight, true, null, true, "ready", AUTHORIZATION).every((item) => item.disabledReason === "Check in progress")).toBe(true);
  });

  it("projects metadata loss as unknown and blocks every credential action without inventing facts", () => {
    const input = { ...response([slot({ ownership: null, enabled: false })]), metadataAvailable: false };
    const projected = projectCredentialMode(input, "normal")[0]!;
    expect(projected.status).toMatchObject({ label: "Details unavailable", connected: false });
    expect(projected.actions).not.toHaveLength(0);
    expect(projected.actions.every((item) => item.disabledReason === "Restore this installation's saved credential details")).toBe(true);
    expect(projectCredentialStatus(slot({ ownership: null, enabled: false }), false).sentence).toContain("cannot be determined");
    expect(projectCredentialStatus(slot({ state: "revoked", ownership: null, enabled: false }), false)).toMatchObject({ label: "Details unavailable", connected: false });
    expect(projectCredentialStatus(slot({ state: "revoked", ownership: null, enabled: false }), false).sentence).not.toContain("re-entry");
  });

  it("blocks every authority-bearing action while secure storage needs recovery", () => {
    const input: CredentialSlotsResult = {
      ...response([slot()]),
      vaultState: "backup-only",
      recovery: { issueCode: "VAULT_BACKUP_ONLY", primaryDigest: null, backupDigest: "f".repeat(64), actions: ["restore-backup", "start-over"] },
    };
    const projected = projectCredentialMode(input, "normal")[0]!;
    expect(projected.actions).not.toHaveLength(0);
    expect(projected.actions.every((item) => item.disabledReason === "Secure storage needs recovery")).toBe(true);
    expect(projected.status).toMatchObject({ label: "Recovery required", connected: false });
    expect(aggregateSummary(input, NOW)).toBe("Secure storage recovery required · Provider acceptance and credential counts unavailable");

    for (const vaultState of ["backup-only", "corrupt", "identity-mismatch", "backend-mismatch", "schema-ahead", "encryption-unavailable"] as const) {
      const recovery = { ...input, vaultState };
      expect(projectCredentialMode(recovery, "normal", NOW)[0]!.status.connected).toBe(false);
      expect(aggregateSummary(recovery, NOW)).toContain("counts unavailable");
    }

    const empty = slot({ state: "absent", credentialId: null, nickname: null, ownership: null, revision: null, generation: null, recordToken: null });
    const absent = projectCredentialMode({ ...response([empty]), vaultState: "absent", revision: null }, "normal")[0]!;
    expect(absent.actions).toEqual([{ action: "save", disabledReason: null }]);
  });

  it("projects one authoritative validation reservation as a global validation block", () => {
    const checking = slot({
      slotId: "anthropic",
      developer: { ...slot().developer, operationPhase: "validation-in-flight" },
    });
    const other = slot({ slotId: "openai", credentialId: "cred-other" });
    const projected = projectCredentialMode(response([checking, other]), "normal");

    expect(projected[0]!.actions.every((item) => item.disabledReason === "Check in progress")).toBe(true);
    expect(projected[1]!.actions.find((item) => item.action === "validate")).toBeUndefined();
    expect(projected[1]!.actions.every((item) => item.disabledReason === null)).toBe(true);
  });
});

describe("finite refusal catalogue", () => {
  it("maps every closed error code to nonempty product copy", () => {
    expect(hasCompleteCredentialErrorCopy()).toBe(true);
    for (const code of CREDENTIAL_ERROR_CODES) {
      expect(credentialErrorCopy(code).title.length).toBeGreaterThan(0);
      expect(credentialErrorCopy(code).body.length).toBeGreaterThan(0);
    }
  });
});
