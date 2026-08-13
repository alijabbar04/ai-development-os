/**
 * Regression tests for ownership-bearing Windows artifact verification
 * (ADR 0017 sections 6.5 and 6.6).
 *
 * Every test here is written to FAIL under a specific defect, not to describe
 * good behaviour. The defects they cover were each reintroduced into the
 * reviewed source once, observed failing, and restored.
 *
 * Two layers are covered:
 *
 * 1. the TypeScript **pre-filter**, which may refuse and may never authorize; and
 * 2. the reviewed C# **enforcing** side, which is checked here by asserting that
 *    its named self-test vectors still exist in source and that the pinned
 *    conformance digest still matches. TypeScript cannot execute the native
 *    suite, so it pins the suite instead: deleting a native regression breaks a
 *    test here rather than passing silently.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  parseWindowsArtifactManifest,
  WINDOWS_COMPONENT_CONFORMANCE,
  type WindowsArtifactManifest,
} from "../src/index.js";
import {
  describeWindowsPreFilterVerdict,
  windowsPreFilterClosure,
  windowsPreFilterImageName,
  WINDOWS_VERIFICATION_AUTHORITY,
  type ObservedClosureEntry,
} from "../src/windows-artifact-prefilter.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = join(packageRoot, "scripts", "manifest-conformance-fixture.json");
const NATIVE_DIRECTORIES = [
  join(packageRoot, "native", "windows-supervisor"),
  join(packageRoot, "native", "windows-helper"),
];

function fixture(): WindowsArtifactManifest {
  return parseWindowsArtifactManifest(JSON.parse(readFileSync(fixturePath, "utf8")) as unknown);
}

/** The closure exactly as the manifest describes it. */
function exactObserved(): ObservedClosureEntry[] {
  return fixture().files.map((entry) => ({
    name: entry.name,
    size: entry.size,
    sha256: entry.sha256,
  }));
}

/**
 * Extracts one method body from C# source by brace matching, so a test can
 * assert what a specific command emits rather than what the file mentions
 * somewhere.
 */
function methodBody(source: string, methodName: string): string {
  const signature = source.indexOf(`int ${methodName}(`);
  if (signature < 0) throw new Error(`method not found: ${methodName}`);
  const open = source.indexOf("{", signature);
  if (open < 0) throw new Error(`method body not found: ${methodName}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced braces in: ${methodName}`);
}

function nativeSource(): string {
  return NATIVE_DIRECTORIES.flatMap((directory) =>
    readdirSync(directory)
      .filter((name) => name.endsWith(".cs"))
      .map((name) => readFileSync(join(directory, name), "utf8")),
  ).join("\n");
}

