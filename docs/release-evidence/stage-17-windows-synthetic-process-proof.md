# Stage 17 Windows synthetic process proof

Date: 2026-08-05

Outcome: **PASSED AS A BOUNDED FEASIBILITY PROOF; PRODUCTION REMAINS UNAVAILABLE**

This evidence records the explicitly authorized Windows synthetic
process-creation proof. It is not a production sandbox, release result, escape
corpus result, or claim that the Windows backend is secure-enforcing. The
backend still reports `unavailable`, every advertised capability remains
false, every quota remains unsupported, Windows actual-native corpus evidence
remains 0/40, Stage 17 remains gated, Stage 18 remains blocked, and no
`v0.17*` tag or push is permitted.

Follow-up: implementation commit
`e35ff4f5eaf8faa64f1eb3dd79f22200150b4fce` completed the structured fixture
identified below. See
`docs/release-evidence/stage-17-windows-structured-boundary-proof.md`. The
historical single-marker observations in this document remain exact; its next
bounded action is superseded, while production helper, crash, quota,
packaging, general-boundary, and all 40 corpus blockers remain.

Implementation commit:
`05e768bcc0cd94da430a4d58f9fcb7ed29e08426`.

## Authorized boundary

The authorization covered one bounded workflow using only fresh, strictly
named task resources:

- a same-user AppContainer profile with zero capability SIDs;
- a matching direct child of the current user's temporary directory;
- a byte-matched staged copy of exact System32 `cmd.exe`;
- one fixed built-in `echo` marker, with no provider, repository workload,
  script, prompt, credential, or network operation;
- one private Job configured with kill-on-close, active-process limit one, and
  neither breakaway flag;
- one `STARTUPINFOEX` attribute list carrying AppContainer security
  capabilities, the private Job list, and an explicit inherited-handle list;
- creation suspended, token and Job observation before resume, bounded wait,
  Job termination/drain, and complete resource cleanup; and
- no firewall, proxy, loopback exemption, system policy, privilege, package,
  production registration, receipt, or backend availability change.

The command accepts only profile names matching
`AiDevOs.Stage17.ProcessProof.<32-lowercase-hex>` and matching staging roots
named `ai-dev-os-stage17-process-proof-<same-hex>` directly beneath the
current temporary directory. Output contains only finite booleans, counts,
stable reason codes, numeric native errors, and SHA-256 values. Raw names,
SIDs, paths, process IDs, environment values, and fixture output are not
committed.

## Composition and pre-resume observations

Protocol version 3 performs these operations:

1. Derive and create the fresh profile with no capabilities; observe its
   profile folder and exact mapping/storage registry records.
2. Create the task staging directory, retain its original DACL, grant only
   read/execute to the AppContainer SID, and copy exact System32 `cmd.exe`
   beneath a unique filename. Reject a reparse-point source and require source
   and staged SHA-256 equality.
