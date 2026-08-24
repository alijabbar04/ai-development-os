import { types as utilTypes } from "node:util";
import type {
  CredentialValidationAuthorizationView,
  CredentialValidationOutcome,
} from "@ai-dev-os/credential-ui";
import type { SecretMaterial } from "@ai-dev-os/secrets";
import type { AppVaultSlotId } from "@ai-dev-os/secrets-app-vault";
import { CredentialHostError } from "./host-error.js";

export interface CredentialValidationInput {
  readonly slotId: AppVaultSlotId;
  readonly credentialId: string;
  readonly recordRevision: number;
  readonly recordToken: string;
  readonly secret: SecretMaterial;
  readonly signal: AbortSignal;
  /** The policy-aware resolver's exact allowed decision for this secret use. */
  readonly policyDecisionFingerprint?: string;
  /** Opaque one-shot claim prepared before secret resolution. */
  readonly authorizationAttempt?: unknown;
  /** Called only once the transport has reached a possibly-dispatched phase. */
  readonly observeProviderDispatch?: () => void;
  /** Main-process operation identity; never a credential identifier. */
  readonly operationId?: string;
  /** Start timestamp from the same bounded host clock used for completion. */
  readonly validationStartedAt?: string;
}

export interface CredentialValidationResult {
  readonly outcome: CredentialValidationOutcome;
  readonly resultCode: "VALIDATION_OK" | "AUTHENTICATION_FAILED" | "AUTHORIZATION_LIMITED" | "RESULT_AMBIGUOUS" | "PROVIDER_UNREACHABLE" | "EVIDENCE_RECEIPT_UNAVAILABLE";
  readonly successReceiptId?: string;
  readonly successReceiptSha256?: string;
}

export interface CredentialValidationPort {
  /** Precise ports report dispatch through `observeProviderDispatch`. */
  readonly preciseDispatchObservation?: true;
  /** A valid result from this port is refused unless it carries committed receipt evidence. */
  readonly requiresSuccessReceipt?: true;
  /** Optional because deterministic legacy test ports are not operator gates. */
  authorization?(): CredentialValidationAuthorizationView;
  prepare?(input: Readonly<{
    slotId: AppVaultSlotId;
    providerInstanceId: string;
    secretRefFingerprint: string;
    signal: AbortSignal;
  }>): Promise<unknown>;
  /**
   * Optional post-effect settlement boundary. The host invokes this only after
   * the policy-aware resolver has released the SecretMaterial callback. Once a
   * provider effect settles before its absolute deadline, the host awaits this
   * promise without racing it against that provider deadline so non-cancellable
   * evidence IO cannot continue after a terminal response.
   */
  settleAfterSecretRelease?(effectResult: unknown): Promise<unknown>;
  validate(input: CredentialValidationInput): Promise<unknown>;
}

const RESULT_CODES: Readonly<Record<CredentialValidationOutcome, CredentialValidationResult["resultCode"]>> = Object.freeze({
  valid: "VALIDATION_OK",
  invalid: "AUTHENTICATION_FAILED",
  unauthorized: "AUTHORIZATION_LIMITED",
  ambiguous: "RESULT_AMBIGUOUS",
  unreachable: "PROVIDER_UNREACHABLE",
  "evidence-incomplete": "EVIDENCE_RECEIPT_UNAVAILABLE",
});

export function validationResultCode(outcome: CredentialValidationOutcome): CredentialValidationResult["resultCode"] {
  return RESULT_CODES[outcome];
}

export function parseCredentialValidationResult(value: unknown): CredentialValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value) || utilTypes.isProxy(value)) throw new CredentialHostError("REFUSED");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new CredentialHostError("REFUSED");
  const keys = Reflect.ownKeys(value);
  const hasReceipt = keys.includes("successReceiptId") || keys.includes("successReceiptSha256");
  if (
    keys.length !== (hasReceipt ? 4 : 2) || !keys.includes("outcome") || !keys.includes("resultCode") ||
    (hasReceipt && (!keys.includes("successReceiptId") || !keys.includes("successReceiptSha256"))) ||
    keys.some((key) => typeof key !== "string" || !["outcome", "resultCode", "successReceiptId", "successReceiptSha256"].includes(key))
  ) throw new CredentialHostError("REFUSED");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const outcomeDescriptor = descriptors["outcome"];
  const codeDescriptor = descriptors["resultCode"];
  if (outcomeDescriptor === undefined || codeDescriptor === undefined || !("value" in outcomeDescriptor) || !("value" in codeDescriptor)) throw new CredentialHostError("REFUSED");
  const outcome = outcomeDescriptor.value;
  if (!(Object.keys(RESULT_CODES) as CredentialValidationOutcome[]).includes(outcome as CredentialValidationOutcome)) throw new CredentialHostError("REFUSED");
  const resultCode = codeDescriptor.value;
  if (resultCode !== validationResultCode(outcome as CredentialValidationOutcome)) throw new CredentialHostError("REFUSED");
  if (!hasReceipt) return Object.freeze({ outcome: outcome as CredentialValidationOutcome, resultCode });
  const receiptId = descriptors["successReceiptId"];
  const receiptSha256 = descriptors["successReceiptSha256"];
  if (
    outcome !== "valid" || receiptId === undefined || receiptSha256 === undefined ||
    !("value" in receiptId) || !("value" in receiptSha256) ||
    typeof receiptId.value !== "string" || !/^[a-f0-9]{64}$/u.test(receiptId.value) ||
    typeof receiptSha256.value !== "string" || !/^[a-f0-9]{64}$/u.test(receiptSha256.value)
  ) throw new CredentialHostError("REFUSED");
  return Object.freeze({ outcome: "valid", resultCode: "VALIDATION_OK", successReceiptId: receiptId.value, successReceiptSha256: receiptSha256.value });
}

export function validationDefinitive(outcome: CredentialValidationOutcome): boolean {
  return outcome === "valid" || outcome === "invalid" || outcome === "unauthorized";
}

export function createDisabledCredentialValidationPort(): CredentialValidationPort {
  return Object.freeze({
    async validate() { throw new CredentialHostError("VALIDATION_DISABLED"); },
  });
}

export function createDeterministicCredentialValidationPort(options: Readonly<{
  outcome?: CredentialValidationOutcome;
  gate?: Promise<void>;
}> = {}): CredentialValidationPort & { dispatches(): number } {
  let count = 0;
  const outcome = options.outcome ?? "valid";
  return Object.freeze({
    async validate(input: CredentialValidationInput) {
      count += 1;
      if (input.signal.aborted) throw new CredentialHostError("VALIDATION_CANCELLED");
      await options.gate;
      if (input.signal.aborted) throw new CredentialHostError("VALIDATION_CANCELLED");
      await input.secret.useText((value: string) => {
        if (value.length === 0) throw new CredentialHostError("REFUSED");
        return undefined;
      });
      return Object.freeze({ outcome, resultCode: validationResultCode(outcome) });
    },
    dispatches: () => count,
  });
}
