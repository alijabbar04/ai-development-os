import type { CredentialChannel } from "./constants.js";
import { CREDENTIAL_CHANNELS } from "./constants.js";
import { CredentialHostError } from "./host-error.js";

export type CredentialSessionState = "opening" | "editing" | "submitting" | "committed" | "failed" | "finished" | "destroyed";
export type CredentialOperation = "describe" | "save" | "rotate" | "set-enabled" | "remove" | "validate" | "cancel";

const WRITE_OPERATIONS = new Set<CredentialOperation>(["save", "rotate", "set-enabled", "remove"]);

export class CredentialEntrySession {
  #state: CredentialSessionState = "opening";
  readonly #counts = new Map<CredentialChannel, number>();
  #validationCount = 0;
  #writeActive = false;
  #writeOutcomeUnknown = false;
  #writeInterrupted = false;

  get state(): CredentialSessionState { return this.#state; }

  count(channel: CredentialChannel): void {
    const next = (this.#counts.get(channel) ?? 0) + 1;
    this.#counts.set(channel, next);
    if (next > 10) throw new CredentialHostError("RATE_LIMITED");
    if (channel === CREDENTIAL_CHANNELS.validate) {
      this.#validationCount += 1;
      if (this.#validationCount > 3) throw new CredentialHostError("RATE_LIMITED");
    }
  }

  begin(operation: CredentialOperation): void {
    if (operation === "cancel") {
      if (this.#state === "finished" || this.#state === "destroyed") throw new CredentialHostError("ILLEGAL_TRANSITION");
      if (this.#writeActive) this.#writeInterrupted = true;
      this.#state = "finished";
      return;
    }
    if (operation === "describe") {
      if (!["opening", "editing", "committed", "failed"].includes(this.#state)) throw new CredentialHostError("ILLEGAL_TRANSITION");
      return;
    }
    if (operation === "validate") {
      if (this.#state !== "editing" && this.#state !== "committed") throw new CredentialHostError("ILLEGAL_TRANSITION");
      return;
    }
    if (WRITE_OPERATIONS.has(operation)) {
      if (this.#state === "committed") throw new CredentialHostError("REPLAYED");
      if (this.#state !== "editing") throw new CredentialHostError("ILLEGAL_TRANSITION");
      this.#writeActive = true;
      this.#writeOutcomeUnknown = false;
      this.#writeInterrupted = false;
      this.#state = "submitting";
      return;
    }
    throw new CredentialHostError("ILLEGAL_TRANSITION");
  }

  described(): void {
    if (this.#state === "opening") this.#state = "editing";
  }

  committed(): void {
    if (!this.#writeActive) throw new CredentialHostError("ILLEGAL_TRANSITION");
    this.#writeActive = false;
    if (this.#state === "submitting" || (this.#state === "failed" && this.#writeOutcomeUnknown)) {
      this.#state = "committed";
      return;
    }
    if ((this.#state === "finished" || this.#state === "destroyed") && this.#writeInterrupted) return;
    throw new CredentialHostError("ILLEGAL_TRANSITION");
  }

  refused(code: string): void {
    if (!this.#writeActive) return;
    this.#writeActive = false;
    if (this.#state === "submitting") this.#state = code === "VAULT_REVISION_CONFLICT" || code === "VAULT_BUSY" ? "editing" : "failed";
  }

  writeOutcomeUnknown(): void {
    if (this.#state === "submitting" && this.#writeActive) {
      this.#writeOutcomeUnknown = true;
      this.#state = "failed";
    }
  }

  destroy(): void {
    if (this.#writeActive) this.#writeInterrupted = true;
    this.#state = "destroyed";
  }
}
