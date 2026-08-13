#!/usr/bin/env node
/**
 * Deterministic packaging pipeline for the Windows production supervisor and
 * helper candidates (ADR 0017 section 6).
 *
 * What it does, in order:
 *
 *   1. checks that the two shared protocol cores have not drifted apart;
 *   2. publishes each component twice, into separate intermediate and output
 *      directories;
 *   3. compares the entire invoked closure byte for byte between the two
 *      builds and records every file name, size, and SHA-256;
 *   4. rejects debug symbols, source files, caches, temporary files,
 *      unexpected files, reparse points, and duplicate entries;
 *   5. runs each component's read-only `self-test` and `describe-artifact`
 *      and cross-checks them against the manifest and against the TypeScript
 *      implementation of canonical manifest identity;
 *   6. emits a canonical artifact manifest per component and a deterministic
 *      manifest fingerprint; and
 *   7. simulates an installed package: exact placement, verification against a
 *      pinned fingerprint, refusal to overwrite, refusal to remove an active
 *      version, exact removal, and a residue scan.
 *
 * What it never does: sign anything, publish anything, install anything
 * outside its task-owned output directory, download a runtime, write into the
 * repository, or represent unsigned output as production eligible. Everything
 * it produces is `unsigned-candidate` and `productionEligible: false`, and
 * nothing it reports can change Windows availability, the capability matrix,
 * the quota matrix, or the 0/40 `not-run` Windows corpus state.
 *
 * Usage:
 *   node scripts/build-windows-artifacts.mjs --out <absolute-task-owned-dir>
 *
 * The output directory must be absolute and must not be inside the repository.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const repoRoot = resolve(packageRoot, "..", "..");
const nativeRoot = join(packageRoot, "native");

const BUILD_RECIPE_VERSION = 1;
const BUNDLE_VERSION = "1.0.0";
const SOURCE_VERSION = "1.0.0";
const PROTOCOL_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 1;
const RID = "win-x64";
const PLATFORM = "win32";
const ARCHITECTURE = "x64";
const MANIFEST_FILE_NAME = "artifact-manifest.json";

/**
 * ADR 0018 section 4: the reviewed-proof build constant.
 *
 * Passing it produces a binary that reports `reviewed-proof-mode` from both
 * read-only commands, has a different conformance digest, and is a different
 * set of bytes. It is never the default and it cannot be produced by accident:
 * it requires `--flavor reviewed-proof` on the command line.
 *
 * `--flavor` applies ONLY to the proof-only component. Every production-shaped
 * component is built sealed regardless of it, which is enforced in
 * `flavorFor(entry)` and asserted per component further down.
 *
 * That is a correction. This comment previously said the pipeline "refuses to
 * emit a production-shaped manifest for" a proof build, and it did no such
 * thing: `--flavor` was applied to every component, and the manifest — carrying
 * `manifestKind: "…production-artifact-manifest"` and no flavour field at all —
 * was written before any flavour assertion ran. The stated behaviour is now the
 * implemented behaviour, which is the honest direction to resolve that in: a
 * production-shaped binary has no legitimate reason to exist in proof mode.
 *
 * Note also what `--flavor reviewed-proof` still does NOT confer. The environment
 * cannot supply this constant — the csproj neutralises `DefineConstants`, proved
 * by building with it set and observing a sealed binary — and a reviewed-proof
 * binary is refused at production discovery by component identity as well as by
 * flavour.
 */
const REVIEWED_PROOF_CONSTANT = "AIDEVOS_STAGE17_REVIEWED_PROOF_MODE";
const SEALED_FLAVOR = "sealed";
const PROOF_FLAVOR = "reviewed-proof-mode";

const COMPONENTS = [
  {
    component: "windows-supervisor",
    directory: join(nativeRoot, "windows-supervisor"),
    project: join(nativeRoot, "windows-supervisor", "AI.DevOS.WindowsSupervisor.csproj"),
    executable: "AI.DevOS.WindowsSupervisor.exe",
    productionShaped: true,
    linkedSources: ["../windows-runtime/RuntimeClosureLease.cs"],
  },
  {
    component: "windows-helper",
    directory: join(nativeRoot, "windows-helper"),
    project: join(nativeRoot, "windows-helper", "AI.DevOS.WindowsHelper.csproj"),
    executable: "AI.DevOS.WindowsHelper.exe",
    productionShaped: true,
    linkedSources: [
      "../windows-runtime/RuntimeClosureLease.cs",
      "../windows-runtime/RuntimeNativePrimitives.cs",
      "../windows-runtime/RuntimeLifecycleWorker.cs",
    ],
  },
];

/**
 * Proof-only components (ADR 0018 section 2). They are built, measured, and
 * self-tested exactly like the production-shaped ones, and they are excluded
 * from the pinned conformance comparison, from the install simulation, and from
 * any manifest that could be mistaken for a production one. They are absent
 * from the npm package for a structural reason rather than a remembered one:
 * `files` is `dist` + `README.md`, so nothing under `native/` is packed.
 */
const PROOF_ONLY_COMPONENTS = [
  {
    component: "windows-proof-installer",
    directory: join(nativeRoot, "windows-proof-installer"),
    project: join(nativeRoot, "windows-proof-installer", "AI.DevOS.WindowsProofInstaller.csproj"),
    executable: "AI.DevOS.WindowsProofInstaller.exe",
    productionShaped: false,
    installableCandidateCount: 1,
    linkedSources: [],
  },
  {
    component: "windows-proof-controller",
    directory: join(nativeRoot, "windows-proof-controller"),
    project: join(nativeRoot, "windows-proof-controller", "AI.DevOS.WindowsProofController.csproj"),
    executable: "AI.DevOS.WindowsProofController.exe",
    productionShaped: false,
    installableCandidateCount: 0,
    linkedSources: [
      "../windows-runtime/RuntimeClosureLease.cs",
      "../windows-feasibility-probe/SyntheticProcessProof.cs",
      "../windows-feasibility-probe/StructuredBoundaryProof.cs",
      "../windows-feasibility-probe/HelperLifecycleProof.cs",
    ],
  },
];

