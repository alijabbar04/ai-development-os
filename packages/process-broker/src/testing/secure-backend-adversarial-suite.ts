/**
 * Reusable Stage 17 escape-corpus contract.
 *
 * This module defines test orchestration, not enforcement. A passing result is
 * meaningful only when `candidate()` drives the reviewed native backend on
 * the exact host recorded in its attestation. Mock implementations must label
 * their results non-enforcement and cannot mint production registration.
 */

import { describe, expect, it } from "vitest";
import { fingerprintOf } from "../fingerprint.js";

export const SECURE_BACKEND_ESCAPE_CORPUS_VERSION = 1 as const;
export const SECURE_BACKEND_ESCAPE_CORPUS_SEED = "stage-17-corpus-seed-0001";

export const SECURE_BACKEND_ESCAPE_VECTORS = Object.freeze([
  { id: "fs-outside-read", category: "filesystem", platforms: ["win32", "linux", "darwin"] },
  { id: "fs-outside-write-delete-rename", category: "filesystem", platforms: ["win32", "linux", "darwin"] },
  { id: "fs-relative-absolute-normalization", category: "filesystem", platforms: ["win32", "linux", "darwin"] },
  { id: "fs-link-and-rename-race", category: "filesystem", platforms: ["win32", "linux", "darwin"] },
  { id: "fs-inherited-handle", category: "filesystem", platforms: ["win32", "linux", "darwin"] },
  { id: "fs-profile-temp-cache", category: "filesystem", platforms: ["win32", "linux", "darwin"] },
  { id: "fs-executable-substitution", category: "filesystem", platforms: ["win32", "linux", "darwin"] },
  { id: "fs-cross-session", category: "filesystem", platforms: ["win32", "linux", "darwin"] },
  { id: "fs-windows-device-unc-ads-reparse", category: "filesystem", platforms: ["win32"] },
  { id: "fs-posix-mount-proc-device", category: "filesystem", platforms: ["linux", "darwin"] },
  { id: "process-child-grandchild", category: "process-tree", platforms: ["win32", "linux", "darwin"] },
  { id: "process-detach-reparent-breakaway", category: "process-tree", platforms: ["win32", "linux", "darwin"] },
  { id: "process-rapid-spawn-race", category: "process-tree", platforms: ["win32", "linux", "darwin"] },
  { id: "process-signal-ignore", category: "process-tree", platforms: ["linux", "darwin"] },
  { id: "process-debug-inspection", category: "process-tree", platforms: ["win32", "linux", "darwin"] },
  { id: "ipc-inherited-pipe-socket", category: "ipc", platforms: ["win32", "linux", "darwin"] },
  { id: "ipc-host-service", category: "ipc", platforms: ["win32", "linux", "darwin"] },
  { id: "lifecycle-helper-parent-crash", category: "cleanup", platforms: ["win32", "linux", "darwin"] },
  { id: "lifecycle-cancellation-races", category: "cleanup", platforms: ["win32", "linux", "darwin"] },
  { id: "network-approved-fake-service", category: "network", platforms: ["win32", "linux", "darwin"] },
  { id: "network-direct-dns-tcp-udp-quic-raw", category: "network", platforms: ["win32", "linux", "darwin"] },
  { id: "network-address-range-bypass", category: "network", platforms: ["win32", "linux", "darwin"] },
  { id: "network-redirect-dns-rebinding", category: "network", platforms: ["win32", "linux", "darwin"] },
  { id: "network-sni-host-connect", category: "network", platforms: ["win32", "linux", "darwin"] },
  { id: "network-proxy-resolver-override", category: "network", platforms: ["win32", "linux", "darwin"] },
  { id: "network-channel-reuse-inheritance", category: "network", platforms: ["win32", "linux", "darwin"] },
  { id: "network-relay-drift-crash-cleanup", category: "network", platforms: ["win32", "linux", "darwin"] },
  { id: "credential-ambient-environment", category: "credentials", platforms: ["win32", "linux", "darwin"] },
  { id: "credential-profile-config-stores", category: "credentials", platforms: ["win32", "linux", "darwin"] },
  { id: "credential-helper-agent-socket", category: "credentials", platforms: ["win32", "linux", "darwin"] },
  { id: "credential-process-inspection", category: "credentials", platforms: ["win32", "linux", "darwin"] },
  { id: "credential-metadata-canary", category: "credentials", platforms: ["win32", "linux", "darwin"] },
  { id: "credential-evidence-leakage", category: "credentials", platforms: ["win32", "linux", "darwin"] },
  { id: "quota-wall-clock", category: "quota", platforms: ["win32", "linux", "darwin"] },
  { id: "quota-total-cpu", category: "quota", platforms: ["win32", "linux", "darwin"] },
  { id: "quota-memory-process-tree", category: "quota", platforms: ["win32", "linux", "darwin"] },
  { id: "quota-process-count", category: "quota", platforms: ["win32", "linux", "darwin"] },
  { id: "quota-output-stdin-duplex", category: "quota", platforms: ["win32", "linux", "darwin"] },
  { id: "quota-disk-file-count", category: "quota", platforms: ["win32", "linux", "darwin"] },
  { id: "quota-network", category: "quota", platforms: ["win32", "linux", "darwin"] },
  { id: "quota-boundary-concurrency-overflow", category: "quota", platforms: ["win32", "linux", "darwin"] },
  { id: "cleanup-repeated-session-residue", category: "cleanup", platforms: ["win32", "linux", "darwin"] },
] as const);

export type SecureBackendEscapeVector = (typeof SECURE_BACKEND_ESCAPE_VECTORS)[number];
export type SecureBackendEscapeVectorId = SecureBackendEscapeVector["id"];

export const SECURE_BACKEND_ESCAPE_CORPUS_FINGERPRINT = fingerprintOf({
  version: SECURE_BACKEND_ESCAPE_CORPUS_VERSION,
  seed: SECURE_BACKEND_ESCAPE_CORPUS_SEED,
  vectors: SECURE_BACKEND_ESCAPE_VECTORS,
});

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
