import { mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileCredentialMetadataStore, createMemoryCredentialMetadataStore, emptyCredentialMetadata, parseCredentialMetadata, replaceSlotMetadata } from "../src/main/metadata-store.js";

function populated() {
  const validation = { outcome: "valid" as const, checkedAt: "2026-08-20T10:00:00.000Z", recordRevision: 1, recordToken: "2".repeat(64), definitive: true, resultCode: "VALIDATION_OK" as const, policyDecisionFingerprint: "3".repeat(64) };
  return replaceSlotMetadata(emptyCredentialMetadata(), "anthropic", {
    credentialId: `cred-${"1".repeat(32)}`,
    nickname: "Synthetic",
    ownership: "authorized",
    authorizedBy: "Test lead",
    enabled: true,
    validation,
    lastValidationAttempt: validation,
  }, { id: "activity-1", at: "2026-08-20T10:00:00.000Z", tone: "ok", text: "Saved synthetic Anthropic credential locally — not validated." });
}

describe("bounded nonsecret metadata store", () => {
  it("serializes explicit in-memory writes through the same strict parser", async () => {
    const store = createMemoryCredentialMetadataStore();
    await store.write(populated());
    expect(store.snapshot()).toEqual(populated());
    await expect(store.write({ ...populated(), schemaVersion: 2 } as never)).rejects.toMatchObject({ code: "METADATA_UNAVAILABLE" });
    expect(await store.read()).toEqual(populated());
    const recovered = await store.update((current) => replaceSlotMetadata(current, "anthropic", { ...current.slots.anthropic!, enabled: false }));
    expect(recovered.slots.anthropic?.enabled).toBe(false);
  });

  it("does not poison in-memory reads or later updates when one transform throws", async () => {
    const store = createMemoryCredentialMetadataStore(populated());
    const marker = new Error("synthetic-transform-failure");
    await expect(store.update(() => { throw marker; })).rejects.toBe(marker);
    expect(await store.read()).toEqual(populated());
    const recovered = await store.update((current) => replaceSlotMetadata(current, "anthropic", { ...current.slots.anthropic!, enabled: false }));
    expect(recovered.slots.anthropic?.enabled).toBe(false);
  });

  it("round-trips strict bounded metadata atomically without temp remnants", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-dev-os-credential-metadata-"));
    try {
      const store = createFileCredentialMetadataStore(root);
      expect(await store.read()).toEqual(emptyCredentialMetadata());
      await store.write(populated());
      expect(await store.read()).toEqual(populated());
      const second = replaceSlotMetadata(populated(), "anthropic", { ...populated().slots.anthropic!, enabled: false });
      await store.write(second);
      expect((await store.read()).slots.anthropic?.enabled).toBe(false);
      expect(await readdir(root)).toEqual(["credential-ui.v1.json"]);
      expect(await readFile(join(root, "credential-ui.v1.json"), "utf8")).not.toContain("SYNTHETIC_CREDENTIAL_VALUE");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses corrupt, oversized, extra-field, duplicate-shape, and invalid validation metadata without overwriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-dev-os-credential-metadata-bad-"));
    try {
      const target = join(root, "credential-ui.v1.json");
      await writeFile(target, "{not-json", "utf8");
      const store = createFileCredentialMetadataStore(root);
      await expect(store.read()).rejects.toMatchObject({ code: "METADATA_UNAVAILABLE" });
      await expect(store.write(populated())).rejects.toMatchObject({ code: "METADATA_UNAVAILABLE" });
      await expect(store.update(() => populated())).rejects.toMatchObject({ code: "METADATA_UNAVAILABLE" });
      expect(await readFile(target, "utf8")).toBe("{not-json");
      await writeFile(target, "x".repeat(131_073), "utf8");
      await expect(store.read()).rejects.toMatchObject({ code: "METADATA_UNAVAILABLE" });
      await writeFile(target, "replace-after-oversized-refusal", "utf8");
      const sparse = await open(target, "w");
      try { await sparse.truncate(1_000_000_000); }
      finally { await sparse.close(); }
      await expect(store.read()).rejects.toMatchObject({ code: "METADATA_UNAVAILABLE" });
      await writeFile(target, "replace-after-sparse-refusal", "utf8");
      expect(() => parseCredentialMetadata({ ...emptyCredentialMetadata(), extra: true })).toThrow();
      expect(() => parseCredentialMetadata({ ...populated(), slots: { ...populated().slots, anthropic: { ...populated().slots.anthropic, validation: { ...populated().slots.anthropic!.validation, recordToken: "bad" } } } })).toThrow();
      expect(() => parseCredentialMetadata({ ...populated(), slots: { ...populated().slots, anthropic: { ...populated().slots.anthropic, validation: { ...populated().slots.anthropic!.validation, resultCode: "PRIVATE_PROVIDER_TEXT" } } } })).toThrow();
      expect(() => parseCredentialMetadata({ ...populated(), slots: { ...populated().slots, anthropic: { ...populated().slots.anthropic, validation: { ...populated().slots.anthropic!.validation, definitive: false } } } })).toThrow();
      expect(parseCredentialMetadata({ ...populated(), slots: { ...populated().slots, anthropic: { ...populated().slots.anthropic, nickname: "N".repeat(40), authorizedBy: "A".repeat(40) } } }).slots.anthropic).toMatchObject({ nickname: "N".repeat(40), authorizedBy: "A".repeat(40) });
      expect(() => parseCredentialMetadata({ ...populated(), slots: { ...populated().slots, anthropic: { ...populated().slots.anthropic, nickname: "N".repeat(41) } } })).toThrowError(expect.objectContaining({ code: "METADATA_UNAVAILABLE" }));
      expect(() => parseCredentialMetadata({ ...populated(), slots: { ...populated().slots, anthropic: { ...populated().slots.anthropic, authorizedBy: "A".repeat(41) } } })).toThrowError(expect.objectContaining({ code: "METADATA_UNAVAILABLE" }));
      expect(() => parseCredentialMetadata({ ...populated(), slots: { ...populated().slots, anthropic: { ...populated().slots.anthropic, nickname: "SYNTHETIC_SECRET_CANARY" } } })).toThrowError(expect.objectContaining({ code: "METADATA_UNAVAILABLE" }));
      expect(() => parseCredentialMetadata({ ...populated(), slots: { ...populated().slots, anthropic: { ...populated().slots.anthropic, nickname: Buffer.from("SYNTHETIC_SECRET_CANARY", "utf8").toString("base64") } } })).toThrowError(expect.objectContaining({ code: "METADATA_UNAVAILABLE" }));
      expect(() => parseCredentialMetadata({ ...populated(), slots: { ...populated().slots, anthropic: { ...populated().slots.anthropic, nickname: "YRANAC_TERCES_CITEHTNYS" } } })).toThrowError(expect.objectContaining({ code: "METADATA_UNAVAILABLE" }));
      expect(() => parseCredentialMetadata({ ...populated(), slots: { ...populated().slots, anthropic: { ...populated().slots.anthropic, nickname: "ＳＹＮＴＨＥＴＩＣ_ＳＥＣＲＥＴ_ＣＡＮＡＲＹ" } } })).toThrowError(expect.objectContaining({ code: "METADATA_UNAVAILABLE" }));
      expect(() => parseCredentialMetadata({ ...populated(), slots: { ...populated().slots, anthropic: { ...populated().slots.anthropic, nickname: "SYNTHETIC_CREDENTIAL_", authorizedBy: "VALUE" } } })).toThrowError(expect.objectContaining({ code: "METADATA_UNAVAILABLE" }));
      expect(() => parseCredentialMetadata({ ...populated(), activity: [{ ...populated().activity[0], text: `Imported ${["sk", "ant", "api03", "SYNTHETIC_ACTIVITY_CANARY"].join("-")}` }] })).toThrowError(expect.objectContaining({ code: "METADATA_UNAVAILABLE" }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("serializes concurrent writes so the file is always a complete strict snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-dev-os-credential-metadata-race-"));
    try {
      const store = createFileCredentialMetadataStore(root);
      const on = populated();
      const off = replaceSlotMetadata(on, "anthropic", { ...on.slots.anthropic!, enabled: false });
      await Promise.all([store.write(on), store.write(off)]);
      expect((await store.read()).slots.anthropic?.enabled).toBe(false);
      expect(await readdir(root)).toEqual(["credential-ui.v1.json"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("serializes read-modify-write updates against the latest committed snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-dev-os-credential-metadata-update-"));
    try {
      const store = createFileCredentialMetadataStore(root);
      await store.write(populated());
      await Promise.all([
        store.update((current) => replaceSlotMetadata(current, "openai", { ...current.slots.anthropic!, credentialId: `cred-${"4".repeat(32)}`, nickname: "Second" })),
        store.update((current) => replaceSlotMetadata(current, "anthropic", { ...current.slots.anthropic!, enabled: false })),
      ]);
      const final = await store.read();
      expect(final.slots.openai?.nickname).toBe("Second");
      expect(final.slots.anthropic?.enabled).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not poison file reads or later updates when one transform throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-dev-os-credential-metadata-transform-recovery-"));
    try {
      const store = createFileCredentialMetadataStore(root);
      await store.write(populated());
      const marker = new Error("synthetic-transform-failure");
      await expect(store.update(() => { throw marker; })).rejects.toBe(marker);
      expect(await store.read()).toEqual(populated());
      const recovered = await store.update((current) => replaceSlotMetadata(current, "anthropic", { ...current.slots.anthropic!, enabled: false }));
      expect(recovered.slots.anthropic?.enabled).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
