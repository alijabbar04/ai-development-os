import { controlFail } from "./errors.js";

export const CONTROL_LIFECYCLE_STATES = Object.freeze([
  "absent", "starting", "adopting", "ready", "stale", "draining", "lost", "closed",
] as const);
export type ControlLifecycleState = (typeof CONTROL_LIFECYCLE_STATES)[number];

export const CONTROL_LIFECYCLE_EVENTS = Object.freeze([
  "begin-fresh", "begin-adoption", "fresh-ready", "adoption-ready", "mark-stale",
  "begin-drain", "mark-lost", "recovery-unresolved", "close",
] as const);
export type ControlLifecycleEvent = (typeof CONTROL_LIFECYCLE_EVENTS)[number];
export type StartupMode = "fresh" | "adopted";

type TransitionTable = Readonly<Record<ControlLifecycleState, Readonly<Record<ControlLifecycleEvent, ControlLifecycleState | null>>>>;

const NONE = null;
export const CONTROL_LIFECYCLE_TRANSITIONS: TransitionTable = Object.freeze({
  absent: Object.freeze({ "begin-fresh": "starting", "begin-adoption": "adopting", "fresh-ready": NONE, "adoption-ready": NONE, "mark-stale": NONE, "begin-drain": NONE, "mark-lost": NONE, "recovery-unresolved": NONE, close: "closed" }),
  starting: Object.freeze({ "begin-fresh": NONE, "begin-adoption": NONE, "fresh-ready": "ready", "adoption-ready": NONE, "mark-stale": NONE, "begin-drain": "draining", "mark-lost": "lost", "recovery-unresolved": NONE, close: NONE }),
  adopting: Object.freeze({ "begin-fresh": NONE, "begin-adoption": NONE, "fresh-ready": NONE, "adoption-ready": "ready", "mark-stale": NONE, "begin-drain": "draining", "mark-lost": "lost", "recovery-unresolved": "stale", close: NONE }),
  ready: Object.freeze({ "begin-fresh": NONE, "begin-adoption": NONE, "fresh-ready": NONE, "adoption-ready": NONE, "mark-stale": "stale", "begin-drain": "draining", "mark-lost": "lost", "recovery-unresolved": NONE, close: NONE }),
  stale: Object.freeze({ "begin-fresh": NONE, "begin-adoption": NONE, "fresh-ready": NONE, "adoption-ready": NONE, "mark-stale": NONE, "begin-drain": "draining", "mark-lost": "lost", "recovery-unresolved": NONE, close: NONE }),
  draining: Object.freeze({ "begin-fresh": NONE, "begin-adoption": NONE, "fresh-ready": NONE, "adoption-ready": NONE, "mark-stale": NONE, "begin-drain": NONE, "mark-lost": "lost", "recovery-unresolved": NONE, close: "closed" }),
  lost: Object.freeze({ "begin-fresh": NONE, "begin-adoption": NONE, "fresh-ready": NONE, "adoption-ready": NONE, "mark-stale": NONE, "begin-drain": NONE, "mark-lost": NONE, "recovery-unresolved": NONE, close: "closed" }),
  closed: Object.freeze({ "begin-fresh": NONE, "begin-adoption": NONE, "fresh-ready": NONE, "adoption-ready": NONE, "mark-stale": NONE, "begin-drain": NONE, "mark-lost": NONE, "recovery-unresolved": NONE, close: NONE }),
});

export interface LifecycleSnapshot {
  readonly state: ControlLifecycleState;
  readonly startupMode: StartupMode | null;
  readonly recovery: "not-applicable" | "unresolved" | "identity-adopted";
  readonly productionEnabled: false;
  readonly tasksMayStart: false;
  readonly providersMayStart: false;
}

export interface ControlLifecycle {
  snapshot(): LifecycleSnapshot;
  transition(event: ControlLifecycleEvent): LifecycleSnapshot;
}

export function transitionLifecycleState(
  state: ControlLifecycleState,
  event: ControlLifecycleEvent,
): ControlLifecycleState {
  if (!CONTROL_LIFECYCLE_STATES.includes(state) || !CONTROL_LIFECYCLE_EVENTS.includes(event)) {
    controlFail("LIFECYCLE_REFUSED");
  }
  const next = CONTROL_LIFECYCLE_TRANSITIONS[state][event];
  if (next === null) controlFail("LIFECYCLE_REFUSED");
  return next;
}

export function createControlLifecycle(): ControlLifecycle {
  let state: ControlLifecycleState = "absent";
  let startupMode: StartupMode | null = null;
  let recovery: LifecycleSnapshot["recovery"] = "not-applicable";
  const snapshot = (): LifecycleSnapshot => Object.freeze({
    state, startupMode, recovery,
    productionEnabled: false,
    tasksMayStart: false,
    providersMayStart: false,
  });
  return Object.freeze({
    snapshot,
    transition(event: ControlLifecycleEvent) {
      const next = transitionLifecycleState(state, event);
      if (event === "begin-fresh") {
        startupMode = "fresh";
        recovery = "not-applicable";
      } else if (event === "begin-adoption") {
        startupMode = "adopted";
        recovery = "unresolved";
      } else if (event === "adoption-ready") {
        recovery = "identity-adopted";
      }
      state = next;
      return snapshot();
    },
  });
}
