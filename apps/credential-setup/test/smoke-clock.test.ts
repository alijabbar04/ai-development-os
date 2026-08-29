import { describe, expect, it } from "vitest";
import { alignSyntheticSmokeClock, syntheticAuthorizationWindow } from "../src/testing/smoke-clock.js";

function advancingClock(start: string): { now(): Date; advance(milliseconds: number): void } {
  let now = new Date(start).valueOf();
  return {
    now: () => new Date(now),
    advance(milliseconds: number) { now += milliseconds; },
  };
}

describe("synthetic Electron smoke clock", () => {
  it("keeps completed validations fresh after the former fixed fixture becomes stale", () => {
    const clock = advancingClock("2026-08-20T10:00:00.000Z");
    const smokeStartedAt = new Date("2026-08-29T12:34:56.000Z").valueOf();

    alignSyntheticSmokeClock(clock, smokeStartedAt);

    expect(clock.now().valueOf()).toBe(smokeStartedAt);
    expect(syntheticAuthorizationWindow(clock)).toEqual({
      issuedAt: "2026-08-29T12:33:56.000Z",
      expiresAt: "2026-08-29T13:34:56.000Z",
    });
  });

  it("rejects non-finite fixture timestamps", () => {
    const clock = advancingClock("2026-08-20T10:00:00.000Z");

    expect(() => alignSyntheticSmokeClock(clock, Number.NaN)).toThrowError("SMOKE_CLOCK_INVALID");
  });
});
