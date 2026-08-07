# Stage 17 native-installer audit-fix checkpoint

Date: 2026-08-07

## 1. Outcome

**AUDIT-FIX-PASS.**

The three HIGH findings an independent audit raised against the native
handle-relative installer at `bb2c205` are fixed in the real code path, each with
a regression that fails if the fix is reverted. Nine further findings are fixed
and the remainder are dispositioned in section 8.

What this checkpoint is **not**:

- It is **not** a lifecycle, containment, or recovery proof. Nothing native has
  executed. The marshalling layer still has never run (ADR 0018 §7a).
- It is **not** a Stage 17 release. Stage 17 remains **gated**, Stage 18 remains
  **blocked**, and no `v0.17*` tag exists or may be created from this work.
- It is **not** approval of the elevation package. Zero UAC transactions were
  performed and none was requested.

Windows remains **unavailable**
(`windows-native-process-composition-and-corpus-unverified`), production
execution **refuses**, every isolation capability is **false**, every quota
dimension is **unsupported**, and the Windows escape corpus remains
**0/40 `not-run`** with positive controls not run.

## 2. Starting state: an interrupted, non-compiling change

This checkpoint began by reviewing work a previous session left behind, and the
first thing worth recording is that it was **not** in the state the previous
session believed.

That session ran a background delegate to fix the audit findings, reported the
worktree clean, and paused. The delegate then stalled — no progress for 600
seconds, stream watchdog did not recover — leaving **uncommitted, unverified,
partial** edits to two files. The session caught its own error on resume and
corrected it, which is why the work was still there to review.

Measured state of those edits at the start of this checkpoint:

| Fact | Value |
| --- | --- |
| HEAD | `bb2c205`, unchanged |
| Staged changes | none |
| Modified files | `HandleRelativeContract.cs`, `NativeFileSystem.cs` |
| Diff size | +397 / −78 |
| **Compiles** | **No — 2 errors** |

The two errors are recorded because they establish that the partial work had
never been built, let alone tested:

- `NativeFileSystem.cs(1100)`: `error CS0452: The type 'long' must be a reference
  type in order to use it as parameter 'T' in the generic type or method
  'Outcome<T>'` — a new helper returned `Outcome<long>`, and `Outcome<T>` is
  constrained to reference types on purpose so a refusal can never be confused
  with a default value.
- `SimulatedFileSystem.cs(145)`: `error CS0535: 'SimulatedFileSystem' does not
  implement interface member 'IHandleRelativeFileSystem.RewindToStart'` — the
  contract had gained an operation that only one of its two implementations had.

The partial edits contained a real and correct idea for F-01, F-02, F-04 and part
of F-13. They did **not** contain a working F-03 fix: `RewindToStart` had been
added to the contract and to the adapter, and **nothing called it**, so the
offset defect the operation exists to fix was still fully present. This
checkpoint completed the work rather than discarding it, and every claim below
rests on a build and a run, not on the shape of the abandoned diff.

## 3. Commits

| Role | Commit |
| --- | --- |
| Starting checkpoint | `bb2c205833f630c274b20f84f33567923539af2c` |
| Audit fixes, with ADR 0018 in the same commit | `67494c3` |
| This evidence document | this file's commit |

The code and the ADR are one commit deliberately. A normative design document and
the code it governs belong together, and this project has had that go wrong in
both directions — once an ADR marked "Accepted" existed only as an untracked file,
and once a commit shipped an ADR that contradicted its own code in four places.

Branch `feat/stage-17-secure-execution-backends`. No tag, release, publish, or
pull request. Every commit stages explicit paths; no `git add .`, `git add -A`,
`git reset --hard`, `git checkout --`, `git clean`, or stash was used at any
point.

## 4. Findings fixed, and how each fix is held in place

Severities are the independent auditor's. "Regression" names the mechanism that
fails if the fix is reverted — not merely a test that exists, but one that was
**observed to fail** when the defect was reintroduced (section 6).

### F-01 — HIGH — the ancestor chain was vacuous in the real adapter

