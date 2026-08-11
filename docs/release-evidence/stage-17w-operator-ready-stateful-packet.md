# Stage 17W operator-ready stateful packet

Date: 2026-08-10

Pure-build identity refreshed: 2026-08-11

Status: **PREPARED, READ-ONLY VALIDATED, AND NOT EXECUTED**

This is the canonical operator handoff for the bounded stateful observations
defined by ADR 0020. Preparing and validating this packet did not install or
remove anything, request elevation, create an AppContainer, run a Job/process
lifecycle scenario, run either network canary, admit a production backend, or
execute the separately safety-gated operation.

## Authority and nonclaims

- Reviewed implementation commit:
  `1cd722859800e8c889b1c558afd098bde6ac343f`.
- Reviewed implementation tree:
  `1861c447d069bf60c08696683f58faf0cafa4e31`.
- Branch: `feat/stage-17w-complete`.
- Candidate: `stage17w-runtime-v1`, component
  `windows-stage17-runtime`, bundle `1.0.0`, build flavour `sealed`.
- Canonical source-envelope fingerprint:
  `16f327aa858f25e85c9f335d658e1879d1c93729940648df19cd6966326eb5c8`.
- Installed metadata names: `stage17-proof-manifest.json` and
  `stage17-proof-install-record.json`.
- The proof controller and proof installer are proof-only,
  `productionEligible: false`, and excluded from production discovery and the
  npm package. The installed supervisor/helper are production-shaped but not
  production-admitted.

Nothing in this packet is Stage 17 completion, Stage 18 admission, signing,
merge, tag, release, production availability, or permission to broaden the
commands below.

## Deterministic artifacts and inventories

The checkpoint's two clean publishes established the following runtime
identity:

| Item | Exact evidence |
| --- | --- |
| Supervisor publish | 188 files; repeated publish matched ordinal name, size, and SHA-256 |
| Helper publish | 188 files; repeated publish matched ordinal name, size, and SHA-256 |
| Boundary target | one single-file executable from reviewed commit `1cd722859800e8c889b1c558afd098bde6ac343f`; 70,923,627 bytes; SHA-256 `79491702137668b6c5addd035f5e6fada0b202f74e7250030b76e86766c4f660` |
| Merged installed closure | 193 exact ordinal filenames; 149,441,013 bytes; source-envelope fingerprint `16f327aa858f25e85c9f335d658e1879d1c93729940648df19cd6966326eb5c8` |
| Process-broker npm dry-run | 122 files; 169,073 packed bytes; 772,726 unpacked bytes; only `README.md`, `package.json`, and `dist`; no native or source entry |

The first 2026-08-11 pure preflight correctly stopped before every restricted
operation because the then-recorded boundary pin was stale. Static byte
comparison established that the old 70,923,627-byte artifact embedded
`1.0.0+6a65d2d4be69297149fd265573a4655e9f37c9ca`, while the fresh artifact
embedded the required
`1.0.0+1cd722859800e8c889b1c558afd098bde6ac343f`. Commit `6a65d2d4` is
an ancestor of the reviewed implementation, and its committed
boundary-fixture tree differs by 38 inserted lines across two files. The
preserved artifact does not prove which later uncommitted working-tree source
may have been present during that historical publish. The binaries have the
same length and differ in 161 bytes: the ASCII/UTF-16 revision identities plus
their derived PE timestamp, MVID, and bundle digest.

Two new isolated `dotnet publish` runs from the clean detached reviewed commit
with .NET SDK 9.0.316 independently produced the exact updated hash above. A
separately preserved intermediate build embeds its own commit `7ce5b6ac` and
has a third hash, confirming that the single-file identity is deliberately
source-revision-bound. This correction therefore replaces an artifact whose
embedded repository revision did not match the packet's required clean
reviewed commit; it does not accept an unexplained fresh hash or infer
unrecorded historical working-tree contents. The diagnosis only compiled,
hashed, and inspected metadata/bytes. It never executed the generated native
candidate or entered installation, elevation, lifecycle, network, profile, or
restricted-proof boundaries.

An independent GPT-5.6 Sol reviewer at Max effort rechecked the two preserved
reviewed-commit builds, old/intermediate/reviewed embedded revisions, exact
161-byte delta, committed-tree lineage, and both evidence edits read-only. It
returned `PASS` with no correction. This is a disclosed same-family review;
opposite-family review and reviewer usage/cost were unavailable.

