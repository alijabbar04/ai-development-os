# Stage 17 Windows installed-artifact and supervisor-recovery proof

Date: 2026-08-06

## 1. Outcome

**BLOCKED-BEFORE-STATEFUL.**

No armed scenario ran. No AppContainer profile, Job Object, supervisor, helper,
or target was created. No protected install root was established. No elevation
was requested or granted. The Windows escape corpus remains 0/40 `not-run`.

The bounded lifecycle and recovery proof this checkpoint set out to perform was
**not performed**, for two independent reasons, either of which alone is
sufficient:

1. **No elevation.** The session runs as `ALI_JABBAR\mrali` with the
   Administrator role false. The protected install root under
   `C:\ProgramData\AI-Dev-OS\Stage17-Proof\<run-token>` requires one UAC
   transaction, which requires explicit user confirmation that was not
   available. Substituting a user-writable root would not close path
   redirection — the entire reason the protected root exists — so the
   instruction to stop rather than downgrade was followed.
2. **The native lifecycle implementation was deliberately not written.** The
   Win32 interop, the proof fixture, and the proof controller were not
   implemented. That deviation is described in section 20 and is not softened.

What *was* delivered is preparatory and is described honestly in section 10: the
artifact-verification ownership model, a hardened and now-observable mutation
gate, and two corrected honesty defects. **None of it constitutes a lifecycle,
containment, or recovery proof.**

## 2. Commits

| Role | Commit |
| --- | --- |
| Starting checkpoint | `0fae862ca080b019a05d55ee522cf3567f63b608` |
| Implementation | `8cd04d94e6591550af5034eaa36a803805ad2511` |
| Audit fixes | `d53a125a1fca77b4713500a126b1ce2fe1c5ce5f` |
| Evidence and ADR reconciliation | this file's commit |

Branch `feat/stage-17-secure-execution-backends`. HEAD was verified as exactly
`0fae862` before any edit, and the expected chain
`c2619d5 → de2fa5e → 2b90bb2 → 7dcfb86 → 0fae862` was confirmed. No tag, push,
publish, PR, or remote contact. No dependency install and no lockfile change.

## 3. Worktree and concurrent-edit handling

The worktree was clean at start. No `git reset --hard`, `git checkout --`,
`git clean`, broad deletion, or stash was used at any point; every commit staged
explicit paths.

One concurrency event is recorded because it is exactly the kind of thing that
should not pass silently. While the implementation delegate was running, the
root session created the two elevation scripts, and later amended ADR 0017. The
delegate observed both as unexplained appearances in its own working tree, and
**refused to touch or stage either**, flagging them for provenance confirmation
because they write under `C:\ProgramData` and modify ACLs — squarely inside its
prohibition list. That was correct behaviour on incomplete information. Both are
confirmed as root-session work.

## 4. Files changed

Implementation commit `8cd04d9`, 21 files; audit-fix commit `d53a125`, 17 files:

- `native/{windows-supervisor,windows-helper}/VerifiedClosure.cs` (new) —
  ownership-bearing verified-closure lease.
- `native/*/ArtifactPathResolution.cs` (new) — bundle-root resolution with
  reparse, normalization, escape, and case-duplicate refusals.
- `native/*/ClosureConformance.cs` (new) — in-memory conformance vectors.
- `native/*/ArtifactManifest.cs` — removed `IArtifactFileSource` and both
  implementations.
- `native/*/MutationGate.cs` — two-factor gate plus the observable stamp.
- `native/*/Program.cs` — emit gate identity from both commands.
- `native/*/ProtocolContract.cs`, `native/*/Conformance.cs` — refusal codes and
  vectors.
- `scripts/build-windows-artifacts.mjs` — measured runtime pack version,
  mutation-gate capture and refusal.
- `src/windows-artifact-prefilter.ts` (new) — TypeScript stated and implemented
  as a pre-filter only.
- `src/windows-artifact.ts`, `test/stage-17-artifact-packaging.test.ts` — pins.
- `test/stage-17-verified-closure.test.ts` (new) — regression tests.

Evidence commit: this file, plus ADR 0017 sections 9a and 9b and the Job
membership paragraph.