`NativeHandleRelativeFileSystem` built every `OpenedObject` with
`ParentOf(rootDirectory)`, a helper whose two branches both returned `null`. Every
handle in the binary that would actually run therefore had `Parent == null`,
`Depth == 0`, and a `ChainIsRetained` that inspected exactly one handle. The
property that justifies the entire handle-based design was absent from the only
place it mattered, and all four `retention/*` vectors passed because
`SimulatedFileSystem` supplied the link the adapter did not.

**Fixed structurally, not by correcting the helper.** A new abstract base class
`HandleRelativeFileSystem` owns ordinal allocation, name-grammar enforcement,
parent-handle validation, and construction of `OpenedObject` with the parent the
*caller* named. An implementation is asked only whether an open succeeded; it is
never asked what the parent was, so it cannot answer wrongly. `ParentOf` is
deleted. Both implementations now derive from the base.

**Regression, two mechanisms.** A `LinkageProbeFileSystem` in the conformance
suite implements the contract while opening nothing at all, so any ancestor chain
it produces can only have come from the base class. It and the simulation are
driven through the same three-hop walk and graded against the **same** expected
string, which is what the auditor asked for — the property asserted against more
than one implementation rather than against one cooperative one. Separately, a
source-level test pins `new OpenedObject(` to exactly one site, in the file that
declares the contract.

### F-02 — HIGH — wrong enum family, and a failed enumeration read as an empty directory

Two defects in one call. `FileFullDirectoryRestartInfo = 3` and
`FileFullDirectoryInfo = 2` are `FILE_INFORMATION_CLASS` values, the enum
`NtQueryDirectoryFile` takes; `GetFileInformationByHandleEx` takes
`FILE_INFO_BY_HANDLE_CLASS`, where the correct values are 15 and 14 and where 2
is `FileNameInfo` and 3 is `FileRenameInfo`, which is SET-only. The structure
offsets the adapter parsed were correct for `FILE_FULL_DIR_INFO` throughout,
which is what isolated the fault to the two ordinals. Separately,
`while (GetFileInformationByHandleEx(...))` treated **any** FALSE as
end-of-enumeration and never consulted `GetLastWin32Error`.

**Fixed.** Correct ordinals; a FALSE return is end-of-enumeration only when the
last error is `ERROR_NO_MORE_FILES` (18), and every other error becomes a refusal
— `NativeAccessDenied` for error 5, `NativeUnexpectedFailure` otherwise.

**Regression.** Vectors pin all four information-class ordinals against
hand-written SDK values, and pin that the restart class is the continue class
plus one — a relationship two individually-plausible ordinals from different enums
would not satisfy. Two hostile conditions fail an enumeration at the source root
and at the destination leaf and require a refusal.

The severity is worth stating concretely, because measurement made it larger than
the description suggests. With a failed enumeration reported as empty, an install
with a planted extra source file **succeeds** — observed, `none:` — because every
planned file is then opened by name and found. The source extra-file scan, the
case-duplicate scan, the destination extra-entry scan, and removal's proof that a
directory is empty were all disabled at once by one unchecked return value.

### F-03 — HIGH — the per-handle byte offset was never reset (see also NEW-02)

Every request carries `FILE_SYNCHRONOUS_IO_NONALERT`, so the kernel maintains a
per-handle byte offset. `ReadThroughHandle` never seeked, and `MeasureFile` was
another read on the *same* handle. After a read to end of file, the measurement
hashed **zero bytes** and digested the empty string, in three places: twice per
source file, and once per destination file after the write left the offset at end
of file.

**Fixed as a contract operation, deliberately not as a hidden convenience.**
`RewindToStart` is part of `IHandleRelativeFileSystem` and the *transaction*
requests it. A silent rewind inside the adapter's read would have fixed the
symptom while making its own absence unobservable to any simulation — which is
how the defect survived review the first time. The simulation now models the
offset, and `HostileConditions.SkipRewind` makes the rewind report success while
moving nothing.

