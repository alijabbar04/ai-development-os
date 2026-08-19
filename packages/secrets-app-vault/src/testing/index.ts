import {
  AppVaultError,
  createAppVaultManagerForTesting,
  createAppVaultSecretBrokerForTesting,
  type AppVaultCryptoPort,
  type AppVaultStoragePort,
} from "../internal-testing.js";
import { createHash } from "node:crypto";

export type AppVaultMemoryFaultStage =
  | "read"
  | "read-backup"
  | "before-revision-check"
  | "after-revision-check"
  | "before-backup"
  | "after-backup"
  | "before-commit"
  | "after-commit"
  | "before-recovery-check"
  | "after-recovery-preserve"
  | "before-recovery-commit"
  | "after-recovery-commit";

export interface DeterministicAppVaultCryptoOptions {
  readonly available?: boolean | (() => boolean);
  readonly shouldReEncrypt?: boolean | (() => boolean);
  readonly failEncrypt?: boolean;
  readonly failDecrypt?: boolean | (() => boolean);
}

export interface MemoryAppVaultStorageOptions {
  readonly initialBytes?: Uint8Array;
  readonly initialBackupBytes?: Uint8Array;
  readonly fault?: (stage: AppVaultMemoryFaultStage) => void | Promise<void>;
}

export interface MemoryAppVaultStorageControl {
  readonly port: AppVaultStoragePort;
  snapshot(): Readonly<{ primary: Uint8Array | null; backup: Uint8Array | null; forensics: readonly Uint8Array[]; writes: number; recoveries: number; reads: number; backupReads: number }>;
  replacePrimary(bytes: Uint8Array | null): void;
  replaceBackup(bytes: Uint8Array | null): void;
}

function copy(value: Uint8Array | null): Uint8Array | null {
  return value === null ? null : new Uint8Array(value);
}

function documentRevision(bytes: Uint8Array): number {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid");
    const descriptor = Object.getOwnPropertyDescriptor(parsed, "revision");
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "number" || !Number.isSafeInteger(descriptor.value) || descriptor.value < 1) throw new Error("invalid");
    return descriptor.value;
  } catch { throw new AppVaultError("VAULT_CORRUPT", "The memory vault contains an unreadable document."); }
}

export function createMemoryAppVaultStoragePort(options: MemoryAppVaultStorageOptions = {}): MemoryAppVaultStorageControl {
  let primary = copy(options.initialBytes ?? null);
  let backup = copy(options.initialBackupBytes ?? null);
  const forensics: Uint8Array[] = [];
  let writes = 0;
  let recoveries = 0;
  let reads = 0;
  let backupReads = 0;
  const hit = async (stage: AppVaultMemoryFaultStage): Promise<void> => { await options.fault?.(stage); };
  const port: AppVaultStoragePort = Object.freeze({
    async read() {
      await hit("read");
      reads += 1;
      return primary === null ? null : Object.freeze({ bytes: new Uint8Array(primary) });
    },
    async readBackup() {
      await hit("read-backup");
      backupReads += 1;
      return backup === null ? null : Object.freeze({ bytes: new Uint8Array(backup) });
    },
    async writeAtomic(input: Parameters<AppVaultStoragePort["writeAtomic"]>[0]) {
      await hit("before-revision-check");
      const actual = primary === null ? null : documentRevision(primary);
      if (primary === null && backup !== null) throw new AppVaultError("VAULT_BACKUP_ONLY", "A backup exists without its primary vault.");
      if (actual !== input.expectedRevision) throw new AppVaultError("VAULT_REVISION_CONFLICT", "The memory vault revision changed.");
      await hit("after-revision-check");
      const next = documentRevision(input.bytes);
      if (next !== (actual ?? 0) + 1) throw new AppVaultError("VAULT_REVISION_CONFLICT", "The next memory vault revision is invalid.");
      await hit("before-backup");
      backup = copy(primary);
      await hit("after-backup");
      await hit("before-commit");
      primary = new Uint8Array(input.bytes);
      writes += 1;
      await hit("after-commit");
      return Object.freeze({ revision: next });
    },
    async recoverAtomic(input: Parameters<AppVaultStoragePort["recoverAtomic"]>[0]) {
      await hit("before-recovery-check");
      const digest = (bytes: Uint8Array | null): string | null => bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
      if (digest(primary) !== input.expectedPrimaryDigest) throw new AppVaultError("VAULT_REVISION_CONFLICT", "The memory vault primary changed before recovery.");
      if (input.mode !== "rebind" && digest(backup) !== input.expectedBackupDigest) throw new AppVaultError("VAULT_REVISION_CONFLICT", "The memory vault backup changed before recovery.");
      const next = documentRevision(input.bytes);
      if (primary !== null) forensics.push(new Uint8Array(primary));
      else if (backup !== null) forensics.push(new Uint8Array(backup));
      await hit("after-recovery-preserve");
      await hit("before-recovery-commit");
      primary = new Uint8Array(input.bytes);
      recoveries += 1;
      await hit("after-recovery-commit");
      return Object.freeze({ revision: next });
    },
  });
  return Object.freeze({
    port,
    snapshot: () => Object.freeze({ primary: copy(primary), backup: copy(backup), forensics: Object.freeze(forensics.map((bytes) => new Uint8Array(bytes))), writes, recoveries, reads, backupReads }),
    replacePrimary(bytes: Uint8Array | null) { primary = copy(bytes); },
    replaceBackup(bytes: Uint8Array | null) { backup = copy(bytes); },
  });
}

