import { describe, expect, it } from "vitest";
import { CREDENTIAL_CHANNELS } from "../src/main/constants.js";
import { CredentialEntrySession, type CredentialOperation, type CredentialSessionState } from "../src/main/session-machine.js";

function at(state: CredentialSessionState): CredentialEntrySession {
  const session = new CredentialEntrySession();
  if (state === "opening") return session;
  session.begin("describe"); session.described();
  if (state === "editing") return session;
  if (state === "submitting") { session.begin("save"); return session; }
  if (state === "committed") { session.begin("save"); session.committed(); return session; }
  if (state === "failed") { session.begin("save"); session.refused("VAULT_CORRUPT"); return session; }
  if (state === "finished") { session.begin("cancel"); return session; }
  session.destroy(); return session;
}

describe("entry-session legality matrix", () => {
  const allowed: Readonly<Record<CredentialSessionState, readonly CredentialOperation[]>> = {
    opening: ["describe", "cancel"],
    editing: ["describe", "save", "rotate", "set-enabled", "remove", "validate", "cancel"],
    submitting: ["cancel"],
    committed: ["describe", "validate", "cancel"],
    failed: ["describe", "cancel"],
    finished: [],
    destroyed: [],
  };
  const operations: readonly CredentialOperation[] = ["describe", "save", "rotate", "set-enabled", "remove", "validate", "cancel"];

  for (const state of Object.keys(allowed) as CredentialSessionState[]) {
    for (const operation of operations) {
      it(`${state} ${allowed[state].includes(operation) ? "allows" : "refuses"} ${operation}`, () => {
        const session = at(state);
        if (allowed[state].includes(operation)) expect(() => session.begin(operation)).not.toThrow();
        else expect(() => session.begin(operation)).toThrow();
      });
    }
  }

  it("returns recoverable conflicts to editing, terminal failures to failed, and post-commit writes to REPLAYED", () => {
    const retry = at("editing"); retry.begin("save"); retry.refused("VAULT_REVISION_CONFLICT"); expect(retry.state).toBe("editing");
    retry.begin("rotate"); retry.refused("VAULT_BUSY"); expect(retry.state).toBe("editing");
    retry.begin("remove"); retry.refused("VAULT_CORRUPT"); expect(retry.state).toBe("failed");
    const committed = at("committed");
    expect(() => committed.begin("save")).toThrowError(expect.objectContaining({ code: "REPLAYED" }));
  });

  it("records a watchdog-unknown state while allowing the in-flight commit to settle authoritatively", () => {
    const session = at("editing");
    session.begin("save");
    session.writeOutcomeUnknown();
    expect(session.state).toBe("failed");
    session.committed();
    expect(session.state).toBe("committed");
  });

  it("allows cancel or destruction to record completion without reviving the closed surface", () => {
    const cancelled = at("editing");
    cancelled.begin("save");
    cancelled.begin("cancel");
    cancelled.committed();
    expect(cancelled.state).toBe("finished");
    const destroyed = at("editing");
    destroyed.begin("remove");
    destroyed.destroy();
    destroyed.refused("VAULT_WRITE_FAILED");
    expect(destroyed.state).toBe("destroyed");
  });

  it("bounds each channel to ten calls and validation to three", () => {
    const general = new CredentialEntrySession();
    for (let index = 0; index < 10; index += 1) general.count(CREDENTIAL_CHANNELS.describe);
    expect(() => general.count(CREDENTIAL_CHANNELS.describe)).toThrowError(expect.objectContaining({ code: "RATE_LIMITED" }));
    const validation = new CredentialEntrySession();
    for (let index = 0; index < 3; index += 1) validation.count(CREDENTIAL_CHANNELS.validate);
    expect(() => validation.count(CREDENTIAL_CHANNELS.validate)).toThrowError(expect.objectContaining({ code: "RATE_LIMITED" }));
  });
});
