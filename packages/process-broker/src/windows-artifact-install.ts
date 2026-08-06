/**
 * Installed-bundle placement, verification, side-by-side update, rollback,
 * removal, quarantine, and interruption recovery (ADR 0017 sections 6.5
 * and 7).
 *
 * Package-private, like `trusted-evidence.ts` and `windows-recovery-journal.ts`:
 * it is not reachable through the package export map, so an ordinary consumer
 * of `@ai-dev-os/process-broker` cannot obtain a filesystem-mutating artifact
 * API from it. First-party code and the reviewed packaging script import it by
 * relative path.
 *
 * Every entry point takes an explicit absolute installation root. That is
 * deliberate and is *not* discovery: this is the administrative surface used by
 * packaging and by the installed-package simulation. Discovery — the thing the
 * broker uses at execution time — has no path parameter at all and always
 * fails closed (see `windows-artifact-discovery.ts`).
 *
 * ## Honest limitations
 *
 * - **No deny-write handles.** ADR 0017 section 6.5 requires hashing through a
 *   `FILE_SHARE_READ`-only handle held across process creation. Node's `fs`
 *   cannot request Windows share modes, so this implementation hashes through
 *   an ordinary read handle. The content-substitution window is therefore
 *   *not* closed here. That is a stated production blocker, not a solved
 *   problem, and it is one reason the pinned fingerprint table is empty.
 * - **No protected install root.** Path redirection by renaming a parent
 *   directory remains open (ADR 0017 section 6.6) because creating an
 *   administrator-only install root is outside the current authorization.
 * - Nothing here executes an artifact. Placement and verification are not
 *   enforcement, and a verified bundle is still `unsigned-candidate`.
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
  lstat,
} from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
  MAX_WINDOWS_ARTIFACT_MANIFEST_BYTES,
  WINDOWS_ARTIFACT_COMPONENTS,
  WINDOWS_ARTIFACT_MANIFEST_FILE_NAME,
  WINDOWS_ARTIFACT_RID,
  classifyWindowsArtifactBundle,
  isSafeWindowsArtifactFileName,
  parseWindowsArtifactManifest,
  verifyWindowsArtifactIdentity,
  windowsArtifactManifestFingerprint,
  type WindowsArtifactComponent,
  type WindowsArtifactIdentityExpectation,
  type WindowsArtifactManifest,
  type WindowsArtifactRefusal,
} from "./windows-artifact.js";

export const WINDOWS_STAGING_DIRECTORY = ".staging";
export const WINDOWS_QUARANTINE_DIRECTORY = ".quarantine";
export const WINDOWS_REMOVAL_MARKER = ".removing";

/** The observable intermediate states of an install, in order. */
export const WINDOWS_INSTALL_STEPS = Object.freeze([
  "staging-created",
  "closure-staged",
  "manifest-staged",
  "staging-verified",
  "version-directory-created",
  "bundle-renamed",
] as const);
export type WindowsInstallStep = (typeof WINDOWS_INSTALL_STEPS)[number];

export interface WindowsInstallLayout {
  readonly root: string;
  readonly component: WindowsArtifactComponent;
  readonly bundleVersion: string;
  readonly componentDir: string;
  readonly versionDir: string;
  readonly bundleDir: string;
  readonly manifestPath: string;
  readonly removalMarkerPath: string;
}

/** `<root>/<component>/<bundleVersion>/win-x64` — no mutable `latest` alias. */
export function windowsInstallLayout(
  root: string,
  component: WindowsArtifactComponent,
  bundleVersion: string,
): WindowsInstallLayout {
  const componentDir = join(root, component);
  const versionDir = join(componentDir, bundleVersion);
  const bundleDir = join(versionDir, WINDOWS_ARTIFACT_RID);
  return Object.freeze({
    root,
    component,
    bundleVersion,
    componentDir,
    versionDir,
    bundleDir,
    manifestPath: join(bundleDir, WINDOWS_ARTIFACT_MANIFEST_FILE_NAME),
    removalMarkerPath: join(versionDir, WINDOWS_REMOVAL_MARKER),
  });
}

/**
 * Path segments may not contain Windows-reserved punctuation, an alternate
 * data stream separator, a wildcard, a control character, or a tilde.
 *
 * The tilde matters on its own. NTFS keeps DOS 8.3 aliases, so `RUNTIM~1` can
 * name the same on-disk object as a long directory name under a completely
 * different string. Permitting it would let two different paths resolve to one
 * object while both passed a "normalization is unambiguous" check, which is
 * precisely what ADR 0017 section 6.5 step 1 promises to refuse. No component
 * name, version string, RID, or quarantine label this design produces contains
 * a tilde, so refusing every tilde outright is tighter and cheaper than trying
 * to recognise the 8.3 shape.
 */
