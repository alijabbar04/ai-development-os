# Stage 17 Windows AppContainer profile lifecycle proof

Date: 2026-08-05

Outcome: **PASSED FOR ONE AUTHORIZED PROFILE LIFECYCLE — NOT ENFORCEMENT**

One uniquely named, same-user, test-only AppContainer profile and one matching
task-owned ACL directory were created and completely removed. The profile had
zero capabilities. No workload, child process, Job Object, production helper,
registration, preparation receipt, provider request, credential, firewall
rule, loopback exemption, proxy change, privileged operation, or corpus vector
was created or run.

This closes only the profile/ACL lifecycle feasibility blocker on the exact
observed host. The Windows backend remains `unavailable`, every capability is
false, every quota is `unsupported`, actual-native evidence remains 0/40,
Stage 17 remains gated, Stage 18 remains blocked, and no `v0.17*` tag or push
is permitted.

## Authorization and Git boundary

The incoming checkpoint explicitly required user authorization before any
persistent per-user AppContainer state. After a read-only verification, the
user authorized exactly one uniquely named same-user test profile and one
task-owned ACL area, with no workload and mandatory residue verification.

- Worktree:
  `C:\Users\mrali\Projects\ai-dev-os-stage-17-secure-execution`.
- Branch: `feat/stage-17-secure-execution-backends`.
- Starting checkpoint:
  `4187682f7cef6cb64f79cfbb14c29229be977350`.
- Starting tree:
  `8ba728ec84a4eeff00ed9c1f742def8052cc333d`.
- Profile-lifecycle implementation candidate:
  `69ff7a782f01655408b2e029895682a7756ab676`.
- Candidate tree:
  `07a8a36f14b5c0fded9a35a729e58891875f0616`.
- The Stage 16 peeled release commit
  `c344b1e9264e5306fb648abaa7add6cebc17c3cc` remains an ancestor.
- No remote or `v0.17*` tag exists.

The evidence-only commit containing this document follows the implementation
candidate. It is not a release commit or tag.

## Protocol-v2 evidence tool

`packages/process-broker/native/windows-feasibility-probe` remains evidence
tooling, not a sandbox helper or packaged runtime. Protocol version 2 retains
the read-only `probe` and `self-test` commands and adds the explicitly gated
`profile-lifecycle-proof` command.

The stateful command accepts only:

- `AiDevOs.Stage17.ProfileProof.<32-lowercase-hex>`; and
- the matching direct child
  `%TEMP%\ai-dev-os-stage17-profile-proof-<same-hex>`.

It derives and frees the deterministic AppContainer SID before mutation,
refuses pre-existing matching ACL/registry state, creates the profile with a
null capability array and count zero, verifies the returned SID, resolves and
observes the profile folder, observes the exact mapping and storage registry
records, applies an inheritable allow rule for that SID to the new task-owned
directory, observes the explicit rule, restores the exact original access
SDDL, deletes the empty directory, frees the SID returned by profile creation,
calls `DeleteAppContainerProfile`, and polls the exact folder and registry
records for absence. It contains no process-creation call.

Invalid commands and shapes are stable body-free refusals. The stateful command
returns only boolean observations and SHA-256 fingerprints for the profile
name, SID, and ACL path; it does not persist their raw values.

## Build and artifact identity

The successful lifecycle proof used this exact framework-dependent payload:

- executed source digest:
  `d0c787690c09cde1644f40b80c1fa4d7da007340478228e3508f53722b72994f`;
- executed DLL digest:
  `fc896403faeb582db681d170bf2c64b389bb0710ab49e2ec8ddc69d76d494f6b`;
- executed build-envelope digest:
  `679d085eb7b98fd754e4df3b0fdaae102d5aaf6748ca5c51eafa9fc3d5201348`;
- SDK/runtime: .NET SDK 9.0.316 / Microsoft.NETCore.App 9.0.18;
- target: `net9.0-windows`, Release, deterministic, warnings as errors,
  checked arithmetic, no unsafe code, no debug symbols, no apphost, and no
  NuGet/project dependency.

After the proof, the non-stateful probe refusal was narrowed from the old
profile-lifecycle blocker to
`windows-native-process-composition-and-corpus-unverified`. No lifecycle or
P/Invoke behavior changed. The exact committed source therefore has new
artifact identities:

- final source digest:
  `71d207377eba2bf66596ecf4de4b9eec1961e58366b7e0e2277ff28dfd753111`;
- final DLL digest:
  `eb437744f8a09306d6d7caa11b47c5126d39dad109f5a77acdde77c6bc48d156`;
- final build-envelope digest:
  `e8df2a0e3c7e6c8b1c39c0e9035f335ec6e434de6f824d31c9978965114d6778`.

The final source digest covers, in ordinal path order,
`AI.DevOS.WindowsSandboxFeasibilityProbe.csproj`,
`ProfileLifecycleProof.cs`, and `Program.cs`, using the existing path/NUL/raw
bytes/NUL algorithm. Two fresh builds in separate task-owned output and
intermediate directories completed with zero warnings/errors and produced the
same manifest:

| Payload | Bytes | SHA-256 |
| --- | ---: | --- |
| `AI.DevOS.WindowsSandboxFeasibilityProbe.deps.json` | 509 | `edb3906cbfcc8e80f3dbc56769089ce90f7a0efd0e821a09f5abffb65f4571b5` |
| `AI.DevOS.WindowsSandboxFeasibilityProbe.dll` | 49,664 | `eb437744f8a09306d6d7caa11b47c5126d39dad109f5a77acdde77c6bc48d156` |
| `AI.DevOS.WindowsSandboxFeasibilityProbe.runtimeconfig.json` | 397 | `e3a9d5d0a25ca066e8b70401b5869b5cfc92d16f5fe89b83077cdfd4b7427711` |

