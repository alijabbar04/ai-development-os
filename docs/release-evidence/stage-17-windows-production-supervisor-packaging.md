# Stage 17 Windows production supervisor and packaging checkpoint

Date: 2026-08-06

Outcome: **PACKAGED `unsigned-candidate` SUPERVISOR/HELPER PAIR, NEVER EXECUTED
BEYOND ITS READ-ONLY SELF-TEST. WINDOWS PRODUCTION REMAINS UNAVAILABLE.**

The binaries *were* executed, exactly three ways and no further: `self-test`,
`describe-artifact`, and an unknown-command refusal check. All three are
structurally incapable of creating host state. No mutating operation ran.

This is an artifact-boundary checkpoint. It does not prove native enforcement,
and nothing recorded here may be read as containment evidence.

## 1. Commits

| Role | Commit |
| --- | --- |
| Stage 17 HEAD at session start | `c2619d5095466f0d1bb2fcd62dc035351687d541` |
| Planning-document reconciliation (isolated) | `de2fa5e45aa4166c79c676855bc647477895389a` |
| Implementation and tests | `2b90bb26b4c5efc82c4bcde5b06443b871ea5e4d` |
| Audit fixes and regressions | `7dcfb869c27937b062edc03dc24d6108b4939c0a` |
| Evidence and documentation | this file's commit, `docs(stage17): record Windows supervisor packaging checkpoint` |

The audit ran against `2b90bb2`; `7dcfb86` closes five of its findings. Both are
retained rather than squashed, so the record shows audit then fix rather than a
single already-clean commit.

Branch: `feat/stage-17-secure-execution-backends`. No tag, push, release, or
remote change was made. Retained ancestors `c2619d5`, `cacf2ed`, and `77c4294`
were each verified as ancestors of HEAD.

## 2. Observed host and toolchain

Windows 11 Pro 10.0.26200, build 26200, x64. Node v24.17.0, npm 11.13.0,
git 2.54.0.windows.1, .NET SDK 9.0.316, Microsoft.NETCore.App 9.0.18. No
C/C++ compiler, Windows SDK, WSL distribution, container CLI, VM CLI, git
remote, or executable CI surface.

## 3. Authorization boundary actually observed

Performed: repository reads and edits; TypeScript and .NET builds; task-owned
temporary build, publish, package, install-simulation and consumer directories;
compiler, test-runner, package-manager and read-only self-test processes; local
`npm pack` tarballs installed only into task-owned temporary consumers; isolated
local commits.

Not performed: no AppContainer profile created or deleted; no AppContainer or
restricted-identity target launched; no Job Object created for the production
candidate; no supervisor recovery scenario run; no ACL or registry mutation; no
corpus vector and no positive control; no repository, provider, or
credential-bearing workload; no service, scheduled task, driver, firewall rule,
proxy, loopback exemption, certificate, or trust anchor; no global install; no
write to Program Files or a production application-data location; no signing; no
runtime download; no postinstall script; no publication; no tag, push, or remote
change; no GPT or Codex use.

## 4. Model sessions

| Session | Requested | Reported identity | Effort | Result |
| --- | --- | --- | --- | --- |
| Root coordinator | Fable 5 | Fable 5, `claude-fable-5` | xhigh | Baseline, threat model, ADR 0017, review, independent validation, commits |
| Implementation | Opus 5 | `You are powered by the model named Opus 5. The exact model ID is claude-opus-5.` | high | 137 tool uses, ~4,291,847 ms, 46 files staged, no commit |
| Native source inventory | inherited | read-only agent, 15 tool uses | — | Structured inventory of retained evidence tooling |
| Fresh final audit | Fable 5 | Fable 5, `claude-fable-5` | read-only | PASS with ten findings — section 16 |
| Fresh post-fix verification | Fable 5 | Fable 5, `claude-fable-5` | read-only | PASS, all five findings closed — section 16.1 |

No permission denial was raised against any session.

**Honest limitations on model identity.** Model identity inside Claude Code is
**self-reported**. There is no cryptographic or external attestation available
to this session, and the harness's own context is internally inconsistent: the
Bash tool's commit-trailer boilerplate reads "Claude Fable 5" even inside an
Opus 5 session. An initial identity probe was misled by that boilerplate and
reported the wrong name; a verbatim re-quote of the environment identity line
resolved it to Opus 5 / `claude-opus-5`. No model verdict in this file is
enforcement evidence.

