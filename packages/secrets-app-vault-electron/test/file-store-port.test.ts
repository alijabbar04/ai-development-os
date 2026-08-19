import { mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_VAULT_MAX_DOCUMENT_BYTES,
  AppVaultError,
  appVaultContainerBinding,
  createAppVaultManager,
  inspectVaultDocument,
} from "@ai-dev-os/secrets-app-vault";
import {
  createDeterministicAppVaultCryptoPort,
  createDeterministicAppVaultRandomPort,
  createMemoryAppVaultStoragePort,
} from "@ai-dev-os/secrets-app-vault/testing";
import {
  APP_VAULT_BACKUP_FILE_NAME,
  APP_VAULT_FILE_NAME,
  APP_VAULT_LOCK_FILE_NAME,
  APP_VAULT_TEMP_FILE_PATTERN,
  createNodeFileAppVaultStoragePort,
  type AppVaultFileFaultStage,
} from "../src/testing/index.js";

const IDENTITY = Object.freeze({ name: "AI Development OS", appDataPath: "C:\\Users\\Operator\\AppData\\Roaming" });
const BINDING = appVaultContainerBinding({ appIdentity: IDENTITY, backendKind: "deterministic-fake" });
const SECRET = "SYNTHETIC-FILE-STORE-CREDENTIAL-3B72";
const NOW = Date.parse("2026-08-19T09:00:00.000Z");

let suiteRoot = "";
let revisionOne = new Uint8Array();
let revisionTwo = new Uint8Array();

class Clock {
  value = NOW;
  now(): Date { return new Date(this.value); }
}

async function documents(): Promise<readonly [Uint8Array, Uint8Array]> {
  const clock = new Clock();
  const memory = createMemoryAppVaultStoragePort();
  const manager = createAppVaultManager({
    schemaVersion: 1,
    appIdentity: IDENTITY,
    clock,
    crypto: createDeterministicAppVaultCryptoPort(),
    storage: memory.port,
    random: createDeterministicAppVaultRandomPort(),
  });
  await manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
  const first = memory.snapshot().primary!;
  clock.value += 1_000;
  await manager.rotate({ slotId: "anthropic", secret: `${SECRET}-ROTATED`, expectRevision: 1 });
  return Object.freeze([new Uint8Array(first), new Uint8Array(memory.snapshot().primary!)]);
}

async function caseRoot(name: string): Promise<string> {
  const root = join(suiteRoot, name);
  await mkdir(root, { recursive: true });
  return root;
}

beforeAll(async () => {
  suiteRoot = await mkdtemp(join(tmpdir(), "ai-dev-os-app-vault-electron-"));
  [revisionOne, revisionTwo] = await documents();
});

afterAll(async () => {
  const expectedPrefix = join(tmpdir(), "ai-dev-os-app-vault-electron-");
  if (!suiteRoot.startsWith(expectedPrefix) || suiteRoot.length <= expectedPrefix.length) throw new Error("Refusing to remove an unexpected test directory.");
  await rm(suiteRoot, { recursive: true, force: true });
});

