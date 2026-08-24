import { describe, expect, it } from "vitest";
import { AppVaultError } from "@ai-dev-os/secrets-app-vault";
import { SecretBrokerError, createSecretMaterial } from "@ai-dev-os/secrets";
import { CredentialHostError, finiteCredentialError } from "../src/main/host-error.js";
import { createDeterministicCredentialValidationPort, createDisabledCredentialValidationPort, parseCredentialValidationResult } from "../src/main/validation.js";

function input(signal: AbortSignal, text = "SYNTHETIC_VALIDATION_VALUE") {
  const secret = createSecretMaterial("text", new TextEncoder().encode(text));
  return {
    secret,
    value: { slotId: "anthropic" as const, credentialId: `cred-${"1".repeat(32)}`, recordRevision: 1, recordToken: "2".repeat(64), secret, signal },
  };
}

describe("finite host error projection", () => {
  it("preserves host errors and maps known, absent, revoked, and unknown failures without private text", () => {
    const host = new CredentialHostError("VAULT_BUSY");
    expect(finiteCredentialError(host)).toBe(host);
    expect(finiteCredentialError(new AppVaultError("VAULT_CORRUPT", "PRIVATE_CANARY"))).toMatchObject({ code: "VAULT_CORRUPT", retryable: false });
    expect(finiteCredentialError(new AppVaultError("VAULT_ABSENT", "PRIVATE_CANARY"))).toMatchObject({ code: "REFUSED" });
    expect(finiteCredentialError(new SecretBrokerError("NOT_FOUND", "PRIVATE_CANARY"))).toMatchObject({ code: "SLOT_ABSENT" });
    expect(finiteCredentialError(new SecretBrokerError("REVOKED", "PRIVATE_CANARY"))).toMatchObject({ code: "SLOT_ABSENT" });
    expect(finiteCredentialError(new SecretBrokerError("BACKEND_FAILURE", "PRIVATE_CANARY"))).toMatchObject({ code: "REFUSED" });
    expect(finiteCredentialError(new Error("PRIVATE_CANARY"))).toMatchObject({ code: "REFUSED", message: "Credential operation refused." });
  });
});

describe("deterministic validation ports", () => {
  it("projects only exact closed validation results without invoking accessors or accepting proxies", () => {
    const valid = parseCredentialValidationResult(Object.freeze({ outcome: "valid", resultCode: "VALIDATION_OK" }));
    expect(valid).toEqual({ outcome: "valid", resultCode: "VALIDATION_OK" });
    expect(Object.isFrozen(valid)).toBe(true);
    expect(() => parseCredentialValidationResult(new Date())).toThrow();
    expect(() => parseCredentialValidationResult({ outcome: "unexpected", resultCode: "VALIDATION_OK" })).toThrow();
    expect(() => parseCredentialValidationResult({ outcome: "valid", resultCode: "AUTHENTICATION_FAILED" })).toThrow();
    expect(() => parseCredentialValidationResult({ outcome: "valid", resultCode: "VALIDATION_OK", providerText: "PRIVATE_PROVIDER_TEXT" })).toThrow();
    expect(parseCredentialValidationResult({ outcome: "valid", resultCode: "VALIDATION_OK", successReceiptId: "a".repeat(64), successReceiptSha256: "b".repeat(64) })).toEqual({ outcome: "valid", resultCode: "VALIDATION_OK", successReceiptId: "a".repeat(64), successReceiptSha256: "b".repeat(64) });
    expect(() => parseCredentialValidationResult({ outcome: "valid", resultCode: "VALIDATION_OK", successReceiptId: "a".repeat(64) })).toThrow();
    expect(() => parseCredentialValidationResult({ outcome: "invalid", resultCode: "AUTHENTICATION_FAILED", successReceiptId: "a".repeat(64), successReceiptSha256: "b".repeat(64) })).toThrow();

    let accessorRead = false;
    const accessor = Object.defineProperties({}, {
      outcome: { enumerable: true, get() { accessorRead = true; return "valid"; } },
      resultCode: { enumerable: true, value: "VALIDATION_OK" },
    });
    expect(() => parseCredentialValidationResult(accessor)).toThrow();
    expect(accessorRead).toBe(false);
    expect(() => parseCredentialValidationResult(new Proxy({ outcome: "valid", resultCode: "VALIDATION_OK" }, {}))).toThrow();
  });

  it("keeps production validation disabled and maps every finite deterministic outcome", async () => {
    const disabled = createDisabledCredentialValidationPort();
    const disabledInput = input(new AbortController().signal);
    await expect(disabled.validate(disabledInput.value)).rejects.toMatchObject({ code: "VALIDATION_DISABLED" });
    disabledInput.secret.dispose();

    const expected = {
      valid: "VALIDATION_OK",
      invalid: "AUTHENTICATION_FAILED",
      unauthorized: "AUTHORIZATION_LIMITED",
      ambiguous: "RESULT_AMBIGUOUS",
      unreachable: "PROVIDER_UNREACHABLE",
      "evidence-incomplete": "EVIDENCE_RECEIPT_UNAVAILABLE",
    } as const;
    for (const [outcome, resultCode] of Object.entries(expected)) {
      const port = createDeterministicCredentialValidationPort({ outcome: outcome as keyof typeof expected });
      const current = input(new AbortController().signal);
      await expect(port.validate(current.value)).resolves.toEqual({ outcome, resultCode });
      expect(port.dispatches()).toBe(1);
      current.secret.dispose();
    }
  });

  it("refuses cancellation before and after a gate and rejects empty material", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const before = input(alreadyAborted.signal);
    await expect(createDeterministicCredentialValidationPort().validate(before.value)).rejects.toMatchObject({ code: "VALIDATION_CANCELLED" });
    before.secret.dispose();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const duringAbort = new AbortController();
    const during = input(duringAbort.signal);
    const pending = createDeterministicCredentialValidationPort({ gate }).validate(during.value);
    duringAbort.abort();
    release();
    await expect(pending).rejects.toMatchObject({ code: "VALIDATION_CANCELLED" });
    during.secret.dispose();

    const empty = input(new AbortController().signal, "");
    await expect(createDeterministicCredentialValidationPort().validate(empty.value)).rejects.toMatchObject({ code: "REFUSED" });
    empty.secret.dispose();
  });
});
