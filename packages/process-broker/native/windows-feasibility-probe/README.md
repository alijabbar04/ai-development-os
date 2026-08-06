# Windows sandbox feasibility probe

This dependency-free .NET 9 program is **evidence tooling**, not a sandbox
helper and not a production backend. Its `probe` and `self-test` commands are
read-only: they check exact System32 DLL loads and documented export names
relevant to the Stage 17 Windows architecture decision. Neither command
creates an AppContainer profile, changes an ACL, creates a Job Object, launches
a process, or mints process-broker registration/session evidence.

Protocol version 5 also contains `profile-lifecycle-proof`, a deliberately
stateful command that may be run only after explicit authorization. It accepts
one strictly named test profile and a matching direct child of the current
user's temporary directory. It creates the profile with zero capabilities,
observes its folder and registry records, applies the AppContainer SID to the
task-owned directory, restores the original DACL, deletes the empty directory,
frees every returned SID, calls `DeleteAppContainerProfile`, and verifies the
folder and exact registry records are absent. It never launches a workload.

Protocol version 5 additionally contains `synthetic-process-proof`. This
separately authorized command creates a fresh zero-capability AppContainer
profile and task-owned staging directory, copies and hashes the exact System32
`cmd.exe` image into that directory, and launches only a fixed built-in `echo`
fixture. The target is created suspended with security capabilities, one
private Job list, and an explicit two-handle inheritance list in a single
`STARTUPINFOEX` attribute list. Before resume, the command verifies the target
token is the expected AppContainer with zero capabilities and that the private
Job contains exactly that one process. The Job has kill-on-close and a
one-process limit with no breakaway flags. The command then resumes the target,
validates its fixed marker and zero exit, drains the Job, restores the original
DACL, deletes the staged image/directory/profile, and verifies measured residue
is absent. It passes only a fixed eight-entry environment block and inherits no
user environment.

Protocol version 5 retains `structured-boundary-proof`, which remains separately
authorized evidence tooling. It launches a digest-pinned, shell-free,
self-contained fixture in the same zero-capability AppContainer and
creation-time one-process Job. The fixture checks a fixed allowed staged read,
denied staged write and protected same-user canary access, local loopback
transfer against live parent TCP/UDP controls, and eight normal plus eight
breakaway child attempts. The result preserves the observed distinction that
TCP connection was denied while bind/listen and UDP `SendTo` returned success;
neither a TCP connection nor UDP datagram reached the parent. The proof then
restores/removes its task resources and verifies profile/registry absence.

Protocol version 5 adds `helper-lifecycle-crash-proof` and the internal
`helper-lifecycle-worker`. This is a separately authorized bounded controller/
helper proof, not a reusable workload protocol. Each fresh helper receives one
maximum-4,096-byte 4-byte-little-endian-length-prefixed strict UTF-8 JSON
request over controller-created anonymous pipes. It accepts only the fixed
normal, disconnect, and four controlled helper-termination scenarios and exact
ordered checkpoints. Malformed, duplicate, oversized, out-of-order, and
unknown frames fail closed with stable body-free codes.

The controller owns the exact fresh unnamed kill-on-close/no-breakaway/
one-process Job, exact helper process handle, opposite pipe ends, and
token-derived recovery manifest. The helper inherits only request read,
response write, the duplicated exact Job, and one NUL standard-stream handle;
it receives a fixed empty-baseline environment. Target Job membership is
assigned at creation. Normal/disconnect paths require helper cleanup; actual
helper termination paths require the surviving controller to drain the exact
Job and remove only validated token-derived files, empty directories, ACL and
profile state. Every scenario stops on a nonzero residue observation.

The probe intentionally reports `unavailable` even when every export is
present. Export presence is not enforcement proof. The experimental
`processmodel.dll` route additionally requires the exact authoritative
`SandboxSpec.fbs` layout, and the public Win32 composition requires a reviewed
native AppContainer/Job process creation, packaging, and corpus evidence.

Build with the installed SDK while directing generated files outside the
repository:

```powershell
dotnet publish .\AI.DevOS.WindowsSandboxFeasibilityProbe.csproj `
  --configuration Release `
  --self-contained false `
  --output <task-owned-output-directory> `
  -p:BaseIntermediateOutputPath=<task-owned-intermediate-directory> `
  -p:BaseOutputPath=<task-owned-base-output-directory>