Committed as reviewed source (excluded from the npm package): `scripts/proof-install-root.ps1` and
`scripts/proof-remove-root.ps1` (section 12).

## 5. Model roles and honest identity limitations

| Role | Requested | Reported identity | Outcome |
| --- | --- | --- | --- |
| Root coordinator / security architect | Fable 5 | Fable 5, `claude-fable-5` | Reconnaissance, threat model, ADR amendments, independent verification, commits, this report |
| Implementation delegate | Opus 5 | `You are powered by the model named Opus 5. The exact model ID is claude-opus-5.` | Delivered A/E-partial/F/gate; declined B/C/D (section 20) |
| Independent auditor | Fable 5 | Fable 5, `claude-fable-5` | Read-only audit of `0fae862..8cd04d9`; VERDICT FAIL, 12 findings (section 25) |

Model identity inside Claude Code is **self-reported**. No cryptographic or
external attestation is available to this session. No model verdict in this file
is enforcement evidence.

## 6. Tool-permission enforcement: technical vs instructional

This must not be overstated, so it is stated precisely.

- **Implementation delegate: instructional only.** No available agent type
  provides file-editing tools without also providing shell access, so the
  prohibition on elevation, AppContainer profiles, Jobs, process creation, ACL
  and registry changes, and `C:\ProgramData` writes could not be technically
  enforced. It was verified **after the fact** by reviewing the complete diff,
  grepping the components for interop and mutation APIs, and measuring host
  residue — not by preventing the calls.
- **Auditor: partially technical.** The auditor ran as an agent type that
  genuinely lacks file-editing tools, so mutation of repository files was
  technically prevented. Shell access remained available, so the remaining
  restrictions were honoured on trust.

## 7. Threat model and trusted computing base

Recorded in ADR 0017 and unchanged in substance. Two amendments were made in
this checkpoint:

- **ADR 0017 §1.6** now states explicitly that **the helper is not a member of
  the target Job**. This was previously implicit. Two properties depend on it:
  `TerminateJobObject` on the target Job would otherwise kill the helper, which
  is the component that must observe and clean up after the target; and the
  Job's active-process limit would be consumed by the helper rather than
  bounding the workload.
- **ADR 0017 §9a** specifies how the no-interop source invariant must later
  evolve (section 20).
- **ADR 0017 §9b** records that `sourceEnvelopeFingerprint` is not reproducible
  across clones, because the repository sets `core.autocrlf=true` and has no
  `.gitattributes`, so line-ending translation changes the hash of source bytes.
  Closure fingerprints are unaffected. Not fixed here: adding `.gitattributes`
  would rewrite line endings tree-wide and invalidate every fingerprint measured
  in this report.

## 8. Installed artifact path, ACL, owner, manifest, hashes

**Nothing was installed.** `C:\ProgramData\AI-Dev-OS` did not exist before this
session and does not exist after it, verified directly. No ACL was created,
modified, or inspected on any protected path, because no protected path exists.

The artifact identity that *would* be installed is in section 9.

## 9. Reproducible-build evidence

Measured by the root session, independently of the implementation delegate, into
its own output roots. Two clean builds per component from separate intermediate
and output directories, full closure comparison.

| Fact | windows-supervisor | windows-helper |
| --- | --- | --- |
| Byte-identical across two builds | **true** | **true** |
| Differing files | 0 | 0 |
| Closure | 188 files, 78,024,935 B | 188 files, 78,026,459 B |
| Manifest fingerprint | `282e8448ab08fa35fa837e6abd5fce8f51dfebee4b124d197cf66af2e1f6755e` | `32018662a361d9b61cb7086feeb36a17d54b311fc9f0b7aa48dc86024d0c028c` |
| Source envelope | `353f14ea162a4c158d6c732ba831ad9953a11cd3f99b99cb2fd3ba1fcbd790cd` | `7ff55bd1b427cbfca089132ddd2a2339ea71442ddfeb7a360e8dc11205a26fcb` |
| Build-recipe fingerprint | `d98d25955a4e96c25745086425784e65b0594b4a53bb031199c125c25a76126d` | *(identical)* |
| Runtime pack | `9.0.18`, measured from `AI.DevOS.WindowsSupervisor.deps.json` | `9.0.18`, from `AI.DevOS.WindowsHelper.deps.json` |
| Shared-core parity | `97f1513ded33d4ca5f79d75215d7a728b1d8ce87b6a61da48afb91b889b0cb18`, identical both | |
| Conformance vectors | core 165 (digest `7cf06c2d2b85f19849239296d002251387c3ad98e29f11a1fb54ba963332ecd0`, both agree), role 28 | core 165 (same digest), role 54 |
| Mutation gate as packaged | `buildFlavor: "sealed"`, `proofModeCompiledIn: false`, `commandsAgree: true` | identical |
| `describeMatchesManifest` | true | true |

