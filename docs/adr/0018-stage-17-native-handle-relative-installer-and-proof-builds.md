# ADR 0018: Native handle-relative proof installer, real lifecycle call sites, and the sealed/reviewed-proof build split

Status: Accepted as the reviewed design for a readiness checkpoint. No UAC
transaction, no stateful proof, and no production promotion is authorized by
this decision.
Date: 2026-08-06

Extends ADR 0017. Does not supersede it. ADR 0014 (trust boundary) and ADR 0015
(Windows feasibility) remain in force.

## 1. Decision: PowerShell is rejected as filesystem security authority

The elevation package prepared at `093203c` — `proof-install-root.ps1`
(`f6bafae1…`) and `proof-remove-root.ps1` (`39c216c5…`) — is **rejected and must
not be executed**. Its residual path-based check-to-use race is not accepted.

The reason is structural, not a matter of patch quality. Those scripts
authorize by *path*: they resolve a string, inspect what that string currently
names, and then act on the same string a moment later. Between those two steps
the name can be re-bound. Every hardening applied to them — ancestor ownership
verification, pre- and post-creation reparse checks, delete-class rights
analysis, assertion of the resulting DACL — narrows the window without closing
it, because the authority is the name rather than the object.

Direct measurement on the target host established that the window is reachable
in practice and not merely in theory: `C:\ProgramData` grants
`BUILTIN\Users:(CI)(WD,AD,WEA,WA)` and `CREATOR OWNER:(OI)(CI)(IO)(F)`, and an
unelevated process was observed creating a directory there, becoming its owner
with FullControl, and removing it again. An unelevated attacker can therefore
create and own `AI-Dev-OS`, which confers `FILE_DELETE_CHILD` over any leaf
inside it — enough to delete or rename a "protected" directory regardless of
that directory's own DACL — and can pre-plant a junction for the elevated
transaction to follow.

**Authority moves to retained handles.** A handle names a specific object, not a
string that resolves to one. Once an ancestor is open, subsequent operations
performed relative to that handle cannot be redirected by renaming anything
above it.

### What PowerShell may still do

- Compose and display a plan for human review.
- Launch the native utility under UAC.
- Format the native utility's machine-readable result.

It may not decide whether a path is safe, whether an ancestor is trustworthy,
what to create, what to delete, or whether an install succeeded. No
`Remove-Item -Recurse` may remain on any elevation-authority path.

## 2. Native handle-relative installer and remover

A new proof-only native component owns install and removal enforcement. It is
excluded from the npm package and from every production discovery path.

### 2.1 Required filesystem semantics

The utility must not use a path-check-then-path-use sequence as its authority.
It must instead:

- open the `CommonApplicationData` ancestor as a directory handle, resolved
  through the shell/known-folder API rather than the `%ProgramData%` string;
- walk each subsequent component **relative to its already-open parent handle**,
  using `NtCreateFile` with `OBJECT_ATTRIBUTES.RootDirectory` set to that
  parent, or a demonstrably equivalent handle-relative primitive;
- set `OBJ_DONT_REPARSE` on **every relative hop**, so a reparse point in the
  chain fails the open rather than redirecting it, and use
  `FILE_OPEN_REPARSE_POINT` where the intent is to inspect a link rather than
  traverse it;

  **Correction, found during implementation.** An earlier revision required
  `OBJ_DONT_REPARSE` on *every* open including the initial absolute one. That
  is unsatisfiable: `\GLOBAL??\C:` is itself an object-manager symbolic link, so
  the flag makes the root open fail on every stock Windows host. The requirement
  now applies to the relative hops, which is where traversal redirection is
  possible. The single absolute root open instead uses `\GLOBAL??` rather than
  `\??` together with `OBJ_IGNORE_IMPERSONATED_DEVICEMAP`, so a per-logon-session
  device map — which an unelevated process in the same session **can** add
  entries to — cannot supply the drive letter, and volume identity, filesystem
  type, and final path are then verified through the returned handle.
- request directory semantics explicitly (`FILE_DIRECTORY_FILE`) so a file
  masquerading as a directory component is refused;
- retain every ancestor handle for the whole transaction, opened **without**
  delete sharing, so no ancestor can be renamed or deleted underneath the
  operation;
