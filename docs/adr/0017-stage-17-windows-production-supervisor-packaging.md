# ADR 0017: Stage 17 Windows production supervisor, helper, and immutable artifact packaging

Status: Accepted as the reviewed design for a packaged-but-unproved Windows
production candidate. Windows remains `unavailable`.
Date: 2026-08-06

Supersedes nothing. ADR 0014 (trust boundary) and ADR 0015 (Windows native
enforcement feasibility) remain in force and are extended, not replaced. ADR
0016 is the unrelated product-completeness planning decision.

## Decision

Stage 17 will grow a production-shaped Windows supervisor/helper architecture
with immutable installed-artifact identity, deterministic packaging, a finite
versioned protocol, side-by-side update semantics, bounded rollback and
removal, a durable recovery design, and fail-closed process-broker seams.

None of that establishes containment. This decision explicitly does not make
Windows available, does not create a production registration, does not issue a
preparation receipt, does not enable any isolation capability, does not change
any quota from `unsupported`, and does not change the Windows actual-native
escape-corpus state from 0/40 `not-run`.

The production supervisor and helper are **new, separate source projects** with
their own protocol, build identity, manifests, and package identity. The
existing `native/windows-feasibility-probe` and `native/windows-boundary-fixture`
are evidence tooling. They are not renamed, copied, or promoted, and no
production code path may reference them.

## 1. Process topology

Four roles plus a fifth recovery moment.

### 1.1 Broker / control plane

The reviewed TypeScript process broker in `@ai-dev-os/process-broker`, running
inside the application's Node process.

Responsibilities: parse and validate the request/grant/lease/policy decision,
evaluate containment and admission, discover and verify the installed artifact
bundle, own the pinned-fingerprint trust root, and refuse. It holds **no**
native handle, creates **no** AppContainer profile, and owns **no** Job.

The broker is the only component that may consume a production registration or
a preparation receipt, and in this checkpoint it can obtain neither.

### 1.2 Supervisor

One native process per broker instance, launched by the broker from the
verified installed bundle.

Owns:

- the **private Job Object** — created before any helper or target exists, with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, an active-process limit, and neither
  breakaway flag set;
- the **helper process handle** returned by `CreateProcessW`;
- the **recovery journal writer**;
- **recovery authority** at later application startup;
- final **zero-active-process verification** through
  `QueryInformationJobObject(JobObjectBasicAccountingInformation)` on the exact
  Job handle.

The supervisor does **not** own the target process or thread handles. It does
not need them: it holds the Job, and `TerminateJobObject` on the exact Job
handle stops every process in that Job without ever naming a PID or an image.

### 1.3 Helper

One fresh native process per operation, launched by the supervisor from the
same verified bundle, and never reused.

Owns: the AppContainer profile SID allocation, the target process and thread
handles, the target's token, the process-creation attribute list, and
normal-path cleanup.

Receives exactly four inherited handles: the request-pipe read end, the
response-pipe write end, one duplicated reference to the supervisor's private
Job, and one `NUL` handle used for all three standard streams. Nothing else is
inheritable.

### 1.4 Target

The workload. Created suspended, already inside the AppContainer identity and
already a member of the private Job through
`PROC_THREAD_ATTRIBUTE_JOB_LIST` in the same `STARTUPINFOEX` attribute list
that carries `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` and the explicit
two-handle list. Membership therefore precedes the target's first instruction.

### 1.5 Recovery at later application startup

A supervisor started by a later broker instance reads the recovery journal,
identifies operations that did not reach `cleanup-complete`, and performs
exact, non-recursive cleanup. Recovery is described in section 5.

### 1.6 Ownership table

