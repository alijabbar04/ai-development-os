import { createHash, randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { types } from "node:util";
import {
  APP_VAULT_MAX_DOCUMENT_BYTES,
  AppVaultError,
  inspectVaultDocument,
  type AppVaultContainerBinding,
  type AppVaultStoragePort,
} from "@ai-dev-os/secrets-app-vault";

export const APP_VAULT_FILE_NAME = "app-vault.v1.json" as const;
export const APP_VAULT_BACKUP_FILE_NAME = "app-vault.v1.json.bak" as const;
export const APP_VAULT_LOCK_FILE_NAME = "app-vault.v1.lock" as const;
export const APP_VAULT_STALE_LOCK_MS = 30_000 as const;
export const APP_VAULT_TEMP_FILE_PATTERN = /^w-[a-f0-9]{32}\.tmp$/u;

export type AppVaultFileFaultStage =
  | "before-lock"
  | "after-lock"
  | "after-current-read"
  | "after-temp-open"
  | "after-temp-write"
  | "after-temp-sync"
  | "after-temp-close"
  | "after-backup-copy"
  | "after-backup-sync"
  | "before-rename"
  | "after-rename"
  | "before-recovery-preserve"
  | "after-recovery-preserve"
  | "before-recovery-rename"
  | "after-recovery-rename"
  | "before-unlock";

export interface NodeFileAppVaultStorageOptions {
  readonly root: string;
  readonly binding: AppVaultContainerBinding;
  readonly platform?: string;
  readonly now?: () => Date;
  readonly processId?: number;
  readonly processAlive?: (processId: number) => boolean;
  readonly idSource?: () => string;
  readonly fault?: (stage: AppVaultFileFaultStage) => void | Promise<void>;
}

const writeTails = new Map<string, Promise<void>>();

function systemCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function storageFailure(message: string): AppVaultError {
  return new AppVaultError("STORAGE_FAILURE", message);
}

function digest(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
}

function basicTimestamp(value: Date): string {
  return value.toISOString().replace(/[-:.]/gu, "");
}

function finiteDate(now: () => Date): Date {
  try {
    const value = now();
    if (
      !(value instanceof Date)
      || Object.prototype.hasOwnProperty.call(value, "valueOf")
      || Object.prototype.hasOwnProperty.call(value, "toISOString")
    ) throw new Error("invalid-clock");
    const milliseconds = Date.prototype.valueOf.call(value);
    if (!Number.isFinite(milliseconds)) throw new Error("invalid-clock");
    return new Date(milliseconds);
  } catch { throw new AppVaultError("INVALID_CONFIGURATION", "The vault storage clock is invalid."); }
}

function defaultProcessAlive(processId: number): boolean {
  try { process.kill(processId, 0); return true; }
  catch (error) { return systemCode(error) !== "ESRCH"; }
}

async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = writeTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  writeTails.set(key, current);
  await prior;
  try { return await work(); }
  finally {
    release();
    if (writeTails.get(key) === current) writeTails.delete(key);
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesWritten < 1) throw storageFailure("A vault file write made no progress.");
    offset += result.bytesWritten;
  }
}

async function readBounded(path: string): Promise<Uint8Array | null> {
  let handle: FileHandle;
  try { handle = await open(path, "r"); }
  catch (error) {
    if (systemCode(error) === "ENOENT") return null;
    throw storageFailure("The vault document could not be opened.");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > APP_VAULT_MAX_DOCUMENT_BYTES) throw new AppVaultError("VAULT_CORRUPT", "The vault document has an invalid size or type.");
    const bytes = new Uint8Array(info.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) throw new AppVaultError("VAULT_CORRUPT", "The vault document changed while it was read.");
      offset += result.bytesRead;
    }
    const extra = new Uint8Array(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) throw new AppVaultError("VAULT_CORRUPT", "The vault document exceeds its declared size.");
    return bytes;
  } catch (error) {
    if (error instanceof AppVaultError) throw error;
    throw storageFailure("The vault document could not be read.");
  } finally {
    try { await handle.close(); } catch { /* best effort */ }
  }
}

function lockOwner(bytes: Uint8Array): number | null {
  try {
    if (bytes.byteLength > 256) return null;
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value) || Reflect.ownKeys(value).length !== 2) return null;
    const pid = Object.getOwnPropertyDescriptor(value, "pid");
    const createdAt = Object.getOwnPropertyDescriptor(value, "createdAt");
    if (pid === undefined || !("value" in pid) || typeof pid.value !== "number" || !Number.isSafeInteger(pid.value) || pid.value < 1) return null;
    if (createdAt === undefined || !("value" in createdAt) || typeof createdAt.value !== "string") return null;
    return pid.value;
  } catch { return null; }
}

