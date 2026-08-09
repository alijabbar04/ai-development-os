/**
 * Stage 17 Windows production artifact packaging tests.
 *
 * Everything here is value logic and task-owned temporary-directory
 * simulation. Nothing in this file creates an AppContainer profile, a Job
 * Object, a process, an ACL change, a registry value, a recovery journal, or
 * any other host state, and nothing here is enforcement evidence.
 *
 * Where a test stands in for future mutating supervisor or helper behaviour it
 * is named or commented `simulated` / `non-enforcement`. A passing test in this
 * file means the refusal logic is correct, not that containment exists.
 *
 * Protocol framing, strict frame parsing, and the operation state machine are
 * implemented in the two native components and are proved by their 105 shared
 * in-memory conformance vectors plus their role vectors. Those results are
 * pinned here by digest (see `WINDOWS_COMPONENT_CONFORMANCE`) and are re-checked
 * against the actual binaries by `scripts/build-windows-artifacts.mjs`; a
 * change on either side that is not mirrored fails.
 */

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_WINDOWS_ARTIFACT_FILE_COUNT,
  PINNED_WINDOWS_BUNDLE_FINGERPRINTS,
  PROOF_ONLY_COMPONENTS,
  admitWindowsArtifactBuildFlavor,
  WINDOWS_ARTIFACT_COMPONENTS,
  WINDOWS_ARTIFACT_LIMITATION_CODES,
  WINDOWS_ARTIFACT_MANIFEST_FILE_NAME,
  WINDOWS_ARTIFACT_MANIFEST_KIND,
  WINDOWS_ARTIFACT_REFUSALS,
  WINDOWS_ARTIFACT_RID,
  WINDOWS_COMPONENT_CONFORMANCE,
  WINDOWS_PROTOCOL_LIMITS,
  classifyWindowsArtifactBundle,
  createWindowsSandboxBackend,
  describeWindowsArtifactSeam,
  discoverWindowsArtifactBundle,
  findPinnedWindowsBundle,
  isSafeWindowsArtifactFileName,
  parseWindowsArtifactManifest,
  verifyWindowsArtifactIdentity,
  windowsArtifactManifestFingerprint,
  type WindowsArtifactComponent,
  type WindowsArtifactManifest,
} from "../src/index.js";
import * as publicSurface from "../src/index.js";
import * as testingSurface from "../src/testing/contract-suite.js";
import {
  QUOTA_DIMENSIONS,
} from "../src/quota.js";
import {
  SECURE_BACKEND_ESCAPE_CORPUS_FINGERPRINT,
  SECURE_BACKEND_ESCAPE_CORPUS_VERSION,
  secureBackendEscapeVectorCount,
} from "../src/escape-corpus.js";
import {
  installWindowsBundle,
  listWindowsInstalledVersions,
  quarantineWindowsDirectory,
  recoverWindowsInstallRoot,
  removeWindowsBundle,
  resumeWindowsInterruptedRemoval,
  scanWindowsInstallResidue,
  verifyWindowsInstalledBundle,
  windowsInstallLayout,
  WINDOWS_INSTALL_STEPS,
  WINDOWS_REMOVAL_MARKER,
  WINDOWS_STAGING_DIRECTORY,
  checkWindowsArtifactPath,
} from "../src/windows-artifact-install.js";
import {
  canonicalWindowsRecoveryRecord,
  frameWindowsRecoveryRecord,
  isWindowsRecoveryJournalActionable,
  readWindowsRecoveryJournal,
  windowsJournalFileName,
  windowsProfileName,
  windowsRecoverableBundleVersions,
  windowsRecoveryRecordDigest,
  windowsStagedFileNames,
  windowsStagingRootLeaf,
  type WindowsRecoveryRecord,
} from "../src/windows-recovery-journal.js";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const roots: string[] = [];

async function taskOwnedRoot(label: string): Promise<string> {
  const created = await mkdtemp(join(realpathSync(tmpdir()), `aidevos-s17-${label}-`));
  const root = realpathSync(created);
  roots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.allSettled(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const TOKEN = "0123456789abcdef0123456789abcdef";
const OTHER_TOKEN = "fedcba9876543210fedcba9876543210";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

let fixtureManifest: WindowsArtifactManifest;
let fixtureRaw: Record<string, unknown>;

beforeAll(async () => {
  const text = await readFile(
    join(packageRoot, "scripts", "manifest-conformance-fixture.json"),
    "utf8",
  );
  fixtureRaw = JSON.parse(text) as Record<string, unknown>;
  fixtureManifest = parseWindowsArtifactManifest(fixtureRaw);
});

function mutatedFixture(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...structuredClone(fixtureRaw), ...overrides };
}

/** Builds a small synthetic bundle. The contents are text, not executables. */
interface SyntheticBundle {
  readonly files: Record<string, string>;
  readonly manifest: Record<string, unknown>;
}

function syntheticBundle(options: {
  readonly component: WindowsArtifactComponent;
  readonly bundleVersion: string;
  readonly files?: Record<string, string>;
  readonly manifestOverrides?: Record<string, unknown>;
}): SyntheticBundle {
  const files = options.files ?? {
    "alpha.dll": "alpha-bytes",
    "beta.exe": "beta-bytes",
    "candidate.runtimeconfig.json": "{}",
  };
  const entries = Object.keys(files)
    .sort()
    .map((name) => {
      const content = files[name] ?? "";
      return { name, size: Buffer.byteLength(content, "utf8"), sha256: sha256(content) };
    });
  return {
    files,
    manifest: {
      schemaVersion: 1,
      manifestKind: WINDOWS_ARTIFACT_MANIFEST_KIND,
      component: options.component,
      protocolVersion: 1,
      sourceVersion: "1.0.0",
      buildRecipeVersion: 1,
      platform: "win32",
      rid: WINDOWS_ARTIFACT_RID,
      architecture: "x64",
      packageVersion: "0.1.0",
      bundleVersion: options.bundleVersion,
      fileCount: entries.length,
      totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      files: entries,
      sourceEnvelopeFingerprint: "1".repeat(64),
      buildManifestFingerprint: "2".repeat(64),
      corpusVersion: SECURE_BACKEND_ESCAPE_CORPUS_VERSION,
      corpusFingerprint: SECURE_BACKEND_ESCAPE_CORPUS_FINGERPRINT,
      windowsApplicableVectorCount: secureBackendEscapeVectorCount("win32"),
      signerState: "unsigned-candidate",
      productionEligible: false,
      limitations: ["artifact-never-executed-beyond-read-only-self-test", "unsigned-candidate"],
      ...options.manifestOverrides,
    },
  };
}

async function stage(
  root: string,
  bundle: SyntheticBundle,
  stagingName: string,
  options: { readonly omitManifest?: boolean; readonly omitFiles?: readonly string[] } = {},
): Promise<string> {
  const stagingDir = join(root, WINDOWS_STAGING_DIRECTORY, stagingName);
  await mkdir(stagingDir, { recursive: true });
  for (const [name, content] of Object.entries(bundle.files)) {
    if (options.omitFiles?.includes(name) === true) continue;
    await writeFile(join(stagingDir, name), content, "utf8");
  }
  if (options.omitManifest !== true) {
    await writeFile(
      join(stagingDir, WINDOWS_ARTIFACT_MANIFEST_FILE_NAME),
      JSON.stringify(bundle.manifest, null, 2),
      "utf8",
    );
  }
  return stagingDir;
}

async function installed(
  root: string,
  component: WindowsArtifactComponent,
  bundleVersion: string,
  bundle?: SyntheticBundle,
): Promise<string> {
  const built = bundle ?? syntheticBundle({ component, bundleVersion });
  const stagingDir = await stage(root, built, `${component}-${bundleVersion}`);
  const result = await installWindowsBundle({
    root,
    component,
    bundleVersion,
    stagingDir,
  });
  expect(result.code).toBeNull();
  expect(result.installed).toBe(true);
  return result.layout.bundleDir;
}

// ---------------------------------------------------------------- manifest

describe("Stage 17 Windows artifact manifest identity (non-enforcement)", () => {
  it("reproduces the cross-language canonical fingerprint for the reviewed fixture", () => {
    expect(windowsArtifactManifestFingerprint(fixtureManifest)).toBe(
      WINDOWS_COMPONENT_CONFORMANCE.manifestFixtureFingerprint,
    );
  });

  it("is independent of member insertion order", () => {
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(fixtureRaw).reverse()) {
      reordered[key] = fixtureRaw[key];
    }
    expect(windowsArtifactManifestFingerprint(parseWindowsArtifactManifest(reordered))).toBe(
      WINDOWS_COMPONENT_CONFORMANCE.manifestFixtureFingerprint,
    );
  });

  it("changes when any bound fact changes", () => {
    const base = windowsArtifactManifestFingerprint(fixtureManifest);
    const changed = parseWindowsArtifactManifest(mutatedFixture({ bundleVersion: "1.0.1" }));
    expect(windowsArtifactManifestFingerprint(changed)).not.toBe(base);
  });

  it("rejects unknown, duplicate, and prototype-polluting fields", () => {
    expect(() => parseWindowsArtifactManifest(mutatedFixture({ surprise: 1 }))).toThrow();
    // JSON text with a duplicate key collapses to the last value; the parser
    // still refuses because the surviving shape must be exact.
    expect(() =>
      parseWindowsArtifactManifest(
        JSON.parse('{"schemaVersion":1,"schemaVersion":2}') as unknown,
      ),
    ).toThrow();
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const hostile = JSON.parse(
        `{"${key}":{"polluted":true},"schemaVersion":1}`,
      ) as Record<string, unknown>;
      expect(() => parseWindowsArtifactManifest(hostile)).toThrow();
    }
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("rejects an unsupported schema version and a foreign manifest kind", () => {
    expect(() => parseWindowsArtifactManifest(mutatedFixture({ schemaVersion: 2 }))).toThrow();
    expect(() =>
      parseWindowsArtifactManifest(mutatedFixture({ manifestKind: "something-else" })),
    ).toThrow();
  });

  it("rejects duplicate, case-only-duplicate, and unsorted file entries", () => {
    const files = fixtureRaw["files"] as readonly Record<string, unknown>[];
    const first = files[0] as Record<string, unknown>;
    const second = files[1] as Record<string, unknown>;
    expect(() =>
      parseWindowsArtifactManifest(mutatedFixture({ files: [first, first], fileCount: 2, totalBytes: 6 })),
    ).toThrow();
    expect(() =>
      parseWindowsArtifactManifest(
        mutatedFixture({
          files: [first, { ...first, name: "ALPHA.dll", size: 4 }],
          fileCount: 2,
          totalBytes: 7,
        }),
      ),
    ).toThrow();
    expect(() =>
      parseWindowsArtifactManifest(mutatedFixture({ files: [second, first] })),
    ).toThrow();
  });

  it("rejects a closure summary that disagrees with its own file list", () => {
    expect(() => parseWindowsArtifactManifest(mutatedFixture({ fileCount: 3 }))).toThrow();
    expect(() => parseWindowsArtifactManifest(mutatedFixture({ totalBytes: 8 }))).toThrow();
  });

  it("rejects unsorted or unknown limitation codes", () => {
    expect(() =>
      parseWindowsArtifactManifest(
        mutatedFixture({ limitations: ["unsigned-candidate", "artifact-never-executed-beyond-read-only-self-test"] }),
      ),
    ).toThrow();
    expect(() =>
      parseWindowsArtifactManifest(mutatedFixture({ limitations: ["everything-is-fine"] })),
    ).toThrow();
  });

  it("rejects unsafe artifact file names", () => {
    const unsafe = [
      "sub/alpha.dll",
      "sub\\alpha.dll",
      "..\\alpha.dll",
      "a..dll",
      ".hidden",
      "trailing.",
      "trailing ",
      "NUL.dll",
      "com1.dll",
      // Regression, F-003(b): the C# validator used to permit a leading dash
      // or underscore while this one did not.
      "-alpha.dll",
      "_alpha.dll",
      "alph\u00e1.dll",
      "alpha.dll:stream",
      "",
    ];
    for (const name of unsafe) {
      expect(isSafeWindowsArtifactFileName(name)).toBe(false);
    }
    for (const name of ["alpha.dll", "System.Private.CoreLib.dll", "a_b-c.1.json"]) {
      expect(isSafeWindowsArtifactFileName(name)).toBe(true);
    }
  });

  it("refuses a manifest that claims a signature or production eligibility", () => {
    expect(() =>
      parseWindowsArtifactManifest(mutatedFixture({ signerState: "authenticode" })),
    ).toThrow();
    const claimed = parseWindowsArtifactManifest(mutatedFixture({ productionEligible: true }));
    expect(
      verifyWindowsArtifactIdentity(claimed, {
        component: "windows-supervisor",
        bundleVersion: "1.0.0",
      }),
    ).toBe("artifact-production-eligibility-claimed");
  });

  it("binds component, version, protocol, platform, rid, architecture, and source/build", () => {
    const expected = { component: "windows-supervisor" as const, bundleVersion: "1.0.0" };
    expect(verifyWindowsArtifactIdentity(fixtureManifest, expected)).toBeNull();
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ component: "windows-helper" }, "artifact-identity-component-mismatch"],
      [{ bundleVersion: "9.9.9" }, "artifact-manifest-stale"],
      [{ protocolVersion: 2 }, "artifact-identity-protocol-mismatch"],
      [{ platform: "linux" }, "artifact-identity-platform-mismatch"],
      [{ rid: "win-arm64" }, "artifact-identity-rid-mismatch"],
      [{ architecture: "arm64" }, "artifact-identity-architecture-mismatch"],
      [{ corpusVersion: 2 }, "artifact-corpus-mismatch"],
      [{ corpusFingerprint: "9".repeat(64) }, "artifact-corpus-mismatch"],
      [{ windowsApplicableVectorCount: 39 }, "artifact-corpus-mismatch"],
    ];
    for (const [override, code] of cases) {
      const manifest = parseWindowsArtifactManifest(mutatedFixture(override));
      expect(verifyWindowsArtifactIdentity(manifest, expected)).toBe(code);
    }
    expect(
      verifyWindowsArtifactIdentity(fixtureManifest, { ...expected, sourceVersion: "2.0.0" }),
    ).toBe("artifact-identity-source-build-mismatch");
    expect(
      verifyWindowsArtifactIdentity(fixtureManifest, { ...expected, buildRecipeVersion: 2 }),
    ).toBe("artifact-identity-source-build-mismatch");
  });

  it("always classifies a bundle as an unsigned, production-ineligible candidate", () => {
    const classification = classifyWindowsArtifactBundle(fixtureManifest);
    expect(classification.signerState).toBe("unsigned-candidate");
    expect(classification.productionEligible).toBe(false);
    expect([...classification.limitations]).toContain("unsigned-candidate");
    expect(WINDOWS_ARTIFACT_LIMITATION_CODES).toContain("windows-corpus-not-run");
  });

  it("keeps its closed enumerations sorted and finite", () => {
    expect([...WINDOWS_ARTIFACT_REFUSALS]).toEqual([...WINDOWS_ARTIFACT_REFUSALS].sort());
    expect([...WINDOWS_ARTIFACT_LIMITATION_CODES]).toEqual(
      [...WINDOWS_ARTIFACT_LIMITATION_CODES].sort(),
    );
    expect(MAX_WINDOWS_ARTIFACT_FILE_COUNT).toBe(1_024);
  });
});

