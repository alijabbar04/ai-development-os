import { validation } from "@ai-dev-os/domain";

export interface RouterClock {
  now(): Date;
}

export interface ManualRouterClock extends RouterClock {
  advance(milliseconds: number): void;
  set(iso: string): void;
}

export function createManualRouterClock(
  startIso = "2026-08-05T10:00:00.000Z"
): ManualRouterClock {
  let current = new Date(validation.ensureTimestamp(startIso, "routerClock.startIso")).valueOf();
  return Object.freeze({
    now: (): Date => new Date(current),
    advance: (milliseconds: number): void => {
      current += validation.ensureSafeInteger(
        milliseconds,
        "routerClock.advanceMs",
        0,
        31_536_000_000
      );
    },
    set: (iso: string): void => {
      current = new Date(validation.ensureTimestamp(iso, "routerClock.setIso")).valueOf();
    }
  });
}
