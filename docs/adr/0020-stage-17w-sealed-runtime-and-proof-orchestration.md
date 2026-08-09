# ADR 0020: Stage 17W sealed runtime and proof-only orchestration

Status: Accepted for the defensive implementation checkpoint; runtime evidence
and production admission remain gated
Date: 2026-08-09

Extends ADRs 0014, 0017, 0018, and 0019. This decision supersedes the parts of
ADR 0017 that describe the supervisor and helper as inspection-only binaries,
and the parts of ADR 0018 section 4 that use “sealed” to mean that every
state-changing runtime operation is absent. It does not weaken their artifact,
installer, proof-build, evidence, or release gates.

## Decision

The ordinary Windows lifecycle is compiled into the sealed supervisor and
helper. Proof-only authority remains outside both production-shaped components.

“Sealed” now has a precise role-specific meaning:

- the supervisor and helper contain the fixed operational lifecycle they would
  use in production, including exact process creation, containment, cleanup,
  and recovery;
- they contain no proof authorization constructor, arbitrary executable or
  path input, fault-injection switch, plugin surface, PATH lookup, shell, or
  runtime download;
- the proof controller alone owns scenario selection, process termination, and
  evidence assembly, and its mutating commands exist only in the explicit
  reviewed-proof build; and
- the proof installer alone owns installation/removal, behind its separate
  reviewed-proof capability. Its compiled source table admits one exact
  candidate; neither proof-only component is discoverable as production.

This distinction fixes an architectural contradiction. A production-shaped
runtime cannot prove its real lifecycle if the lifecycle is compiled out, but
proof tooling must not become the production control plane merely to make the
test possible.

## Component and authority split

| Component | Compiled role | Caller-controlled authority |
| --- | --- | --- |
| `windows-supervisor` | Retain the installed closure, own the private Job and exact helper process, proxy the framed lifecycle, perform token-derived bounded recovery, and issue fixed provider canaries. | Closed command enumeration and inherited handle values only. No executable, endpoint, credential, filesystem root, or fault selector. |
| `windows-helper` | Retain the installed closure and run the reviewed lifecycle worker that creates the fixed target suspended with the AppContainer and Job attributes present at creation. | Three inherited handle/token fields under the supervisor protocol. |
| `windows-runtime` | Shared closure lease plus a compile-time-pruned projection of the reviewed native lifecycle primitives. | No executable entry point. |
| `windows-proof-controller` | Plan and orchestrate the bounded scenario matrix, inject proof-only failures, run two fixed egress canaries, and assemble non-production receipts. | A lower-case 128-bit run token, with mutation unavailable in the sealed build. |
| `windows-proof-installer` | Install or remove the one compiled-in closure through the native handle-relative transaction. | Candidate identifier and run token; no caller-supplied trust digest or filename set. |
| `windows-boundary-fixture` | Fixed single-file target and two bounded fixture commands. | Command-specific, grammar-constrained paths only. |

The retained feasibility project remains investigative tooling. Production
projects do not reference its assembly or namespace. The two lifecycle source
files used by the runtime are checked-in projections with proof-only branches
removed and a production namespace applied. A static parity test reconstructs
that projection from the reviewed feasibility sources and requires byte-for-byte
agreement, so either side drifting fails policy review.

## Installed closure and creation boundary

The installed runtime candidate is `stage17w-runtime-v1`. Its reviewed source
envelope contains exactly 193 ordinal filenames: the supervisor closure, helper
closure, and single-file boundary target. The proof installer compiles the
expected filename set and source-envelope fingerprint into reviewed source.
The proof controller, which is not a member of that closure, independently
compiles the same fingerprint and requires its retained lease to reconstruct it
from the measured installed files before the first supervisor launch. Keeping
the second pin outside the closure avoids a hash self-reference while ensuring
proof evidence cannot be produced by a self-consistent substituted manifest and
file set.

Before an operational command creates another process, `RuntimeClosureLease`:

1. derives the install root from the current image or from a validated run token
   under the fixed ProgramData hierarchy;
2. rejects missing/reparse ancestors and an unexpected image name;
3. parses exact-shape installed manifest and record files;
4. requires an exact flat directory enumeration with no missing, additional,
   duplicate, case-colliding, directory, or reparse entries;
5. opens the metadata and every declared member with write/delete sharing
   denied, then checks every size and SHA-256 through the retained handle; and
