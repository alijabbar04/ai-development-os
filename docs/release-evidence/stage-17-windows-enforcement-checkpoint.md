# Stage 17 Windows feasibility checkpoint evidence

Date: 2026-08-05

Outcome: **GATED — the Windows production backend is unavailable**

This is an Outcome B feasibility checkpoint, not a Windows enforcement result
or a Stage 17 release. No AppContainer profile, ACL, Job Object, native target
process, production registration, or production session receipt was created.
Windows actual-native evidence remains 0/40 with no positive control run.
Production continues to refuse before `prepare`/`spawn`, Stage 17 remains
gated, Stage 18 remains blocked, and no `v0.17*` tag or push is permitted.

## Provenance and Git lane

- Worktree:
  `C:\Users\mrali\Projects\ai-dev-os-stage-17-secure-execution`.
- Branch: `feat/stage-17-secure-execution-backends`.
- Stage 16 annotated tag object:
  `9fbaf6e1d7cbae7e026b1dadae6109ac46a884e4`.
- Stage 16 peeled commit:
  `c344b1e9264e5306fb648abaa7add6cebc17c3cc`.
- Starting Stage 17 checkpoint:
  `08666171b7f15caecf6aa95beba4e1005bf15af9`.
- Audited Windows feasibility candidate:
  `d129c65e72f650b3bb02d16465fd3fc1da78a43c`.
- The Stage 16 commit is an ancestor of both the starting checkpoint and the
  audited candidate. The continuation is one linear commit at the audit
  boundary.
- No Git remote is configured, no executable remote CI surface was available,
  no push occurred, and `git tag -l "v0.17*"` was empty.

The evidence commit containing this document follows the audited candidate.
The final handoff records the post-evidence HEAD and final-tree Git checks; it
is intentionally not a release tag.

## Architecture result

ADR 0015 selects no production implementation at this checkpoint. The
experimental `processmodel.dll` route is rejected because Microsoft documents
FlatBuffer identifier `SBOX` and schema version `0.1.0` but neither the
installed host nor the published Microsoft documentation/source supplied the
authoritative `SandboxSpec.fbs` table layout or generated bindings. Field
ordinals were not inferred and no unofficial schema was copied.

The preferred next experiment is a documented public Win32 composition:

- a unique same-user AppContainer or LPAC identity with no network capability;
- a task-owned staged filesystem whose explicit ACL grants only that identity;
- `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, a narrow handle list, and a
  creation-time Job list in one `STARTUPINFOEX` attribute list;
- a private Job with kill-on-close and no breakaway flags; and
- deterministic handle, process, Job, ACL, profile, and directory teardown.

That design is future work, not a current boundary. AppContainer profile
creation persists per-user folders and registry state. Complete removal under
ordinary-user failure and open-handle conditions has not been authorized or
proved, so the stop rule prohibited profile creation. A restricted token or a
Job Object alone was rejected as insufficient for filesystem and network
containment.

## Observed host and read-only probe

| Item | Exact observation |
| --- | --- |
| OS | Microsoft Windows 11 Pro 10.0.26200, build 26200, x64 |
| Processor | 12th Gen Intel(R) Core(TM) i7-12800H |
| Node/npm/Git | Node 24.17.0; npm 11.13.0; Git 2.54.0.windows.1 |
| .NET | SDK 9.0.316; Microsoft.NETCore.App 9.0.18 |
| Other tooling | no C/C++ compiler, public Windows SDK include tree, .NET workload, WSL installation, container CLI, VM CLI, or Linux/macOS runner found |
| System DLL | `C:\Windows\System32\processmodel.dll`, 192,512 bytes, file/product version 10.0.26100.8737 |
| System DLL SHA-256 | `eff290093568efbe27f3918112f3b5f44e8980412d07addfcd69ca7a03f61049` |

The repository-owned `net9.0-windows` diagnostic loaded the exact System32
DLL with `LOAD_LIBRARY_SEARCH_SYSTEM32`, confirmed both experimental exports,
confirmed the listed public AppContainer/Job/process/restricted-token exports,
hashed the DLL, and observed that the current Codex process is already in a
Job. That parent observation does not prove nested child-Job behavior.

Loading a DLL necessarily runs that trusted Windows DLL's load-time
initialization (`DllMain`) in the diagnostic process. No mutating export was
resolved to a delegate or invoked. The diagnostic created no profile, ACL,
Job, or child process and always reported
`authoritative-sandbox-schema-and-profile-lifecycle-unverified` with exit 2.
It is evidence tooling, not the future sandbox helper.

## Diagnostic build, protocol, and identity

The source project enables nullable analysis, latest recommended SDK analyzers,
warnings as errors, deterministic/CI builds, deterministic source paths,
checked arithmetic, no unsafe code, no debug symbols, no apphost, and no
NuGet or project dependency. Two clean Release builds used separate random
task-owned output and intermediate directories:

```powershell
dotnet build .\packages\process-broker\native\windows-feasibility-probe\AI.DevOS.WindowsSandboxFeasibilityProbe.csproj `
  --configuration Release --output <task-owned-build-N\out> `
  -p:BaseIntermediateOutputPath=<task-owned-build-N\obj\>