**Tool restriction was applied by instruction, not by harness enforcement.** The
implementation session was told it had no browser, MCP, plugin, hook, or network
tool and no authority for stateful native actions. The harness did not gate
those tools. The boundary was verified after the fact — by reviewing the diff,
scanning the new sources for native interop and forbidden surfaces, and
measuring host residue — not by preventing the calls.

## 5. Architecture and trusted computing base

Recorded normatively in
[ADR 0017](../adr/0017-stage-17-windows-production-supervisor-packaging.md).
The load-bearing decisions:

- **Job ownership.** The supervisor creates and holds the private Job
  (kill-on-close, active-process limit, no breakaway). The helper receives only
  a duplicated handle for `PROC_THREAD_ATTRIBUTE_JOB_LIST`. Helper death cannot
  release kill-on-close, and the supervisor never needs the target's process
  handle — it terminates the exact Job, so no PID or image name is ever
  recovery authority.
- **Broker loss is fail-closed shutdown, not survival.** A supervisor with no
  control plane has no authority to serve; it detects pipe EOF, terminates the
  Job, cleans up, and exits. The helper does the same on its own pipe EOF, so
  when every Job handle closes the kernel kills the target.
- **Supervisor crash is covered by the journal, not by a process.** The design
  does not claim otherwise.
- **ACL restoration is designed out.** The helper never modifies the security
  descriptor of a pre-existing object; it creates fresh directories and sets
  their DACL at creation, so cleanup is "delete what we created".
- **The journal never trusts its own paths.** Recovery recomputes the profile
  name, staging root, and file names from the operation token and refuses on
  disagreement, so a substituted journal can at most name a different token,
  which derives a different, non-existent path.
- **The trust root is reviewed source, not the bundle.** A digest stored beside
  its binary is an index, not evidence. The pinned fingerprint table lives in
  compiled TypeScript and is empty.

The trusted computing base is enumerated in ADR 0017 section 3. The retained
feasibility probe and boundary fixture are **not** in it, and no file under
`src/` references either.

## 6. Protocol

Production protocol version 1, schema version 1, sharing no code with the
evidence tool's version 5. Four-byte little-endian length prefix; strict UTF-8
JSON; 8,192-byte frame bound; 262,144-byte connection bound; 32-frame bound;
exact property sets rejecting unknown, duplicate, and
`__proto__`/`constructor`/`prototype` properties; a linear monotonic state
machine from `request-accepted` to `cleanup-complete`; operation-token binding
on every frame; `CREATE_NEW` journal registration for replay prevention;
body-free refusal codes from a closed enum; one operation per fresh helper.

Honest residual: Windows has no argv-array process-creation API, so the helper
must compose an `lpCommandLine` from the argv array using the documented
`CommandLineToArgvW` inverse quoting rules with an exact `lpApplicationName`.
The round-trip vectors compare the composer against a **managed implementation**
of those rules, not against the Win32 function. Verifying against the real API
requires native interop execution, which was not authorized.

## 7. Artifact identity and deterministic packaging

Closure form: self-contained, `PublishSingleFile=false`, fixed and completely
enumerated. Single-file was rejected because the retained boundary fixture
demonstrably requires `DOTNET_BUNDLE_EXTRACT_BASE_DIR` redirection — a writable
extraction directory between verification and execution. Framework-dependent was
rejected because the runtime would then sit outside the enumerated trust
closure.

Manifest binding: schema 1, protocol 1, source version 1.0.0, build recipe 1,
platform win32, RID `win-x64`, architecture x64, package version 0.1.0, exact
file closure, corpus version 1, corpus fingerprint
`125b809194d26cf1be518249b96727b78be80c25088826464ec94154a6fb3652`, 40
Windows-applicable vectors, signer state `unsigned-candidate`,
`productionEligible: false`, and seven stable limitation codes:
`artifact-never-executed`,
`installed-source-trust-blocked-on-release-signing`,
`no-pinned-bundle-fingerprint`,
`path-redirection-needs-protected-install-root`,
`production-supervisor-recovery-unproved`, `unsigned-candidate`,
`windows-corpus-not-run`.

## 8. TypeScript fail-closed integration

Public (validation logic that grants nothing): `src/windows-artifact.ts` and
`src/windows-artifact-discovery.ts`.

Package-private, alongside `trusted-evidence.ts`:
`src/windows-artifact-install.ts` and `src/windows-recovery-journal.ts`. The
package export map exposes only `.` and `./testing`.

