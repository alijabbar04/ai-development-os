# Windows sandbox feasibility probe

This dependency-free .NET 9 program is a **read-only diagnostic**, not a
sandbox helper and not a production backend. It checks the exact System32 DLL
loads and documented export names relevant to the Stage 17 Windows
architecture decision. It never creates an AppContainer profile, changes an
ACL, creates a Job Object, launches a process, or mints process-broker
registration/session evidence.

The probe intentionally reports `unavailable` even when every export is
present. Export presence is not enforcement proof. The experimental
`processmodel.dll` route additionally requires the exact authoritative
`SandboxSpec.fbs` layout, and the public Win32 composition requires a reviewed
ephemeral AppContainer profile/filesystem lifecycle plus native integration
and corpus evidence.

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