```

Both builds completed with 0 warnings and 0 errors and produced byte-identical
manifests:

| Payload | Bytes | SHA-256 |
| --- | ---: | --- |
| `AI.DevOS.WindowsSandboxFeasibilityProbe.deps.json` | 509 | `edb3906cbfcc8e80f3dbc56769089ce90f7a0efd0e821a09f5abffb65f4571b5` |
| `AI.DevOS.WindowsSandboxFeasibilityProbe.dll` | 32,768 | `31fa2c9bc61bd692c30f5c521fc43e93094a348f7109df37629a8331d85029b3` |
| `AI.DevOS.WindowsSandboxFeasibilityProbe.runtimeconfig.json` | 397 | `e3a9d5d0a25ca066e8b70401b5869b5cfc92d16f5fe89b83077cdfd4b7427711` |

Recorded identities are:

- source digest:
  `45d65a2a19de6810b5dcba104cf2a7199a4c4997f1dd826bb421fc206f57973f`;
- invoked DLL digest:
  `31fa2c9bc61bd692c30f5c521fc43e93094a348f7109df37629a8331d85029b3`;
- build-envelope digest:
  `3886764cfa2a450cff1adfcad357d1d04c57cebc10e94dd192a74896f524b5ee`.

The source digest is SHA-256 over the ordinally sorted relative paths
`AI.DevOS.WindowsSandboxFeasibilityProbe.csproj` and `Program.cs`; each UTF-8
path, a NUL byte, the raw file bytes, and a trailing NUL byte are added in that
order. The README is intentionally not invoked source.

The build digest is SHA-256 over compact UTF-8 JSON with ordered keys
`algorithm`, `sdk`, `runtime`, `targetFramework`, `runtimeIdentifier`,
`configuration`, `deployment`, `deterministic`, `warningsAsErrors`, `unsafe`,
and `files`. The values are respectively
`stage17-windows-feasibility-build-v1`, `9.0.316`,
`Microsoft.NETCore.App 9.0.18`, `net9.0-windows`, null, `Release`,
`framework-dependent-no-apphost`, true, true, false, and the filename-sorted
manifest above with ordered `name`, `length`, and `sha256` keys.

Protocol version 1 has only `probe` and `self-test`. Using the first payload,
which was byte-identical to the second, the final protocol evidence was:

- `dotnet <payload.dll> self-test`: exit 0, deterministic output true,
  body-free output true, no profile/process mutation;
- `dotnet <payload.dll> probe`: exit 2, stable unavailable reason, exact host
  and export observations, no path or user body;
- `dotnet <payload.dll> unsupported`: exit 64 with
  `unsupported-command`; and
- `dotnet <payload.dll>`: exit 64 with
  `exactly-one-command-required`.

All task-owned build directories were removed after digest verification.

## Process-broker integration and native proof boundary

The Windows factory keeps backend ID `windows-restricted-job-object`, an
`unavailable` descriptor, every isolation capability false, network boundary
`unsupported`, and every quota dimension `unsupported`. On Windows,
`probe()` and `validateGrant()` return the same stable unavailable detail. On
other platforms, the existing `unsupported-platform` result remains. The
diagnostic is never loaded or invoked by the factory and cannot access the
package-private registration or receipt issuers.

The npm `files` allowlist remains only `dist` and `README.md`; no diagnostic
source or payload ships. There is no production helper protocol, digest lookup,
registration/receipt issuance, signing decision, native installed-package
execution path, or supported runtime prerequisite.

| Native claim | Result |
| --- | --- |
| Corpus version/seed/fingerprint | v1 / `stage-17-corpus-seed-0001` / `125b809194d26cf1be518249b96727b78be80c25088826464ec94154a6fb3652` |
| Canonical / Windows-applicable vectors | 42 / 40 |
| Actual-native candidate vectors | 0 |
| Armed open positive controls | 0; not run |
| Native failures/skips | none executed; 40 applicable vectors unrun |
| Profile/ACL/Job/target process | none created |
| Enforcement conclusion | none; Outcome A is not claimed |

## Package and repository validation

The exact audited candidate ran these gates successfully:

```text
npm run typecheck --workspace @ai-dev-os/process-broker
npm run test --workspace @ai-dev-os/process-broker
npm run test:coverage --workspace @ai-dev-os/process-broker
npm run build --workspace @ai-dev-os/process-broker
```

The package result was 5/5 files and 319/319 tests. The Stage 17 mocked
security file is 77/77; it is protocol/admission evidence, not native
enforcement evidence.

| Scope | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Process broker | 1,597/1,729 (92.36%) | 995/1,158 (85.92%) | 293/298 (98.32%) | 1,539/1,655 (92.99%) |

All required thresholds (90/80/98/90 percent) were met without exclusions.
New regressions cover exact Windows fail-closed detail, grant/endpoint
canonicalization, duplicate approvals, lease/abort callbacks, stdin and
duplex failure settlement, a real unsafe-backend lifecycle path, and body-free
backend-loss mapping.

For each direct reverse consumer, `typecheck`, `test`, and `build` passed:

- workspace: 107/107;
- Claude Code provider: 255 passed, 7 intentional live skips; and
- Codex provider: 89 passed, 4 intentional live skips.

One uninterrupted root `npm run check` exited 0 in 1,325.530 seconds across
all 32 workspaces. The command transcript exceeded the wrapper display limit;
exit 0 is the authoritative repository gate. The auxiliary count is separately
reconciled as 2,590 passed and 24 intentional skips: the prior exact checkpoint
had 2,579/24, only process-broker test files changed, and that package increased
from 308 to 319. This arithmetic reconciliation is not represented as a
second test execution.

## Packaging, consumer, audit, and static checks

`npm pack --dry-run --json --ignore-scripts` reported:

| Package | Files | Packed bytes | Unpacked bytes |
| --- | ---: | ---: | ---: |
| `@ai-dev-os/process-broker` | 102 | 122,234 | 579,954 |
| `@ai-dev-os/workspace` | 62 | 70,105 | 311,586 |
| `@ai-dev-os/provider-claude-code` | 74 | 111,132 | 471,546 |
| `@ai-dev-os/provider-codex` | 66 | 54,843 | 262,193 |

Two fresh process-broker tarballs were byte-identical at 122,234 bytes and
SHA-256 `cb34bc90e302f1b4e9603d08d97e970328d24c58b3a6d64c11ca4c0ab5abd1c2`.
All 32 internal packages were then packed into a new temporary consumer.
Installation used `--ignore-scripts`; 113 packages were added. The consumer:

- resolved the public root and `./testing` export;
- reproduced the corpus fingerprint in a fresh process and measured 42 total
  and 40 Windows vectors with deeply frozen data;
- observed Windows `probe()` unavailable and `prepare()` refusing with
  `BACKEND_UNAVAILABLE`;
- proved registration/receipt issuer names absent from the root export;
- proved the private `trusted-evidence` subpath unexported; and
- proved the installed package contained no `native` diagnostic directory.

Root `npm audit --audit-level=high --json` reported 0 vulnerabilities across
217 dependencies. The packed consumer reported 0 vulnerabilities across 137
dependencies. npm emitted the existing transitive deprecation warning for
`prebuild-install@7.1.3`; it was not a vulnerability, no install script ran,
and no manifest or lockfile changed. The lockfile SHA-256 remained
`818aa42c91c84d8272eff3b4287daf554396810b5021d40244bdca65685594f6`.

Static and dependency scans measured:

- 32 manifests and 103 internal runtime edges;
- 0 dependency cycles, undeclared internal imports, private-subpath imports,
  or first-party preinstall/install/postinstall hooks;
- process-broker runtime dependencies only on artifacts, domain, and policy;
- 0 tracked `bin`/`obj`/coverage/native binary/package/log artifacts;
- 0 packed source-map matches for the worktree or user path;
- 0 changed focused/skipped tests, conflict markers, dynamic evaluation,
  `shell: true`, external project/package reference, or changed-production
  `Date.now`/`Math.random`/`randomUUID`/`localeCompare` addition;
- one network-pattern match, classified as `node:net`'s `isIP` input
  validator rather than a runtime network sink; and
- three repository-wide high-confidence secret-shape matches, all classified:
  two fixed `sk-...` redaction canaries in memory tests and one fixed private
  key header canary in repository-index testing. No credential value was
  found, and none of the three files changed in this continuation.

The truth-table JSON parsed successfully, `git diff --check` was clean, and
fresh local processes twice reproduced the exact corpus fingerprint/count.
No lint script exists, so no lint result is claimed.

## Manual and independent security review

The manual threat-model review traced every diagnostic native call and the
untrusted-input, handle, memory, process-before-first-instruction, identity,
ACL, Job, network, executable TOCTOU, crash, evidence issuance, artifact,
cleanup, and body-leakage claims. Because this checkpoint invokes only exact
system DLL load/export inspection, hashing, and current Job membership, the
mutating process/identity/ACL/Job/network/lifecycle paths remain explicitly
unimplemented and cannot mint authority.

Claude Code CLI 2.1.201 then performed the separately authorized read-only
audit of candidate `d129c65e72f650b3bb02d16465fd3fc1da78a43c`
against base `08666171b7f15caecf6aa95beba4e1005bf15af9`:

- requested alias: `opus`;
- requested effort: High;
- permission mode: plan, with Read/Glob/Grep/Bash only and no Write/Edit;
- actual main model: `claude-opus-4-8`;
- CLI support-path model: `claude-haiku-4-5-20251001`;
- session: `9f4fad4b-33c8-4620-9f08-3133e456bb00`;
- permission denials and web requests: 0; and
- verdict: **PASS**, with no release-blocking or material finding.

The auditor supported Outcome B's fail-closed and truthfulness boundary. Its
non-blocking notes were: document digest canonicalization (recorded above),
make the inherent trusted-DLL load-time initialization explicit (recorded
above), retain the test-count bookkeeping distinction (recorded above), and a
cosmetic assembly/namespace casing difference. No fix audit was required.
Git status was clean before and after the audit.

## Cleanup, unsupported checks, and blockers

Final task-owned checks found 0 diagnostic/fixture processes, 0 task-named
AppContainer package folders, and 0 task-named AppContainer registry mappings.
No ACL target existed because none was created. Eighteen verified task-owned
temporary build, pack, and consumer directories were deleted after their
artifacts were measured; 0 remained. No recovery is needed because they held
only reproducible generated output.

The following are deliberately unrun or unsupported:

- the 40 actual-native Windows vectors and every armed positive control;
- AppContainer profile creation/deletion, ACL application/removal, child Job
  creation, target launch, helper/broker crash, and cleanup fault injection;
- Windows deny-all network, identity, filesystem, process-tree, profile,
  credential, IPC, disk/file, CPU, memory, and process-count enforcement;
- a packaged/signed production helper and installed-package native execution;
- controlled Claude/Codex service egress or a live provider canary;
- Linux and macOS implementations or actual-host corpora; and
- remote CI, signing, installer, privileged, or external infrastructure work.

Windows, Linux, macOS, and controlled provider egress therefore remain Stage
17 blockers. Stage 18 cannot begin because no advertised platform has the
required complete native containment and actual positive-control evidence.

The smallest next action requires explicit authorization: create one uniquely
named same-user test-only AppContainer profile, launch no workload, close every
handle, call `DeleteAppContainerProfile`, and verify profile folder, registry,
and ACL residue are absent. Production must remain unavailable during that
lifecycle proof.