```

Run the protocol and dependency-free self-test with the framework-dependent
apphost produced by that build:

```powershell
<output-directory>\AI.DevOS.WindowsSandboxFeasibilityProbe.exe probe
<output-directory>\AI.DevOS.WindowsSandboxFeasibilityProbe.exe self-test
```

`probe` exits with code 2 while the production composition remains
unavailable. `self-test` exits with code 0 only when two observations serialize
byte-identically, the response is body-free, and no profile/process mutation
was attempted. Unknown commands fail with a stable body-free refusal.

The stateful command is intentionally not part of routine validation:

```powershell
<output-directory>\AI.DevOS.WindowsSandboxFeasibilityProbe.exe `
  profile-lifecycle-proof `
  AiDevOs.Stage17.ProfileProof.<32-lowercase-hex> `
  "$env:TEMP\ai-dev-os-stage17-profile-proof-<same-hex>"
```

Do not run it repeatedly or without explicit authorization. Its successful
result proves only same-user profile/ACL lifecycle cleanup on that exact host;
it does not prove identity, filesystem, network, Job, process-tree, quota, or
escape-corpus enforcement.

The synthetic process command is also intentionally excluded from routine
validation and requires separate explicit authorization:

```powershell
<output-directory>\AI.DevOS.WindowsSandboxFeasibilityProbe.exe `
  synthetic-process-proof `
  AiDevOs.Stage17.ProcessProof.<32-lowercase-hex> `
  "$env:TEMP\ai-dev-os-stage17-process-proof-<same-hex>"
```

A passing result is only a one-host feasibility observation for creation-time
AppContainer identity and private-Job membership. It is not a production
helper, does not exercise a provider or repository workload, and does not
prove filesystem denial, network denial, quotas, crash recovery, packaging,
or the Windows escape corpus.

The structured boundary command is likewise excluded from routine validation
and requires fresh explicit authorization:

```powershell
<output-directory>\AI.DevOS.WindowsSandboxFeasibilityProbe.exe `
  structured-boundary-proof `
  AiDevOs.Stage17.BoundaryProof.<32-lowercase-hex> `
  "$env:TEMP\ai-dev-os-stage17-boundary-proof-<same-hex>" `
  "$env:TEMP\ai-dev-os-stage17-boundary-canary-<same-hex>" `
  <absolute-path>\AI.DevOS.WindowsBoundaryFixture.exe `
  <exact-lowercase-fixture-sha256>
```

A passing result is a bounded one-host observation only. In particular, the
socket-creation results are not blanket network denial, the 16 child attempts
are not the process-tree corpus, and normal cleanup is not crash cleanup. The
fixture source is sibling evidence tooling under `windows-boundary-fixture`;
neither its source nor its published binary is included in the npm package.

The helper lifecycle command is also excluded from routine validation. Its
completed Stage 17 run consumed most of the finite authorization, so do not run
it again without a fresh explicit cap. Its exact argument shape is retained for
evidence review only:

```powershell
<output-directory>\AI.DevOS.WindowsSandboxFeasibilityProbe.exe `
  helper-lifecycle-crash-proof `
  <absolute-exact-helper-apphost> `
  <lowercase-helper-apphost-sha256> `
  <lowercase-helper-managed-payload-sha256> `
  <absolute-exact-self-contained-fixture> `
  <lowercase-fixture-sha256> `
  <prior-profile-create-count> `
  <prior-helper-process-create-count> `
  <prior-appcontainer-fixture-create-count> `
  <prior-other-task-process-create-count>
```

The retained matrix passed all six fixed scenarios at cumulative counts 9
profiles, 9 helpers, 7 AppContainer fixtures, and 2 ordinary fixture controls,
18 total helper/fixture processes under the 10/10/20 caps. Every per-scenario
and final residue scan was zero and no manual recovery was needed. Three prior
failed development attempts remain failed in the release evidence even though
their exact bounded recovery succeeded. This does not prove a production
helper, installed-artifact immutability, general filesystem/network/IPC/
credential isolation, quotas, packaging, or any of the 40 Windows corpus
vectors.
