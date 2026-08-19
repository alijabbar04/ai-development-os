export const APP_VAULT_ERROR_CODES = Object.freeze([
  "VAULT_ABSENT",
  "RECORD_ABSENT",
  "RECORD_REVOKED",
  "RECORD_UNRECOVERABLE",
  "VAULT_CORRUPT",
  "VAULT_IDENTITY_MISMATCH",
  "VAULT_BACKEND_MISMATCH",
  "VAULT_SCHEMA_AHEAD",
  "VAULT_UNKNOWN_SLOT",
  "VAULT_BACKUP_ONLY",
  "VAULT_REVISION_CONFLICT",
  "VAULT_BUSY",
  "ENCRYPTION_UNAVAILABLE",
  "APP_NOT_READY",
  "PLATFORM_UNSUPPORTED",
  "ENCRYPT_FAILED",
  "DECRYPT_FAILED",
  "MALFORMED_CRYPTO_RESPONSE",
  "SECRET_TOO_LARGE",
  "SECRET_EMPTY",
  "SECRET_INVALID_CHARACTERS",
  "SLOT_OCCUPIED",
  "SLOT_UNKNOWN",
  "SLOT_NOT_PRESENT",
  "INVALID_CONFIGURATION",
  "STORAGE_FAILURE",
  "MIGRATION_GAP",
  "BROKER_CLOSED",
] as const);

export type AppVaultErrorCode = (typeof APP_VAULT_ERROR_CODES)[number];

/** A finite, redacted error suitable for crossing the vault/host boundary. */
export class AppVaultError extends Error {
  readonly code: AppVaultErrorCode;

  constructor(code: AppVaultErrorCode, message: string) {
    super(message);
    this.name = "AppVaultError";
    this.code = code;
  }

  toJSON(): object {
    return Object.freeze({ name: this.name, code: this.code, message: this.message });
  }
}

export function isAppVaultError(value: unknown): value is AppVaultError {
  return value instanceof AppVaultError && APP_VAULT_ERROR_CODES.includes(value.code);
}