As read-only packet-preparation validation, the reviewed-proof controller was
rebuilt from the exact implementation commit under two independent checkout
roots, and the installer was rebuilt from the checkpoint with .NET SDK `9.0.316`,
isolated `obj`, `bin`, and publish roots, and
`-p:DefineConstants=AIDEVOS_STAGE17_REVIEWED_PROOF_MODE`. Each repeat had 188
files and zero ordinal name/size/SHA-256 differences:

| Proof artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `AI.DevOS.WindowsProofController.exe` | 156,672 | `2678a479e863fc80360ec4371b9b78be96d8588cda1beffe51066012b09e9735` |
| `AI.DevOS.WindowsProofController.dll` | 268,800 | `31b866dcfa9bc07a239a06ef422863e5df2ba3b08c22230859c8cce2003c2e53` |
| `AI.DevOS.WindowsProofInstaller.exe` | 156,672 | `09b32936f4dcbcf4dddcbdbcb4b504a7aeb254eb5bec20b0aea4463abf162421` |
| `AI.DevOS.WindowsProofInstaller.dll` | 159,744 | `befda5f13e986f5f9eab3d964ceb1da27b117a4a291ee80e60f850b6756cb5b5` |

For evidence comparison only, the canonical lines
`<ordinal-name>|<byte-length>|<lowercase-sha256>`, joined by LF with no final
LF, hash to
`35326196c2f03cd5e06964057a210ce40b4bc4d326bb461f4a56714d3c52e6b0`
for the controller publish and
`0edbbe71b212638af5d28f2ed74eec73d89b0aa1c78cbf556366ce717ffdb7d0`
for the installer publish. These comparison digests are not new trust inputs;
the compiled candidate table, exact installed manifest, per-file hashes, and
source-envelope pin remain authoritative.

The exact 193-name runtime inventory is emitted by the installer `plan`
command from its compiled candidate table. Preserve that JSON as evidence;
do not replace it with a hand-maintained filename list.

## Build and pure preflight

The first operator-present pure preflight on 2026-08-10 used implementation
commit `7ce5b6ac9c25ad55e8023d130073c87f4c70b161` and stopped before any stateful
action. Three of the four pinned proof artifacts matched. The only mismatch was
the controller DLL: expected
`31f2ef9c71cb2fa9bf5f2c82b9d373d708c818c78bf471f7e5923a7bf5e9ff27`,
observed `242ff9ef30787b97012ae50491523633f37704ddbce5cc17327709c59d53a1ac`.
The project path-mapped its own directory but not the linked sibling sources.
Commit `1cd722859800e8c889b1c558afd098bde6ac343f` maps the complete native source
root and adds a regression. Two independent-root publishes of that exact commit
now match across all 188 ordinal names, byte lengths, and SHA-256 values. No
installation, elevation, profile, lifecycle, network, or protected-location
action occurred during the failed preflight or repair.

Use .NET SDK `9.0.316`, a fresh artifact root, and a separate clean checkout of
the exact implementation commit. Do not point `$Repository` at a working tree
that contains this later evidence packet as an uncommitted file. These commands
build artifacts only; they do not perform native installation or lifecycle
operations.

