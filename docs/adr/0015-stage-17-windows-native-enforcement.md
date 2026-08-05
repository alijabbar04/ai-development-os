# ADR 0015: Stage 17 Windows native enforcement feasibility

Status: Accepted for an honest Windows gated checkpoint
Date: 2026-08-05

## Decision

The Windows first-party backend remains `unavailable`. This continuation ends
at Outcome B: it records and tests the smallest safe feasibility slice but does
not create a production sandbox, production registration, preparation receipt,
AppContainer profile, ACL grant, Job Object, or child process.

The preferred implementation direction, subject to an explicitly authorized
ephemeral-profile proof, is the documented public Win32 composition using an
AppContainer or LPAC identity, a task-owned filesystem staging root, and
creation-time Job Object assignment through one `STARTUPINFOEX` attribute
list. The experimental `processmodel.dll` API is rejected for implementation
at this checkpoint because its exact required FlatBuffer schema layout is not
available from an installed or published authoritative Microsoft artifact.

A dependency-free .NET 9 feasibility probe is retained as reviewed source at
`packages/process-broker/native/windows-feasibility-probe`. It loads only exact
System32 DLL paths, checks documented export names, hashes
`processmodel.dll`, queries whether the current process is already in a Job,
and emits a finite body-free result. The probe is deliberately not a sandbox
helper. It never invokes any mutating export and always reports the production
composition unavailable.

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

No native process was launched and no actual-native corpus vector ran. The
probe observed `currentProcessInJob: true` for the current Codex host process;
that is diagnostic only. Creation of a nested child Job and its behavior remain
untested.

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

No such profile or ACL was created in this checkpoint. Microsoft documents
that `CreateAppContainerProfile` creates persistent per-user folders and
registry storage. `DeleteAppContainerProfile` is idempotent for a missing
profile, but open handles can prevent complete storage removal and a failed
delete leaves profile state undetermined. The continuation stop rule therefore
requires an explicit, separately reviewed lifecycle proof before this host is
mutated.

### Race-free Job ownership and handles

The candidate would create a private Job Object before process creation, set
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, omit both breakaway flags, apply only
supported finite limits, and place its handle in
`PROC_THREAD_ATTRIBUTE_JOB_LIST`. The same `STARTUPINFOEX` list would carry
`PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, the narrow handle list, and
compatible mitigations. This is intended to place the initial process in the
Job and AppContainer before its first instruction, but it remains a hypothesis
until the actual helper proves membership and adversarial rapid-spawn behavior.

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

The helper would own every Job/profile/pipe/process/ACL handle. Protocol loss,
helper or broker crash, unconfirmed empty-Job state, or incomplete profile/ACL
removal would invalidate evidence and could not return success.

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
dependency or apphost, enables nullable analysis, SDK analyzers, warnings as
errors, checked arithmetic, and deterministic/CI build settings, and disables
unsafe code and debug-symbol path material. Its protocol version is 1 and has
only `probe` and `self-test` commands; unknown commands are stable refusals.

Two clean task-owned builds are required to have identical DLL, deps, and
runtime-configuration manifests before their digest is recorded. This proves
only the diagnostic payload's build determinism. The diagnostic source and
payload are not included in the process-broker npm tarball and are never
invoked by a platform factory.

There is no production helper protocol, production payload, digest lookup,
signing decision, or fresh installed-package native execution path. Those are
explicit packaging blockers, not inferred successes. The public registration
and receipt issuers remain package-private and the Windows factory cannot call
them.

## Availability and fail-closed rules

The Windows backend ID remains `windows-restricted-job-object`; its descriptor
remains `unavailable` with all isolation capabilities false. On Windows, both
`probe()` and `validateGrant()` report stable detail
`authoritative-sandbox-schema-and-profile-lifecycle-unverified`. On other
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
- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [.NET P/Invoke source generation](https://learn.microsoft.com/en-us/dotnet/standard/native-interop/pinvoke-source-generation)

## Consequence and next action

This is an honest Windows gated checkpoint, not a verified enforcement
checkpoint. Windows actual-native count remains 0/40, positive controls remain
unrun, production remains closed, Stage 17 remains gated, Stage 18 remains
blocked, and no Stage 17 tag or push is permitted.

The smallest next action is explicit authorization for one uniquely named,
same-user, test-only AppContainer profile and task-owned ACL lifecycle proof.
That proof must create no workload, close every handle, call
`DeleteAppContainerProfile`, verify the profile/folder/ACL residue is absent,
and keep production unavailable. Only after that proof should a process-launch
helper be implemented.