const UNSAFE_SEGMENT = /[<>:"|?*~\u0000-\u001f]/;

function segmentIssue(segment: string): WindowsArtifactRefusal | null {
  if (segment.length === 0) return "artifact-path-normalization-ambiguous";
  if (segment === "." || segment === "..") return "artifact-path-escape";
  if (UNSAFE_SEGMENT.test(segment)) return "artifact-path-normalization-ambiguous";
  if (segment.endsWith(".") || segment.endsWith(" ") || segment.startsWith(" ")) {
    return "artifact-path-normalization-ambiguous";
  }
  if (segment.normalize("NFC") !== segment) return "artifact-path-normalization-ambiguous";
  return null;
}

/**
 * Refuses a path that escapes the root, normalizes ambiguously, differs from
 * the on-disk name only by case, or traverses a reparse point at any
 * component. Junctions and symbolic links are both reparse points and both are
 * refused.
 */
export async function checkWindowsArtifactPath(
  root: string,
  target: string,
): Promise<WindowsArtifactRefusal | null> {
  if (!isAbsolute(root) || !isAbsolute(target)) return "artifact-root-unresolvable";
  const normalizedRoot = normalize(resolve(root));
  const normalizedTarget = normalize(resolve(target));
  if (normalizedTarget !== target || normalizedRoot !== root) {
    return "artifact-path-normalization-ambiguous";
  }
  if (
    normalizedTarget !== normalizedRoot &&
    !normalizedTarget.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep)
  ) {
    return "artifact-path-escape";
  }

  const relative = normalizedTarget.slice(normalizedRoot.length).split(sep).filter((part) => part !== "");
  let current = normalizedRoot;
  const rootIssue = await reparseIssue(current);
  if (rootIssue !== null) return rootIssue;

  for (const segment of relative) {
    const issue = segmentIssue(segment);
    if (issue !== null) return issue;
    const parent = current;
    current = join(parent, segment);
    const linkIssue = await reparseIssue(current);
    if (linkIssue !== null) return linkIssue;
    const caseIssue = await caseExactIssue(parent, segment);
    if (caseIssue !== null) return caseIssue;
  }
  return null;
}

async function reparseIssue(path: string): Promise<WindowsArtifactRefusal | null> {
  try {
    const info = await lstat(path);
    return info.isSymbolicLink() ? "artifact-path-reparse-point" : null;
  } catch {
    // A path component that does not exist yet cannot be a reparse point. Its
    // absence is handled by the caller, which knows whether it is required.
    return null;
  }
}

async function caseExactIssue(
  parent: string,
  segment: string,
): Promise<WindowsArtifactRefusal | null> {
  let entries: readonly string[];
  try {
    entries = await readdir(parent);
  } catch {
    return null;
  }
  if (entries.includes(segment)) return null;
  const lowered = segment.toLowerCase();
  if (entries.some((entry) => entry.toLowerCase() === lowered)) {
    return "artifact-path-normalization-ambiguous";
  }
  return null;
}

