# @ai-dev-os/process-broker

Validated process-execution contracts, sanitized environments, quotas,
process-tree cancellation, and pluggable sandbox backends.

This package decides **whether** a command may run, **exactly what** runs, and
**how it is bounded**. It does not decide what a command should do — that
belongs to the coding-agent adapter — and it deliberately does not pretend to
provide isolation it cannot enforce.

## What it guarantees

- An executable plus an argument array. There is no command-string API and no
  option that turns one on.
- A child environment constructed from empty, never inherited.
- Output captured within hard byte bounds, on separate streams.
- A wall-clock deadline the broker enforces itself.
- Exactly one terminal outcome per process, whatever races occur.
- A two-phase production gate that requires a trusted opaque backend
  registration before preparation and a single-use, exact-bound session
  receipt immediately before spawn.
- Field-by-field request/grant/policy/lease containment, including tool
  digest/immutable reference, environment names, credential references,
  network mode, endpoint policy, quotas, output, and deadline.

## What it explicitly does not guarantee

The shipped backends do not isolate anything. `createUnsafeDevelopmentBackend`
runs the workload as the invoking user with that user's full access to the
filesystem, the network, and their own credentials. The Windows, Linux, and
macOS backends are honest probe seams: they report precisely which platform
primitive is missing and refuse to spawn. None of them is classified
`secure-enforcing`, so production mode refuses all of them.

That refusal is the intended behaviour. Running autonomously against a hostile
repository on a machine with no sandbox is the thing this stage exists to
prevent.

## Stage 17 gated checkpoint

Stage 17 hardens the admission contract without claiming that a native
sandbox now exists. `BackendDescriptor` schema 2 is advisory maximum
capability only. Its network field distinguishes `unsupported`, `deny-all`,
and `controlled-service-egress`; an ID, descriptor, approved-ID filter, probe,
mock, or successful spawn is never enforcement evidence.

Production composition additionally supplies an opaque
`ProductionBackendRegistration`. The broker verifies its object identity,
backend instance, descriptor fingerprint, exact host/architecture, helper
source/binary/build identity, protocol, quota matrix, exact canonical
escape-corpus version/fingerprint/host-applicable vector count, endpoint
policy, and expiry. `prepare()` must return a package-private,
single-use receipt bound to the exact execution fingerprint. The broker
rechecks the lease, grant and endpoint expiry, executable identity, and receipt
before any workload spawn. Unconfirmed tree termination or production cleanup
invalidates the evidence and cannot become success.

The public `EnforcementAttestation` is serializable and body-free but grants no
authority. `projectEnforcementAttestation()` always returns advisory evidence;
only `projectVerifiedProductionRegistration()` can emit a non-authorizing
`secure-enforcing` routing projection after opaque evidence is revalidated.

No exported platform factory can mint a production registration in this
checkpoint. Windows, Linux, and macOS therefore remain unavailable and
production execution still refuses. The measured machine-readable status is
in [`docs/release-evidence/stage-17-platform-truth-table.json`](../../docs/release-evidence/stage-17-platform-truth-table.json).

### Windows native continuation

The Windows continuation is an honest feasibility checkpoint, not a native
enforcement result. Dependency-free `net9.0-windows` evidence tooling under
`native/windows-feasibility-probe` proved that the exact System32
`processmodel.dll` and both experimental sandbox exports exist on the observed
Windows 11 build. It also found the documented AppContainer, restricted-token,
process-attribute, and Job Object exports. Its ordinary probe/self-test path is
read-only, cannot issue process-broker evidence, and is not included in the npm
tarball.

Export presence is not a boundary. Microsoft's experimental API requires an
exact `SandboxSpec.fbs` FlatBuffer layout; no installed or published
authoritative layout was available, so field ordinals were not inferred and
no unofficial schema was copied. A separately authorized lifecycle proof then
created exactly one uniquely named same-user AppContainer profile with zero
capabilities and one task-owned ACL directory. It observed the profile folder,
mapping/storage registry records, and explicit SID grant; restored the original
DACL; freed the SID; deleted the profile and directory; and independently
confirmed zero measured folder, registry, ACL, or directory residue.

A later separately authorized synthetic proof exercised the preferred public
composition on the same host. It staged a byte-matched copy of the exact
System32 `cmd.exe`, created it suspended as the expected zero-capability
AppContainer, and supplied security capabilities, a private Job list, and an
explicit two-handle list in one `STARTUPINFOEX` attribute list. Before resume,
the token matched the profile SID, its capability count was zero, and the
kill-on-close/no-breakaway/one-process Job contained exactly the target. The
fixed built-in marker then exited zero. All process, Job, ACL, staged-file,
directory, profile-folder, and registry cleanup checks passed, followed by an
independent zero-residue scan. No provider or repository workload ran. This is
a narrow feasibility result, not native enforcement evidence.