/**
 * Source files that must be byte-identical between the two components once the
 * namespace line is normalised. Duplicating a security-critical parser is only
 * safe if drift is impossible to miss, so drift is a build failure.
 */
const SHARED_CORE_FILES = [
  "ArtifactManifest.cs",
  "ArtifactPathResolution.cs",
  "CanonicalJson.cs",
  "ClosureConformance.cs",
  "Conformance.cs",
  "FrameCodec.cs",
  "MutationGate.cs",
  "NuGet.Config",
  "OperationStateMachine.cs",
  "Program.cs",
  "ProtocolContract.cs",
  "ProtocolMessages.cs",
  "RecoveryRecord.cs",
  "StrictJson.cs",
  "TokenDerivation.cs",
  "VerifiedClosure.cs",
];

const ALLOWED_EXTENSIONS = new Set([".exe", ".dll", ".json"]);
const REJECTED_EXTENSIONS = new Set([
  ".pdb",
  ".cs",
  ".csproj",
  ".config",
  ".xml",
  ".txt",
  ".log",
  ".tmp",
  ".cache",
  ".user",
  ".suo",
  ".bak",
  ".map",
  ".sln",
]);

const LIMITATIONS = [
  "artifact-never-executed-beyond-read-only-self-test",
  "installed-source-trust-blocked-on-release-signing",
  "no-pinned-bundle-fingerprint",
  "path-redirection-needs-protected-install-root",
  "production-supervisor-recovery-unproved",
  "unsigned-candidate",
  "windows-corpus-not-run",
];

function fail(message) {
  process.stderr.write(`build-windows-artifacts: ${message}\n`);
  process.exit(1);
}

/**
 * The recipe a component is built with.
 *
 * A production-shaped component is built sealed no matter what `--flavor` says.
 * The switch exists for proof-only components. The installer is the only one
 * with a mutating operation to gate; applying the switch to the supervisor and
 * helper produced binaries with the mutating branch compiled in AND a manifest
 * that announced itself as a production artifact.
 */
function flavorFor(entry, requestedFlavor) {
  return entry.productionShaped === true ? "sealed" : requestedFlavor;
}

function parseArguments(argv) {
  let out = null;
  let skipSimulation = false;
  let flavor = "sealed";
  let includeProofOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--out") {
      index += 1;
      out = argv[index] ?? null;
      continue;
    }
    if (value === "--skip-install-simulation") {
      skipSimulation = true;
      continue;
    }
    if (value === "--flavor") {
      index += 1;
      flavor = argv[index] ?? "";
      continue;
    }
    if (value === "--include-proof-only") {
      includeProofOnly = true;
      continue;
    }
    fail(`unknown argument: ${value}`);
  }
  if (out === null) fail("--out <absolute-task-owned-directory> is required");
  if (flavor !== "sealed" && flavor !== "reviewed-proof") {
    fail("--flavor must be exactly 'sealed' (default) or 'reviewed-proof'");
  }
  if (flavor === "reviewed-proof" && !includeProofOnly) {
    fail("--flavor reviewed-proof requires --include-proof-only");
  }
  const resolved = resolve(out);
  if (resolved !== out) fail("--out must already be an absolute normalized path");
  if (resolved === repoRoot || resolved.startsWith(repoRoot + sep)) {
    fail("--out must be outside the repository so no generated binary can be tracked");
  }
  return { out: resolved, skipSimulation, flavor, includeProofOnly };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_NOLOGO: "1",
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    },
    ...options,
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  return result;
}

// --------------------------------------------------------------- shared core

function sharedCoreParity() {
  const digests = new Map();
  for (const entry of COMPONENTS) {
    const parts = [];
    for (const name of SHARED_CORE_FILES) {
      const path = join(entry.directory, name);
      if (!existsSync(path)) fail(`shared core file missing: ${entry.component}/${name}`);
      const text = readFileSync(path, "utf8")
        .replace(/namespace AiDevOs\.Windows(Supervisor|Helper);/g, "namespace AiDevOs.Component;")
        .replace(/\r\n/g, "\n");
      parts.push({ name, sha256: sha256Text(text) });
    }
    digests.set(entry.component, sha256Text(canonicalJson(parts)));
  }
  const values = [...digests.values()];
  const identical = values.every((value) => value === values[0]);
  return {
    identical,
    digest: values[0] ?? null,
    perComponent: Object.fromEntries(digests),
    fileCount: SHARED_CORE_FILES.length,
  };
}

// ------------------------------------------------------------------- publish