describe("Stage 17 TypeScript verification is a pre-filter, never the enforcing check", () => {
  it("never claims to authorize and never claims to prove current bytes", () => {
    const manifest = fixture();
    const clean = windowsPreFilterClosure(manifest, exactObserved());
    expect(clean.refusal).toBeNull();
    // The two properties that make this a pre-filter. If either ever became
    // true, a Node-side hash would be standing in for the native check.
    expect(clean.enforcing).toBe(false);
    expect(clean.provesCurrentBytes).toBe(false);

    const verdict = describeWindowsPreFilterVerdict(clean);
    expect(verdict.verdict).toBe("requires-native-enforcement");
    expect(verdict.sufficientToSpawn).toBe(false);
  });

  it("records that only the native side holds handles and can request a share mode", () => {
    const { preFilter, enforcing } = WINDOWS_VERIFICATION_AUTHORITY;
    expect(preFilter.mayAuthorize).toBe(false);
    expect(preFilter.holdsFileHandles).toBe(false);
    expect(preFilter.canRequestWindowsShareMode).toBe(false);
    expect(preFilter.provesCurrentBytes).toBe(false);
    expect(enforcing.mayAuthorize).toBe(true);
    expect(enforcing.holdsFileHandles).toBe(true);
    expect(enforcing.canRequestWindowsShareMode).toBe(true);
  });

  it("refuses an extra closure file rather than ignoring it", () => {
    const manifest = fixture();
    const withExtra: ObservedClosureEntry[] = [
      ...exactObserved(),
      { name: "gamma.dll", size: 1, sha256: "0".repeat(64) },
    ];
    expect(windowsPreFilterClosure(manifest, withExtra).refusal).toBe("artifact-file-unexpected");
  });

  it("refuses a missing closure file", () => {
    const manifest = fixture();
    const partial = exactObserved().slice(0, 1);
    expect(windowsPreFilterClosure(manifest, partial).refusal).toBe("artifact-file-missing");
  });

  it("refuses exact and case-only duplicate entries", () => {
    const manifest = fixture();
    const observed = exactObserved();
    const first = observed[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    expect(
      windowsPreFilterClosure(manifest, [...observed, { ...first }]).refusal,
    ).toBe("artifact-file-duplicate");
    expect(
      windowsPreFilterClosure(manifest, [
        ...observed,
        { ...first, name: first.name.toUpperCase() },
      ]).refusal,
    ).toBe("artifact-file-duplicate");
  });

  it("refuses a size or digest that disagrees with the manifest", () => {
    const manifest = fixture();
    const observed = exactObserved();
    const first = observed[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    expect(
      windowsPreFilterClosure(manifest, [{ ...first, size: first.size + 1 }, ...observed.slice(1)])
        .refusal,
    ).toBe("artifact-file-size-mismatch");
    expect(
      windowsPreFilterClosure(manifest, [{ ...first, sha256: "1".repeat(64) }, ...observed.slice(1)])
        .refusal,
    ).toBe("artifact-file-digest-mismatch");
  });

  it("refuses a reparse point and an unsafe name in the observed closure", () => {
    const manifest = fixture();
    const observed = exactObserved();
    const first = observed[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    expect(
      windowsPreFilterClosure(manifest, [{ ...first, reparsePoint: true }, ...observed.slice(1)])
        .refusal,
    ).toBe("artifact-file-reparse-point");
    expect(
      windowsPreFilterClosure(manifest, [{ ...first, name: "sub/alpha.dll" }, ...observed.slice(1)])
        .refusal,
    ).toBe("artifact-file-name-invalid");
  });

  it("refuses an image name that escapes the verified closure", () => {
    const manifest = fixture();
    expect(windowsPreFilterImageName(manifest, "beta.exe").refusal).toBeNull();
    expect(windowsPreFilterImageName(manifest, "cmd.exe").refusal).toBe(
      "artifact-caller-selected-path-refused",
    );
    for (const escape of ["..\\..\\windows\\system32\\cmd.exe", "../beta.exe", "C:\\beta.exe", ".."]) {
      expect(windowsPreFilterImageName(manifest, escape).refusal).toBe("artifact-file-name-invalid");
    }
  });

  it("never reports an image name as sufficient to spawn", () => {
    const manifest = fixture();
    const verdict = describeWindowsPreFilterVerdict(windowsPreFilterImageName(manifest, "beta.exe"));
    expect(verdict.sufficientToSpawn).toBe(false);
  });
});

describe("Stage 17 native enforcing-side regressions are pinned from TypeScript", () => {
  it("keeps every required native self-test vector present in reviewed source", () => {
    const source = nativeSource();
    for (const vector of WINDOWS_VERIFICATION_AUTHORITY.requiredNativeVectors) {
      // Deleting a native regression must break a test, not pass quietly.
      expect(source, `missing native vector: ${vector}`).toContain(`"${vector}"`);
    }
  });

  it("pins the SEALED native conformance digest and vector count", () => {
    // The digest moved at this checkpoint because ADR 0018 section 4 replaced
    // the core suite's `gate/mutating-operations-structurally-disabled` vector,
    // which pinned the sealed answer into a suite BOTH recipes run and so made
    // a passing reviewed-proof self-test impossible. The replacement,
    // `gate/mutating-permitted-couples-to-recipe`, is strictly stronger in the
    // sealed direction and additionally covers the proof direction.
    //
    // A direct reviewed-proof recipe reports a different core digest by
    // construction. The combined packaging command deliberately keeps these
    // production-shaped components sealed and requires this exact pin, while
    // proof-only components are built and checked on their separate branch.
    expect(WINDOWS_COMPONENT_CONFORMANCE.coreVectorCount).toBe(165);
    expect(WINDOWS_COMPONENT_CONFORMANCE.coreConformanceDigest).toBe(
      "3b5ad6e8931cbe129dd5bda1fe8998853260466ea0525680d34276ad0bc77757",
    );
  });

  it("keeps the ownership-bearing lease, not a dispose-then-return file source", () => {
    const source = nativeSource();
    // The replaced abstraction hashed through a handle and disposed it before
    // returning. Its absence is the fix; its return would be the regression.
    expect(source).not.toContain("interface IArtifactFileSource");
    expect(source).not.toContain("ReadOnlyDirectoryArtifactFileSource");
    expect(source).toContain("internal sealed class VerifiedClosureLease");
    expect(source).toContain("ClosureMeasurementProvenance.ThroughHeldHandle");
    // FileShare.Read denies write AND delete. Widening it is the defect.
    expect(source).toContain("private const FileShare RequiredShare = FileShare.Read;");
  });

  it("keeps the mutation gate two-factor and sealed in the production recipe", () => {
    const source = nativeSource();
    expect(source).toContain("private const bool MutatingOperationsEnabled = false;");
    // The capability's only construction site must stay behind the build
    // constant, and no csproj may define that constant.
    expect(source).toContain("#if AIDEVOS_STAGE17_REVIEWED_PROOF_MODE");
    for (const directory of NATIVE_DIRECTORIES) {
      for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".csproj"))) {
        const project = readFileSync(join(directory, name), "utf8");
        expect(project).not.toContain("AIDEVOS_STAGE17_REVIEWED_PROOF_MODE");
        expect(project).not.toContain("DefineConstants");
      }
    }
  });

  it("emits the mutation-gate identity from BOTH read-only commands, in both components", () => {
    // Asserted per command body, not over the whole file: a field emitted by
    // self-test alone would leave describe-artifact silently unobservable, and
    // a whole-file grep cannot tell the two apart.
    for (const directory of NATIVE_DIRECTORIES) {
      const program = readFileSync(join(directory, "Program.cs"), "utf8");
      const selfTest = methodBody(program, "RunSelfTest");
      const describe = methodBody(program, "DescribeArtifact");
      for (const [command, body] of [
        ["RunSelfTest", selfTest],
        ["DescribeArtifact", describe],
      ] as const) {
        expect(body, `${directory}: ${command} does not stamp the mutation gate`).toContain(
          "MutationGate.Describe(",
        );
      }
    }
  });

  it("keeps the gate's observable field list single-sourced and sealed", () => {
    const source = nativeSource();
    expect(source).toContain('.Set("buildFlavor", BuildFlavor)');
    expect(source).toContain('.Set("proofModeCompiledIn", ProofModeCompiledIn)');
    // The sealed values themselves, from the non-proof-mode branch.
    expect(source).toContain('private const bool ProofModeRecipe = false;');
    expect(source).toContain('private const string BuildFlavorName = "sealed";');
  });

  it("makes the packaging pipeline refuse a binary whose gate contradicts the recipe", () => {
    const script = readFileSync(join(packageRoot, "scripts", "build-windows-artifacts.mjs"), "utf8");
    // Both the presence check and the value check must survive.
    expect(script).toContain("the mutation gate is unobservable in this binary");
    expect(script).toContain("mutationGate.commandsAgree");

    // ADR 0018 section 4 turned the one-directional check into a
    // two-directional one. Refusing to package a proof binary under the sealed
    // recipe is the obvious half; refusing to accept a SEALED binary under the
    // reviewed-proof recipe is the half that stops a proof run being conducted
    // in good faith against a binary that cannot perform it.
    expect(script).toContain("function assertGateMatchesRecipe(");
    expect(script).toContain('const expected = flavor === "sealed" ? SEALED_FLAVOR : PROOF_FLAVOR;');
    expect(script).toContain('const expectedProofMode = flavor !== "sealed";');
    expect(script).toContain("if (reported !== expected || proofMode !== expectedProofMode)");

    // Only the command line can define the proof constant. Production-shaped
    // components remain sealed even in a combined proof-artifact build and
    // must reproduce the sealed pin; proof-only components are checked against
    // their requested recipe before they can enter the separate proof report.
    expect(script).toContain('const REVIEWED_PROOF_CONSTANT = "AIDEVOS_STAGE17_REVIEWED_PROOF_MODE"');
    expect(script).toContain("the sealed production self-test results do not match");
    expect(script).toContain('const entryFlavor = flavorFor(entry, flavor)');
    expect(script).toContain("buildProofOnlyComponent(entry, out, flavor)");
    expect(script).toContain("reviewed-proof-bundles-are-never-installed");
    expect(script).toContain('if (flavor === "reviewed-proof" && !includeProofOnly)');
    expect(script).toContain("--flavor reviewed-proof requires --include-proof-only");

    const proofStart = script.indexOf("function buildProofOnlyComponent(");
    const proofEnd = script.indexOf("// ---------------------------------------------------------------------- main", proofStart);
    expect(proofStart).toBeGreaterThanOrEqual(0);
    expect(proofEnd).toBeGreaterThan(proofStart);
    const proofBody = script.slice(proofStart, proofEnd).replaceAll("\r\n", "\n");
    expect(proofBody).toContain(
      'if (differing.length > 0) {\n    fail(`${entry.component} proof-only builds were not byte-identical: ${differing.join(", ")}`);\n  }',
    );
    expect(proofBody).toContain(
      'describe.status !== 0 ||\n    describeJson.status !== "described" ||\n    describeJson.component !== entry.component',
    );
    expect(proofBody).toContain(
      'fail(`${entry.component} describe-artifact identity/status mismatch`);',
    );
    expect(proofBody).toContain(
      'if (selfTestJson.component !== entry.component) {\n    fail(`${entry.component} self-test component identity mismatch`);\n  }',
    );
  });

  it("keeps the native creation boundary free of any path-taking overload", () => {
    const source = nativeSource();
    // Process creation accepts a VerifiedImageReference, never a string path.
    expect(source).toContain("internal sealed class VerifiedImageReference");
    expect(source).toContain("internal static RefusalCode AssertCreationPermitted(");
  });
});