| Resource | Normal-path owner | Recovery owner |
| --- | --- | --- |
| Private Job handle | Supervisor (primary), helper (duplicate) | Supervisor |
| Helper process handle | Supervisor | Supervisor |
| Target process/thread handles | Helper | Nobody — the Job is used instead |
| AppContainer profile create | Helper | — |
| AppContainer profile delete | Helper | Supervisor, from the derived name |
| Task-owned directory create + DACL | Helper | — |
| Task-owned directory removal | Helper | Supervisor, exact and non-recursive |
| Staged file removal | Helper | Supervisor, exact names only |
| Recovery journal write | Supervisor | Supervisor |
| Recovery journal consume | — | Supervisor at next startup |
| Zero-active-process proof | Supervisor | Supervisor |

**ACL restoration is designed out.** The helper never modifies the security
descriptor of a pre-existing object. It creates fresh, uniquely named
directories and sets their DACL at creation time. "Restoring an ACL" therefore
reduces to "delete a directory we created", which is idempotent and needs no
saved prior state. This removes an entire failure class present in the earlier
bounded proofs.

**The helper is not a member of the target Job.** This was implicit in the
original ownership table and is now stated, because two properties depend on
it. If the helper were in the Job, `TerminateJobObject` on the target Job would
also kill the helper, destroying the very component that is supposed to observe
and clean up after the target; and the Job's active-process limit would be
consumed by the helper rather than bounding the workload. The helper therefore
holds a duplicated Job handle purely to name the Job in
`PROC_THREAD_ATTRIBUTE_JOB_LIST` at target creation, and is never assigned to
it. The retained protocol-v5 evidence tooling already behaved this way; the
requirement was simply never written down.

## 2. Failure semantics

### 2.1 Broker exits normally

The broker closes the supervisor control pipe. The supervisor observes EOF,
terminates the Job, drains it to zero active processes, performs cleanup,
marks the journal `cleanup-complete`, and exits.

### 2.2 Broker crashes

Identical detection: the pipe breaks. The supervisor does **not** outlive its
control plane. A supervisor with no broker has no authority to serve and
becomes an orphan holding containment resources, so broker loss is a
fail-closed shutdown trigger, not a reason to keep running.

### 2.3 Helper disconnects or crashes

The supervisor's copy of the Job handle keeps kill-on-close from firing, so the
target is not silently released. The supervisor waits on the exact helper
process handle, then terminates and drains the exact Job, then performs exact
recovery cleanup. This is the ownership invariant the bounded protocol-v5 proof
already demonstrated in test-only form.

### 2.4 Supervisor crashes

Nothing in-process can cover this, and the design does not pretend otherwise.
Two mechanisms apply:

1. **Layered kill-on-close.** The helper also holds a Job handle, so a
   supervisor crash alone does not fire kill-on-close. The helper therefore
   must fail closed on its own control-pipe EOF: it terminates the Job and
   exits. When both die, every Job handle closes and the kernel kills the
   target.
2. **Write-ahead journal.** Filesystem and profile residue that survives a
   supervisor crash is removed by the next startup's recovery pass.

### 2.5 When evidence becomes invalid and when the backend is quarantined

Evidence is invalidated and the backend registration is quarantined on any of:
unconfirmed process-tree termination; a Job that cannot be proven drained to
zero active processes; incomplete profile or directory removal; a manifest,
size, or digest mismatch at any verification point; a protocol refusal after
target creation; a recovery pass that cannot complete exactly; or any journal
record that fails validation.

### 2.6 Failures that can never return success

Unconfirmed termination, unconfirmed cleanup, unverified artifact identity,
receipt failure, and recovery failure are terminal. They are reported as
containment failures. There is no retry through the unsafe development backend
and no downgrade path.

### 2.7 Forbidden recovery authority

Recovery may never use: a process name; a PID alone; broad process
enumeration; task-wide or recursive deletion; a guessed profile name; a guessed
filesystem path; an ambient registry search; or a fallback to
`unsafe-development-current-user`.

Recovery authority is exactly: the exact Job handle, the exact helper process
handle, and values **derived by a pure function from the operation token**.

## 3. Trusted computing base

Trusted:

- the Windows kernel and the documented APIs actually invoked;
- the reviewed process-broker control plane;
- the reviewed supervisor source;
- the reviewed helper source;
- the exact protocol defined in section 4;
- the exact build recipe in section 6;
- the exact packaged file closure named by the artifact manifest;
- the manifest and package integrity source defined in section 6.4;
- the recovery-record format in section 5;
- the task-owned isolation resources;
- the canonical escape corpus (`escape-corpus.ts`, version 1, fingerprint
  `125b809194d26cf1be518249b96727b78be80c25088826464ec94154a6fb3652`, 40
  Windows-applicable vectors); and
- the evidence and release procedure.

Untrusted: repositories; prompts; model output; workload paths and arguments;
copied manifests; descriptors; serialized attestations; configuration below
mandatory locks; arbitrary package files; environment variables; `PATH`; the
current directory; workload-created files; and helper output until validated.

## 4. Protocol

Production protocol version 1, schema version 1. It is deliberately a different
protocol from the evidence tool's version 5 and shares no code.

### 4.1 Framing

- Four-byte little-endian unsigned length prefix, then the payload.
- Payload is strict UTF-8 JSON. Invalid UTF-8 is a refusal, not a replacement
  character.
- Maximum frame payload: 8,192 bytes.
- Maximum total bytes per connection: 262,144.
- Maximum frames per connection: 32.
- Bounded wait per frame and a bounded total operation time; both expire into
  fail-closed cleanup.

### 4.2 Parsing

Exact property sets per message type. Unknown properties, duplicate properties,
missing properties, wrong types, and the property names `__proto__`,
`constructor`, and `prototype` are refusals. Numbers are bounded integers.
Strings have explicit maximum lengths and closed character classes.

### 4.3 States

Linear and monotonic:

`request-accepted` → `setup-complete` → `target-created` →
`target-suspended` → `target-ready` → `target-exited` → `cleanup-complete`

Any frame that is unknown, duplicate, replayed, or out of order terminates the
connection with a body-free refusal.

### 4.4 Binding

The setup request carries fingerprints for: request, grant, policy, lease,
workspace, tool, endpoint policy, and quotas; the supervisor identity, helper
identity, and build identity; and a fresh 128-bit nonce (the operation token).
Every subsequent frame repeats the operation token; a mismatch is a refusal.

### 4.5 Replay prevention

The operation token is registered in the recovery journal with `CREATE_NEW`
before the helper is launched. A replayed token collides with an existing
journal file and is refused before anything is created.

### 4.6 Execution rules

- One operation per fresh helper; the helper exits after `cleanup-complete` or
  any refusal.
- No shell.
- No caller-selected helper path: the supervisor resolves the helper only from
  the verified installed bundle.
- No caller-selected cleanup path: every cleanup target is derived from the
  token.
- No ambient environment: the target environment block is built from empty.
- Explicit handle lists everywhere; nothing else is inheritable.
- Failures are body-free codes from a closed enum.
- Cancellation is supervisor-initiated pipe closure; disconnect is fail-closed
  cleanup on either side.

### 4.7 Honest limitation: command-line reconstruction

Windows has no argv-array process-creation API. `CreateProcessW` takes a single
`lpCommandLine` string. The helper therefore never accepts a caller-supplied
command *string*, but it must build one from the exact argv array using the
documented `CommandLineToArgvW` inverse quoting rules, with an exact
`lpApplicationName` so the command line is never used for image resolution.
This is a stated residual, not a claim of avoidance, and it requires its own
round-trip property tests.

## 5. Recovery record

- Location: a fixed task-owned recovery directory under the application's own
  state root. Never Program Files, never a production application-data
  location, never the registry.
- One file per operation, named by the 128-bit operation token in lowercase
  hex, created with `CREATE_NEW`.
- Canonical JSON, strict schema, bounded length, with a per-record length
  prefix and record digest so a truncated trailing record is detected and
  discarded.