`src/platform-backends.ts` is byte-unchanged. The artifact seam was added as
separate modules rather than wired into `probe()`, because such wiring would be
provably unreachable duplication while the pinned table is empty.

## 9. Honest limitations recorded rather than papered over

1. **The TypeScript verifier cannot hold deny-write handles.** Node's `fs`
   cannot request a Windows share mode, so it hashes through an ordinary read
   handle and does **not** close the content-substitution window. ADR 0017
   section 6.5 was amended during review to assign the enforcing verification to
   the native supervisor — which uses `FileShare.Read` — and to state that the
   TypeScript check is a pre-filter that must never be the last check before
   execution.
2. **Path redirection remains open.** Renaming a parent directory can still
   redirect a verified path. Mitigating it needs an administrator-only install
   root, which is outside this authorization. Production blocker.
3. **Cross-language conformance is enforced at packaging time, not at
   `npm test`.** `npm test` verifies the TypeScript side against pinned digests
   and a checked-in fixture; only the packaging script re-checks the built
   binaries. A C# change that is not rebuilt would pass `npm test` and fail
   packaging.
4. **The two components duplicate the shared protocol core** so each stays an
   independently reviewable trust closure. Drift is caught by a source-parity
   digest and an identical runtime conformance digest, both build gates.
5. **Reproducibility is claimed for this host only.** Cross-machine
   reproducibility is not claimed. It was, however, reproduced from two
   different output roots by two different sessions (section 12).
6. **Unreachable discovery ordering is excluded from coverage** with a
   documented `c8 ignore` block, retained so the ordering of the remaining
   checks is reviewable now rather than invented at release time.
7. **`./testing` could not be exercised from a packed consumer** because it
   needs the optional `vitest` peer, deliberately not installed offline.
   Recorded as `requires-optional-vitest-peer` and backed by a static
   export-name scan, not reported as a pass.
8. **The deny-write handle is not held across process creation, and the
   delivered abstraction cannot express it.** `IArtifactFileSource.TryMeasure`
   disposes its `FileShare.Read` handle and returns only a size and a digest,
   so ADR 0017 section 6.5 step 4 — the load-bearing TOCTOU property — needs
   interface rework before any execution path can rely on it. ADR 0017 section 9
   already classifies this as "requires implementation"; it is restated here so
   the reviewed file is not credited with more than it delivers.
9. **Recovery journals are integrity-checked but unauthenticated.** The record
   digest is keyless SHA-256, so anyone who can write the journal directory can
   mint validly framed journals for fresh tokens that pin arbitrary bundle
   versions and thereby block removal indefinitely with
   `artifact-removal-recoverable-version`. This cannot cause deletion, because
   every deletion path recomputes its targets from the token. The residual is
   availability-only and fail-closed, and an authenticated journal is future
   work.
10. **Conformance drift is only vector-deep.** The C# and TypeScript
    implementations are cross-checked by fixed vectors, so behaviour the vectors
    do not cover can diverge. The audit found exactly this in two validators
    (see section 16); they were tightened and given vectors, but the general
    guarantee is "vector-covered behaviour is drift-proof", not "the two
    implementations are identical".
11. **Three further instances of the same drift class are known and left in
    place.** `ArtifactManifestReader.TryParse` in C# accepts any string for
    `signerState`, any string for `component`, and any string array for
    `limitations` (checking only sort order), whereas the TypeScript parser
    enforces closed enumerations for all three. Both sides still refuse every
    bad value — C# does so at `ArtifactManifestVerifier.VerifyIdentity` rather
    than at parse time — so this is a layering difference, not a hole. It was
    deliberately not changed in this checkpoint: it is not a defect, and
    tightening it would move the role-vector expectations and both manifest
    fingerprints for no change in what is accepted. It is recorded here so the
    next checkpoint inherits the knowledge rather than rediscovering it.

## 10. Weaknesses observed in the retained evidence tooling

Found by read-only inspection; recorded rather than fixed, because they are
test-only surfaces and editing them would mix evidence-tool changes into a
production-candidate commit. None is on a production path.

1. `windows-boundary-fixture` `RunChildPositiveControl` validates its marker
   path far more weakly than `RunChild`, accepting any path whose parent exists
   and whose file does not, then spawning a child and creating a file there.
