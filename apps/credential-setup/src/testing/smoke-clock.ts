interface AdvancingSmokeClock {
  now(): Date;
  advance(milliseconds: number): void;
}

export interface SyntheticAuthorizationWindow {
  readonly issuedAt: string;
  readonly expiresAt: string;
}

const AUTHORIZATION_ISSUED_BEFORE_MS = 60_000;
const AUTHORIZATION_EXPIRES_AFTER_MS = 60 * 60 * 1_000;

function finiteTimestamp(value: number): number {
  if (!Number.isFinite(value)) throw new Error("SMOKE_CLOCK_INVALID");
  return value;
}

export function alignSyntheticSmokeClock(clock: AdvancingSmokeClock, smokeStartedAtMs: number): void {
  const target = finiteTimestamp(smokeStartedAtMs);
  const observed = finiteTimestamp(clock.now().valueOf());
  clock.advance(target - observed);
  if (clock.now().valueOf() !== target) throw new Error("SMOKE_CLOCK_ALIGNMENT_FAILED");
}

export function syntheticAuthorizationWindow(clock: Pick<AdvancingSmokeClock, "now">): SyntheticAuthorizationWindow {
  const now = finiteTimestamp(clock.now().valueOf());
  return Object.freeze({
    issuedAt: new Date(now - AUTHORIZATION_ISSUED_BEFORE_MS).toISOString(),
    expiresAt: new Date(now + AUTHORIZATION_EXPIRES_AFTER_MS).toISOString(),
  });
}