function publishOnce(entry, out, buildIndex, flavor) {
  const outputDir = join(out, `build-${String(buildIndex)}`, entry.component);
  const intermediate = join(out, `obj-${String(buildIndex)}`, entry.component) + sep;
  const baseOutput = join(out, `bin-${String(buildIndex)}`, entry.component) + sep;
  mkdirSync(outputDir, { recursive: true });

  const properties = [
    `-p:BaseIntermediateOutputPath=${intermediate}`,
    `-p:BaseOutputPath=${baseOutput}`,
  ];
  if (flavor === "reviewed-proof") {
    // The ONLY way the constant is ever defined. It is not in any csproj, not
    // in any Directory.Build.props, and not derivable from the environment, so
    // a proof-flavoured binary can only be produced by a command line that says
    // so.
    properties.push(`-p:DefineConstants=${REVIEWED_PROOF_CONSTANT}`);
  }

  const restore = run("dotnet", ["restore", entry.project, "--nologo", ...properties]);
  if (restore.status !== 0) {
    fail(`restore failed for ${entry.component}:\n${restore.stdout}\n${restore.stderr}`);
  }
  const publish = run("dotnet", [
    "publish",
    entry.project,
    "-c",
    "Release",
    "--no-restore",
    "--nologo",
    "-o",
    outputDir,
    ...properties,
  ]);
  if (publish.status !== 0) {
    fail(`publish failed for ${entry.component}:\n${publish.stdout}\n${publish.stderr}`);
  }
  const warnings = (publish.stdout.match(/warning [A-Z]+\d+/g) ?? []).length;
  if (warnings > 0) fail(`publish produced ${String(warnings)} warnings for ${entry.component}`);
  return outputDir;
}

function enumerateClosure(directory) {
  const files = [];
  const rejected = [];
  const seenLower = new Set();
  const walk = (current) => {
    for (const item of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(current, item.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        rejected.push({ name: relative(directory, path), reason: "mutable-alias-or-reparse-point" });
        continue;
      }
      if (item.isDirectory()) {
        rejected.push({ name: relative(directory, path), reason: "unexpected-subdirectory" });
        walk(path);
        continue;
      }
      const name = relative(directory, path).split(sep).join("/");
      const dot = name.lastIndexOf(".");
      const extension = dot < 0 ? "" : name.slice(dot).toLowerCase();
      if (REJECTED_EXTENSIONS.has(extension)) {
        rejected.push({ name, reason: `rejected-extension${extension}` });
        continue;
      }
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        rejected.push({ name, reason: "unexpected-extension" });
        continue;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name.includes("..")) {
        rejected.push({ name, reason: "unsafe-file-name" });
        continue;
      }
      if (seenLower.has(name.toLowerCase())) {
        rejected.push({ name, reason: "duplicate-entry" });
        continue;
      }
      seenLower.add(name.toLowerCase());
      files.push({ name, size: info.size, sha256: sha256File(path) });
    }
  };
  walk(directory);
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { files, rejected };
}

function compareClosures(first, second) {
  const differing = [];
  const byName = new Map(second.map((entry) => [entry.name, entry]));
  for (const entry of first) {
    const other = byName.get(entry.name);
    if (other === undefined) {
      differing.push({ name: entry.name, reason: "missing-in-second-build" });
      continue;
    }
    if (other.size !== entry.size) {
      differing.push({
        name: entry.name,
        reason: "size-differs",
        firstSize: entry.size,
        secondSize: other.size,
      });
      continue;
    }
    if (other.sha256 !== entry.sha256) {
      differing.push({
        name: entry.name,
        reason: "digest-differs",
        firstSha256: entry.sha256,
        secondSha256: other.sha256,
      });
    }
  }
  const firstNames = new Set(first.map((entry) => entry.name));
  for (const entry of second) {
    if (!firstNames.has(entry.name)) {
      differing.push({ name: entry.name, reason: "missing-in-first-build" });
    }
  }
  return differing;
}

/**
 * Locates the first differing byte region of two files whose digests disagree.
 * Only offsets and lengths are reported; no file content is ever emitted,
 * because the differing bytes could be anything.
 */
function differingRegion(firstPath, secondPath) {
  const a = readFileSync(firstPath);
  const b = readFileSync(secondPath);
  const limit = Math.min(a.length, b.length);
  let start = -1;
  let end = -1;
  let differingBytes = 0;
  for (let index = 0; index < limit; index += 1) {
    if (a[index] !== b[index]) {
      if (start < 0) start = index;
      end = index;
      differingBytes += 1;
    }
  }
  return {
    firstLength: a.length,
    secondLength: b.length,
    firstDifferingOffset: start,
    lastDifferingOffset: end,
    differingByteCount: differingBytes,
  };
}

// ------------------------------------------------------------------ manifest

function sourceEnvelope(entry) {
  const inputs = [];
  const files = [];
  for (const name of readdirSync(entry.directory).sort()) {
    const path = join(entry.directory, name);
    if (!lstatSync(path).isFile()) continue;
    inputs.push({ name, path });
  }
  for (const name of entry.linkedSources) {
    const path = resolve(entry.directory, name);
    const fromNativeRoot = relative(nativeRoot, path);
    if (
      fromNativeRoot === "" ||
      fromNativeRoot === ".." ||
      fromNativeRoot.startsWith(`..${sep}`) ||
      resolve(nativeRoot, fromNativeRoot) !== path ||
      !existsSync(path) ||
      !lstatSync(path).isFile()
    ) {
      fail(`${entry.component}: linked source escapes native root or is not a file: ${name}`);
    }
    inputs.push({ name: name.split(sep).join("/"), path });
  }
  const seen = new Set();
  for (const input of inputs.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (seen.has(input.name)) {
      fail(`${entry.component}: duplicate source-envelope name: ${input.name}`);
    }
    seen.add(input.name);
    files.push({ name: input.name, sha256: sha256File(input.path) });
  }
  return { files, fingerprint: sha256Text(canonicalJson(files)) };
}

