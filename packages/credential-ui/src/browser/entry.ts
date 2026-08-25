type SlotId = "anthropic" | "openai" | "gemini" | "openrouter";
type Ownership = "owned" | "authorized";
type Tone = "ok" | "info" | "warn" | "danger" | "neutral";
type RecoveryAction = "restore-backup" | "start-over" | "rebind";
type ErrorCode =
  | "SENDER_REJECTED" | "TOKEN_REJECTED" | "REPLAYED" | "SCHEMA_REJECTED"
  | "ILLEGAL_TRANSITION" | "RATE_LIMITED" | "PLATFORM_UNSUPPORTED" | "APP_NOT_READY"
  | "ENCRYPTION_UNAVAILABLE" | "SECRET_EMPTY" | "SECRET_TOO_LARGE"
  | "SECRET_INVALID_CHARACTERS" | "SLOT_UNKNOWN" | "SLOT_OCCUPIED" | "SLOT_ABSENT"
  | "VAULT_CORRUPT" | "VAULT_BACKUP_ONLY" | "VAULT_IDENTITY_MISMATCH"
  | "VAULT_BACKEND_MISMATCH" | "VAULT_SCHEMA_AHEAD" | "VAULT_REVISION_CONFLICT"
  | "VAULT_BUSY" | "VAULT_WRITE_FAILED" | "DECRYPT_FAILED" | "METADATA_UNAVAILABLE"
  | "VALIDATION_DISABLED" | "VALIDATION_DISCLOSURE_MISSING" | "VALIDATION_POLICY_DENIED" | "VALIDATION_CANCELLED"
  | "VALIDATION_AUTHORIZATION_UNAVAILABLE" | "VALIDATION_AUTHORIZATION_INVALID" | "VALIDATION_AUTHORIZATION_EXPIRED"
  | "VALIDATION_AUTHORIZATION_CONSUMED" | "VALIDATION_AUTHORIZATION_AMBIGUOUS"
  | "VALIDATION_STALE" | "UNKNOWN_OUTCOME" | "REFUSED";

interface ValidationAuthorizationView {
  readonly schemaVersion: 1;
  readonly state: "unavailable" | "invalid" | "expired" | "consumed" | "available";
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

interface DeveloperFacts {
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

interface ValidationView {
  readonly outcome: "valid" | "invalid" | "unauthorized" | "ambiguous" | "unreachable" | "evidence-incomplete";
  readonly checkedAt: string;
  readonly recordRevision: number;
  readonly recordToken: string;
  readonly definitive: boolean;
  readonly receiptState?: "not-applicable" | "committed" | "historical-missing" | "write-failed" | "mismatch";
}

interface SlotView {
  readonly slotId: SlotId;
  readonly displayName: string;
  readonly productName: string;
  readonly providerHost: string;
  readonly credentialId: string | null;
  readonly nickname: string | null;
  readonly ownership: Ownership | null;
  readonly authorizedBy: string | null;
  readonly enabled: boolean;
  readonly state: "absent" | "present" | "revoked" | "unrecoverable";
  readonly revision: number | null;
  readonly generation: number | null;
  readonly createdAt: string | null;
  readonly rotatedAt: string | null;
  readonly revokedAt: string | null;
  readonly recordToken: string | null;
  readonly validation: ValidationView | null;
  readonly lastValidationAttempt: ValidationView | null;
  readonly developer: DeveloperFacts;
}

interface Activity {
  readonly id: string;
  readonly at: string;
  readonly tone: "info" | "ok" | "warn" | "danger";
  readonly text: string;
}

interface SlotsResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly ok: true;
  readonly kind: "slots";
  readonly vaultState: "absent" | "ready" | "backup-only" | "corrupt" | "identity-mismatch" | "backend-mismatch" | "schema-ahead" | "encryption-unavailable";
  readonly revision: number | null;
  readonly slots: readonly SlotView[];
  readonly recovery: { readonly issueCode: ErrorCode; readonly primaryDigest: string | null; readonly backupDigest: string | null; readonly actions: readonly RecoveryAction[] } | null;
  readonly activity: readonly Activity[];
  readonly clipboardClearDefault: boolean;
  readonly validationEnabled: boolean;
  readonly validationAuthorization: ValidationAuthorizationView | null;
  readonly productionDisabled: true;
  readonly metadataAvailable: boolean;
}

interface MutationResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly ok: true;
  readonly kind: "saved" | "rotated" | "enabled" | "disabled" | "removed";
  readonly slot: SlotView;
  readonly clipboard: { readonly requested: boolean; readonly outcome: "cleared" | "failed" | "not-requested" };
  readonly metadataWarning: boolean;
}

interface ValidatedResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly ok: true;
  readonly kind: "validated";
  readonly slotId: SlotId;
  readonly credentialId: string;
  readonly recordRevision: number;
  readonly recordToken: string;
  readonly outcome: "valid" | "invalid" | "unauthorized" | "ambiguous" | "unreachable" | "evidence-incomplete";
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

interface RefusedResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly ok: false;
  readonly kind: "refused" | "unknown";
  readonly code: ErrorCode;
  readonly retryable: boolean;
}

type Response = SlotsResult | MutationResult | ValidatedResult | RefusedResult | { readonly schemaVersion: 1; readonly requestId: string; readonly ok: true; readonly kind: "cancelled" };

interface Bridge {
  describe(): Promise<Response>;
  save(slotId: SlotId, secret: string, nickname: string, ownership: Ownership, authorizedBy: string, clearClipboard: boolean): Promise<Response>;
  rotate(slotId: SlotId, secret: string, credentialId: string, recordRevision: number, recordToken: string, clearClipboard: boolean, entryMode: "rotate" | "reenter", nickname: string | null, ownership: Ownership | null, authorizedBy: string | null): Promise<Response>;
  setEnabled(slotId: SlotId, credentialId: string, recordRevision: number, recordToken: string, enabled: boolean): Promise<Response>;
  remove(slotId: SlotId, credentialId: string, recordRevision: number, recordToken: string, acknowledgedRemoval: true): Promise<Response>;
  validate(slotId: SlotId, credentialId: string, recordRevision: number, recordToken: string, acknowledgedDisclosure: true): Promise<Response>;
  cancel(): Promise<Response>;
}

declare global {
  interface Window { readonly credentialVault?: Bridge }
}

const CATALOGUE: Readonly<Record<SlotId, Readonly<{ mark: string; localFormat: string; acquisition: string }>>> = Object.freeze({
  anthropic: Object.freeze({ mark: "An", localFormat: "Anthropic credentials usually begin with the provider's standard key prefix.", acquisition: "Get it from Anthropic Console → API keys." }),
  openai: Object.freeze({ mark: "Oa", localFormat: "OpenAI credentials usually begin with the provider's standard key prefix.", acquisition: "Get it from the OpenAI dashboard → API keys." }),
  gemini: Object.freeze({ mark: "Gm", localFormat: "Google Gemini credentials usually begin with the provider's standard API prefix.", acquisition: "Get it from Google AI Studio → API keys." }),
  openrouter: Object.freeze({ mark: "Or", localFormat: "OpenRouter credentials usually begin with the provider's standard key prefix.", acquisition: "Get it from the OpenRouter dashboard → Keys." }),
});

interface LocalCredentialFormat {
  readonly tone: "neutral" | "ok" | "warn" | "danger";
  readonly sentence: string;
  readonly blocks: boolean;
}

const RAW_SECRET_CODE_UNIT_LIMIT = 16_384;
const SECRET_UTF8_BYTE_LIMIT = 8_192;

function logicalSecretSpan(value: string): Readonly<{ start: number; end: number }> {
  const isTrimmedCodeUnit = (code: number): boolean => (
    (code >= 0x0009 && code <= 0x000d)
    || code === 0x0020 || code === 0x00a0 || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f
    || code === 0x205f || code === 0x3000 || code === 0xfeff
  );
  let start = 0;
  while (start < value.length && isTrimmedCodeUnit(value.charCodeAt(start))) start += 1;
  let end = value.length;
  while (end > start && isTrimmedCodeUnit(value.charCodeAt(end - 1))) end -= 1;
  return Object.freeze({ start, end });
}

function localSecretBoundaryIssue(value: string): "too-large" | "invalid-characters" | null {
  if (value.length > RAW_SECRET_CODE_UNIT_LIMIT) return "too-large";
  const { start, end } = logicalSecretSpan(value);
  let bytes = 0;
  for (let index = start; index < end; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0x0000 && code <= 0x001f) || (code >= 0x007f && code <= 0x009f) || code === 0x2028 || code === 0x2029) return "invalid-characters";
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= end || next < 0xdc00 || next > 0xdfff) return "invalid-characters";
      bytes += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return "invalid-characters";
    else bytes += code <= 0x007f ? 1 : code <= 0x07ff ? 2 : 3;
    if (bytes > SECRET_UTF8_BYTE_LIMIT) return "too-large";
  }
  return null;
}

