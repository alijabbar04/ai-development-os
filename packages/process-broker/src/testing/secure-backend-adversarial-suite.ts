/**
 * Reusable Stage 17 escape-corpus contract.
 *
 * This module defines test orchestration, not enforcement. A passing result is
 * meaningful only when `candidate()` drives the reviewed native backend on
 * the exact host recorded in its attestation. Mock implementations must label
 * their results non-enforcement and cannot mint production registration.
 */

import { describe, expect, it } from "vitest";
import {
  SECURE_BACKEND_ESCAPE_VECTORS,
  type SecureBackendEscapeVector,
} from "../escape-corpus.js";

export {
  SECURE_BACKEND_ESCAPE_CORPUS_FINGERPRINT,
  SECURE_BACKEND_ESCAPE_CORPUS_SEED,
  SECURE_BACKEND_ESCAPE_CORPUS_VERSION,
  SECURE_BACKEND_ESCAPE_VECTORS,
  secureBackendEscapeVectorCount,
} from "../escape-corpus.js";
export type {
  SecureBackendEscapeVector,
  SecureBackendEscapeVectorId,
  SecureBackendPlatform,
} from "../escape-corpus.js";

export interface EscapeAttemptObservation {
  /** Proves the fixture itself began rather than being skipped. */
  readonly fixtureStarted: boolean;
  /** Proves execution reached the armed attack checkpoint. */
  readonly armedCheckpointReached: boolean;
  /** True only when the canary shows that the attempted escape succeeded. */
  readonly escapeObserved: boolean;
  /** Confirms task-owned resources and markers were settled after the run. */
  readonly cleanupConfirmed: boolean;
  /** Stable body-free result category; never a native message or payload. */
  readonly stableOutcomeCode: string;
}

export interface SecureBackendEscapeHarness {
  readonly platform: "win32" | "linux" | "darwin";
  readonly enforcementKind: "actual-native" | "mock-non-enforcement";
  runOpenControl(vector: SecureBackendEscapeVector): Promise<EscapeAttemptObservation>;
  settleOpenControl(vector: SecureBackendEscapeVector): Promise<void>;
  runCandidate(vector: SecureBackendEscapeVector): Promise<EscapeAttemptObservation>;
  close(): Promise<void>;
}

export type SecureBackendEscapeHarnessFactory =
  () => Promise<SecureBackendEscapeHarness>;

/**
 * Registers one positive control and one candidate assertion per applicable
 * vector. Release evidence may count it only when `actual-native` is returned.
 */
export function runSecureBackendAdversarialSuite(
  factory: SecureBackendEscapeHarnessFactory,
): void {
  describe("secure backend escape corpus v1", () => {
    for (const vector of SECURE_BACKEND_ESCAPE_VECTORS) {
      it(`${vector.category}: ${vector.id}`, async () => {
        const harness = await factory();
        try {
          expect(harness.enforcementKind).toBe("actual-native");
          if (!(vector.platforms as readonly string[]).includes(harness.platform)) return;

          const control = await harness.runOpenControl(vector);
          expect(control.fixtureStarted).toBe(true);
          expect(control.armedCheckpointReached).toBe(true);
          expect(control.escapeObserved).toBe(true);
          expect(control.cleanupConfirmed).toBe(true);
          expect(control.stableOutcomeCode).toMatch(/^[a-z][a-z0-9-]{0,127}$/);

          await harness.settleOpenControl(vector);

          const candidate = await harness.runCandidate(vector);
          expect(candidate.fixtureStarted).toBe(true);
          expect(candidate.armedCheckpointReached).toBe(true);
          expect(candidate.escapeObserved).toBe(false);
          expect(candidate.cleanupConfirmed).toBe(true);
          expect(candidate.stableOutcomeCode).toMatch(/^[a-z][a-z0-9-]{0,127}$/);
        } finally {
          await harness.close();
        }
      });
    }
  });
}