- inspect security descriptors, reparse attributes and tags, final path, volume
  identity, and file identity **through those handles**, never by re-resolving
  the path;
- create each protected directory atomically relative to its retained parent,
  with the intended security descriptor supplied **at creation** — never create
  a user-owned directory and repair its ACL afterwards, which is itself a
  window;
- use create-only disposition (`FILE_CREATE`), so an attacker who wins a race
  causes a collision and a refusal, never an adoption of an existing object.

If a component already exists, it must be opened handle-relatively and required
to match the exact approved type, owner, DACL, identity, and non-reparse status,
or the transaction refuses. An unexpected existing component is never repaired.

### 2.2 Honest limits of `NtCreateFile`

Calling `NtCreateFile` does not by itself close the boundary, and this ADR does
not claim it does. The guarantee depends on every one of: correct
`RootDirectory` use on each hop; the reparse flags actually being set; share
modes that exclude delete; handle lifetime spanning the whole transaction;
correct `NTSTATUS`-to-refusal mapping including the statuses that mean
"something changed underneath you"; correct native allocation and release of
`UNICODE_STRING`, `OBJECT_ATTRIBUTES`, and security descriptors; and no fallback
path that quietly reverts to a path-based API. `NtCreateFile` is documented but
is a lower-level API whose contract can change; that is an accepted, recorded
cost of obtaining the property at all, and it is why the interop is confined to
an allow-listed file set (section 5) and audited call site by call site.

### 2.3 Protection target

Root: `C:\ProgramData\AI-Dev-OS\Stage17-Proof\<32-lowercase-hex-run-token>`.

`SYSTEM` and `BUILTIN\Administrators` may hold FullControl. The unelevated proof
identity receives only the read and execute rights it needs. The result is
verified by an `AccessCheck` against a **standard** token — obtained via
`TokenLinkedToken` when the transaction is elevated, with no fallback to the
elevated token — proving the proof identity lacks the rights it must not have.

**Which mask applies to which object, corrected during implementation.** An
earlier revision required proving the absence of write, delete, rename,
DACL-change, owner-change, and delete-child authority without saying on which
objects. Applied to `C:\ProgramData` that is unsatisfiable, because stock
Windows grants `BUILTIN\Users` write-class rights there, and a check nobody can
satisfy is a check everybody disables. The rule is therefore split:

- on the three objects this transaction creates and owns — `AI-Dev-OS`,
  `Stage17-Proof`, and the run leaf — the **full** forbidden mask applies:
  write-data, append, write-EA, write-attributes, delete-child, `DELETE`,
  `WRITE_DAC`, `WRITE_OWNER`;
- on the shared pre-existing `C:\ProgramData` ancestor, only the
  **delete-and-control** subset applies: `DELETE`, delete-child, `WRITE_DAC`,
  `WRITE_OWNER`. Ordinary write access there cannot reach an existing leaf; the
  rights that can are the ones checked.

Inherited and inherit-only ACE semantics must be evaluated correctly: an
inherit-only ACE grants nothing on the object carrying it.

Mutable journals and staging data live **outside** the immutable installed
closure.

### 2.4 Source-closure and destination trust

The elevated utility trusts no caller-supplied path, manifest, digest, or
filename. It opens the source root and manifest through retained handles;
refuses reparses at the source root and below; denies write and delete sharing
while measuring and copying; enforces the exact closed filename grammar,
rejecting alternate data streams, device and UNC spellings, trailing dots and
spaces, wildcards, case duplicates, missing files, and extra files; hashes
through the exact retained source handles; creates destination files relative to
retained destination handles; writes, hashes, and flushes through those handles;
and re-measures before reporting success.

**A fingerprint supplied on the command line is not a trust root.** The expected
candidate fingerprints are bound in reviewed proof configuration compiled into
the utility. An operator can choose *which* reviewed candidate to install; an
operator cannot introduce a new one by typing a hash.

An existing installed version is refused, never overwritten.

### 2.5 Removal and partial-install recovery

Removal is native and handle-relative on the same terms. It opens the exact root
chain through retained handles; validates run token, component identity,
manifests, file identity, owner, DACL, and reparse status; deletes exactly the
manifest-listed files by handle; deletes manifests last, so an interrupted
removal is still recognizable; refuses unexpected entries rather than deleting
them; and removes directories only after proving them empty. `C:\ProgramData` is
never removed — it is not in the component list at all, which is stronger than a
check that could be deleted. No wildcard, recursive, prefix, or
caller-supplied-path cleanup exists anywhere on the authority path.