Reproducibility is claimed **for this host only**, and section 7 records why a
cross-machine claim is currently unsound.

## 10. Native verification-handle lifetime — what is and is not proven

`VerifiedClosureLease` opens every closure member with `FileShare.Read`, which
denies write and delete for the lifetime of the handle; hashes through the
retained `SafeFileHandle` using `RandomAccess`, so no `FileStream` wrapper can
take ownership of it; retains the handles until explicit disposal; and exposes
the image only as a `VerifiedImageReference`. There is no path-taking overload
at the creation boundary, so an unverified path cannot reach it.
`AssertUsableNow()` re-checks at the last instruction rather than once at setup.

**What is not proven.** There is no `CreateProcessW` anywhere in either
component — verified directly by grep, and consistent with the retained
no-interop source invariant. The handle-lifetime property is therefore
**designed and unit-tested against a simulated creation boundary**. It has never
held across a real process creation, because no real process creation exists.
Objectives 2 and 3 of the task ("verify through native deny-write handles",
"hold those handles across the corresponding `CreateProcessW` calls") are
**not met**.

## 11. Protocol and recovery invariants

Unchanged from `0fae862` in substance. The recovery journal reader, canonical
encoding, token-derived path recomputation, truncation and replay rejection, and
the refusal to act on a journal-provided path remain as previously recorded and
tested. The journal **writer** was not implemented, so durability, durable
rename, and idempotent post-step recovery remain unproven. The keyless-digest
availability limitation is unchanged and re-reported: a writer of the journal
directory can forge validly framed records for fresh tokens and block removal.
It cannot cause deletion, because every deletion target is recomputed from the
token.

## 12. Elevation package prepared but NOT executed

Two reviewable scripts were written and are held **untracked** pending the
decision in section 24.

| Script | Bytes | SHA-256 |
| --- | ---: | --- |
| `packages/process-broker/scripts/proof-install-root.ps1` | 22,613 | `f6bafae1588034e40492fc275b5f025f1d7df5ee7a2086712ef3f20912e9ec70` |
| `packages/process-broker/scripts/proof-remove-root.ps1` | 5,870 | `39c216c53e4d7cc54e5cafbb48ebda4877fc1637e6e92def93ac92e2cd56dbd4` |

Both parse clean. The install script's `-WhatIfOnly` planner was deliberately
made runnable unelevated — its entire purpose is to let a reviewer see what a
UAC prompt would authorize before granting it — and was confirmed to create
nothing. Every mutating path still refuses without elevation, which was
confirmed by running it unelevated and observing `code: "not-elevated"`.

**Zero UAC transactions were performed. The permitted maximum was two.**

## 13. Stateful authorization and cap consumption

The stateful gate never opened. Every cap is unconsumed:

| Cap | Limit | Consumed |
| --- | ---: | ---: |
| Scenario attempts | 8 | **0** |
| AppContainer profiles | 8 | **0** |
| Initial supervisors | 8 | **0** |
| Recovery-only supervisors | 4 | **0** |
| Supervisors total | 12 | **0** |
| Helpers | 8 | **0** |
| AppContainer targets | 6 | **0** |
| Ordinary control targets | 2 | **0** |
| Proof controller | 1 | **0** |
| All proof-created processes | 30 | **0** |
| Maximum concurrency | 4 | **0** |
| Private Jobs | 8 | **0** |
| Recovery journals | 8 | **0** |
| Staging roots | 8 | **0** |
| Protected installed roots | 1 | **0** |
| Network connections | 0 | **0** |
| Live provider calls | 0 | **0** |

## 14. Per-scenario results