/**
 * Measures the runtime pack version from what the publish actually emitted.
 *
 * A self-contained publish writes `<assembly>.deps.json` into the closure, and
 * that file names the exact runtime pack it resolved, for example
 * `runtimepack.Microsoft.NETCore.App.Runtime.win-x64/9.0.18`. That string is a
 * measurement of this build, and the file carrying it is itself enumerated,
 * sized, and SHA-256'd as part of the closure, so the value is bound to bytes
 * the manifest already covers.
 *
 * This replaces a hard-coded `"9.0.18"` literal that was emitted whenever
 * `hostpolicy.dll` happened to be present. That literal was a guess wearing the
 * costume of a measurement: it would have kept reporting 9.0.18 across a
 * runtime servicing update, silently attesting to a runtime version the build
 * did not use.
 *
 * There is no fallback and no `"unknown"`. If the value cannot be measured the
 * build fails, because a build-identity fingerprint that quietly degrades to a
 * placeholder is worse than no fingerprint at all.
 */
function measureRuntimePackVersion(entry, publishDirectory, closureFiles) {
  const depsName = entry.executable.replace(/\.exe$/, ".deps.json");
  if (!closureFiles.some((file) => file.name === depsName)) {
    fail(`${entry.component}: ${depsName} is not in the enumerated closure; cannot measure runtimePackVersion`);
  }

  let deps;
  try {
    deps = JSON.parse(readFileSync(join(publishDirectory, depsName), "utf8"));
  } catch (error) {
    fail(`${entry.component}: ${depsName} is unreadable or not JSON: ${String(error)}`);
  }

  // Exact string prefix, deliberately not a regular expression: the dots in
  // the pack name are literal, and an escaping slip in a template literal is
  // an easy way to turn them into wildcards without anyone noticing.
  const prefix = `runtimepack.Microsoft.NETCore.App.Runtime.${RID}/`;
  const distinct = [
    ...new Set(
      Object.keys(deps.libraries ?? {})
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length)),
    ),
  ];

  if (distinct.length !== 1) {
    fail(
      `${entry.component}: expected exactly one runtimepack entry for ${RID} in ${depsName}, ` +
        `found ${JSON.stringify(distinct)}`,
    );
  }

  const version = distinct[0];
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9a-z.]{1,32})?$/.test(version)) {
    fail(`${entry.component}: measured runtimePackVersion ${JSON.stringify(version)} is not a version`);
  }
  return version;
}

function buildRecipeFingerprint(sdkVersion, runtimePackVersion) {
  return sha256Text(
    canonicalJson({
      allowUnsafeBlocks: false,
      analysisLevel: "latest-all",
      buildRecipeVersion: BUILD_RECIPE_VERSION,
      checkForOverflowUnderflow: true,
      configuration: "Release",
      continuousIntegrationBuild: true,
      debugType: "none",
      deterministic: true,
      invariantGlobalization: true,
      nugetPackageSources: "cleared",
      publishReadyToRun: false,
      publishSingleFile: false,
      publishTrimmed: false,
      rid: RID,
      runtimePackVersion,
      satelliteResourceLanguages: "en",
      sdkVersion,
      selfContained: true,
      targetFramework: "net9.0-windows",
      treatWarningsAsErrors: true,
      useSystemResourceKeys: true,
    }),
  );
}

/**
 * Requires a binary's self-reported gate to match the recipe that was asked
 * for, in BOTH read-only commands (ADR 0018 section 4).
 *
 * Both directions are enforced, and that is the point. Refusing to package a
 * proof binary as sealed is the obvious half. Refusing to accept a SEALED
 * binary when the reviewed-proof recipe was requested is the half that stops a
 * proof run being conducted, in good faith, against a binary that cannot
 * perform it — which would produce a clean run that proved nothing.
 */
function assertGateMatchesRecipe(entry, mutationGate, flavor) {
  const expected = flavor === "sealed" ? SEALED_FLAVOR : PROOF_FLAVOR;
  const expectedProofMode = flavor !== "sealed";
  for (const [command, reported, proofMode] of [
    ["self-test", mutationGate.selfTestBuildFlavor, mutationGate.selfTestProofModeCompiledIn],
    ["describe-artifact", mutationGate.describeBuildFlavor, mutationGate.describeProofModeCompiledIn],
  ]) {
    if (typeof reported !== "string" || typeof proofMode !== "boolean") {
      fail(
        `${entry.component} ${command} does not report buildFlavor and proofModeCompiledIn; ` +
          `the mutation gate is unobservable in this binary`,
      );
    }
    if (reported !== expected || proofMode !== expectedProofMode) {
      fail(
        `${entry.component} ${command} reports buildFlavor=${JSON.stringify(reported)} ` +
          `proofModeCompiledIn=${JSON.stringify(proofMode)}, but the ${flavor} recipe requires ` +
          `${JSON.stringify(expected)}/${String(expectedProofMode)}`,
      );
    }
  }
  if (!mutationGate.commandsAgree) {
    fail(`${entry.component}: self-test and describe-artifact disagree about the mutation gate`);
  }
}

/**
 * Builds, measures, and read-only self-tests a proof-only component.
 *
 * It is deliberately NOT given a production-shaped artifact manifest, is not
 * compared against the pinned conformance table, and is not offered to the
 * install simulation. A proof component that acquired any of those would be one
 * step from being discovered by a production path.
 */
