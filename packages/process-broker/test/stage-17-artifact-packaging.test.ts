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
    expect(WINDOWS_COMPONENT_CONFORMANCE.coreVectorCount).toBe(161);
    expect(WINDOWS_COMPONENT_CONFORMANCE.coreConformanceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(WINDOWS_COMPONENT_CONFORMANCE.roles["windows-supervisor"].vectorCount).toBe(27);
    expect(WINDOWS_COMPONENT_CONFORMANCE.roles["windows-helper"].vectorCount).toBe(53);
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

  it("keeps the two native components structurally read-only in source", async () => {
    for (const component of ["windows-supervisor", "windows-helper"]) {
      const directory = join(packageRoot, "native", component);
      const names = await readdir(directory);
      const sources = names.filter((name) => name.endsWith(".cs"));
      expect(sources.length).toBeGreaterThan(0);
      let combined = "";
      for (const name of sources) {
        combined += await readFile(join(directory, name), "utf8");
      }
      // The mutation gate is a compile-time false constant, and nothing in the
      // components starts a process, opens a shell, reads the environment, or
      // downloads anything.
      expect(combined).toContain("private const bool MutatingOperationsEnabled = false;");
      for (const forbidden of [
        "Process.Start",
        "ProcessStartInfo",
        "DllImport",
        "Environment.GetEnvironmentVariable",
        "Registry",
        "HttpClient",
        "WebClient",
        "Directory.CreateDirectory",
        "File.WriteAllText",
        "File.Delete",
        "Directory.Delete",
      ]) {
        expect(combined).not.toContain(forbidden);
      }
    }
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
