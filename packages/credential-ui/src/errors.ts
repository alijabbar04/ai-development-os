import { CREDENTIAL_ERROR_CODES, type CredentialErrorCode } from "./contracts.js";

export interface CredentialErrorCopy {
  readonly title: string;
  readonly body: string;
}

const COPY: Readonly<Record<CredentialErrorCode, CredentialErrorCopy>> = Object.freeze({
  SENDER_REJECTED: { title: "This window was refused", body: "Close it and reopen credential setup from the trusted application." },
  TOKEN_REJECTED: { title: "This secure session expired", body: "Close this window and start a new secure session." },
  REPLAYED: { title: "That change was already completed", body: "Reopen credential setup before making another storage change." },
  SCHEMA_REJECTED: { title: "The request was refused", body: "No credential change was made. Close this window and try again." },
  ILLEGAL_TRANSITION: { title: "That action is not available now", body: "Wait for the current action to finish or close this window." },
  RATE_LIMITED: { title: "Too many requests in this session", body: "Close this window and start a new secure session." },
  PLATFORM_UNSUPPORTED: { title: "Windows is required", body: "This credential setup is available only on Windows." },
  APP_NOT_READY: { title: "Credential setup is not ready", body: "Close this window and try again after the application has started." },
  ENCRYPTION_UNAVAILABLE: { title: "Secure storage is unavailable", body: "Storage changes are refused while Windows secure storage is unavailable. This app never falls back to plaintext storage." },
  SECRET_EMPTY: { title: "Paste a credential", body: "The protected field was empty after surrounding whitespace was removed." },
  SECRET_TOO_LARGE: { title: "That credential is too large", body: "Nothing was saved. Paste a credential within the supported bound." },
  SECRET_INVALID_CHARACTERS: { title: "That credential contains unsupported characters", body: "Nothing was saved. Copy the credential again from the provider." },
  SLOT_UNKNOWN: { title: "That provider slot is not supported", body: "No credential change was made." },
  SLOT_OCCUPIED: { title: "A credential is already saved", body: "Use Rotate credential to replace it without creating a second slot entry." },
  SLOT_ABSENT: { title: "No saved credential was found", body: "Refresh the slot list before trying again." },
  VAULT_CORRUPT: { title: "The credential store cannot be read", body: "The app refused to guess or replace it. Use one of the offered recovery actions." },
  VAULT_BACKUP_ONLY: { title: "Only a previous encrypted backup was found", body: "Review the offered choice to restore that backup or start again before continuing." },
  VAULT_IDENTITY_MISMATCH: { title: "This credential store belongs to another installation", body: "The app refused to read or overwrite it. Review the offered destructive recovery choice, which discards encrypted values and requires every credential to be re-entered." },
  VAULT_BACKEND_MISMATCH: { title: "This credential store uses a different secure-storage method", body: "The app refused to read or overwrite it." },
  VAULT_SCHEMA_AHEAD: { title: "This credential store was written by a newer version", body: "Update the app before using this credential store." },
  VAULT_REVISION_CONFLICT: { title: "The credential list changed", body: "Refresh the current state, then choose whether to submit again. Nothing is retried automatically." },
  VAULT_BUSY: { title: "Secure storage is busy", body: "Wait a moment, then retry deliberately. Nothing is retried automatically." },
  VAULT_WRITE_FAILED: { title: "The storage-change outcome is unknown", body: "Do not submit again yet. Close and reopen credential setup to inspect the current saved state." },
  DECRYPT_FAILED: { title: "This credential could not be read", body: "Review the refreshed status before trying again. Re-entry is offered only if secure storage marks the saved copy unreadable." },
  METADATA_UNAVAILABLE: { title: "Credential details are unavailable", body: "The local details read or update did not complete. Earlier saved details may still be intact. Close and reopen to inspect them before deciding whether any repair is needed." },
  VALIDATION_DISABLED: { title: "Live validation is off in this build", body: "Saving remains local. A provider request is unavailable until a separately enabled build is reviewed." },
  VALIDATION_DISCLOSURE_MISSING: { title: "Validation was not approved", body: "Review the one-dispatch-attempt disclosure and choose Confirm and validate explicitly." },
  VALIDATION_POLICY_DENIED: { title: "Validation wasn't allowed by policy", body: "Nothing was sent to the provider. The refusal was recorded in Activity." },
  VALIDATION_CANCELLED: { title: "Validation was cancelled", body: "The credential was not judged and no retry was attempted." },
  VALIDATION_AUTHORIZATION_UNAVAILABLE: { title: "Validation authorization is unavailable", body: "No provider request was made. A reviewed, candidate-bound one-shot authorization must be loaded first." },
  VALIDATION_AUTHORIZATION_INVALID: { title: "Validation authorization was refused", body: "No provider request was made. The authorization did not match this exact candidate and request." },
  VALIDATION_AUTHORIZATION_EXPIRED: { title: "Validation authorization expired", body: "No provider request was made. An expired authorization cannot be reused." },
  VALIDATION_AUTHORIZATION_CONSUMED: { title: "Validation authorization was already consumed", body: "No additional request was made. Reopening or repeating the action cannot restore this one-shot authorization." },
  VALIDATION_AUTHORIZATION_AMBIGUOUS: { title: "Validation authorization outcome is ambiguous", body: "Do not retry. The one-shot authorization remains consumed because its durable marker could not be finalized." },
  VALIDATION_STALE: { title: "The validation result was discarded", body: "The saved credential changed while the check was in flight, so the result was not applied." },
  UNKNOWN_OUTCOME: { title: "The action outcome is unknown", body: "The response was interrupted. Reopen credential setup to inspect the current saved state before trying again." },
  REFUSED: { title: "The action was refused", body: "No optimistic success is shown. Close this window and inspect the current state." },
});

export function credentialErrorCopy(code: CredentialErrorCode): CredentialErrorCopy {
  return COPY[code];
}

export function hasCompleteCredentialErrorCopy(): boolean {
  return CREDENTIAL_ERROR_CODES.every((code) => COPY[code].title.length > 0 && COPY[code].body.length > 0);
}
