# Windows sandbox feasibility probe

This dependency-free .NET 9 program is **evidence tooling**, not a sandbox
helper and not a production backend. Its `probe` and `self-test` commands are
read-only: they check exact System32 DLL loads and documented export names
relevant to the Stage 17 Windows architecture decision. Neither command
creates an AppContainer profile, changes an ACL, creates a Job Object, launches
a process, or mints process-broker registration/session evidence.

Protocol version 2 also contains `profile-lifecycle-proof`, a deliberately
stateful command that may be run only after explicit authorization. It accepts
one strictly named test profile and a matching direct child of the current
user's temporary directory. It creates the profile with zero capabilities,
observes its folder and registry records, applies the AppContainer SID to the
task-owned directory, restores the original DACL, deletes the empty directory,
frees every returned SID, calls `DeleteAppContainerProfile`, and verifies the
folder and exact registry records are absent. It never launches a workload.

The probe intentionally reports `unavailable` even when every export is
present. Export presence is not enforcement proof. The experimental
`processmodel.dll` route additionally requires the exact authoritative
`SandboxSpec.fbs` layout, and the public Win32 composition requires a reviewed
native AppContainer/Job process creation, packaging, and corpus evidence.

Build with the installed SDK while directing generated files outside the
repository:

```powershell
dotnet build .\AI.DevOS.WindowsSandboxFeasibilityProbe.csproj `
  --configuration Release `
  --output <task-owned-output-directory> `
  -p:BaseIntermediateOutputPath=<task-owned-intermediate-directory>
```

Run the protocol and dependency-free self-test with the framework-dependent
DLL produced by that build:

```powershell
dotnet <output-directory>\AI.DevOS.WindowsSandboxFeasibilityProbe.dll probe
dotnet <output-directory>\AI.DevOS.WindowsSandboxFeasibilityProbe.dll self-test
```

`probe` exits with code 2 while the production composition remains
unavailable. `self-test` exits with code 0 only when two observations serialize
byte-identically, the response is body-free, and no profile/process mutation
was attempted. Unknown commands fail with a stable body-free refusal.

The stateful command is intentionally not part of routine validation:

```powershell
dotnet <output-directory>\AI.DevOS.WindowsSandboxFeasibilityProbe.dll `
  profile-lifecycle-proof `
  AiDevOs.Stage17.ProfileProof.<32-lowercase-hex> `
  "$env:TEMP\ai-dev-os-stage17-profile-proof-<same-hex>"
```

Do not run it repeatedly or without explicit authorization. Its successful
result proves only same-user profile/ACL lifecycle cleanup on that exact host;
it does not prove identity, filesystem, network, Job, process-tree, quota, or
escape-corpus enforcement.