**Ambiguity resolved during implementation.** An earlier revision allowed
removing `Stage17-Proof` and `AI-Dev-OS` "only if this transaction created
them". Removal is a *different invocation* from install, so a removal
transaction never created anything and the clause has no consistent reading.
Resolved conservatively: the shared ancestors are **always retained**. An empty
directory an operator can inspect and delete is a better outcome than a deletion
the transaction cannot justify from its own records.

An unrecognized object is a refusal requiring operator review, not something to
clean up. That is deliberate: silently deleting an object you cannot explain is
how a cleanup routine becomes an arbitrary-delete primitive.

## 3. Real lifecycle call sites

The supervisor and helper currently contain no `CreateProcessW` at all. This
decision introduces exactly three reviewed creation sites in source:

1. the proof controller creates the exact installed supervisor;
2. the supervisor creates the exact installed helper;
3. the helper creates the fixed synthetic target, suspended.

Every site uses `CreateProcessW` with an exact absolute `lpApplicationName`
(never null), a writable correctly quoted command-line buffer, no PATH lookup,
an explicit application directory and controlled DLL-search posture, a canonical
bounded environment block, `STARTUPINFOEX` with
`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, and `bInheritHandles = TRUE` only alongside
that exact allow-list. Process and thread handles are closed deterministically,
every failure maps to a stable body-free refusal, the relevant
`VerifiedClosureLease` stays alive until `CreateProcessW` returns, and
`AssertCreationPermitted` runs at the last point before the call. The child's
protocol identity is cross-checked before READY is trusted.

Target creation additionally uses `PROC_THREAD_ATTRIBUTE_JOB_LIST`,
`PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, `CREATE_SUSPENDED`, the exact
private Job, and the exact AppContainer SID and capability set, with resume only
after all validation and journal checkpoints succeed.

**Ownership is unchanged from ADR 0017 §1 and is restated because the
implementation now makes it real:** the supervisor owns the primary Job handle;
the helper receives only the duplicated handle needed to name the Job at target
creation and **is not itself a member of that Job**; the target joins at
creation; the Job has kill-on-close, the reviewed active-process cap, and no
breakaway; the supervisor owns and monitors the exact helper process handle; the
helper detects supervisor loss through its exact inherited control handles;
broker EOF is a fail-closed shutdown trigger; and no cleanup authority derives
from a PID, an image name, or process enumeration. Enumeration is external
evidence only.

**Writing these call sites does not exercise them.** Until a `CreateProcessW`
actually runs under a later authorization, no claim may be made that the
handle-retaining lease has crossed a real creation boundary. The property
remains designed and unit-tested against a simulated boundary.

## 4. Sealed versus reviewed-proof builds

There is a contradiction at `093203c`: `AIDEVOS_STAGE17_REVIEWED_PROOF_MODE`
compiles the authorization constructor, but `MutatingOperationsEnabled` is
unconditionally `false`, so even a proof build cannot execute a mutating path.
The gate is currently a wall with a door drawn on it.

This decision resolves it with two explicit recipes:

- **Sealed** — the default and the only recipe whose output may approach
  production. Structurally unable to mutate: the authorization capability's
  constructor is not compiled, so no instance can exist by any means.
- **Reviewed-proof** — a separate recipe that compiles the capability's single
  construction site and enables the mutating branch. Its output is visibly and
  verifiably distinct: a different build flavor reported by both
  `describe-artifact` and `self-test`, and different manifest and conformance
  fingerprints.

**Do not use the `.exe` hash as the flavour discriminator.** Implementation
measurement showed the apphost is **byte-identical between flavours** — it is a
copied template patched with the app name, and nothing flavour-specific reaches
it. The difference lives in the sibling managed assembly, the manifest
fingerprint, and the conformance digest. An earlier revision said "different
artifact fingerprints" without qualification, which would invite exactly the
wrong check.

Every mutating entry point requires the capability **by signature**, so a sealed
build cannot reach one even if a branch is mistakenly left enabled. No
environment variable, registry value, configuration file, manifest field,
ordinary CLI switch, reflection path, or caller-supplied boolean can turn a
sealed build into a proof build.