async function readSmall(path: string): Promise<Uint8Array | null> {
  let handle: FileHandle;
  try { handle = await open(path, "r"); }
  catch (error) { if (systemCode(error) === "ENOENT") return null; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > 256) return null;
    const bytes = new Uint8Array(info.size);
    const result = await handle.read(bytes, 0, bytes.byteLength, 0);
    return result.bytesRead === bytes.byteLength ? bytes : null;
  } finally { try { await handle.close(); } catch { /* best effort */ } }
}

async function acquireLock(options: {
  lockPath: string;
  now: () => Date;
  processId: number;
  processAlive: (processId: number) => boolean;
}): Promise<FileHandle> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(options.lockPath, "wx");
      try {
        const payload = new TextEncoder().encode(JSON.stringify({ createdAt: finiteDate(options.now).toISOString(), pid: options.processId }));
        await writeAll(handle, payload);
        await handle.sync();
        return handle;
      } catch (error) {
        try { await handle.close(); } catch { /* best effort */ }
        try { await unlink(options.lockPath); } catch { /* best effort */ }
        throw error;
      }
    } catch (error) {
      if (error instanceof AppVaultError) throw error;
      if (systemCode(error) !== "EEXIST") throw storageFailure("The vault writer lock could not be acquired.");
      if (attempt > 0) break;
      try {
        const info = await stat(options.lockPath);
        const age = finiteDate(options.now).valueOf() - info.mtimeMs;
        const bytes = await readSmall(options.lockPath);
        const owner = bytes === null ? null : lockOwner(bytes);
        if (age <= APP_VAULT_STALE_LOCK_MS || owner === null || options.processAlive(owner)) break;
        await unlink(options.lockPath);
      } catch (inspectionError) {
        if (systemCode(inspectionError) !== "ENOENT") break;
      }
    }
  }
  throw new AppVaultError("VAULT_BUSY", "Another vault writer is active.");
}

async function createTemp(options: { tmpPath: string; idSource: () => string }): Promise<{ path: string; handle: FileHandle }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = options.idSource();
    if (!/^[a-f0-9]{32}$/u.test(id)) throw new AppVaultError("INVALID_CONFIGURATION", "The vault temporary-name source is invalid.");
    const path = join(options.tmpPath, `w-${id}.tmp`);
    try { return { path, handle: await open(path, "wx") }; }
    catch (error) { if (systemCode(error) !== "EEXIST") throw storageFailure("The vault temporary file could not be created."); }
  }
  throw storageFailure("The vault temporary-file names kept colliding.");
}

async function preserveForensics(options: {
  sourcePath: string;
  root: string;
  label: "corrupt" | "identity-mismatch" | "orphaned-backup";
  now: () => Date;
  idSource: () => string;
}): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = options.idSource();
    if (!/^[a-f0-9]{32}$/u.test(id)) throw new AppVaultError("INVALID_CONFIGURATION", "The vault forensic-name source is invalid.");
    const path = join(options.root, `${APP_VAULT_FILE_NAME}.${options.label}-${basicTimestamp(finiteDate(options.now))}-${id}`);
    try {
      await copyFile(options.sourcePath, path, fsConstants.COPYFILE_EXCL);
      const handle = await open(path, "r+");
      try { await handle.sync(); }
      finally { await handle.close(); }
      return;
    } catch (error) {
      if (systemCode(error) !== "EEXIST") throw storageFailure("The vault recovery evidence could not be preserved.");
    }
  }
  throw storageFailure("The vault forensic-file names kept colliding.");
}