`MeasureFile`'s provenance flag is a **cross-check**, not a literal: the bytes
hashed are compared against the size the same handle reports via
`FileStandardInfo`. `WriteThroughHandle` now reports `measuredThroughHandle:
false` in both implementations, because hashing the buffer you just handed the
kernel proves the caller can hash its own array and nothing about what landed on
disk.

**Regression, two-sided.** The happy path breaks if either rewind call is
deleted, and the `rewind-that-moves-nothing` hostile vector breaks if the size
cross-check is deleted. Neither the guard nor its caller can be removed silently.

The pinned `ExpectedInstallSequence` was rewritten by hand from the design. The
rule it encodes is exact: a rewind appears **if and only if an earlier operation
on that same handle already advanced the offset**. That is once per source file,
between the read and the measurement, and once per destination file, after the
write. It is deliberately absent before the first read of a source file and
absent throughout the final verification loop, for the same single reason in both
cases — those handles were just opened, so their offset is already zero.

An earlier revision of this fix also rewound before the first source read, and
described all of those calls as load-bearing. The independent audit was right that
this was false: that call was decorative, removing it changed nothing observable,
and its own justification contradicted the reason the verification loop correctly
omits one. It is removed, and the sequence and the rule now agree. Recorded as
NEW-02 in section 10.

### F-04 — MEDIUM — a failed elevation query stood in for a non-elevated token

`ReadTokenElevation` returned `false` both for "not elevated" and for "the query
failed", after which `standardTokenKind` was assigned `"standard-user"` by
whichever branch ran, never derived from an observation of the resulting token.

**Fixed.** `TryReadTokenElevation` distinguishes the two. A failed query is
`StandardTokenUnavailable`. The label is read back from the **duplicated** token
that will actually be checked against, and a duplicate that still reports
elevated is refused rather than labelled.

**Regression: source-level only, and labelled as such.** This path needs a real
elevated process to execute, so no vector in this repository can run it. What is
checkable is the shape that produced the finding: a test asserts the collapsing
helper is absent, that the try-form is consulted for both the process token and
the duplicate, and that `"standard-user"` is assigned exactly once.

### F-05 — MEDIUM — the proof constant *was* derivable from the environment

The packaging script claimed the reviewed-proof constant was "not derivable from
the environment" and ADR §4 claimed no environment variable could turn a sealed
build into a proof build. Both were false: MSBuild materialises every environment
variable as a property, nothing assigned `DefineConstants` in the project file,
and the SDK appends its implicit constants rather than assigning them.

**Fixed** by assigning `<DefineConstants></DefineConstants>` in the project file,
which overrides an environment property. The command line still works, by design,
because a global `-p:` property overrides project-file assignments and that is the
documented switch.

**Proved both ways by experiment, not by reading MSBuild documentation** — the
prior auditor explicitly could not verify this read-only:

| Build | Environment | `describe-artifact` reports |
| --- | --- | --- |
| Project file **with** the assignment | `DefineConstants=AIDEVOS_STAGE17_REVIEWED_PROOF_MODE` | `buildFlavor: sealed`, `proofModeCompiledIn: false` |
| Project file **without** it | same variable set | `buildFlavor: reviewed-proof-mode`, `proofModeCompiledIn: true` |

The finding was real, and the one added line is what closes it.

### F-07 — MEDIUM — a vector that could not fail, and two literals a script "checked"

`transaction/self-test-never-instantiates-the-native-filesystem` compared the
literal `"true"` to the literal `"true"`. `Program.cs` emitted `hostStateCreated`
and `nativeFileSystemInstantiated` as hardcoded `false`, and the packaging
script's `if (selfTestJson.hostStateCreated !== false)` therefore examined a
compile-time literal. This is the F2/F-006 defect — a comparison that cannot fail
— shipped in the same checkpoint whose comments cite F2 twice as the thing being
avoided.

**Fixed by measurement.** The native adapter increments a counter in its own
constructor and another in its own open path. The vector reads them and compares
against `instantiations=0 nativeOpens=0`. `Program.cs` derives both booleans from
the counters and additionally reports `nativeOpenAttempts`. The packaging script
now has three checks with measured inputs.