2. The fixture's boundary-marker branch resolves "temp" from the `TEMP`
   environment variable, which the parent fully controls through the synthesized
   environment block. The lifecycle branch is stronger: it derives the expected
   marker root from the fixture's own executable filename token.
3. `RecoverLifecycleResources` passes `profileCreated: true` unconditionally, so
   recovery calls `DeleteAppContainerProfile` for a token-derived name even when
   that run never created it. Bounded by the 128-bit token and by documented
   idempotency.
4. The four prior-count caps are caller-supplied with no persistent ledger;
   re-running with `0 0 0 0` restarts the budget. Cap enforcement is out-of-band.
5. `helper-lifecycle-worker` is dispatchable from any command line given three
   positive decimal integers and is not printed in usage text. Its practical
   protection is handle parsing plus self-image digest validation.
6. `ScanLifecycleResidue` enumerates all machine processes and reads
   `MainModule.FileName`. Read-only and count-only, but machine-wide in scope.
7. `SyntheticProcessProof.cs` declares an unreferenced constant `StillActive`.

## 11. Truth table disposition

`docs/release-evidence/stage-17-platform-truth-table.json` was **not changed**.
Its Windows entry has fields for a shipped `helper`, `protocolVersion`, and
`artifactDigest` but none for signer state, determinism, "never executed", or
"not installed". Populating `protocolVersion` or `artifactDigest` would imply a
shipped artifact; adding keys would change the schema. Its existing blocker
`windows-production-helper-and-complete-native-composition-unimplemented`
remains true, because no mutating operation is implemented. Silence about a
never-executed candidate is not a falsehood, so the file was left alone and this
disposition recorded instead.

## 12. Measured validation

Every number below was produced by the coordinator re-running the gate itself,
not copied from the implementation session's report. Where the implementation
session had also measured a value, the two agreed exactly.

### Build, tests, coverage

All figures are the **final post-fix** state at `7dcfb86` unless marked
otherwise.

| Gate | Result |
| --- | --- |
| `process-broker` typecheck | clean |
| `process-broker` build | clean |
| `process-broker` tests | **381 passed, 0 failed, 0 skipped** (6 files) |
| Statement coverage | **92.37 %** (2071/2242), threshold 90 |
| Branch coverage | **85.74 %** (1251/1459), threshold 80 |
| Function coverage | **98.31 %** (350/356), threshold 90 |
| Line coverage | **93.53 %** (1983/2120), threshold 90 |
| `workspace` tests | 107 passed, 0 failed (3 files) |
| `provider-claude-code` tests | 255 passed, 7 skipped (10 files) |
| `provider-codex` tests | 89 passed, 4 skipped (3 files passed, 1 skipped) |
| `git diff --cached --check` | clean |

Thresholds in `vitest.config.ts` were not modified. Baseline before this
checkpoint was 319 tests. 57 were added by the implementation commit and a
further 5 by the fix commit — one regression per closed audit finding, each
named after its finding id. No pre-existing test was modified or weakened.

### Deterministic native build

Two clean publishes per component, into separate intermediate and output
directories, then a byte-for-byte closure comparison.

| Fact | Supervisor | Helper |
| --- | --- | --- |
| Byte-identical across two builds | **true** | **true** |
| Differing files | 0 | 0 |
| Closure file count | 188 | 188 |
| Closure bytes | 77,995,239 | 77,996,763 |
| Manifest fingerprint | `19221819609ae520f1149cd675e5622e7dc48c1f4122bb9846b3c4161130c739` | `d5e80dbfa2848ad189e7af3a0ebbf8eccdab9a481cb8ad10a261511b737c9e67` |
| Source envelope fingerprint | `45de355b875aca610aad5a68efbf42aaf6f54b9b51587e071cb103b6b63a12ea` (17 files) | `33d2a27ee1768cf8099e90cae42db9206dd97388c777b1f194bc6e486ac32411` (18 files) |
| Build manifest fingerprint | `d98d25955a4e96c25745086425784e65b0594b4a53bb031199c125c25a76126d` (both, SDK 9.0.316, recipe 1) | |
| Shared-core parity digest | `3db786f20d22f669ccb73c8f1b1ea4c38dca32fedf0971fd2584772f7f48cd07` over 13 files, identical for both | |
| Rejected entries (PDB, source, cache, temp, unexpected, duplicate, reparse) | 0 | 0 |

The coordinator's runs used a **different output root** from the implementation
session's and produced identical fingerprints both before and after the fixes,
which also demonstrates that `PathMap` removed build-path dependence.

