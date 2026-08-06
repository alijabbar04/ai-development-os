# ADR 0015: Stage 17 Windows native enforcement feasibility

Status: Accepted for an honest Windows gated checkpoint with bounded profile,
synthetic-process, structured-boundary, and test-helper lifecycle/crash proofs
Date: 2026-08-06

## Decision

The Windows first-party backend remains `unavailable`. This continuation ends
at Outcome B: it records and tests bounded feasibility slices but does not
create a production sandbox, production registration, preparation receipt, or
production helper. Explicitly authorized commands proved profile cleanup and
then launched only a fixed synthetic `cmd.exe` built-in marker. The synthetic
target began suspended as the expected zero-capability AppContainer and inside
a private kill-on-close, no-breakaway, one-process Job before its first
instruction. Every created process, handle, ACL, file, directory, profile, and
measured registry record was removed. No provider or repository workload ran,
and no authority was minted.

A third explicitly authorized command replaced the shell marker with a
digest-pinned structured fixture. The staged read succeeded, a staged write
and protected same-user canary read/write were denied, and a creation-time
one-process/no-breakaway Job natively denied eight normal and eight explicit
breakaway child attempts. Live parent TCP/UDP loopback controls passed; the
AppContainer TCP connection timed out and no TCP connection or UDP datagram
crossed to the parent. Bind/listen and UDP `SendTo` returned success, so the
result is deliberately recorded as bounded transfer denial rather than a
blanket socket-syscall denial. Normal cleanup and a generic residue scan
passed.

A fourth explicitly authorized protocol-v5 command placed the same reviewed
composition behind a finite, framed, body-free, shell-free test helper. One
normal lifecycle, client disconnect before target creation, and helper
termination after setup, while suspended, while running after READY, and after
target exit all passed. The surviving controller terminated only exact handles,
drained its private Job to zero active processes, performed token-bound
supervised recovery for the four helper terminations, and observed zero residue
after every scenario. Three earlier implementation attempts remain recorded as
failed even though their exact emergency recovery and later scans succeeded.
This proves only the bounded test ownership/recovery design on one host; it is
not a production helper or production crash-cleanup result.

The preferred implementation direction is the documented public Win32
composition using an AppContainer or LPAC identity, a task-owned filesystem
staging root, and creation-time Job Object assignment through one
`STARTUPINFOEX` attribute list. Bounded instances of that composition are now
observed, including the narrow filesystem, loopback-transfer, and
process-count and test-helper lifecycle slices above, but general
filesystem/network denial, executable immutability, quotas, production crash
recovery, packaging, and the native corpus remain unproved. The
experimental `processmodel.dll` API is rejected for implementation
at this checkpoint because its exact required FlatBuffer schema layout is not
available from an installed or published authoritative Microsoft artifact.

A dependency-free .NET 9 evidence tool is retained as reviewed source at
`packages/process-broker/native/windows-feasibility-probe`. It loads only exact
System32 DLL paths, checks documented export names, hashes
`processmodel.dll`, queries whether the current process is already in a Job,
and emits a finite body-free result. Its ordinary probe and self-test never
invoke a mutating export. Its original separately authorized protocol-v2
lifecycle command invoked only profile create/derive/folder/delete and
task-owned ACL operations. Protocol version 5 retains that command, the
synthetic process command, and the structured boundary command and adds the
separately authorized test-helper lifecycle command described above. The same
program may act as the helper only inside that bounded proof; it is deliberately
not a shipped sandbox helper and always reports the production composition
unavailable.

## Observed host and evidence boundary

The exact observed host is Windows 11 Pro 10.0.26200, build 26200, x64. The
toolchain is Node 24.17.0, npm 11.13.0, Git 2.54.0.windows.1, .NET SDK 9.0.316,
and Microsoft.NETCore.App 9.0.18. No C/C++ compiler, Visual Studio build tools,
public Windows SDK include tree, installed .NET workload, WSL distribution,
container CLI, VM CLI, Git remote, or executable remote CI surface was found.

`C:\Windows\System32\processmodel.dll` was loaded by exact absolute path. Its
observed identity is:

- file/product version: 10.0.26100.8737;
- length: 192,512 bytes; and
- SHA-256: `eff290093568efbe27f3918112f3b5f44e8980412d07addfcd69ca7a03f61049`.

Both `Experimental_CreateProcessInSandbox` and
`Experimental_CreateProcessAsUserInSandbox` are exported. The documented
public AppContainer/profile, restricted-token, process-creation, Job Object,
and process-attribute exports checked by the probe are also present. Presence
does not establish semantics, containment, packaging, lifecycle, or release
eligibility.