**Regression.** Instantiating the native filesystem anywhere in the self-test
flips the vector to `instantiations=1 nativeOpens=0` — observed.

### F-08 — MEDIUM — one reason given for two commands that are inert for different reasons

`Program.cs` claimed both gated commands refuse in a reviewed-proof build
"because the installable candidate table is empty". True for `install`, which
looks up the candidate before touching anything. False for `remove`, which takes
no candidate and never consults that table: it resolves the known folder, opens
the volume root, and walks toward the run-token leaf, refusing because no
matching leaf **exists** — a fact about the host, not a property of the build.

**Fixed** by stating the truth per command, and by naming what actually bounds
`remove`: the only deletion candidates are components recomputed from the run
token, and `C:\ProgramData` is not among them.

### F-09 — MEDIUM — `--flavor reviewed-proof` produced production-shaped artifacts

The script claimed it "refuses to emit a production-shaped manifest" for a proof
build. It did not: `--flavor` applied to every component, and the manifest —
carrying `manifestKind: "…production-artifact-manifest"` and no flavour field —
was written before any flavour assertion ran.

**Fixed** by making the stated behaviour the implemented behaviour. `--flavor`
applies only to the proof-only installer; every production-shaped component is
built sealed regardless, enforced in `flavorFor(entry)` and asserted per
component. A production-shaped binary has no legitimate reason to exist in proof
mode.

### F-10 — MEDIUM — the allow-list governed three of five native directories

`NATIVE_COMPONENTS` named three directories; `native/` holds five. The two omitted
contain real `DllImport` declarations and, between them, twenty-two occurrences of
`CreateProcessW`, `CreateJobObjectW` and `CreateAppContainerProfile`, scanned by
nothing. The scan was non-recursive, so a `.cs` file one level down was invisible.
The only structural tie was that the allow-list's keys equalled the component
array — which ties the list to itself rather than to the filesystem, so a new
component directory would also have been ungoverned and unnoticed.

**Fixed.** Scans recurse, excluding `bin/` and `obj/`. The carve-out is explicit
(`UNGOVERNED_NATIVE_TOOLING`) and, more importantly, **checked**: `readdir` of
`native/` is compared against the two lists and a directory in neither fails the
suite. The carve-out itself is justified in ADR §5 — both are retained
investigative tooling, shipped nowhere and reachable from no authority path, and
the alternatives are deleting the investigation or widening the allow-list to
cover code on no authority path.

### F-13 — LOW — hardcoded provenance

`measuredThroughHandle: true` was a literal in the adapter, so
`SourceMeasurementNotThroughHandle` could never fire in the real path. Fixed by
the cross-check described under F-03.

**Regression, with an honest nuance.** Removing the cross-check does not make the
zero-byte measurement pass; it changes the refusal from
`source-measurement-not-through-handle` to `source-manifest-fingerprint-unknown`.
The cross-check is the **proximate** guard and the fingerprint comparison is a
backstop. The vector discriminates because it pins the code rather than merely
"something failed", which is the distinction this project's section 25b is about.

### F-14 — LOW — the interop scan got weaker on `RegistryKey`

Moving from substring to whole-identifier matching meant `Registry` stopped
covering `RegistryKey` — a narrowing on exactly the string ADR 0017 §9a records as
covered by the mechanism it replaced.

**Fixed** by listing `RegistryKey` and `Microsoft.Win32.Registry` explicitly. The
broader `Microsoft.Win32` was **tried and rejected**: it flags
`using Microsoft.Win32.SafeHandles;` in the supervisor, which is where
`SafeFileHandle` lives and has nothing to do with the registry. Recorded because
a token that flags legitimate code is a token someone eventually deletes along
with the rule — the exact pressure this file's own comments warn about, and it was
caught here by running the suite rather than by reasoning about it.

### F-17 — LOW — a flush failure reported as a delete failure

`FlushBuffers` returned `RefusalCode.DeleteFailed`. Fixed to
`NativeUnexpectedFailure`. A flush failure is not a delete failure, and reporting
one as the other sends a reviewer to the removal path for a fault that happened
while writing.