describe("real filesystem vault storage", () => {
  it("reads absence, atomically promotes revisions, and preserves the previous backup", async () => {
    const root = await caseRoot("round-trip");
    const port = await createNodeFileAppVaultStoragePort({ root, binding: BINDING, platform: "win32" });
    await expect(port.read()).resolves.toBeNull();
    await expect(port.readBackup()).resolves.toBeNull();
    await expect(port.writeAtomic({ bytes: revisionOne, expectedRevision: null })).resolves.toEqual({ revision: 1 });
    expect((await port.read())?.bytes).toEqual(revisionOne);
    await expect(port.writeAtomic({ bytes: revisionTwo, expectedRevision: 1 })).resolves.toEqual({ revision: 2 });
    expect((await port.read())?.bytes).toEqual(revisionTwo);
    expect((await port.readBackup())?.bytes).toEqual(revisionOne);
    expect(inspectVaultDocument((await port.read())!.bytes, BINDING).revision).toBe(2);
    expect(inspectVaultDocument((await port.readBackup())!.bytes, BINDING).revision).toBe(1);
  });

  it("checks optimistic revision inside the lock and leaves primary unchanged", async () => {
    const root = await caseRoot("revision-conflict");
    const port = await createNodeFileAppVaultStoragePort({ root, binding: BINDING, platform: "win32" });
    await port.writeAtomic({ bytes: revisionOne, expectedRevision: null });
    await expect(port.writeAtomic({ bytes: revisionTwo, expectedRevision: null })).rejects.toMatchObject({ code: "VAULT_REVISION_CONFLICT" });
    expect((await port.read())?.bytes).toEqual(revisionOne);
    await expect(port.writeAtomic({ bytes: revisionOne, expectedRevision: 1 })).rejects.toMatchObject({ code: "VAULT_REVISION_CONFLICT" });
    expect((await port.read())?.bytes).toEqual(revisionOne);
  });

  it("independently refuses to overwrite an unreadable primary", async () => {
    const root = await caseRoot("corrupt-refusal");
    const corrupt = new TextEncoder().encode('{"ciphertext":"unchanged"}');
    await writeFile(join(root, APP_VAULT_FILE_NAME), corrupt);
    const port = await createNodeFileAppVaultStoragePort({ root, binding: BINDING, platform: "win32" });
    await expect(port.writeAtomic({ bytes: revisionOne, expectedRevision: null })).rejects.toMatchObject({ code: "VAULT_CORRUPT" });
    expect(new Uint8Array(await readFile(join(root, APP_VAULT_FILE_NAME)))).toEqual(corrupt);
    await expect(stat(join(root, APP_VAULT_BACKUP_FILE_NAME))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a normal create when a backup exists without its primary", async () => {
    const root = await caseRoot("backup-only-refusal");
    const port = await createNodeFileAppVaultStoragePort({ root, binding: BINDING, platform: "win32" });
    await port.writeAtomic({ bytes: revisionOne, expectedRevision: null });
    await port.writeAtomic({ bytes: revisionTwo, expectedRevision: 1 });
    const backup = (await port.readBackup())!.bytes;
    await unlink(join(root, APP_VAULT_FILE_NAME));
    await expect(port.writeAtomic({ bytes: revisionOne, expectedRevision: null })).rejects.toMatchObject({ code: "VAULT_BACKUP_ONLY" });
    await expect(port.read()).resolves.toBeNull();
    expect((await port.readBackup())!.bytes).toEqual(backup);
  });

  it("restores an observed backup atomically and preserves the corrupt primary for forensics", async () => {
    const root = await caseRoot("explicit-restore");
    const port = await createNodeFileAppVaultStoragePort({ root, binding: BINDING, platform: "win32", now: () => new Date(NOW), idSource: () => "a".repeat(32) });
    await port.writeAtomic({ bytes: revisionOne, expectedRevision: null });
    await port.writeAtomic({ bytes: revisionTwo, expectedRevision: 1 });
    const corrupt = new TextEncoder().encode('{"corrupt":true}');
    await writeFile(join(root, APP_VAULT_FILE_NAME), corrupt);
    const primaryDigest = createHash("sha256").update(corrupt).digest("hex");
    const backupDigest = createHash("sha256").update(revisionOne).digest("hex");
    await expect(port.recoverAtomic({ mode: "restore-backup", bytes: revisionOne, expectedPrimaryDigest: primaryDigest, expectedBackupDigest: backupDigest })).resolves.toEqual({ revision: 1 });
    expect((await port.read())!.bytes).toEqual(revisionOne);
    expect((await port.readBackup())!.bytes).toEqual(revisionOne);
    const forensic = (await readdir(root)).find((name) => name.startsWith(`${APP_VAULT_FILE_NAME}.corrupt-`));
    expect(forensic).toBeDefined();
    expect(new Uint8Array(await readFile(join(root, forensic!)))).toEqual(corrupt);
    await expect(port.recoverAtomic({ mode: "restore-backup", bytes: revisionOne, expectedPrimaryDigest: primaryDigest, expectedBackupDigest: backupDigest })).rejects.toMatchObject({ code: "VAULT_REVISION_CONFLICT" });
  });

  it("preserves an orphaned backup on explicit start-over and labels identity-rebind evidence", async () => {
    const orphanRoot = await caseRoot("explicit-start-over");
    await writeFile(join(orphanRoot, APP_VAULT_BACKUP_FILE_NAME), revisionOne);
    const orphan = await createNodeFileAppVaultStoragePort({ root: orphanRoot, binding: BINDING, platform: "win32", now: () => new Date(NOW), idSource: () => "b".repeat(32) });
    const backupDigest = createHash("sha256").update(revisionOne).digest("hex");
    await expect(orphan.recoverAtomic({ mode: "start-over", bytes: revisionOne, expectedPrimaryDigest: null, expectedBackupDigest: backupDigest })).resolves.toEqual({ revision: 1 });
    expect((await readdir(orphanRoot)).some((name) => name.startsWith(`${APP_VAULT_FILE_NAME}.orphaned-backup-`))).toBe(true);

    const rebindRoot = await caseRoot("explicit-rebind");
    const rebind = await createNodeFileAppVaultStoragePort({ root: rebindRoot, binding: BINDING, platform: "win32", now: () => new Date(NOW), idSource: () => "c".repeat(32) });
    await rebind.writeAtomic({ bytes: revisionOne, expectedRevision: null });
    const primaryDigest = createHash("sha256").update(revisionOne).digest("hex");
    await expect(rebind.recoverAtomic({ mode: "rebind", bytes: revisionTwo, expectedPrimaryDigest: primaryDigest, expectedBackupDigest: null })).resolves.toEqual({ revision: 2 });
    expect((await readdir(rebindRoot)).some((name) => name.startsWith(`${APP_VAULT_FILE_NAME}.identity-mismatch-`))).toBe(true);
  });

  it("bounds file size before allocating or parsing the document", async () => {
    const root = await caseRoot("oversized-read");
    await writeFile(join(root, APP_VAULT_FILE_NAME), new Uint8Array(APP_VAULT_MAX_DOCUMENT_BYTES + 1));
    const port = await createNodeFileAppVaultStoragePort({ root, binding: BINDING, platform: "win32" });
    await expect(port.read()).rejects.toMatchObject({ code: "VAULT_CORRUPT" });
  });

  it("refuses an active lock and recovers only a stale lock whose owner is dead", async () => {
    const activeRoot = await caseRoot("active-lock");
    const activeLock = join(activeRoot, APP_VAULT_LOCK_FILE_NAME);
    await writeFile(activeLock, JSON.stringify({ createdAt: new Date(NOW).toISOString(), pid: 7001 }));
    const active = await createNodeFileAppVaultStoragePort({ root: activeRoot, binding: BINDING, platform: "win32", now: () => new Date(NOW), processAlive: () => true });
    await expect(active.writeAtomic({ bytes: revisionOne, expectedRevision: null })).rejects.toMatchObject({ code: "VAULT_BUSY" });
    expect(await readFile(activeLock, "utf8")).toContain("7001");
    await unlink(activeLock);

    const staleRoot = await caseRoot("stale-lock");
    const staleLock = join(staleRoot, APP_VAULT_LOCK_FILE_NAME);
    await writeFile(staleLock, JSON.stringify({ createdAt: new Date(0).toISOString(), pid: 7002 }));
    await utimes(staleLock, new Date(0), new Date(0));
    const stale = await createNodeFileAppVaultStoragePort({ root: staleRoot, binding: BINDING, platform: "win32", now: () => new Date(NOW), processAlive: () => false });
    await expect(stale.writeAtomic({ bytes: revisionOne, expectedRevision: null })).resolves.toEqual({ revision: 1 });
    await expect(stat(staleLock)).rejects.toMatchObject({ code: "ENOENT" });

    const defaultProbeRoot = await caseRoot("stale-lock-default-probe");
    const defaultProbeLock = join(defaultProbeRoot, APP_VAULT_LOCK_FILE_NAME);
    await writeFile(defaultProbeLock, JSON.stringify({ createdAt: new Date(0).toISOString(), pid: 2_147_483_647 }));
    await utimes(defaultProbeLock, new Date(0), new Date(0));
    const defaultProbe = await createNodeFileAppVaultStoragePort({ root: defaultProbeRoot, binding: BINDING, platform: "win32", now: () => new Date(NOW) });
    await expect(defaultProbe.writeAtomic({ bytes: revisionOne, expectedRevision: null })).resolves.toEqual({ revision: 1 });
  });

  it("refuses malformed lock ownership, temp collisions and invalid storage clocks", async () => {
    const malformedRoot = await caseRoot("malformed-lock");
    const malformedLock = join(malformedRoot, APP_VAULT_LOCK_FILE_NAME);
    await writeFile(malformedLock, "{");
    await utimes(malformedLock, new Date(0), new Date(0));
    const malformed = await createNodeFileAppVaultStoragePort({ root: malformedRoot, binding: BINDING, platform: "win32", now: () => new Date(NOW), processAlive: () => false });
    await expect(malformed.writeAtomic({ bytes: revisionOne, expectedRevision: null })).rejects.toMatchObject({ code: "VAULT_BUSY" });
    await unlink(malformedLock);

    for (const [index, payload] of [
      "{}",
      JSON.stringify({ createdAt: new Date(0).toISOString(), pid: 0 }),
      JSON.stringify({ createdAt: 7, pid: 7003 }),
    ].entries()) {
      const root = await caseRoot(`invalid-lock-owner-${index}`);
      const lock = join(root, APP_VAULT_LOCK_FILE_NAME);
      await writeFile(lock, payload);
      await utimes(lock, new Date(0), new Date(0));
      const invalidOwner = await createNodeFileAppVaultStoragePort({ root, binding: BINDING, platform: "win32", now: () => new Date(NOW), processAlive: () => false });
      await expect(invalidOwner.writeAtomic({ bytes: revisionOne, expectedRevision: null })).rejects.toMatchObject({ code: "VAULT_BUSY" });
      await unlink(lock);
    }

    const collisionRoot = await caseRoot("temp-collisions");
    const collision = await createNodeFileAppVaultStoragePort({ root: collisionRoot, binding: BINDING, platform: "win32", idSource: () => "a".repeat(32) });
    await writeFile(join(collisionRoot, "tmp", `w-${"a".repeat(32)}.tmp`), "occupied");
    await expect(collision.writeAtomic({ bytes: revisionOne, expectedRevision: null })).rejects.toMatchObject({ code: "STORAGE_FAILURE" });

    const clockRoot = await caseRoot("invalid-clock");
    const invalidClock = await createNodeFileAppVaultStoragePort({ root: clockRoot, binding: BINDING, now: () => new Date(Number.NaN) });
    await expect(invalidClock.writeAtomic({ bytes: revisionOne, expectedRevision: null })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    for (const [index, shadow] of ["valueOf", "toISOString"].entries()) {
      const date = new Date(NOW);
      Object.defineProperty(date, shadow, { value: () => shadow === "valueOf" ? Date.parse(NOW) : `${SECRET}-clock` });
      const root = await caseRoot(`shadowed-clock-${index}`);
      const port = await createNodeFileAppVaultStoragePort({ root, binding: BINDING, now: () => date });
      const error = await port.writeAtomic({ bytes: revisionOne, expectedRevision: null }).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "INVALID_CONFIGURATION" });
      expect(JSON.stringify(error)).not.toContain(SECRET);
    }
  });

  it("maps filesystem preparation and commit failures without paths", async () => {
    const parent = await caseRoot("root-is-file");
    const fileRoot = join(parent, "vault-file");
    await writeFile(fileRoot, "not-a-directory");
    await expect(createNodeFileAppVaultStoragePort({ root: fileRoot, binding: BINDING })).rejects.toMatchObject({ code: "STORAGE_FAILURE" });

    const documentDirectoryRoot = await caseRoot("primary-is-directory");
    await mkdir(join(documentDirectoryRoot, APP_VAULT_FILE_NAME));
    const documentDirectory = await createNodeFileAppVaultStoragePort({ root: documentDirectoryRoot, binding: BINDING });
    const directoryError = await documentDirectory.read().catch((value: unknown) => value) as { code?: string };
    expect(["STORAGE_FAILURE", "VAULT_CORRUPT"]).toContain(directoryError.code);

    const backupRoot = await caseRoot("backup-is-directory");
    const port = await createNodeFileAppVaultStoragePort({ root: backupRoot, binding: BINDING, platform: "win32" });
    await port.writeAtomic({ bytes: revisionOne, expectedRevision: null });
    await mkdir(join(backupRoot, APP_VAULT_BACKUP_FILE_NAME));
    const error = await port.writeAtomic({ bytes: revisionTwo, expectedRevision: 1 }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "STORAGE_FAILURE" });
    expect(JSON.stringify(error)).not.toContain(backupRoot);
    expect((await port.read())?.bytes).toEqual(revisionOne);
  });

  it("performs the best-effort directory durability branch off Windows", async () => {
    const root = await caseRoot("posix-directory-sync-branch");
    const port = await createNodeFileAppVaultStoragePort({ root, binding: BINDING, platform: "linux" });
    await expect(port.writeAtomic({ bytes: revisionOne, expectedRevision: null })).resolves.toEqual({ revision: 1 });
    expect((await port.read())?.bytes).toEqual(revisionOne);
  });

  it("validates fixed-root and process configuration", async () => {
    await expect(createNodeFileAppVaultStoragePort({ root: "relative", binding: BINDING })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(createNodeFileAppVaultStoragePort({ root: "file:C:/vault", binding: BINDING })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(createNodeFileAppVaultStoragePort(null as never)).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    const root = await caseRoot("bad-config");
    await expect(createNodeFileAppVaultStoragePort({ root, binding: { ...BINDING, digest: "bad" } })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(createNodeFileAppVaultStoragePort({ root, binding: BINDING, processId: 0 })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    const badId = await createNodeFileAppVaultStoragePort({ root: await caseRoot("bad-id"), binding: BINDING, idSource: () => "unsafe" });
    await expect(badId.writeAtomic({ bytes: revisionOne, expectedRevision: null })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    const requestRoot = await caseRoot("bad-request");
    const requestPort = await createNodeFileAppVaultStoragePort({ root: requestRoot, binding: BINDING });
    await expect(requestPort.writeAtomic({ bytes: new Uint8Array(), expectedRevision: null })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(requestPort.writeAtomic({ bytes: revisionOne, expectedRevision: 0 })).rejects.toMatchObject({ code: "VAULT_REVISION_CONFLICT" });
    await expect(requestPort.recoverAtomic(null as never)).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(requestPort.recoverAtomic({ mode: "restore-backup", bytes: revisionOne, expectedPrimaryDigest: null, expectedBackupDigest: null })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(requestPort.recoverAtomic({ mode: "rebind", bytes: revisionOne, expectedPrimaryDigest: "a".repeat(64), expectedBackupDigest: "b".repeat(64) })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(requestPort.recoverAtomic(new Proxy({ mode: "start-over", bytes: revisionOne, expectedPrimaryDigest: null, expectedBackupDigest: "a".repeat(64) }, {}) as never)).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(requestPort.recoverAtomic({ mode: "future", bytes: revisionOne, expectedPrimaryDigest: null, expectedBackupDigest: null } as never)).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(requestPort.recoverAtomic({ mode: "start-over", bytes: new Uint8Array(), expectedPrimaryDigest: null, expectedBackupDigest: null })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(requestPort.recoverAtomic({ mode: "start-over", bytes: revisionOne, expectedPrimaryDigest: "bad", expectedBackupDigest: null })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(requestPort.recoverAtomic({ mode: "start-over", bytes: revisionOne, expectedPrimaryDigest: null, expectedBackupDigest: null, extra: true } as never)).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    let getterCalls = 0;
    const accessorRequest = Object.defineProperty({ mode: "start-over", bytes: revisionOne, expectedPrimaryDigest: null }, "expectedBackupDigest", {
      enumerable: true,
      get() { getterCalls += 1; return null; },
    });
    await expect(requestPort.recoverAtomic(accessorRequest as never)).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(getterCalls).toBe(0);

    const blockedTmpRoot = await caseRoot("blocked-tmp-directory");
    await writeFile(join(blockedTmpRoot, "tmp"), "not-a-directory");
    await expect(createNodeFileAppVaultStoragePort({ root: blockedTmpRoot, binding: BINDING })).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  });

  it("contains typed boundary faults and forensic-name failures", async () => {
    const typedRoot = await caseRoot("typed-boundary-fault");
    const typed = await createNodeFileAppVaultStoragePort({
      root: typedRoot,
      binding: BINDING,
      fault: (stage) => { if (stage === "before-lock") throw new AppVaultError("VAULT_BUSY", "typed-test-fault"); },
    });
    await expect(typed.writeAtomic({ bytes: revisionOne, expectedRevision: null })).rejects.toMatchObject({ code: "VAULT_BUSY", message: "typed-test-fault" });

    const invalidIdRoot = await caseRoot("invalid-forensic-id");
    const seed = await createNodeFileAppVaultStoragePort({ root: invalidIdRoot, binding: BINDING, platform: "win32" });
    await seed.writeAtomic({ bytes: revisionOne, expectedRevision: null });
    let idCalls = 0;
    const invalidId = await createNodeFileAppVaultStoragePort({
      root: invalidIdRoot,
      binding: BINDING,
      platform: "win32",
      idSource: () => idCalls++ === 0 ? "a".repeat(32) : "unsafe",
    });
    await expect(invalidId.recoverAtomic({ mode: "start-over", bytes: revisionOne, expectedPrimaryDigest: createHash("sha256").update(revisionOne).digest("hex"), expectedBackupDigest: null })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });

    const collisionRoot = await caseRoot("forensic-name-collisions");
    const collisionSeed = await createNodeFileAppVaultStoragePort({ root: collisionRoot, binding: BINDING, platform: "win32" });
    await collisionSeed.writeAtomic({ bytes: revisionOne, expectedRevision: null });
    const forensicId = "b".repeat(32);
    await writeFile(join(collisionRoot, `${APP_VAULT_FILE_NAME}.corrupt-20260819T090000000Z-${forensicId}`), "occupied");
    let collisionCalls = 0;
    const collision = await createNodeFileAppVaultStoragePort({
      root: collisionRoot,
      binding: BINDING,
      platform: "win32",
      now: () => new Date(NOW),
      idSource: () => collisionCalls++ === 0 ? "c".repeat(32) : forensicId,
    });
    await expect(collision.recoverAtomic({ mode: "start-over", bytes: revisionOne, expectedPrimaryDigest: createHash("sha256").update(revisionOne).digest("hex"), expectedBackupDigest: null })).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  });

  it("syncs successful non-Windows recovery and maps a foreign rename failure", async () => {
    const posixRoot = await caseRoot("posix-recovery-sync");
    await writeFile(join(posixRoot, APP_VAULT_BACKUP_FILE_NAME), revisionOne);
    const posix = await createNodeFileAppVaultStoragePort({ root: posixRoot, binding: BINDING, platform: "linux", idSource: () => "d".repeat(32) });
    await expect(posix.recoverAtomic({
      mode: "start-over",
      bytes: revisionOne,
      expectedPrimaryDigest: null,
      expectedBackupDigest: createHash("sha256").update(revisionOne).digest("hex"),
    })).resolves.toEqual({ revision: 1 });

    const renameRoot = await caseRoot("foreign-recovery-rename");
    const primaryPath = join(renameRoot, APP_VAULT_FILE_NAME);
    const renameFailure = await createNodeFileAppVaultStoragePort({
      root: renameRoot,
      binding: BINDING,
      platform: "win32",
      idSource: () => "e".repeat(32),
      fault: async (stage) => { if (stage === "before-recovery-rename") await mkdir(primaryPath); },
    });
    await expect(renameFailure.recoverAtomic({ mode: "start-over", bytes: revisionOne, expectedPrimaryDigest: null, expectedBackupDigest: null })).rejects.toMatchObject({ code: "STORAGE_FAILURE", message: "The explicit vault recovery commit failed." });
  });

  const faultStages: readonly AppVaultFileFaultStage[] = [
    "before-lock", "after-lock", "after-current-read", "after-temp-open", "after-temp-write", "after-temp-sync",
    "after-temp-close", "after-backup-copy", "after-backup-sync", "before-rename", "after-rename", "before-unlock",
  ];

  for (const [index, faultStage] of faultStages.entries()) {
    it(`contains the ${faultStage} write-boundary fault`, async () => {
      const root = await caseRoot(`fault-${index}`);
      const seed = await createNodeFileAppVaultStoragePort({ root, binding: BINDING, platform: "win32" });
      await seed.writeAtomic({ bytes: revisionOne, expectedRevision: null });
      const port = await createNodeFileAppVaultStoragePort({
        root,
        binding: BINDING,
        platform: "win32",
        fault: (stage) => { if (stage === faultStage) throw new Error(`foreign-${faultStage}`); },
      });
      const error = await port.writeAtomic({ bytes: revisionTwo, expectedRevision: 1 }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(AppVaultError);
      expect(JSON.stringify(error)).not.toContain("foreign-");
      const primary = (await port.read())!.bytes;
      const promoted = faultStage === "after-rename" || faultStage === "before-unlock";
      expect(primary).toEqual(promoted ? revisionTwo : revisionOne);
      expect(inspectVaultDocument(primary, BINDING).revision).toBe(promoted ? 2 : 1);
      const tempEntries = (await readdir(join(root, "tmp"))).filter((name) => APP_VAULT_TEMP_FILE_PATTERN.test(name));
      expect(tempEntries).toEqual([]);
      await expect(stat(join(root, APP_VAULT_LOCK_FILE_NAME))).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  const recoveryFaultStages: readonly AppVaultFileFaultStage[] = [
    "before-lock", "after-lock", "after-current-read", "after-temp-open", "after-temp-write", "after-temp-sync",
    "after-temp-close", "before-recovery-preserve", "after-recovery-preserve", "before-recovery-rename",
    "after-recovery-rename", "before-unlock",
  ];

  for (const [index, faultStage] of recoveryFaultStages.entries()) {
    it(`contains the ${faultStage} recovery-boundary fault`, async () => {
      const root = await caseRoot(`recovery-fault-${index}`);
      const seed = await createNodeFileAppVaultStoragePort({ root, binding: BINDING, platform: "win32" });
      await seed.writeAtomic({ bytes: revisionOne, expectedRevision: null });
      await seed.writeAtomic({ bytes: revisionTwo, expectedRevision: 1 });
      const corrupt = new TextEncoder().encode(`{"corrupt":${index}}`);
      await writeFile(join(root, APP_VAULT_FILE_NAME), corrupt);
      const primaryDigest = createHash("sha256").update(corrupt).digest("hex");
      const backupDigest = createHash("sha256").update(revisionOne).digest("hex");
      const port = await createNodeFileAppVaultStoragePort({
        root,
        binding: BINDING,
        platform: "win32",
        fault: (stage) => { if (stage === faultStage) throw new Error(`foreign-recovery-${faultStage}`); },
      });
      const error = await port.recoverAtomic({ mode: "restore-backup", bytes: revisionOne, expectedPrimaryDigest: primaryDigest, expectedBackupDigest: backupDigest }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(AppVaultError);
      expect(JSON.stringify(error)).not.toContain("foreign-recovery-");
      const landed = faultStage === "after-recovery-rename" || faultStage === "before-unlock";
      const primary = new Uint8Array(await readFile(join(root, APP_VAULT_FILE_NAME)));
      expect(primary).toEqual(landed ? revisionOne : corrupt);
      expect((await readdir(join(root, "tmp"))).filter((name) => APP_VAULT_TEMP_FILE_PATTERN.test(name))).toEqual([]);
      await expect(stat(join(root, APP_VAULT_LOCK_FILE_NAME))).rejects.toMatchObject({ code: "ENOENT" });
    });
  }
});