The manifest and source-envelope fingerprints necessarily changed between
`2b90bb2` and `7dcfb86`, because F-005 renamed a limitation code carried in
every manifest and F-006 altered the conformance suite. The pre-fix values were
supervisor `d4444a93…` / helper `2f98c116…`, recorded here so the change is
traceable rather than silent.

### Read-only native self-tests

| Fact | Supervisor | Helper |
| --- | --- | --- |
| `self-test` exit code / status | 0 / passed | 0 / passed |
| Core vectors | 110, 0 failed | 110, 0 failed |
| Role vectors | 27, 0 failed | 53, 0 failed |
| Core conformance digest | `af25a90c021deee3d617db1c8bb3663457cc4e48bda9d42ccff6a597d9e284d8` | identical |
| `mutatingOperationsPermitted` | false | false |
| `hostStateCreated` | false | false |
| `describe-artifact` matches manifest | true | true |
| Unknown command | exit 64, `unknown-command` | exit 64, `unknown-command` |
| Pinned conformance matches observed | true | true |

Core vectors moved 105 → 110 in the fix commit: one tautological vector became
a real pinned assertion and five new vectors were added, one per closed
finding.

Cross-language manifest identity: the TypeScript implementation, the supervisor
binary, and the helper binary all produce fixture fingerprint
`c39961a4a6946201758403a86fe25795c89e70f607a1c6e3642c292419663054`.

The `manifest/digest-source-parity` vector added for F-001 was demonstrated to
be a real regression test, not a decorative one: the implementation session
temporarily reintroduced the double hash, rebuilt, and observed
`status: failed, failedVectorCount: 1,
failedVectors: ["manifest/digest-source-parity"]`, then restored the fix and
observed `passed`. A regression test that has never been seen to fail proves
nothing, so this was checked rather than assumed.

### Installed-package simulation (simulated, non-enforcement)

Both components installed and verified as `unsigned-candidate` with
`productionEligible: false`, then removed exactly (188 files each). Observed
refusal codes: `artifact-manifest-fingerprint-unpinned` for an unpinned bundle,
`artifact-destination-exists` for an in-place overwrite, and
`artifact-removal-active-version` for removing an active version. Recovery
resumed no removals and quarantined nothing in the clean run. **Residue inside
the simulated root: 0 entries.**

### Package and consumer

| Gate | Result |
| --- | --- |
| `npm pack --dry-run` | **118 files, 157,563 packed bytes, 732,772 unpacked bytes** |
| Non-`dist` entries | `README.md`, `package.json` only |
| Native sources, `.csproj`, scripts, tests, binaries in tarball | none |
| Export map | `.` and `./testing` only |
| Public export count from the packed tarball | 161 |
| Issuer-shaped public exports | **0** |
| Tracked binaries anywhere in the repository | **0** |

A real tarball was packed and extracted into a temporary consumer with its
workspace dependency closure. Node's resolver refused every deep import with
`ERR_PACKAGE_PATH_NOT_EXPORTED`:
`dist/trusted-evidence.js`, `dist/windows-artifact-install.js`,
`dist/windows-recovery-journal.js`, `dist/index.js`, and `package.json`. Only
`.` and `./testing` resolved. The shipped `index.js` was read line by line: it
re-exports `projectVerifiedProductionRegistration` alone from
`trusted-evidence.js` and does not export the installer, the journal reader, the
escape corpus, or either issuer. The strings `windows-artifact-install` and
`windows-recovery-journal` do appear in `index.js` but only inside a source
comment preserved by `tsc`.

Observed from the packed package on this host:

- Windows `securityClass`: `unavailable`
- Capabilities: `filesystemIsolation`, `processTreeControl`, `identityIsolation`,
  `profileIsolation` all **false**; `networkBoundary` `unsupported`
- All eight quota dimensions: **`unsupported`**
- `probe()` and `validateGrant()`: `{available:false, reason:"not-implemented",
  detail:"windows-native-process-composition-and-corpus-unverified"}`
- `prepare()`: refused, `BACKEND_UNAVAILABLE`
- `spawn()`: refused, `BACKEND_UNAVAILABLE`
- Pinned bundle fingerprint table length: **0**
- `discoverWindowsArtifactBundle()`: refused,
  `artifact-bundle-not-pinned`