Using the final payload, `self-test` passed, `probe` exited 2 with the narrowed
unavailable reason, an unknown command exited 64 with `unsupported-command`,
and an empty command exited 64 with `invalid-command-shape`. Neither read-only
command attempted profile or process mutation.

## First command attempt

The first authorized lifecycle command exposed an ordering defect in the proof
tool: it tried to resolve the profile folder before creating the profile. SID
derivation succeeded, but folder resolution failed before
`CreateAppContainerProfile`.

The result reported:

- `status: failed` and `reason: profile-lifecycle-proof-exception`;
- `profileCreated: false`;
- `processCreationAttempted: false`;
- `aclDirectoryRemoved: true`;
- profile folder, mapping registry, and storage registry residue absent; and
- no delete call because no profile existed.

Its profile-name, SID, and ACL-root fingerprints were respectively
`77ef87b8f8ff8f87e878b2ca9ab41b670015f97fa9224d8844325c5de77ea88f`,
`47a7c2f158f9a3a64bec77052a20d7fb768018f8e539f938b1594e153833b0c4`,
and `de783b5d13c01873c9c99724a104e32dad4ed63f81b8357550413d30173ec101`.

The ordering was corrected and the project rebuilt with zero warnings/errors.
Because the failed command created no profile, the user's authorization for
one profile creation remained unused.

## Successful single-profile result

Exactly one profile was then created. The body-free result was:

| Observation | Result |
| --- | --- |
| Status/reason | `passed` / `profile-lifecycle-proof-passed` |
| Profile-name fingerprint | `6f689cb9039963f534df1bbe6030bb20a78b68e909b9a3e04b3edf0a2c2004cc` |
| Profile-SID fingerprint | `4b2c2d95c0307d2839f0b056c3e874bfb29463a0fc589e972449314b9673b18f` |
| ACL-root fingerprint | `4c06e3bdca6342ac3dc6fe37887a1acbf117907c6f8b3eee582823c766a85ed4` |
| Profile created | true; count 1 |
| Capabilities requested | false |
| Process creation attempted | false |
| Profile folder observed | true |
| Mapping registry observed | true |
| Storage registry observed | true |
| Explicit SID ACL grant observed | true |
| Original ACL restored | true |
| ACL directory removed | true |
| Returned SID freed | true |
| Delete attempts/success | 1 / true |
| Folder residue absent | true |
| Mapping registry residue absent | true |
| Storage registry residue absent | true |
| Cleanup confirmed | true |

An independent read-only host scan after the command found:

- ACL root exists: false;
- matching registry key names: 0;
- mapping values matching the profile: 0;
- matching package folders: 0; and
- exact storage key exists: false.

No raw profile name, SID, ACL path, or generated payload is committed.

## Process-broker and package validation

On the implementation candidate, all of these passed:

```text
npm run typecheck --workspace @ai-dev-os/process-broker
npm run test --workspace @ai-dev-os/process-broker
npm run test:coverage --workspace @ai-dev-os/process-broker
npm run build --workspace @ai-dev-os/process-broker
```

The package remained at 319/319 tests. Coverage remained above every gate:

| Statements | Branches | Functions | Lines |
| ---: | ---: | ---: | ---: |
| 1,597/1,729 (92.36%) | 995/1,158 (85.92%) | 293/298 (98.32%) | 1,539/1,655 (92.99%) |

The Windows factory and `validateGrant()` now share stable refusal
`windows-native-process-composition-and-corpus-unverified`. The descriptor
remains unavailable with every capability false and quota unsupported.

`npm pack --dry-run --json --ignore-scripts` reported 102 files and 122,370
packed bytes. It contained zero `native` entries; the evidence tool and its
stateful command are not shipped. No manifest, lockfile, dependency, install
hook, production registration issuer, receipt issuer, or production native
execution path changed.

The machine-readable truth table parsed, `git diff --check` passed, no raw
profile identifiers were present in the repository, and final generated
`bin`/`obj` directories remained outside the worktree.

The repository-wide `npm run check` was not rerun for this bounded evidence
tool/profile proof. The incoming prose handoff reported 1,476.477 seconds for
its prior final check, while the committed prior evidence records 1,325.530
seconds. This proof does not adopt either duration as a fresh result; the
targeted exact commands above are its validation boundary.

No new independent external model audit was authorized or run for this
follow-up. The manual review covered input restrictions, SID ownership and
freeing, ACL observation/restoration, registry-handle disposal, profile-delete
retry semantics, residue polling, body-free output, and absence of any process
creation call.

## Remaining blockers and next action

This result proves same-user profile/ACL create-observe-restore-delete behavior
only. It does not prove:

- AppContainer/LPAC target identity or token contents;
- creation-time Job membership, nesting, no-breakaway, or kill-on-close;
- filesystem denial or executable staging/TOCTOU safety;
- deny-all network behavior;
- handle inheritance, credentials, IPC, profile redirection, quotas, crash
  cleanup, helper protocol, packaging, or signing;
- any of the 40 Windows native positive-control vectors;
- controlled Claude/Codex service egress; or
- Linux or macOS enforcement.

The smallest next task is a separately scoped, synthetic, no-provider process
creation proof using the documented public Win32 composition: no-capability
AppContainer/LPAC identity, task-owned staging, narrow inherited handles, and
creation-time Job assignment through one `STARTUPINFOEX` attribute list. The
backend must remain unavailable until the complete native composition and
corpus are proved.
