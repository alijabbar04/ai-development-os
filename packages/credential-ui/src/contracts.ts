export const CREDENTIAL_UI_SCHEMA_VERSION = 1 as const;

export const CREDENTIAL_SLOT_IDS = Object.freeze(["anthropic", "openai", "gemini", "openrouter"] as const);
export type CredentialSlotId = (typeof CREDENTIAL_SLOT_IDS)[number];

export const CREDENTIAL_ERROR_CODES = Object.freeze([
  "SENDER_REJECTED", "TOKEN_REJECTED", "REPLAYED", "SCHEMA_REJECTED",
  "ILLEGAL_TRANSITION", "RATE_LIMITED", "PLATFORM_UNSUPPORTED", "APP_NOT_READY",
  "ENCRYPTION_UNAVAILABLE", "SECRET_EMPTY", "SECRET_TOO_LARGE",
  "SECRET_INVALID_CHARACTERS", "SLOT_UNKNOWN", "SLOT_OCCUPIED", "SLOT_ABSENT",
  "VAULT_CORRUPT", "VAULT_BACKUP_ONLY", "VAULT_IDENTITY_MISMATCH",
  "VAULT_BACKEND_MISMATCH", "VAULT_SCHEMA_AHEAD", "VAULT_REVISION_CONFLICT",
  "VAULT_BUSY", "VAULT_WRITE_FAILED", "DECRYPT_FAILED", "METADATA_UNAVAILABLE",
  "VALIDATION_DISABLED", "VALIDATION_DISCLOSURE_MISSING", "VALIDATION_POLICY_DENIED", "VALIDATION_CANCELLED",
  "VALIDATION_AUTHORIZATION_UNAVAILABLE", "VALIDATION_AUTHORIZATION_INVALID", "VALIDATION_AUTHORIZATION_EXPIRED",
  "VALIDATION_AUTHORIZATION_CONSUMED", "VALIDATION_AUTHORIZATION_AMBIGUOUS",
  "VALIDATION_STALE", "UNKNOWN_OUTCOME", "REFUSED",
] as const);
export type CredentialErrorCode = (typeof CREDENTIAL_ERROR_CODES)[number];

export type CredentialVaultState =
  | "absent" | "ready" | "backup-only" | "corrupt" | "identity-mismatch"
  | "backend-mismatch" | "schema-ahead" | "encryption-unavailable";
export type CredentialRecordState = "absent" | "present" | "revoked" | "unrecoverable";
export type CredentialOwnership = "owned" | "authorized";
export type CredentialValidationOutcome = "valid" | "invalid" | "unauthorized" | "ambiguous" | "unreachable" | "evidence-incomplete";
export type CredentialValidationAuthorizationState =
  | "unavailable" | "invalid" | "expired" | "consumed" | "available";
export type CredentialRecoveryAction = "restore-backup" | "start-over" | "rebind";

export interface CredentialValidationAuthorizationView {
  readonly schemaVersion: 1;
  readonly state: CredentialValidationAuthorizationState;
  readonly slotId: "anthropic" | null;
  readonly providerInstanceId: "anthropic-default" | null;
  readonly modelId: "claude-haiku-4-5-20251001" | null;
  readonly requestFingerprint: string | null;
  readonly packetFingerprint: string | null;
  readonly authorizationReference: string | null;
  readonly expiresAt: string | null;
  readonly maximumOutputTokens: 4 | null;
  readonly effectTimeoutMs: 15_000 | null;
  readonly callbackDrainMs: 5_000 | null;
  readonly retentionMode: "standard-commercial-api" | null;
}

export interface CredentialDeveloperFacts {
  readonly referenceDisplay: string;
  readonly referenceFingerprint: string;
  readonly containerBinding: string;
  readonly backendKind: "electron-safe-storage-async" | "deterministic-fake";
  readonly documentRevision: number | null;
  readonly recordToken: string | null;
  readonly operationPhase: "idle" | "validation-in-flight";
  readonly resultCode: string | null;
  readonly policyDecisionFingerprint: string | null;
  readonly successReceiptState: "not-applicable" | "committed" | "historical-missing" | "write-failed" | "mismatch" | null;
  readonly successReceiptId: string | null;
  readonly successReceiptSha256: string | null;
}

export interface CredentialValidationView {
  readonly outcome: CredentialValidationOutcome;
  readonly checkedAt: string;
  readonly recordRevision: number;
  readonly recordToken: string;
  readonly definitive: boolean;
  readonly receiptState?: "not-applicable" | "committed" | "historical-missing" | "write-failed" | "mismatch";
}