function localCredentialFormat(slotId: SlotId, raw: string): LocalCredentialFormat {
  if (raw.length === 0) return { tone: "neutral", sentence: "Nothing pasted yet.", blocks: true };
  if (raw.length > RAW_SECRET_CODE_UNIT_LIMIT) return { tone: "danger", sentence: "This paste is larger than the supported transport bound. Nothing will be submitted, and the value is not echoed.", blocks: true };
  if (/\r|\n/u.test(raw)) return { tone: "danger", sentence: "Remove line breaks before saving. The value is not echoed.", blocks: true };
  if (/^\s*$/u.test(raw)) return { tone: "danger", sentence: "Only spaces were pasted. Copy the credential itself.", blocks: true };
  if (/^\s*https?:\/\//iu.test(raw)) return { tone: "danger", sentence: "This looks like a web address, not a credential. Nothing will be submitted.", blocks: true };
  const boundaryIssue = localSecretBoundaryIssue(raw);
  if (boundaryIssue === "invalid-characters") return { tone: "danger", sentence: "This paste contains an unsupported control character or invalid text encoding. Nothing will be submitted, and the value is not echoed.", blocks: true };
  if (boundaryIssue === "too-large") return { tone: "danger", sentence: "This paste is larger than the supported credential bound. Nothing will be submitted, and the value is not echoed.", blocks: true };
  if (/\s/u.test(raw)) return { tone: "warn", sentence: "This contains whitespace. Check the copied value before saving; you can still continue.", blocks: false };

  const expectedPrefix = slotId === "anthropic" ? "sk-ant-" : slotId === "openai" ? "sk-" : slotId === "gemini" ? "AIza" : "sk-or-";
  const knownOtherPrefix = (["sk-ant-", "sk-or-", "AIza", "sk-"] as const)
    .some((prefix) => prefix !== expectedPrefix && raw.startsWith(prefix) && !(prefix === "sk-" && (raw.startsWith("sk-ant-") || raw.startsWith("sk-or-"))));
  if (knownOtherPrefix) return { tone: "warn", sentence: "This resembles a different provider family. Check the selected provider before saving; you can still continue.", blocks: false };

  const safeCharacters = /^[A-Za-z0-9._-]+$/u.test(raw);
  const plausible = slotId === "anthropic"
    ? raw.startsWith("sk-ant-") && raw.length >= 20 && safeCharacters
    : slotId === "openai"
      ? raw.startsWith("sk-") && !raw.startsWith("sk-ant-") && !raw.startsWith("sk-or-") && raw.length >= 20 && safeCharacters
      : slotId === "gemini"
        ? raw.startsWith("AIza") && raw.length >= 35 && raw.length <= 60 && safeCharacters
        : raw.startsWith("sk-or-") && raw.length >= 20 && safeCharacters;
  if (plausible) return { tone: "ok", sentence: "The local provider-family and character check looks plausible. This is not provider validation, and the value is not echoed.", blocks: false };
  return { tone: "warn", sentence: `${CATALOGUE[slotId].localFormat} Check the copied value before saving; you can still continue. The value is not echoed.`, blocks: false };
}

const ERROR_COPY: Readonly<Record<ErrorCode, Readonly<{ title: string; body: string }>>> = Object.freeze({
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

const api = window.credentialVault;
const main = document.querySelector<HTMLElement>("#main")!;
const statusRegion = document.querySelector<HTMLElement>("#status-region")!;
const alertRegion = document.querySelector<HTMLElement>("#alert-region")!;
const modeToggle = document.querySelector<HTMLButtonElement>("#mode-toggle")!;

let model: SlotsResult | null = null;
let mode: "normal" | "developer" = "normal";
let view: "providers" | "activity" = "providers";
let selectedSlotId: SlotId | null = null;
let validatingCredentialId: string | null = null;
let mutationInFlight = false;
let refreshInFlight = false;
let authoritativeStateFresh = true;
let sessionPresentationState: "editing" | "committed" | "failed" = "editing";
let validationPresentationState: "available" | "reopen-required" = "available";
type Notice = Readonly<{ tone: Tone; title: string; body: string; code?: ErrorCode }>;
let notice: Notice | null = null;
let refreshWarning: Notice | null = null;
let lastFocusKey: string | null = null;
let deferredFocusKey: string | null = null;
let ageOnlyRender = false;
let dialogSequence = 0;
let announcementSequence = 0;
const dialogOpeners = new WeakMap<HTMLDialogElement, HTMLElement>();
const finalizingDialogs = new WeakSet<HTMLDialogElement>();

const REOPEN_FOR_STORAGE_CHANGE = "Reopen credential setup before another storage change";
const REOPEN_AFTER_TERMINAL_REFUSAL = "Close and reopen credential setup after this refused or uncertain operation";
const GLOBAL_ACTION_REASON_ID = "credential-global-action-reason";
const REFUSAL_TONE: Readonly<Record<ErrorCode, Readonly<{ tone: Tone; urgent: boolean }>>> = Object.freeze({
  SENDER_REJECTED: { tone: "danger", urgent: true }, TOKEN_REJECTED: { tone: "danger", urgent: true }, REPLAYED: { tone: "warn", urgent: false }, SCHEMA_REJECTED: { tone: "danger", urgent: true },
  ILLEGAL_TRANSITION: { tone: "warn", urgent: false }, RATE_LIMITED: { tone: "warn", urgent: false }, PLATFORM_UNSUPPORTED: { tone: "warn", urgent: false }, APP_NOT_READY: { tone: "warn", urgent: false },
  ENCRYPTION_UNAVAILABLE: { tone: "danger", urgent: true }, SECRET_EMPTY: { tone: "warn", urgent: false }, SECRET_TOO_LARGE: { tone: "warn", urgent: false }, SECRET_INVALID_CHARACTERS: { tone: "warn", urgent: false },
  SLOT_UNKNOWN: { tone: "danger", urgent: true }, SLOT_OCCUPIED: { tone: "warn", urgent: false }, SLOT_ABSENT: { tone: "warn", urgent: false }, VAULT_CORRUPT: { tone: "danger", urgent: true },
  VAULT_BACKUP_ONLY: { tone: "danger", urgent: true }, VAULT_IDENTITY_MISMATCH: { tone: "danger", urgent: true }, VAULT_BACKEND_MISMATCH: { tone: "danger", urgent: true }, VAULT_SCHEMA_AHEAD: { tone: "danger", urgent: true },
  VAULT_REVISION_CONFLICT: { tone: "warn", urgent: false }, VAULT_BUSY: { tone: "warn", urgent: false }, VAULT_WRITE_FAILED: { tone: "warn", urgent: false }, DECRYPT_FAILED: { tone: "danger", urgent: true },
  METADATA_UNAVAILABLE: { tone: "warn", urgent: false }, VALIDATION_DISABLED: { tone: "info", urgent: false }, VALIDATION_DISCLOSURE_MISSING: { tone: "info", urgent: false }, VALIDATION_POLICY_DENIED: { tone: "warn", urgent: false },
  VALIDATION_CANCELLED: { tone: "info", urgent: false }, VALIDATION_AUTHORIZATION_UNAVAILABLE: { tone: "info", urgent: false }, VALIDATION_AUTHORIZATION_INVALID: { tone: "warn", urgent: false },
  VALIDATION_AUTHORIZATION_EXPIRED: { tone: "warn", urgent: false }, VALIDATION_AUTHORIZATION_CONSUMED: { tone: "warn", urgent: false }, VALIDATION_AUTHORIZATION_AMBIGUOUS: { tone: "danger", urgent: true },
  VALIDATION_STALE: { tone: "warn", urgent: false }, UNKNOWN_OUTCOME: { tone: "warn", urgent: false }, REFUSED: { tone: "danger", urgent: true },
});
const TERMINAL_VALIDATION_CODES = new Set<ErrorCode>(["SENDER_REJECTED", "TOKEN_REJECTED", "REPLAYED", "SCHEMA_REJECTED", "RATE_LIMITED", "VALIDATION_AUTHORIZATION_INVALID", "VALIDATION_AUTHORIZATION_EXPIRED", "VALIDATION_AUTHORIZATION_CONSUMED", "VALIDATION_AUTHORIZATION_AMBIGUOUS", "UNKNOWN_OUTCOME", "REFUSED"]);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, options: { className?: string; text?: string; attrs?: Readonly<Record<string, string>> } = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className !== undefined) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) node.setAttribute(name, value);
  return node;
}

function append(parent: ParentNode, ...children: readonly (Node | null)[]): void {
  for (const child of children) if (child !== null) parent.append(child);
}

function randomSecretFieldName(): string {
  const words = new Uint32Array(4);
  crypto.getRandomValues(words);
  return `credential-${[...words].map((word) => word.toString(16).padStart(8, "0")).join("")}`;
}

function button(label: string, onClick: () => void, className = "btn", disabledReason: string | null = null, focusKey: string | null = null): HTMLButtonElement {
  const node = element("button", { className, text: label, attrs: { type: "button" } });
  node.addEventListener("click", onClick);
  if (disabledReason !== null) {
    node.disabled = true;
    node.title = disabledReason;
    node.dataset["disabledReason"] = disabledReason;
  }
  if (focusKey !== null) node.dataset["focusKey"] = focusKey;
  return node;
}

function appendActionReasons(parent: HTMLElement, actions: HTMLElement, scope: string): void {
  const disabledActions = [...actions.querySelectorAll<HTMLButtonElement>("button:disabled[data-disabled-reason]")];
  if (disabledActions.length === 0) return;
  const reasons = element("div", { className: "action-reasons", attrs: { "data-action-reasons-for": scope } });
  const globalReason = globalActionReason();
  let localReasonIndex = 0;
  for (const action of disabledActions) {
    if (globalReason !== null && action.dataset["disabledReason"] === globalReason) {
      action.setAttribute("aria-describedby", GLOBAL_ACTION_REASON_ID);
      continue;
    }
    const reasonId = `action-reason-${scope}-${localReasonIndex}`;
    localReasonIndex += 1;
    action.setAttribute("aria-describedby", reasonId);
    reasons.append(element("p", { text: `${action.textContent?.trim() ?? "Action"} unavailable — ${action.dataset["disabledReason"] ?? "Unavailable"}.`, attrs: { id: reasonId } }));
  }
  if (reasons.childElementCount > 0) parent.append(reasons);
}

function renderGlobalActionReason(parent: HTMLElement, scope: string): void {
  const reason = globalActionReason();
  if (reason === null) return;
  parent.append(element("p", { className: "action-reasons global-action-reason", text: `Unavailable credential actions — ${reason}.`, attrs: { id: GLOBAL_ACTION_REASON_ID, "data-action-reasons-for": scope } }));
}

function announce(message: string, urgent = false): void {
  announcementSequence += 1;
  const sequence = announcementSequence;
  const target = urgent ? alertRegion : statusRegion;
  statusRegion.textContent = "";
  alertRegion.textContent = "";
  requestAnimationFrame(() => { if (sequence === announcementSequence) target.textContent = message; });
}

function rememberFocus(): void {
  const active = document.activeElement as HTMLElement | null;
  lastFocusKey = active?.dataset["focusKey"] ?? null;
}

function restoreFocus(): void {
  if (lastFocusKey !== null) {
    const candidate = document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(lastFocusKey)}"]`);
    if (candidate !== null && !candidate.hasAttribute("disabled")) { candidate.focus(); return; }
  }
  document.querySelector<HTMLElement>("h1")?.focus();
}

function statusFor(slot: SlotView): Readonly<{ tone: Tone; label: string; sentence: string; connected: boolean }> {
  if (model !== null && model.vaultState !== "ready" && model.vaultState !== "absent") return {
    tone: "danger",
    label: model.vaultState === "encryption-unavailable" ? "Secure storage unavailable" : "Recovery required",
    sentence: "Credential and provider-acceptance status is unavailable until secure storage recovery is completed.",
    connected: false,
  };
  if (slot.state === "absent") return { tone: "neutral", label: "Not saved", sentence: "No credential is stored on this PC.", connected: false };
  if (model?.metadataAvailable === false) return { tone: "warn", label: "Details unavailable", sentence: "Credential storage, ownership, enabled state, validation details, and available actions cannot be determined until this installation's saved credential details are restored.", connected: false };
  if (slot.state === "revoked") return {
    tone: "neutral",
    label: "Removed",
    sentence: sessionPresentationState === "committed"
      ? "The encrypted credential was removed from this PC. Reopen credential setup to re-enter it."
      : "The encrypted credential was removed from this PC. Re-entry remains available.",
    connected: false,
  };
  if (slot.state === "unrecoverable" && slot.credentialId === null) return { tone: "danger", label: "Storage unavailable", sentence: "This provider slot cannot be read while secure storage needs recovery.", connected: false };
  if (slot.state === "unrecoverable") return { tone: "danger", label: "Re-entry required", sentence: "The saved credential cannot be read on this PC.", connected: false };
  if (!slot.enabled) return { tone: "neutral", label: "Disabled", sentence: "Saved on this PC but disabled for future use. No tasks run in this build.", connected: false };
  const latest = slot.lastValidationAttempt ?? slot.validation;
  if (latest === null) return { tone: "info", label: "Saved · not validated", sentence: "Saved securely on this PC. Saving did not contact the provider.", connected: false };
  if (latest.outcome === "evidence-incomplete" && latest.receiptState === "mismatch") return { tone: "warn", label: "Receipt not verifiable", sentence: `Provider validation succeeded, but the saved audit receipt could not be verified for this build. The one-shot attempt was consumed and cannot be retried. ${lastKnownValidation(slot)}`, connected: false };
  if (latest.outcome === "evidence-incomplete") return { tone: "warn", label: "Receipt not saved", sentence: `Provider validation succeeded, but its audit receipt could not be saved. The one-shot attempt was consumed and cannot be retried. ${lastKnownValidation(slot)}`, connected: false };
  if (!latest.definitive) return { tone: "warn", label: "Check inconclusive", sentence: `The latest check did not judge this credential. ${lastKnownValidation(slot)}`, connected: false };
  const age = validationAge(latest.checkedAt);
  if (!age.recorded && latest.outcome !== "invalid") return { tone: "warn", label: "Check needed", sentence: "The last definitive check has an invalid or future recorded time, so provider acceptance is not inferred.", connected: false };
  if (latest.outcome === "valid") return age.stale
    ? { tone: "warn", label: "Check needed", sentence: `The last accepted check is stale and needs another deliberate check. ${lastKnownValidation(slot)}`, connected: true }
    : { tone: "ok", label: `Validated · ${age.short}`, sentence: `The separately requested check accepted this credential ${age.sentence}.`, connected: true };
  if (latest.outcome === "invalid") return { tone: "danger", label: "Not accepted", sentence: `The last separately requested check did not accept this credential ${age.sentence}.`, connected: false };
  if (latest.outcome === "unauthorized") return { tone: "warn", label: "Permission limited", sentence: `The provider accepted the credential ${age.sentence} but refused the checked capability.`, connected: true };
  return { tone: "warn", label: "Check inconclusive", sentence: "The latest check did not judge this credential. No earlier definitive result is known.", connected: false };
}

function lastKnownValidation(slot: SlotView): string {
  const known = slot.validation?.definitive === true ? slot.validation : null;
  if (known === null) return "No earlier definitive result is known.";
  const recorded = validationAge(known.checkedAt).sentence;
  if (known.outcome === "valid") return `Last known: accepted ${recorded}.`;
  if (known.outcome === "unauthorized") return `Last known: accepted with limited permission ${recorded}.`;
  return `Last known: not accepted ${recorded}.`;
}