```powershell
$Repository = '<fresh-clean-checkout-of-1cd722859800e8c889b1c558afd098bde6ac343f>'
$ArtifactRoot = '<new-empty-task-owned-artifact-root>'
$RuntimeSource = Join-Path $ArtifactRoot 'runtime-closure'
$ControllerRoot = Join-Path $ArtifactRoot 'proof-controller'
$InstallerRoot = Join-Path $ArtifactRoot 'proof-installer'
$RunToken = '<32-lowercase-hex>'

Set-Location -LiteralPath $Repository
dotnet --version
git rev-parse HEAD
git rev-parse 'HEAD^{tree}'
git status --porcelain=v1

dotnet publish packages/process-broker/native/windows-supervisor/AI.DevOS.WindowsSupervisor.csproj -c Release -r win-x64 --self-contained true -o $RuntimeSource
dotnet publish packages/process-broker/native/windows-helper/AI.DevOS.WindowsHelper.csproj -c Release -r win-x64 --self-contained true -o $RuntimeSource
dotnet publish packages/process-broker/native/windows-boundary-fixture/AI.DevOS.WindowsBoundaryFixture.csproj -c Release -r win-x64 --self-contained true -o $RuntimeSource
dotnet publish packages/process-broker/native/windows-proof-controller/AI.DevOS.WindowsProofController.csproj -c Release -r win-x64 --self-contained true -p:DefineConstants=AIDEVOS_STAGE17_REVIEWED_PROOF_MODE -o $ControllerRoot
dotnet publish packages/process-broker/native/windows-proof-installer/AI.DevOS.WindowsProofInstaller.csproj -c Release -r win-x64 --self-contained true -p:DefineConstants=AIDEVOS_STAGE17_REVIEWED_PROOF_MODE -o $InstallerRoot

& "$ControllerRoot\AI.DevOS.WindowsProofController.exe" describe-artifact
& "$ControllerRoot\AI.DevOS.WindowsProofController.exe" self-test
& "$ControllerRoot\AI.DevOS.WindowsProofController.exe" plan --token $RunToken
& "$InstallerRoot\AI.DevOS.WindowsProofInstaller.exe" describe-artifact
& "$InstallerRoot\AI.DevOS.WindowsProofInstaller.exe" self-test
& "$InstallerRoot\AI.DevOS.WindowsProofInstaller.exe" plan --token $RunToken --candidate stage17w-runtime-v1

Get-FileHash -Algorithm SHA256 -LiteralPath "$ControllerRoot\AI.DevOS.WindowsProofController.exe"
Get-FileHash -Algorithm SHA256 -LiteralPath "$ControllerRoot\AI.DevOS.WindowsProofController.dll"
Get-FileHash -Algorithm SHA256 -LiteralPath "$InstallerRoot\AI.DevOS.WindowsProofInstaller.exe"
Get-FileHash -Algorithm SHA256 -LiteralPath "$InstallerRoot\AI.DevOS.WindowsProofInstaller.dll"
```

The SDK output must be `9.0.316`. The Git outputs must be the SHA/tree above and
an empty status. The controller must report reviewed-proof mode,
`productionEligible: false`, 2/2 pure self-test vectors, and the fixed
eight-scenario plan. The installer must report reviewed-proof mode,
`productionEligible: false`, one installable candidate, 190/190 pure self-test
vectors, and a plan with `filesystemTouched: false`, component
`windows-stage17-runtime`, bundle version `1.0.0`, the 193-name inventory, and
the source-envelope fingerprint above. The four `Get-FileHash` results must
match the packet-preparation table. Any difference is an abort, not permission
to regenerate a pin or add an argument.

## Run-token and derived-name rules

`$RunToken` must match exactly `[0-9a-f]{32}`. Uppercase, a different length,
or any non-hex character is refused. The installed leaf is derived as:

```text
<CommonApplicationData>\AI-Dev-OS\Stage17-Proof\<run-token>
```

Each scenario token is the lowercase first 16 bytes of SHA-256 over
`ai-dev-os/stage17w/scenario/v1/<run-token>/<zero-based-index>`. The compiled
plan derives only these scenario-scoped names:

```text
AiDevOs.Stage17.Runtime.<scenario-token>
<TEMP>\ai-dev-os-stage17-runtime-<scenario-token>
<TEMP>\ai-dev-os-stage17-runtime-canary-<scenario-token>
<staging-leaf>\stage17-runtime-<scenario-token>.journal
```

Use the names emitted by `plan`; do not calculate, substitute, or widen them
in an external script.

## The only elevated operations

UAC is required only so the reviewed proof installer can create or remove the
exact token-derived leaf below `CommonApplicationData` and apply/verify the
compiled protected DACLs. Run only the following native commands in the
administrator context; do not elevate the controller or add a wrapper,
destination, digest, ACL, force, or recursive-delete argument.

```powershell
& "$InstallerRoot\AI.DevOS.WindowsProofInstaller.exe" install --token $RunToken --candidate stage17w-runtime-v1 --source $RuntimeSource
& "$InstallerRoot\AI.DevOS.WindowsProofInstaller.exe" remove --token $RunToken
```

The first command must complete successfully before any lifecycle command.
The second command is the sole native remover and must run after observation
or after any aborted installed-state attempt. A refusal or mismatch is not a
reason to grant a shell or PowerShell filesystem authority over the install
tree.

## Stateful observation order

