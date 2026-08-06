# Stage 17 Windows structured boundary-fixture proof

Date: 2026-08-06

Outcome: **PASSED AS A BOUNDED FEASIBILITY PROOF; PRODUCTION REMAINS UNAVAILABLE**

This evidence records the explicitly authorized Windows structured
boundary-fixture proof. It is not a production sandbox, helper, packaging
result, crash result, quota result, escape-corpus result, or claim that the
Windows backend is secure-enforcing. The backend still reports `unavailable`,
every advertised capability remains false, every quota remains unsupported,
Windows actual-native corpus evidence remains 0/40, Stage 17 remains gated,
Stage 18 remains blocked, and no `v0.17*` tag or push is permitted.

Implementation commit:
`e35ff4f5eaf8faa64f1eb3dd79f22200150b4fce`.

## Authorized boundary

The authorization covered only fresh, strictly named synthetic resources:

- one zero-capability same-user AppContainer profile per implementation or
  retained evidence attempt;
- a matching staging directory and a separately protected same-user canary
  directory, both direct children of the current user's temporary directory;
- one reviewed, shell-free, self-contained `win-x64` .NET fixture, copied only
  after an exact filename, reparse-point, and SHA-256 check;
- one fixed allowed staged file, one forbidden staged write target, and one
  fixed canary file;
- local IPv4 loopback only, with live parent TCP and UDP positive controls;
- eight normal and eight `CREATE_BREAKAWAY_FROM_JOB` child-creation attempts
  from the fixture under a private one-process Job;
- bounded waits, exact process/Job/token observations, complete cleanup, and
  an independent residue scan; and
- no provider, repository workload, credential, public/private network
  destination, DNS, proxy, firewall, loopback exemption, privilege, system
  policy, production registration, receipt, backend availability change,
  remote, tag, or push.

The proof accepts only names matching
`AiDevOs.Stage17.BoundaryProof.<32-lowercase-hex>` and matching staging/canary
roots directly beneath `%TEMP%`. Its result contains only booleans, bounded
counts, numeric native errors, stable reason codes, fingerprints, and
SHA-256 values. Raw names, SIDs, paths, ports, process IDs, environment values,
and fixture output are not persisted.

## Composition

Protocol version 4 performs the following bounded composition:

1. Refuse pre-existing matching filesystem or AppContainer registry state.
2. Create a fresh profile with no capability SIDs and observe its exact folder,
   mapping, and storage records.
3. Retain the staging directory's original access SDDL, grant the AppContainer
   SID read/execute inheritance only, copy the digest-pinned fixture, and create
   the fixed allowed file.
4. Create the canary directory with a protected DACL containing only the
   current user's inheritable full-control rule. Verify there is no rule for
   the AppContainer SID before creating the canary.
5. Create a parent TCP listener and UDP receiver on the same loopback port.
   Require ordinary parent TCP connection/accept and UDP send/receive controls
   to pass before launching the AppContainer.
6. Configure an unnamed private Job with only kill-on-close and active-process
   limit one. Neither breakaway flag is set.
7. Pass security capabilities, the Job list, and an explicit two-handle list in
   one `STARTUPINFOEX` attribute list. Pass a fixed nine-entry Unicode
   environment, including profile-local temp and single-file extraction roots,
   rather than inheriting the user's environment.
8. Create the exact staged fixture suspended. Before resume, require its token
   to be the expected AppContainer SID with zero capabilities and its private
   Job to contain exactly one active process.
9. Resume the shell-free fixture. It reports structured JSON for the allowed
   read, denied stage/canary operations, loopback socket results, and normal
   plus breakaway child attempts.
10. Require no parent-side TCP connection or UDP datagram from the
    AppContainer, unchanged canary content, no forbidden staged file, zero
    child marker files, one total Job process, and zero active Job processes
    after fixture exit.
11. Terminate/drain the Job, close every native handle, free the returned SID,
    delete the exact files, restore the staging SDDL, remove both empty task
    directories, delete the profile, and poll its folder and registry records
    for absence.

The command never calls `AssignProcessToJobObject`; membership is present at
creation through `PROC_THREAD_ATTRIBUTE_JOB_LIST`.

## Retained final result

The retained run used one of two byte-identical final Release builds and
returned exit 0 with `structured-boundary-proof-passed`:

| Observation | Result |
| --- | --- |
| Profile-name fingerprint | `46434a8168e6fccbecae9cc5c5459c245a4df4ba81e04021312030333af8ddd5` |
| Profile-SID fingerprint | `2d110fbf14918b64e3522d15fa2e2eeae8c1266be0e4bb33b8635cac6e314d89` |
| Staging-root fingerprint | `3ec491fd0c28fc9c06b1ffdccc66cda09e73bb453548f442740ff5d66d082491` |
| Canary-root fingerprint | `2ed9946a25f7e183596a374092a2aa769f6db8352881103994420bf80da0d762` |
| Source/staged fixture SHA-256 | `ad4b10ef8d7f082642cca6f3bb1dd06f1b0719de943f1932ae712710fff55097` / same |
| Capabilities requested / token capabilities | false / 0 |
| Creation attributes / inherited handles / environment entries | 3 / 2 / 9 |
| Kill-on-close / active-process limit / breakaway allowed | true / one / false |
| Token SID and private Job verified before resume | true; active count 1 |
| Allowed staged read/content | passed / matched |
| Staged write / canary read / canary write | denied / denied / denied |
| Parent TCP and UDP positive controls | passed |
| AppContainer TCP connect | denied by timeout; native error 10060 |
| AppContainer bind/listen syscall | returned success; not represented as denied |
| AppContainer UDP `SendTo` syscall | returned success; not represented as denied |
| TCP connection / UDP datagram observed by parent | absent / absent |
| Normal child attempts | 8 native denials; 0 created markers; 0 unexpected |
| Breakaway child attempts | 8 native denials; 0 created markers; 0 unexpected |
| Private Job total/active after exit | 1 / 0 |
| Canary unchanged / forbidden staged write absent | true / true |
| Job termination/drain | true / true |
| ACL restored; staged/canary resources removed | true / true |
| Profile delete attempts/success | 1 / true |
| Profile folder/mapping/storage residue absent | true / true / true |
| Cleanup confirmed | true |
| Production backend available | false |

The network result is intentionally narrow. It proves that data did not cross
between this zero-capability AppContainer and the two live parent loopback
receivers in the tested direction. It does **not** prove that every socket
operation fails: bind/listen and UDP `SendTo` returned success. It also does
not cover DNS, non-loopback addresses, IPv6, redirects, proxies, inherited
sockets, QUIC, multicast, or the full network corpus.

The serialized result was independently checked not to contain the raw
profile name, token, staging/canary path, current user name, or System32 path.
The final read-only host scan found zero matching staging directories, canary
directories, fixture processes, AppContainer storage records, mapping values,
package folders, and temporary marker files.

## Honest iteration record

Six fresh profiles and six AppContainer fixture processes were created across
implementation and retained evidence. Every attempt used a unique identifier,
reported cleanup confirmed, and was followed by zero matching task-directory
or fixture-process residue. The retained generic scan also measured zero
registry, package, and marker residue.

- Attempt 1 reached the verified suspended boundary but the fixture exited at
  its loopback-connect check. The initial fixture emitted only a generic stable
  error and the proof did not yet expose a step code. Cleanup passed. The first
  independent process scan produced one false positive because the scanner's
  own PowerShell command line contained the profile prefix; the corrected scan
  matches actual fixture image names/paths and returned zero thereafter.
- Attempt 2 added a stable fixture step code, but the proof's JSON reader was
  case-sensitive while the fixture emitted camel-case properties. Cleanup
  passed; no boundary claim was retained.
- Attempt 3 fixed that reader and identified
  `fixture-loopback-connect-failed`. Cleanup passed.
- Attempt 4 recorded all socket exceptions. It observed TCP timeout 10060,
  successful bind/listen and UDP-send syscalls, and 16 native child denials.
  The then-current assertion still required the latter two socket syscalls to
  fail, so the proof honestly failed and cleaned up.
- Attempt 5 added a live parent UDP receiver and distinguished syscall return
  from cross-boundary delivery. It passed as an implementation check: neither
  the TCP connection nor UDP datagram reached the parent.
- The retained final run repeated the passing observations using the final
  deterministic artifact and was followed by the full zero-residue scan.

Across attempts 4 through 6, 48 child `CreateProcessW` calls were made: 24
normal and 24 requesting `CREATE_BREAKAWAY_FROM_JOB`. All were natively denied;
no attempted child marker was created and the Job's total process count
remained one. Three separate ordinary fixture positive controls each created a
child successfully outside the one-process AppContainer Job and removed its
marker, confirming that the child path itself was functional.

## Build and protocol identity

The implementation candidate and retained payload identities are:

- implementation commit:
  `e35ff4f5eaf8faa64f1eb3dd79f22200150b4fce`;
- proof source digest:
  `9dd47fe5deb0a0f28000d05d7e6311bd8707549be4c83515e217297df184f2fa`;
- fixture source digest:
  `2c0dc1c14d0c9fdc406d63f6b819f3f0c671c987db8cdfccd05b739ef701e01c`;
- proof DLL: 137,216 bytes,
  `9592400aa1a92a5ce283ee7cb472ac5dd15571faf55974765d67e187da095369`;
- proof deps/runtime-config digests:
  `edb3906cbfcc8e80f3dbc56769089ce90f7a0efd0e821a09f5abffb65f4571b5`
  / `e3a9d5d0a25ca066e8b70401b5869b5cfc92d16f5fe89b83077cdfd4b7427711`;