## 5. Self-test results, both recipes

Two clean publishes from separate intermediate and output directories, both
outside the repository.

| Fact | sealed | reviewed-proof |
| --- | --- | --- |
| `self-test` exit code | 0 | 0 |
| Status | passed | passed |
| Vectors | **150** | **190** |
| Failed vectors | 0 | 0 |
| Conformance digest | `5bf362ce6f332475eaaf694f53bec070ecec38b25c61c0078f9fac4b89910299` | `1caebccbfec0582eab5ef826460b35bb635b6a253a4ec6c26d23c012b5f9f85d` |
| `buildFlavor`, self-test | `sealed` | `reviewed-proof-mode` |
| `buildFlavor`, describe-artifact | `sealed` | `reviewed-proof-mode` |
| `proofModeCompiledIn` | false | true |
| `nativeFileSystemInstantiated` (measured) | **false** | **false** |
| `hostStateCreated` (measured) | **false** | **false** |
| `nativeOpenAttempts` (measured) | **0** | **0** |
| Unknown command | `unknown-command` | `unknown-command` |

The two recipes report different vector counts and different digests, which is
the ADR 0018 §4 requirement that the flavours be verifiably distinct. The last
three rows are measurements now rather than literals, which is F-07.

## 6. Defect proofs

Every guarded defect was reintroduced and the result observed. Each probe ran
against a **copy** of the reviewed source in a task-owned scratch directory, so
the worktree was never modified to run a probe and never had to be restored.

The bar is not "the suite went red". It is "the suite went red **for this
reason**, and a reviewer reading the failure would be pointed at this guard".

| # | Defect reintroduced | Result | Distinguishing observation |
| --- | --- | --- | --- |
| 1 | Base class passes `null` for every parent | **DETECTED**, 5 vectors | `depth=0,0,0 names=closure` — the exact vacuous chain F-01 described, in **both** implementations. `retention/chain-refused-after-early-disposal` also flips to `none`. |
| 2 | Directory info-class ordinals back to 2 and 3 | **DETECTED**, 2 vectors | `expected 14, observed 2` and `expected 15, observed 3` |
| 3 | Enumeration failure returns empty-success | **DETECTED**, 2 vectors | Both enumeration vectors observe **`none:`** — the install **succeeds**. This is the finding's real severity: a swallowed enumeration error does not fail closed. |
| 4 | Remove the rewind before the source measurement | **DETECTED**, 12 vectors | Happy path → `source-measurement-not-through-handle:measure-source-closure`; the pinned sequence truncates at `rewind-to-start\|read-through-handle\|measure-file`, showing exactly where it stopped |
| 5 | Remove the rewind after the write | **DETECTED**, 10 vectors | Happy path → `destination-digest-mismatch-after-write:copy-closure` |
| 6 | Drop the size cross-check in `MeasureFile` | **DETECTED**, 1 vector | `rewind-that-moves-nothing` observes `source-manifest-fingerprint-unknown` instead of `source-measurement-not-through-handle` — proximate guard vs. backstop, recorded under F-13 |
| 7 | Instantiate the native filesystem in the self-test | **DETECTED**, 1 vector | `instantiations=1 nativeOpens=0` — the counter is a measurement |
| 8 | Remove the `DefineConstants` assignment from the csproj | **DETECTED** | Environment variable then produces `reviewed-proof-mode`; with the assignment it produces `sealed` (F-05, both directions) |

Four further probes were run after the independent audit, against the corrected
code, and are reported separately so it is clear they postdate the audit:

| # | Defect reintroduced | Result | Distinguishing observation |
| --- | --- | --- | --- |
| 9 | Raw numeric information class at the `QueryFacts` call site (NEW-01) | **DETECTED**, by name | `GetFileInformationByHandleEx is called with a bare numeric information class` |
| 10 | Remove the one remaining source rewind (post-NEW-02 shape) | **DETECTED**, 12 vectors | Happy path → `source-measurement-not-through-handle:measure-source-closure`. This is what makes the two-sided claim true: with the decorative call gone, the remaining one is load-bearing. |
| 11 | Remove the post-write rewind | **DETECTED**, 10 vectors | Happy path → `destination-digest-mismatch-after-write:copy-closure` |
| 12 | Instantiate the native filesystem, with the counter vector now added last (NEW-03) | **DETECTED**, 1 vector | `instantiations=1 nativeOpens=0` |