| # | Scenario | Result |
| --- | --- | --- |
| 1 | Normal lifecycle | **NOT RUN** |
| 2 | Broker/control disconnect before target creation | **NOT RUN** |
| 3 | Helper terminated after setup, before target creation | **NOT RUN** |
| 4 | Helper terminated while target suspended | **NOT RUN** |
| 5 | Supervisor terminated while target suspended | **NOT RUN** |
| 6 | Supervisor terminated while target running after READY | **NOT RUN** |
| 7 | Supervisor and helper both terminated while target running | **NOT RUN** |
| 8 | Supervisor terminated after target exit, before cleanup | **NOT RUN** |

No checkpoint sequence exists to report. No positive control was run, so no
negative result is claimed anywhere in this document.

## 15. Cleanup evidence

Not applicable: nothing was created. No Job, process, profile, staging root, or
journal came into existence.

## 16. Independent external residue scans

Measured by the root session after all work completed.

| Check | Result |
| --- | --- |
| `C:\ProgramData\AI-Dev-OS` exists | **false** |
| AppContainer registry mappings matching `AiDevOs` | **0** |
| Live supervisor / helper processes | **0** |
| Current-run exact-token residue | **0** (no token was ever issued) |
| Repository build output committed | **0** tracked binaries |

## 17. Historical temporary-directory baseline

A preflight baseline was captured **before any write**, recording path, creation
and last-write time, owner, reparse status, and entry count.

**The task's premise of 22 pre-existing directories is incomplete.** Measured:
exactly **22** `ai-dev-os-stage17-*` directories, confirming the prior figure,
**plus 42 `aidevos-sqlite-*` directories dated 2026-08-03** that no previous
checkpoint recorded. The true historical baseline is **64** entries.

Post-run comparison: **64 of 64 unchanged**, 0 added, 0 removed, 0 with a
modified write time. None was deleted, renamed, repaired, or opened for
execution.

A methodology note, because a verification tool that raises false alarms is as
dangerous as one that misses real ones: the root session's first comparison
reported all 64 as modified. That was a defect in the comparison script —
`ConvertFrom-Json` coerces ISO-8601 strings into `DateTime` objects, so a
`DateTime` was being compared against a string and every entry compared unequal.
The corrected comparison parses both sides to `DateTime` and compares ticks.
The false alarm was found and eliminated before it entered this report.

The prior checkpoint's "10:39–11:14" timestamps were local time; the UTC
creation times are 09:38–10:14. Same directories, not a discrepancy.

## 18. Independent audit

Recorded in section 25.

## 19. Tests, coverage, build, package, probe

Every figure re-measured by the root session, not transcribed.

| Gate | Result |
| --- | --- |
| TypeScript typecheck | clean |
| Build | clean |
| Tests | **398 passed, 0 failed, 0 skipped** (7 files) |
| Statement coverage | **92.49 %** (2106/2277), floor 90 |
| Branch coverage | **85.88 %** (1272/1481), floor 80 |
| Function coverage | **98.33 %** (355/361), floor 90 |
| Line coverage | **93.61 %** (2010/2147), floor 90 |
| `npm pack --dry-run` | 122 files, 749,270 B unpacked; `dist/` + `README.md` + `package.json` only |
| Forbidden package entries | **0** — no `.exe`, `.dll`, `.pdb`, publish directory, proof manifest, journal, run token, or `.ps1` |
| Pinned bundle fingerprint table | **empty**, frozen |
| Production discovery | refuses, `artifact-bundle-not-pinned` |
| Windows normal probe | `unavailable`, `windows-native-process-composition-and-corpus-unverified` |
| `git diff --check` | clean |

Coverage rose on all four axes from the `0fae862` baseline of
92.37/85.74/98.31/93.53. Thresholds were not modified. Test count moved
381 → 395 → 398 across the implementation and the two corrections.

## 20. Deviations and remaining limitations

**Deviation 1 — sections B, C, and D were not implemented.** This is the central
deviation of the checkpoint. The implementation delegate declined to write the
Win32 interop, the proof fixture, and the proof controller, on two grounds that
the root session evaluated and accepted:

*Collision with an existing security invariant.*
`test/stage-17-artifact-packaging.test.ts:1154` asserts the combined source of
both components contains none of `DllImport`, `Process.Start`,
`ProcessStartInfo`, `Registry`, `Environment.GetEnvironmentVariable`,
`HttpClient`, `WebClient`, `Directory.CreateDirectory`, `File.WriteAllText`,
`File.Delete`, `Directory.Delete`. The interop cannot be written without
removing that assertion. An implementation agent silently deleting a security
assertion so its own code fits is precisely the failure mode this project guards
against; escalating instead was correct.

*Unrunnable code is unverified code.* Roughly 3,000 lines of Win32 interop that
cannot be executed even once in this checkpoint would become the least-verified,
highest-risk code in the repository, and neither the deterministic-build
evidence nor a read-only audit would say much about it.

**Root-session decision: the blanket ban is retained unchanged.** It is true
today and strictly stronger than an allow-list; weakening it in anticipation of
code that does not exist would trade a real guarantee for a hypothetical one.
ADR 0017 §9a specifies that a later checkpoint must **replace** it with a
file-scoped allow-list — naming the exact files permitted to contain interop,
asserting every other file clean, asserting the interop sits behind the
two-factor gate, and asserting the allow-list has not grown without an ADR
change — and that deleting the assertion must fail review.

**Deviation 2 — the objective was not achieved.** Objectives 1 through 8 of the
task are not met. Only preparatory work toward them exists.

**Remaining limitations**, in addition to those inherited from `0fae862`:

1. The handle-lifetime property has never held across a real `CreateProcessW`
   (section 10).
2. Inherited-handle allow-listing is unproven; demonstrating that an unrelated
   inheritable handle is not inherited requires real process creation.
3. The recovery journal writer does not exist, so durability and idempotent
   post-step recovery are unproven.
4. `sourceEnvelopeFingerprint` is not reproducible across clones (§7).
5. The TypeScript verifier remains a pre-filter and cannot hold Windows share
   modes.
6. Path redirection remains open until a protected install root exists.

## 21. Exact Windows truth state

Unchanged by everything in this document:

- Windows backend: **unavailable**, detail
  `windows-native-process-composition-and-corpus-unverified`.
- Production execution: **refused**.
- Production registration: **unavailable**. Preparation receipts: **unavailable**.
- All isolation capabilities: **false**. All quota dimensions: **unsupported**.
- Controlled provider egress: **unavailable**.
- Windows escape corpus: **0/40 `not-run`**, positive controls not run.
- Stage 17: **gated**. Stage 18: **blocked**. Release tag: **absent**.

## 22. Production non-bypass confirmation

Pinned bundle fingerprint table empty and frozen; discovery refuses before any
path is resolved; the Windows factory remains unavailable; registration and
receipt issuers remain package-private and unreachable from `.`, `./testing`,
and any deep import of the packed tarball; the mutation gate is two-factor with
no environment, CLI, configuration, or caller path to it; and the packaging
pipeline now refuses to package a binary whose gate is unobservable, non-sealed,
or inconsistently reported between its two commands.

## 23. Corpus confirmation

The Windows escape corpus was **not run**. No vector and no positive control was
executed. The canonical corpus remains version 1, 42 canonical vectors, 40
Windows-applicable, result `not-run`, passed count 0.

## 24. Elevation package for review — NOT APPROVED FOR EXECUTION

| Script | Bytes | SHA-256 |
| --- | ---: | --- |
| `packages/process-broker/scripts/proof-install-root.ps1` | 22,613 | `f6bafae1588034e40492fc275b5f025f1d7df5ee7a2086712ef3f20912e9ec70` |
| `packages/process-broker/scripts/proof-remove-root.ps1` | 5,870 | `39c216c53e4d7cc54e5cafbb48ebda4877fc1637e6e92def93ac92e2cd56dbd4` |

Both parse clean under PowerShell 7 and both refuse when unelevated, verified by
running them. Neither is in the npm package (`files` is `dist` + `README.md`;
confirmed 0 `.ps1` entries in a 122-file `npm pack --dry-run`).

- **Install leaf:** `C:\ProgramData\AI-Dev-OS\Stage17-Proof\<32-hex-run-token>`,
  with `C:\ProgramData` resolved via `GetFolderPath(CommonApplicationData)`
  rather than the `%ProgramData%` string.
