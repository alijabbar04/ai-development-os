import { describe, expect, it } from "vitest";
import { nativeConfirmationResult } from "../src/testing/native-confirmation-result.js";

describe("native confirmation fixture result", () => {
  it.each([true, false])("retains the real %s decision when closing the modal discards the script reply", async (decision) => {
    expect(await nativeConfirmationResult(Promise.resolve(decision), new Promise<boolean>(() => {}))).toBe(decision);
  });
  it("never accepts a successful automation click without a native decision", async () => {
    let decide!: (value: boolean) => void, completed = false;
    const native = new Promise<boolean>((resolve) => { decide = resolve; });
    const result = nativeConfirmationResult(native, Promise.resolve(true)).then(value => { completed = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    expect(completed).toBe(false); decide(false); expect(await result).toBe(false);
  });
  it("reports an unavailable control while there is no decision", async () => {
    await expect(nativeConfirmationResult(new Promise<boolean>(() => {}), Promise.resolve(false))).rejects.toThrow("SMOKE_CONFIRMATION_CONTROL_UNAVAILABLE");
  });
});