Probe 4 is worth reading closely. It fails 12 vectors, and `removal/happy-path`
among them — but **not** `removal/fixture-was-installed`, because the install
fails *after* the destination directories are created. That is the discriminator
this project added for exactly this case working as designed: it distinguishes
"removal is broken" from "there was nothing to remove".

## 7. Tests, coverage, build, packaging

Every figure re-measured in this checkpoint, not transcribed.

| Gate | Result |
| --- | --- |
| Sealed native build | clean, **0 warnings, 0 errors** (`TreatWarningsAsErrors`, `AnalysisMode=All`) |
| Reviewed-proof native build | clean, 0 warnings, 0 errors |
| TypeScript typecheck (process-broker) | clean |
| TypeScript build | clean |
| process-broker tests | **413 passed, 0 failed, 0 skipped** (7 files) |
| Statement coverage | **92.53 %** (2120/2291), floor 90 |
| Branch coverage | **86.00 %** (1291/1501), floor 80 |
| Function coverage | **98.34 %** (356/362), floor 90 |
| Line coverage | **93.66 %** (2024/2161), floor 90 |
| Repository-wide `npm run check` | **pass** — typecheck, then tests, then build, across all 32 workspace packages |
| Repository-wide test total | **2,684 passed, 0 failed, 24 skipped** across 32 suites |

Coverage rose on all four axes from the `bb2c205` baseline of
92.49/85.88/98.33/93.61. No threshold was modified. Test count moved 409 → 413,
and all four additions are source-level pins: one for F-01 (single handle-object
construction site), one for F-04 (the elevation query's shape), one for F-10 (the
governed-or-carved-out directory census), and one for NEW-01 (no bare numeric
information class at any call site).

The 24 skips are the pre-existing intentional live-provider opt-ins, unchanged by
this work. The repository-wide total moved from the 2,579 passed / 24 skipped
recorded at the Stage 16→17 checkpoint to 2,684 passed / 24 skipped.

An honest process note about the repository-wide run. A first `npm run check` was
started before the audit-response fixes and was **discarded rather than reported**,
because source changed while it was in flight and a result measured against a
mixed tree is not a result. It was stopped cleanly and its worker processes were
verified gone — every remaining Node process predated it. The figures above come
from a single uninterrupted run over the exact final tree.

The three tests that failed while this work was in progress are recorded because
each was a pin doing its job rather than a defect:

1. `pins the exact imported libraries and entry points` failed on the new
   `SetFilePointerEx` import, which is the mechanism that forces a new native
   import to be declared deliberately.
2. The same test failed again until `SetFilePointerEx` was placed in a category —
   a new `file-position` category, because moving a handle's offset is its own
   capability and not a sub-case of reading.
3. `forbids … registry … APIs everywhere` failed on `Microsoft.Win32`, correctly,
   for `SafeHandles` (see F-14).

## 8. Findings not fixed, and why

These are the auditor's lower-severity findings that this checkpoint records
rather than closes. None is a security exposure in the current gated state, and
each is named so it cannot be quietly forgotten.

