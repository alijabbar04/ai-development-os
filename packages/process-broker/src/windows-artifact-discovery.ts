/**
 * Windows production artifact discovery (ADR 0017 section 6.4).
 *
 * The trust root for an installed bundle is **reviewed source**, not anything
 * that arrives with the bundle. This module holds the compiled-in table of
 * pinned bundle fingerprints. A bundle is acceptable only when its recomputed
 * manifest fingerprint equals a pinned constant for that component and version.
 *
 * **In this checkpoint the table is empty.** There is no released, signed
 * version, so there is no pinned fingerprint, so every discovery attempt fails
 * closed with a stable code before any path is resolved and before any byte is
 * read. That is the correct and intended outcome, and it is what makes the
 * seam testable without promoting anything.
 *
 * Discovery deliberately has no path parameter. It never consults `PATH`, the
 * current working directory, the registry, an environment variable, a model or
 * provider name, or a caller-supplied location.
 */

import {
  WINDOWS_ARTIFACT_COMPONENTS,
  WINDOWS_ARTIFACT_PLATFORM,
  WINDOWS_ARTIFACT_RID,
  WINDOWS_PRODUCTION_PROTOCOL_VERSION,
  type WindowsArtifactComponent,
  type WindowsArtifactRefusal,
} from "./windows-artifact.js";

export interface PinnedWindowsBundle {
  readonly component: WindowsArtifactComponent;
  readonly bundleVersion: string;
  /** Recomputed manifest fingerprint that a bundle must equal exactly. */
  readonly manifestFingerprint: string;
}

/**
 * The pinned bundle fingerprint table.
 *
 * Empty by decision, not by omission. Adding an entry is a reviewed source
 * change that requires a released, signed bundle to exist first; until then
 * every entry would be a fingerprint of something that has never been proved,
 * and pinning it would convert "we built it" into "we trust it".
 */
export const PINNED_WINDOWS_BUNDLE_FINGERPRINTS: readonly PinnedWindowsBundle[] =
  Object.freeze([]);

export interface WindowsArtifactDiscoveryRefused {
  readonly discovered: false;
  readonly component: WindowsArtifactComponent;
  readonly code: WindowsArtifactRefusal;
  readonly pinnedFingerprintCount: number;
}

export interface WindowsArtifactDiscoverySucceeded {
  readonly discovered: true;
  readonly component: WindowsArtifactComponent;
  readonly bundleVersion: string;
  readonly manifestFingerprint: string;
  readonly pinnedFingerprintCount: number;
}

export type WindowsArtifactDiscovery =
  | WindowsArtifactDiscoveryRefused
  | WindowsArtifactDiscoverySucceeded;

/** Looks a component and version up in the pinned table. Always null here. */
export function findPinnedWindowsBundle(
  component: WindowsArtifactComponent,
  bundleVersion: string,
): PinnedWindowsBundle | null {
  return (
    PINNED_WINDOWS_BUNDLE_FINGERPRINTS.find(
      (entry) => entry.component === component && entry.bundleVersion === bundleVersion,
    ) ?? null
  );
}

/**
 * Resolves whether a component's installed bundle may be used.
 *
 * The pinned table is consulted first, before the platform is even considered
 * relevant to the outcome, so the refusal cannot depend on the host, the
 * filesystem, or anything an attacker controls.
 */
export function discoverWindowsArtifactBundle(options: {
  readonly component: WindowsArtifactComponent;
  readonly platform?: NodeJS.Platform;
}): WindowsArtifactDiscovery {
  const component = options.component;
  const pinnedFingerprintCount = PINNED_WINDOWS_BUNDLE_FINGERPRINTS.length;

  if (pinnedFingerprintCount === 0) {
    return Object.freeze({
      discovered: false as const,
      component,
      code: "artifact-bundle-not-pinned" as const,
      pinnedFingerprintCount,
    });
  }

  /* c8 ignore start -- unreachable while the pinned table is empty (ADR 0017
     section 6.4). Retained so the ordering of the remaining checks is
     reviewable now rather than invented at release time. */
  const platform = options.platform ?? process.platform;
  if (platform !== WINDOWS_ARTIFACT_PLATFORM) {
    return Object.freeze({
      discovered: false as const,
      component,
      code: "artifact-discovery-unsupported-platform" as const,
      pinnedFingerprintCount,
    });
  }

  const pinned = PINNED_WINDOWS_BUNDLE_FINGERPRINTS.find((entry) => entry.component === component);
  if (pinned === undefined) {
    return Object.freeze({
      discovered: false as const,
      component,
      code: "artifact-bundle-not-pinned" as const,
      pinnedFingerprintCount,
    });
  }

  return Object.freeze({
    discovered: true as const,
    component,
    bundleVersion: pinned.bundleVersion,
    manifestFingerprint: pinned.manifestFingerprint,
    pinnedFingerprintCount,
  });
  /* c8 ignore stop */
}

export interface WindowsArtifactSeamStatus {
  readonly seamVersion: 1;
  readonly protocolVersion: typeof WINDOWS_PRODUCTION_PROTOCOL_VERSION;
  readonly rid: typeof WINDOWS_ARTIFACT_RID;
  readonly pinnedFingerprintCount: number;
  readonly discovery: readonly WindowsArtifactDiscovery[];
  readonly anyComponentDiscovered: boolean;
  /** Always false. Packaging is not containment. */
  readonly productionEligible: false;
  /** Always false. No artifact can change platform availability. */
  readonly changesPlatformAvailability: false;
  readonly windowsBackendDetail: "windows-native-process-composition-and-corpus-unverified";
}

/**
 * A read-only, non-authorizing description of the artifact seam.
 *
 * It exists so tests and operators can observe that the seam refuses without
 * having to reach into the platform backend, and so that "we packaged
 * something" and "Windows is available" stay visibly separate facts.
 */
export function describeWindowsArtifactSeam(options: {
  readonly platform?: NodeJS.Platform;
} = {}): WindowsArtifactSeamStatus {
  const discovery = WINDOWS_ARTIFACT_COMPONENTS.map((component) =>
    options.platform === undefined
      ? discoverWindowsArtifactBundle({ component })
      : discoverWindowsArtifactBundle({ component, platform: options.platform }),
  );
  return Object.freeze({
    seamVersion: 1 as const,
    protocolVersion: WINDOWS_PRODUCTION_PROTOCOL_VERSION,
    rid: WINDOWS_ARTIFACT_RID,
    pinnedFingerprintCount: PINNED_WINDOWS_BUNDLE_FINGERPRINTS.length,
    discovery: Object.freeze(discovery),
    anyComponentDiscovered: discovery.some((entry) => entry.discovered),
    productionEligible: false as const,
    changesPlatformAvailability: false as const,
    windowsBackendDetail: "windows-native-process-composition-and-corpus-unverified" as const,
  });
}