function aggregate(input: SlotsResult): string {
  if (input.vaultState !== "ready" && input.vaultState !== "absent") return "Secure storage recovery required · Provider acceptance and credential counts unavailable";
  const saved = input.slots.filter((slot) => slot.state === "present" || slot.state === "unrecoverable").length;
  if (!input.metadataAvailable) return `${saved} saved ${saved === 1 ? "credential" : "credentials"} · Connection and validation details unavailable`;
  const connected = new Set(input.slots.filter((slot) => statusFor(slot).connected).map((slot) => slot.slotId)).size;
  const pending = input.slots.filter((slot) => slot.state === "present" && slot.enabled && (slot.lastValidationAttempt ?? slot.validation) === null).length;
  const check = input.slots.filter((slot) => {
    const latest = slot.lastValidationAttempt ?? slot.validation;
    return slot.state === "present" && slot.enabled && latest !== null && (!latest.definitive || latest.outcome === "unauthorized" || (latest.outcome === "valid" && validationAge(latest.checkedAt).stale));
  }).length;
  const attention = input.slots.filter((slot) => slot.state === "unrecoverable" || (slot.state === "present" && slot.enabled && (slot.lastValidationAttempt ?? slot.validation)?.outcome === "invalid")).length;
  const disabled = input.slots.filter((slot) => slot.state === "present" && !slot.enabled).length;
  return `${connected} accepted ${connected === 1 ? "provider" : "providers"} · ${saved} saved ${saved === 1 ? "credential" : "credentials"} · ${pending} ${pending === 1 ? "credential" : "credentials"} not validated · ${check} ${check === 1 ? "credential needs" : "credentials need"} a check · ${attention} ${attention === 1 ? "credential needs" : "credentials need"} attention · ${disabled} disabled ${disabled === 1 ? "credential" : "credentials"}`;
}

function validationSummary(validation: ValidationView | null): string {
  if (validation === null) return "Never";
  const label: Readonly<Record<ValidationView["outcome"], string>> = Object.freeze({
    valid: "Accepted",
    invalid: "Not accepted",
    unauthorized: "Accepted · permission limited",
    ambiguous: "Inconclusive · unclear result",
    unreachable: "Inconclusive · provider unreachable",
    "evidence-incomplete": "Inconclusive · audit receipt unavailable",
  });
  const age = validationAge(validation.checkedAt);
  if (validation.definitive && !age.recorded && validation.outcome !== "invalid") return "Provider acceptance unavailable · recorded time is invalid or in the future";
  return `${label[validation.outcome]} · ${date(validation.checkedAt)} · ${age.short}`;
}

const VALIDATION_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1_000;

function validationAge(value: string, now = Date.now()): Readonly<{ short: string; sentence: string; stale: boolean; recorded: boolean }> {
  const checked = Date.parse(value);
  if (!Number.isFinite(checked) || checked > now) return { short: "recorded time unavailable", sentence: "at an unavailable recorded time", stale: true, recorded: false };
  const elapsed = now - checked;
  const stale = elapsed >= VALIDATION_FRESHNESS_MS;
  if (elapsed < 60_000) return { short: "just now", sentence: "just now", stale, recorded: true };
  if (elapsed < 3_600_000) {
    const minutes = Math.floor(elapsed / 60_000);
    return { short: `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`, sentence: `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`, stale, recorded: true };
  }
  if (elapsed < 86_400_000) {
    const hours = Math.floor(elapsed / 3_600_000);
    return { short: `${hours} ${hours === 1 ? "hour" : "hours"} ago`, sentence: `${hours} ${hours === 1 ? "hour" : "hours"} ago`, stale, recorded: true };
  }
  const days = Math.floor(elapsed / 86_400_000);
  return { short: `${days} ${days === 1 ? "day" : "days"} ago`, sentence: `${days} ${days === 1 ? "day" : "days"} ago`, stale, recorded: true };
}

function date(value: string | null): string {
  if (value === null) return "Never";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "Recorded time unavailable" : formatCredentialTimestamp(parsed);
}

/** Credential Setup uses its reviewed document language and the operator's OS time zone. */
const CREDENTIAL_TIMESTAMP_FORMAT_CONTRACT = Object.freeze({
  locale: document.documentElement.lang,
  options: Object.freeze({ dateStyle: "medium", timeStyle: "short" } as const),
});

function formatCredentialTimestamp(value: Date): string {
  return new Intl.DateTimeFormat(
    CREDENTIAL_TIMESTAMP_FORMAT_CONTRACT.locale,
    CREDENTIAL_TIMESTAMP_FORMAT_CONTRACT.options,
  ).format(value);
}

function displayFingerprint(value: string | null): string {
  if (value === null) return "none";
  return /^[0-9a-f]{16,}$/iu.test(value) ? `fp:${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

function mutationInputs(slot: SlotView): { credentialId: string; revision: number; token: string } | null {
  if (slot.credentialId === null || slot.revision === null || slot.recordToken === null) return null;
  return { credentialId: slot.credentialId, revision: slot.revision, token: slot.recordToken };
}

function renderNotice(parent: HTMLElement): void {
  for (const [kind, item] of [["outcome", notice], ["refresh-warning", refreshWarning]] as const) {
    if (item === null) continue;
    const box = element("section", { className: "notice", attrs: { role: "region", "aria-label": kind === "outcome" ? "Action result" : "Refresh warning", "data-tone": item.tone, "data-notice-kind": kind } });
    append(box, element("h2", { text: item.title }), element("p", { className: "sub", text: item.body }));
    if (mode === "developer" && item.code !== undefined) box.append(developerFactsBlock([["result.code", item.code]]));
    parent.append(box);
  }
}

function renderRecovery(parent: HTMLElement): void {
  if (model === null) return;
  if (!model.metadataAvailable && model.recovery === null) {
    const box = element("section", { className: "notice", attrs: { role: "region", "aria-label": "Credential presentation recovery", "data-tone": "danger" } });
    append(
      box,
      element("h2", { text: "Credential details need external repair" }),
      element("p", { className: "sub", text: "Close credential setup and preserve the encrypted credentials. Restore the saved credential details from a trusted backup of this same installation, then reopen. If no such backup exists, stop here: this credential window has no reviewed rebuild or erase command. External review is required before re-entry can be added." }),
    );
    if (mode === "developer") {
      box.append(developerFactsBlock([
        ["issueCode", "METADATA_UNAVAILABLE"],
        ["vaultState", model.vaultState],
        ["documentRevision", model.revision?.toString() ?? "none"],
      ]));
    }
    parent.append(box);
    return;
  }
  if (model.recovery === null) return;
  const copy = ERROR_COPY[model.recovery.issueCode];
  const box = element("section", { className: "notice", attrs: { role: "region", "aria-label": "Credential storage recovery", "data-tone": "danger" } });
  append(box, element("h2", { text: copy.title }), element("p", { className: "sub", text: copy.body }));
  const actionCopy: Readonly<Record<RecoveryAction, string>> = Object.freeze({
    "restore-backup": "replace the unreadable store with its previous encrypted backup; any credential changes made after that backup will be lost",
    "start-over": "irreversibly replace the active credential store with an empty one; the displaced unreadable store is preserved for review",
    rebind: "irreversibly discard every encrypted credential, preserve only names and times as records needing recovery, and require each credential to be pasted again",
  });
  const actions = model.recovery.actions.length === 0
    ? "No recovery choice is available in this state."
    : `Available recovery choices: ${model.recovery.actions.map((action) => actionCopy[action]).join("; ")}. These choices are shown for review in this development build and are not available as buttons here.`;
  box.append(element("p", { className: "sub", text: actions }));
  if (mode === "developer") {
    box.append(developerFactsBlock([
      ["issueCode", model.recovery.issueCode],
      ["vaultState", model.vaultState],
      ["primaryFingerprint", displayFingerprint(model.recovery.primaryDigest)],
      ["backupFingerprint", displayFingerprint(model.recovery.backupDigest)],
      ["recovery.actionCodes", model.recovery.actions.join(",") || "none"],
      ["recovery.review", model.recovery.actions.includes("restore-backup") ? "Recheck both displayed fingerprints against the frozen recovery observation before execution" : "No backup-fingerprint review applies"],
    ]));
  }
  parent.append(box);
}

function developerFactsBlock(facts: readonly (readonly [string, string])[]): HTMLElement {
  const block = element("section", { className: "dev-block", attrs: { "aria-label": "Developer facts" } });
  block.append(element("h3", { text: "Developer" }));
  const dl = element("dl");
  for (const [key, value] of facts) append(dl, element("dt", { text: key }), element("dd", { text: value }));
  block.append(dl);
  return block;
}

function renderDeveloperFacts(slot: SlotView): HTMLElement {
  return developerFactsBlock([
    ["credentialId", slot.credentialId ?? "none"],
    ["secretRef", slot.developer.referenceDisplay],
    ["referenceFingerprint", displayFingerprint(slot.developer.referenceFingerprint)],
    ["containerBinding", displayFingerprint(slot.developer.containerBinding)],
    ["vaultBackend", slot.developer.backendKind],
    ["documentRevision", slot.developer.documentRevision?.toString() ?? "none"],
    ["recordState", slot.state],
    ["recordToken", displayFingerprint(slot.developer.recordToken)],
    ["operation.phase", slot.developer.operationPhase],
    ["result.code", slot.developer.resultCode ?? "none"],
    ["policyDecision.fingerprint", displayFingerprint(slot.developer.policyDecisionFingerprint)],
    ["successReceipt.state", slot.developer.successReceiptState ?? "none"],
    ["successReceipt.id", displayFingerprint(slot.developer.successReceiptId)],
    ["successReceipt.sha256", displayFingerprint(slot.developer.successReceiptSha256)],
    ["createdAt", slot.createdAt ?? "none"],
    ["rotatedAt", slot.rotatedAt ?? "none"],
    ["revokedAt", slot.revokedAt ?? "none"],
    ["validation.outcome", slot.validation?.outcome ?? "none"],
    ["validation.checkedAt", slot.validation?.checkedAt ?? "none"],
    ["lastAttempt.outcome", slot.lastValidationAttempt?.outcome ?? "none"],
    ["lastAttempt.checkedAt", slot.lastValidationAttempt?.checkedAt ?? "none"],
  ]);
}

function renderEntryDeveloperFacts(slot: SlotView, operation: "save" | "rotate" | "reenter"): HTMLElement {
  return developerFactsBlock([
    ["operation", `credential-${operation}`],
    ["provider", slot.slotId],
    ["credentialId", slot.credentialId ?? "assigned-on-commit"],
    ["secretRef", slot.developer.referenceDisplay],
    ["referenceFingerprint", displayFingerprint(slot.developer.referenceFingerprint)],
    ["vaultBackend", slot.developer.backendKind],
    ["documentRevision", slot.developer.documentRevision?.toString() ?? "none"],
    ["recordState", slot.state],
    ["recordToken", displayFingerprint(slot.developer.recordToken)],
    ["createdAt", slot.createdAt ?? "none"],
    ["rotatedAt", slot.rotatedAt ?? "none"],
    ["revokedAt", slot.revokedAt ?? "none"],
    ["validation.checkedAt", slot.validation?.checkedAt ?? "none"],
    ["lastAttempt.checkedAt", slot.lastValidationAttempt?.checkedAt ?? "none"],
    ["localFormatRule", "provider-family check only; value never echoed"],
    ["transmitsOnSave", "false"],
    ["request.schemaVersion", "1"],
  ]);
}

function renderProviderCard(slot: SlotView): HTMLElement {
  const card = element("article", { className: "card provider-card", attrs: { "data-slot-id": slot.slotId, role: "listitem" } });
  const head = element("div", { className: "provider-head" });
  const title = element("div", { className: "provider-title" });
  append(title, element("h2", { text: slot.displayName }), element("p", { text: slot.productName }));
  const status = statusFor(slot);
  const badge = element("span", { className: "badge", text: status.label, attrs: { "data-tone": status.tone } });
  append(head, element("span", { className: "provider-mark", text: CATALOGUE[slot.slotId].mark, attrs: { "aria-hidden": "true" } }), title, badge);
  const recoveryState = model !== null && model.vaultState !== "ready" && model.vaultState !== "absent";
  card.append(head, element("p", { className: "provider-body", text: slot.state === "absent" || recoveryState || model?.metadataAvailable === false ? status.sentence : `${slot.nickname ?? slot.displayName} · ${status.sentence}` }));
  const actions = element("div", { className: "button-row" });
  if (slot.state === "absent") actions.append(button("Save credential", () => openEntry(slot, "save"), "btn primary", storageChangeReason(model?.vaultState === "absent" || model?.vaultState === "ready" ? null : "Secure storage needs recovery first"), `save-${slot.slotId}`));
  else {
    const manageReason = storageChangeReason(slot.state === "unrecoverable" && mutationInputs(slot) === null ? "Secure storage recovery is required first" : null);
    actions.append(button("Manage", () => { rememberFocus(); selectedSlotId = slot.slotId; render(); }, "btn", manageReason, `manage-${slot.slotId}`));
  }
  card.append(actions);
  appendActionReasons(card, actions, `card-${slot.slotId}`);
  return card;
}

const MULTI_CREDENTIAL_MANAGEMENT_REASON = "Multiple credentials require a compatible credential setup version";

function providerGroupManageReason(): string {
  return globalActionReason() ?? MULTI_CREDENTIAL_MANAGEMENT_REASON;
}

function providerSlotGroups(slots: readonly SlotView[]): readonly (readonly SlotView[])[] {
  const groups = new Map<SlotId, SlotView[]>();
  for (const slot of slots) {
    const group = groups.get(slot.slotId) ?? [];
    group.push(slot);
    groups.set(slot.slotId, group);
  }
  return Object.freeze([...groups.values()].map((group) => Object.freeze(group)));
}

function renderProviderGroupStatus(slots: readonly SlotView[]): Readonly<{ tone: Tone; label: string; body: string }> {
  const saved = slots.filter((slot) => slot.state === "present" || slot.state === "unrecoverable").length;
  const credentialPhrase = (count: number, singular: string, plural: string) => `${count} ${count === 1 ? singular : plural}`;
  if (model !== null && model.vaultState !== "ready" && model.vaultState !== "absent") return {
    tone: "danger",
    label: model.vaultState === "encryption-unavailable" ? "Secure storage unavailable" : "Recovery required",
    body: "Credential counts and provider-acceptance details are unavailable until secure storage recovery is completed.",
  };
  if (model?.metadataAvailable === false) return {
    tone: "warn",
    label: "Details unavailable",
    body: `${credentialPhrase(saved, "saved credential", "saved credentials")} · Credential details are unavailable until this installation's saved credential details are restored.`,
  };

  const statuses = slots.map(statusFor);
  const enabled = slots.filter((slot) => slot.state === "present" && slot.enabled);
  const disabled = slots.filter((slot) => slot.state === "present" && !slot.enabled).length;
  const removed = slots.filter((slot) => slot.state === "revoked").length;
  const unreadable = slots.filter((slot) => slot.state === "unrecoverable").length;
  const invalid = enabled.filter((slot) => (slot.lastValidationAttempt ?? slot.validation)?.outcome === "invalid").length;
  const inconclusive = enabled.filter((slot) => {
    const latest = slot.lastValidationAttempt ?? slot.validation;
    return latest !== null && !latest.definitive;
  }).length;
  const limited = enabled.filter((slot) => {
    const latest = slot.lastValidationAttempt ?? slot.validation;
    return latest?.definitive === true && latest.outcome === "unauthorized" && validationAge(latest.checkedAt).recorded;
  }).length;
  const stale = enabled.filter((slot) => {
    const latest = slot.lastValidationAttempt ?? slot.validation;
    if (latest?.definitive !== true || latest.outcome !== "valid") return false;
    const age = validationAge(latest.checkedAt);
    return age.recorded && age.stale;
  }).length;
  const otherCheck = enabled.filter((slot) => {
    const latest = slot.lastValidationAttempt ?? slot.validation;
    return latest?.definitive === true && latest.outcome !== "invalid" && !validationAge(latest.checkedAt).recorded;
  }).length;
  const accepted = statuses.filter((status) => status.connected).length;
  const unvalidated = enabled.filter((slot) => (slot.lastValidationAttempt ?? slot.validation) === null).length;
  const needsCheck = inconclusive + limited + stale + otherCheck;
  const attention = invalid + unreadable;
  const body = [
    credentialPhrase(saved, "saved credential", "saved credentials"),
    `${credentialPhrase(accepted, "credential accepted", "credentials accepted")} by the provider`,
    credentialPhrase(unvalidated, "credential not validated", "credentials not validated"),
    credentialPhrase(needsCheck, "credential needs a check", "credentials need a check"),
    credentialPhrase(attention, "credential needs attention", "credentials need attention"),
    credentialPhrase(disabled, "disabled credential", "disabled credentials"),
    ...(removed === 0 ? [] : [credentialPhrase(removed, "removed credential", "removed credentials")]),
  ].join(" · ");

  if (unreadable > 0) return { tone: "danger", label: "Credentials can't be read", body };
  if (invalid > 0) return { tone: "danger", label: "Needs attention", body };
  if (inconclusive > 0 || limited > 0 || otherCheck > 0) return { tone: "warn", label: "Check needed", body };
  if (stale > 0) return { tone: "warn", label: "Check getting stale", body };
  if (enabled.length === 0 && disabled > 0) return { tone: "neutral", label: "All credentials disabled", body };
  if (accepted > 0) return { tone: "ok", label: unvalidated > 0 ? `Connected · ${unvalidated} ${unvalidated === 1 ? "credential" : "credentials"} unvalidated` : "Connected", body };
  if (saved > 0) return { tone: "neutral", label: "Saved · not validated", body };
  return { tone: "neutral", label: "Removed", body };
}