6. keeps all handles open across each dependent `CreateProcessW` return.

The pure self-test fixes the canonical serializer against a literal two-file
vector, rather than comparing the serializer to itself. A static policy test
also requires the controller and installer pins to be identical.

Every creation site supplies an exact absolute `lpApplicationName`, explicit
application directory, bounded environment, writable quoted command line,
`STARTUPINFOEX`, and exact inherited-handle list. The helper’s target creation
also supplies the private Job and AppContainer security capabilities at
creation and starts suspended. No process is selected by PID or image-name
enumeration.

The supervisor owns an unnamed kill-on-close/no-breakaway Job and the exact
helper process handle. The helper is outside that Job and gives the target the
Job at creation. A framed journal records bounded lifecycle phases and flushes
each record. Cleanup and recovery act only on the closed set of names derived
from the run token and never recurse. Recovery and egress commands, like the
normal session command, first authenticate that the supervisor is executing
from a complete installed closure.

Runtime path validation is not a native handle-relative ancestor walk. The
proof installer is the authority that creates and verifies protected exact
DACLs on every directory below `CommonApplicationData`: the proof identity has
read/execute but no write, delete-child, delete, DACL-change, or owner-change
authority, while only SYSTEM and Administrators retain full control. The
runtime rechecks that those ancestors exist and are not reparse points, then
retains every metadata/member handle. A privileged administrator able to replace
those protected ancestors remains outside the same-user workload boundary. A
future production launcher must provide the same externally pinned retained
lease (or a native held-directory equivalent); direct supervisor invocation is
not admitted as production by this checkpoint.

## Proof matrix boundary

The proof controller has eight fixed scenarios covering the normal lifecycle,
control disconnect, helper termination, supervisor termination, combined
termination, suspended/running target phases, and termination after target
exit. Its plan fixes all profile, process-role, ordinary-control, and total
process caps before any execution. It stops after the first unconfirmed cleanup
or cap failure and cannot convert a failed or absent observation into success.

That source exists to make a later bounded observation possible. A successful
compile, pure self-test, or read-only review is not the observation. The
controller is proof-only, reports `productionEligible: false`, is excluded from
the npm package and production component identities, and cannot run its mutating
commands when built sealed.

## Controlled-egress canary boundary

The supervisor has one body-free canary implementation for each of two fixed
HTTPS endpoints. It accepts only the provider enum `anthropic` or `openai`; the
caller cannot provide a URI, host, port, method, header, body, proxy, redirect
policy, or credential.

The canary disables proxy use, redirects, cookies, automatic decompression,
pre-authentication, and QUIC; uses GET with no request body or authorization
header; validates the exact DNS host and port in the connection callback;
rejects loopback, private, link-local, multicast, documentation, benchmark,
transition, and other special-use address ranges; connects directly to a
resolved public address; and leaves normal TLS hostname/certificate validation
bound to the original URI. The proof controller independently recomputes the
reviewed endpoint fingerprint and refuses a substituted receipt.

This is a bounded endpoint-reachability canary, not a general provider request
relay. It has no provider credentials and carries no prompt, repository,
telemetry, or user data. Its source presence does not make controlled service
egress available; that requires the later authorized observation and production
integration gates.

## Artifact and packaging consequence

The production-shaped supervisor and helper remain sealed regardless of the
requested proof flavor. The proof controller and installer are both measured as
proof-only components, and production discovery rejects either identity. The
npm package continues to contain only `dist` and `README.md`; no native source,
project, proof binary, or build output is shipped by this checkpoint.

The repository’s aggregate Windows packaging helper imports the safety-gated
module as part of its report assembly. It was therefore not invoked for this
checkpoint. Determinism and the installer pin were instead measured with two
ordinary clean `dotnet publish` roots per affected production artifact, direct
filename/size/SHA-256 comparison, and the installer’s canonical envelope
algorithm. This is artifact-build evidence only.

## Release truth and remaining boundary

This decision records implementation, not runtime enforcement evidence. No
installation, removal, elevation, AppContainer creation, Job lifecycle,
scenario matrix, recovery mutation, live provider canary, production
registration, or production workload was executed for this checkpoint.

Windows production availability therefore remains false, production execution
continues to refuse, Stage 17W remains gated, Stage 18 remains blocked, and no
merge or release tag is authorized. The exact safety-gated operation remains a
separate required operation and is not rerouted or approximated here.