function buildProofOnlyComponent(entry, out, flavor) {
  const firstDir = publishOnce(entry, out, 1, flavor);
  const secondDir = publishOnce(entry, out, 2, flavor);
  const first = enumerateClosure(firstDir);
  const second = enumerateClosure(secondDir);
  if (first.rejected.length > 0 || second.rejected.length > 0) {
    fail(
      `${entry.component} closure contains rejected entries: ` +
        JSON.stringify([...first.rejected, ...second.rejected], null, 2),
    );
  }

  const differing = compareClosures(first.files, second.files);
  if (differing.length > 0) {
    fail(`${entry.component} proof-only builds were not byte-identical: ${differing.join(", ")}`);
  }
  const executable = join(firstDir, entry.executable);
  const selfTest = run(executable, ["self-test"], { cwd: firstDir });
  const describe = run(executable, ["describe-artifact"], { cwd: firstDir });
  const unknown = run(executable, ["definitely-not-a-command"], { cwd: firstDir });
  const selfTestJson = JSON.parse(selfTest.stdout.trim());
  const describeJson = JSON.parse(describe.stdout.trim());
  const unknownJson = JSON.parse(unknown.stdout.trim());

  const mutationGate = {
    selfTestBuildFlavor: selfTestJson.buildFlavor,
    selfTestProofModeCompiledIn: selfTestJson.proofModeCompiledIn,
    describeBuildFlavor: describeJson.buildFlavor,
    describeProofModeCompiledIn: describeJson.proofModeCompiledIn,
    commandsAgree:
      selfTestJson.buildFlavor === describeJson.buildFlavor &&
      selfTestJson.proofModeCompiledIn === describeJson.proofModeCompiledIn,
  };
  assertGateMatchesRecipe(entry, mutationGate, flavor);

  if (selfTest.status !== 0 || selfTestJson.status !== "passed") {
    fail(`${entry.component} self-test failed`);
  }
  if (
    describe.status !== 0 ||
    describeJson.status !== "described" ||
    describeJson.component !== entry.component
  ) {
    fail(`${entry.component} describe-artifact identity/status mismatch`);
  }
  if (selfTestJson.component !== entry.component) {
    fail(`${entry.component} self-test component identity mismatch`);
  }
  if (unknown.status === 0 || unknownJson.code !== "unknown-command") {
    fail(`${entry.component} accepted an unknown command`);
  }
  if (describeJson.productionEligible !== false) {
    fail(`${entry.component} describe-artifact does not report productionEligible: false`);
  }
  if (selfTestJson.installableCandidateCount !== entry.installableCandidateCount) {
    fail(
      `${entry.component} reports ${String(selfTestJson.installableCandidateCount)} installable ` +
        `candidates; reviewed source requires ${String(entry.installableCandidateCount)}`,
    );
  }
  // These two are now MEASUREMENTS in the binary — read from counters the native
  // adapter increments in its own constructor and its own open path — rather than
  // the compile-time `false` literals they used to be. Checking a literal against
  // a literal is what made this a check that could not fire, about the one
  // property most worth checking.
  if (selfTestJson.hostStateCreated !== false) {
    fail(`${entry.component} self-test reports host state was created`);
  }
  if (selfTestJson.nativeFileSystemInstantiated !== false) {
    fail(`${entry.component} self-test instantiated the native filesystem`);
  }
  if (selfTestJson.nativeOpenAttempts !== 0) {
    fail(
      `${entry.component} self-test attempted ${String(selfTestJson.nativeOpenAttempts)} native ` +
        `opens; the read-only suite must attempt none`,
    );
  }

  const envelope = sourceEnvelope(entry);
  const runtimePackVersion = measureRuntimePackVersion(entry, firstDir, first.files);
  return {
    proofOnly: true,
    productionEligible: false,
    mutationGate,
    fileCount: first.files.length,
    totalBytes: first.files.reduce((sum, file) => sum + file.size, 0),
    sourceEnvelopeFingerprint: envelope.fingerprint,
    sourceFileCount: envelope.files.length,
    runtimePackVersion,
    byteIdenticalAcrossTwoBuilds: differing.length === 0,
    differingFiles: differing,
    selfTest: {
      exitCode: selfTest.status,
      status: selfTestJson.status,
      suite: selfTestJson.suite,
      vectorCount: selfTestJson.vectorCount,
      failedVectorCount: selfTestJson.failedVectorCount,
      conformanceDigest: selfTestJson.conformanceDigest,
      installableCandidateCount: selfTestJson.installableCandidateCount,
      hostStateCreated: selfTestJson.hostStateCreated,
      nativeFileSystemInstantiated: selfTestJson.nativeFileSystemInstantiated,
      nativeOpenAttempts: selfTestJson.nativeOpenAttempts,
    },
    describeArtifact: { exitCode: describe.status, ...describeJson },
    unknownCommand: { exitCode: unknown.status, code: unknownJson.code },
    largestFiles: [...first.files]
      .sort((a, b) => b.size - a.size)
      .slice(0, 5)
      .map((file) => ({ name: file.name, size: file.size })),
  };
}


// ---------------------------------------------------------------------- main