function renderProviderGroup(slots: readonly SlotView[]): HTMLElement {
  if (slots.length === 1) return renderProviderCard(slots[0]!);
  const representative = slots[0]!;
  const status = renderProviderGroupStatus(slots);
  const card = element("article", { className: "card provider-card", attrs: { "data-slot-id": representative.slotId, "data-credential-count": slots.length.toString(), role: "listitem" } });
  const head = element("div", { className: "provider-head" });
  const title = element("div", { className: "provider-title" });
  append(title, element("h2", { text: representative.displayName }), element("p", { text: representative.productName }));
  append(head, element("span", { className: "provider-mark", text: CATALOGUE[representative.slotId].mark, attrs: { "aria-hidden": "true" } }), title, element("span", { className: "badge", text: status.label, attrs: { "data-tone": status.tone } }));
  card.append(head, element("p", { className: "provider-body", text: status.body }));
  const actions = element("div", { className: "button-row" });
  actions.append(button(`Manage ${slots.length} credentials`, () => undefined, "btn", providerGroupManageReason()));
  card.append(actions);
  appendActionReasons(card, actions, `card-${representative.slotId}`);
  return card;
}

function initialStatePending(): boolean {
  return model === null && sessionPresentationState === "editing" && authoritativeStateFresh;
}

function renderOverview(parent: HTMLElement): void {
  const header = element("div", { className: "view-head" });
  const heading = element("div");
  const h1 = element("h1", { text: "Providers & integrations", attrs: { tabindex: "-1" } });
  append(heading, h1, element("p", { className: "sub", text: "Credentials are encrypted and stay on this PC. Saving never contacts a provider." }));
  const pending = initialStatePending();
  const addReason = model === null
    ? pending ? "Secure storage is loading" : REOPEN_AFTER_TERMINAL_REFUSAL
    : model.vaultState === "absent" || model.vaultState === "ready" ? null : "Secure storage needs recovery first";
  const add = button("Add credential", openProviderPicker, "btn primary", storageChangeReason(addReason), "add-provider");
  append(header, heading, add);
  appendActionReasons(header, header, "overview-add");
  parent.append(header);
  renderNotice(parent);
  renderRecovery(parent);
  renderGlobalActionReason(parent, "overview-global");
  const strip = element("section", { className: "strip", attrs: { "aria-label": "Credential summary" } });
  const validationAvailability = model === null
    ? pending ? "Loading validation availability" : "Validation availability unavailable"
    : model.validationEnabled && model.validationAuthorization?.state === "available"
      ? "One-shot Anthropic validation available"
      : model.validationAuthorization?.state === "consumed"
        ? "Anthropic validation authorization consumed — a new separately bound authorization is required for any further attempt"
        : model.validationAuthorization?.state === "expired"
          ? "Anthropic validation authorization expired — a new separately bound authorization is required"
          : model.validationAuthorization?.state === "invalid"
            ? "Anthropic validation authorization invalid — no provider request is available"
            : "Live validation disabled";
  append(strip, element("strong", { text: model === null ? pending ? "Loading secure storage…" : "Secure storage is unavailable — close and reopen credential setup" : aggregate(model) }), element("span", { text: "Development build — tasks do not run against providers" }), element("span", { text: validationAvailability }));
  parent.append(strip);
  if (model === null) return;
  const grid = element("div", { className: "provider-grid", attrs: { role: "list", "aria-label": "Supported providers" } });
  for (const slots of providerSlotGroups(model.slots)) grid.append(renderProviderGroup(slots));
  parent.append(grid);
}

function activeValidationCredentialId(): string | null {
  return validatingCredentialId ?? model?.slots.find((slot) => slot.developer.operationPhase === "validation-in-flight")?.credentialId ?? null;
}

function detailActionButton(slot: SlotView, label: string, action: () => void, focusKey: string, blockedReason: string | null = null, kind = "btn"): HTMLButtonElement {
  const validating = activeValidationCredentialId() === slot.credentialId;
  return button(label, action, kind, blockedReason ?? (validating ? "Check in progress" : null), focusKey);
}

function globalActionReason(): string | null {
  if (mutationInFlight) return "A storage change is in progress";
  if (refreshInFlight) return "Current credential state is being refreshed";
  if (activeValidationCredentialId() !== null) return "A credential validation check is in progress";
  if (sessionPresentationState === "committed") return REOPEN_FOR_STORAGE_CHANGE;
  if (sessionPresentationState === "failed") return REOPEN_AFTER_TERMINAL_REFUSAL;
  if (model === null) return initialStatePending() ? "Secure storage is loading" : "Secure storage is unavailable; close and reopen credential setup";
  if (model.vaultState !== "absent" && model.vaultState !== "ready") return "Secure storage recovery is required before credential actions";
  if (!model.metadataAvailable) return "Restore this installation's saved credential details before credential actions";
  return null;
}

function storageChangeReason(reason: string | null = null): string | null {
  return globalActionReason() ?? reason;
}

function validationReason(reason: string | null = null): string | null {
  const globalReason = globalActionReason();
  if (globalReason !== null && globalReason !== REOPEN_FOR_STORAGE_CHANGE) return globalReason;
  if (validationPresentationState === "reopen-required") return "Close and reopen credential setup before another validation check";
  if (!authoritativeStateFresh) return "Reopen credential setup to load current credential state";
  return reason;
}

function validationAuthorizationFor(slot: SlotView): ValidationAuthorizationView | null {
  const authorization = model?.validationAuthorization ?? null;
  return model?.validationEnabled === true && slot.slotId === "anthropic" &&
    authorization?.state === "available" && authorization.slotId === "anthropic"
    ? authorization
    : null;
}

