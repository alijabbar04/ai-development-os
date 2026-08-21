import type {
  CredentialSlotView,
  CredentialSlotsResult,
  CredentialValidationOutcome,
} from "./contracts.js";

export type PresentationMode = "normal" | "developer";
export type CredentialAction = "save" | "rotate" | "validate" | "disable" | "enable" | "remove" | "reenter";

export interface CredentialActionProjection {
  readonly action: CredentialAction;
  readonly disabledReason: string | null;
}

export interface CredentialModeSlotProjection {
  readonly slotId: CredentialSlotView["slotId"];
  readonly status: CredentialStatusProjection;
  readonly actions: readonly CredentialActionProjection[];
  readonly developerFacts: CredentialSlotView["developer"] | null;
}

export interface CredentialStatusProjection {
  readonly tone: "ok" | "info" | "warn" | "danger" | "neutral";
  readonly label: string;
  readonly sentence: string;
  readonly connected: boolean;
}

export function validationIsDefinitive(outcome: CredentialValidationOutcome): boolean {
  return outcome === "valid" || outcome === "invalid" || outcome === "unauthorized";
}

function latestValidation(slot: CredentialSlotView): CredentialSlotView["validation"] {
  return slot.lastValidationAttempt ?? slot.validation;
}

function lastKnownSentence(slot: CredentialSlotView): string {
  const known = slot.validation?.definitive === true ? slot.validation : null;
  if (known === null) return "No earlier definitive result is known.";
  if (known.outcome === "valid") return `Last known: accepted at ${known.checkedAt}.`;
  if (known.outcome === "unauthorized") return `Last known: accepted with limited permission at ${known.checkedAt}.`;
  return `Last known: not accepted at ${known.checkedAt}.`;
}

const VALIDATION_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1_000;

function validationIsStale(checkedAt: string, now: Date): boolean {
  const checked = Date.parse(checkedAt);
  return !Number.isFinite(checked) || checked > now.valueOf() || now.valueOf() - checked >= VALIDATION_FRESHNESS_MS;
}

function validationTimeIsValid(checkedAt: string, now: Date): boolean {
  const checked = Date.parse(checkedAt);
  return Number.isFinite(checked) && checked <= now.valueOf();
}

function vaultStateRequiresRecovery(vaultState: CredentialSlotsResult["vaultState"]): boolean {
  return vaultState !== "ready" && vaultState !== "absent";
}

export function projectCredentialStatus(
  slot: CredentialSlotView,
  metadataAvailable = true,
  vaultState: CredentialSlotsResult["vaultState"] = "ready",
  now: Date = new Date(),
): CredentialStatusProjection {
  if (vaultStateRequiresRecovery(vaultState)) return {
    tone: "danger",
    label: vaultState === "encryption-unavailable" ? "Secure storage unavailable" : "Recovery required",
    sentence: "Credential and provider-acceptance status is unavailable until secure storage recovery is completed.",
    connected: false,
  };
  if (slot.state === "absent") return { tone: "neutral", label: "Not saved", sentence: "No credential is stored on this PC.", connected: false };
  if (!metadataAvailable) return { tone: "warn", label: "Details unavailable", sentence: "Credential storage, ownership, enabled state, validation details, and available actions cannot be determined until this installation's saved credential details are restored.", connected: false };
  if (slot.state === "revoked") return { tone: "neutral", label: "Removed", sentence: "The encrypted credential was removed from this PC. Re-entry remains available.", connected: false };
  if (slot.state === "unrecoverable" && slot.credentialId === null) return { tone: "danger", label: "Storage unavailable", sentence: "This provider slot cannot be read while secure storage needs recovery.", connected: false };
  if (slot.state === "unrecoverable") return { tone: "danger", label: "Re-entry required", sentence: "The saved credential cannot be read on this PC. Re-enter it to recover.", connected: false };
  if (!slot.enabled) return { tone: "neutral", label: "Disabled", sentence: "Saved on this PC but disabled for future use. No tasks run in this build.", connected: false };
  const validation = latestValidation(slot);
  if (validation === null) return { tone: "info", label: "Saved · not validated", sentence: "Saved securely on this PC. Saving did not contact the provider.", connected: false };
  if (!validation.definitive) return { tone: "warn", label: "Check inconclusive", sentence: `The latest check did not judge the credential. ${lastKnownSentence(slot)}`, connected: false };
  if (!validationTimeIsValid(validation.checkedAt, now) && validation.outcome !== "invalid") return { tone: "warn", label: "Check needed", sentence: "The last definitive check has an invalid or future recorded time, so provider acceptance is not inferred.", connected: false };
  if (validation.outcome === "valid") return validationIsStale(validation.checkedAt, now)
    ? { tone: "warn", label: "Check needed", sentence: `The last accepted check is stale and needs another deliberate check. ${lastKnownSentence(slot)}`, connected: true }
    : { tone: "ok", label: "Validated", sentence: `The separately requested check accepted this credential at ${validation.checkedAt}.`, connected: true };
  if (validation.outcome === "invalid") return { tone: "danger", label: "Not accepted", sentence: "The last separately requested check did not accept this credential.", connected: false };
  if (validation.outcome === "unauthorized") return { tone: "warn", label: "Permission limited", sentence: `The provider accepted the credential at ${validation.checkedAt} but refused the checked capability.`, connected: true };
  return { tone: "warn", label: "Check inconclusive", sentence: "The last check did not judge the credential. Earlier definitive information is preserved.", connected: false };
}

