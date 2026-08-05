/**
 * Canonical identity of the Stage 17 native escape corpus.
 *
 * This runtime-only module deliberately has no Vitest dependency. Production
 * evidence verification imports the same deeply immutable vector inventory
 * that the public testing contract executes, so an attestation cannot name a
 * different, shortened, or stale corpus and still authorize production.
 */

import { fingerprintOf } from "./fingerprint.js";

export const SECURE_BACKEND_ESCAPE_CORPUS_VERSION = 1 as const;
export const SECURE_BACKEND_ESCAPE_CORPUS_SEED = "stage-17-corpus-seed-0001";

const ESCAPE_VECTORS = [
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
] as const;

export type SecureBackendPlatform = "win32" | "linux" | "darwin";
export type SecureBackendEscapeVectorId = (typeof ESCAPE_VECTORS)[number]["id"];
export type SecureBackendEscapeCategory = (typeof ESCAPE_VECTORS)[number]["category"];

export interface SecureBackendEscapeVector {
  readonly id: SecureBackendEscapeVectorId;
  readonly category: SecureBackendEscapeCategory;
  readonly platforms: readonly SecureBackendPlatform[];
}

export const SECURE_BACKEND_ESCAPE_VECTORS: readonly SecureBackendEscapeVector[] =
  Object.freeze(
    ESCAPE_VECTORS.map((vector) =>
      Object.freeze({
        ...vector,
        platforms: Object.freeze([...vector.platforms]),
      }),
    ),
  );

export const SECURE_BACKEND_ESCAPE_CORPUS_FINGERPRINT = fingerprintOf({
  version: SECURE_BACKEND_ESCAPE_CORPUS_VERSION,
  seed: SECURE_BACKEND_ESCAPE_CORPUS_SEED,
  vectors: SECURE_BACKEND_ESCAPE_VECTORS,
});

export function secureBackendEscapeVectorCount(platform: SecureBackendPlatform): number {
  return SECURE_BACKEND_ESCAPE_VECTORS.filter((vector) =>
    (vector.platforms as readonly SecureBackendPlatform[]).includes(platform),
  ).length;
}