- Write-ahead: each phase record is flushed with `FlushFileBuffers` before the
  native step it describes. Every step is idempotent, because a crash between
  flush and step leaves it ambiguous whether the step ran.

**Paths in the journal are never trusted.** Recovery recomputes the profile
name, staging root, and file names from the token using the same pure function
the helper used, and refuses if the stored values disagree. A hostile or
substituted journal can therefore at most name a different token, and a
different token derives a different, non-existent path.

Additional hardening: the journal directory and every recovery path component
must be non-reparse; deletion is exact, file-by-file, from a closed derived
set, then `RemoveDirectory` on the exact empty directories; an operation whose
token is in the live set is skipped, so an old restored journal cannot target a
running operation.

## 6. Immutable artifact identity

### 6.1 Layout

```
<bundleRoot>/<component>/<bundleVersion>/win-x64/<exact files>
```

`component` is `windows-supervisor` or `windows-helper`. `bundleVersion` is
immutable. There is no mutable `latest` pointer, no PATH lookup, no registry
discovery, no current-directory discovery, and no runtime download.

### 6.2 Closure form: fixed, completely enumerated, self-contained multi-file

Evaluated and rejected:

- **Self-contained single-file.** The bundle extracts native assets into a
  same-user writable directory between verification and execution. That is an
  unmitigated substitution surface, it creates state the design does not own,
  and it hides the runtime inside a blob that cannot be enumerated or hashed
  file by file. Roughly 71 MB per component, and any runtime servicing change
  rewrites the whole digest.
- **Framework-dependent apphost plus managed payload.** Small (about 157 KB +
  220 KB + two JSON files) and reproducible, but the runtime resolved through
  `hostfxr` is then **outside** the enumerated trust closure. Immutable
  artifact identity would cover four files and silently exclude the code that
  actually executes.

Selected: **self-contained, `PublishSingleFile=false`**, so `hostfxr`,
`hostpolicy`, `coreclr`, and every managed assembly resolve app-locally and are
each named, sized, and hashed in the manifest. The size cost (roughly 71 MB per
component, two components, built twice for reproducibility) is accepted and
confined to task-owned temporary directories.

### 6.3 Manifest content

Schema version; protocol version; source version; build-recipe version;
platform; RID (`win-x64`); target architecture; package version; the exact file
list with exact names, exact sizes, and exact SHA-256 values; the source
envelope fingerprint; the build manifest fingerprint; minimum host and runtime
facts; signer state; and stable limitation codes.

Also bound: corpus version, corpus fingerprint, and Windows-applicable vector
count, so a manifest cannot name a shortened or stale corpus.

### 6.4 What actually protects the manifest

**A digest stored beside its binary is not an external trust root.** A manifest
sitting in the bundle it describes is an index, not evidence: anything that can
rewrite the files can rewrite the manifest.

For this checkpoint the trust root is **reviewed source**. The TypeScript
control plane holds a compiled-in table of pinned bundle fingerprints. A bundle
is acceptable only when its recomputed manifest fingerprint equals a pinned
constant for that component and version.

**In this checkpoint that table is empty.** There is no released, signed
version, so there is no pinned fingerprint, so every discovery attempt fails
closed with a stable code. That is the correct and intended outcome, and it is
what makes the seam testable without promoting anything.

Blocked until release signing exists: accepting a bundle that arrives with an
installation rather than with reviewed source. Unsigned output is represented
as `unsigned-candidate` and is never production eligible.

### 6.5 Verification immediately before use

1. Resolve the absolute bundle path; refuse if any component is a reparse
   point, if normalization is ambiguous, or if the path escapes the package
   root.
2. Enumerate the directory and refuse on any missing, extra, or duplicate file.
3. For each file, open with `dwShareMode = FILE_SHARE_READ` — denying write and
   delete — hash **through that handle**, and check size and SHA-256.
4. Keep those deny-write handles open across `CreateProcessW`.
5. Cross-check the supervisor's and helper's self-reported identity in their
   protocol responses against the manifest; a mismatch fails.