// --------------------------------------------------------------- discovery

describe("Stage 17 Windows artifact discovery (fail-closed)", () => {
  it("has an empty pinned bundle fingerprint table", () => {
    expect(PINNED_WINDOWS_BUNDLE_FINGERPRINTS).toHaveLength(0);
    expect(Object.isFrozen(PINNED_WINDOWS_BUNDLE_FINGERPRINTS)).toBe(true);
  });

  it("refuses every component because the table is empty", () => {
    for (const component of WINDOWS_ARTIFACT_COMPONENTS) {
      const result = discoverWindowsArtifactBundle({ component });
      expect(result.discovered).toBe(false);
      expect(result.discovered ? null : result.code).toBe("artifact-bundle-not-pinned");
      expect(result.pinnedFingerprintCount).toBe(0);
      expect(findPinnedWindowsBundle(component, "1.0.0")).toBeNull();
    }
  });

  it("refuses identically on every platform, because the table is checked first", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      const result = discoverWindowsArtifactBundle({ component: "windows-helper", platform });
      expect(result.discovered).toBe(false);
      expect(result.discovered ? null : result.code).toBe("artifact-bundle-not-pinned");
    }
  });

  it("does not consult PATH, the current directory, the registry, or a model name", async () => {
    const before = discoverWindowsArtifactBundle({ component: "windows-supervisor" });
    const originalPath = process.env["PATH"];
    try {
      process.env["PATH"] = "C:\\hostile";
      process.env["AIDEVOS_WINDOWS_BUNDLE_ROOT"] = "C:\\hostile\\bundle";
      const after = discoverWindowsArtifactBundle({ component: "windows-supervisor" });
      expect(after).toStrictEqual(before);
    } finally {
      if (originalPath === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = originalPath;
      }
      delete process.env["AIDEVOS_WINDOWS_BUNDLE_ROOT"];
    }

    // Structural, not behavioural: the discovery module must contain no
    // environment, current-directory, registry, or child-process lookup at all.
    const source = await readFile(join(packageRoot, "src", "windows-artifact-discovery.ts"), "utf8");
    for (const forbidden of ["process.env", "process.cwd", "child_process", "reg query", "winreg"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("takes no caller-selected path", () => {
    const withExtras = discoverWindowsArtifactBundle({
      component: "windows-helper",
      ...({ bundleRoot: "C:\\hostile" } as Record<string, never>),
    });
    expect(withExtras.discovered).toBe(false);
    expect(discoverWindowsArtifactBundle.length).toBe(1);
  });

  it("describes a seam that grants nothing and changes no availability truth", () => {
    const seam = describeWindowsArtifactSeam();
    expect(seam.pinnedFingerprintCount).toBe(0);
    expect(seam.anyComponentDiscovered).toBe(false);
    expect(seam.productionEligible).toBe(false);
    expect(seam.changesPlatformAvailability).toBe(false);
    expect(seam.windowsBackendDetail).toBe(
      "windows-native-process-composition-and-corpus-unverified",
    );
    expect(seam.discovery).toHaveLength(WINDOWS_ARTIFACT_COMPONENTS.length);
    expect(describeWindowsArtifactSeam({ platform: "linux" }).anyComponentDiscovered).toBe(false);
  });
});

// ------------------------------------------------------- installed package

describe("Stage 17 Windows installed-package simulation (simulated, non-enforcement)", () => {
  it("places a candidate at its exact immutable location and verifies it", async () => {
    const root = await taskOwnedRoot("place");
    const bundleDir = await installed(root, "windows-supervisor", "1.0.0");
    expect(bundleDir).toBe(join(root, "windows-supervisor", "1.0.0", WINDOWS_ARTIFACT_RID));

    const verification = await verifyWindowsInstalledBundle({
      root,
      component: "windows-supervisor",
      bundleVersion: "1.0.0",
    });
    expect(verification.verified).toBe(true);
    if (verification.verified) {
      expect(verification.signerState).toBe("unsigned-candidate");
      expect(verification.productionEligible).toBe(false);
      expect(verification.manifestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(await listWindowsInstalledVersions(root, "windows-supervisor")).toEqual(["1.0.0"]);
  });

  it("refuses a bundle whose recomputed fingerprint is not the pinned one", async () => {
    const root = await taskOwnedRoot("pin");
    await installed(root, "windows-helper", "1.0.0");
    const refused = await verifyWindowsInstalledBundle({
      root,
      component: "windows-helper",
      bundleVersion: "1.0.0",
      pinnedFingerprint: "0".repeat(64),
    });
    expect(refused.verified).toBe(false);
    expect(refused.verified ? null : refused.code).toBe("artifact-manifest-fingerprint-unpinned");
  });

  it("refuses missing, unexpected, substituted, resized, and re-digested files", async () => {
    const root = await taskOwnedRoot("closure");
    const bundleDir = await installed(root, "windows-supervisor", "1.0.0");
    const verify = async (): Promise<string | null> => {
      const result = await verifyWindowsInstalledBundle({
        root,
        component: "windows-supervisor",
        bundleVersion: "1.0.0",
      });
      return result.verified ? null : result.code;
    };

    await writeFile(join(bundleDir, "gamma.dll"), "extra", "utf8");
    expect(await verify()).toBe("artifact-file-unexpected");
    await unlink(join(bundleDir, "gamma.dll"));
    expect(await verify()).toBeNull();

    await writeFile(join(bundleDir, "alpha.dll"), "alpha-bytes-longer", "utf8");
    expect(await verify()).toBe("artifact-file-size-mismatch");

    await writeFile(join(bundleDir, "alpha.dll"), "ALPHA-BYTES", "utf8");
    expect(await verify()).toBe("artifact-file-digest-mismatch");

    await unlink(join(bundleDir, "alpha.dll"));
    expect(await verify()).toBe("artifact-file-missing");
  });

  it("refuses a substituted manifest and a partially copied bundle", async () => {
    const root = await taskOwnedRoot("substitute");
    const bundleDir = await installed(root, "windows-supervisor", "1.0.0");

    await writeFile(join(bundleDir, WINDOWS_ARTIFACT_MANIFEST_FILE_NAME), "{not json", "utf8");
    let result = await verifyWindowsInstalledBundle({
      root,
      component: "windows-supervisor",
      bundleVersion: "1.0.0",
    });
    expect(result.verified ? null : result.code).toBe("artifact-manifest-unreadable");

    const foreign = syntheticBundle({ component: "windows-helper", bundleVersion: "1.0.0" });
    await writeFile(
      join(bundleDir, WINDOWS_ARTIFACT_MANIFEST_FILE_NAME),
      JSON.stringify(foreign.manifest),
      "utf8",
    );
    result = await verifyWindowsInstalledBundle({
      root,
      component: "windows-supervisor",
      bundleVersion: "1.0.0",
    });
    expect(result.verified ? null : result.code).toBe("artifact-identity-component-mismatch");

    await unlink(join(bundleDir, WINDOWS_ARTIFACT_MANIFEST_FILE_NAME));
    result = await verifyWindowsInstalledBundle({
      root,
      component: "windows-supervisor",
      bundleVersion: "1.0.0",
    });
    expect(result.verified ? null : result.code).toBe("artifact-manifest-missing");
  });

  it("refuses a stale manifest, an unsupported schema, and a wrong architecture or protocol", async () => {
    const root = await taskOwnedRoot("identity");
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ bundleVersion: "0.9.0" }, "artifact-manifest-stale"],
      [{ schemaVersion: 2 }, "artifact-manifest-unsupported-schema"],
      [{ architecture: "arm64" }, "artifact-identity-architecture-mismatch"],
      [{ rid: "win-arm64" }, "artifact-identity-rid-mismatch"],
      [{ protocolVersion: 2 }, "artifact-identity-protocol-mismatch"],
      [{ platform: "linux" }, "artifact-identity-platform-mismatch"],
    ];
    let index = 0;
    for (const [override, code] of cases) {
      const bundleVersion = `1.0.${String(index)}`;
      const bundle = syntheticBundle({
        component: "windows-supervisor",
        bundleVersion,
        manifestOverrides: override,
      });
      const stagingDir = await stage(root, bundle, `case-${String(index)}`);
      const install = await installWindowsBundle({
        root,
        component: "windows-supervisor",
        bundleVersion,
        stagingDir,
      });
      expect(install.installed).toBe(false);
      expect(install.code).toBe(code);
      index += 1;
    }
  });

  it("refuses a bundle whose source or build identity is not the expected one", async () => {
    const root = await taskOwnedRoot("srcbuild");
    await installed(root, "windows-helper", "1.0.0");
    const result = await verifyWindowsInstalledBundle({
      root,
      component: "windows-helper",
      bundleVersion: "1.0.0",
      expectedSourceVersion: "2.0.0",
    });
    expect(result.verified ? null : result.code).toBe("artifact-identity-source-build-mismatch");
    const build = await verifyWindowsInstalledBundle({
      root,
      component: "windows-helper",
      bundleVersion: "1.0.0",
      expectedBuildRecipeVersion: 7,
    });
    expect(build.verified ? null : build.code).toBe("artifact-identity-source-build-mismatch");
  });

  it("refuses path escape, normalization ambiguity, and case ambiguity", async () => {
    const root = await taskOwnedRoot("paths");
    await mkdir(join(root, "windows-supervisor", "1.0.0"), { recursive: true });
    expect(await checkWindowsArtifactPath(root, join(root, "ok"))).toBeNull();
    expect(await checkWindowsArtifactPath(root, resolve(root, ".."))).toBe("artifact-path-escape");
    expect(await checkWindowsArtifactPath(root, `${root}${sep}a${sep}..${sep}b`)).toBe(
      "artifact-path-normalization-ambiguous",
    );
    expect(await checkWindowsArtifactPath(root, join(root, "trailing "))).toBe(
      "artifact-path-normalization-ambiguous",
    );
    expect(await checkWindowsArtifactPath(root, join(root, "with?wildcard"))).toBe(
      "artifact-path-normalization-ambiguous",
    );
    expect(await checkWindowsArtifactPath("relative", join(root, "x"))).toBe(
      "artifact-root-unresolvable",
    );
    // A directory that exists as `windows-supervisor` must not be reachable as
    // `Windows-Supervisor`, even on a case-insensitive filesystem.
    expect(await checkWindowsArtifactPath(root, join(root, "Windows-Supervisor", "1.0.0"))).toBe(
      "artifact-path-normalization-ambiguous",
    );
  });

  it("refuses a reparse point in the bundle path, or skips when links need elevation", async () => {
    const root = await taskOwnedRoot("reparse");
    const target = join(root, "real-target");
    await mkdir(target, { recursive: true });
    const link = join(root, "linked");
    let created = true;
    try {
      await symlink(target, link, "junction");
    } catch {
      created = false;
    }
    if (!created) {
      // SKIPPED, NOT PASSED: creating a directory junction was refused by the
      // host (it usually needs elevation or developer mode). The refusal path
      // is therefore unproved here rather than proved.
      expect(created).toBe(false);
      return;
    }
    expect(await checkWindowsArtifactPath(root, join(link, "inner"))).toBe(
      "artifact-path-reparse-point",
    );
  });

  it("refuses to overwrite an existing version in place", async () => {
    const root = await taskOwnedRoot("overwrite");
    await installed(root, "windows-supervisor", "1.0.0");
    const again = syntheticBundle({ component: "windows-supervisor", bundleVersion: "1.0.0" });
    const stagingDir = await stage(root, again, "again");
    const result = await installWindowsBundle({
      root,
      component: "windows-supervisor",
      bundleVersion: "1.0.0",
      stagingDir,
    });
    expect(result.installed).toBe(false);
    expect(result.code).toBe("artifact-destination-exists");
  });

  it("installs side by side, pins the active version, and rolls back by selection", async () => {
    const root = await taskOwnedRoot("sxs");
    await installed(root, "windows-supervisor", "1.0.0");
    await installed(root, "windows-supervisor", "1.1.0");
    expect(await listWindowsInstalledVersions(root, "windows-supervisor")).toEqual([
      "1.0.0",
      "1.1.0",
    ]);
    for (const version of ["1.0.0", "1.1.0"]) {
      const result = await verifyWindowsInstalledBundle({
        root,
        component: "windows-supervisor",
        bundleVersion: version,
      });
      expect(result.verified).toBe(true);
    }
    // Rollback is a change of which version the pinned table names. Nothing on
    // disk moves and there is no mutable alias to repoint.
    const layout = windowsInstallLayout(root, "windows-supervisor", "1.0.0");
    expect(layout.bundleDir.endsWith(join("1.0.0", WINDOWS_ARTIFACT_RID))).toBe(true);
    const entries = await readdir(join(root, "windows-supervisor"));
    expect(entries).not.toContain("latest");
    expect(entries).not.toContain("current");
  });

  it("refuses to remove an active or recoverable version and removes an inactive one exactly", async () => {
    const root = await taskOwnedRoot("remove");
    await installed(root, "windows-supervisor", "1.0.0");
    await installed(root, "windows-supervisor", "1.1.0");

    const active = await removeWindowsBundle({
      root,
      component: "windows-supervisor",
      bundleVersion: "1.1.0",
      activeVersions: ["1.1.0"],
      recoverableVersions: [],
    });
    expect(active.removed).toBe(false);
    expect(active.code).toBe("artifact-removal-active-version");

    const recoverable = await removeWindowsBundle({
      root,
      component: "windows-supervisor",
      bundleVersion: "1.1.0",
      activeVersions: [],
      recoverableVersions: ["1.1.0"],
    });
    expect(recoverable.removed).toBe(false);
    expect(recoverable.code).toBe("artifact-removal-recoverable-version");

    const removed = await removeWindowsBundle({
      root,
      component: "windows-supervisor",
      bundleVersion: "1.0.0",
      activeVersions: ["1.1.0"],
      recoverableVersions: [],
    });
    expect(removed.removed).toBe(true);
    expect(removed.removedFileCount).toBe(3);
    expect(await listWindowsInstalledVersions(root, "windows-supervisor")).toEqual(["1.1.0"]);
  });

  it("leaves zero residue after a complete install and removal cycle", async () => {
    const root = await taskOwnedRoot("residue");
    await installed(root, "windows-helper", "1.0.0");
    const removed = await removeWindowsBundle({
      root,
      component: "windows-helper",
      bundleVersion: "1.0.0",
      activeVersions: [],
      recoverableVersions: [],
    });
    expect(removed.removed).toBe(true);
    await recoverWindowsInstallRoot({ root });
    expect(await scanWindowsInstallResidue(root)).toEqual([]);
  });

  it("recovers from an interruption at every install step (simulated interruption)", async () => {
    for (const step of WINDOWS_INSTALL_STEPS) {
      const root = await taskOwnedRoot(`step-${step}`);
      const bundle = syntheticBundle({ component: "windows-supervisor", bundleVersion: "1.0.0" });
      const layout = windowsInstallLayout(root, "windows-supervisor", "1.0.0");

      if (step === "staging-created") {
        await mkdir(join(root, WINDOWS_STAGING_DIRECTORY, "s"), { recursive: true });
      } else if (step === "closure-staged") {
        await stage(root, bundle, "s", { omitManifest: true });
      } else if (step === "manifest-staged") {
        await stage(root, bundle, "s", { omitFiles: ["beta.exe"] });
      } else if (step === "staging-verified") {
        await stage(root, bundle, "s");
      } else if (step === "version-directory-created") {
        await stage(root, bundle, "s");
        await mkdir(layout.versionDir, { recursive: true });
      } else {
        const stagingDir = await stage(root, bundle, "s");
        const result = await installWindowsBundle({
          root,
          component: "windows-supervisor",
          bundleVersion: "1.0.0",
          stagingDir,
        });
        expect(result.installed).toBe(true);
      }

      const recovery = await recoverWindowsInstallRoot({ root });
      const residue = await scanWindowsInstallResidue(root);
      if (step === "bundle-renamed") {
        // A completed install is not touched by recovery.
        expect(recovery.quarantined).toEqual([]);
        const verified = await verifyWindowsInstalledBundle({
          root,
          component: "windows-supervisor",
          bundleVersion: "1.0.0",
        });
        expect(verified.verified).toBe(true);
      } else {
        // Every incomplete state is quarantined or pruned, never repaired and
        // never left installable.
        expect(recovery.quarantined.length + recovery.prunedEmptyVersionDirectories.length).
          toBeGreaterThan(0);
        const verified = await verifyWindowsInstalledBundle({
          root,
          component: "windows-supervisor",
          bundleVersion: "1.0.0",
        });
        expect(verified.verified).toBe(false);
        expect(residue.every((entry) => !entry.startsWith(`windows-supervisor/`))).toBe(true);
      }
    }
  });

  it("resumes a removal that was interrupted after its marker was written", async () => {
    const root = await taskOwnedRoot("interrupted-removal");
    await installed(root, "windows-supervisor", "1.0.0");
    const layout = windowsInstallLayout(root, "windows-supervisor", "1.0.0");
    // Simulated interruption: the marker exists but no file was deleted yet.
    await writeFile(layout.removalMarkerPath, "windows-supervisor 1.0.0\n", "utf8");

    const blocked = await verifyWindowsInstalledBundle({
      root,
      component: "windows-supervisor",
      bundleVersion: "1.0.0",
    });
    expect(blocked.verified ? null : blocked.code).toBe("artifact-removal-interrupted");

    const blockedInstall = await installWindowsBundle({
      root,
      component: "windows-supervisor",
      bundleVersion: "1.0.0",
      stagingDir: join(root, WINDOWS_STAGING_DIRECTORY, "none"),
    });
    expect(blockedInstall.code).toBe("artifact-destination-exists");

    const resumed = await resumeWindowsInterruptedRemoval({
      root,
      component: "windows-supervisor",
      bundleVersion: "1.0.0",
    });
    expect(resumed.removed).toBe(true);
    await recoverWindowsInstallRoot({ root });
    expect(await scanWindowsInstallResidue(root)).toEqual([]);
  });

  it("resumes a removal interrupted midway through deleting the closure", async () => {
    const root = await taskOwnedRoot("partial-removal");
    const bundleDir = await installed(root, "windows-supervisor", "1.0.0");
    const layout = windowsInstallLayout(root, "windows-supervisor", "1.0.0");
    await writeFile(layout.removalMarkerPath, "windows-supervisor 1.0.0\n", "utf8");
    await unlink(join(bundleDir, "alpha.dll"));

    const recovery = await recoverWindowsInstallRoot({ root });
    expect(recovery.resumedRemovals).toEqual(["windows-supervisor/1.0.0"]);
    expect(await scanWindowsInstallResidue(root)).toEqual([]);
  });

  it("refuses to resume a removal that was never started", async () => {
    const root = await taskOwnedRoot("no-marker");
    await installed(root, "windows-supervisor", "1.0.0");
    const result = await resumeWindowsInterruptedRemoval({
      root,
      component: "windows-supervisor",
      bundleVersion: "1.0.0",
    });
    expect(result.removed).toBe(false);
    expect(result.code).toBe("artifact-manifest-missing");
  });

  it("quarantines a tampered bundle instead of repairing or deleting it", async () => {
    const root = await taskOwnedRoot("quarantine");
    const bundleDir = await installed(root, "windows-supervisor", "1.0.0");
    await writeFile(join(bundleDir, "alpha.dll"), "tampered", "utf8");

    const quarantined = await quarantineWindowsDirectory({
      root,
      directory: windowsInstallLayout(root, "windows-supervisor", "1.0.0").versionDir,
      label: "windows-supervisor-1.0.0",
    });
    expect(quarantined.quarantined).toBe(true);
    expect(quarantined.quarantinePath).not.toBeNull();

    const residue = await scanWindowsInstallResidue(root);
    expect(residue.some((entry) => entry.startsWith(".quarantine/"))).toBe(true);
    // The tampered bytes are retained, not destroyed.
    const kept = await readFile(
      join(quarantined.quarantinePath ?? "", WINDOWS_ARTIFACT_RID, "alpha.dll"),
      "utf8",
    );
    expect(kept).toBe("tampered");

    const second = await quarantineWindowsDirectory({
      root,
      directory: join(root, "does-not-exist"),
      label: "windows-supervisor-1.0.0",
    });
    expect(second.quarantined).toBe(false);
    expect(second.code).toBe("artifact-manifest-missing");

    const badLabel = await quarantineWindowsDirectory({
      root,
      directory: join(root, ".quarantine"),
      label: "Bad Label",
    });
    expect(badLabel.quarantined).toBe(false);
    expect(badLabel.code).toBe("artifact-file-name-invalid");
  });

  it("refuses an install whose staging directory is missing or outside the root", async () => {
    const root = await taskOwnedRoot("staging");
    const missing = await installWindowsBundle({
      root,
      component: "windows-helper",
      bundleVersion: "1.0.0",
      stagingDir: join(root, WINDOWS_STAGING_DIRECTORY, "absent"),
    });
    expect(missing.code).toBe("artifact-staging-incomplete");

    const outside = await installWindowsBundle({
      root,
      component: "windows-helper",
      bundleVersion: "1.0.0",
      stagingDir: resolve(root, "..", "elsewhere"),
    });
    expect(outside.code).toBe("artifact-path-escape");
  });

  it("keeps the removal marker constant stable", () => {
    expect(WINDOWS_REMOVAL_MARKER).toBe(".removing");
    expect(WINDOWS_STAGING_DIRECTORY).toBe(".staging");
  });
});

// ---------------------------------------------------------------- recovery

describe("Stage 17 Windows recovery-record format (pure, non-enforcement)", () => {
  const record = (
    phase: WindowsRecoveryRecord["phase"],
    sequence: number,
    token = TOKEN,
  ): WindowsRecoveryRecord => ({
    component: "windows-supervisor",
    operationToken: token,
    phase,
    sequence,
    bundleVersion: "1.0.0",
  });

  function journal(...records: readonly WindowsRecoveryRecord[]): Uint8Array {
    const frames = records.map(frameWindowsRecoveryRecord);
    const total = frames.reduce((sum, frame) => sum + frame.length, 0);
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const frame of frames) {
      buffer.set(frame, offset);
      offset += frame.length;
    }
    return buffer;
  }

  it("derives every recovery name purely from the operation token", () => {
    expect(windowsProfileName(TOKEN)).toBe("AiDevOs.S17.5d1d2919a5bc7d29ae6c908688e74ca7");
    expect(windowsStagingRootLeaf(TOKEN)).toBe("aidevos-s17-8e0a428992e9cd87c83d99caff6b2e7c");
    expect(windowsJournalFileName(TOKEN)).toBe(`${TOKEN}.journal`);
    expect([...windowsStagedFileNames(TOKEN)]).toEqual([
      "req-12ece52677716308770858ddb48c8b97.bin",
      "res-418567b7c99828864120f7bed2297b7a.bin",
    ]);
    expect(windowsProfileName(OTHER_TOKEN)).not.toBe(windowsProfileName(TOKEN));
  });

  it("produces the same canonical record bytes as the reviewed C# implementation", () => {
    expect(canonicalWindowsRecoveryRecord(record("request-accepted", 1))).toBe(
      '{"bundleVersion":"1.0.0","component":"windows-supervisor","operationToken":' +
        `"${TOKEN}","phase":"request-accepted",` +
        '"profileName":"AiDevOs.S17.5d1d2919a5bc7d29ae6c908688e74ca7",' +
        '"recordVersion":1,"schemaVersion":1,"sequence":1,' +
        '"stagedFileNames":["req-12ece52677716308770858ddb48c8b97.bin",' +
        '"res-418567b7c99828864120f7bed2297b7a.bin"],' +
        '"stagingRootLeaf":"aidevos-s17-8e0a428992e9cd87c83d99caff6b2e7c"}',
    );
  });

  it("round-trips a journal and reports whether recovery is required", () => {
    const partial = readWindowsRecoveryJournal(
      journal(record("request-accepted", 1), record("setup-complete", 2)),
      TOKEN,
    );
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.journal.records).toHaveLength(2);
    expect(partial.journal.truncatedTrailingRecordDiscarded).toBe(false);
    expect(partial.journal.requiresRecovery).toBe(true);

    const complete = readWindowsRecoveryJournal(
      journal(record("request-accepted", 1), record("cleanup-complete", 2)),
      TOKEN,
    );
    expect(complete.ok && complete.journal.requiresRecovery).toBe(false);
  });

  it("detects and discards a truncated trailing record", () => {
    const full = journal(
      record("request-accepted", 1),
      record("setup-complete", 2),
      record("target-created", 3),
    );
    const truncated = full.subarray(0, full.length - 12);
    const result = readWindowsRecoveryJournal(truncated, TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.journal.records).toHaveLength(2);
    expect(result.journal.truncatedTrailingRecordDiscarded).toBe(true);

    const stray = new Uint8Array(full.length + 2);
    stray.set(full, 0);
    const withStray = readWindowsRecoveryJournal(stray.subarray(0, full.length + 2), TOKEN);
    expect(withStray.ok && withStray.journal.truncatedTrailingRecordDiscarded).toBe(true);
  });

  it("refuses a tampered digest, token, path, sequence, or phase order", () => {
    const base = journal(record("request-accepted", 1));
    const flipped = Uint8Array.from(base);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff;
    let result = readWindowsRecoveryJournal(flipped, TOKEN);
    expect(result.ok ? null : result.code).toBe("recovery-record-digest-mismatch");

    result = readWindowsRecoveryJournal(journal(record("request-accepted", 1, OTHER_TOKEN)), TOKEN);
    expect(result.ok ? null : result.code).toBe("recovery-record-token-mismatch");

    result = readWindowsRecoveryJournal(
      journal(record("request-accepted", 1), record("setup-complete", 1)),
      TOKEN,
    );
    expect(result.ok ? null : result.code).toBe("recovery-record-sequence-invalid");

    result = readWindowsRecoveryJournal(
      journal(record("setup-complete", 1), record("request-accepted", 2)),
      TOKEN,
    );
    expect(result.ok ? null : result.code).toBe("state-out-of-order");

    result = readWindowsRecoveryJournal(new Uint8Array([1, 0, 1, 0]), TOKEN);
    expect(result.ok ? null : result.code).toBe("recovery-record-schema-invalid");

    expect(readWindowsRecoveryJournal(base, "not-a-token")).toStrictEqual({
      ok: false,
      code: "token-malformed",
    });
  });

  it("never trusts a path written into a record", () => {
    const canonical = canonicalWindowsRecoveryRecord(record("request-accepted", 1)).replace(
      "AiDevOs.S17.5d1d2919a5bc7d29ae6c908688e74ca7",
      "AiDevOs.S17.00000000000000000000000000000000",
    );
    const bytes = new TextEncoder().encode(canonical);
    const digest = windowsRecoveryRecordDigest(bytes);
    const framed = new Uint8Array(4 + bytes.length + digest.length);
    new DataView(framed.buffer).setUint32(0, bytes.length, true);
    framed.set(bytes, 4);
    framed.set(digest, 4 + bytes.length);
    const result = readWindowsRecoveryJournal(framed, TOKEN);
    expect(result.ok ? null : result.code).toBe("recovery-record-path-mismatch");
  });

  it("refuses an unknown field and a malformed record body", () => {
    for (const canonical of [
      canonicalWindowsRecoveryRecord(record("request-accepted", 1)).replace(
        '{"bundleVersion"',
        '{"extra":1,"bundleVersion"',
      ),
      '{"bundleVersion":"1.0.0"}',
      "not json at all",
      '["array"]',
    ]) {
      const bytes = new TextEncoder().encode(canonical);
      const digest = windowsRecoveryRecordDigest(bytes);
      const framed = new Uint8Array(4 + bytes.length + digest.length);
      new DataView(framed.buffer).setUint32(0, bytes.length, true);
      framed.set(bytes, 4);
      framed.set(digest, 4 + bytes.length);
      const result = readWindowsRecoveryJournal(framed, TOKEN);
      expect(result.ok).toBe(false);
      expect(result.ok ? null : result.code).toBe("recovery-record-schema-invalid");
    }
  });

  it("treats a stale, replayed, or live-token journal as not actionable", () => {
    const partial = readWindowsRecoveryJournal(
      journal(record("request-accepted", 1), record("setup-complete", 2)),
      TOKEN,
    );
    const complete = readWindowsRecoveryJournal(
      journal(record("request-accepted", 1), record("cleanup-complete", 2)),
      TOKEN,
    );
    expect(partial.ok && complete.ok).toBe(true);
    if (!partial.ok || !complete.ok) return;

    expect(isWindowsRecoveryJournalActionable(TOKEN, partial.journal, [])).toBe(true);
    // Stale: the operation already finished, so nothing may be cleaned up.
    expect(isWindowsRecoveryJournalActionable(TOKEN, complete.journal, [])).toBe(false);
    // Replayed: a restored journal whose token is live must not target it.
    expect(isWindowsRecoveryJournalActionable(TOKEN, partial.journal, [TOKEN])).toBe(false);
    expect(isWindowsRecoveryJournalActionable("nope", partial.journal, [])).toBe(false);

    expect([
      ...windowsRecoverableBundleVersions([{ token: TOKEN, journal: partial.journal }], []),
    ]).toEqual(["1.0.0"]);
    expect([
      ...windowsRecoverableBundleVersions([{ token: TOKEN, journal: complete.journal }], []),
    ]).toEqual([]);
  });

  it("gates removal on the versions a recoverable journal still pins", async () => {
    const root = await taskOwnedRoot("gate");
    await installed(root, "windows-supervisor", "1.0.0");
    const partial = readWindowsRecoveryJournal(
      journal(record("request-accepted", 1), record("setup-complete", 2)),
      TOKEN,
    );
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    const recoverable = windowsRecoverableBundleVersions(
      [{ token: TOKEN, journal: partial.journal }],
      [],
    );
    const refused = await removeWindowsBundle({
      root,
      component: "windows-supervisor",
      bundleVersion: "1.0.0",
      activeVersions: [],
      recoverableVersions: recoverable,
    });
    expect(refused.removed).toBe(false);
    expect(refused.code).toBe("artifact-removal-recoverable-version");
  });
});