export interface CredentialSlotView {
  readonly slotId: CredentialSlotId;
  readonly displayName: string;
  readonly productName: string;
  readonly providerHost: string;
  readonly credentialId: string | null;
  readonly nickname: string | null;
  readonly ownership: CredentialOwnership | null;
  readonly authorizedBy: string | null;
  readonly enabled: boolean;
  readonly state: CredentialRecordState;
  readonly revision: number | null;
  readonly generation: number | null;
  readonly createdAt: string | null;
  readonly rotatedAt: string | null;
  readonly revokedAt: string | null;
  readonly recordToken: string | null;
  /** Last result retained as authoritative knowledge for this credential version. */
  readonly validation: CredentialValidationView | null;
  /** Most recent attempt, including an inconclusive attempt that did not overwrite prior knowledge. */
  readonly lastValidationAttempt: CredentialValidationView | null;
  readonly developer: CredentialDeveloperFacts;
}

export interface CredentialActivitySentence {
  readonly id: string;
  readonly at: string;
  readonly tone: "info" | "ok" | "warn" | "danger";
  readonly text: string;
}

export interface CredentialRecoveryView {
  readonly issueCode: CredentialErrorCode;
  readonly primaryDigest: string | null;
  readonly backupDigest: string | null;
  readonly actions: readonly CredentialRecoveryAction[];
}

export interface CredentialSlotsResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly ok: true;
  readonly kind: "slots";
  readonly vaultState: CredentialVaultState;
  readonly revision: number | null;
  readonly slots: readonly CredentialSlotView[];
  readonly recovery: CredentialRecoveryView | null;
  readonly activity: readonly CredentialActivitySentence[];
  readonly clipboardClearDefault: boolean;
  readonly validationEnabled: boolean;
  readonly validationAuthorization: CredentialValidationAuthorizationView | null;
  readonly productionDisabled: true;
  readonly metadataAvailable: boolean;
}

export interface ClipboardResult {
  readonly requested: boolean;
  readonly outcome: "cleared" | "failed" | "not-requested";
}

export interface CredentialMutationResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly ok: true;
  readonly kind: "saved" | "rotated" | "enabled" | "disabled" | "removed";
  readonly slot: CredentialSlotView;
  readonly clipboard: ClipboardResult;
  readonly metadataWarning: boolean;
}

export interface CredentialValidatedResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly ok: true;
  readonly kind: "validated";
  readonly slotId: CredentialSlotId;
  readonly credentialId: string;
  readonly recordRevision: number;
  readonly recordToken: string;
  readonly outcome: CredentialValidationOutcome;
  readonly checkedAt: string;
  readonly definitive: boolean;
  readonly providerDispatched: boolean;
  readonly deadlineExpired: boolean;
  readonly workSettled: boolean;
  readonly applicability: "current" | "discarded" | "unknown";
  readonly resultRecording: "recorded" | "prior-definitive-preserved" | "not-recorded" | "unknown";
  readonly activityRecording: "recorded" | "unknown";
  readonly discarded: boolean;
}

export interface CredentialCancelledResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly ok: true;
  readonly kind: "cancelled";
}

export interface CredentialRefusedResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly ok: false;
  readonly kind: "refused";
  readonly code: CredentialErrorCode;
  readonly retryable: boolean;
}

export interface CredentialUnknownResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly ok: false;
  readonly kind: "unknown";
  readonly code: "UNKNOWN_OUTCOME";
  readonly retryable: false;
}

export type CredentialResponse =
  | CredentialSlotsResult
  | CredentialMutationResult
  | CredentialValidatedResult
  | CredentialCancelledResult
  | CredentialRefusedResult
  | CredentialUnknownResult;

export interface CredentialUiBridge {
  describe(): Promise<CredentialResponse>;
  save(slotId: CredentialSlotId, secret: string, nickname: string, ownership: CredentialOwnership, authorizedBy: string, clearClipboard: boolean): Promise<CredentialResponse>;
  rotate(slotId: CredentialSlotId, secret: string, credentialId: string, recordRevision: number, recordToken: string, clearClipboard: boolean, entryMode: "rotate" | "reenter", nickname: string | null, ownership: CredentialOwnership | null, authorizedBy: string | null): Promise<CredentialResponse>;
  setEnabled(slotId: CredentialSlotId, credentialId: string, recordRevision: number, recordToken: string, enabled: boolean): Promise<CredentialResponse>;
  remove(slotId: CredentialSlotId, credentialId: string, recordRevision: number, recordToken: string, acknowledgedRemoval: true): Promise<CredentialResponse>;
  validate(slotId: CredentialSlotId, credentialId: string, recordRevision: number, recordToken: string, acknowledgedDisclosure: true): Promise<CredentialResponse>;
  cancel(): Promise<CredentialResponse>;
}