- `describeWindowsArtifactSeam()`: `productionEligible false`,
  `anyComponentDiscovered false`, `changesPlatformAvailability false`
- Escape corpus in the shipped `dist`: 42 canonical vectors

### Scans

| Scan | Result |
| --- | --- |
| Secret scan over staged sources | 0 findings |
| Forbidden-surface scan of new native sources (network, DNS, registry, environment, process start, shell, reflection) | 0 code matches; every hit is a doc comment |
| `using` namespaces in new native sources | `System`, `System.Buffers.Binary`, `System.Collections.Generic`, `System.Globalization`, `System.IO`, `System.Security.Cryptography`, `System.Text`, `System.Text.Json` — no `System.Net`, `System.Diagnostics`, `Microsoft.Win32`, `InteropServices`, or `Reflection` |
| P/Invoke, `Marshal`, `Process.Start` in new native projects | **0 occurrences** — mutating operations are unimplemented, not merely gated |
| Filesystem-write APIs in new native projects | **0 occurrences** |
| `PackageReference` / `ProjectReference` in either `.csproj` | **0** each; `NuGet.Config` clears every source, so restore is offline |
| The two `.csproj` files | identical modulo the component name |
| Dependencies | unchanged: 3 workspace dependencies, 0 dev dependencies |
| Staged files under `bin/` or `obj/` | 0 |

## 13. Independent verification by the coordinator

Every figure in section 12 was produced by the coordinator re-running the gate,
not transcribed from a delegated session's report. That includes a second
complete packaging run into a different output root, a real `npm pack` tarball
extracted into a temporary consumer, a line-by-line read of the shipped
`index.js`, and direct observation of the Windows descriptor, `probe()`,
`validateGrant()`, `prepare()`, and `spawn()` through the packed package.

Where a delegated session had also measured a value, the two agreed exactly.
Two claims from delegated reports were checked and **corrected**: the retained
fixture's publish artifacts were reported as committed but are untracked and
gitignored (`git ls-files` finds zero tracked binaries anywhere), and an initial
model-identity probe misread commit-trailer boilerplate as its own model name.

## 14. Host mutations and residue

The implementation session used a task-owned temporary root under `%TEMP%`
(peak roughly 603 MB) plus one marker file, and deleted both. The coordinator
ran its own verification into a separate task-owned scratch directory
(600 MB packaging root plus a 2.1 MB consumer) and deleted both after
extracting results. In-repository `bin/` and `obj/` directories created during
native iteration were deleted.

Measured after cleanup:

| Check | Result |
| --- | --- |
| Files in the two new native project directories | 35, all `.cs` / `.csproj` / `NuGet.Config` |
| `%TEMP%` entries matching this session's prefixes (`aidevos-stage17-*`, `aidevos-s17-*`) | **0** |
| AppContainer package folders matching `AiDevOs` | **0** |
| `HKCU\...\AppContainer\Mappings` entries matching `AiDevOs` | **0** |
| `HKCU\...\AppContainer\Storage` | key absent |
| Live supervisor / helper / probe / fixture processes | **0** |
| Tracked binaries in the repository | **0** |

Gitignored `dist/` and `coverage/` were regenerated by ordinary build and test.
The npm cache received locally packed tarballs. The NuGet global cache was
read-only: every package source is cleared, so restore cannot reach the network.
No service, scheduled task, driver, firewall rule, proxy, certificate, registry
value, ACL, or global install was created.

**Pre-existing residue not created by this session, reported rather than
removed.** `%TEMP%` contains 22 directories matching `ai-dev-os-stage17-*`,
timestamped 10:39–11:14 on 2026-08-06 — before this session's first command.
They are build-check, compile, and staging scratch directories from the *prior*
helper-lifecycle checkpoint (`77c4294` / `cacf2ed`), with names such as
`ai-dev-os-stage17-lifecycle-build-check-N` and
`ai-dev-os-stage17-helper-lifecycle-final-vN`. This does **not** falsify the
prior checkpoint's zero-residue claim: that scan targeted the pattern
`^ai-dev-os-stage17-helper-(proof|canary)-[a-f0-9]{32}$`, and none of these 22
match it. It does show that the prior residue scan's scope was narrower than
"all task-related temporary directories". No AppContainer profile, registry, or
process residue accompanies them. This session did not create them and therefore
did not delete them.

## 15. Failed attempts, retained as failed

From the implementation session; each remains a failure regardless of the later
fix.

