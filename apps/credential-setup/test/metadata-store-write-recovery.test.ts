import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const renameControl = vi.hoisted(() => ({ failNext: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async rename(oldPath: Parameters<typeof actual.rename>[0], newPath: Parameters<typeof actual.rename>[1]) {
      if (renameControl.failNext) {
        renameControl.failNext = false;
        throw Object.assign(new Error("synthetic-one-shot-rename-failure"), { code: "EACCES" });
      }
      await actual.rename(oldPath, newPath);
    },
  };
});

import { createFileCredentialMetadataStore, emptyCredentialMetadata, replaceSlotMetadata } from "../src/main/metadata-store.js";

function populated() {
  return replaceSlotMetadata(emptyCredentialMetadata(), "anthropic", {
    credentialId: `cred-${"1".repeat(32)}`,
    nickname: "Synthetic",
    ownership: "owned",
    authorizedBy: "",
    enabled: true,
    validation: null,
    lastValidationAttempt: null,
  });
}

describe("file metadata write recovery", () => {
  it("keeps the last committed bytes readable and accepts a later update after one disk write fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-dev-os-credential-metadata-write-recovery-"));
    try {
      const store = createFileCredentialMetadataStore(root);
      await store.write(populated());
      const target = join(root, "credential-ui.v1.json");
      const beforeBytes = await readFile(target);
      renameControl.failNext = true;
      await expect(store.update((current) => replaceSlotMetadata(current, "anthropic", { ...current.slots.anthropic!, enabled: false }))).rejects.toMatchObject({ code: "METADATA_UNAVAILABLE" });
      expect(await readFile(target)).toEqual(beforeBytes);
      expect((await store.read()).slots.anthropic?.enabled).toBe(true);
      const recovered = await store.update((current) => replaceSlotMetadata(current, "anthropic", { ...current.slots.anthropic!, enabled: false }));
      expect(recovered.slots.anthropic?.enabled).toBe(false);
      expect((await store.read()).slots.anthropic?.enabled).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