async function main() {
  const { out, skipSimulation, flavor, includeProofOnly } = parseArguments(process.argv.slice(2));
  mkdirSync(out, { recursive: true });

  const distIndex = join(packageRoot, "dist", "index.js");
  if (!existsSync(distIndex)) fail("dist is missing; run `npm run build` in packages/process-broker first");
  const artifactModule = await import(pathToFileURL(join(packageRoot, "dist", "windows-artifact.js")).href);
  const installModule = await import(
    pathToFileURL(join(packageRoot, "dist", "windows-artifact-install.js")).href
  );
  const corpusModule = await import(pathToFileURL(join(packageRoot, "dist", "escape-corpus.js")).href);
  const discoveryModule = await import(
    pathToFileURL(join(packageRoot, "dist", "windows-artifact-discovery.js")).href
  );

  const packageVersion = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
  const sdkVersion = run("dotnet", ["--version"]).stdout.trim();

  const parity = sharedCoreParity();
  if (!parity.identical) {
    fail(
      `the shared protocol cores have drifted apart: ${JSON.stringify(parity.perComponent, null, 2)}`,
    );
  }

  const report = {
    schemaVersion: 1,
    reportKind: "ai-dev-os-windows-production-artifact-packaging-result",
    generatedFor: "stage-17-windows-production-supervisor-packaging",
    outputRoot: out,
    dotnetSdkVersion: sdkVersion,
    buildRecipeVersion: BUILD_RECIPE_VERSION,
    sharedCoreParity: parity,
    buildFlavor: flavor,
    expectedBuildFlavorName: flavor === "sealed" ? SEALED_FLAVOR : PROOF_FLAVOR,
    proofOnlyComponentsIncluded: includeProofOnly,
    components: {},
    deterministic: null,
    installSimulation: null,
    truth: {
      signerState: "unsigned-candidate",
      productionEligible: false,
      windowsBackendAvailable: false,
      windowsBackendDetail: "windows-native-process-composition-and-corpus-unverified",
      pinnedBundleFingerprintCount: discoveryModule.PINNED_WINDOWS_BUNDLE_FINGERPRINTS.length,
      windowsCorpusResult: "not-run",
      windowsApplicableVectorCount: corpusModule.secureBackendEscapeVectorCount("win32"),
      windowsCorpusPassedCount: 0,
      artifactExecutedBeyondReadOnlySelfTest: false,
      limitations: LIMITATIONS,
    },
  };

  let allDeterministic = true;
  const allDifferences = [];

  for (const entry of COMPONENTS) {
    // Sealed for every production-shaped component, whatever --flavor asked for.
    const entryFlavor = flavorFor(entry, flavor);
    if (entry.productionShaped === true && entryFlavor !== "sealed") {
      fail(`${entry.component} is production-shaped and must be built sealed`);
    }

    const firstDir = publishOnce(entry, out, 1, entryFlavor);
    const secondDir = publishOnce(entry, out, 2, entryFlavor);
    const first = enumerateClosure(firstDir);
    const second = enumerateClosure(secondDir);

    if (first.rejected.length > 0 || second.rejected.length > 0) {
      fail(
        `${entry.component} closure contains rejected entries: ` +
          JSON.stringify([...first.rejected, ...second.rejected], null, 2),
      );
    }

    const differing = compareClosures(first.files, second.files);
    if (differing.length > 0) {
      allDeterministic = false;
      for (const difference of differing) {
        if (difference.reason === "digest-differs" || difference.reason === "size-differs") {
          difference.region = differingRegion(
            join(firstDir, difference.name),
            join(secondDir, difference.name),
          );
        }
        allDifferences.push({ component: entry.component, ...difference });
      }
    }

    // Measured from each build's own output, then cross-checked: two clean
    // builds that resolved different runtime packs are not reproducible, and
    // that must fail rather than be papered over by reporting only the first.
    const runtimePackVersion = measureRuntimePackVersion(entry, firstDir, first.files);
    const secondRuntimePackVersion = measureRuntimePackVersion(entry, secondDir, second.files);
    if (runtimePackVersion !== secondRuntimePackVersion) {
      fail(
        `${entry.component}: runtime pack differs between clean builds ` +
          `(${runtimePackVersion} vs ${secondRuntimePackVersion})`,
      );
    }
    const envelope = sourceEnvelope(entry);
    const totalBytes = first.files.reduce((sum, file) => sum + file.size, 0);

    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      manifestKind: "ai-dev-os-windows-production-artifact-manifest",
      component: entry.component,
      protocolVersion: PROTOCOL_VERSION,
      sourceVersion: SOURCE_VERSION,
      buildRecipeVersion: BUILD_RECIPE_VERSION,
      platform: PLATFORM,
      rid: RID,
      architecture: ARCHITECTURE,
      packageVersion,
      bundleVersion: BUNDLE_VERSION,
      fileCount: first.files.length,
      totalBytes,
      files: first.files,
      sourceEnvelopeFingerprint: envelope.fingerprint,
      buildManifestFingerprint: buildRecipeFingerprint(sdkVersion, runtimePackVersion),
      corpusVersion: corpusModule.SECURE_BACKEND_ESCAPE_CORPUS_VERSION,
      corpusFingerprint: corpusModule.SECURE_BACKEND_ESCAPE_CORPUS_FINGERPRINT,
      windowsApplicableVectorCount: corpusModule.secureBackendEscapeVectorCount("win32"),
      signerState: "unsigned-candidate",
      productionEligible: false,
      limitations: LIMITATIONS,
    };

    const parsed = artifactModule.parseWindowsArtifactManifest(manifest);
    const manifestFingerprint = artifactModule.windowsArtifactManifestFingerprint(parsed);

    const manifestDir = join(out, "manifests");
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, `${entry.component}-${MANIFEST_FILE_NAME}`),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    // Read-only component commands. Neither can create a profile, a Job, a
    // process, an ACL change, a registry value, a recovery record, or any
    // other persistent state.
    const executable = join(firstDir, entry.executable);
    const selfTest = run(executable, ["self-test"], { cwd: firstDir });
    const describe = run(executable, ["describe-artifact"], { cwd: firstDir });
    const unknown = run(executable, ["definitely-not-a-command"], { cwd: firstDir });
    const selfTestJson = JSON.parse(selfTest.stdout.trim());
    const describeJson = JSON.parse(describe.stdout.trim());
    const unknownJson = JSON.parse(unknown.stdout.trim());

    const describeMatchesManifest =
      describeJson.component === manifest.component &&
      describeJson.protocolVersion === manifest.protocolVersion &&
      describeJson.sourceVersion === manifest.sourceVersion &&
      describeJson.buildRecipeVersion === manifest.buildRecipeVersion &&
      describeJson.manifestSchemaVersion === manifest.schemaVersion &&
      describeJson.rid === manifest.rid &&
      describeJson.signerState === manifest.signerState &&
      describeJson.productionEligible === false;

    // The mutation gate's observable identity, taken from the binary's own
    // output rather than from the source that built it. A binary compiled with
    // AIDEVOS_STAGE17_REVIEWED_PROOF_MODE reports a different flavour, and it
    // must never be able to flow through the normal packaging path unnoticed.
    // Both read-only commands are required to report it, and to agree.
    const mutationGate = {
      selfTestBuildFlavor: selfTestJson.buildFlavor,
      selfTestProofModeCompiledIn: selfTestJson.proofModeCompiledIn,
      describeBuildFlavor: describeJson.buildFlavor,
      describeProofModeCompiledIn: describeJson.proofModeCompiledIn,
      commandsAgree:
        selfTestJson.buildFlavor === describeJson.buildFlavor &&
        selfTestJson.proofModeCompiledIn === describeJson.proofModeCompiledIn,
      sealed:
        selfTestJson.buildFlavor === "sealed" && selfTestJson.proofModeCompiledIn === false,
    };

    report.components[entry.component] = {
      mutationGate,
      fileCount: first.files.length,
      totalBytes,
      manifestFingerprint,
      sourceEnvelopeFingerprint: envelope.fingerprint,
      sourceFileCount: envelope.files.length,
      buildManifestFingerprint: manifest.buildManifestFingerprint,
      // Recorded, not just fingerprinted. A value that only ever reaches a
      // digest cannot be audited: a reviewer has no way to see what was
      // measured or to notice it silently changing.
      runtimePackVersion,
      runtimePackVersionMeasuredFrom: entry.executable.replace(/\.exe$/, ".deps.json"),
      byteIdenticalAcrossTwoBuilds: differing.length === 0,
      differingFiles: differing,
      selfTest: {
        exitCode: selfTest.status,
        status: selfTestJson.status,
        coreVectorCount: selfTestJson.coreVectorCount,
        roleVectorCount: selfTestJson.roleVectorCount,
        failedVectorCount: selfTestJson.failedVectorCount,
        coreConformanceDigest: selfTestJson.coreConformanceDigest,
        roleConformanceDigest: selfTestJson.roleConformanceDigest,
        manifestFixtureFingerprint: selfTestJson.manifestFixtureFingerprint,
        reviewedProofMutationAuthorized: selfTestJson.reviewedProofMutationAuthorized,
        hostStateCreated: selfTestJson.hostStateCreated,
      },
      describeArtifact: { exitCode: describe.status, ...describeJson },
      describeMatchesManifest,
      unknownCommand: { exitCode: unknown.status, code: unknownJson.code },
      largestFiles: [...first.files]
        .sort((a, b) => b.size - a.size)
        .slice(0, 5)
        .map((file) => ({ name: file.name, size: file.size })),
    };

    if (selfTest.status !== 0 || selfTestJson.status !== "passed") {
      fail(`${entry.component} self-test failed`);
    }
    assertGateMatchesRecipe(entry, mutationGate, entryFlavor);
    if (!mutationGate.commandsAgree) {
      fail(`${entry.component}: self-test and describe-artifact disagree about the mutation gate`);
    }
    if (describe.status !== 0 || !describeMatchesManifest) {
      fail(`${entry.component} describe-artifact disagrees with its manifest`);
    }
    if (unknown.status === 0 || unknownJson.code !== "unknown-command") {
      fail(`${entry.component} accepted an unknown command`);
    }
  }

  if (includeProofOnly) {
    report.proofOnlyComponents = {};
    for (const entry of PROOF_ONLY_COMPONENTS) {
      report.proofOnlyComponents[entry.component] = buildProofOnlyComponent(entry, out, flavor);
    }
  }

  const supervisor = report.components["windows-supervisor"];
  const helper = report.components["windows-helper"];
  const coreDigestsAgree =
    supervisor.selfTest.coreConformanceDigest === helper.selfTest.coreConformanceDigest;
  if (!coreDigestsAgree) fail("the two components report different core conformance digests");

  // The reviewed TypeScript source pins what the native self-tests must report.
  // A protocol, state-machine, recovery-record, or manifest change that is not
  // mirrored into the pinned table fails the build here rather than shipping.
  const pinned = artifactModule.WINDOWS_COMPONENT_CONFORMANCE;
  const conformanceMatches =
    supervisor.selfTest.coreConformanceDigest === pinned.coreConformanceDigest &&
    supervisor.selfTest.coreVectorCount === pinned.coreVectorCount &&
    helper.selfTest.coreVectorCount === pinned.coreVectorCount &&
    supervisor.selfTest.roleConformanceDigest === pinned.roles["windows-supervisor"].digest &&
    supervisor.selfTest.roleVectorCount === pinned.roles["windows-supervisor"].vectorCount &&
    helper.selfTest.roleConformanceDigest === pinned.roles["windows-helper"].digest &&
    helper.selfTest.roleVectorCount === pinned.roles["windows-helper"].vectorCount;
  report.pinnedConformance = {
    matches: conformanceMatches,
    pinned,
    observed: {
      "windows-supervisor": supervisor.selfTest,
      "windows-helper": helper.selfTest,
    },
  };
  // The two production-shaped components are ALWAYS built sealed by
  // flavorFor(entry), even when the top-level request additionally asks for
  // reviewed-proof-only components. Their exact sealed conformance must match
  // the production pin in both command shapes. Each proof-only component is
  // checked separately above against the requested reviewed-proof recipe and
  // is never admitted to this production-shaped manifest/pin path.
  if (!conformanceMatches) {
    fail("the sealed production self-test results do not match the pinned conformance table");
  }

  // Cross-language check: the C# and TypeScript implementations of canonical
  // manifest identity must agree on the same fixed fixture.
  const fixture = JSON.parse(
    readFileSync(join(scriptDir, "manifest-conformance-fixture.json"), "utf8"),
  );
  const fixtureFingerprint = artifactModule.windowsArtifactManifestFingerprint(
    artifactModule.parseWindowsArtifactManifest(fixture),
  );
  const crossLanguageAgrees =
    fixtureFingerprint === supervisor.selfTest.manifestFixtureFingerprint &&
    fixtureFingerprint === helper.selfTest.manifestFixtureFingerprint;
  report.crossLanguageManifestIdentity = {
    typescriptFingerprint: fixtureFingerprint,
    supervisorFingerprint: supervisor.selfTest.manifestFixtureFingerprint,
    helperFingerprint: helper.selfTest.manifestFixtureFingerprint,
    agrees: crossLanguageAgrees,
  };
  if (!crossLanguageAgrees) {
    fail("the C# and TypeScript manifest identity implementations disagree");
  }

  report.deterministic = {
    byteIdentical: allDeterministic,
    differences: allDifferences,
    buildsPerComponent: 2,
  };

  // The install simulation exercises the PRODUCTION install path. Offering it
  // a reviewed-proof bundle would install proof-flavoured bytes through the
  // seam whose whole purpose is to refuse them, so it is skipped rather than
  // guarded: a code path that never sees a proof bundle cannot be tricked into
  // accepting one.
  if (!skipSimulation && flavor === "sealed") {
    report.installSimulation = await simulateInstall(out, artifactModule, installModule);
  } else if (flavor !== "sealed") {
    report.installSimulation = { skipped: "reviewed-proof-bundles-are-never-installed" };
  }

  writeFileSync(join(out, "packaging-result.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (!allDeterministic) {
    process.stderr.write(
      "build-windows-artifacts: FAILED — the two builds are not byte-identical. " +
        "The mismatch is retained in packaging-result.json.\n",
    );
    process.exit(2);
  }
}