export function createDeterministicAppVaultCryptoPort(options: DeterministicAppVaultCryptoOptions = {}): AppVaultCryptoPort {
  const available = (): boolean => typeof options.available === "function" ? options.available() : options.available ?? true;
  const reencrypt = (): boolean => typeof options.shouldReEncrypt === "function" ? options.shouldReEncrypt() : options.shouldReEncrypt ?? false;
  const failDecrypt = (): boolean => typeof options.failDecrypt === "function" ? options.failDecrypt() : options.failDecrypt ?? false;
  return Object.freeze({
    async isAvailable() { return available(); },
    async encrypt(plainText: string) {
      if (options.failEncrypt === true) throw new Error("deterministic-encrypt-failure");
      const input = new TextEncoder().encode(plainText);
      const output = new Uint8Array(input.byteLength + 4);
      output.set([0x41, 0x56, 0x31, 0x00]);
      for (let index = 0; index < input.byteLength; index += 1) output[index + 4] = input[index]! ^ 0xa5;
      input.fill(0);
      return output;
    },
    async decrypt(cipher: Uint8Array) {
      if (failDecrypt()) throw new Error("deterministic-decrypt-failure");
      if (cipher.byteLength < 5 || cipher[0] !== 0x41 || cipher[1] !== 0x56 || cipher[2] !== 0x31 || cipher[3] !== 0x00) throw new Error("deterministic-malformed-ciphertext");
      const plain = new Uint8Array(cipher.byteLength - 4);
      for (let index = 0; index < plain.byteLength; index += 1) plain[index] = cipher[index + 4]! ^ 0xa5;
      try { return Object.freeze({ result: new TextDecoder("utf-8", { fatal: true }).decode(plain), shouldReEncrypt: reencrypt() }); }
      finally { plain.fill(0); }
    },
    describeBackend: () => Object.freeze({ kind: "deterministic-fake" as const }),
  });
}

export function createDeterministicAppVaultRandomPort(seed = 17): Readonly<{ bytes(length: number): Uint8Array }> {
  let state = seed >>> 0;
  return Object.freeze({
    bytes(length: number) {
      if (!Number.isSafeInteger(length) || length < 1 || length > 65_536) throw new Error("invalid-deterministic-length");
      const output = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        output[index] = state & 0xff;
      }
      return output;
    },
  });
}

export {
  createAppVaultSecretBrokerForTesting,
  createAppVaultManagerForTesting,
};