**Which process performs step 3 is load-bearing, not an implementation
detail.** Only the process that creates the process can hold a handle across
`CreateProcessW`, and Node's `fs` cannot request a Windows share mode at all.
The enforcing verification therefore belongs to the **native supervisor**,
which opens each file with `FileShare.Read` and holds it. The TypeScript
control plane's verification is a **pre-filter**: it can refuse a bundle, but
it must never be the last check before execution, and a TypeScript pass is not
evidence that the bytes are still the hashed bytes. Any future execution path
that relies on a Node-side hash alone is a defect.

### 6.6 TOCTOU: what this closes and what it does not

Holding deny-write, deny-delete handles across process creation closes the
**content substitution** window: while the handle is held, the bytes that were
hashed are the bytes that load. That mitigation exists only on the native side
(section 6.5) and is unavailable to the TypeScript verifier.

It does **not** close **path redirection**: renaming a parent directory can
still point the path elsewhere. Mitigating that requires an installation root
writable only by an administrator. Changing ACLs and installing to a protected
location are outside the current authorization, so this remains a **production
blocker**, not a solved problem.

## 7. Update and removal semantics

- Immutable versioned side-by-side bundles. In-place binary replacement is
  refused outright.
- Install: stage into a task-owned staging directory, verify the complete
  manifest and the entire closure, then a single atomic `MoveFileExW` rename
  into the versioned destination. An existing destination is a refusal, never
  an overwrite.
- Active-operation version pinning: every operation records its exact bundle
  version in the journal.
- Rollback: change which version the pinned-fingerprint table names. No
  symlink, no mutable alias.
- Removal: write a `.removing` marker, delete exactly the manifest-listed
  files, delete the manifest **last**, then `RemoveDirectory`. An interrupted
  removal is resumed from the marker at next startup.
- Removal is refused while any active or recoverable operation references the
  version.
- A partial or tampered bundle is **quarantinable** by renaming it into a
  quarantine directory, never silently deleted and never repaired. Quarantine
  is an explicit operation, not an automatic one: a bundle that fails
  verification, and a removal that cannot complete, both leave the version in a
  refusing state that neither verifies nor reinstalls until an operator
  quarantines it. Automating a rename out from under a possibly-active version
  is deliberately not done, because recovery must never move something it has
  not proved is unreferenced.
- No postinstall hook, no service installation, no scheduled task, no broad
  directory cleanup.

## 8. Availability boundary

Stated explicitly, because compilation, tests, coverage, deterministic
packaging, and successful simulation cannot alter any of it:

- No containment has been established.
- No stateful production supervisor has run.
- No production helper has created a target.
- No corpus vector has run.
- Production registration remains unavailable.
- Preparation receipts remain unavailable.
- Windows remains `unavailable`.
- All isolation capabilities remain false.
- All quota dimensions remain `unsupported`.
- Windows escape-corpus evidence remains 0/40 `not-run`.
- Stage 17 remains gated, Stage 18 remains blocked, and no Stage 17 release tag
  exists.

## 9. Issue disposition