After a successful install, leave the administrator context. Run the
controller as the intended ordinary proof identity, preserving each single-line
JSON result verbatim:

```powershell
& "$ControllerRoot\AI.DevOS.WindowsProofController.exe" plan --token $RunToken
& "$ControllerRoot\AI.DevOS.WindowsProofController.exe" run --token $RunToken
& "$ControllerRoot\AI.DevOS.WindowsProofController.exe" egress --token $RunToken
```

The `egress` command is conditional: run it once only after `run` reports all
eight scenarios passed, `stoppedAfterFailure: false`, caps respected, and zero
final residue. It accepts no host, URI, body, credential, prompt, repository
content, proxy, redirect, cookie, pre-authentication, decompression, or QUIC
input. A denial/outage is recorded once and must not be rerouted.

The eight fixed lifecycle scenarios are:

1. `normal-lifecycle`;
2. `control-disconnect-before-target`;
3. `helper-terminated-after-setup`;
4. `helper-terminated-target-suspended`;
5. `supervisor-terminated-target-suspended`;
6. `supervisor-terminated-target-running`;
7. `supervisor-helper-terminated-target-running`;
8. `supervisor-terminated-after-target-exit`.

The cumulative compiled caps are 8 profiles, 8 initial supervisors, 4 recovery
supervisors, 12 supervisors total, 8 helpers, 6 AppContainer targets, 2
ordinary-control targets, and 30 processes maximum. A fully passing run expects
29 created processes within that ceiling. Frame waits are bounded at 30
seconds, helper/supervisor waits at 45 seconds, target waits at 10 seconds, and
zero-residue observation at 50 retries of 100 milliseconds. Journals contain
at most eight flushed, digest-protected records of at most 1,024 bytes each.

## Abort, recovery, and cleanup rules

Abort immediately on a SHA/tree mismatch, dirty checkout, wrong build flavour,
unexpected candidate/inventory/fingerprint, non-NTFS install volume,
unexpected/reparse install ancestor, pre-existing scenario state, failed
closure lease, cap projection failure, timeout, missing checkpoint, unconfirmed
cleanup/recovery, nonzero residue, or any result that claims production
eligibility. Do not retry a failed stateful run with the same token and do not
continue to the network canary after a lifecycle failure.

The controller stops after the first unconfirmed scenario and performs its
bounded exact-name recovery where planned. The helper journal is flushed at
each phase; recovery accepts only the compiled token-derived closed set and
never recurses. After the controller exits, invoke the sole remover above. Then
use the independent read-only inventory used for the pre-install baseline—not
another controller command—to confirm that the installed token leaf is absent
and the same eight residue categories are all zero:

- filesystem residue;
- marker residue;
- package-folder residue;
- registry residue;
- helper-process residue;
- fixture-process residue;
- generic task-directory residue; and
- generic registry residue.

Capture a read-only baseline immediately before install and compare the same
eight categories after removal. Any delta is a failed observation requiring
manual review; do not broaden cleanup authority.

## Results, receipts, and evidence locations

Store the following stdout records together under a task-owned evidence
directory named for the implementation SHA and run token:

- controller and installer `describe-artifact`, `self-test`, and `plan` JSON;
- installer install and remove transaction JSON;
- lifecycle `Stage17WProofResult` JSON, including exact artifact hashes,
  counts/caps, every scenario result, per-scenario residue, final residue,
  `receiptFingerprint`, and `productionEligible: false`;
- canary `Stage17WEgressResult` JSON, including both provider categories,
  endpoint fingerprints, zero-body/credential flags, redirect/proxy/QUIC
  flags, its receipt fingerprint, and `productionEligible: false`; and
- the before/after read-only residue inventories and operator timestamps.

Do not edit or normalize the JSON before hashing it. Evidence does not create
a production registration. The lifecycle and canary receipts are explicitly
non-production.

## Remaining gated boundary

The separately safety-gated Stage 17 operation remains prohibited until the
installed lifecycle succeeds, cleanup/recovery and residue are independently
confirmed, and the product safety layer expressly permits its existing
procedure. This packet neither contains nor recreates that procedure.

Until all required runtime evidence and later admission review succeed,
Windows production remains unavailable, Stage 17W remains incomplete, the
stacked Stage 18A branch remains production-disabled, and no merge, tag,
signing, release, or Stage 18 admission is authorized.