// ------------------------------------------------- native component pinning

describe("Stage 17 native component conformance pins (non-enforcement)", () => {
  it("pins the shared core and role conformance the components must report", () => {
    expect(WINDOWS_COMPONENT_CONFORMANCE.coreVectorCount).toBe(165);
    expect(WINDOWS_COMPONENT_CONFORMANCE.coreConformanceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(WINDOWS_COMPONENT_CONFORMANCE.roles["windows-supervisor"].vectorCount).toBe(28);
    expect(WINDOWS_COMPONENT_CONFORMANCE.roles["windows-helper"].vectorCount).toBe(54);
    expect(WINDOWS_COMPONENT_CONFORMANCE.roles["windows-supervisor"].digest).not.toBe(
      WINDOWS_COMPONENT_CONFORMANCE.roles["windows-helper"].digest,
    );
  });

  it("keeps the protocol bounds of ADR 0017 section 4.1", () => {
    expect(WINDOWS_PROTOCOL_LIMITS.protocolVersion).toBe(1);
    expect(WINDOWS_PROTOCOL_LIMITS.frameLengthPrefixBytes).toBe(4);
    expect(WINDOWS_PROTOCOL_LIMITS.maxFramePayloadBytes).toBe(8_192);
    expect(WINDOWS_PROTOCOL_LIMITS.maxConnectionBytes).toBe(262_144);
    expect(WINDOWS_PROTOCOL_LIMITS.maxFramesPerConnection).toBe(32);
    expect(WINDOWS_PROTOCOL_LIMITS.operationTokenHexLength).toBe(32);
  });

  it("keeps the mutation gate's sealed branch present and recipe-coupled", async () => {
    // ADR 0018 section 4. The sealed branch must still declare the constant
    // false, and the proof branch must declare it true; the two are selected by
    // the same preprocessor symbol that selects the build flavour. Before this
    // checkpoint the constant was unconditionally false, so a reviewed-proof
    // build compiled the authorization constructor and still could not execute
    // anything — the gate was a wall with a door drawn on it.
    for (const component of [
      "windows-supervisor",
      "windows-helper",
      "windows-proof-installer",
    ] as const) {
      const gate = await readFile(join(packageRoot, "native", component, "MutationGate.cs"), "utf8");
      expect(gate).toContain("#if AIDEVOS_STAGE17_REVIEWED_PROOF_MODE");
      expect(gate).toContain("private const bool MutatingOperationsEnabled = true;");
      expect(gate).toContain("private const bool MutatingOperationsEnabled = false;");
      expect(gate).toContain('private const string BuildFlavorName = "sealed";');
      expect(gate).toContain('private const string BuildFlavorName = "reviewed-proof-mode";');

      // The true branch must be inside the proof-mode conditional and the false
      // branch inside the #else. A file that declared both unconditionally
      // would not compile, but one that swapped them would, and would produce a
      // sealed binary that mutates.
      const conditional = gate.indexOf("#if AIDEVOS_STAGE17_REVIEWED_PROOF_MODE");
      const otherwise = gate.indexOf("#else", conditional);
      const endOfConditional = gate.indexOf("#endif", otherwise);
      expect(conditional).toBeGreaterThan(-1);
      expect(otherwise).toBeGreaterThan(conditional);
      expect(endOfConditional).toBeGreaterThan(otherwise);
      const proofBranch = gate.slice(conditional, otherwise);
      const sealedBranch = gate.slice(otherwise, endOfConditional);
      expect(proofBranch).toContain("private const bool MutatingOperationsEnabled = true;");
      expect(sealedBranch).toContain("private const bool MutatingOperationsEnabled = false;");
      expect(proofBranch).toContain('BuildFlavorName = "reviewed-proof-mode"');
      expect(sealedBranch).toContain('BuildFlavorName = "sealed"');
    }
  });
});

// ------------------------------------------------- ADR 0018 section 5: interop

/**
 * The reviewed interop allow-list.
 *
 * ADR 0017 section 9a required the eleven-string no-interop denylist to be
 * REPLACED rather than deleted once real interop was written, and ADR 0018
 * section 5 performs the replacement. The table below names the exact files
 * permitted to contain each interop category. Every other `.cs` file in every
 * reviewed native component must be free of all of them.
 *
 * **What this cannot prove, stated so nobody mistakes the test for the
 * guarantee.** A text scan cannot decide reachability. It cannot see a
 * `DllImport` that a source generator emitted into `obj/` — which is exactly
 * why `LibraryImport` is declined project-wide and the explicit attribute is
 * kept in reviewed source. It cannot follow a function pointer. It cannot
 * distinguish a call site behind the mutation gate from one beside it. The
 * allow-list is a containment boundary on WHERE interop may appear, not a proof
 * of HOW it is reached. Reachability is discharged by the
 * capability-by-signature requirement of ADR 0018 section 4, by the compiler
 * and analyser output of a zero-warning build, by call-site review, and by
 * independent audit.
 */
const INTEROP_ALLOW_LIST: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> =
  Object.freeze({
    "windows-supervisor": Object.freeze({
      "RoleRuntime.cs": Object.freeze([
        "dll-import",
        "marshal",
        "create-file-w",
        "create-process-w",
        "job",
        "appcontainer",
        "durability",
      ]),
    }),
    "windows-helper": Object.freeze({}),
    "windows-proof-installer": Object.freeze({
      "NativeFileSystem.cs": Object.freeze([
        "dll-import",
        "marshal",
        "nt-create-file",
        "security-descriptor",
        "durability",
        "file-position",
      ]),
    }),
    "windows-proof-controller": Object.freeze({
      "Stage17WProof.cs": Object.freeze(["marshal", "create-file-w", "create-process-w"]),
    }),
    "windows-runtime": Object.freeze({
      "RuntimeNativePrimitives.cs": Object.freeze([
        "dll-import",
        "marshal",
        "create-file-w",
        "create-process-w",
        "job",
        "appcontainer",
        "security-descriptor",
        "durability",
      ]),
      "RuntimeLifecycleWorker.cs": Object.freeze([
        "dll-import",
        "marshal",
        "create-process-w",
        "job",
        "appcontainer",
        "security-descriptor",
        "durability",
      ]),
    }),
    "windows-boundary-fixture": Object.freeze({
      "Program.cs": Object.freeze(["dll-import", "marshal", "create-process-w"]),
    }),
  });

/** Every category, and the exact tokens that place a file in it. */
const INTEROP_CATEGORIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "dll-import": ["DllImport", "LibraryImport", "SuppressGCTransition"],
  marshal: ["Marshal.", "StructLayout", "AllocHGlobal", "AllocCoTaskMem", "stackalloc", "fixed ("],
  "nt-create-file": ["NtCreateFile", "NtSetInformationFile", "NtQueryInformationFile", "NtClose"],
  "create-file-w": ["CreateFileW", "CreateFile2"],
  "create-process-w": ["CreateProcessW", "CreateProcessAsUserW", "InitializeProcThreadAttributeList"],
  job: ["CreateJobObjectW", "SetInformationJobObject", "QueryInformationJobObject", "TerminateJobObject"],
  appcontainer: [
    "CreateAppContainerProfile",
    "DeleteAppContainerProfile",
    "DeriveAppContainerSidFromAppContainerName",
    "GetAppContainerFolderPath",
  ],
  "security-descriptor": [
    "GetSecurityInfo",
    "SetSecurityInfo",
    "ConvertStringSecurityDescriptorToSecurityDescriptorW",
    "AccessCheck",
    "GetAce",
    "GetAclInformation",
    "ConvertSidToStringSidW",
    "DuplicateTokenEx",
    "OpenProcessToken",
    "GetTokenInformation",
  ],
  durability: ["FlushFileBuffers", "MoveFileExW", "WriteFile", "ReadFile"],

  // Moving a handle's byte offset is its own capability, not a sub-case of
  // reading. It is separated because the offset is what an audit found the
  // adapter getting wrong: a read to EOF followed by a "re-measurement" on the
  // same handle hashed zero bytes. A file that wants to seek has to say so.
  "file-position": ["SetFilePointerEx", "SetFilePointer"],
});