1. A scratch build proved that testing a compile-time `false` constant inline
   emits CS0162, which `TreatWarningsAsErrors` turns into a build failure. The
   gate now reads the constant through a property with no setter and no backing
   field.
2. Supervisor build 1 failed with five analyzer errors under
   `AnalysisLevel=latest-all` (four CA1859, one CA1812).
3. Supervisor self-test 1 failed 6 of 105 core vectors: placeholder pinned
   derivations, wrong fixture digests, and a sequence-runner bug.
4. Helper self-test 1 failed 2 of 53 role vectors: tab was wrongly rejected as a
   control character.
5. Packaging run 1 exited 1 with CS0579 duplicate assembly attributes — a stale
   in-tree `obj/` was swept in once `BaseIntermediateOutputPath` was redirected.
   Both projects now exclude `bin/**` and `obj/**` explicitly.
6. Packaging run 2's install simulation returned `artifact-staging-incomplete`
   where `artifact-destination-exists` is correct; the destination check was
   moved first.
7. Packed-consumer attempt 1 hit an npm 404 because workspace dependencies are
   unpublished; the local closure was packed offline instead.
8. Packed-consumer attempt 2 could not exercise `./testing`, which needs the
   optional `vitest` peer. Recorded as `requires-optional-vitest-peer`, not
   reported as a pass.

## 16. Fresh Fable audit result

A fresh Fable 5 session (self-reported `claude-fable-5`) audited base
`de2fa5e45aa4166c79c676855bc647477895389a` against candidate
`2b90bb26b4c5efc82c4bcde5b06443b871ea5e4d`, read-only, with no shared
implementation context beyond the committed repository, the four pending
documentation files, and a bounded audit request. 64 tool uses.

**Verdict: PASS.** A model verdict is not enforcement evidence and is not
treated as such here.

Ten findings were returned. Five were fixed with regressions; five are recorded
as documentation or known limitations.

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| F-001 | medium | `ArtifactManifest.TryMeasure` passed an already-computed digest into `Sha256Hex`, producing `hex(SHA256(SHA256(file)))` while every other source produced `hex(SHA256(file))`. `VerifyInstalledClosure` would have rejected every genuine file of every genuine bundle. The 105-vector suite could not detect it because it exercised only the in-memory source. | **Confirmed by the coordinator independently. Fixed**, with a new vector that measures the same bytes through both sources and asserts equality. |
| F-002 | low | The `FileShare.Read` handle is disposed inside `TryMeasure`, so ADR 0017 section 6.5 step 4 cannot be expressed by the delivered interface. | Recorded, section 9.8. Already classified "requires implementation" in ADR 0017 section 9. |
| F-003 | low | C# accepted component names and leading `-`/`_` file names that TypeScript rejected, while comments claimed the implementations were identical. | **Fixed** by tightening C# to the stricter TypeScript rule, with vectors for the previously divergent inputs. |
| F-004 | low | `segmentIssue` permitted `~`, so a DOS 8.3 alias passed the normalization-ambiguity check that ADR 0017 section 6.5 claims refuses it. | **Fixed** with tests. |
| F-005 | low | The limitation code `artifact-never-executed` and the evidence headline were unqualified, though the binaries run `self-test`, `describe-artifact`, and an unknown-command check. | **Fixed** in both places: the code is renamed and the headline now states exactly what ran. |
| F-006 | informational | A conformance vector compared a value against itself and could never fail, inflating the advertised vector count; an unused helper double-hashed like F-001. | **Fixed.** |
| F-007 | informational | ADR 0017 section 7 said a tampered bundle "is quarantined", implying automation that does not exist. | Recorded: ADR wording corrected to say quarantine is an explicit operation, with the reason automation is deliberately avoided. |
| F-008 | informational | Evidence wording "unreachable from the packed tarball" read stronger than the truth: export-map privacy is namespace privacy, not an authorization boundary. | Recorded: section 17 now states the limit explicitly and points at ADR 0014's disclaimer. |
| F-009 | informational | Evidence file had unresolved internal cross-references and commit-SHA placeholders. | Resolved in this file. |
| F-010 | informational | Recovery journals are integrity-checked but unauthenticated, so a forged journal can block removal indefinitely. Cannot cause deletion. | Recorded, section 9.9. Availability-only, fail-closed. |