A third separately authorized proof replaced the shell marker with a
digest-pinned structured fixture. On the same host it read only the explicitly
granted staged file, was denied a staged write and protected same-user canary
read/write, and had all eight normal plus eight breakaway child attempts
natively denied by the creation-time one-process Job. Parent TCP/UDP loopback
controls passed; the AppContainer TCP connect timed out and neither a TCP
connection nor UDP datagram reached the parent. Bind/listen and UDP `SendTo`
did return success, so this is a bounded transfer-denial observation, not a
claim that every socket syscall is denied. Normal-path cleanup and an
independent generic residue scan passed. Production remains unavailable.

Protocol version 5 adds a separately authorized, test-only helper lifecycle
proof around that same composition. A finite 4-byte-length-prefixed strict
UTF-8 JSON protocol uses one fresh helper and private Job per scenario, no
ambient environment, and exactly four explicitly inherited helper handles.
Normal lifecycle, client disconnect before target creation, and actual helper
termination after setup, while the target was suspended, while running after
READY, and after target exit all passed. The surviving controller used only
exact helper/Job handles and token-derived recovery state; every Job drained,
no descendant survived, and every per-scenario, post-recovery, final, and
external residue scan was zero. Three earlier failed development attempts and
their successful bounded recovery remain recorded. Cumulative use was 9 fresh
profiles, 9 helpers, 7 AppContainer fixtures, and 2 ordinary fixture controls
(18 total helper/fixture processes), within the authorized 10/10/20 caps. This
is evidence tooling, not a production helper or corpus result.

The only candidate production network shape is deny-all with no AppContainer
network capability, proxy, allowlist, or loopback exemption. Controlled
service egress remains a separate unavailable boundary. All quota dimensions
remain `unsupported` in the current Windows descriptor, all isolation
capabilities remain false, and both `probe()` and `validateGrant()` refuse with
stable detail
`windows-native-process-composition-and-corpus-unverified`.

## Controlled service egress

`ControlPlaneEndpointPolicy` schema 1 represents provider control traffic
separately from workload network authority. It accepts a finite set of exact
lowercase public DNS names over HTTPS port 443, rejects IP literals, local and
internal suffixes, wildcards, IDNA/trailing-dot tricks and QUIC, caps redirects,
binds provider/adapter/tool identity, and expires. It contains no built-in
Claude or Codex domains.

This checkpoint implements and tests that value contract only. It does not
ship a relay and did not use a live provider or credential-bearing canary.
Until exact locked provider endpoints and an enforcing, platform-tested relay
exist, controlled service egress remains unavailable and cannot satisfy
production admission.

## Shell execution

Not represented. A string handed to a shell is a different and materially more
dangerous action than an executable plus arguments: it reintroduces quoting,
metacharacters, and command substitution on every argument. If shell execution
is ever added it must arrive as its own finite action category, denied by
default, separately approved, supported only by a backend that can contain it,
and separately tested.

On Windows this is why a `.cmd` or `.bat` shim is refused outright. A tool like
npm is represented as a trusted `node.exe` plus the verified CLI entry point,
using `pinnedLeadingArguments`.

## Executable identity

A `TrustedToolDescriptor` names an absolute path — never a `PATH` lookup — with
an optional expected digest, containment root, and platform. Before every
spawn the broker resolves the path, refuses link and reparse indirection,
checks the file type, verifies the digest, and binds the normalized executable
and argument digest into the policy subject.

**Honest limitation.** On a same-user backend the digest check is
time-of-check/time-of-use only. A process running as the same user can replace
the image between verification and execution. The check raises the cost of
substitution and produces audit evidence; it is not a boundary. A secure
backend supplies an immutable mount or backend tool reference, and *that* is
the enforcing mechanism.

## Quotas

Each backend declares, per dimension, whether it `enforced`, `observed`,
`estimated`, or `unsupported` that quota. Production admission accepts only
`enforced`. The broker itself enforces wall-clock duration and output bytes,
because it observes them directly; CPU, memory, disk, process count, and
network belong to the operating system and are reported unavailable when the
platform cannot deliver them. Application-level counters are never presented as
kernel enforcement.

## Process-tree cancellation