| ID | Sev | Disposition |
| --- | --- | --- |
| F-06 | MED | **Already fixed** at `bb2c205`, which committed the ADR corrections alongside their code. Verified: the ADR is no longer the only modified file. |
| F-11 | LOW | The "whole request set" is a nine-element literal array, so a new `OpenRequests` factory is silently uncovered. Recorded. |
| F-12 | LOW | `InspectWithoutTraversing` is called only from conformance vectors, so ADR §2.1's `FILE_OPEN_REPARSE_POINT` requirement is met by code no transaction reaches. Recorded. |
| F-16 | LOW | The bytes installed come from `ReadThroughHandle` and the bytes fingerprinted come from a second `MeasureFile` read. **Deliberately not "fixed"**, and this is a decision rather than an omission: adding a read-versus-measure agreement check would have refused the `source-bytes-swapped-after-measurement` vector with a new code, changing that vector from proving the fingerprint check works to proving the new check works. Blunting an existing discriminator to close a LOW finding is the wrong trade. Mitigated by `FILE_SHARE_READ`-only on the source. |
| F-18 | INFO | The installer's filename grammar is stricter than the supervisor's (it also rejects `~`). Fail-closed, but no parity test pins the two together. Recorded. |
| F-19 | INFO | `removal/shared-ancestors-are-retained-when-creation-is-unproven` cannot discriminate removal of the `AncestorCreatedByThisTransaction` guard; `removal/happy-path` would flip. Redundancy, not exposure. |
| F-20 | INFO | Only the last known-folder component becomes an `AncestorRecord`, so the retained `C:\` volume-root handle is never `AccessCheck`ed. Recorded. |
| F-21 | INFO | The group SID is requested and discarded though the SDDL sets `G:BA`; `SE_DACL_AUTO_INHERITED` is declared and never compared. Recorded. |
| F-22 | INFO | `entry += nextOffset` in the directory walk has no bound against the buffer end. Kernel-filled buffer. Recorded. |

Two limits inherited unchanged from `bb2c205` and restated because they bound
everything above: `sourceEnvelopeFingerprint` is not reproducible across clones
(`core.autocrlf=true`, no `.gitattributes`), and the TypeScript verifier remains
a pre-filter that cannot hold Windows share modes.

## 9. Host residue

Measured after all work completed.

| Check | Result |
| --- | --- |
| `C:\ProgramData\AI-Dev-OS` exists | **false** |
| Historical `%TEMP%` baseline | **64 of 64 unchanged** (22 `ai-dev-os-stage17-*`, 42 `aidevos-sqlite-*`) |
| AppContainer registry mappings matching `AiDevOs` | **0** (mappings key absent) |
| Live supervisor/helper processes | **0** |
| UAC transactions | **0** |
| Tracked binaries in git | **0** |
| Native build output location | task-owned scratch directories outside the repository |

The 64-directory baseline is the figure ADR 0018 §6 fixes, and it is unchanged:
nothing in this checkpoint created, removed, renamed, or opened any of them.

## 10. Independent audit

A fresh Claude Fable 5 session (self-reported `claude-fable-5`), with **no Edit or
Write tools**, audited the uncommitted diff. 39 tool uses. It compiled nothing,
ran no binary, and created no state — those restrictions were honoured on trust
for shell access and enforced mechanically for file mutation.

**VERDICT: PASS.**

The auditor confirmed all thirteen targeted findings fixed **in the real code
path**, distinguishing "the defect is gone" from "the defect is gone and its
return would be detected" for each. It independently reproduced two figures this
checkpoint asserts — the twenty-two process-creation-family call sites in the
carved-out tooling, and the pinned install sequence, which it traced element by
element against the transaction code rather than accepting.

It raised six new findings, all LOW or INFO, none of which makes a guard vacuous
or reopens a closed exposure. Four are fixed; two are recorded.

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| NEW-01 | LOW | `QueryFacts` passed the raw literal `1` instead of `FileStandardInfo`, so the vectors pinning those ordinals did not govern that call site, and a FALSE return left `endOfFile = 0` — a benign-looking answer to a query that failed, which vacuously satisfies the pre-read maximum-size gate. | **Fixed.** The call goes through the same named-constant helper the measurement uses, and a failed query is a refusal. A new source pin forbids a bare numeric information class at any call site, so the ordinal vectors now reach all of them. **Defect proof:** reintroducing the raw literal fails the pin by name. |
| NEW-02 | LOW | The comment claimed the happy path fails if *either* source rewind is removed, and that each rewind followed an operation that had advanced the offset. False for the first of the two: it preceded the first read on a freshly opened handle. A decorative call documented as a guard, which is this project's own finding class. | **Confirmed. Fixed** by removing the call and restating the rule exactly. **Defect proof:** removing the one remaining source rewind now fails 12 vectors including the happy path, so the two-sided claim is true as written. |
| NEW-03 | INFO | The counter vector was added mid-suite, so it observed only the vectors preceding it; an instantiation by a later vector — including every transaction vector — would not have flipped it. Enforcement rested on the packaging script, not the suite. | **Fixed.** The vector is now added last, after every other vector has run, so it covers the whole suite. Defect proof re-run and still detects. |
| NEW-04 | LOW | The production-shaped manifest is still written before `assertGateMatchesRecipe` runs, so a mis-flavoured closure would leave a valid-looking manifest on disk before the run aborts non-zero. Unreachable in this pipeline, since production components are forced sealed and the environment is neutralised. | **Recorded, not fixed**, and the reason is a rule rather than an omission: exercising the packaging script end to end needs supervisor and helper builds plus `dist`, which this checkpoint did not run. Editing a script I cannot exercise would be the unverified-change pattern this project exists to avoid. Carried forward. |
| NEW-05 | INFO | `RefusalCode.DeleteFailed` is now dead — declared and spelled, produced nowhere — and a flush failure is no longer distinguishable by code from a generic I/O failure in the same step. | **Recorded.** A collapse of diagnostic granularity, not of a guard; the previous mapping was strictly worse. The enum entry is retained because the refusal set is a closed protocol, and `EveryCodeHasASpelling` still holds. |
| NEW-06 | INFO | Passing `DefineConstants` as a global property makes it immutable, so the SDK targets that append `NET9_0`, `TRACE` and `WINDOWS` are skipped in a reviewed-proof build. No source uses them today. | **Recorded in the csproj**, where the consequence is now written down: a future `#if NET9_0` or `Trace.*` would compile differently between flavours, and that must be noticed deliberately rather than discovered. |