No provider, repository, or production workload was launched and no
actual-native corpus vector ran. The probe observed `currentProcessInJob: true`
for the current Codex host process. The authorized synthetic command then
proved that one newly created private child Job could contain its suspended
AppContainer target on this host; this does not generalize to production or
adversarial process trees. The profile commands observed profile folder,
mapping registry, storage registry, and task-owned ACL state before restoring
and deleting all of it.

## Threat model and trusted computing base

The threat model and opaque two-phase admission contract in ADR 0014 remain
unchanged. Repository content, executable paths, scripts, arguments,
environment values, reparse points, workload processes and descendants,
handles, network peers, descriptors, probes, attestations, and copied JSON are
untrusted.

The proposed Windows trusted computing base would contain only:

- the Windows kernel and documented APIs actually exercised;
- reviewed process-broker control-plane code;
- reviewed first-party managed helper source and its exact verified payload;
- the exact helper protocol and build recipe;
- a uniquely named same-user AppContainer profile proven removed after use;
- task-owned isolation directories and their exact ACL changes; and
- the evidence and release procedure.

The .NET feasibility probe is evidence tooling, not part of a production
containment boundary.

## Experimental API decision

Microsoft documents the two `processmodel.dll` entry points as experimental
and subject to change. The functions require a FlatBuffer with file identifier
`SBOX` conforming to `SandboxSpec.fbs`, currently naming schema version
`0.1.0`. AppContainer mode creates or opens a per-user AppContainer profile.

The installed host contains the exports but no discovered authoritative
`SandboxSpec.fbs`, generated bindings, public header, or compiler. Microsoft's
current Learn page describes field names and behavior but does not publish the
FlatBuffer table declaration, field ordinals, enum values, or generated
bindings. The MicrosoftDocs source contains the same prose and no schema file.
Constructing the blob from inferred ordinals would be reverse engineering, and
copying an unofficial schema would add an unreviewed security dependency.

The API also does not, by its returned process information alone, prove the
Stage 17 caller-owned kill-on-close Job lifecycle, quota accounting, profile
removal, helper-crash behavior, or composition with an explicit Job-list
attribute. These are additional reasons not to treat the export as a shortcut.

Candidate 1 is therefore blocked by an exact authoritative-schema dependency
and unproved lifecycle semantics. A later Microsoft-published schema/header or
installed authoritative SDK artifact could reopen this decision, but would
still require all 40 native vectors.

## Public Win32 composition direction

Candidate 2 uses documented APIs available from the installed runtime through
reviewed .NET P/Invoke. It is the preferred next experiment, not an implemented
or selected production backend.

### Identity and network

The workload would run in an AppContainer or LPAC with no network capability
SIDs. Microsoft documents that access for an AppContainer is the intersection
of ordinary user/group access and AppContainer SID/capability access, and that
an AppContainer without a network capability cannot access the network. No
`internetClient`, `internetClientServer`, `privateNetworkClientServer`, proxy,
or loopback exemption would be granted.

A restricted token alone is rejected as insufficient: it can remove
privileges and add restricting SIDs but does not by itself create the required
filesystem or network boundary.

### Filesystem and profile

The candidate would create a unique per-session AppContainer profile and stage
the exact executable/tool closure plus an immutable workspace snapshot into a
task-owned isolation tree. Only the AppContainer SID would receive the
required read-only or read/write access. Repository paths, ordinary user
profile paths, UNC/device/volume-GUID/drive-relative/ADS paths, and unsupported
reparse points would not be granted directly.

Microsoft documents that `CreateAppContainerProfile` creates persistent
per-user folders and registry storage. `DeleteAppContainerProfile` is
idempotent for a missing profile, but open handles can prevent complete storage
removal and a failed delete leaves profile state undetermined.

After explicit user authorization, protocol version 2 created exactly one
profile named `AiDevOs.Stage17.ProfileProof.<32-lowercase-hex>` with zero
capabilities and one matching direct child of the current user's temporary
directory. The proof observed the returned SID, profile folder, mapping and
storage registry records, and explicit inheritable allow rule for that SID. It
then restored the exact original DACL, deleted the empty ACL directory, freed
the returned SID, called `DeleteAppContainerProfile` once successfully, and
observed the folder and exact registry records absent. A separate host scan
found zero matching folder, registry-name, mapping-value, storage-key, or ACL
directory residue. The profile name, SID, and ACL path are retained in evidence
only as SHA-256 fingerprints.

