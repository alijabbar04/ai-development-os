import { types as utilTypes } from "node:util";
import type { CredentialValidationOutcome } from "@ai-dev-os/credential-ui";
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
}

export interface CredentialValidationResult {
  readonly outcome: CredentialValidationOutcome;
  readonly resultCode: "VALIDATION_OK" | "AUTHENTICATION_FAILED" | "AUTHORIZATION_LIMITED" | "RESULT_AMBIGUOUS" | "PROVIDER_UNREACHABLE";
}

export interface CredentialValidationPort {
  validate(input: CredentialValidationInput): Promise<unknown>;
}

const RESULT_CODES: Readonly<Record<CredentialValidationOutcome, CredentialValidationResult["resultCode"]>> = Object.freeze({
  valid: "VALIDATION_OK",
  invalid: "AUTHENTICATION_FAILED",
  unauthorized: "AUTHORIZATION_LIMITED",
  ambiguous: "RESULT_AMBIGUOUS",
  unreachable: "PROVIDER_UNREACHABLE",
});

export function validationResultCode(outcome: CredentialValidationOutcome): CredentialValidationResult["resultCode"] {
  return RESULT_CODES[outcome];
}

export function parseCredentialValidationResult(value: unknown): CredentialValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value) || utilTypes.isProxy(value)) throw new CredentialHostError("REFUSED");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new CredentialHostError("REFUSED");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("outcome") || !keys.includes("resultCode") || keys.some((key) => typeof key !== "string")) throw new CredentialHostError("REFUSED");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const outcomeDescriptor = descriptors["outcome"];
  const codeDescriptor = descriptors["resultCode"];
  if (outcomeDescriptor === undefined || codeDescriptor === undefined || !("value" in outcomeDescriptor) || !("value" in codeDescriptor)) throw new CredentialHostError("REFUSED");
  const outcome = outcomeDescriptor.value;
  if (!(Object.keys(RESULT_CODES) as CredentialValidationOutcome[]).includes(outcome as CredentialValidationOutcome)) throw new CredentialHostError("REFUSED");
  const resultCode = codeDescriptor.value;
  if (resultCode !== validationResultCode(outcome as CredentialValidationOutcome)) throw new CredentialHostError("REFUSED");
  return Object.freeze({ outcome: outcome as CredentialValidationOutcome, resultCode });
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
