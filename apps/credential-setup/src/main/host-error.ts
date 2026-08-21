import { AppVaultError, isAppVaultError } from "@ai-dev-os/secrets-app-vault";
import { SecretBrokerError } from "@ai-dev-os/secrets";
import type { CredentialErrorCode } from "@ai-dev-os/credential-ui";

const RETRYABLE = new Set<CredentialErrorCode>(["VAULT_REVISION_CONFLICT", "VAULT_BUSY"]);

export class CredentialHostError extends Error {
  readonly code: CredentialErrorCode;
  readonly retryable: boolean;
  constructor(code: CredentialErrorCode) {
    super("Credential operation refused.");
    this.name = "CredentialHostError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
  }
}

const VAULT_CODES: Readonly<Partial<Record<AppVaultError["code"], CredentialErrorCode>>> = Object.freeze({
  PLATFORM_UNSUPPORTED: "PLATFORM_UNSUPPORTED",
  APP_NOT_READY: "APP_NOT_READY",
  ENCRYPTION_UNAVAILABLE: "ENCRYPTION_UNAVAILABLE",
  SECRET_EMPTY: "SECRET_EMPTY",
  SECRET_TOO_LARGE: "SECRET_TOO_LARGE",
  SECRET_INVALID_CHARACTERS: "SECRET_INVALID_CHARACTERS",
  SLOT_UNKNOWN: "SLOT_UNKNOWN",
  SLOT_OCCUPIED: "SLOT_OCCUPIED",
  SLOT_ABSENT: "SLOT_ABSENT",
  VAULT_CORRUPT: "VAULT_CORRUPT",
  VAULT_BACKUP_ONLY: "VAULT_BACKUP_ONLY",
  VAULT_IDENTITY_MISMATCH: "VAULT_IDENTITY_MISMATCH",
  VAULT_BACKEND_MISMATCH: "VAULT_BACKEND_MISMATCH",
  VAULT_SCHEMA_AHEAD: "VAULT_SCHEMA_AHEAD",
  VAULT_REVISION_CONFLICT: "VAULT_REVISION_CONFLICT",
  VAULT_BUSY: "VAULT_BUSY",
  VAULT_WRITE_FAILED: "VAULT_WRITE_FAILED",
  DECRYPT_FAILED: "DECRYPT_FAILED",
});

export function finiteCredentialError(error: unknown): CredentialHostError {
  if (error instanceof CredentialHostError) return error;
  if (isAppVaultError(error)) return new CredentialHostError(VAULT_CODES[error.code] ?? "REFUSED");
  if (error instanceof SecretBrokerError) {
    if (error.code === "NOT_FOUND") return new CredentialHostError("SLOT_ABSENT");
    if (error.code === "REVOKED") return new CredentialHostError("SLOT_ABSENT");
    if (error.code === "UNAVAILABLE" && (error.details["vaultCode"] === "DECRYPT_FAILED" || error.details["vaultCode"] === "RECORD_UNRECOVERABLE")) return new CredentialHostError("DECRYPT_FAILED");
  }
  return new CredentialHostError("REFUSED");
}