The auditor also confirmed what it could **not** verify read-only, and this file
does not claim otherwise: that either flavour compiles, that any vector's observed
value equals its expected value at runtime, the `DefineConstants` both-ways build
experiment, and anything about the native adapter's actual runtime behaviour. The
first three are covered by the measured results in sections 5, 6 and 7 of this
file; the fourth remains the ADR 0018 §7a boundary and is not closed by anything
here.

One judgement of the auditor's is worth recording because it is a cost this
checkpoint accepted knowingly: it called
`linkage/simulation/chain-is-built-by-the-contract` **redundant** with the probe
variant, since both exercise the same base-class code path. That is correct. It is
retained anyway, because the finding it guards against was specifically a property
that held in the simulation and not in the adapter, and a reader comparing the two
vectors can see at a glance that both implementations are graded against one
expected string. It is redundancy, and naming it as such is the point.

## 11. Exact Windows truth state

Unchanged by everything in this document:

- Windows backend: **unavailable**, detail
  `windows-native-process-composition-and-corpus-unverified`.
- Production execution: **refused**. Production registration: **unavailable**.
- All isolation capabilities: **false**. All quota dimensions: **unsupported**.
- Controlled provider egress: **unavailable**.
- Windows escape corpus: **0/40 `not-run`**, positive controls not run.
- Stage 17: **gated**. Stage 18: **blocked**. Release tag: **absent**.
- Pinned bundle fingerprint table: **empty and frozen**.
- The native marshalling layer: **has never executed**.

## 12. Smallest separately authorized next action

Unchanged in substance from the previous checkpoint, and now better founded: a
**decision on the elevation package**, specifically whether to accept the
residual check-to-use race or to require native handle-based ancestor
verification first.

What has changed is the quality of the artifact that decision is about. The three
HIGH defects were all inside the boundary ADR 0018 §7a identifies as
unverifiable by simulation, and all three are now fixed with observable
regressions. The transaction logic is verified; the marshalling still is not, and
no statement in this file claims otherwise.

The ordered remainder after that decision is unchanged: implement the native
lifecycle behind the two-factor gate; implement the fixture and the capped
controller; obtain a fresh audit of that code; request the bounded stateful matrix
under the recorded caps; and only after it passes, request the armed 40-vector
corpus.