function renderDetail(parent: HTMLElement, slot: SlotView): void {
  const header = element("div", { className: "view-head" });
  const heading = element("div");
  const back = button("← Providers", () => { rememberFocus(); selectedSlotId = null; render(); }, "btn subtle", null, "back-providers");
  const h1 = element("h1", { text: slot.displayName, attrs: { tabindex: "-1", "data-focus-key": `detail-heading-${slot.slotId}` } });
  append(heading, back, h1, element("p", { className: "sub", text: slot.productName }));
  append(header, heading);
  parent.append(header);
  renderNotice(parent);
  renderGlobalActionReason(parent, "detail-global");
  const status = statusFor(slot);
  const card = element("article", { className: "card detail-card", attrs: { "data-slot-id": slot.slotId } });
  const cardHead = element("div", { className: "provider-head" });
  const title = element("div", { className: "provider-title" });
  append(title, element("h2", { text: slot.nickname ?? slot.displayName }), element("p", { text: slot.ownership === "authorized" ? `Authorised by ${slot.authorizedBy ?? "recorded owner"}` : slot.ownership === "owned" ? "Owned" : "Ownership unavailable" }));
  append(cardHead, title, element("span", { className: "badge", text: status.label, attrs: { "data-tone": status.tone } }));
  card.append(cardHead, element("p", { className: "sub", text: status.sentence }));
  const facts = element("dl", { className: "facts" });
  const latestValidation = slot.lastValidationAttempt ?? slot.validation;
  const rows: Array<readonly [string, string]> = [
    ["Storage", slot.state === "present" ? "Encrypted on this PC" : slot.state === "revoked" ? mode === "developer" ? "Encrypted value removed; nonsecret tombstone retained" : sessionPresentationState === "committed" ? "Encrypted value removed; reopen credential setup to re-enter" : "Encrypted value removed; re-entry available" : "Re-entry required"],
    ["Enabled", model?.metadataAvailable === false ? "Unavailable" : slot.enabled ? "Yes — but tasks remain disabled in this build" : "No — disabled for future use"],
    ["Last validation", model?.metadataAvailable === false ? "Unavailable" : validationSummary(latestValidation)],
    ...(model?.metadataAvailable !== false && latestValidation?.definitive === false
      ? [["Last known result", slot.validation?.definitive === true ? validationSummary(slot.validation) : "No earlier definitive result"] as const]
      : []),
    ["Created", date(slot.createdAt)],
    ["Last rotated", date(slot.rotatedAt)],
  ];
  if (mode === "developer") rows.splice(1, 0, ["Presentation metadata", model?.metadataAvailable === false ? "Unavailable — no ownership, enable, or validation fact is inferred" : "Available"]);
  for (const [term, value] of rows) append(facts, element("dt", { text: term }), element("dd", { text: value }));
  card.append(facts, element("div", { className: "divider" }));
  const actions = element("div", { className: "button-row" });
  const inputs = mutationInputs(slot);
  if (slot.state === "revoked" || slot.state === "unrecoverable") {
    actions.append(detailActionButton(slot, "Re-enter credential", () => openEntry(slot, "reenter"), `reenter-${slot.slotId}`, storageChangeReason(inputs === null ? "Secure storage recovery is required first" : null)));
  } else if (slot.state === "present") {
    if (validationAuthorizationFor(slot) !== null) {
      actions.append(detailActionButton(slot, "Validate connection", () => openValidation(slot), `validate-${slot.slotId}`, validationReason(slot.enabled ? null : "Enable this credential first"), "btn primary"));
    }
    actions.append(detailActionButton(slot, "Rotate credential", () => openEntry(slot, "rotate"), `rotate-${slot.slotId}`, storageChangeReason()));
    actions.append(detailActionButton(slot, slot.enabled ? "Disable" : "Enable", () => { void setEnabled(slot, !slot.enabled); }, `enabled-${slot.slotId}`, storageChangeReason(inputs === null ? "Refresh required" : model?.metadataAvailable === false ? "Presentation metadata is unavailable" : null)));
  }
  if (slot.state !== "revoked") actions.append(detailActionButton(slot, "Remove from this PC…", () => openRemoval(slot), `remove-${slot.slotId}`, storageChangeReason(inputs === null ? "Refresh required" : null), "btn danger"));
  card.append(actions);
  appendActionReasons(card, actions, `detail-${slot.slotId}`);
  if (mode === "developer") card.append(renderDeveloperFacts(slot));
  parent.append(card);
}

function renderActivity(parent: HTMLElement): void {
  const h1 = element("h1", { text: "Credential activity", attrs: { tabindex: "-1" } });
  append(parent, h1, element("p", { className: "sub", text: "Activity shows non-sensitive summaries only. Credential values and fragments never appear here." }));
  renderNotice(parent);
  const list = element("ol", { className: "activity-list" });
  if (model === null) {
    list.append(element("li", { className: "card", text: initialStatePending() ? "Loading credential activity…" : "Credential Activity is unavailable. Close and reopen credential setup; no absence of earlier activity is inferred." }));
  } else if (!model.metadataAvailable) {
    list.append(element("li", { className: "card", text: "Credential Activity and presentation details are unavailable. No absence of earlier activity is inferred." }));
  } else {
    for (const item of model.activity) {
      const row = element("li", { className: "card", attrs: { "data-tone": item.tone } });
      append(row, element("time", { text: date(item.at), attrs: { datetime: item.at } }), element("span", { text: item.text }));
      list.append(row);
    }
    if (list.childElementCount === 0) list.append(element("li", { className: "card", text: "No credential activity recorded in this credential window." }));
  }
  parent.append(list);
}

function render(): void {
  if (deferredFocusKey === null) rememberFocus();
  main.replaceChildren();
  const root = element("section", { className: ageOnlyRender ? "view age-only" : "view", attrs: { "data-view": view } });
  if (view === "activity") renderActivity(root);
  else {
    const slot = selectedSlotId === null ? undefined : model?.slots.find((item) => item.slotId === selectedSlotId);
    const recoveryState = model !== null && model.vaultState !== "ready" && model.vaultState !== "absent";
    if (slot === undefined || slot.state === "absent" || recoveryState || model?.metadataAvailable === false) { selectedSlotId = null; renderOverview(root); }
    else renderDetail(root, slot);
  }
  main.append(root);
  for (const nav of document.querySelectorAll<HTMLButtonElement>(".rail button[data-view]")) nav.setAttribute("aria-current", nav.dataset["view"] === view ? "page" : "false");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const openDialog = document.querySelector<HTMLDialogElement>("dialog[open]");
      if (openDialog !== null) {
        const active = document.activeElement;
        if (!openDialog.contains(active) || (active instanceof HTMLButtonElement && active.disabled) || (active instanceof HTMLInputElement && active.disabled)) {
          openDialog.querySelector<HTMLElement>("[data-busy-focus], button:not(:disabled), input:not(:disabled)")?.focus();
        }
        return;
      }
      if (deferredFocusKey !== null) {
        const deferred = document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(deferredFocusKey)}"]`);
        if (deferred !== null && !deferred.hasAttribute("disabled")) {
          lastFocusKey = deferredFocusKey;
          deferredFocusKey = null;
          deferred.focus();
          return;
        }
        if (!refreshInFlight) deferredFocusKey = null;
      }
      restoreFocus();
    });
  });
}

function dialogShell(title: string): { dialog: HTMLDialogElement; body: HTMLElement; foot: HTMLElement } {
  dialogSequence += 1;
  const titleId = `credential-dialog-title-${dialogSequence}`;
  const dialog = element("dialog", { attrs: { "aria-labelledby": titleId } });
  const opener = document.activeElement;
  if (opener instanceof HTMLElement) dialogOpeners.set(dialog, opener);
  const head = element("div", { className: "dialog-head" });
  append(head, element("h2", { text: title, attrs: { id: titleId } }));
  const body = element("div", { className: "dialog-body" });
  const foot = element("div", { className: "dialog-foot" });
  append(dialog, head, body, foot);
  document.body.append(dialog);
  return { dialog, body, foot };
}

function reopenBusyDialog(dialog: HTMLDialogElement): void {
  queueMicrotask(() => {
    if (!dialog.isConnected || dialog.open) return;
    dialog.showModal();
    requestAnimationFrame(() => {
      if (!dialog.isConnected || !dialog.open) return;
      dialog.querySelector<HTMLElement>('[data-busy-focus="true"]')?.focus();
    });
  });
}

function destroyDialog(dialog: HTMLDialogElement, password: HTMLInputElement | null = null): void {
  if (finalizingDialogs.has(dialog)) return;
  finalizingDialogs.add(dialog);
  const opener = dialogOpeners.get(dialog) ?? null;
  dialogOpeners.delete(dialog);
  if (password !== null) password.value = "";
  if (dialog.open) dialog.close();
  dialog.replaceChildren();
  dialog.remove();
  requestAnimationFrame(() => {
    if (opener !== null && opener.isConnected && !(opener instanceof HTMLButtonElement && opener.disabled)) opener.focus();
    else document.querySelector<HTMLElement>("h1")?.focus();
  });
}

function inputField(label: string, id: string, help: string): { wrap: HTMLElement; input: HTMLInputElement; error: HTMLElement } {
  const wrap = element("div", { className: "field" });
  const labelNode = element("label", { text: label, attrs: { for: id } });
  const input = element("input", { attrs: { id, type: "text", autocomplete: "off", spellcheck: "false", maxlength: "40", "aria-describedby": `${id}-help ${id}-error` } });
  const helpNode = element("div", { className: "help", text: help, attrs: { id: `${id}-help` } });
  const error = element("div", { className: "error", attrs: { id: `${id}-error` } });
  append(wrap, labelNode, input, helpNode, error);
  return { wrap, input, error };
}

function setFieldError(input: HTMLInputElement, error: HTMLElement, message: string): void {
  input.setAttribute("aria-invalid", message.length > 0 ? "true" : "false");
  error.textContent = message;
}

function openProviderPicker(): void {
  if (model === null) return;
  const shell = dialogShell("Choose a provider");
  const providerGroups = providerSlotGroups(model.slots);
  const hasMultipleCredentials = providerGroups.some((slots) => slots.length > 1);
  shell.body.append(element("p", { className: "sub", text: hasMultipleCredentials
    ? "Choose one of the four supported providers. This credential setup version can manage one active credential per provider; grouped credentials from a later-compatible view are review-only here."
    : "Choose one of the four supported providers. This credential setup version can manage one active credential per provider." }));
  const picker = element("ul", { className: "provider-picker" });
  for (const slots of providerGroups) {
    const slot = slots[0]!;
    const item = element("li", { attrs: { "data-slot-id": slot.slotId } });
    const row = element("button", { attrs: { type: "button" } });
    const multiple = slots.length > 1;
    const blocked = multiple ? providerGroupManageReason() : slot.state === "absent" ? storageChangeReason() : null;
    if (blocked !== null) {
      row.disabled = true;
      row.title = blocked;
      row.dataset["disabledReason"] = blocked;
      row.setAttribute("aria-describedby", `provider-picker-reason-${slot.slotId}`);
    }
    append(row, element("span", { className: "provider-mark", text: CATALOGUE[slot.slotId].mark, attrs: { "aria-hidden": "true" } }), element("span", { text: slot.displayName }), element("span", { text: multiple ? `${slots.length} credentials` : slot.state === "absent" ? "Save" : "Manage" }));
    row.addEventListener("click", () => { destroyDialog(shell.dialog); if (slot.state === "absent") openEntry(slot, "save"); else { selectedSlotId = slot.slotId; render(); } });
    item.append(row);
    if (blocked !== null) item.append(element("p", { className: "action-reasons", text: `${multiple ? "Manage" : "Save"} unavailable — ${blocked}.`, attrs: { id: `provider-picker-reason-${slot.slotId}` } }));
    picker.append(item);
  }
  shell.body.append(picker);
  shell.foot.append(button("Cancel", () => destroyDialog(shell.dialog)));
  shell.dialog.addEventListener("cancel", (event) => { event.preventDefault(); destroyDialog(shell.dialog); });
  shell.dialog.showModal();
  (picker.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? shell.foot.querySelector<HTMLButtonElement>("button"))?.focus();
}