async function sha256OfFile(path: string): Promise<{ readonly size: number; readonly sha256: string }> {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(65_536);
    let size = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    return { size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

export interface WindowsBundleVerified {
  readonly verified: true;
  readonly manifest: WindowsArtifactManifest;
  readonly manifestFingerprint: string;
  readonly signerState: "unsigned-candidate";
  readonly productionEligible: false;
}

export interface WindowsBundleRefused {
  readonly verified: false;
  readonly code: WindowsArtifactRefusal;
}

export type WindowsBundleVerification = WindowsBundleVerified | WindowsBundleRefused;

function refuse(code: WindowsArtifactRefusal): WindowsBundleRefused {
  return Object.freeze({ verified: false as const, code });
}

/**
 * Reads and validates a manifest file. The manifest is read before the closure
 * so a schema failure is reported as a schema failure rather than as a missing
 * file.
 */
async function readManifest(
  root: string,
  manifestPath: string,
): Promise<{ readonly ok: true; readonly manifest: WindowsArtifactManifest } | WindowsBundleRefused> {
  const pathIssue = await checkWindowsArtifactPath(root, manifestPath);
  if (pathIssue !== null) return refuse(pathIssue);
  let raw: Buffer;
  try {
    const info = await stat(manifestPath);
    if (!info.isFile()) return refuse("artifact-manifest-missing");
    if (info.size > MAX_WINDOWS_ARTIFACT_MANIFEST_BYTES) return refuse("artifact-manifest-unreadable");
    raw = await readFile(manifestPath);
  } catch {
    return refuse("artifact-manifest-missing");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    return refuse("artifact-manifest-unreadable");
  }
  if (
    typeof parsedJson === "object" &&
    parsedJson !== null &&
    !Array.isArray(parsedJson) &&
    (parsedJson as Record<string, unknown>)["schemaVersion"] !== 1
  ) {
    return refuse("artifact-manifest-unsupported-schema");
  }
  try {
    return { ok: true as const, manifest: parseWindowsArtifactManifest(parsedJson) };
  } catch {
    return refuse("artifact-manifest-schema-invalid");
  }
}

/**
 * Verifies a bundle directory: path safety, manifest schema, declared
 * identity, exact directory enumeration, and per-file size and digest.
 *
 * `pinnedFingerprint` is the reviewed-source trust root. When it is supplied
 * and does not match, the bundle is refused even though every byte verified
 * against its own manifest — because a manifest that describes itself proves
 * only internal consistency.
 */
export async function verifyWindowsBundleDirectory(input: {
  readonly root: string;
  readonly bundleDir: string;
  readonly expected: WindowsArtifactIdentityExpectation;
  readonly pinnedFingerprint?: string | null;
}): Promise<WindowsBundleVerification> {
  const pathIssue = await checkWindowsArtifactPath(input.root, input.bundleDir);
  if (pathIssue !== null) return refuse(pathIssue);

  let entries: readonly { readonly name: string; readonly isFile: boolean; readonly isLink: boolean }[];
  try {
    const raw = await readdir(input.bundleDir, { withFileTypes: true });
    entries = raw.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isLink: entry.isSymbolicLink(),
    }));
  } catch {
    return refuse("artifact-manifest-missing");
  }

  const manifestPath = join(input.bundleDir, WINDOWS_ARTIFACT_MANIFEST_FILE_NAME);
  const manifestResult = await readManifest(input.root, manifestPath);
  if (!("ok" in manifestResult)) return manifestResult;
  const manifest = manifestResult.manifest;

  const identityIssue = verifyWindowsArtifactIdentity(manifest, input.expected);
  if (identityIssue !== null) return refuse(identityIssue);

  const expectedNames = new Set(manifest.files.map((file) => file.name));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.name === WINDOWS_ARTIFACT_MANIFEST_FILE_NAME) continue;
    if (entry.isLink) return refuse("artifact-file-reparse-point");
    if (!entry.isFile) return refuse("artifact-file-unexpected");
    if (!isSafeWindowsArtifactFileName(entry.name)) return refuse("artifact-file-name-invalid");
    if (seen.has(entry.name.toLowerCase())) return refuse("artifact-file-duplicate");
    seen.add(entry.name.toLowerCase());
    if (!expectedNames.has(entry.name)) return refuse("artifact-file-unexpected");
  }

  for (const file of manifest.files) {
    // The directory itself was validated above; each entry is validated by its
    // closed-class name, so no per-file path walk is needed or trusted.
    if (!isSafeWindowsArtifactFileName(file.name)) return refuse("artifact-file-name-invalid");
    const filePath = join(input.bundleDir, file.name);
    let info;
    try {
      info = await lstat(filePath);
    } catch {
      return refuse("artifact-file-missing");
    }
    if (info.isSymbolicLink()) return refuse("artifact-file-reparse-point");
    if (!info.isFile()) return refuse("artifact-file-missing");
    const measured = await sha256OfFile(filePath);
    if (measured.size !== file.size) return refuse("artifact-file-size-mismatch");
    if (measured.sha256 !== file.sha256) return refuse("artifact-file-digest-mismatch");
  }

  const manifestFingerprint = windowsArtifactManifestFingerprint(manifest);
  if (input.pinnedFingerprint !== undefined && input.pinnedFingerprint !== null) {
    if (input.pinnedFingerprint !== manifestFingerprint) {
      return refuse("artifact-manifest-fingerprint-unpinned");
    }
  }

  const classification = classifyWindowsArtifactBundle(manifest);
  return Object.freeze({
    verified: true as const,
    manifest,
    manifestFingerprint,
    signerState: classification.signerState,
    productionEligible: false as const,
  });
}