/**
 * Tokens that must appear in NO reviewed native source file, allow-listed or
 * not. Dynamic binding and reflection-generated invocation would let interop
 * exist without any of the categories above appearing anywhere, which is the
 * hole ADR 0017 section 9a recorded in the old denylist.
 */
const FORBIDDEN_EVERYWHERE: readonly string[] = Object.freeze([
  "NativeLibrary.Load",
  "NativeLibrary.GetExport",
  "GetDelegateForFunctionPointer",
  "DynamicMethod",
  "ILGenerator",
  "Assembly.Load",
  "Activator.CreateInstance",
  "MethodInfo.Invoke",
  "Process.Start",
  "ProcessStartInfo",
  "ShellExecute",
  "WinExec",
  "Registry",
  "OpenSCManager",
  "CreateServiceW",
  "ITaskService",
  // `Registry` alone stopped covering `RegistryKey` when the scan moved from
  // substring to whole-identifier matching — a narrowing on precisely the string
  // ADR 0017 section 9a records as covered by the mechanism this replaced. Both
  // spellings are listed rather than reverting to substring matching, which had
  // its own false positives.
  //
  // `Microsoft.Win32` is deliberately NOT listed, and the reason is worth
  // keeping: it was tried, and it flagged `using Microsoft.Win32.SafeHandles;`
  // in the supervisor, which is where `SafeFileHandle` lives and has nothing to
  // do with the registry. That is the false-positive pressure this file's own
  // comment warns about — a token that flags legitimate code is a token someone
  // eventually deletes along with the rule. The registry-specific prefix is used
  // instead.
  "RegistryKey",
  "Microsoft.Win32.Registry",
  "schtasks",
  "netsh",
  "HttpClient",
  "WebClient",
  "Socket(",
  "WSAStartup",
  "InternetOpen",
  "Dns.",
  "Environment.GetEnvironmentVariable",
  "Directory.CreateDirectory",
  "Directory.Delete",
  "File.WriteAllText",
  "File.Delete",
  "File.Move",
  "File.Create",
  "Directory.CreateSymbolicLink",
  "unsafe ",
]);