function openEntry(slot: SlotView, operation: "save" | "rotate" | "reenter"): void {
  const shell = dialogShell(operation === "save" ? `Save credential — ${slot.displayName}` : operation === "rotate" ? `Rotate ${slot.displayName}` : `Re-enter ${slot.displayName}`);
  shell.dialog.classList.add("credential-entry-dialog");
  const facts = element("ul", { className: "disclosure" });
  const disclosureId = `${shell.dialog.getAttribute("aria-labelledby") ?? "credential-entry"}-description`;
  facts.id = disclosureId;
  shell.dialog.setAttribute("aria-describedby", disclosureId);
  const messages = operation === "rotate"
    ? ["The current encrypted credential stays in place until a replacement commit is confirmed.", `Saving still does not contact ${slot.displayName}.`, `After replacement, revoke the old credential at ${slot.displayName} if it should stop working elsewhere.`]
    : operation === "reenter"
      ? [
        slot.state === "unrecoverable" ? "The saved encrypted credential cannot be read. A confirmed re-entry replaces that unreadable copy." : "The local encrypted value was removed. A confirmed re-entry replaces the local removal record with a new encrypted credential.",
        `Re-entry does not contact ${slot.displayName}; validation remains a separate explicit action.`,
        "The replacement is encrypted and stored only on this PC. It is never shown again, copied, or exported.",
      ]
      : ["The value is encrypted and stored only on this PC. It is never shown again, copied, or exported.", `Saving does not contact ${slot.displayName}. Validation is a separate explicit action.`, "This protected window is excluded from ordinary screen capture as defence in depth; a camera can still photograph it."];
  for (const message of messages) facts.append(element("li", { text: message }));
  if (operation !== "save") facts.append(element("li", { text: "This protected window is excluded from ordinary screen capture as defence in depth; a camera can still photograph it." }));
  shell.body.append(facts);
  if (mode === "developer") shell.body.append(renderEntryDeveloperFacts(slot, operation));
  const errorSummary = element("div", { className: "form-error-summary", attrs: { role: "alert", tabindex: "-1" } });
  errorSummary.hidden = true;
  shell.body.append(errorSummary);

  const nicknameField = inputField("Nickname", "credential-nickname", "A friendly label that does not contain the credential. It is not used as storage identity. In this version, changing it later requires removal and re-entry.");
  nicknameField.input.value = slot.nickname ?? "Personal";
  if (operation !== "rotate") shell.body.append(nicknameField.wrap);

  let ownership: Ownership = slot.ownership ?? "owned";
  const ownershipGroup = element("fieldset");
  ownershipGroup.append(element("legend", { text: "Whose credential is this?" }));
  const choices = element("div", { className: "choices" });
  for (const item of [{ value: "owned", label: "Mine", detail: "Labelled Owned." }, { value: "authorized", label: "Someone authorised me", detail: "The authorising label is stored without the credential." }] as const) {
    const label = element("label", { className: "choice" });
    const radio = element("input", { attrs: { type: "radio", name: "credential-ownership", value: item.value } });
    radio.checked = ownership === item.value;
    radio.addEventListener("change", () => {
      ownership = item.value;
      authorizedField.wrap.hidden = ownership !== "authorized";
      if (authorizedField.wrap.hidden) {
        authorizedField.input.value = "";
        clearCorrectedFieldError(authorizedField);
      }
      else authorizedField.input.focus();
    });
    const words = element("span");
    append(words, element("strong", { text: item.label }), element("span", { className: "help", text: item.detail }));
    append(label, radio, words);
    choices.append(label);
  }
  ownershipGroup.append(choices);
  const authorizedField = inputField("Authorised by", "credential-authorized-by", "Use a role or first name, never a credential value.");
  authorizedField.input.value = slot.authorizedBy ?? "";
  authorizedField.wrap.hidden = ownership !== "authorized";
  const clearCorrectedFieldError = (field: { input: HTMLInputElement; error: HTMLElement }): void => {
    setFieldError(field.input, field.error, "");
    errorSummary.hidden = true;
    errorSummary.textContent = "";
  };
  nicknameField.input.addEventListener("input", () => clearCorrectedFieldError(nicknameField));
  authorizedField.input.addEventListener("input", () => clearCorrectedFieldError(authorizedField));
  if (operation !== "rotate") append(shell.body, ownershipGroup, authorizedField.wrap);

  const keyWrap = element("div", { className: "field" });
  const keyLabel = element("label", { text: `${slot.displayName} credential`, attrs: { for: "credential-secret" } });
  const key = element("input", { attrs: { id: "credential-secret", name: randomSecretFieldName(), type: "password", autocomplete: "new-password", spellcheck: "false", autocapitalize: "off", autocorrect: "off", placeholder: "Press Ctrl+V to paste", "aria-describedby": "credential-secret-help credential-secret-format" } });
  const keyHelp = element("div", { className: "help", text: `${CATALOGUE[slot.slotId].acquisition} Paste it into this protected password field. After saving, there is no masked echo or last-four display. The credential is never revealed, copied, or exported.`, attrs: { id: "credential-secret-help" } });
  const keyFormat = element("div", { className: "help", text: "Nothing pasted yet.", attrs: { id: "credential-secret-format", role: "status", "data-tone": "neutral" } });
  let submit: HTMLButtonElement;
  const clearKey = button("Clear", () => {
    key.value = "";
    updateKeyFormat("Field cleared. Nothing pasted yet.");
    key.focus();
  }, "btn subtle", "The protected field is empty");
  function updateKeyFormat(sentenceOverride?: string): LocalCredentialFormat {
    const local = localCredentialFormat(slot.slotId, key.value);
    keyFormat.textContent = sentenceOverride ?? local.sentence;
    keyFormat.dataset["tone"] = local.tone;
    key.setAttribute("aria-invalid", local.blocks && key.value.length > 0 ? "true" : "false");
    clearKey.disabled = key.value.length === 0;
    clearKey.title = clearKey.disabled ? "The protected field is empty" : "";
    if (clearKey.disabled) {
      clearKey.dataset["disabledReason"] = "The protected field is empty";
      clearKey.setAttribute("aria-label", "Clear. Unavailable: The protected field is empty.");
    } else {
      delete clearKey.dataset["disabledReason"];
      clearKey.setAttribute("aria-label", "Clear protected field");
    }
    submit.disabled = local.blocks;
    return local;
  }
  key.addEventListener("input", () => { updateKeyFormat(); errorSummary.hidden = true; errorSummary.textContent = ""; });
  append(keyWrap, keyLabel, key, keyHelp, keyFormat, element("div", { className: "button-row" }));
  keyWrap.querySelector<HTMLElement>(".button-row")?.append(clearKey);
  shell.body.append(keyWrap);

  const clipboardBlock = element("div", { className: "clipboard-choice" });
  const clipboardLabel = element("label", { className: "check" });
  const clipboardLabelId = `credential-clipboard-label-${operation}`;
  const clipboardHelpId = `credential-clipboard-help-${operation}`;
  const clipboardChoice = element("input", { attrs: { type: "checkbox", "aria-labelledby": clipboardLabelId, "aria-describedby": clipboardHelpId } });
  clipboardChoice.checked = model?.clipboardClearDefault ?? true;
  const clipboardAction = operation === "save" ? "save" : operation === "rotate" ? "replacement" : "re-entry";
  append(clipboardLabel, clipboardChoice, element("strong", { text: `Clear the current clipboard item after confirmed ${clipboardAction}`, attrs: { id: clipboardLabelId } }));
  append(clipboardBlock, clipboardLabel, element("p", { className: "help", text: "The app never reads the clipboard. Windows clipboard history or cloud sync may retain earlier copies; use Win+V → Clear all if needed.", attrs: { id: clipboardHelpId } }));
  shell.body.append(clipboardBlock);

  const local = element("span", { className: "local-note", text: "Cancel closes this secure window. Nothing is saved." });
  const cancel = button("Cancel and close", () => cancelEntry());
  submit = button(operation === "save" ? "Save securely" : operation === "rotate" ? "Replace securely" : "Re-enter securely", () => { void submitEntry(); }, "btn primary");
  append(shell.foot, local, cancel, submit);
  let submitting = false;
  let entryFinalized = false;
  updateKeyFormat();

  function showEntryError(message: string, target: HTMLInputElement): void {
    const link = element("a", { text: message, attrs: { href: `#${target.id}` } });
    link.addEventListener("click", (event) => { event.preventDefault(); target.focus(); });
    errorSummary.replaceChildren(link);
    errorSummary.hidden = false;
    link.focus();
  }

  function finalizeEntry(kind: "cancel" | "complete"): void {
    if (entryFinalized) return;
    if (kind === "cancel" && submitting) {
      reopenBusyDialog(shell.dialog);
      return;
    }
    entryFinalized = true;
    destroyDialog(shell.dialog, key);
    if (kind === "cancel") {
      sessionPresentationState = "failed";
      authoritativeStateFresh = false;
      render();
      void api?.cancel().catch(() => undefined).finally(() => window.close());
      window.setTimeout(() => window.close(), 250);
    }
  }

  function cancelEntry(): void { finalizeEntry("cancel"); }

  shell.dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    cancelEntry();
  });
  shell.dialog.addEventListener("close", () => {
    key.value = "";
    if (!entryFinalized) finalizeEntry("cancel");
  });

  async function submitEntry(): Promise<void> {
    setFieldError(nicknameField.input, nicknameField.error, "");
    setFieldError(authorizedField.input, authorizedField.error, "");
    const localFormat = updateKeyFormat();
    if (operation !== "rotate" && nicknameField.input.value.trim().length === 0) { setFieldError(nicknameField.input, nicknameField.error, "Enter a nickname."); showEntryError("Enter a nickname that does not contain the credential before saving.", nicknameField.input); return; }
    if (operation !== "rotate" && ownership === "authorized" && authorizedField.input.value.trim().length === 0) { setFieldError(authorizedField.input, authorizedField.error, "Say who authorised this credential."); showEntryError("Enter an authorising label that does not contain the credential before saving.", authorizedField.input); return; }
    if (localFormat.blocks) { key.setAttribute("aria-invalid", "true"); showEntryError(localFormat.sentence, key); return; }
    const inputs = mutationInputs(slot);
    if (operation !== "save" && inputs === null) { showRefusal({ schemaVersion: 1, requestId: "0".repeat(32), ok: false, kind: "refused", code: "VAULT_REVISION_CONFLICT", retryable: true }); destroyDialog(shell.dialog, key); return; }

    submitting = true;
    shell.dialog.setAttribute("aria-busy", "true");
    mutationInFlight = true;
    submit.disabled = true;
    cancel.disabled = true;
    clearKey.disabled = true;
    key.disabled = true;
    nicknameField.input.disabled = true;
    ownershipGroup.disabled = true;
    authorizedField.input.disabled = true;
    clipboardChoice.disabled = true;
    const progressText = element("h3", { text: operation === "save" ? "Encrypting and saving…" : operation === "reenter" ? "Encrypting and re-entering…" : "Encrypting and rotating…", attrs: { tabindex: "-1", "data-busy-focus": "true" } });
    shell.body.append(progressText, element("div", { className: "progress mutation-progress", attrs: { "aria-hidden": "true" } }));
    announce(progressText.textContent ?? "Saving securely.");
    render();
    progressText.focus();

    const secret = key.value;
    const clearClipboard = clipboardChoice.checked;
    const nickname = nicknameField.input.value.trim();
    const authorizedBy = ownership === "authorized" ? authorizedField.input.value.trim() : "";
    key.value = "";
    keyWrap.remove();
    let result: Response;
    if (api === undefined) result = { schemaVersion: 1, requestId: "0".repeat(32), ok: false, kind: "refused", code: "SENDER_REJECTED", retryable: false };
    else if (operation === "save") result = await finite(api.save(slot.slotId, secret, nickname, ownership, authorizedBy, clearClipboard));
    else result = await finite(api.rotate(slot.slotId, secret, inputs!.credentialId, inputs!.revision, inputs!.token, clearClipboard, operation, operation === "reenter" ? nickname : null, operation === "reenter" ? ownership : null, operation === "reenter" ? authorizedBy : null));
    finalizeEntry("complete");
    await applyResponse(result, operation === "save" ? "saved" : operation === "reenter" ? "reentered" : "rotated");
  }

  shell.dialog.showModal();
  key.focus();
}

async function finite(promise: Promise<Response>, timeoutMs = 30_000): Promise<Response> {
  const unknown: RefusedResult = { schemaVersion: 1, requestId: "0".repeat(32), ok: false, kind: "unknown", code: "UNKNOWN_OUTCOME", retryable: false };
  const guarded = promise.catch((): Response => unknown);
  return await Promise.race([guarded, new Promise<Response>((resolve) => window.setTimeout(() => resolve(unknown), timeoutMs))]);
}

async function awaitValidationSettlement(promise: Promise<Response>): Promise<Response> {
  const unknown: RefusedResult = { schemaVersion: 1, requestId: "0".repeat(32), ok: false, kind: "unknown", code: "UNKNOWN_OUTCOME", retryable: false };
  return await promise.catch((): Response => unknown);
}

function showRefusal(result: RefusedResult, expected: ExpectedResponse | null = null): void {
  refreshWarning = null;
  const copy = result.code === "RATE_LIMITED" && expected === "validation"
    ? sessionPresentationState === "editing"
      ? { title: "No more validation checks are available in this window", body: "Local credential storage changes remain available. Close and reopen credential setup before starting another provider check." }
      : { title: "No more validation checks are available in this window", body: "Storage changes in this window remain locked. Close and reopen credential setup before another storage change or provider check." }
    : ERROR_COPY[result.code];
  const presentation = REFUSAL_TONE[result.code];
  const definitive = result.kind === "refused" && result.code !== "VAULT_WRITE_FAILED" && result.code !== "UNKNOWN_OUTCOME";
  const currentStateMayHaveChanged = new Set<ErrorCode>(["VAULT_REVISION_CONFLICT", "SLOT_ABSENT", "DECRYPT_FAILED", "VAULT_CORRUPT", "VAULT_BACKUP_ONLY", "VAULT_IDENTITY_MISMATCH", "VAULT_BACKEND_MISMATCH", "VAULT_SCHEMA_AHEAD"]).has(result.code);
  const attempt = expected !== null && storageExpectation(expected)
    ? currentStateMayHaveChanged
      ? "This attempt made no storage change. Review the refreshed current saved state."
      : "This attempt made no storage change."
    : null;
  const contextualBody = definitive && attempt !== null
    ? `${copy.body.replace(/Nothing was saved\.?/u, "").trim()} ${attempt}`.trim()
    : copy.body;
  notice = { tone: presentation.tone, title: copy.title, body: contextualBody, code: result.code };
  announce(`${copy.title}. ${contextualBody}`, presentation.urgent);
  render();
}