3. Create an unnamed private Job and set only
   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` plus
   `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` with limit one.
4. Create one NUL input handle and one output-pipe write handle as the only two
   inheritable handles; the parent read end is explicitly non-inheritable.
5. Pass exactly three creation attributes in one list:
   `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`,
   `PROC_THREAD_ATTRIBUTE_JOB_LIST`, and
   `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`.
6. Pass a fixed eight-entry Unicode environment block instead of inheriting
   the user's environment. It contains the current-drive entry, staged
   `COMSPEC`, AppContainer `LOCALAPPDATA`/`TEMP`/`TMP`, and required Windows
   system-root variables.
7. Call `CreateProcessW` with exact `lpApplicationName`, a writable fixed
   command line, `CREATE_SUSPENDED`, `CREATE_UNICODE_ENVIRONMENT`, and
   `EXTENDED_STARTUPINFO_PRESENT`.
8. Before resume, query the process token and private Job. Require an
   AppContainer token, exact profile-SID match, zero token capabilities,
   positive private-Job membership, and exactly one active process.
9. Resume only after those checks; require `ResumeThread` to report a prior
   suspend count of one, the fixed marker to arrive on the bounded pipe, and a
   zero process exit.
10. Terminate and drain the Job, close every native handle, free the returned
    SID, delete the staged file, restore the exact original DACL, remove the
    empty staging directory, delete the profile, and poll for exact folder and
    registry absence.

The command does not call `AssignProcessToJobObject`; membership comes from
the creation-time Job-list attribute.

## Final executed result

The final evidence run used one of two byte-identical clean Release builds.
It returned exit 0 and `synthetic-process-proof-passed` with:

| Observation | Result |
| --- | --- |
| Profile-name fingerprint | `76b20fcc82346fb485506e52bbb2c3ac32d6407096c62baa38ad4982e6686305` |
| Profile-SID fingerprint | `9e4aaa410d0f9605ae1b9660929d9d04e8c06fb265b5a32ac12c825045dd3525` |
| Staging-root fingerprint | `965d9c888391b6d0014310967a64d34307f67317dbdb9a9bf5461156702cbfdc` |
| Source/staged image SHA-256 | `65ec268add3973b6dca64222985da47caeaee44a340b0ec1466782914fd743d9` / same |
| Capabilities requested / token capabilities | false / 0 |
| Creation attributes / inherited handles / environment entries | 3 / 2 / 8 |
| Kill-on-close / active-process limit / breakaway allowed | true / one / false |
| Process created suspended | true |
| Token matched expected AppContainer SID before resume | true |
| Private-Job membership / active count before resume | true / 1 |
| Previous suspend count returned by resume | 1 |
| Fixed marker / zero exit | true / true |
| Job termination / drain | true / true |
| ACL restored / staged image removed / directory removed | true / true / true |
| SID freed / profile delete attempts / success | true / 1 / true |
| Profile-folder / mapping / storage residue absent | true / true / true |
| Cleanup confirmed | true |
| Production backend available | false |

The serialized result was independently checked not to contain the raw
profile name, token, staging path, current user name, or System32 path.

An independent read-only scan after the final command found:

- matching process-proof staging roots: 0;
- matching staged fixture processes or executable paths: 0;
- matching AppContainer registry key names: 0;
- mapping registry values matching the process-proof prefix: 0; and
- package folders matching the final unique token: 0.

The generic staging/process/registry checks cover all attempts made during this
authorized workflow, not only the final token.

## Honest iteration record

Three fresh profiles were created across implementation and final evidence;
two synthetic child processes were created. Every attempt used a different
identifier and independently measured zero residue.

- Attempt 1 created the profile, ACL, staged image, handles, and Job, but
  `CreateProcessW` refused before creating a child with native error 203. The
  initial minimal environment omitted the AppContainer profile variables and
  current-drive entry required by the documented launch shape. The Job was
  empty and drained; the image, ACL, directory, SID, profile folder, and exact
  registry records were removed. The independent scan was zero.
- Attempt 2 added only the documented AppContainer `LOCALAPPDATA`/`TEMP`/`TMP`,
  current-drive, and Windows system variables. It created and verified one
  synthetic child and completed cleanup. It was an implementation check, not
  the retained final evidence identity.
- The final run used the byte-identical clean-build artifact recorded below,
  repeated the passing observations, and was followed by the generic
  zero-residue scan.

No process from a failed attempt was resumed because the only failure occurred
before process creation.

## Build and protocol identity

The statefully executed final-proof artifact had:

- source digest:
  `8aab98b9ff442829eaa9c25a1656824ae356ca85f8c06f144237082be33df531`;
- DLL digest:
  `9d7f30b9fde38d798c777c3a8d767df98b2f2d7d64db5a9bd28ae78cb8c61a29`;
- build-envelope digest:
  `ee7e834d07b8cc211513e06d52ec5026ad65693ff8f5a212f67bf5f09146708a`;
  and
- two clean builds byte-identical: true.

After the stateful run, only the unrelated retained lifecycle command's
response protocol constant was raised from 2 to 3 for protocol consistency.
The synthetic process implementation did not change. Two new clean builds of
the exact implementation commit were byte-identical and had:

- final source digest:
  `bbf8cb130f18d95fcb9cba2f290bd2a9daa6418e4290c922459ecf8273c0a0ae`;
- final DLL digest:
  `6bc6c86699d3f58a29ee10e6c3809a1e0cff322cbf13c64ad0994981d59ff7ae`;
- final build-envelope digest:
  `36338073dcccc4456d6b4572a13d2ffc596c279e2d28295afaa126fef01c7eb8`;
- deps digest/bytes:
  `edb3906cbfcc8e80f3dbc56769089ce90f7a0efd0e821a09f5abffb65f4571b5`
  / 509;
- DLL bytes: 88,064; and
- runtime-config digest/bytes:
  `e3a9d5d0a25ca066e8b70401b5869b5cfc92d16f5fe89b83077cdfd4b7427711`
  / 397.

The final artifact's read-only `self-test` passed with deterministic body-free
output and no mutation. Its `probe` exited 2 with stable unavailable reason
`windows-native-process-composition-and-corpus-unverified`; an unknown command
exited 64 with `unsupported-command`.

The source digest is SHA-256 over the ordinally sorted four invoked source
files (`.csproj` plus the three `.cs` files), adding each UTF-8 relative name,
a NUL byte, raw file bytes, and a trailing NUL byte. The build digest uses the
previously documented ordered `stage17-windows-feasibility-build-v1` envelope.

Generated build output/intermediate directories remain under the task's
external `work` directory because the host execution policy rejected their
recursive removal. They are outside the Git worktree and contain reproducible
build artifacts only; they are not AppContainer, process, ACL, registry, or
package residue.

## Process-broker and packaging validation

The exact implementation candidate passed:

```text
npm run typecheck --workspace @ai-dev-os/process-broker
npm run test --workspace @ai-dev-os/process-broker
npm run test:coverage --workspace @ai-dev-os/process-broker
npm run build --workspace @ai-dev-os/process-broker
```

All 319 tests passed. Coverage was 92.36% statements (1,597/1,729),
85.83% branches (994/1,158), 98.32% functions (293/298), and 92.99% lines
(1,539/1,655), above every configured threshold. No TypeScript production
path, descriptor, manifest, dependency, lockfile, install hook, registration
issuer, receipt issuer, or native packaging allowlist changed.

`npm pack --dry-run --json --ignore-scripts` reported 102 files and 122,684
packed bytes for `@ai-dev-os/process-broker`, with zero `native` entries. The
evidence source and generated payload remain outside the package.

The repository-wide check was not rerun for this evidence-tool-only bounded
proof. No new external independent audit was authorized or run.

## What this proves and does not prove

This proves on Windows 11 Pro build 26200 that the documented public Win32
composition can create one target already carrying the intended
zero-capability AppContainer identity and private creation-time Job membership
while suspended, then resume, observe, terminate, and clean it under the tested
happy path.

It does not prove:

- a production helper protocol, payload, packaging, signing, digest lookup, or
  installed-package execution path;
- immutable executable staging or same-user TOCTOU resistance;
- denied access to ungranted filesystem, registry, credential, IPC, process,
  device, or user-profile resources;
- deny-all network behavior, including DNS, loopback, listening sockets,
  public/private addresses, redirects, QUIC, proxy, or inherited sockets;
- adversarial descendants, rapid spawn, breakaway attempts, helper/broker
  crash, handle leakage, profile deletion under open handles, or fault
  injection;
- CPU, memory, wall-clock, output, disk, file-count, process-count, or network
  quota semantics beyond the proof Job's single-process limit; or
- any of the 40 Windows-applicable positive-control corpus vectors.

## Historical next bounded action

The next task requires separate authorization. Replace the shell-based marker
with a reviewed structured fixture that can report operation results without
parsing a command line. Use it first to prove allowed staged reads and denied
ungranted same-user filesystem access, then a bounded no-capability network
denial slice and rapid child-creation behavior. Keep the production backend
unavailable until the full helper lifecycle, packaging, crash cleanup, quotas,
and all 40 Windows vectors pass. This action was subsequently completed within
the exact limits recorded in
`stage-17-windows-structured-boundary-proof.md`; that result remains a bounded
feasibility proof rather than production enforcement.

## Follow-up: protocol-v5 helper lifecycle proof

On 2026-08-06, a later separately authorized protocol-v5 proof placed the
reviewed structured composition behind a finite test-only helper. Its normal,
disconnect, and four exact-handle helper-termination scenarios all passed with
zero per-scenario and final residue; see
`stage-17-windows-helper-lifecycle-crash-proof.md`. This later result does not
rewrite this historical protocol-v3 command or make it production/corpus
enforcement. Windows remains unavailable and actual Windows corpus coverage
remains 0/40.

## Official references

- [Launch an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
- [CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)
- [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [TOKEN_INFORMATION_CLASS](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class)
