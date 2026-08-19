import type {
  SecretAuditHook,
  SecretBroker,
  SecretClock,
  SecretRef,
} from "@ai-dev-os/secrets";

export const APP_VAULT_BROKER_SCHEMA_VERSION = 1 as const;
export const APP_VAULT_DOCUMENT_SCHEMA_VERSION = 1 as const;
export const APP_VAULT_CONTAINER_ID = "app-vault.v1" as const;
export const APP_VAULT_MAX_DOCUMENT_BYTES = 1_048_576 as const;
export const APP_VAULT_MAX_SECRET_BYTES = 8_192 as const;
export const APP_VAULT_MAX_RECORDS = 32 as const;
export const APP_VAULT_MAX_CIPHER_TEXT_CHARS = 12_288 as const;

export const APP_VAULT_BACKEND_KINDS = Object.freeze([
  "electron-safe-storage-async",
  "deterministic-fake",
] as const);
export type AppVaultBackendKind = (typeof APP_VAULT_BACKEND_KINDS)[number];

export interface AppVaultCryptoPort {
  isAvailable(): Promise<boolean>;
  encrypt(plainText: string): Promise<Uint8Array>;
  decrypt(cipher: Uint8Array): Promise<Readonly<{ result: string; shouldReEncrypt: boolean }>>;
  describeBackend(): Readonly<{ kind: AppVaultBackendKind }>;
}

export interface AppVaultStoragePort {
  read(): Promise<Readonly<{ bytes: Uint8Array }> | null>;
  readBackup(): Promise<Readonly<{ bytes: Uint8Array }> | null>;
  writeAtomic(input: Readonly<{
    bytes: Uint8Array;
    expectedRevision: number | null;
  }>): Promise<Readonly<{ revision: number }>>;
  recoverAtomic(input: Readonly<{
    mode: AppVaultRecoveryAction;
    bytes: Uint8Array;
    expectedPrimaryDigest: string | null;
    expectedBackupDigest: string | null;
  }>): Promise<Readonly<{ revision: number }>>;
}

export interface AppVaultClockPort extends SecretClock {}

export interface AppVaultRandomPort {
  bytes(length: number): Uint8Array;
}

export interface AppVaultAppIdentity {
  readonly name: string;
  readonly appDataPath: string;
}

export interface AppVaultBrokerOptions {
  readonly schemaVersion: typeof APP_VAULT_BROKER_SCHEMA_VERSION;
  readonly reference: SecretRef;
  readonly appIdentity: AppVaultAppIdentity;
  readonly clock: AppVaultClockPort;
  readonly crypto: AppVaultCryptoPort;
  readonly storage: AppVaultStoragePort;
  readonly random?: AppVaultRandomPort;
  readonly audit?: SecretAuditHook;
}

export type AppVaultRecordState = "present" | "revoked" | "unrecoverable";
export type AppVaultValidationOutcome =
  | "valid"
  | "invalid"
  | "unauthorized"
  | "ambiguous"
  | "unreachable";

export interface AppVaultRecordSummary {
  readonly slotId: string;
  readonly state: AppVaultRecordState | "absent";
  readonly revision: number | null;
  readonly generation: number | null;
  readonly createdAt: string | null;
  readonly rotatedAt: string | null;
  readonly revokedAt: string | null;
  readonly lastValidation: Readonly<{
    outcome: AppVaultValidationOutcome;
    checkedAt: string;
  }> | null;
}

export type AppVaultState =
  | "absent"
  | "ready"
  | "backup-only"
  | "corrupt"
  | "identity-mismatch"
  | "backend-mismatch"
  | "schema-ahead";

export type AppVaultRecoveryAction = "restore-backup" | "start-over" | "rebind";

export interface AppVaultRecoveryDescriptor {
  readonly primaryDigest: string | null;
  readonly backupDigest: string | null;
  readonly backup: Readonly<{
    digest: string;
    revision: number;
    updatedAt: string;
  }> | null;
  readonly actions: readonly AppVaultRecoveryAction[];
}

export interface AppVaultSnapshot {
  readonly vaultState: AppVaultState;
  readonly issue: import("./errors.js").AppVaultErrorCode | null;
  readonly revision: number | null;
  readonly updatedAt: string | null;
  readonly slots: readonly AppVaultRecordSummary[];
  readonly recovery: AppVaultRecoveryDescriptor | null;
}

export interface AppVaultContainerBinding {
  readonly schemaVersion: typeof APP_VAULT_DOCUMENT_SCHEMA_VERSION;
  readonly containerId: typeof APP_VAULT_CONTAINER_ID;
  readonly backendKind: AppVaultBackendKind;
  readonly digest: string;
}

export interface AppVaultSecretBroker extends SecretBroker {
  describeContainerBinding(): AppVaultContainerBinding;
  describeRecord(): Promise<AppVaultRecordSummary>;
}

export interface AppVaultManager {
  describeSnapshot(): Promise<AppVaultSnapshot>;
  describeSlots(): Promise<readonly AppVaultRecordSummary[]>;
  create(input: Readonly<{ slotId: string; secret: string; expectRevision: number | null }>): Promise<AppVaultRecordSummary>;
  rotate(input: Readonly<{ slotId: string; secret: string; expectRevision: number }>): Promise<AppVaultRecordSummary>;
  remove(input: Readonly<{ slotId: string; expectRevision: number }>): Promise<AppVaultRecordSummary>;
  forget(input: Readonly<{ slotId: string; expectRevision: number }>): Promise<AppVaultRecordSummary>;
  restoreBackup(input: Readonly<{ expectPrimaryDigest: string | null; expectBackupDigest: string }>): Promise<AppVaultSnapshot>;
  startOver(input: Readonly<{ expectPrimaryDigest: string | null; expectBackupDigest: string | null }>): Promise<AppVaultSnapshot>;
  rebind(input: Readonly<{ expectPrimaryDigest: string }>): Promise<AppVaultSnapshot>;
  close(): Promise<void>;
}

export interface AppVaultManagerOptions {
  readonly schemaVersion: typeof APP_VAULT_BROKER_SCHEMA_VERSION;
  readonly appIdentity: AppVaultAppIdentity;
  readonly clock: AppVaultClockPort;
  readonly crypto: AppVaultCryptoPort;
  readonly storage: AppVaultStoragePort;
  readonly random?: AppVaultRandomPort;
  readonly audit?: SecretAuditHook;
}

export interface AppVaultTestingOptions extends AppVaultBrokerOptions {
  readonly onZero?: (record: Readonly<{
    stage: "plain-text-bytes" | "decrypted-bytes" | "cipher-bytes" | "salt-bytes";
    byteLength: number;
    allZero: boolean;
  }>) => void;
}