function showRefreshFailure(result: RefusedResult, preserveOutcome: boolean): void {
  if (!preserveOutcome || notice === null) {
    showRefusal(result);
    return;
  }
  const copy = ERROR_COPY[result.code];
  refreshWarning = {
    tone: "warn",
    title: "Current details could not be refreshed",
    body: `${copy.title}. The status or outcome shown above remains the best available result, but current credential details are unavailable. Close and reopen credential setup before another action.`,
    code: result.code,
  };
  announce(`${notice.title}. ${notice.body} ${refreshWarning.title}. ${refreshWarning.body}`, REFUSAL_TONE[result.code].urgent);
  render();
}

function clipboardSentence(result: MutationResult): string {
  if (!result.clipboard.requested || result.clipboard.outcome === "not-requested") return "Clipboard left as it was.";
  if (result.clipboard.outcome === "cleared") return "The current clipboard item was cleared. Windows history or cloud sync may retain earlier copies.";
  return "The current clipboard item could not be cleared. Use Win+V → Clear all if needed.";
}

function mutationSentence(result: MutationResult, expected: ExpectedResponse): string {
  const metadata = result.metadataWarning ? " Some presentation details or Activity history could not be updated." : "";
  if (result.kind === "saved") return `${clipboardSentence(result)} This save did not validate or contact the provider.${metadata}`;
  if (result.kind === "rotated") {
    const revokeReminder = expected === "reentered" ? "" : ` The previous credential may still work at ${result.slot.displayName}; revoke it there if it should stop working.`;
    return `${clipboardSentence(result)} This ${expected === "reentered" ? "re-entry" : "rotation"} did not validate or contact the provider.${revokeReminder}${metadata}`;
  }
  if (result.kind === "removed") return `The local encrypted credential was removed. The provider credential may still work at ${result.slot.displayName}; revoke it there if it should stop working.${metadata}`;
  return `This local change did not validate or contact the provider.${metadata}`;
}

type ExpectedResponse = MutationResult["kind"] | "reentered" | "validation" | "enable-state";

function storageExpectation(expected: ExpectedResponse): boolean {
  return expected !== "validation";
}

async function applyResponse(result: Response, expected: ExpectedResponse): Promise<void> {
  refreshWarning = null;
  if (!result.ok) {
    mutationInFlight = false;
    if (expected === "validation") {
      if (TERMINAL_VALIDATION_CODES.has(result.code)) validationPresentationState = "reopen-required";
      refreshInFlight = true;
      authoritativeStateFresh = false;
      showRefusal(result, expected);
      const refreshed = await refresh(false, true);
      refreshInFlight = false;
      authoritativeStateFresh = refreshed;
      if (!refreshed) sessionPresentationState = "failed";
      render();
      return;
    }
    if (storageExpectation(expected) && result.retryable) {
      mutationInFlight = true;
      refreshInFlight = true;
      authoritativeStateFresh = false;
      showRefusal(result, expected);
      const refreshed = await refresh(false, true);
      mutationInFlight = false;
      refreshInFlight = false;
      authoritativeStateFresh = refreshed;
      sessionPresentationState = refreshed ? "editing" : "failed";
      if (refreshed && result.code === "VAULT_REVISION_CONFLICT") {
        notice = { tone: "info", title: "Current credential state refreshed", body: "Review the current details, then deliberately submit again if the change is still wanted. Nothing was retried automatically.", code: result.code };
        announce(`${notice.title}. ${notice.body}`);
      }
      render();
      return;
    }
    if (storageExpectation(expected)) {
      mutationInFlight = true;
      refreshInFlight = true;
      authoritativeStateFresh = false;
      sessionPresentationState = "failed";
      showRefusal(result, expected);
      const refreshed = await refresh(false, true);
      mutationInFlight = false;
      refreshInFlight = false;
      authoritativeStateFresh = refreshed;
      render();
      return;
    }
    if (result.kind === "unknown") { authoritativeStateFresh = false; sessionPresentationState = "failed"; }
    showRefusal(result, expected);
    return;
  }
  if (["saved", "rotated", "enabled", "disabled", "removed"].includes(result.kind)) {
    const mutation = result as MutationResult;
    const mutationHasWarning = mutation.metadataWarning || (mutation.clipboard.requested && mutation.clipboard.outcome === "failed");
    mutationInFlight = true;
    refreshInFlight = true;
    authoritativeStateFresh = false;
    sessionPresentationState = "committed";
    notice = { tone: mutation.kind === "removed" || mutationHasWarning ? "warn" : "ok", title: mutation.kind === "removed" ? "Removed from this PC" : mutation.kind === "rotated" ? expected === "reentered" ? "Credential re-entered" : "Credential rotated" : mutation.kind === "saved" ? "Saved securely" : mutation.kind === "enabled" ? "Credential enabled" : "Credential disabled", body: mutationSentence(mutation, expected) };
    announce(`${notice.title}. ${notice.body}`);
    selectedSlotId = mutation.slot.slotId;
    deferredFocusKey = `detail-heading-${mutation.slot.slotId}`;
    if (model !== null) model = Object.freeze({ ...model, requestId: mutation.requestId, vaultState: "ready", recovery: null, revision: mutation.slot.revision, slots: Object.freeze(model.slots.map((slot) => slot.slotId === mutation.slot.slotId ? mutation.slot : slot)) });
    render();
    const refreshed = await refresh(false, true);
    mutationInFlight = false;
    refreshInFlight = false;
    authoritativeStateFresh = refreshed;
    render();
    return;
  }
  if (result.kind === "validated") {
    if (!result.workSettled) {
      notice = {
        tone: "warn",
        title: "Validation deadline reached; check is still closing",
        body: result.providerDispatched
          ? "One provider dispatch attempt reached the deadline. Cancellation was requested, nothing was retried, and any late outcome will be ignored. Reopen after the check has fully closed."
          : "The deadline passed while credential access was closing. No provider request was sent or may start late. Reopen after the check has fully closed.",
      };
      announce(`${notice.title}. ${notice.body}`);
      refreshInFlight = true;
      authoritativeStateFresh = false;
      sessionPresentationState = "failed";
      render();
      await refresh(false, true);
      refreshInFlight = false;
      authoritativeStateFresh = false;
      sessionPresentationState = "failed";
      render();
      return;
    }
    const resultRecordComplete = result.resultRecording === "recorded" || result.resultRecording === "prior-definitive-preserved";
    const recordingIncomplete = result.activityRecording !== "recorded" || (result.providerDispatched && !resultRecordComplete);
    if (result.applicability === "unknown" || (!result.discarded && recordingIncomplete)) {
      notice = {
        tone: "warn",
        title: result.applicability === "unknown" ? "Check completed; saved credential could not be confirmed" : "Check completed; local record incomplete",
        body: result.providerDispatched
          ? "Exactly one provider check completed. Nothing was retried. The app could not confirm which saved credential the result belongs to, or confirm its local result and Activity record."
          : "No provider request was sent. The app could not confirm which saved credential the local Activity record belongs to.",
      };
      announce(`${notice.title}. ${notice.body}`);
      refreshInFlight = true;
      authoritativeStateFresh = false;
      render();
      const refreshed = await refresh(false, true);
      refreshInFlight = false;
      authoritativeStateFresh = refreshed;
      if (!refreshed) sessionPresentationState = "failed";
      render();
      return;
    }
    if (result.discarded) {
      refreshInFlight = true;
      authoritativeStateFresh = false;
      if (result.activityRecording === "recorded") {
        showRefusal({ schemaVersion: 1, requestId: result.requestId, ok: false, kind: "refused", code: "VALIDATION_STALE", retryable: false });
      } else {
        notice = { tone: "warn", title: "Check result discarded", body: "The checked credential changed, so the result was not applied. Its local Activity record could not be confirmed." };
        announce(`${notice.title}. ${notice.body}`);
        render();
      }
      const refreshed = await refresh(false, true);
      refreshInFlight = false;
      authoritativeStateFresh = refreshed;
      if (!refreshed) sessionPresentationState = "failed";
      render();
      return;
    }
    const observed = date(result.checkedAt);
    const outcomeNotice: Readonly<Record<ValidatedResult["outcome"], Readonly<{ tone: Tone; title: string; body: string }>>> = {
      valid: { tone: "ok", title: "Connection works", body: `The provider accepted the credential at ${observed}. Exactly one separately disclosed check completed, and nothing was retried.` },
      invalid: { tone: "danger", title: "Credential not accepted", body: `The provider rejected the credential at ${observed}. Exactly one separately disclosed check completed, and nothing was retried.` },
      unauthorized: { tone: "warn", title: "Permission limited", body: `The provider accepted the credential but reported limited permission at ${observed}. Exactly one separately disclosed check completed, and nothing was retried.` },
      ambiguous: { tone: "warn", title: "Check unclear", body: `The check did not clearly accept or reject the credential at ${observed}. Nothing was retried, and earlier definitive information was preserved.` },
      unreachable: { tone: "warn", title: "Provider unreachable", body: result.providerDispatched ? `The provider could not be reached or did not complete the check at ${observed}. Nothing was retried, and earlier definitive information was preserved.` : result.deadlineExpired ? `The deadline expired at ${observed} before a provider request was sent. Nothing was retried, and earlier definitive information was preserved.` : `The check ended at ${observed} before provider dispatch. No provider request was sent; nothing was retried, and earlier definitive information was preserved.` },
      "evidence-incomplete": { tone: "warn", title: "Audit receipt not saved", body: `Provider validation succeeded at ${observed}, but its audit receipt could not be saved. The one-shot attempt was consumed, no retry will occur, and earlier definitive information was preserved.` },
    };
    notice = outcomeNotice[result.outcome];
    announce(`${notice.title}. ${notice.body}`, result.outcome === "invalid");
    refreshInFlight = true;
    authoritativeStateFresh = false;
    render();
    const refreshed = await refresh(false, true);
    refreshInFlight = false;
    authoritativeStateFresh = refreshed;
    if (!refreshed) sessionPresentationState = "failed";
    render();
    return;
  }
  if (expected !== "validation" && expected !== "enable-state") await refresh(false);
}

