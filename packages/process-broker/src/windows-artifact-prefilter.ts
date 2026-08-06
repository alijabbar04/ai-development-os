/**
 * The TypeScript side of Windows artifact verification, stated as what it
 * actually is: a **pre-filter**, never the enforcing check.
 *
 * ADR 0017 section 6.5 makes this load-bearing rather than stylistic. The
 * mitigation that closes the content-substitution window is holding a
 * deny-write, deny-delete file handle open across `CreateProcessW`, and:
 *
 * - only the process that creates the process can hold a handle across it, and
 * - Node's `fs` cannot request a Windows share mode at all.
 *
 * So a TypeScript pass can prove that a bundle was wrong, and can never prove
 * that a bundle is still right. It refuses early and cheaply; it does not
 * authorize. The enforcing verification is the native supervisor's
 * ownership-bearing closure lease (`VerifiedClosure.cs`), which opens every
 * closure member with `FileShare.Read`, hashes through those exact handles, and
 * releases them only after the creation and identity boundary has completed.
 *
 * Every result this module returns therefore carries `enforcing: false` and
 * `provesCurrentBytes: false`. Any future execution path that treats a result
 * from here as sufficient before spawning is a defect, and
 * `windowsVerificationAuthority` exists so that claim is testable rather than
 * merely documented.
 */

import {
  isSafeWindowsArtifactFileName,
  windowsArtifactFileNameIssue,
  type WindowsArtifactManifest,
  type WindowsArtifactRefusal,
} from "./windows-artifact.js";

/**
 * Which side of the boundary performs which check.
 *
 * This is a compiled-in description of the ADR 0017 section 6.5 split, exported
 * so tests can assert that the control plane has not quietly promoted itself.
 */
export const WINDOWS_VERIFICATION_AUTHORITY = Object.freeze({
  contractVersion: 1,
  /** What TypeScript may decide. */
  preFilter: Object.freeze({
    side: "typescript-control-plane",
    mayRefuse: true,
    mayAuthorize: false,
    holdsFileHandles: false,
    canRequestWindowsShareMode: false,
    provesCurrentBytes: false,
  }),
  /** What only the native component can decide. */
  enforcing: Object.freeze({
    side: "native-supervisor",
    mayRefuse: true,
    mayAuthorize: true,
    holdsFileHandles: true,
    canRequestWindowsShareMode: true,
    provesCurrentBytes: true,
  }),
  /**
   * The named native self-test vectors that must exist for the enforcing side
   * to be considered covered. The packaging test asserts each of these names is
   * present in the reviewed C# source, so deleting a native regression breaks a
   * TypeScript test rather than passing silently.
   */
  requiredNativeVectors: Object.freeze([
    "boundary/refuses-child-reporting-other-component",
    "boundary/refuses-image-outside-verified-closure",
    "boundary/refuses-root-not-bound-to-lease",
    "boundary/refuses-when-lease-already-disposed",
    "boundary/refuses-when-lease-disposed-after-authorization",
    "closure/lease-retains-handles-after-measurement",
    "closure/refuses-extra-closure-file",
    "closure/refuses-measurement-not-through-handle",
    "closure/refuses-share-mode-permitting-delete",
    "closure/refuses-share-mode-permitting-write",
    "closure/win32-handle-denies-write-and-delete",
    "path/refuses-extended-length-root",
    "path/refuses-parent-escape-in-component",
    "path/refuses-reparse-point-at-intermediate-component",
    "path/refuses-unc-root",
    "role/mutating-requires-authorization",
  ] as const),
} as const);

/** One entry as observed on disk by the control plane. */
export interface ObservedClosureEntry {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  /**
   * Whether the entry is, or is reached through, a reparse point. The control
   * plane can observe this with `lstat`; it cannot prevent it changing.
   */
  readonly reparsePoint?: boolean;
}

export interface WindowsPreFilterResult {
  /** Always false. A pre-filter never authorizes. */
  readonly enforcing: false;
  /** Always false. A past-tense hash is not evidence about the current bytes. */
  readonly provesCurrentBytes: false;
  /** Null means "found nothing wrong", which is not the same as "is safe". */
  readonly refusal: WindowsArtifactRefusal | null;
}

function refused(refusal: WindowsArtifactRefusal): WindowsPreFilterResult {
  return Object.freeze({ enforcing: false as const, provesCurrentBytes: false as const, refusal });
}

const PASSED: WindowsPreFilterResult = Object.freeze({
  enforcing: false as const,
  provesCurrentBytes: false as const,
  refusal: null,
});

/**
 * Compares an observed closure against a manifest and returns the first
 * refusal, if any.
 *
 * The comparison is exact in both directions: a missing entry, an extra entry,
 * a duplicate, a case-only duplicate, a size difference, and a digest
 * difference are all refusals. Extra entries matter as much as missing ones —
 * an unexpected file in the closure is an unaccounted-for input to the process
 * that is about to run.
 */
export function windowsPreFilterClosure(
  manifest: WindowsArtifactManifest,
  observed: readonly ObservedClosureEntry[],
): WindowsPreFilterResult {
  const expected = new Map<string, { readonly size: number; readonly sha256: string }>();
  for (const entry of manifest.files) {
    expected.set(entry.name, { size: entry.size, sha256: entry.sha256 });
  }

  const seen = new Set<string>();
  const seenLower = new Set<string>();
  for (const entry of observed) {
    const nameIssue = windowsArtifactFileNameIssue(entry.name);
    if (nameIssue !== null) return refused(nameIssue);
    if (entry.reparsePoint === true) return refused("artifact-file-reparse-point");
    if (seen.has(entry.name) || seenLower.has(entry.name.toLowerCase())) {
      return refused("artifact-file-duplicate");
    }
    seen.add(entry.name);
    seenLower.add(entry.name.toLowerCase());

    const match = expected.get(entry.name);
    if (match === undefined) return refused("artifact-file-unexpected");
    if (match.size !== entry.size) return refused("artifact-file-size-mismatch");
    if (match.sha256 !== entry.sha256) return refused("artifact-file-digest-mismatch");
  }

  for (const name of expected.keys()) {
    if (!seen.has(name)) return refused("artifact-file-missing");
  }

  return PASSED;
}

/**
 * The honest verdict for a bundle the control plane has looked at.
 *
 * It deliberately has no "approved" state. The two outcomes are "refused here"
 * and "not refused here, still requires native enforcement", because those are
 * the only two conclusions the control plane is entitled to reach.
 */
export function describeWindowsPreFilterVerdict(result: WindowsPreFilterResult): {
  readonly verdict: "refused" | "requires-native-enforcement";
  readonly refusal: WindowsArtifactRefusal | null;
  readonly sufficientToSpawn: false;
} {
  return Object.freeze({
    verdict: result.refusal === null ? ("requires-native-enforcement" as const) : ("refused" as const),
    refusal: result.refusal,
    sufficientToSpawn: false as const,
  });
}

/**
 * Whether a name may be used as a process image name by the native side.
 *
 * The control plane never composes a path: it can only say that a name is or is
 * not a member of the verified closure, by name. Path composition happens once,
 * natively, from an already-validated bundle root.
 */
export function windowsPreFilterImageName(
  manifest: WindowsArtifactManifest,
  imageName: string,
): WindowsPreFilterResult {
  if (!isSafeWindowsArtifactFileName(imageName)) return refused("artifact-file-name-invalid");
  const member = manifest.files.some((entry) => entry.name === imageName);
  return member ? PASSED : refused("artifact-caller-selected-path-refused");
}