- self-contained single-file fixture: 70,919,531 bytes,
  `ad4b10ef8d7f082642cca6f3bb1dd06f1b0719de943f1932ae712710fff55097`;
- proof builds byte-identical: true; and
- fixture publishes byte-identical: true.

Each source digest uses the existing ordinal relative-path / NUL / raw bytes /
NUL SHA-256 algorithm. The proof digest covers its project plus all four
invoked `.cs` files. The fixture digest covers its project, offline
`NuGet.Config`, and `Program.cs`.

The fixture is `net9.0-windows`, self-contained, `win-x64`, single-file,
untrimmed, no ReadyToRun or compression, deterministic, invariant-globalized,
warnings-as-errors, checked, no unsafe code, no debug symbols, and restored
with all package sources cleared. Its final ordinary child positive control
passed and removed the marker. The final proof's read-only `self-test` passed;
`probe` still exited 2 with
`windows-native-process-composition-and-corpus-unverified`.

Generated build, publish, and bundle-extraction directories remain under the
task's external `work` directory. The earlier host execution policy rejected
recursive generated-directory removal. They are outside Git, contain only
reproducible generated artifacts, and are not AppContainer profile, process,
ACL, registry, package, or marker residue. Repository-local `bin`/`obj`
directories are ignored generated output and are not tracked or packaged.

## Process-broker and packaging validation

The exact implementation candidate passed:

```text
npm run typecheck --workspace @ai-dev-os/process-broker
npm run test --workspace @ai-dev-os/process-broker
npm run test:coverage --workspace @ai-dev-os/process-broker
npm run build --workspace @ai-dev-os/process-broker
```

All 319 tests passed. Coverage was 92.36% statements (1,597/1,729),
85.92% branches (995/1,158), 98.32% functions (293/298), and 92.99% lines
(1,539/1,655), above every configured threshold.

`npm pack --dry-run --json --ignore-scripts` reported 102 files, 122,684
packed bytes, and zero `native` entries. No TypeScript production path,
descriptor, manifest, dependency, lockfile, install hook, production issuer,
or native packaging allowlist changed. The repository-wide check was not
rerun for this evidence-tool-only proof. No new external independent model
audit was authorized or run.

## What this proves and does not prove

On Windows 11 Pro build 26200, this proves only the tested bounded composition:

- AppContainer read access followed the explicit staging ACL while a protected
  same-user canary and staged write were denied;
- data did not cross to live parent TCP/UDP loopback receivers despite the
  UDP-send syscall returning success;
- a creation-time one-process/no-breakaway Job natively denied all 16 child
  attempts in the retained run; and
- the process, Job, file, ACL, directory, profile, and registry lifecycle
  cleaned up under the tested normal parent path.

It does not prove:

- a production helper protocol, payload, immutable staging, signing, digest
  lookup, installed-package path, registration, or receipt;
- general same-user filesystem denial, reparse/TOCTOU resistance, registry,
  credential, IPC, device, user-profile, inherited-handle, or named-object
  containment;
- complete network denial or controlled service egress;
- helper/broker crash cleanup, parent death, open-handle profile deletion,
  process races beyond this fixture, fault injection, or reboot recovery;
- any CPU, memory, wall-clock, output, disk, file-count, or network quota;
- any of the 40 Windows-applicable positive-control corpus vectors; or
- Linux or macOS enforcement.

## Next bounded action

The next stateful task requires separate authorization. The smallest useful
Windows continuation is a test-only helper lifecycle and crash-cleanup proof:
put the already reviewed composition behind a finite framed protocol, kill the
client/helper at controlled lifecycle points, and independently prove Job,
process, handle, staged-file, ACL, profile, and registry cleanup. It must still
run no provider or repository workload, ship no production registration, and
leave the backend unavailable. Packaging, quotas, adversarial filesystem/IPC/
credential work, and all 40 corpus vectors remain later blockers.

## Follow-up: protocol-v5 helper lifecycle proof

On 2026-08-06, a later separately authorized protocol-v5 proof completed the
finite test-only helper action described above. Normal lifecycle, client
disconnect, and four exact-handle helper-termination checkpoints passed with
zero per-scenario and final residue; see
`stage-17-windows-helper-lifecycle-crash-proof.md`. This follow-up does not
change the historical protocol-v4 observations or turn this structured fixture
into production/corpus enforcement. Windows remains unavailable and actual
Windows corpus coverage remains 0/40.

## Official references

- [Implementing an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
- [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)
- [Networking basics](https://learn.microsoft.com/en-us/windows/uwp/networking/networking-basics)
- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [JOBOBJECT_BASIC_LIMIT_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)
- [.NET single-file deployment](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview)