function openValidation(slot: SlotView): void {
  const inputs = mutationInputs(slot);
  if (inputs === null) return;
  const authorization = validationAuthorizationFor(slot);
  if (authorization === null) {
    showRefusal({ schemaVersion: 1, requestId: "0".repeat(32), ok: false, kind: "refused", code: "VALIDATION_AUTHORIZATION_UNAVAILABLE", retryable: false });
    return;
  }
  const shell = dialogShell("Start the one authorised Anthropic validation attempt?");
  const validationIntroId = `${shell.dialog.getAttribute("aria-labelledby") ?? "credential-validation"}-intro`;
  const validationDisclosureId = `${shell.dialog.getAttribute("aria-labelledby") ?? "credential-validation"}-description`;
  const validationIntro = element("p", { text: "Confirming starts one validation attempt using the saved credential. One dispatch attempt; no retry.", attrs: { id: validationIntroId } });
  const list = element("ul", { className: "disclosure", attrs: { id: validationDisclosureId } });
  shell.dialog.setAttribute("aria-describedby", `${validationIntroId} ${validationDisclosureId}`);
  append(shell.body, validationIntro, list);
  for (const sentence of [
    `Provider and model: Anthropic, ${authorization.modelId}.`,
    'Request content: only the fixed synthetic phrase “Reply with exactly OK.” No user, project, repository, or task data is sent.',
    "Maximum output: four tokens.",
    "Standard Anthropic commercial API retention applies; zero-data retention is not claimed.",
    "One attempt only. No automatic or hidden retry will occur.",
    "The saved credential is used only inside the secure main-process boundary and will not be displayed.",
    "Cancel makes no network request and does not consume the one-shot authorization.",
    "Confirm consumes the one-shot authorization immediately before credential resolution and possible dispatch.",
    "The provider effect is limited to 15 seconds within a 20-second host effect deadline. After a successful effect releases the secure callback, local audit-receipt settlement is awaited before completion.",
  ]) list.append(element("li", { text: sentence }));
  if (mode === "developer") shell.body.append(developerFactsBlock([
    ["operation", "ai-dev-os.stage-18e-i.anthropic-validation.v1"],
    ["provider", "anthropic-default"],
    ["endpointProfile", "https://api.anthropic.com/v1/messages"],
    ["model", authorization.modelId ?? "unavailable"],
    ["requestFingerprint", displayFingerprint(authorization.requestFingerprint)],
    ["authorizationPacket", displayFingerprint(authorization.packetFingerprint)],
    ["authorizationReference", authorization.authorizationReference ?? "unavailable"],
    ["expiresAt", authorization.expiresAt ?? "unavailable"],
    ["timeout", "15 seconds provider effect within 20 seconds; receipt settlement awaited afterward"],
    ["retry", "never"],
    ["policyAction", "provider-disclosure then secret-access"],
    ["policyDecision.fingerprint", "minted by main after approval"],
    ["secretRef", slot.developer.referenceDisplay],
    ["recordToken", displayFingerprint(slot.recordToken)],
  ]));
  let validationSubmitting = false;
  const cancel = button("Cancel", () => destroyDialog(shell.dialog));
  const validate = button("Confirm and validate", () => { void run(); }, "btn primary");
  append(shell.foot, cancel, validate);
  shell.dialog.addEventListener("cancel", (event) => { event.preventDefault(); if (!validationSubmitting) destroyDialog(shell.dialog); });
  shell.dialog.addEventListener("close", () => {
    if (finalizingDialogs.has(shell.dialog)) return;
    if (validationSubmitting) reopenBusyDialog(shell.dialog);
    else destroyDialog(shell.dialog);
  });
  async function run(): Promise<void> {
    if (validationSubmitting) return;
    validationSubmitting = true;
    shell.dialog.setAttribute("aria-busy", "true");
    validate.disabled = true;
    cancel.disabled = true;
    validatingCredentialId = inputs!.credentialId;
    const progressHeading = element("h3", { text: "Validating… the one-shot authorization is consumed. One dispatch attempt, no retry. Provider effect up to 15 seconds; local audit-receipt settlement follows.", attrs: { tabindex: "-1", "data-busy-focus": "true" } });
    shell.body.append(
      progressHeading,
      element("p", { className: "help", text: "The one-shot authorization has been consumed and will not be retried. Rotate, re-enter, enable or disable, and remove are unavailable until this check finishes." }),
      element("div", { className: "progress validation-progress", attrs: { "aria-hidden": "true" } }),
    );
    announce(`Validating ${slot.displayName}. The one-shot authorization has been consumed. One dispatch attempt, no retry. Provider effect up to 15 seconds, then local audit-receipt settlement is awaited before completion.`);
    render();
    progressHeading.focus();
    const result = api === undefined
      ? ({ schemaVersion: 1, requestId: "0".repeat(32), ok: false, kind: "refused", code: "SENDER_REJECTED", retryable: false } as const)
      : await awaitValidationSettlement(api.validate(slot.slotId, inputs!.credentialId, inputs!.revision, inputs!.token, true));
    if (!(result.ok && result.kind === "validated" && !result.workSettled)) validatingCredentialId = null;
    deferredFocusKey = `detail-heading-${slot.slotId}`;
    destroyDialog(shell.dialog);
    await applyResponse(result, "validation");
  }
  shell.dialog.showModal();
  cancel.focus();
}

async function setEnabled(slot: SlotView, enabled: boolean): Promise<void> {
  const inputs = mutationInputs(slot);
  if (inputs === null || api === undefined) return;
  mutationInFlight = true;
  announce(`${enabled ? "Enabling" : "Disabling"} ${slot.displayName} credential.`);
  render();
  const result = await finite(api.setEnabled(slot.slotId, inputs.credentialId, inputs.revision, inputs.token, enabled));
  await applyResponse(result, "enable-state");
}

function openRemoval(slot: SlotView): void {
  const inputs = mutationInputs(slot);
  if (inputs === null) return;
  const shell = dialogShell(`Remove ${slot.nickname ?? slot.displayName} from this PC?`);
  const removalDisclosureId = `${shell.dialog.getAttribute("aria-labelledby") ?? "credential-removal"}-description`;
  const list = element("ul", { className: "disclosure", attrs: { id: removalDisclosureId } });
  shell.dialog.setAttribute("aria-describedby", removalDisclosureId);
  for (const sentence of ["The encrypted credential is deleted from this PC. A local removal record remains so re-entry is truthful.", `This does not revoke the credential at ${slot.displayName}. Revoke it there if it should stop working elsewhere.`, "No task state is overridden. Tasks remain disabled in this credential window."]) list.append(element("li", { text: sentence }));
  const label = element("label", { className: "check" });
  const acknowledge = element("input", { attrs: { type: "checkbox" } });
  const acknowledgementId = `remove-acknowledgement-${slot.slotId}`;
  append(label, acknowledge, element("span", { text: `I understand this removes the local encrypted value and does not revoke it at ${slot.displayName}.`, attrs: { id: acknowledgementId } }));
  append(shell.body, list, label);
  const keep = button("Keep credential", () => destroyDialog(shell.dialog));
  const remove = button("Remove from this PC", () => { void run(); }, "btn danger-fill", "Confirm the consequences first", `confirm-remove-${slot.slotId}`);
  remove.setAttribute("aria-describedby", acknowledgementId);
  acknowledge.addEventListener("change", () => {
    remove.disabled = !acknowledge.checked;
    remove.title = acknowledge.checked ? "" : "Confirm the consequences first";
    if (acknowledge.checked) delete remove.dataset["disabledReason"];
    else remove.dataset["disabledReason"] = "Confirm the consequences first";
  });
  append(shell.foot, keep, remove);
  let removalSubmitting = false;
  shell.dialog.addEventListener("cancel", (event) => { event.preventDefault(); if (!removalSubmitting) destroyDialog(shell.dialog); });
  shell.dialog.addEventListener("close", () => {
    if (finalizingDialogs.has(shell.dialog)) return;
    if (removalSubmitting) reopenBusyDialog(shell.dialog);
    else destroyDialog(shell.dialog);
  });
  async function run(): Promise<void> {
    if (removalSubmitting) return;
    removalSubmitting = true;
    shell.dialog.setAttribute("aria-busy", "true");
    remove.disabled = true;
    keep.disabled = true;
    acknowledge.disabled = true;
    mutationInFlight = true;
    const progressHeading = element("h3", { text: "Removing the local encrypted credential…", attrs: { tabindex: "-1", "data-busy-focus": "true" } });
    shell.body.append(progressHeading, element("div", { className: "progress mutation-progress", attrs: { "aria-hidden": "true" } }));
    announce(`Removing ${slot.displayName} credential from this PC.`);
    render();
    progressHeading.focus();
    const result = api === undefined
      ? ({ schemaVersion: 1, requestId: "0".repeat(32), ok: false, kind: "refused", code: "SENDER_REJECTED", retryable: false } as const)
      : await finite(api.remove(slot.slotId, inputs!.credentialId, inputs!.revision, inputs!.token, true));
    destroyDialog(shell.dialog);
    await applyResponse(result, "removed");
  }
  shell.dialog.showModal();
  keep.focus();
}

async function refresh(initial: boolean, preserveOutcome = false): Promise<boolean> {
  if (api === undefined) {
    authoritativeStateFresh = false;
    sessionPresentationState = "failed";
    showRefreshFailure({ schemaVersion: 1, requestId: "0".repeat(32), ok: false, kind: "refused", code: "SENDER_REJECTED", retryable: false }, preserveOutcome);
    return false;
  }
  const result = await finite(api.describe());
  if (!result.ok) {
    if (initial) { authoritativeStateFresh = false; sessionPresentationState = "failed"; }
    showRefreshFailure(result, preserveOutcome);
    return false;
  }
  if (result.kind !== "slots") {
    if (initial) { authoritativeStateFresh = false; sessionPresentationState = "failed"; }
    showRefreshFailure({ schemaVersion: 1, requestId: result.requestId, ok: false, kind: "refused", code: "SCHEMA_REJECTED", retryable: false }, preserveOutcome);
    return false;
  }
  model = result;
  render();
  if (initial) {
    document.querySelector<HTMLElement>("h1")?.focus();
    const availabilityAnnouncement = result.validationEnabled
      ? "Validation availability is enabled."
      : result.validationAuthorization?.state === "consumed"
        ? "The Anthropic one-shot authorization is consumed. A new separately bound authorization is required for any further attempt."
        : result.validationAuthorization?.state === "expired"
          ? "The Anthropic validation authorization is expired. A new separately bound authorization is required."
          : result.validationAuthorization?.state === "invalid"
            ? "The Anthropic validation authorization is invalid. No provider request is available."
            : "Live validation is disabled.";
    announce(`Credential storage loaded. ${aggregate(result)}. ${availabilityAnnouncement}`);
  }
  return true;
}

function openModePicker(): void {
  rememberFocus();
  const shell = dialogShell("Choose presentation mode");
  append(shell.body, element("p", { className: "sub", text: "Normal is concise. Developer adds non-sensitive identifiers, timestamps, codes and fingerprints. Both modes have exactly the same actions and permissions." }));
  const group = element("fieldset");
  group.append(element("legend", { text: "Presentation" }));
  const choices = element("div", { className: "choices" });
  let selected: "normal" | "developer" = mode;
  for (const item of [
    { value: "normal", label: "Normal", detail: "Plain-language credential status and actions." },
    { value: "developer", label: "Developer", detail: "Adds nonsecret implementation facts only." },
  ] as const) {
    const label = element("label", { className: "choice" });
    const radio = element("input", { attrs: { type: "radio", name: `presentation-mode-${dialogSequence}`, value: item.value } });
    radio.checked = selected === item.value;
    radio.addEventListener("change", () => { selected = item.value; });
    const words = element("span");
    append(words, element("strong", { text: item.label }), element("span", { className: "help", text: item.detail }));
    append(label, radio, words);
    choices.append(label);
  }
  group.append(choices);
  shell.body.append(group);
  const cancel = button("Cancel", () => destroyDialog(shell.dialog));
  const apply = button("Apply mode", () => {
    mode = selected;
    document.documentElement.dataset["mode"] = mode;
    modeToggle.textContent = mode === "developer" ? "Mode: Developer" : "Mode: Normal";
    modeToggle.dataset["currentMode"] = mode;
    modeToggle.setAttribute("aria-label", `Interface mode. Current mode: ${mode === "developer" ? "Developer" : "Normal"}. Change mode.`);
    destroyDialog(shell.dialog);
    announce(mode === "developer" ? "Developer presentation enabled. Action authority is unchanged." : "Normal presentation enabled. Action authority is unchanged.");
    render();
  }, "btn primary");
  append(shell.foot, cancel, apply);
  shell.dialog.addEventListener("cancel", (event) => { event.preventDefault(); destroyDialog(shell.dialog); });
  shell.dialog.showModal();
  choices.querySelector<HTMLInputElement>("input:checked")?.focus();
}

modeToggle.addEventListener("click", openModePicker);

for (const nav of document.querySelectorAll<HTMLButtonElement>(".rail button[data-view]")) {
  nav.addEventListener("click", () => {
    view = nav.dataset["view"] === "activity" ? "activity" : "providers";
    selectedSlotId = null;
    render();
    requestAnimationFrame(() => document.querySelector<HTMLElement>("h1")?.focus());
  });
}

function refreshRelativeValidationPresentation(): void {
  if (model === null || document.querySelector("dialog") !== null || !model.slots.some((slot) => (slot.lastValidationAttempt ?? slot.validation) !== null)) return;
  rememberFocus();
  ageOnlyRender = true;
  try { render(); }
  finally { ageOnlyRender = false; }
}

const relativeAgeTimer = window.setInterval(refreshRelativeValidationPresentation, 30_000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshRelativeValidationPresentation(); });
window.addEventListener("pagehide", () => window.clearInterval(relativeAgeTimer), { once: true });

render();
void refresh(true);

export {};
