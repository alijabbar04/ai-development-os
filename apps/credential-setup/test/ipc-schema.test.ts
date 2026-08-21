import { describe, expect, it } from "vitest";
import { CredentialHostError } from "../src/main/host-error.js";
import { parseCancelPayload, parseDescribePayload, parseRemoveChannelPayload, parseRotatePayload, parseSavePayload, parseValidatePayload } from "../src/main/ipc-schema.js";

const base = Object.freeze({ schemaVersion: 1, requestId: "1".repeat(32), sessionToken: "2".repeat(64) });
const identity = Object.freeze({ slotId: "anthropic", credentialId: `cred-${"3".repeat(32)}`, recordRevision: 4, recordToken: "4".repeat(64) });
const existingRotation = Object.freeze({ entryMode: "rotate", nickname: null, ownership: null, authorizedBy: null });

describe("flat hostile IPC projection", () => {
  it("parses every bounded request shape and preserves the secret for the foundation's one canonical trim", () => {
    expect(parseDescribePayload({ ...base }).operation).toBe("describe");
    expect(parseCancelPayload({ ...base }).operation).toBe("cancel");
    expect(parseSavePayload({ ...base, slotId: "anthropic", secret: "  SYNTHETIC_CREDENTIAL_VALUE  ", nickname: "Synthetic", ownership: "owned", authorizedBy: "", clearClipboard: true }).secret).toBe("  SYNTHETIC_CREDENTIAL_VALUE  ");
    expect(parseRotatePayload({ ...base, ...identity, secret: "SYNTHETIC_ROTATION_VALUE", clearClipboard: false, ...existingRotation })).toMatchObject({ operation: "rotate", entryMode: "rotate", nickname: null });
    expect(parseRotatePayload({ ...base, ...identity, secret: "SYNTHETIC_REENTRY_VALUE", clearClipboard: true, entryMode: "reenter", nickname: "Corrected nickname", ownership: "authorized", authorizedBy: "Platform lead" })).toMatchObject({ operation: "rotate", entryMode: "reenter", nickname: "Corrected nickname", ownership: "authorized", authorizedBy: "Platform lead" });
    expect(parseRemoveChannelPayload({ ...base, action: "set-enabled", ...identity, enabled: false })).toMatchObject({ operation: "set-enabled", enabled: false });
    expect(parseRemoveChannelPayload({ ...base, action: "remove", ...identity, acknowledgedRemoval: true })).toMatchObject({ operation: "remove", acknowledgedRemoval: true });
    expect(parseValidatePayload({ ...base, ...identity, acknowledgedDisclosure: true })).toMatchObject({ operation: "validate", acknowledgedDisclosure: true });
  });

  it("rejects proxies, accessors, symbols, hostile prototypes, boxed strings, extras, and wrong unions without invoking accessors", () => {
    let accessed = false;
    const accessor = Object.defineProperty({ ...base }, "requestId", { enumerable: true, get() { accessed = true; return "1".repeat(32); } });
    for (const bad of [new Proxy({ ...base }, {}), accessor, { ...base, extra: true }, { ...base, [Symbol("hidden")]: true }, Object.assign(Object.create({ polluted: true }), base)]) expect(() => parseDescribePayload(bad)).toThrow(CredentialHostError);
    expect(accessed).toBe(false);
    expect(() => parseSavePayload({ ...base, slotId: "anthropic", secret: new String("SYNTHETIC"), nickname: "Synthetic", ownership: "owned", authorizedBy: "", clearClipboard: true })).toThrow(CredentialHostError);
    expect(() => parseRemoveChannelPayload({ ...base, action: "arbitrary", ...identity })).toThrow(CredentialHostError);
    expect(() => parseValidatePayload({ ...base, ...identity, acknowledgedDisclosure: false })).toThrowError(expect.objectContaining({ code: "VALIDATION_DISCLOSURE_MISSING" }));
  });

  it("bounds the logical UTF-8 trim span without allocating, normalizing, or echoing secret material", () => {
    const save = (secret: string) => parseSavePayload({ ...base, slotId: "anthropic", secret, nickname: "Synthetic", ownership: "owned", authorizedBy: "", clearClipboard: true });
    const surrounded = " \nSYNTHETIC_CREDENTIAL_VALUE\r ";
    expect(save(surrounded).secret).toBe(surrounded);
    expect(save("x".repeat(8_192)).secret).toHaveLength(8_192);
    expect(save("🙂".repeat(2_048)).secret).toBe("🙂".repeat(2_048));
    expect(() => save("   \n")).toThrowError(expect.objectContaining({ code: "SECRET_EMPTY" }));
    expect(() => save("x".repeat(8_193))).toThrowError(expect.objectContaining({ code: "SECRET_TOO_LARGE" }));
    expect(() => save("🙂".repeat(2_049))).toThrowError(expect.objectContaining({ code: "SECRET_TOO_LARGE" }));
    expect(() => save("SYNTHETIC\u0000VALUE")).toThrowError(expect.objectContaining({ code: "SECRET_INVALID_CHARACTERS" }));
    expect(() => save("SYNTHETIC\ud800VALUE")).toThrowError(expect.objectContaining({ code: "SECRET_INVALID_CHARACTERS" }));
    expect(() => save(" ".repeat(16_385))).toThrowError(expect.objectContaining({ code: "SECRET_TOO_LARGE" }));
    expect(() => parseSavePayload({ ...base, slotId: "anthropic", secret: new Uint8Array([1]), nickname: "Synthetic", ownership: "owned", authorizedBy: "", clearClipboard: true })).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
  });

  it("refuses direct or split credential material in plaintext metadata fields", () => {
    const payload = (secret: string, nickname: string, authorizedBy = "") => ({
      ...base,
      slotId: "anthropic",
      secret,
      nickname,
      ownership: authorizedBy.length === 0 ? "owned" : "authorized",
      authorizedBy,
      clearClipboard: true,
    });
    const neutralCanary = "SYNTHETIC_SAMPLE_ALPHA";
    expect(() => parseSavePayload(payload(neutralCanary, neutralCanary))).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
    expect(() => parseSavePayload(payload(neutralCanary, `Label ${neutralCanary}`))).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
    expect(() => parseSavePayload(payload("abc", "Label abc"))).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
    expect(() => parseSavePayload(payload("SYNTHETIC_FRAGMENT_1234", "1234"))).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
    expect(() => parseSavePayload(payload(neutralCanary, "Synthetic", neutralCanary))).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
    expect(() => parseSavePayload(payload("SYNTHETIC_CREDENTIAL_VALUE", "SYNTHETIC_CREDENTIAL_", "VALUE"))).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
    expect(() => parseSavePayload(payload("VALUESYNTHETIC_CREDENTIAL_", "SYNTHETIC_CREDENTIAL_", "VALUE"))).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
    expect(() => parseSavePayload(payload("UNRELATED_SYNTHETIC_SAMPLE", "SYNTHETIC_KEY_CANARY"))).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
  });

  it("refuses bounded reversible credential transformations while preserving benign labels", () => {
    const payload = (secret: string, nickname: string, authorizedBy = "") => ({
      ...base,
      slotId: "anthropic",
      secret,
      nickname,
      ownership: authorizedBy.length === 0 ? "owned" : "authorized",
      authorizedBy,
      clearClipboard: true,
    });
    const secret = "SYNTHETIC_CREDENTIAL_ALPHA90";
    const shift = (value: string, delta: number) => [...value].map((character) => String.fromCharCode(character.charCodeAt(0) + delta)).join("");
    const fullwidth = [...secret].map((character) => /[A-Z0-9]/u.test(character) ? String.fromCharCode(character.charCodeAt(0) + 0xfee0) : character).join("");
    const secretSlice = secret.slice(-20);
    const hostile = [
      [...secret].reverse().join(""),
      shift(secret, 1),
      `${secret.slice(0, 9)}\u200b${secret.slice(9)}`,
      fullwidth,
      Buffer.from(secretSlice, "utf8").toString("base64"),
      Buffer.from(secretSlice, "utf8").toString("base64url"),
    ];
    for (const nickname of hostile) expect(() => parseSavePayload(payload(secret, nickname))).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
    expect(() => parseSavePayload(payload(secret, Buffer.from(secretSlice, "utf8").toString("hex")))).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
    const reversed = [...secret].reverse().join("");
    expect(() => parseSavePayload(payload(secret, reversed.slice(0, 20), reversed.slice(20)))).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
    expect(parseSavePayload(payload(secret, "Release credential", "Platform team"))).toMatchObject({ nickname: "Release credential", authorizedBy: "Platform team" });
    expect(() => parseRotatePayload({ ...base, ...identity, secret, clearClipboard: false, entryMode: "reenter", nickname: reversed, ownership: "owned", authorizedBy: "" })).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
    expect(parseRotatePayload({ ...base, ...identity, secret, clearClipboard: false, entryMode: "reenter", nickname: "Release credential", ownership: "authorized", authorizedBy: "Platform team" })).toMatchObject({ nickname: "Release credential", authorizedBy: "Platform team" });
  });

  it("requires consistent ownership metadata and bounded authoritative identity tokens", () => {
    const common = { ...base, slotId: "anthropic", secret: "SYNTHETIC", nickname: "Synthetic", clearClipboard: true };
    expect(() => parseSavePayload({ ...common, ownership: "owned", authorizedBy: "Someone" })).toThrow();
    expect(() => parseSavePayload({ ...common, ownership: "authorized", authorizedBy: "" })).toThrow();
    expect(parseSavePayload({ ...common, ownership: "authorized", authorizedBy: "Team lead" }).authorizedBy).toBe("Team lead");
    expect(parseSavePayload({ ...common, nickname: "N".repeat(40), ownership: "owned", authorizedBy: "" }).nickname).toHaveLength(40);
    expect(parseSavePayload({ ...common, ownership: "authorized", authorizedBy: "A".repeat(40) }).authorizedBy).toHaveLength(40);
    expect(() => parseSavePayload({ ...common, nickname: "N".repeat(41), ownership: "owned", authorizedBy: "" })).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
    expect(() => parseSavePayload({ ...common, ownership: "authorized", authorizedBy: "A".repeat(41) })).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
    expect(() => parseRotatePayload({ ...base, ...identity, recordRevision: 0, secret: "SYNTHETIC", clearClipboard: true, ...existingRotation })).toThrow();
    expect(() => parseRotatePayload({ ...base, ...identity, recordToken: "short", secret: "SYNTHETIC", clearClipboard: true, ...existingRotation })).toThrow();
    expect(() => parseRotatePayload({ ...base, ...identity, secret: "SYNTHETIC", clearClipboard: true, entryMode: "rotate", nickname: "Rename", ownership: null, authorizedBy: null })).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
    expect(() => parseRotatePayload({ ...base, ...identity, secret: "SYNTHETIC", clearClipboard: true, entryMode: "reenter", nickname: "", ownership: "owned", authorizedBy: "" })).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
    expect(() => parseRotatePayload({ ...base, ...identity, secret: "SYNTHETIC", clearClipboard: true, entryMode: "reenter", nickname: "Corrected", ownership: "authorized", authorizedBy: "" })).toThrowError(expect.objectContaining({ code: "SCHEMA_REJECTED" }));
  });
});