/** Exact reviewed lifecycle sites allowed to use an otherwise-forbidden API. */
const FORBIDDEN_EXACT_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "windows-proof-installer/ProofConfiguration.cs": Object.freeze([
    "Registry",
    "Microsoft.Win32.Registry",
    "WebClient",
  ]),
  "windows-supervisor/RoleRuntime.cs": Object.freeze([
    "Registry",
    "RegistryKey",
    "HttpClient",
    "Socket(",
    "Dns.",
    "Directory.Delete",
    "File.Delete",
  ]),
  "windows-runtime/RuntimeNativePrimitives.cs": Object.freeze([
    "RegistryKey",
  ]),
  "windows-runtime/RuntimeLifecycleWorker.cs": Object.freeze([
    "RegistryKey",
    "Directory.CreateDirectory",
    "Directory.Delete",
    "File.WriteAllText",
    "File.Delete",
  ]),
  "windows-proof-controller/Stage17WProof.cs": Object.freeze(["File.Delete"]),
  "windows-boundary-fixture/Program.cs": Object.freeze([
    "Socket(",
    "Environment.GetEnvironmentVariable",
    "File.WriteAllText",
    "File.Delete",
  ]),
});

/** The exact libraries and entry points the allow-listed files may import. */
const PERMITTED_IMPORTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "ntdll.dll": Object.freeze([
    "NtClose",
    "NtCreateFile",
    "NtQueryInformationFile",
    "NtSetInformationFile",
  ]),
  "kernel32.dll": Object.freeze([
    "CloseHandle",
    "CreateFileW",
    "CreateJobObjectW",
    "CreatePipe",
    "CreateProcessW",
    "DeleteProcThreadAttributeList",
    "FlushFileBuffers",
    "GetCurrentProcess",
    "GetExitCodeProcess",
    "GetFileInformationByHandleEx",
    "GetFinalPathNameByHandleW",
    "GetVolumeInformationByHandleW",
    "InitializeProcThreadAttributeList",
    "IsProcessInJob",
    "LocalFree",
    "PeekNamedPipe",
    "QueryFullProcessImageNameW",
    "QueryInformationJobObject",
    "ReadFile",
    "ResumeThread",
    "SetHandleInformation",
    "SetInformationJobObject",
    "SetFilePointerEx",
    "TerminateJobObject",
    "TerminateProcess",
    "UpdateProcThreadAttribute",
    "WaitForSingleObject",
    "WriteFile",
  ]),
  "advapi32.dll": Object.freeze([
    "AccessCheck",
    "ConvertSidToStringSidW",
    "ConvertStringSecurityDescriptorToSecurityDescriptorW",
    "DuplicateTokenEx",
    "FreeSid",
    "GetAce",
    "GetAclInformation",
    "GetSecurityDescriptorControl",
    "GetSecurityInfo",
    "GetTokenInformation",
    "MapGenericMask",
    "OpenProcessToken",
  ]),
  "shell32.dll": Object.freeze(["SHGetKnownFolderPath"]),
  "ole32.dll": Object.freeze(["CoTaskMemFree"]),
  "userenv.dll": Object.freeze([
    "CreateAppContainerProfile",
    "DeleteAppContainerProfile",
    "DeriveAppContainerSidFromAppContainerName",
    "GetAppContainerFolderPath",
  ]),
});

/**
 * The allow-list's own size, pinned.
 *
 * Growing the allow-list means changing this number in the same commit, which
 * is the smallest mechanism that makes growth a deliberate, reviewable act
 * rather than a line nobody notices. ADR 0018 section 5 requires no growth
 * without an ADR change; this is what surfaces the growth.
 */
const ALLOW_LISTED_FILE_COUNT = 6;

/**
 * The reviewed native components the allow-list governs.
 *
 * This list used to be the whole story, and that was a finding. `native/`
 * contains five directories; this names three. The other two —
 * `windows-feasibility-probe` and `windows-boundary-fixture` — contain real
 * `DllImport` declarations and, between them, twenty-two occurrences of
 * `CreateProcessW`, `CreateJobObjectW` and `CreateAppContainerProfile`. None of
 * it was scanned by anything, and a NEW component directory would likewise have
 * been invisible: the only structural tie was that the allow-list's keys equalled
 * this array, which ties the list to itself rather than to the filesystem.
 *
 * The carve-out is now explicit and, more importantly, CHECKED against
 * `readdir` — see "every native directory is either governed or deliberately
 * carved out". A directory that is neither fails the suite.
 */
const NATIVE_COMPONENTS = Object.freeze([
  "windows-boundary-fixture",
  "windows-supervisor",
  "windows-helper",
  "windows-proof-controller",
  "windows-proof-installer",
  "windows-runtime",
] as const);

/**
 * Retained investigative tooling, deliberately NOT governed by the allow-list.
 *
 * Both are reviewed source that exists to establish what Windows actually does;
 * neither is shipped, packaged, discovered, or reachable from any production or
 * proof path. They are excluded because they are permitted to contain the very
 * interop the reviewed components must not, and pretending otherwise would mean
 * either deleting the investigation or widening the allow-list to cover code that
 * is not on any authority path.
 *
 * The exclusion is a pinned decision rather than a silent gap: adding a name here
 * is the reviewable act, and the count below has to change with it.
 */
const UNGOVERNED_NATIVE_TOOLING = Object.freeze([
  "windows-feasibility-probe",
] as const);

/**
 * Every directory under `native/`, pinned. A sixth directory appearing without
 * a decision about which of the two lists above it belongs in is exactly the
 * case that previously went unnoticed.
 */
const NATIVE_DIRECTORY_COUNT =
  NATIVE_COMPONENTS.length + UNGOVERNED_NATIVE_TOOLING.length;

/**
 * Removes comments from C# source, keeping string and character literals.
 *
 * The scan below is about CALL SITES, and a call site is code. Scanning raw
 * file text instead would make the allow-list unusable and, worse, dishonest:
 * the reviewed sources discuss `CreateProcessW` and the retained feasibility
 * probe at length in doc comments precisely because ADR 0017 and ADR 0018
 * require them to explain what they do and do not do, and a test that flagged
 * the explanation as the thing it forbids would pressure the next author to
 * delete the explanation. That is a real cost with no security benefit.
 *
 * The cost of stripping is stated too: a call site commented out is invisible
 * to this scan, which is correct, and a call site reached through a token this
 * table does not list is invisible to it as well, which is the limit ADR 0018
 * section 5 records.
 *
 * String literals are deliberately KEPT. A `DllImport` names its library and
 * entry point as string literals, so stripping them would blind the scan to the
 * one thing it most needs to see.
 */
function stripCSharpComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === "//") {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith('@"', index)) {
      let cursor = index + 2;
      while (cursor < source.length) {
        if (source[cursor] === '"') {
          if (source[cursor + 1] === '"') {
            cursor += 2;
            continue;
          }
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      out += source.slice(index, cursor);
      index = cursor;
      continue;
    }
    const character = source[index] as string;
    if (character === '"' || character === "'") {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (source[cursor] === character) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      out += source.slice(index, cursor);
      index = cursor;
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

async function readNativeCode(component: string, name: string): Promise<string> {
  return stripCSharpComments(await readFile(join(packageRoot, "native", component, name), "utf8"));
}

/**
 * Every `.cs` file under a component, RECURSIVELY, excluding build output.
 *
 * The scans used a non-recursive `readdir`, so a `.cs` file one directory down
 * was invisible to the allow-list — a gap with no upside, since nothing about
 * the confinement argument depends on interop living at the top level. Build
 * output is excluded because `obj/` legitimately contains generated code that no
 * reviewer wrote and the csproj already refuses to compile.
 *
 * Returned names are relative to the component directory and use forward slashes,
 * so an allow-list entry for a nested file is spelled the same on every host.
 */
async function nativeSourceFiles(component: string): Promise<string[]> {
  const root = join(packageRoot, "native", component);
  const found: string[] = [];

  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(relative === "" ? root : join(root, relative), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "bin" || entry.name === "obj") continue;
        await walk(child);
        continue;
      }
      if (entry.name.endsWith(".cs")) found.push(child);
    }
  };

  await walk("");
  return found.sort();
}

/**
 * Whole-identifier containment.
 *
 * Plain substring matching produced a false positive on the first run of this
 * suite: the reviewed manifest parser has a private `TryReadFiles` helper, and
 * `ReadFile` is a substring of it, so the durability category appeared in a
 * file that contains no interop at all. A false positive here is not harmless —
 * it is exactly the pressure that gets an allow-list widened until it permits
 * the thing it was written to confine.
 */
function containsIdentifier(text: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const leading = /^[A-Za-z0-9_]/.test(identifier) ? "(?<![A-Za-z0-9_])" : "";
  const trailing = /[A-Za-z0-9_]$/.test(identifier) ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(`${leading}${escaped}${trailing}`).test(text);
}

/**
 * Whole-identifier containment where the identifier is APPLIED — a call or an
 * attribute — rather than merely named.
 *
 * Second false positive of the first run: the supervisor's closed enumeration
 * of the operations it would own has a member called `TerminateJobObject`, and
 * naming an operation is not performing it. Requiring the identifier to be
 * followed by an open parenthesis distinguishes `TerminateJobObject(handle)`
 * from `SupervisorMutatingOperation.TerminateJobObject`, which is precisely the
 * distinction the allow-list is about.
 *
 * Tokens that are not applied that way — a member prefix like `Marshal.`, the
 * `stackalloc` keyword, the `fixed (` statement — are matched literally.
 */