export async function createNodeFileAppVaultStoragePort(options: NodeFileAppVaultStorageOptions): Promise<AppVaultStoragePort> {
  if (typeof options !== "object" || options === null || Object.getPrototypeOf(options) !== Object.prototype) throw new AppVaultError("INVALID_CONFIGURATION", "The vault storage options are invalid.");
  if (typeof options.root !== "string" || options.root.length < 3 || options.root.length > 1_024 || options.root.includes("\u0000") || options.root.startsWith("file:") || !isAbsolute(options.root)) throw new AppVaultError("INVALID_CONFIGURATION", "The vault storage root must be an absolute filesystem path.");
  if (typeof options.binding !== "object" || options.binding === null || !/^[a-f0-9]{64}$/u.test(options.binding.digest)) throw new AppVaultError("INVALID_CONFIGURATION", "The vault container binding is invalid.");
  const platform = options.platform ?? process.platform;
  const now = options.now ?? (() => new Date());
  const processId = options.processId ?? process.pid;
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const idSource = options.idSource ?? (() => randomBytes(16).toString("hex"));
  if (!Number.isSafeInteger(processId) || processId < 1 || typeof processAlive !== "function" || typeof idSource !== "function" || typeof now !== "function") throw new AppVaultError("INVALID_CONFIGURATION", "The vault storage process options are invalid.");
  let root: string;
  try {
    await mkdir(resolve(options.root), { recursive: true });
    root = await realpath(resolve(options.root));
  } catch { throw storageFailure("The vault storage root could not be prepared."); }
  let tmpPath = join(root, "tmp");
  try {
    await mkdir(tmpPath, { recursive: true });
    tmpPath = await realpath(tmpPath);
  }
  catch { throw storageFailure("The vault temporary directory could not be prepared."); }
  if (tmpPath !== root && !tmpPath.startsWith(root + sep)) throw new AppVaultError("INVALID_CONFIGURATION", "The vault temporary directory escaped its root.");
  const primaryPath = join(root, APP_VAULT_FILE_NAME);
  const backupPath = join(root, APP_VAULT_BACKUP_FILE_NAME);
  const lockPath = join(root, APP_VAULT_LOCK_FILE_NAME);
  for (const path of [tmpPath, primaryPath, backupPath, lockPath]) {
    if (path !== root && !path.startsWith(root + sep)) throw new AppVaultError("INVALID_CONFIGURATION", "A vault storage path escaped its root.");
  }
  const fault = async (stage: AppVaultFileFaultStage): Promise<void> => {
    try { await options.fault?.(stage); }
    catch (error) { if (error instanceof AppVaultError) throw error; throw storageFailure("The atomic vault write boundary failed."); }
  };

  return Object.freeze({
    async read() {
      const bytes = await readBounded(primaryPath);
      return bytes === null ? null : Object.freeze({ bytes });
    },
    async readBackup() {
      const bytes = await readBounded(backupPath);
      return bytes === null ? null : Object.freeze({ bytes });
    },
    async writeAtomic(input: Parameters<AppVaultStoragePort["writeAtomic"]>[0]) {
      if (typeof input !== "object" || input === null || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 2 || input.bytes.byteLength > APP_VAULT_MAX_DOCUMENT_BYTES) throw new AppVaultError("INVALID_CONFIGURATION", "The vault write request is invalid.");
      if (input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) throw new AppVaultError("VAULT_REVISION_CONFLICT", "The expected vault revision is invalid.");
      const ownedBytes = new Uint8Array(input.bytes);
      const incoming = inspectVaultDocument(ownedBytes, options.binding);
      return await serial(primaryPath, async () => {
        await fault("before-lock");
        const lock = await acquireLock({ lockPath, now, processId, processAlive });
        let tempPath: string | null = null;
        try {
          await fault("after-lock");
          const currentBytes = await readBounded(primaryPath);
          if (currentBytes === null && await readBounded(backupPath) !== null) throw new AppVaultError("VAULT_BACKUP_ONLY", "A backup exists without its primary vault and requires explicit recovery.");
          const current = currentBytes === null ? null : inspectVaultDocument(currentBytes, options.binding);
          await fault("after-current-read");
          const actualRevision = current?.revision ?? null;
          if (actualRevision !== input.expectedRevision || incoming.revision !== (actualRevision ?? 0) + 1) throw new AppVaultError("VAULT_REVISION_CONFLICT", "The vault revision changed before commit.");
          const temp = await createTemp({ tmpPath, idSource });
          tempPath = temp.path;
          let tempHandle: FileHandle | null = temp.handle;
          try {
            await fault("after-temp-open");
            await writeAll(tempHandle, ownedBytes);
            await fault("after-temp-write");
            await tempHandle.sync();
            await fault("after-temp-sync");
            await tempHandle.close(); tempHandle = null;
            await fault("after-temp-close");
          } finally { if (tempHandle !== null) { try { await tempHandle.close(); } catch { /* best effort */ } } }
          if (currentBytes !== null) {
            await copyFile(primaryPath, backupPath);
            await fault("after-backup-copy");
            const backupHandle = await open(backupPath, "r+");
            try { await backupHandle.sync(); }
            finally { await backupHandle.close(); }
            await fault("after-backup-sync");
          }
          await fault("before-rename");
          await rename(tempPath, primaryPath);
          tempPath = null;
          await fault("after-rename");
          if (platform !== "win32") {
            try {
              const directory = await open(root, "r");
              try { await directory.sync(); }
              finally { await directory.close(); }
            } catch { /* best-effort directory-entry durability */ }
          }
          return Object.freeze({ revision: incoming.revision });
        } catch (error) {
          if (error instanceof AppVaultError) throw error;
          throw storageFailure("The atomic vault write failed.");
        } finally {
          if (tempPath !== null) { try { await unlink(tempPath); } catch { /* best effort */ } }
          try { await fault("before-unlock"); }
          finally {
            try { await lock.close(); } catch { /* best effort */ }
            try { await unlink(lockPath); } catch { /* best effort */ }
          }
        }
      });
    },
    async recoverAtomic(input: Parameters<AppVaultStoragePort["recoverAtomic"]>[0]) {
      if (typeof input !== "object" || input === null || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new AppVaultError("INVALID_CONFIGURATION", "The vault recovery request is invalid.");
      const keys = Reflect.ownKeys(input);
      const expectedKeys = ["mode", "bytes", "expectedPrimaryDigest", "expectedBackupDigest"];
      if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) throw new AppVaultError("INVALID_CONFIGURATION", "The vault recovery request is invalid.");
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (expectedKeys.some((key) => descriptors[key] === undefined || !("value" in descriptors[key]!))) throw new AppVaultError("INVALID_CONFIGURATION", "The vault recovery request is invalid.");
      const mode = descriptors["mode"]!.value;
      const bytes = descriptors["bytes"]!.value;
      const expectedPrimaryDigest = descriptors["expectedPrimaryDigest"]!.value;
      const expectedBackupDigest = descriptors["expectedBackupDigest"]!.value;
      const token = (value: unknown, nullable: boolean): value is string | null => (nullable && value === null) || (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
      if ((mode !== "restore-backup" && mode !== "start-over" && mode !== "rebind") || !(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > APP_VAULT_MAX_DOCUMENT_BYTES) throw new AppVaultError("INVALID_CONFIGURATION", "The vault recovery request is invalid.");
      if (!token(expectedPrimaryDigest, mode !== "rebind") || !token(expectedBackupDigest, true)) throw new AppVaultError("INVALID_CONFIGURATION", "The vault recovery observation token is invalid.");
      if (mode === "restore-backup" && expectedBackupDigest === null) throw new AppVaultError("INVALID_CONFIGURATION", "Backup restoration requires an observed backup.");
      if (mode === "rebind" && expectedBackupDigest !== null) throw new AppVaultError("INVALID_CONFIGURATION", "Identity rebind does not accept a backup observation.");
      const ownedBytes = new Uint8Array(bytes);
      const incoming = inspectVaultDocument(ownedBytes, options.binding);
      return await serial(primaryPath, async () => {
        await fault("before-lock");
        const lock = await acquireLock({ lockPath, now, processId, processAlive });
        let tempPath: string | null = null;
        try {
          await fault("after-lock");
          const currentBytes = await readBounded(primaryPath);
          const backupBytes = mode === "rebind" ? null : await readBounded(backupPath);
          await fault("after-current-read");
          if (digest(currentBytes) !== expectedPrimaryDigest || (mode !== "rebind" && digest(backupBytes) !== expectedBackupDigest)) throw new AppVaultError("VAULT_REVISION_CONFLICT", "The vault changed before explicit recovery.");
          const temp = await createTemp({ tmpPath, idSource });
          tempPath = temp.path;
          let tempHandle: FileHandle | null = temp.handle;
          try {
            await fault("after-temp-open");
            await writeAll(tempHandle, ownedBytes);
            await fault("after-temp-write");
            await tempHandle.sync();
            await fault("after-temp-sync");
            await tempHandle.close(); tempHandle = null;
            await fault("after-temp-close");
          } finally { if (tempHandle !== null) { try { await tempHandle.close(); } catch { /* best effort */ } } }
          await fault("before-recovery-preserve");
          if (currentBytes !== null) {
            await preserveForensics({
              sourcePath: primaryPath,
              root,
              label: mode === "rebind" ? "identity-mismatch" : "corrupt",
              now,
              idSource,
            });
          } else if (backupBytes !== null) {
            await preserveForensics({ sourcePath: backupPath, root, label: "orphaned-backup", now, idSource });
          }
          await fault("after-recovery-preserve");
          await fault("before-recovery-rename");
          await rename(tempPath, primaryPath);
          tempPath = null;
          await fault("after-recovery-rename");
          if (platform !== "win32") {
            try {
              const directory = await open(root, "r");
              try { await directory.sync(); }
              finally { await directory.close(); }
            } catch { /* best-effort directory-entry durability */ }
          }
          return Object.freeze({ revision: incoming.revision });
        } catch (error) {
          if (error instanceof AppVaultError) throw error;
          throw storageFailure("The explicit vault recovery commit failed.");
        } finally {
          if (tempPath !== null) { try { await unlink(tempPath); } catch { /* best effort */ } }
          try { await fault("before-unlock"); }
          finally {
            try { await lock.close(); } catch { /* best effort */ }
            try { await unlink(lockPath); } catch { /* best effort */ }
          }
        }
      });
    },
  });
}