| Issue | Disposition |
| --- | --- |
| Supervisor survives helper failure | Solved by design (dual Job handles) |
| Supervisor survives broker failure | Deliberately not survived; fail-closed shutdown |
| Job ownership | Solved by design (supervisor primary, helper duplicate) |
| Recovery authority | Solved by design (exact handles + token-derived paths) |
| Recovery avoids PID/name authority | Solved by design (`TerminateJobObject`) |
| Recovery avoids enumeration and recursion | Solved by design (closed derived set) |
| ACL ownership | Designed out (fresh directories only) |
| Journal truncation / substitution / replay / rollback | Solved by design; requires implementation and tests |
| Filesystem durability and atomicity | Requires implementation (`FlushFileBuffers`, `MoveFileExW`) |
| Installed identity, manifest and package integrity | Requires implementation; **blocked** on release signing for installed-source trust |
| Source/build identity, reproducibility | Requires implementation and two-clean-build proof |
| Signer-state honesty | Solved by design (`unsigned-candidate`) |
| TOCTOU content substitution | Solved by design on the native side only; the TypeScript verifier is a pre-filter (section 6.5) |
| TOCTOU path redirection | **Production blocker** — needs a protected install root |
| Single-file vs multi-file closure | Decided (section 6.2) |
| Framework/runtime and DLL-search risk | Solved by design (self-contained, app-local) |
| Inherited handles, environment construction | Solved by design; requires tests |
| Protocol framing, states, replay, cancellation | Requires implementation and tests |
| Command-line reconstruction | Honest residual; requires round-trip tests |
| Side-by-side update, pinning, rollback, removal | Requires implementation and simulation |
| Package publication and release trust | **Blocked** on release signing |
| Production registration non-bypass | Solved by existing design; requires regression tests |
| Running the complete corpus later | Requires native stateful proof, then the 40-vector corpus |
| Containment itself | **Requires native stateful proof and the 40-vector corpus** |

## 9-note. Superseding decisions in ADR 0018

Three parts of this ADR are extended or narrowed by
[ADR 0018](0018-stage-17-native-handle-relative-installer-and-proof-builds.md):

- Section 6.6's protected install root is now enforced by a **native
  handle-relative installer**, not by a PowerShell script. The PowerShell
  elevation package is rejected as security authority.
- Section 9a's requirement to replace the no-interop denylist is **discharged**
  by ADR 0018 section 5.
- The sealed versus reviewed-proof build split, and the rule that proof-mode
  lifecycle evidence does not promote the sealed artifact, are defined in
  ADR 0018 section 4.

## 9a. How the no-interop invariant must evolve

`test/stage-17-artifact-packaging.test.ts` asserts that the combined source of
both components contains none of `DllImport`, `Process.Start`,
`ProcessStartInfo`, `Registry`, `Environment.GetEnvironmentVariable`,
`HttpClient`, `WebClient`, `Directory.CreateDirectory`, `File.WriteAllText`,
`File.Delete`, or `Directory.Delete`.

That assertion is **true today and is deliberately retained**, but it must not
be described as more than it is. An earlier draft of this section claimed it was
"strictly stronger than any allow-list". That was wrong, and an independent
audit corrected it. It is a **literal-substring denylist of eleven strings**, and
it does not block:

- `[LibraryImport]`, the .NET 7+ source-generated P/Invoke, whose generated
  `DllImport` lands in `obj/` where the test never looks;
- `NativeLibrary.GetExport` plus `Marshal.GetDelegateForFunctionPointer`, which
  needs neither a banned string nor `AllowUnsafeBlocks`;
- `File.OpenHandle`, `File.Create`, `File.Move`, or
  `Directory.CreateSymbolicLink`.

`RegistryKey` was listed here in an earlier draft and does **not** belong: the
denylist entry `"Registry"` is a substring of it, so `toContain` already blocks
it. A later audit caught that error.

The checkpoint that added `VerifiedClosure.cs` in fact added real
filesystem-reading code — `File.OpenHandle` (`VerifiedClosure.cs:311`) and
`Directory.EnumerateFileSystemEntries` (`ArtifactPathResolution.cs:78`) — that
the "structurally read-only in source" assertion does not cover.

An earlier draft went on to say "none of the strings above appears in either
component today, so extending the denylist costs nothing". That was also wrong,
and self-contradictory with the sentence before it: `File.OpenHandle` **does**
appear, so adding it to the denylist would break the suite immediately. Only the
strings that are genuinely absent — `[LibraryImport]`,
`NativeLibrary.GetExport`, `Marshal.GetDelegateForFunctionPointer`,
`File.Create`, `File.Move`, `Directory.CreateSymbolicLink` — can be added for
free, and the interop-bearing files are handled by the allow-list in
[ADR 0018](0018-stage-17-native-handle-relative-installer-and-proof-builds.md)
section 5 instead.