function containsApplication(text: string, token: string): boolean {
  if (token.includes("(") || token.endsWith(".") || token === "stackalloc") {
    return containsIdentifier(text, token);
  }
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}\\s*\\(`).test(text);
}

describe("Stage 17 interop allow-list (ADR 0018 section 5)", () => {
  it("matches whole identifiers, not substrings", () => {
    expect(containsIdentifier("private static bool TryReadFiles(", "ReadFile")).toBe(false);
    expect(containsIdentifier("NativeMethods.ReadFile(handle", "ReadFile")).toBe(true);
    expect(containsIdentifier("MyCreateProcessWrapper()", "CreateProcessW")).toBe(false);
    expect(containsIdentifier("NativeMethods.CreateProcessW(", "CreateProcessW")).toBe(true);
    expect(containsIdentifier("Marshal.AllocHGlobal(4)", "Marshal.")).toBe(true);
    expect(containsIdentifier("var x = 1;", "Marshal.")).toBe(false);
  });

  it("strips comments without losing string literals", () => {
    // The stripper is itself security-relevant: if it removed string literals
    // the import scan would see nothing and pass vacuously, and if it removed
    // nothing the allow-list would flag every doc comment. Both failure modes
    // are checked here rather than assumed.
    const source = [
      '// DllImport("evil.dll", EntryPoint = "Evil")',
      '/* CreateProcessW in a block comment */',
      '[DllImport("ntdll.dll", EntryPoint = "NtCreateFile")]',
      'string slashes = "a//b";',
      'string quoted = "he said \\" and // more";',
      'char c = \'/\';',
    ].join("\n");
    const stripped = stripCSharpComments(source);
    expect(stripped).not.toContain("evil.dll");
    expect(stripped).not.toContain("CreateProcessW");
    expect(stripped).toContain('[DllImport("ntdll.dll", EntryPoint = "NtCreateFile")]');
    expect(stripped).toContain('"a//b"');
    expect(stripped).toContain('"he said \\" and // more"');
  });

  it("pins the allow-list shape so growth cannot be silent", () => {
    let count = 0;
    for (const files of Object.values(INTEROP_ALLOW_LIST)) {
      count += Object.keys(files).length;
    }
    expect(count).toBe(ALLOW_LISTED_FILE_COUNT);
    expect(Object.keys(INTEROP_ALLOW_LIST).sort()).toEqual([...NATIVE_COMPONENTS].sort());

    // Every category named in the allow-list is a category the scanner knows
    // how to detect. A typo would otherwise silently permit nothing and forbid
    // nothing.
    for (const files of Object.values(INTEROP_ALLOW_LIST)) {
      for (const categories of Object.values(files)) {
        for (const category of categories) {
          expect(Object.keys(INTEROP_CATEGORIES)).toContain(category);
        }
      }
    }
  });

  it("every native directory is either governed or deliberately carved out", async () => {
    // The gap this closes: the component list was tied only to the allow-list's
    // own keys, so two directories full of real interop — and any directory added
    // later — were scanned by nothing and flagged by nothing.
    const entries = await readdir(join(packageRoot, "native"), { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

    expect(directories.length).toBe(NATIVE_DIRECTORY_COUNT);
    for (const name of directories) {
      const governed = (NATIVE_COMPONENTS as readonly string[]).includes(name);
      const carvedOut = (UNGOVERNED_NATIVE_TOOLING as readonly string[]).includes(name);
      expect(
        governed || carvedOut,
        `native/${name} is neither an allow-list-governed component nor a pinned carve-out`,
      ).toBe(true);
      // A directory cannot be both, which would make the carve-out silently win.
      expect(governed && carvedOut).toBe(false);
    }
  });

  it("confines every interop category to its allow-listed files", async () => {
    const observed: { file: string; category: string }[] = [];
    for (const component of NATIVE_COMPONENTS) {
      const sources = await nativeSourceFiles(component);
      expect(sources.length).toBeGreaterThan(0);

      for (const name of sources) {
        const text = await readNativeCode(component, name);
        const permitted = INTEROP_ALLOW_LIST[component]?.[name] ?? [];
        for (const [category, tokens] of Object.entries(INTEROP_CATEGORIES)) {
          const present = tokens.some((token) => containsApplication(text, token));
          if (!present) continue;
          observed.push({ file: `${component}/${name}`, category });
          expect(
            permitted,
            `${component}/${name} contains ${category} interop but is not allow-listed for it`,
          ).toContain(category);
        }
      }
    }

    // The allow-list is not merely permissive: the file it names must actually
    // carry the categories it is allowed to carry. An entry for a file that
    // stopped containing interop is stale, and a stale allow-list entry is a
    // pre-authorization for interop nobody reviewed.
    for (const [component, files] of Object.entries(INTEROP_ALLOW_LIST)) {
      for (const [name, categories] of Object.entries(files)) {
        for (const category of categories) {
          expect(
            observed,
            `${component}/${name} is allow-listed for ${category} but does not contain it`,
          ).toContainEqual({ file: `${component}/${name}`, category });
        }
      }
    }
  });

  it("forbids dynamic binding, reflection invocation, process, shell, registry and network APIs everywhere", async () => {
    for (const component of NATIVE_COMPONENTS) {
      const directory = join(packageRoot, "native", component);
      const sources = await nativeSourceFiles(component);
      for (const name of sources) {
        const text = await readNativeCode(component, name);
        const file = `${component}/${name}`;
        const exceptions = FORBIDDEN_EXACT_EXCEPTIONS[file] ?? [];
        for (const forbidden of FORBIDDEN_EVERYWHERE) {
          if (exceptions.includes(forbidden)) continue;
          expect(
            containsIdentifier(text, forbidden),
            `${file} contains ${forbidden}`,
          ).toBe(false);
        }
      }

      // No component may enable pointer syntax, so an interop mistake cannot be
      // expressed as unchecked pointer arithmetic.
      const projects = (await readdir(directory)).filter((name) => name.endsWith(".csproj"));
      expect(projects.length).toBe(1);
      const project = await readFile(join(directory, projects[0] as string), "utf8");
      expect(project).toContain("<AllowUnsafeBlocks>false</AllowUnsafeBlocks>");
      expect(project).toContain("<TreatWarningsAsErrors>true</TreatWarningsAsErrors>");
    }

    // An exception is not a wildcard and cannot go stale. Every named token
    // must still be globally forbidden and must actually occur in its exact
    // reviewed file, otherwise it is latent authorization for future code.
    for (const [file, exceptions] of Object.entries(FORBIDDEN_EXACT_EXCEPTIONS)) {
      const slash = file.indexOf("/");
      const component = file.slice(0, slash);
      const name = file.slice(slash + 1);
      const text = await readNativeCode(component, name);
      for (const exception of exceptions) {
        expect(FORBIDDEN_EVERYWHERE).toContain(exception);
        expect(containsIdentifier(text, exception), `${file} exception ${exception} is stale`).toBe(
          true,
        );
      }
    }
  });

  it("keeps handle-object construction in exactly one place", async () => {
    // A syntactic property, which is the kind a text scan can actually decide.
    //
    // The ancestor chain that justifies the whole handle-based design was
    // vacuous in the real adapter because each implementation built its own
    // `OpenedObject` and the adapter passed `null` for every parent. The fix
    // moved construction into the shared base class, and this is what keeps it
    // there: one construction site, in the file that declares the contract.
    // A second site anywhere is an implementation being asked a question it has
    // already been shown to answer wrongly.
    const sites: string[] = [];
    for (const component of NATIVE_COMPONENTS) {
      for (const name of await nativeSourceFiles(component)) {
        const text = await readNativeCode(component, name);
        const count = text.match(/new\s+OpenedObject\s*\(/g)?.length ?? 0;
        for (let index = 0; index < count; index += 1) sites.push(`${component}/${name}`);
      }
    }
    expect(sites).toEqual(["windows-proof-installer/HandleRelativeContract.cs"]);
  });

  it("passes every information class by name, never as a bare number", async () => {
    // A syntactic pin, closing the gap that let one call site escape the vectors
    // which pin these ordinals.
    //
    // The conformance suite compares each information-class CONSTANT against the
    // SDK value, which is what caught two ordinals from the wrong enum family. It
    // governs the constants, not the call sites — and one call site in `QueryFacts`
    // passed the raw literal `1`, so the pin did not reach it. Requiring a name at
    // every call site is what makes the vectors cover all of them.
    const text = await readNativeCode("windows-proof-installer", "NativeFileSystem.cs");

    // The scan is only meaningful if it finds the call sites at all, so the
    // occurrence count is asserted before anything is concluded from it. One of
    // these is the DllImport declaration; the rest are calls.
    const occurrences = text.match(/GetFileInformationByHandleEx/g)?.length ?? 0;
    expect(occurrences).toBeGreaterThan(1);

    // A bare number in the second argument position. `[^)]*` spans newlines,
    // which matters because these calls are written one argument per line.
    const bareNumber = /GetFileInformationByHandleEx\s*\(\s*[^),]*,\s*\d+\s*,/;
    expect(
      bareNumber.test(text),
      "GetFileInformationByHandleEx is called with a bare numeric information class; use a named constant so the pinned ordinal vectors govern that call site",
    ).toBe(false);
  });

  it("keeps the elevation query distinguishable from a non-elevated token", async () => {
    // A source-level pin, and honestly labelled as one: the token path needs a
    // real elevated process to execute, so no vector in this repository can run
    // it. What is checkable is the SHAPE that produced the finding — a helper
    // that returned `false` both for "not elevated" and for "could not tell",
    // whose failure mode was an elevated token labelled `standard-user` and an
    // AccessCheck that then passed against the wrong principal.
    const text = await readNativeCode("windows-proof-installer", "NativeFileSystem.cs");

    // The collapsing form must not come back.
    expect(text).not.toMatch(/static\s+bool\s+ReadTokenElevation\s*\(/);

    // The try-form must exist and be consulted twice: once for the process
    // token to decide which branch to take, and once for the DUPLICATE, so the
    // recorded label is a reading of the token that will actually be checked
    // rather than an assumption of the branch that produced it.
    expect(text).toMatch(/static\s+bool\s+TryReadTokenElevation\s*\(/);
    expect(text.match(/TryReadTokenElevation\s*\(/g)?.length ?? 0).toBe(3);

    // "standard-user" is assigned in exactly one place, after that second read.
    expect(text.match(/standardTokenKind\s*=\s*"standard-user"/g)?.length ?? 0).toBe(1);
  });

  it("pins the exact imported libraries and entry points", async () => {
    const imports = new Map<string, Set<string>>();
    for (const [component, files] of Object.entries(INTEROP_ALLOW_LIST)) {
      for (const name of Object.keys(files)) {
        const text = await readNativeCode(component, name);
        // Multi-line DllImport attributes are the normal shape here, so the
        // scan is deliberately multi-line rather than per-line.
        const pattern = /DllImport\(\s*"([^"]+)"[\s\S]*?EntryPoint\s*=\s*"([^"]+)"/g;
        let match = pattern.exec(text);
        while (match !== null) {
          const library = (match[1] as string).toLowerCase();
          if (!imports.has(library)) imports.set(library, new Set());
          (imports.get(library) as Set<string>).add(match[2] as string);
          match = pattern.exec(text);
        }

        // Every import must name its entry point explicitly. An import without
        // one resolves by method name, which makes a rename silently change
        // which native function is called.
        const declarations = text.match(/DllImport\(/g)?.length ?? 0;
        const withEntryPoints = text.match(/EntryPoint\s*=\s*"/g)?.length ?? 0;
        expect(withEntryPoints).toBe(declarations);

        // ExactSpelling stops the marshaller silently probing for an A/W
        // suffixed variant of a name that does not exist.
        const exactSpellings = text.match(/ExactSpelling\s*=\s*true/g)?.length ?? 0;
        expect(exactSpellings).toBe(declarations);
      }
    }

    const observed: Record<string, string[]> = {};
    for (const [library, entries] of imports) {
      observed[library] = [...entries].sort();
    }
    const expected: Record<string, string[]> = {};
    for (const [library, entries] of Object.entries(PERMITTED_IMPORTS)) {
      expected[library] = [...entries].sort();
    }
    expect(observed).toEqual(expected);
  });

  it("has no process-creation call site anywhere in the reviewed components", async () => {
    // ADR 0018 section 3 introduces exactly three reviewed creation sites. None
    // of them exists yet, and this test is what will notice the moment one
    // appears without the allow-list being extended in the same change.
    for (const component of NATIVE_COMPONENTS) {
      const sources = await nativeSourceFiles(component);
      for (const name of sources) {
        const text = await readNativeCode(component, name);
        for (const token of INTEROP_CATEGORIES["create-process-w"] as readonly string[]) {
          const permitted =
            (INTEROP_ALLOW_LIST[component]?.[name] ?? []).includes("create-process-w");
          if (!permitted) {
            expect(
              containsApplication(text, token),
              `${component}/${name} contains ${token}`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it("refuses a proof-mode binary at production discovery", () => {
    const sealed = {
      component: "windows-supervisor",
      describeBuildFlavor: "sealed",
      selfTestBuildFlavor: "sealed",
      describeProofModeCompiledIn: false,
      selfTestProofModeCompiledIn: false,
    };
    expect(admitWindowsArtifactBuildFlavor(sealed)).toMatchObject({
      admitted: true,
      buildFlavor: "sealed",
    });

    // The whole point of ADR 0018 section 4: a reviewed-proof binary is a
    // different set of bytes, evidence about it is not evidence about the
    // sealed artifact, and production must never accept it.
    expect(
      admitWindowsArtifactBuildFlavor({
        ...sealed,
        describeBuildFlavor: "reviewed-proof-mode",
        selfTestBuildFlavor: "reviewed-proof-mode",
        describeProofModeCompiledIn: true,
        selfTestProofModeCompiledIn: true,
      }),
    ).toMatchObject({ admitted: false, code: "artifact-build-flavor-not-sealed" });

    // A binary that reports "sealed" from one command and the truth from the
    // other is worse than either answer on its own.
    expect(
      admitWindowsArtifactBuildFlavor({ ...sealed, selfTestBuildFlavor: "reviewed-proof-mode" }),
    ).toMatchObject({ admitted: false, code: "artifact-gate-inconsistent" });
    expect(
      admitWindowsArtifactBuildFlavor({ ...sealed, selfTestProofModeCompiledIn: true }),
    ).toMatchObject({ admitted: false, code: "artifact-gate-inconsistent" });

    // A gate nobody downstream can read is not an enforceable gate.
    expect(
      admitWindowsArtifactBuildFlavor({ ...sealed, describeBuildFlavor: undefined }),
    ).toMatchObject({ admitted: false, code: "artifact-gate-unobservable" });
    expect(
      admitWindowsArtifactBuildFlavor({ ...sealed, describeProofModeCompiledIn: "false" }),
    ).toMatchObject({ admitted: false, code: "artifact-gate-unobservable" });
    expect(admitWindowsArtifactBuildFlavor({ ...sealed, component: "" })).toMatchObject({
      admitted: false,
      code: "artifact-gate-unobservable",
    });
  });

  it("refuses the proof installer at production discovery even when sealed", () => {
    // A sealed proof-installer is still a proof component. Flavour and purpose
    // are separate facts and both have to hold.
    expect(
      admitWindowsArtifactBuildFlavor({
        component: "windows-proof-installer",
        describeBuildFlavor: "sealed",
        selfTestBuildFlavor: "sealed",
        describeProofModeCompiledIn: false,
        selfTestProofModeCompiledIn: false,
      }),
    ).toMatchObject({ admitted: false, code: "artifact-component-is-proof-only" });

    expect([...PROOF_ONLY_COMPONENTS]).toEqual([
      "windows-proof-controller",
      "windows-proof-installer",
    ]);
    for (const component of PROOF_ONLY_COMPONENTS) {
      expect([...WINDOWS_ARTIFACT_COMPONENTS]).not.toContain(component);
    }
  });

  it("keeps the proof installer out of the pinned table and the npm inventory", async () => {
    expect(PINNED_WINDOWS_BUNDLE_FINGERPRINTS.length).toBe(0);
    for (const pinned of PINNED_WINDOWS_BUNDLE_FINGERPRINTS) {
      expect(PROOF_ONLY_COMPONENTS).not.toContain((pinned as { component: string }).component);
    }

    const manifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    ) as { readonly files: readonly string[] };
    // `files` is dist + README, so `native/` is not packed at all and no
    // exclusion rule has to be remembered per component.
    expect([...manifest.files].sort()).toEqual(["README.md", "dist"]);
    expect(JSON.stringify(manifest)).not.toContain("windows-proof-installer");
  });

  it("keeps retained feasibility source off production component paths", async () => {
    // ADR 0017 section 10.3: no reviewed component may DEPEND on the
    // feasibility probe or the boundary fixture.
    //
    // "Depend on" is the claim and it is narrower than "mention". Both names
    // appear as string literals in the conformance suites, where they are
    // negative test data: a component name manifest verification must refuse,
    // and a bundle directory path resolution must not accept. Forbidding the
    // literal would forbid testing the refusal, which is the wrong trade. What
    // is actually forbidden is a project reference, a namespace import, or a
    // type from either assembly.
    const productionComponents = [
      "windows-boundary-fixture",
      "windows-helper",
      "windows-runtime",
      "windows-supervisor",
    ] as const;
    for (const component of productionComponents) {
      const directory = join(packageRoot, "native", component);
      const names = await readdir(directory);

      for (const name of names.filter((entry) => entry.endsWith(".csproj"))) {
        const project = await readFile(join(directory, name), "utf8");
        expect(project).not.toContain("ProjectReference");
        expect(project).not.toContain("windows-feasibility-probe");
        expect(project).not.toContain("windows-boundary-fixture");
      }

      for (const name of names.filter((entry) => entry.endsWith(".cs"))) {
        const text = await readNativeCode(component, name);
        expect(text).not.toContain("using AiDevOs.WindowsSandboxFeasibilityProbe;");
        expect(text).not.toContain("using AiDevOs.WindowsBoundaryFixture;");
        expect(text).not.toContain("AppContainerSyntheticProcessProof");
        expect(text).not.toContain("AppContainerProfileLifecycleProof");

        // Every non-System import is an exact reviewed BCL or internal runtime
        // namespace; proof-tool namespaces remain forbidden.
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          // A namespace import is `using X.Y.Z;` and nothing else. A using
          // DECLARATION (`using Type name = expr;`) and a using STATEMENT
          // (`using (...)`) are scoped-disposal syntax, not imports, and
          // treating them as imports made this assertion fire on ordinary code.
          if (
            !/^using [A-Za-z_][A-Za-z0-9_.]*;$/.test(trimmed) ||
            trimmed.startsWith("using System")
          ) {
            continue;
          }
          const allowed = new Set([
            "using AiDevOs.WindowsRuntime;",
            "using Microsoft.Win32;",
            "using Microsoft.Win32.SafeHandles;",
          ]);
          expect(allowed, `${component}/${name} imports a non-System namespace`).toContain(
            trimmed,
          );
        }
      }
    }

    // The proof-only controller deliberately reuses the retained native proof
    // primitives. Its exact three links are pinned and the component is barred
    // from production discovery and npm packaging above.
    const controllerProject = await readFile(
      join(
        packageRoot,
        "native",
        "windows-proof-controller",
        "AI.DevOS.WindowsProofController.csproj",
      ),
      "utf8",
    );
    expect(controllerProject.match(/windows-feasibility-probe\//g)?.length ?? 0).toBe(3);
    expect(controllerProject).toContain("SyntheticProcessProof.cs");
    expect(controllerProject).toContain("StructuredBoundaryProof.cs");
    expect(controllerProject).toContain("HelperLifecycleProof.cs");
  });

  it("pins the production runtime worker to the reviewed compile-time projection", async () => {
    const evaluate = (expression: string): boolean => {
      const value = (name: string): boolean =>
        name === "AIDEVOS_STAGE17_RUNTIME_WORKER" ||
        name === "AIDEVOS_STAGE17_RUNTIME_NAMES";
      return expression.split("||").some((alternative) =>
        alternative
          .split("&&")
          .map((term) => term.trim())
          .every((term) => (term.startsWith("!") ? !value(term.slice(1)) : value(term))),
      );
    };
    const projectRuntime = (source: string, addImportPolicy: boolean): string => {
      const output: string[] = [];
      const stack: { readonly parent: boolean; readonly condition: boolean }[] = [];
      let enabled = true;
      for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
        const directive = line.trim();
        if (directive.startsWith("#if ")) {
          const condition = evaluate(directive.slice(4));
          stack.push({ parent: enabled, condition });
          enabled = enabled && condition;
        } else if (directive === "#else") {
          const branch = stack.at(-1);
          if (branch === undefined) throw new Error("unbalanced runtime projection");
          enabled = branch.parent && !branch.condition;
        } else if (directive === "#endif") {
          const branch = stack.pop();
          if (branch === undefined) throw new Error("unbalanced runtime projection");
          enabled = branch.parent;
        } else if (enabled) {
          output.push(line);
        }
      }
      if (stack.length !== 0) throw new Error("unbalanced runtime projection");
      let projected = output
        .join("\n")
        .replace(
          "namespace AiDevOs.WindowsSandboxFeasibilityProbe;",
          "namespace AiDevOs.WindowsRuntime;",
        )
        .replaceAll("AppContainerSyntheticProcessProof", "WindowsRuntimeBoundary");
      if (addImportPolicy) {
        projected = projected.replace(
          "using Microsoft.Win32;\n",
          "using Microsoft.Win32;\n\n" +
            "[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]\n",
        );
      }
      return projected.trimEnd();
    };

    const pairs = [
      ["SyntheticProcessProof.cs", "RuntimeNativePrimitives.cs", true],
      ["HelperLifecycleProof.cs", "RuntimeLifecycleWorker.cs", false],
    ] as const;
    for (const [proofName, runtimeName, addImportPolicy] of pairs) {
      const proof = await readFile(
        join(packageRoot, "native", "windows-feasibility-probe", proofName),
        "utf8",
      );
      const runtime = await readFile(
        join(packageRoot, "native", "windows-runtime", runtimeName),
        "utf8",
      );
      expect(runtime.replace(/\r\n/g, "\n").trimEnd()).toBe(
        projectRuntime(proof, addImportPolicy),
      );
      expect(runtime).not.toContain("#if");
      expect(runtime).not.toContain("AIDEVOS_STAGE17_REVIEWED_PROOF_MODE");
      expect(runtime).not.toContain("AiDevOs.WindowsSandboxFeasibilityProbe");
    }
  });

  it("pins the body-free provider canary to exact endpoints and an installed supervisor", async () => {
    const supervisor = await readNativeCode("windows-supervisor", "RoleRuntime.cs");
    const controller = await readNativeCode("windows-proof-controller", "Stage17WProof.cs");
    const expectedEndpoints = [
      "https://api.anthropic.com/v1/models",
      "https://api.openai.com/v1/models",
    ];
    const endpoints = (source: string): string[] =>
      [...source.matchAll(/https:\/\/api\.(?:anthropic|openai)\.com\/v1\/models/g)]
        .map((match) => match[0])
        .sort();

    expect(endpoints(supervisor)).toEqual(expectedEndpoints);
    expect(endpoints(controller)).toEqual(expectedEndpoints);
    expect(
      supervisor.match(/RuntimeClosureLease\.AcquireFromCurrentImage\(SupervisorImageName\)/g)
        ?.length ?? 0,
    ).toBe(3);
    expect(supervisor).toContain("AllowAutoRedirect = false");
    expect(supervisor).toContain("UseProxy = false");
    expect(supervisor).toContain("UseCookies = false");
    expect(supervisor).toContain("Credentials = null");
    expect(supervisor).toContain("DefaultRequestVersion = HttpVersion.Version20");
    expect(supervisor).toContain("HttpVersionPolicy.RequestVersionOrLower");
    expect(supervisor).toContain("HttpCompletionOption.ResponseHeadersRead");
    expect(supervisor).toContain("new HttpRequestMessage(HttpMethod.Get, endpoint)");
    expect(supervisor).toContain("requestBodyBytes = 0");
    expect(supervisor).not.toContain("Authorization");
    expect(supervisor).not.toContain("HttpVersion.Version30");
    expect(controller).toContain("ExpectedStage17WEgressFingerprint(expectedProvider)");
    expect(controller).toContain('substitutedEgress.Status == "failed"');
  });

  it("binds every lifecycle and recovery token to the installed closure token", async () => {
    const closure = await readNativeCode("windows-runtime", "RuntimeClosureLease.cs");
    const worker = await readNativeCode("windows-runtime", "RuntimeLifecycleWorker.cs");
    const helper = await readNativeCode("windows-helper", "RoleRuntime.cs");
    const supervisor = await readNativeCode("windows-supervisor", "RoleRuntime.cs");
    const controller = await readNativeCode("windows-proof-controller", "Stage17WProof.cs");

    expect(closure).toContain("internal static string DeriveScenarioToken");
    expect(closure).toContain('"ai-dev-os/stage17w/scenario/v1/');
    expect(controller).toContain("RuntimeClosureLease.DeriveScenarioToken(runToken, index)");
    expect(worker).toContain("IsInstalledRuntimeScenarioToken(installedRunToken, validatedRequest)");
    expect(worker).toContain("RuntimeClosureLease.DeriveScenarioToken(installedRunToken, index)");
    expect(helper).toContain("closure.RunToken");
    expect(supervisor).toContain("RuntimeClosureLease.DeriveScenarioToken(runToken, scenarioIndex)");
    expect(supervisor).toContain("IsAuthorizedScenarioToken(closure.RunToken, token)");
    expect(supervisor).toContain("!TryParseRequest(");
    expect(supervisor).toContain("mismatchedScenario");
  });

  it("requires the proof controller to pin the measured installed source envelope", async () => {
    const closure = await readNativeCode("windows-runtime", "RuntimeClosureLease.cs");
    const controller = await readNativeCode("windows-proof-controller", "Stage17WProof.cs");
    const installer = await readNativeCode("windows-proof-installer", "ProofConfiguration.cs");
    const match = controller.match(
      /Stage17WRuntimeSourceEnvelopeFingerprint\s*=\s*\n?\s*"([a-f0-9]{64})"/,
    );

    expect(match).not.toBeNull();
    const fingerprint = match?.[1] ?? "";
    expect(installer).toContain(`"${fingerprint}"`);
    expect(closure).toContain("SourceEnvelopeFingerprint(parsed)");
    expect(closure).toContain("internal static bool RunReadOnlySelfTest()");
    expect(closure).toContain("d804d19ca6e350c7684f17a67aa14a56ef1ca1377b175eec33f1514d045edad7");
    expect(closure).toContain('"installed-source-envelope-unreviewed"');
    expect(closure).toContain('writer.WriteString("buildFlavor", "sealed")');
    expect(closure).toContain('writer.WriteString("bundleVersion", "1.0.0")');
    expect(closure).toContain('writer.WriteString("component", "windows-stage17-runtime")');
    expect(closure).toContain('writer.WriteNumber("schemaVersion", 1)');
    expect(
      controller.match(/Stage17WRuntimeSourceEnvelopeFingerprint\);/g)?.length ?? 0,
    ).toBe(2);
  });

  it("includes every linked compilation input in the packaging source envelope", async () => {
    const script = await readFile(
      join(packageRoot, "scripts", "build-windows-artifacts.mjs"),
      "utf8",
    );
    const occurrences = (value: string): number => script.split(value).length - 1;

    expect(occurrences("linkedSources:")).toBe(4);
    expect(occurrences('"../windows-runtime/RuntimeClosureLease.cs"')).toBe(3);
    expect(occurrences('"../windows-runtime/RuntimeNativePrimitives.cs"')).toBe(1);
    expect(occurrences('"../windows-runtime/RuntimeLifecycleWorker.cs"')).toBe(1);
    expect(occurrences('"../windows-feasibility-probe/SyntheticProcessProof.cs"')).toBe(1);
    expect(occurrences('"../windows-feasibility-probe/StructuredBoundaryProof.cs"')).toBe(1);
    expect(occurrences('"../windows-feasibility-probe/HelperLifecycleProof.cs"')).toBe(1);
    expect(script).toContain("for (const name of entry.linkedSources)");
    expect(script).toContain("relative(nativeRoot, path)");
    expect(script).toContain("duplicate source-envelope name");
  });
});

// ------------------------------------------------------- audit regressions

describe("Stage 17 audit regressions (non-enforcement)", () => {
  it("F-001: measures artifact digests as a single SHA-256 of the file bytes", async () => {
    // The manifest fixture pins plain SHA-256 of the content, not a digest of
    // a digest. The C# deny-write stream path used to hash twice, which would
    // have rejected every genuine file of every genuine bundle; the shared
    // `manifest/digest-source-parity` vector now fails if the two sources
    // disagree, and this test pins the convention on the TypeScript side.
    const files = fixtureManifest.files;
    expect(files[0]?.sha256).toBe(sha256("123"));
    expect(files[1]?.sha256).toBe(sha256("1234"));

    // End to end: a bundle whose manifest carries plain SHA-256 verifies, and
    // one carrying a double digest does not.
    const root = await taskOwnedRoot("digest-convention");
    await installed(root, "windows-supervisor", "1.0.0");
    const good = await verifyWindowsInstalledBundle({
      root,
      component: "windows-supervisor",
      bundleVersion: "1.0.0",
    });
    expect(good.verified).toBe(true);

    const doubled = syntheticBundle({ component: "windows-helper", bundleVersion: "1.0.0" });
    const manifest = doubled.manifest as Record<string, unknown>;
    manifest["files"] = (manifest["files"] as { name: string; size: number; sha256: string }[]).map(
      (entry) => ({ ...entry, sha256: createHash("sha256").update(Buffer.from(entry.sha256, "hex")).digest("hex") }),
    );
    const stagingDir = await stage(root, doubled, "doubled");
    const result = await installWindowsBundle({
      root,
      component: "windows-helper",
      bundleVersion: "1.0.0",
      stagingDir,
    });
    expect(result.installed).toBe(false);
    expect(result.code).toBe("artifact-file-digest-mismatch");
  });

  it("F-003(a): refuses a recovery record naming a component that does not exist", () => {
    const valid: WindowsRecoveryRecord = {
      component: "windows-supervisor",
      operationToken: TOKEN,
      phase: "request-accepted",
      sequence: 1,
      bundleVersion: "1.0.0",
    };
    const canonical = canonicalWindowsRecoveryRecord(valid).replace(
      '"component":"windows-supervisor"',
      '"component":"windows-probe"',
    );
    const bytes = new TextEncoder().encode(canonical);
    const digest = windowsRecoveryRecordDigest(bytes);
    const framed = new Uint8Array(4 + bytes.length + digest.length);
    new DataView(framed.buffer).setUint32(0, bytes.length, true);
    framed.set(bytes, 4);
    framed.set(digest, 4 + bytes.length);
    const result = readWindowsRecoveryJournal(framed, TOKEN);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe("recovery-record-schema-invalid");

    // Both real components remain acceptable.
    for (const component of WINDOWS_ARTIFACT_COMPONENTS) {
      const accepted = readWindowsRecoveryJournal(
        frameWindowsRecoveryRecord({ ...valid, component }),
        TOKEN,
      );
      expect(accepted.ok).toBe(true);
    }
  });

  it("F-004: refuses a DOS 8.3 short-name alias in any path segment", async () => {
    const root = await taskOwnedRoot("shortname");
    await mkdir(join(root, "windows-supervisor"), { recursive: true });
    for (const segment of ["RUNTIM~1", "PROGRA~2", "a~b", "~"]) {
      expect(await checkWindowsArtifactPath(root, join(root, segment))).toBe(
        "artifact-path-normalization-ambiguous",
      );
    }
    // Nested, not just leaf.
    expect(await checkWindowsArtifactPath(root, join(root, "windows-supervisor", "1~0", "win-x64"))).toBe(
      "artifact-path-normalization-ambiguous",
    );
    // The real layout still resolves.
    expect(
      await checkWindowsArtifactPath(root, join(root, "windows-supervisor", "1.0.0", "win-x64")),
    ).toBeNull();
  });

  it("F-005: names the read-only self-test exception in the limitation code", () => {
    expect([...WINDOWS_ARTIFACT_LIMITATION_CODES]).toContain(
      "artifact-never-executed-beyond-read-only-self-test",
    );
    expect([...WINDOWS_ARTIFACT_LIMITATION_CODES]).not.toContain("artifact-never-executed");
    expect([...WINDOWS_ARTIFACT_LIMITATION_CODES]).toEqual(
      [...WINDOWS_ARTIFACT_LIMITATION_CODES].sort(),
    );
    expect([...fixtureManifest.limitations]).toContain(
      "artifact-never-executed-beyond-read-only-self-test",
    );
  });

  it("F-006: pins the manifest fixture fingerprint against an independent constant", () => {
    // The C# suite pins the same literal, so neither implementation can move
    // alone. A vector that compared a value with itself, as the previous
    // `manifest/fingerprint-stable` did, could never have caught this.
    expect(WINDOWS_COMPONENT_CONFORMANCE.manifestFixtureFingerprint).toBe(
      "c39961a4a6946201758403a86fe25795c89e70f607a1c6e3642c292419663054",
    );
    expect(windowsArtifactManifestFingerprint(fixtureManifest)).toBe(
      WINDOWS_COMPONENT_CONFORMANCE.manifestFixtureFingerprint,
    );
  });
});

// ------------------------------------------------------- availability truth

describe("Stage 17 packaging changes no availability truth", () => {
  it("keeps the Windows backend unavailable with its stable detail", async () => {
    const backend = createWindowsSandboxBackend({ platform: "win32" });
    const descriptor = backend.describe();
    expect(descriptor.securityClass).toBe("unavailable");
    expect(descriptor.capabilities.filesystemIsolation).toBe(false);
    expect(descriptor.capabilities.processTreeControl).toBe(false);
    expect(descriptor.capabilities.identityIsolation).toBe(false);
    expect(descriptor.capabilities.profileIsolation).toBe(false);
    expect(descriptor.capabilities.networkBoundary).toBe("unsupported");
    for (const dimension of QUOTA_DIMENSIONS) {
      expect(descriptor.capabilities.quotas[dimension]).toBe("unsupported");
    }

    const probe = await backend.probe();
    expect(probe.available).toBe(false);
    expect(probe.reason).toBe("not-implemented");
    expect(probe.detail).toBe("windows-native-process-composition-and-corpus-unverified");

    const grant = backend.validateGrant({} as never);
    expect(grant.available).toBe(false);
    expect(grant.detail).toBe("windows-native-process-composition-and-corpus-unverified");
  });

  it("keeps production prepare() unreachable", async () => {
    const backend = createWindowsSandboxBackend({ platform: "win32" });
    await expect(backend.prepare({} as never)).rejects.toMatchObject({
      code: "BACKEND_UNAVAILABLE",
    });
    await expect(backend.spawn({} as never)).rejects.toMatchObject({
      code: "BACKEND_UNAVAILABLE",
    });
  });

  it("keeps the registration and receipt issuers unreachable from every public surface", () => {
    const forbidden = [
      "issueProductionBackendRegistration",
      "issueProductionSessionReceipt",
      "invalidateProductionBackendRegistration",
      "verifyProductionBackendRegistration",
      "verifyAndConsumeProductionSessionReceipt",
    ];
    for (const name of forbidden) {
      expect(Object.keys(publicSurface)).not.toContain(name);
      expect(Object.keys(testingSurface)).not.toContain(name);
    }
    // The artifact installer and the recovery-journal reader are likewise not
    // reachable through the package export map.
    for (const name of ["installWindowsBundle", "removeWindowsBundle", "readWindowsRecoveryJournal"]) {
      expect(Object.keys(publicSurface)).not.toContain(name);
    }
  });

  it("keeps the packed npm inventory free of native sources and scripts", async () => {
    const manifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    ) as { readonly files: readonly string[]; readonly exports: Record<string, unknown> };
    expect([...manifest.files].sort()).toEqual(["README.md", "dist"]);
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./testing"]);
    expect(JSON.stringify(manifest.exports)).not.toContain("windows-artifact-install");
    expect(JSON.stringify(manifest.exports)).not.toContain("trusted-evidence");
  });

  it("keeps the Windows escape-corpus state at 0 of 40 and not-run", () => {
    expect(secureBackendEscapeVectorCount("win32")).toBe(40);
    expect(SECURE_BACKEND_ESCAPE_CORPUS_VERSION).toBe(1);
    expect(SECURE_BACKEND_ESCAPE_CORPUS_FINGERPRINT).toBe(
      "125b809194d26cf1be518249b96727b78be80c25088826464ec94154a6fb3652",
    );
    // A packaged, verified, deterministic bundle still binds the same corpus
    // identity and still proves nothing about it.
    expect(fixtureManifest.windowsApplicableVectorCount).toBe(40);
    expect(fixtureManifest.corpusFingerprint).toBe(SECURE_BACKEND_ESCAPE_CORPUS_FINGERPRINT);
    expect(fixtureManifest.productionEligible).toBe(false);
  });

  it("never lets unsafe development execution become a production fallback", async () => {
    const root = await taskOwnedRoot("fallback");
    await installed(root, "windows-supervisor", "1.0.0");
    const verified = await verifyWindowsInstalledBundle({
      root,
      component: "windows-supervisor",
      bundleVersion: "1.0.0",
    });
    expect(verified.verified).toBe(true);
    // A fully verified bundle still leaves discovery refusing and the Windows
    // backend unavailable: there is no path from "packaged" to "permitted".
    expect(discoverWindowsArtifactBundle({ component: "windows-supervisor" }).discovered).toBe(
      false,
    );
    const backend = createWindowsSandboxBackend({ platform: "win32" });
    expect(backend.describe().securityClass).toBe("unavailable");
    expect((await backend.probe()).available).toBe(false);
  });

  it("moves a rename-based rollback without leaving a mutable alias", async () => {
    const root = await taskOwnedRoot("rollback");
    await installed(root, "windows-supervisor", "1.0.0");
    await installed(root, "windows-supervisor", "1.1.0");
    const layout = windowsInstallLayout(root, "windows-supervisor", "1.1.0");
    // Simulated operator error: renaming a version directory is not a supported
    // rollback mechanism, and the renamed bundle no longer verifies.
    await rename(layout.versionDir, join(root, "windows-supervisor", "1.2.0"));
    const result = await verifyWindowsInstalledBundle({
      root,
      component: "windows-supervisor",
      bundleVersion: "1.2.0",
    });
    expect(result.verified).toBe(false);
    expect(result.verified ? null : result.code).toBe("artifact-manifest-stale");
  });
});
