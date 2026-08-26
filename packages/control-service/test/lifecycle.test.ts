import { describe, expect, it } from "vitest";
import {
  CONTROL_LIFECYCLE_EVENTS,
  CONTROL_LIFECYCLE_STATES,
  CONTROL_LIFECYCLE_TRANSITIONS,
  ControlServiceError,
  createControlLifecycle,
  transitionLifecycleState,
} from "../src/index.js";

describe("C3 lifecycle state machine", () => {
  it("defines a total state-by-event table and typed refusal for every illegal cell", () => {
    expect(Object.keys(CONTROL_LIFECYCLE_TRANSITIONS)).toEqual([...CONTROL_LIFECYCLE_STATES]);
    let cells = 0;
    for (const state of CONTROL_LIFECYCLE_STATES) {
      expect(Object.keys(CONTROL_LIFECYCLE_TRANSITIONS[state])).toEqual([...CONTROL_LIFECYCLE_EVENTS]);
      for (const event of CONTROL_LIFECYCLE_EVENTS) {
        cells += 1;
        const expected = CONTROL_LIFECYCLE_TRANSITIONS[state][event];
        if (expected === null) {
          expect(() => transitionLifecycleState(state, event)).toThrowError(ControlServiceError);
        } else {
          expect(transitionLifecycleState(state, event)).toBe(expected);
        }
      }
    }
    expect(cells).toBe(72);
  });

  it("keeps fresh and adopted startup distinguishable with unresolved recovery explicit", () => {
    const fresh = createControlLifecycle();
    expect(fresh.transition("begin-fresh")).toMatchObject({ state: "starting", startupMode: "fresh", recovery: "not-applicable" });
    expect(fresh.transition("fresh-ready")).toMatchObject({ state: "ready", startupMode: "fresh", recovery: "not-applicable" });
    const adopted = createControlLifecycle();
    expect(adopted.transition("begin-adoption")).toMatchObject({ state: "adopting", startupMode: "adopted", recovery: "unresolved" });
    expect(adopted.transition("recovery-unresolved")).toMatchObject({ state: "stale", startupMode: "adopted", recovery: "unresolved" });
    expect(() => adopted.transition("adoption-ready")).toThrowError(ControlServiceError);
  });

  it("never grants production, task, or provider authority", () => {
    const lifecycle = createControlLifecycle();
    for (const snapshot of [lifecycle.snapshot(), lifecycle.transition("begin-fresh"), lifecycle.transition("fresh-ready"), lifecycle.transition("begin-drain"), lifecycle.transition("close")]) {
      expect(snapshot).toMatchObject({ productionEnabled: false, tasksMayStart: false, providersMayStart: false });
    }
    expect(() => lifecycle.transition("begin-fresh")).toThrowError(ControlServiceError);
  });
});