It does block the native lifecycle implementation this design ultimately
requires, so the evolution is specified here rather than improvised under time
pressure. When the interop is written, the assertion must be **replaced, never
deleted**, by a declaration-site allow-list that:

- names the exact files permitted to contain interop;
- asserts every other file in each component is still clean of the extended
  string set (the current test builds its combined text **per component**, not
  across both, and the replacement should keep that); and
- asserts the allow-list has not grown without a corresponding ADR change.

An earlier draft also required the allow-list to assert that "each permitted
file's interop is reachable only behind the two-factor mutation gate". That
instruction is **not expressible by the mechanism it prescribes**: reachability
is a call-graph property and a file-scoped text test over `.cs` files cannot
decide it. Requiring it as written would leave a future agent unable to comply,
which is worse than requiring nothing. The reachability property is still
wanted; it must be discharged either by a Roslyn analyser, by an explicit
requirement that every interop call site take a
`ReviewedProofModeAuthorization` and route through `MutationGate.Authorize` so
the compiler enforces it, or by recorded human review — not by a grep.

Deleting the assertion, or relaxing it to "these strings may appear anywhere",
is a regression and must fail review. An implementation agent that finds itself
needing to remove this assertion should stop and escalate instead — which is
what happened when this checkpoint's implementation delegate reached it.

## 9b. Known reproducibility defect in the source envelope

`sourceEnvelopeFingerprint` hashes raw working-tree bytes. The repository has
`core.autocrlf=true` and **no `.gitattributes`**, so the same commit checked out
on a different machine can produce different source-envelope fingerprints purely
from line-ending translation. The closure fingerprints are unaffected, because
they hash build output rather than source.

This is pre-existing and is not fixed in this checkpoint: adding `.gitattributes`
would rewrite line endings across the tree and invalidate every fingerprint
measured here. It must be fixed before any cross-machine reproducibility claim
is made, and until then reproducibility is claimed for a single host only.

## 10. Reconciliation with the retained evidence tooling

Read-only inspection of `native/windows-feasibility-probe` and
`native/windows-boundary-fixture` produced three facts that this decision
depends on, recorded here so the reasoning is reviewable.

1. **Single-file was rejected on observed evidence, not preference.** The
   boundary fixture publishes with `PublishSingleFile=true` and
   `IncludeNativeLibrariesForSelfExtract=true`, and as a direct consequence the
   proofs must inject `DOTNET_BUNDLE_EXTRACT_BASE_DIR` into the AppContainer
   profile folder to control where the bundle extracts. That is exactly the
   writable-directory-between-verification-and-execution surface section 6.2
   rejects.
2. **The ownership model in section 1 matches what the bounded proof already
   demonstrated.** The protocol-v5 controller creates an unnamed Job with
   kill-on-close, an active-process limit, and no breakaway flag; the helper
   inherits a duplicate and uses it only as `PROC_THREAD_ATTRIBUTE_JOB_LIST`;
   and the helper is deliberately **not** a member of that Job, so terminating
   the Job does not kill the helper and killing the helper does not tear down
   the Job. Recovery used exact owned kernel handles plus a token-derived name
   manifest, never a PID or an image name.
3. **The evidence tooling is not on any production path.** No file under
   `src/` references it, and it is absent from the npm tarball.

Weaknesses observed in the retained evidence tooling are recorded in the
release-evidence file rather than fixed here: they are test-only surfaces,
fixing them is out of this checkpoint's scope, and editing them would mix
evidence-tool changes into a production-candidate commit.

## 11. Consequence

This ADR defines the artifact boundary a future production backend would need.
It does not create one. The smallest separately authorized next action remains
a bounded stateful installed-artifact and production-supervisor recovery proof
with explicit scenario, profile, supervisor, helper, target, and total-process
caps. The armed 40-vector Windows corpus comes only after that proof passes.