The auditor also listed what it could **not** verify read-only, and this file
does not claim otherwise: test and coverage numbers, two-build byte identity,
closure counts and fingerprints, that the pinned conformance digests match what
the binaries emit, the npm pack inventory, host residue, and the model-session
table. Every one of those was measured independently by the coordinator and is
recorded in section 12; none is attested by the auditor.

Because F-001 is security-relevant, a fresh bounded post-fix verification was
obtained; its result is in section 16.1.

### 16.1 Post-fix verification

A second fresh Fable 5 session (self-reported `claude-fable-5`), read-only and
bounded to one question, verified `2b90bb2..7dcfb86`. 47 tool uses.

**Post-fix verdict: PASS.** All five findings **CLOSED**, with no new defect
introduced and no regression in the security posture. Again, a model verdict is
not enforcement evidence.

What the verification added beyond confirming the fixes:

- **F-001 is protected by a known-answer vector, not only a parity vector.**
  The verifier noted that `manifest/digest-source-parity` alone would miss a
  *coordinated* regression in both sources, but `manifest/file-digest-known-vector`
  pins `SHA-256("123")` to its true value `a665a459…7ae3`, and the fixture's own
  file digests are the true single SHA-256 of `"123"` and `"1234"`. All three
  implementations — C# span, C# stream, and the Node script — therefore converge
  on one externally checkable convention.
- **Vector counts were hand-counted, not trusted.** Exactly 110 unconditional
  `vectors.Add(` calls in `CoreConformance`, against 105 pre-fix: the +5 delta
  matches the five added vectors, and the TypeScript pin agrees. The escape
  corpus was likewise hand-counted to 42 canonical and 40 Windows-applicable.
- **File-name rules were compared rule by rule** across C# and TypeScript —
  length, first-character class, character class, trailing dot and space, `..`,
  the same 22-entry reserved-device list, stem derivation, and ASCII
  case-insensitivity — with the conclusion that no string is accepted by one and
  rejected by the other.
- **Rename ripple effects were checked adversarially.** The role suites consume
  the renamed fixture, but only through `VerifyIdentity`, whose outcome does not
  depend on the limitations string — which is why the role pins (27 and 53) and
  their digests legitimately did not move.
- **No legitimate path contains a tilde**, checked against component names,
  the `SEMVER_PATTERN` for bundle versions, the RID, the staging, quarantine and
  removal-marker names, and the quarantine label pattern — so F-004's refusal
  cannot cause a false negative.

One residual observation, recorded because it is a real if narrow gap: the
parity vector exercises `TryMeasureStream`, the tested seam, rather than the
`FileStream`-opening wrapper around it. That is sound while the wrapper only
delegates, but a future change that re-inlines the hash into `TryMeasure` would
escape the vector. Anyone touching that method must keep the digest in the
tested seam.

## 17. Exact Windows truth state

Unchanged by everything in this file:

- Windows backend: **unavailable**, ID `windows-restricted-job-object`, stable
  detail `windows-native-process-composition-and-corpus-unverified`.
- Production execution: **refused**, before `prepare()`.
- Isolation capabilities: filesystem, process-tree, identity, and profile all
  **false**; network boundary `unsupported`.
- Quotas: all eight dimensions **unsupported**.
- Production registration: **unavailable**; the issuer is package-private and
  unreachable through the package export map — from `.`, from `./testing`, and
  from any deep import of the packed tarball. That is namespace privacy, not an
  authorization boundary: the compiled module ships in the tarball and code that
  can already execute arbitrary file-URL imports inside the trusted Node process
  can still load it, exactly as ADR 0014 disclaims. It buys nothing for an
  attacker here, because the Windows backend refuses `prepare()` and `spawn()`
  unconditionally regardless of any registration.
- Preparation receipt: **unavailable**.
- Windows actual-native corpus: **0/40 `not-run`**, positive controls not run.
- Controlled provider egress: **unavailable**.
- Stage 17: **gated**. Stage 18: **blocked**. Stage 17 release tag: **absent**.

None of the following changes any line above: successful compilation, passing
tests, high coverage, deterministic packaging, successful package simulation,
Fable analysis, Opus implementation, a Fable PASS, a canonical manifest, an
unsigned candidate artifact, or mock and fake supervisor tests.

## 18. Smallest separately authorized next action

A bounded stateful installed-artifact and production-supervisor recovery proof
with explicit scenario, profile, supervisor, helper, target, and total-process
caps. The armed 40-vector Windows corpus comes only after that
production-shaped lifecycle proof passes.