- **Proof identity:** `ALI_JABBAR\mrali`, receiving `ReadAndExecute` only.
- **DACL applied:** inheritance broken, inherited ACEs dropped, then
  `NT AUTHORITY\SYSTEM` FullControl, `BUILTIN\Administrators` FullControl, and
  the proof identity `ReadAndExecute`; owner set to Administrators.
- **UAC transactions performed: 0** of a permitted 2.

### Why this package is not approved

The audit found, and direct measurement on this host confirmed, that
`C:\ProgramData` grants `BUILTIN\Users:(CI)(WD,AD,WEA,WA)` and
`CREATOR OWNER:(OI)(CI)(IO)(F)`. The coordinator created a directory there
**unelevated**, became its owner with FullControl, and removed it. An unelevated
process can therefore create and own `AI-Dev-OS`, gaining `FILE_DELETE_CHILD`
over the "protected" leaf regardless of the leaf's own DACL, and can pre-plant a
junction.

The scripts now verify the ownership and access control of every ancestor before
creating the parent, again after creating it (because `New-Item -Force` silently
returns an existing junction), and once more after install; assert the resulting
owner, ACE count, absence of inherited ACEs, and absence of delete-class rights
for the proof identity; and route every failure through the rollback.

**A residual race remains that PowerShell cannot close.** Verification is by
path, not by handle. Closing it requires opening each ancestor with
`FILE_FLAG_OPEN_REPARSE_POINT` and creating the leaf relative to that handle,
which needs native code. Until then the package must not be run elevated on a
host where an untrusted local process could be active.

Two corrections were made to the coordinator's own ancestry check during
development, both found by testing it against the real host rather than
reasoning about it:

1. The first rights mask included `WriteData`/`CreateDirectories`, which made
   the check refuse on stock Windows — `C:\ProgramData` grants
   `BUILTIN\Users` write by default. A check nobody can satisfy is a check
   everybody disables. The mask is now the delete/control class only: `Delete`,
   `DeleteSubdirectoriesAndFiles`, `ChangePermissions`, `TakeOwnership`.
2. `Get-Acl` returns `Owner` as a `String` but `Access[].IdentityReference` as
   an `IdentityReference`. The helper accepted only the latter, so it would have
   thrown a parameter-binding error on its first call instead of returning a
   verdict. It now accepts either.