/** Verifies an installed bundle at its canonical location. */
export async function verifyWindowsInstalledBundle(input: {
  readonly root: string;
  readonly component: WindowsArtifactComponent;
  readonly bundleVersion: string;
  readonly pinnedFingerprint?: string | null;
  readonly expectedSourceVersion?: string;
  readonly expectedBuildRecipeVersion?: number;
}): Promise<WindowsBundleVerification> {
  const layout = windowsInstallLayout(input.root, input.component, input.bundleVersion);
  const marker = await pathExists(layout.removalMarkerPath);
  if (marker) return refuse("artifact-removal-interrupted");
  const expected: WindowsArtifactIdentityExpectation = {
    component: input.component,
    bundleVersion: input.bundleVersion,
    ...(input.expectedSourceVersion === undefined
      ? {}
      : { sourceVersion: input.expectedSourceVersion }),
    ...(input.expectedBuildRecipeVersion === undefined
      ? {}
      : { buildRecipeVersion: input.expectedBuildRecipeVersion }),
  };
  return await verifyWindowsBundleDirectory({
    root: input.root,
    bundleDir: layout.bundleDir,
    expected,
    ...(input.pinnedFingerprint === undefined ? {} : { pinnedFingerprint: input.pinnedFingerprint }),
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export interface WindowsInstallResult {
  readonly installed: boolean;
  readonly code: WindowsArtifactRefusal | null;
  readonly layout: WindowsInstallLayout;
  readonly manifestFingerprint: string | null;
}

/**
 * Installs a staged bundle.
 *
 * The staged closure is verified in full *before* anything is placed, then the
 * whole directory is moved into its versioned destination with one rename. An
 * existing destination is a refusal, never an overwrite: in-place binary
 * replacement is not a supported operation.
 */
export async function installWindowsBundle(input: {
  readonly root: string;
  readonly component: WindowsArtifactComponent;
  readonly bundleVersion: string;
  readonly stagingDir: string;
  readonly pinnedFingerprint?: string | null;
}): Promise<WindowsInstallResult> {
  const layout = windowsInstallLayout(input.root, input.component, input.bundleVersion);
  const stagingIssue = await checkWindowsArtifactPath(input.root, input.stagingDir);
  if (stagingIssue !== null) {
    return Object.freeze({ installed: false, code: stagingIssue, layout, manifestFingerprint: null });
  }
  // Destination first: an occupied destination is refused whatever the state
  // of the staging directory, because in-place replacement is never permitted.
  if (await pathExists(layout.bundleDir)) {
    return Object.freeze({
      installed: false,
      code: "artifact-destination-exists" as const,
      layout,
      manifestFingerprint: null,
    });
  }
  if (!(await pathExists(input.stagingDir))) {
    return Object.freeze({
      installed: false,
      code: "artifact-staging-incomplete" as const,
      layout,
      manifestFingerprint: null,
    });
  }
  if (await pathExists(layout.removalMarkerPath)) {
    return Object.freeze({
      installed: false,
      code: "artifact-removal-interrupted" as const,
      layout,
      manifestFingerprint: null,
    });
  }

  const verification = await verifyWindowsBundleDirectory({
    root: input.root,
    bundleDir: input.stagingDir,
    expected: { component: input.component, bundleVersion: input.bundleVersion },
    ...(input.pinnedFingerprint === undefined ? {} : { pinnedFingerprint: input.pinnedFingerprint }),
  });
  if (!verification.verified) {
    return Object.freeze({
      installed: false,
      code: verification.code,
      layout,
      manifestFingerprint: null,
    });
  }

  await mkdir(layout.versionDir, { recursive: true });
  try {
    await rename(input.stagingDir, layout.bundleDir);
  } catch {
    return Object.freeze({
      installed: false,
      code: "artifact-install-interrupted" as const,
      layout,
      manifestFingerprint: null,
    });
  }

  return Object.freeze({
    installed: true,
    code: null,
    layout,
    manifestFingerprint: verification.manifestFingerprint,
  });
}

export interface WindowsRemovalResult {
  readonly removed: boolean;
  readonly code: WindowsArtifactRefusal | null;
  readonly removedFileCount: number;
}

/**
 * Removes exactly one inactive version.
 *
 * Order: write the `.removing` marker, delete exactly the manifest-listed
 * files, delete the manifest last, then remove the now-empty directories. The
 * marker is what makes an interrupted removal resumable, and deleting the
 * manifest last is what keeps the closed derived file set readable until every
 * file it names is gone. Nothing here deletes recursively or by pattern.
 */
export async function removeWindowsBundle(input: {
  readonly root: string;
  readonly component: WindowsArtifactComponent;
  readonly bundleVersion: string;
  readonly activeVersions: readonly string[];
  readonly recoverableVersions: readonly string[];
}): Promise<WindowsRemovalResult> {
  const layout = windowsInstallLayout(input.root, input.component, input.bundleVersion);
  if (input.activeVersions.includes(input.bundleVersion)) {
    return Object.freeze({ removed: false, code: "artifact-removal-active-version" as const, removedFileCount: 0 });
  }
  if (input.recoverableVersions.includes(input.bundleVersion)) {
    return Object.freeze({
      removed: false,
      code: "artifact-removal-recoverable-version" as const,
      removedFileCount: 0,
    });
  }
  const pathIssue = await checkWindowsArtifactPath(input.root, layout.bundleDir);
  if (pathIssue !== null) {
    return Object.freeze({ removed: false, code: pathIssue, removedFileCount: 0 });
  }
  if (!(await pathExists(layout.bundleDir))) {
    return Object.freeze({ removed: false, code: "artifact-manifest-missing" as const, removedFileCount: 0 });
  }

  await writeFile(layout.removalMarkerPath, `${input.component} ${input.bundleVersion}\n`, "utf8");
  return await completeRemoval(layout);
}

async function completeRemoval(layout: WindowsInstallLayout): Promise<WindowsRemovalResult> {
  const manifestResult = await readManifest(layout.root, layout.manifestPath);
  let removedFileCount = 0;
  if ("ok" in manifestResult) {
    for (const file of manifestResult.manifest.files) {
      const filePath = join(layout.bundleDir, file.name);
      try {
        await unlink(filePath);
        removedFileCount += 1;
      } catch {
        // Already gone: an interrupted removal is resumed, not restarted, and
        // every step is idempotent.
      }
    }
    try {
      await unlink(layout.manifestPath);
    } catch {
      // Already gone.
    }
  }

  try {
    await rmdir(layout.bundleDir);
  } catch {
    const remaining = await safeReaddir(layout.bundleDir);
    if (remaining.length > 0) {
      return Object.freeze({
        removed: false,
        code: "artifact-file-unexpected" as const,
        removedFileCount,
      });
    }
  }
  try {
    await unlink(layout.removalMarkerPath);
  } catch {
    // Already gone.
  }
  try {
    await rmdir(layout.versionDir);
  } catch {
    // A non-empty version directory is left for the next recovery pass rather
    // than being cleared recursively.
  }
  await pruneEmptyComponentDirectory(layout);
  return Object.freeze({ removed: true, code: null, removedFileCount });
}

async function pruneEmptyComponentDirectory(layout: WindowsInstallLayout): Promise<void> {
  const remaining = await safeReaddir(layout.componentDir);
  if (remaining.length === 0) {
    try {
      await rmdir(layout.componentDir);
    } catch {
      // Left in place; an empty component directory is not residue that any
      // later step depends on.
    }
  }
}

async function safeReaddir(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/** Resumes a removal that was interrupted after its marker was written. */
export async function resumeWindowsInterruptedRemoval(input: {
  readonly root: string;
  readonly component: WindowsArtifactComponent;
  readonly bundleVersion: string;
}): Promise<WindowsRemovalResult> {
  const layout = windowsInstallLayout(input.root, input.component, input.bundleVersion);
  if (!(await pathExists(layout.removalMarkerPath))) {
    return Object.freeze({ removed: false, code: "artifact-manifest-missing" as const, removedFileCount: 0 });
  }
  return await completeRemoval(layout);
}

export interface WindowsQuarantineResult {
  readonly quarantined: boolean;
  readonly code: WindowsArtifactRefusal | null;
  readonly quarantinePath: string | null;
}

/**
 * Quarantines a partial or tampered directory by renaming it under the
 * quarantine root. It is never repaired and never silently deleted, because
 * both destroy the evidence of what went wrong.
 */
export async function quarantineWindowsDirectory(input: {
  readonly root: string;
  readonly directory: string;
  readonly label: string;
}): Promise<WindowsQuarantineResult> {
  const issue = await checkWindowsArtifactPath(input.root, input.directory);
  if (issue !== null) {
    return Object.freeze({ quarantined: false, code: issue, quarantinePath: null });
  }
  if (!(await pathExists(input.directory))) {
    return Object.freeze({
      quarantined: false,
      code: "artifact-manifest-missing" as const,
      quarantinePath: null,
    });
  }
  if (!/^[a-z0-9][a-z0-9.-]{0,96}$/.test(input.label)) {
    return Object.freeze({
      quarantined: false,
      code: "artifact-file-name-invalid" as const,
      quarantinePath: null,
    });
  }
  const quarantineRoot = join(input.root, WINDOWS_QUARANTINE_DIRECTORY);
  await mkdir(quarantineRoot, { recursive: true });
  let destination = join(quarantineRoot, input.label);
  let suffix = 1;
  while (await pathExists(destination)) {
    destination = join(quarantineRoot, `${input.label}-${String(suffix)}`);
    suffix += 1;
  }
  await rename(input.directory, destination);
  return Object.freeze({ quarantined: true, code: null, quarantinePath: destination });
}

/** Every installed version of a component, ordinal-sorted. No mutable alias. */
export async function listWindowsInstalledVersions(
  root: string,
  component: WindowsArtifactComponent,
): Promise<readonly string[]> {
  const versions = await safeReaddir(join(root, component));
  return Object.freeze([...versions].sort());
}

export interface WindowsInstallRootRecovery {
  readonly resumedRemovals: readonly string[];
  readonly quarantined: readonly string[];
  readonly prunedEmptyVersionDirectories: readonly string[];
}

/**
 * The recovery pass a later startup performs over an installation root:
 * finish interrupted removals, quarantine incomplete staging directories, and
 * remove version directories that never received a bundle.
 *
 * It is exact: it resumes marked removals, renames incomplete staging
 * directories, and calls `rmdir` on directories it has proved empty. It never
 * deletes recursively and never guesses a name.
 */
export async function recoverWindowsInstallRoot(input: {
  readonly root: string;
}): Promise<WindowsInstallRootRecovery> {
  const resumedRemovals: string[] = [];
  const quarantined: string[] = [];
  const pruned: string[] = [];

  for (const component of WINDOWS_ARTIFACT_COMPONENTS) {
    for (const bundleVersion of await listWindowsInstalledVersions(input.root, component)) {
      const layout = windowsInstallLayout(input.root, component, bundleVersion);
      if (await pathExists(layout.removalMarkerPath)) {
        const result = await completeRemoval(layout);
        if (result.removed) resumedRemovals.push(`${component}/${bundleVersion}`);
        continue;
      }
      if (!(await pathExists(layout.bundleDir))) {
        try {
          await rmdir(layout.versionDir);
          pruned.push(`${component}/${bundleVersion}`);
          await pruneEmptyComponentDirectory(layout);
        } catch {
          const result = await quarantineWindowsDirectory({
            root: input.root,
            directory: layout.versionDir,
            label: `${component}-${bundleVersion}`.toLowerCase(),
          });
          if (result.quarantined) quarantined.push(`${component}/${bundleVersion}`);
        }
      }
    }
  }

  const stagingRoot = join(input.root, WINDOWS_STAGING_DIRECTORY);
  for (const entry of await safeReaddir(stagingRoot)) {
    const directory = join(stagingRoot, entry);
    const result = await quarantineWindowsDirectory({
      root: input.root,
      directory,
      label: `staging-${entry}`.toLowerCase(),
    });
    if (result.quarantined) quarantined.push(`${WINDOWS_STAGING_DIRECTORY}/${entry}`);
  }
  try {
    await rmdir(stagingRoot);
  } catch {
    // Left in place when it still holds entries a later pass will handle.
  }

  return Object.freeze({
    resumedRemovals: Object.freeze(resumedRemovals),
    quarantined: Object.freeze(quarantined),
    prunedEmptyVersionDirectories: Object.freeze(pruned),
  });
}

/**
 * Lists every path still present under the installation root, relative and
 * ordinal-sorted. A clean root after install and removal is the empty list.
 */
export async function scanWindowsInstallResidue(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await safeReaddir(directory)) {
      const relative = prefix === "" ? entry : `${prefix}/${entry}`;
      found.push(relative);
      const child = join(directory, entry);
      let info;
      try {
        info = await lstat(child);
      } catch {
        continue;
      }
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await walk(child, relative);
      }
    }
  };
  await walk(root, "");
  return Object.freeze([...found].sort());
}