The proof controller refuses a sealed binary — it cannot perform the proof.
Production discovery refuses a proof binary — it must never be promoted.
Proof-mode binaries are excluded from npm packaging, and the production pinned
fingerprint table remains empty.

**Sealed and proof binaries are not byte-identical and this decision does not
pretend otherwise.** That has a direct evidentiary consequence, stated plainly:
a successful lifecycle result obtained from a proof-mode artifact **does not
promote the sealed artifact**. The two are different bytes; evidence about one
is not evidence about the other. A future release path must either prove the
sealed artifact directly or record explicitly why proof-mode evidence is
considered transferable, and this ADR does not grant that transfer.

## 5. Interop governance

ADR 0017 §9a required the no-interop denylist to be replaced rather than
deleted. This decision performs that replacement.

A narrow reviewed allow-list names the exact files permitted to contain
`DllImport`/`LibraryImport`, `Marshal` or unsafe/native allocation,
`NtCreateFile`, `CreateFileW`, `CreateProcessW`, Job APIs, AppContainer APIs,
security-descriptor APIs, and journal-durability APIs. Every other production
and native source file must remain free of interop.

Enforceable checks cover: the exact allow-listed file set; the exact imported
libraries and entry points; absence of dynamic `NativeLibrary.Load`/`GetExport`;
absence of reflection-generated invocation; absence of any new process-creation
call site; absence of shell creation; absence of registry, service, scheduled
task, firewall, and network APIs; and no growth of the allow-list without a
deliberate ADR change.

**What textual scanning cannot prove**, stated so nobody mistakes the test for
the guarantee: a grep cannot decide reachability, cannot see source-generated
`DllImport` emitted into `obj/`, cannot follow a function pointer, and cannot
distinguish a call site behind the gate from one beside it. The allow-list is a
containment boundary on *where* interop may appear, not a proof of *how* it is
reached. Reachability is discharged by the capability-by-signature requirement
in section 4, by compiler and analyser output, by call-site review, and by
independent audit.

## 6. Historical baseline

The historical `%TEMP%` baseline for residue comparison is **64 directories**:
22 `ai-dev-os-stage17-*` and 42 `aidevos-sqlite-*` dated 2026-08-03. Earlier
checkpoints recorded only the 22. All 64 are pre-existing, are not this work's
to remove, and must be compared before and after any future stateful run.

## 7. What this decision does not authorize

No UAC transaction. No creation of `C:\ProgramData\AI-Dev-OS`. No AppContainer
profile. No Job. No `CreateProcessW` execution. No scenario matrix. No corpus.
No production promotion.

Windows remains unavailable, production execution refuses, every isolation
capability is false, every quota is unsupported, registration and receipts are
unavailable, the Windows corpus remains 0/40 `not-run`, Stage 17 remains gated,
and Stage 18 remains blocked.

## 7a. The simulation boundary

The installer's hostile-condition vectors run against an in-memory
`SimulatedFileSystem`, not against the kernel. That is deliberate — it is the
only way to exercise junction-at-each-ancestor, swap-between-checks,
collision-during-create, and delete-sharing behaviour without creating OS state
— but it bounds what the vectors prove.

**Nothing in the native marshalling layer has ever executed.** The
`DllImport` signatures, struct layouts, `UNICODE_STRING` and
`OBJECT_ATTRIBUTES` construction, NTSTATUS mapping, and handle release in the
real adapter are reviewed source and nothing more. A simulation of a syscall is
not the syscall: field offsets, calling convention, `SizeOf` values, and
allocation lifetimes are exactly the class of defect a simulation cannot catch.

So the transaction logic is verified and the marshalling is not. Any statement
that the installer "enforces" anything must carry that qualification until a
later authorized run exercises the native path.

## 8. Remaining blockers

- **Release signing and an external trust root.** The installed closure is still
  `unsigned-candidate`. Reviewed source is the only trust root, which works for
  a proof and not for a release.
- **Proof-to-sealed transfer.** Section 4 records that it does not follow.
- **The stateful proof itself.** Nothing here has run.
- **The 40-vector corpus**, which comes only after a passing lifecycle proof.