An earlier command attempt resolved the deterministic SID but failed before
`CreateAppContainerProfile`; it reported `profileCreated: false`, removed its
empty task directory, and left no measured residue. It is not counted as a
profile creation. Exactly one profile was created in the authorized proof.

The lifecycle-only command proves only lifecycle on this exact host. The later
synthetic command separately proved one process identity and creation-time Job
membership instance. Neither proves filesystem denial, network denial, quotas,
crash cleanup, or any escape-corpus vector.

The later protocol-v5 helper proof does not rewrite that historical result. It
created a fresh profile per scenario and separately proved bounded helper-owned
normal/disconnect cleanup plus controller-owned recovery after four actual
helper terminations. All retained and development-attempt profile, folder,
mapping, and storage records were absent after recovery. This remains test-only
feasibility rather than a production lifecycle claim.

### Race-free Job ownership and handles

The candidate would create a private Job Object before process creation, set
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, omit both breakaway flags, apply only
supported finite limits, and place its handle in
`PROC_THREAD_ATTRIBUTE_JOB_LIST`. The same `STARTUPINFOEX` list would carry
`PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, the narrow handle list, and
compatible mitigations. The synthetic proof used those first three attributes
in one list, created the target suspended, and observed the expected
AppContainer token, zero capabilities, and exactly one private-Job process
before `ResumeThread` returned a previous suspend count of one. The Job used
kill-on-close plus an active-process limit of one and omitted both breakaway
flags. That historical command proved the narrow API composition on one host,
not helper crash semantics or adversarial rapid-spawn behavior. The later
protocol-v5 proof reused the composition behind a fresh helper per scenario and
observed zero active Job processes after each controlled interruption; it still
did not exercise rapid-spawn corpus behavior.

Only explicitly duplicated stdin/stdout/stderr pipe handles would be eligible
for inheritance. Broker/helper tokens, Job handles, files, sockets, registry
handles, agents, and other ambient handles would remain non-inheritable. No
shell or reconstructed command string would be used.

### Profile, environment, executable, and lifecycle

`HOME`, `USERPROFILE`, `LOCALAPPDATA`, temporary, cache, and configuration
locations would point only into the task-owned profile/isolation tree. The
existing empty-baseline environment and denylist remain mandatory.

The backend would copy the admitted executable/tool closure into the isolated
tree, reject links/reparse points, hash source and staged bytes, and re-open and
revalidate immediately before structured native creation. Exact semantics for
locking the image against substitution remain part of the native design
review; a same-user path hash alone is not promoted into enforcement.

The bounded proof assigns recovery authority to a surviving controller: it
owns the exact unnamed Job, the exact helper process handle, the controller
pipe ends, and the token-bound recovery manifest. The helper owns its profile,
target process/thread/token, fixture-pipe, attribute-list, and normal cleanup
handles. It receives only the request-read, response-write, duplicated private
Job, and NUL standard-stream handles. Production must preserve an equivalent
supervisory ownership invariant. Protocol loss, helper or broker crash,
unconfirmed empty-Job state, or incomplete profile/ACL removal invalidates
evidence and cannot return success.

## Quota matrix

The current unavailable descriptor truthfully reports every quota dimension
`unsupported`. No matrix changes in this checkpoint.

The candidate composition may later prove broker-enforced wall clock and
output bytes plus Job-enforced CPU time, memory, and process count. Network may
be reported enforced only after no-capability AppContainer tests block the
complete Windows network corpus. Job accounting does not establish disk bytes
or file count; finite disk/file requests must remain pre-spawn refusals unless
a separate kernel-enforced design is reviewed and tested.

Potential support is not current support. The attestation and descriptor must
remain unavailable until exact boundary and quota results exist.

## Helper protocol, build, and packaging

The retained feasibility probe targets `net9.0-windows`, uses no NuGet
dependency, emits a framework-dependent apphost for exact helper creation,
enables nullable analysis, SDK analyzers, warnings as errors, checked
arithmetic, and deterministic/CI build settings, and disables unsafe code and
debug-symbol path material. Protocol version 5 has read-only `probe` and
`self-test` commands plus the separately authorized
`profile-lifecycle-proof`, `synthetic-process-proof`,
`structured-boundary-proof`, and `helper-lifecycle-crash-proof` commands;
unknown commands and invalid shapes are stable refusals. The internal
`helper-lifecycle-worker` accepts one maximum-4,096-byte length-prefixed strict
UTF-8 JSON request on fresh anonymous pipes, recognizes only fixed scenarios
and ordered checkpoints, and rejects malformed, duplicate, oversized,
out-of-order, or unknown frames. The structured fixture is a separate
offline-restored, self-contained, single-file `win-x64` evidence payload and
is also excluded from the npm package.

Two clean task-owned builds are required to have identical apphost, DLL, deps,
runtime-configuration, and fixture payloads before their digests are recorded.
This proves only the evidence payloads' build determinism. The diagnostic
source and payloads are not included in the process-broker npm tarball and are
never invoked by a platform factory.

There is no production helper protocol, production payload, digest lookup,
signing decision, or fresh installed-package native execution path. Those are
explicit packaging blockers, not inferred successes. The public registration
and receipt issuers remain package-private and the Windows factory cannot call
them.

## Availability and fail-closed rules

The Windows backend ID remains `windows-restricted-job-object`; its descriptor
remains `unavailable` with all isolation capabilities false. On Windows, both
`probe()` and `validateGrant()` report stable detail
`windows-native-process-composition-and-corpus-unverified`. On other
platforms it continues to report `unsupported-platform` without loading the
diagnostic or a Windows DLL.

No configuration boolean, helper output, descriptor, evidence JSON, or copied
attestation can promote this state. Production refusal occurs before
`prepare()`, no production receipt can be issued, and the unsafe development
backend remains explicitly selected development-only behavior.

## Tests that falsify the checkpoint claims

This checkpoint is falsified if any of the following occurs:

- the feasibility project builds with a warning or external dependency;
- two clean builds produce different invoked payload manifests;
- probe output varies without host drift, contains an absolute System32/user
  path, or reports a raw exception body;
- `probe` or `self-test` creates a profile, process, ACL, Job, or other host
  state;
- the one authorized lifecycle command requests a capability, launches a
  process, fails to observe the created folder/registry/ACL state, fails to
  restore the original DACL, or leaves any measured residue;
- the authorized synthetic command inherits an ambient user environment or a
  handle outside its two-entry list, requests a capability, starts the target
  before identity/Job observation, observes a different profile SID, permits
  breakaway, exceeds one private-Job process, runs a provider/repository
  workload, or leaves process/profile/ACL/file/directory/registry residue;
- the authorized structured command reads or writes the protected canary,
  creates the forbidden staged file, transfers a TCP connection or UDP
  datagram to the live parent receivers, permits a normal or breakaway child
  marker, reports more than one total private-Job process, hides successful
  socket syscalls as denied, runs a public-network/provider/repository action,
  or leaves task/profile/registry residue;
- the authorized helper-lifecycle command accepts an unframed, malformed,
  oversized, duplicate, out-of-order, or unknown request/checkpoint; inherits
  ambient environment or any handle outside its exact four-entry list;
  terminates by name or PID; misses an expected phase; lets a pre-resume marker
  appear; leaves a target/descendant or active Job process; requires ad-hoc
  recovery; exceeds the 10-profile, 10-AppContainer-fixture, or 20-total-process
  cap; or leaves any exact or generic measured residue;
- an unknown command is accepted;
- the TypeScript Windows factory reports available, secure-enforcing, or a
  non-unsupported quota;
- Windows grant validation accepts a production grant; or
- a public or packed-package import can resolve either issuer.

Future enforcement claims require the actual helper/integration tests plus all
40 Windows-applicable corpus vectors with armed open controls and no skips.

## Official references rechecked

- [Create Process in Sandbox](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox)
- [Restricted Tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)
- [Launch an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
- [CreateAppContainerProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile)
- [DeleteAppContainerProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-deleteappcontainerprofile)
- [GetAppContainerFolderPath](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-getappcontainerfolderpath)
- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [TerminateJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)
- [CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)
- [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [Networking basics](https://learn.microsoft.com/en-us/windows/uwp/networking/networking-basics)
- [.NET single-file deployment](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview)
- [.NET P/Invoke source generation](https://learn.microsoft.com/en-us/dotnet/standard/native-interop/pinvoke-source-generation)

## Consequence and next action

This is an honest Windows gated checkpoint, not a verified enforcement
checkpoint. Windows actual-native count remains 0/40, corpus positive controls
remain unrun, production remains closed, Stage 17 remains gated, Stage 18
remains blocked, and no Stage 17 tag or push is permitted.

The helper lifecycle/crash proof described above completed that bounded next
action. The smallest next action requiring separate authorization is a reviewed
production-helper and installed-artifact design with immutable executable
identity, packaging, update/removal semantics, and production supervisor
recovery, followed by the full armed 40-vector Windows corpus. Production must
remain unavailable until general filesystem/network/process-tree/credential/
IPC/quota boundaries, production crash cleanup, packaging, and all 40
Windows-applicable positive-control vectors pass.