Cancellation targets the whole tree. On POSIX the child is started in its own
process group and the group receives `SIGTERM` then `SIGKILL`; on Windows the
tree is stopped with `taskkill /T /F`. Both are conveniences, not containment:
a child that calls `setsid`, detaches, or is re-parented can survive, and the
returned outcome says `termination-unconfirmed` when the tree cannot be proven
gone. A secure backend is expected to own the tree with a Job Object or a PID
namespace instead.

## Usage

```ts
import {
  createProcessBroker,
  createUnsafeDevelopmentBackend,
  createTrustedToolDescriptor,
  createProcessQuotas,
  createProcessRequest,
} from "@ai-dev-os/process-broker";

const backend = createUnsafeDevelopmentBackend({ sessionRoot });
const broker = createProcessBroker({
  backend,
  mode: "development", // "production" refuses this backend
  policy,              // bridges to @ai-dev-os/policy
});

const result = await broker.execute({
  request: createProcessRequest({
    /* ids, tool, args, quotas, trace */
  }),
  grant,
  lease,
  workspaceRoot,
  workingDirectory,
  workspacePaths,
});
```

A zero exit code means the transport succeeded, nothing more. Task success
still requires validating what the command actually produced.

### Long-lived duplex sessions

`openDuplexSession()` performs the same executable verification, normalized
policy evaluation, grant and lease checks, workspace binding, backend
admission, environment construction, quota enforcement, production refusal,
and process-tree supervision as `execute()`. It differs only after spawn:
stdin stays open for bounded `write()` calls, and separate stdout/stderr chunks
are exposed as a bounded async event stream.

Writes are serialized. Their promises resolve when the backend accepts the
bytes, providing backpressure. Per-message, queued-write, and cumulative-write
bounds are enforced before copying; write-after-close is a structured error.
Output events split at a configured byte limit and are retained only within
both event-count and queued-byte bounds. Crossing a queue or output bound
terminates the process and can never produce success.

Call `closeStdin()` when the protocol is finished, `terminate()` to cancel, or
`close()` to end the session. Each is idempotent and the first terminal outcome
wins. Closing the parent broker closes every active duplex session before the
backend is released.

## Contract suites

`@ai-dev-os/process-broker/testing` exports
`runProcessBrokerContractSuite`, `runDuplexProcessSessionContractSuite`, and
`runSandboxBackendContractSuite`. It also exports the versioned
`runSecureBackendAdversarialSuite` and its stable escape-vector inventory. The
adversarial suite requires an open positive control and an actual-native
candidate result for every applicable filesystem, process, IPC, network,
credential, quota, and cleanup vector. A mock harness is rejected and cannot
be reported as enforcement evidence. Corpus v1 contains 42 canonical vectors
with fingerprint
`125b809194d26cf1be518249b96727b78be80c25088826464ec94154a6fb3652`;
40 apply to Windows and 41 each to Linux and macOS. Production registration
rejects a different version, fingerprint, or platform count.

## Platform and operational status

| Platform | Shipped status | Actual escape tests | Native artifact | What remains |
| --- | --- | ---: | --- | --- |
| Windows 11 10.0.26200 x64 | unavailable | 0 | bounded profile, suspended-process, structured-boundary, and test-helper lifecycle/crash evidence tooling only; no production helper | design/package an immutable production helper, prove quota/general filesystem-network-IPC-production-crash boundaries, then run all 40 positive-control vectors |
| Linux | unavailable/unverified | 0 | none | actual host, namespace/cgroup implementation and positive-control corpus |
| macOS | unavailable/unverified | 0 | none | actual host, supported documented containment foundation and positive-control corpus |

There is no production native helper to install or remove, no postinstall
hook, and no runtime download. The evidence tool builds with the already
installed .NET 9 SDK and now produces a framework-dependent apphost plus its
managed payload solely so the controller can create an exact helper image; the
self-contained fixture is likewise evidence-only. Neither is a shipped runtime
prerequisite or npm entry. The explicitly authorized profile,
synthetic-process, structured-boundary, and helper-lifecycle host-state
resources were completely removed. No privileged operation,
firewall/loopback/proxy change, virtualization
enablement, signing, or external infrastructure change was performed.
Recovery from a containment or cleanup failure is fail-closed: quarantine the
backend registration, confirm task-owned resources are gone, then obtain fresh
measured evidence; never retry through the unsafe backend.

## Coverage note

The function-coverage threshold is 90 rather than 98 because process-tree
termination is platform-split by construction: the POSIX process-group path
cannot execute on Windows and the Windows `taskkill` path cannot execute on
Linux. Checked-in CI configuration is not execution evidence; no remote CI run
was available for this checkpoint, and native enforcement coverage is zero.
The retained threshold follows the precedent set by
`@ai-dev-os/provider-ollama`.