export function projectCredentialActions(
  slot: CredentialSlotView,
  validationEnabled: boolean,
  validatingCredentialId: string | null,
  metadataAvailable = true,
  vaultState: CredentialSlotsResult["vaultState"] = "ready",
): readonly CredentialActionProjection[] {
  const activeValidation = validatingCredentialId ?? (slot.developer.operationPhase === "validation-in-flight" ? slot.credentialId : null);
  const checking = activeValidation !== null && activeValidation === slot.credentialId;
  const storageReady = vaultState === "ready" || (vaultState === "absent" && slot.state === "absent");
  const blocked = checking ? "Check in progress" : !storageReady ? "Secure storage needs recovery" : !metadataAvailable ? "Restore this installation's saved credential details" : null;
  const validationBlocked = checking ? "Check in progress" : activeValidation !== null ? "Another check is in progress" : blocked;
  if (slot.state === "absent") return Object.freeze([{ action: "save", disabledReason: blocked }]);
  if (slot.state === "unrecoverable" && (slot.credentialId === null || slot.revision === null || slot.recordToken === null)) return Object.freeze([]);
  if (slot.state === "revoked") return Object.freeze([{ action: "reenter", disabledReason: blocked }]);
  if (slot.state === "unrecoverable") return Object.freeze([
    { action: "reenter", disabledReason: blocked },
    { action: "remove", disabledReason: blocked },
  ]);
  return Object.freeze([
    { action: "validate", disabledReason: validationBlocked ?? (!validationEnabled ? "Live validation is off in this build" : !slot.enabled ? "Enable this credential first" : null) },
    { action: "rotate", disabledReason: blocked },
    { action: slot.enabled ? "disable" : "enable", disabledReason: blocked },
    { action: "remove", disabledReason: blocked },
  ]);
}

export function actionSetForSlot(slot: CredentialSlotView, validationEnabled: boolean, validatingCredentialId: string | null): readonly CredentialAction[] {
  return Object.freeze(projectCredentialActions(slot, validationEnabled, validatingCredentialId).map((item) => item.action));
}

export function projectCredentialMode(input: CredentialSlotsResult, mode: PresentationMode, now: Date = new Date()): readonly CredentialModeSlotProjection[] {
  const validatingCredentialId = input.slots.find((slot) => slot.developer.operationPhase === "validation-in-flight")?.credentialId ?? null;
  return Object.freeze(input.slots.map((slot) => Object.freeze({
    slotId: slot.slotId,
    status: projectCredentialStatus(slot, input.metadataAvailable, input.vaultState, now),
    actions: projectCredentialActions(slot, input.validationEnabled, validatingCredentialId, input.metadataAvailable, input.vaultState),
    developerFacts: mode === "developer" ? Object.freeze({ ...slot.developer }) : null,
  })));
}

export function captureModeActionSet(input: CredentialSlotsResult, mode: PresentationMode): readonly string[] {
  const independentlyProjected = projectCredentialMode(input, mode).flatMap((slot) => slot.actions.map(({ action }) => `${slot.slotId}:${action}`));
  return Object.freeze(independentlyProjected.sort());
}

export function aggregateSummary(input: Pick<CredentialSlotsResult, "slots" | "metadataAvailable" | "vaultState">, now: Date = new Date()): string {
  if (vaultStateRequiresRecovery(input.vaultState)) return "Secure storage recovery required · Provider acceptance and credential counts unavailable";
  const saved = input.slots.filter((slot) => slot.state === "present" || slot.state === "unrecoverable").length;
  if (!input.metadataAvailable) return `${saved} saved ${saved === 1 ? "credential" : "credentials"} · Connection and validation details unavailable`;
  const connected = new Set(input.slots.filter((slot) => projectCredentialStatus(slot, true, input.vaultState, now).connected).map((slot) => slot.slotId)).size;
  const unvalidated = input.slots.filter((slot) => slot.state === "present" && slot.enabled && latestValidation(slot) === null).length;
  const check = input.slots.filter((slot) => {
    const latest = latestValidation(slot);
    return slot.state === "present" && slot.enabled && latest !== null && (!latest.definitive || latest.outcome === "unauthorized" || (latest.outcome === "valid" && validationIsStale(latest.checkedAt, now)));
  }).length;
  const attention = input.slots.filter((slot) => slot.state === "unrecoverable" || (slot.state === "present" && slot.enabled && latestValidation(slot)?.outcome === "invalid")).length;
  const disabled = input.slots.filter((slot) => slot.state === "present" && !slot.enabled).length;
  return `${connected} accepted ${connected === 1 ? "provider" : "providers"} · ${saved} saved ${saved === 1 ? "credential" : "credentials"} · ${unvalidated} ${unvalidated === 1 ? "credential" : "credentials"} not validated · ${check} ${check === 1 ? "credential needs" : "credentials need"} a check · ${attention} ${attention === 1 ? "credential needs" : "credentials need"} attention · ${disabled} disabled ${disabled === 1 ? "credential" : "credentials"}`;
}