/**
 * Installed-package simulation against the real closure, inside the task-owned
 * output directory. Small synthetic bundles cover the full refusal matrix in
 * the unit tests; this pass proves the real 100+ file closure behaves the same.
 */
async function simulateInstall(out, artifactModule, installModule) {
  const installRoot = join(out, "install-root");
  mkdirSync(installRoot, { recursive: true });
  const results = {};

  for (const entry of COMPONENTS) {
    const source = join(out, "build-1", entry.component);
    const manifestPath = join(out, "manifests", `${entry.component}-${MANIFEST_FILE_NAME}`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const parsed = artifactModule.parseWindowsArtifactManifest(manifest);
    const fingerprint = artifactModule.windowsArtifactManifestFingerprint(parsed);

    const stagingDir = join(installRoot, ".staging", `${entry.component}-${BUNDLE_VERSION}`);
    mkdirSync(stagingDir, { recursive: true });
    cpSync(source, stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const installed = await installModule.installWindowsBundle({
      root: installRoot,
      component: entry.component,
      bundleVersion: BUNDLE_VERSION,
      stagingDir,
      pinnedFingerprint: fingerprint,
    });

    const verified = await installModule.verifyWindowsInstalledBundle({
      root: installRoot,
      component: entry.component,
      bundleVersion: BUNDLE_VERSION,
      pinnedFingerprint: fingerprint,
    });

    const unpinned = await installModule.verifyWindowsInstalledBundle({
      root: installRoot,
      component: entry.component,
      bundleVersion: BUNDLE_VERSION,
      pinnedFingerprint: "0".repeat(64),
    });

    const overwriteRefused = await installModule.installWindowsBundle({
      root: installRoot,
      component: entry.component,
      bundleVersion: BUNDLE_VERSION,
      stagingDir,
    });

    const activeRemovalRefused = await installModule.removeWindowsBundle({
      root: installRoot,
      component: entry.component,
      bundleVersion: BUNDLE_VERSION,
      activeVersions: [BUNDLE_VERSION],
      recoverableVersions: [],
    });

    const removed = await installModule.removeWindowsBundle({
      root: installRoot,
      component: entry.component,
      bundleVersion: BUNDLE_VERSION,
      activeVersions: [],
      recoverableVersions: [],
    });

    results[entry.component] = {
      installed: installed.installed,
      installCode: installed.code,
      verified: verified.verified,
      verifiedSignerState: verified.verified ? verified.signerState : null,
      verifiedProductionEligible: verified.verified ? verified.productionEligible : null,
      unpinnedRefusalCode: unpinned.verified ? null : unpinned.code,
      overwriteRefusalCode: overwriteRefused.installed ? null : overwriteRefused.code,
      activeRemovalRefusalCode: activeRemovalRefused.removed ? null : activeRemovalRefused.code,
      removed: removed.removed,
      removedFileCount: removed.removedFileCount,
    };
  }

  const recovery = await installModule.recoverWindowsInstallRoot({ root: installRoot });
  const residue = await installModule.scanWindowsInstallResidue(installRoot);
  return { perComponent: results, recovery, residue, residueCount: residue.length };
}

await main();