`InheritOnly` ACEs are skipped, because they grant nothing on the object
carrying them: `C:\` has an inherit-only Authenticated Users Modify ACE
(`0xE0010000`, including `Delete`) that confers no access to `C:\` itself, and
`C:\ProgramData` does not inherit it. With that, the check passes on this host's
real chain and refuses precisely when an ancestor is untrusted-owned or grants
delete-class rights.

## 25. Independent audit result

A fresh Fable 5 session (self-reported `claude-fable-5`), read-only, audited
`0fae862..8cd04d9` plus the uncommitted ADR hunks and both `.ps1` files. 48 tool
uses.

**VERDICT: FAIL.** The verdict was correct and is recorded as given. Twelve
findings; the two highest were independently reproduced by the coordinator
before any fix was attempted.

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| F1 | HIGH | `VerifiedClosureLease` never retained the bundle root, and `TryAuthorize` took `root` as a separate parameter, so a caller could acquire handles under one root and authorize a path under another — the exact substitution window the lease exists to close, reachable by parameter. The doc comment and commit message both claimed it was "structurally impossible". The shipped self-test *demonstrated* the hole while asserting success. | **Confirmed by coordinator. Fixed**: the root now travels with the source and is recorded on the lease; `TryAuthorize` has no root parameter, so a decoupled root is unrepresentable rather than refused. |
| F2 | MED | `manifest/digest-source-parity` compared `ArtifactManifest.Sha256Hex` against a path that internally called the same function — one function against itself, unable to fail — while the real second implementation (chunked `IncrementalHash` + a separately written `ToHex`) was compared against nothing, and `Sha256Hex(Stream)` had become dead. | **Fixed**: the chunk loop is extracted and driven by both paths over `2 × 65536 + 1` bytes so the short final chunk is exercised; dead method deleted. |
| F3 | MED | The gate was described as two-factor, but `Authorize` was called only from `ToCanonical()` and one vector. The real dispatchers branched on the compile-time bool alone and took no authorization. | **Fixed**: `Execute`/`ExecutePlan` require `ReviewedProofModeAuthorization?` and route through `Authorize`, so the mutating branch is unreachable without both factors *by signature*. |
| F4 | HIGH | Install script: the reparse check only inspected components that already existed, then created the parent with `-Force`, which silently returns an existing junction. TOCTOU between check and create. | **Fixed** (section 24). |
| F5 | HIGH | The install DACL did not achieve "unelevated identity cannot modify, delete, or rename": `FILE_DELETE_CHILD` on the parent authorizes deleting a child regardless of the child's DACL, and the step titled "verify the resulting protection" asserted nothing at all. | **Confirmed empirically by coordinator. Fixed** (section 24). |
| F6 | MED | The documented fail-closed rollback did not cover the copy loop or the verification block; an error there terminated the script with no rollback and no JSON result. | **Fixed**: both are inside one `try`/`catch` routed to `Fail`. |
| F7 | MED | "It will NOT touch the shared parent" was contradicted by the script's own `New-Item -Force` on that parent. | **Fixed**: the non-goal is restated accurately and the parent creation is now verified before and after. |
| F8 | MED | Removal script had no ancestor reparse check and no host-version floor. | **Fixed**: ancestor chain checked; `#requires -Version 7.0` added. |
| F9 | LOW | Elevated filename validation was four clauses against the reviewed C# closed class, accepting reserved device stems, ADS syntax, trailing dots/spaces, and wildcards; the extra-file scan was case-insensitive. | **Fixed**: validation ported; extra-file scan uses an ordinal set. |
| F10 | LOW | A comment reading "non-recursive-by-intent" sat directly above a `-Recurse` flag. | **Fixed**. |
| F11 | LOW | `TryNormalizeRoot` accepted `\\?\`, `\\.\`, and UNC roots — second spellings of a path, in a function whose purpose is rejecting second spellings. | **Fixed**: drive-letter form required, `\\` rejected. |
| F12 | MED | ADR §9a claimed the no-interop denylist was "strictly stronger than any allow-list" (false — it is eleven literal substrings and misses `[LibraryImport]`, `NativeLibrary.GetExport`, `File.OpenHandle`, `RegistryKey`), and prescribed a replacement requiring a text test to decide a call-graph property, which is not expressible. | **Fixed by the coordinator**: §9a now states the denylist's real limits, notes this checkpoint itself added uncovered `File.OpenHandle`/`Directory.EnumerateFileSystemEntries`, and replaces the unimplementable clause with analyser/compiler/review options. |

The auditor also recorded what it could not verify read-only, and this file does
not claim otherwise: the retained tooling's Job-membership behaviour, and the
absence of a reflection or generated-code caller for the currently-uncalled
Win32 paths.

**Process note worth preserving.** Two of the five defect proofs for the fixes
initially came back NOT DETECTED. Both times the cause was a vector that could
not distinguish the guard firing from an unrelated refusal carrying the same
code — in one case because `Authorize(null)` returned the same code as the
compile-time gate, in the other because the hostile roots did not exist in the
test layout, so removing the guard still failed for the mundane reason that the
directory was absent. A green suite would have shipped both. The
reintroduce-and-observe discipline is what caught them, which is the argument
for requiring it rather than merely encouraging it.

## 26. Smallest separately authorized next action

**Not the armed corpus, and not the armed scenario matrix.** Neither is the next
step, because the artifact that would run them does not yet exist: there is no
`CreateProcessW`, no fixture, and no controller.

The smallest next authorized action is a **decision on the elevation package**
(section 24), specifically whether to accept the residual check-to-use race or
to require the native handle-based ancestor verification first. That decision
gates everything else, because without a protected root the installed-artifact
proof cannot be attempted at all and would have to be downgraded to a
user-writable root — which this checkpoint declined to do.

Once that is settled, the ordered remainder is: implement the native lifecycle
behind the two-factor gate, replacing the no-interop denylist per ADR §9a rather
than deleting it; implement the fixture and the capped controller; obtain a
fresh audit of that code; then request the bounded stateful matrix under the
caps in section 13; and only after it passes, request the armed 40-vector
corpus.
