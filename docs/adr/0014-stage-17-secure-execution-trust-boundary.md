# ADR 0014: Stage 17 secure-execution trust boundary

Status: Accepted for the gated Stage 17 implementation checkpoint
Date: 2026-08-05

## Decision

Production process admission will no longer treat a backend identifier, a
configuration allowlist, a backend descriptor, a successful probe, or a
successful spawn as enforcement evidence. The process broker will require an
opaque in-process registration issued only by reviewed first-party backend
composition and will verify it again immediately before use. A production
backend must also return an opaque, single-use preparation receipt bound to the
exact grant, request, policy decision, lease, workspace, executable, endpoint
policy, helper identity, and current attestation.

The public serializable attestation is body-free audit and routing data only.
It grants no authority. Its schema and fingerprint cover the platform identity,
backend/helper/protocol/build identities, per-boundary results, endpoint-policy
identity, escape-corpus result, observation/expiry times, and limitations. An
ordinary object with identical fields is not a registration or receipt.

No first-party backend in this checkpoint is permitted to issue production
registration or session evidence. The existing Windows, Linux, and macOS
backends remain probe-only and unavailable until their complete native
implementation passes the escape corpus on the actual target platform.

## Context and confirmed Stage 16 gaps

The released Stage 16 broker accepted a production backend when its own
`describe()` result said `secure-enforcing`, its ID appeared in an operator
allowlist, its probe returned available, and its booleans/quota matrix matched
the request. A structurally compatible fake could therefore self-promote. The
allowlist was useful as an operator filter but was incorrectly carrying trust.

Both normal and duplex execution paths also omitted `validateGrant()`. They
checked only a subset of identity fields and executable evidence. They did not
prove that requested network rights and quotas were no wider than the grant,
nor that environment names, approval evidence, lease identity, deadline, and
working directory remained inside the authorized subject.

Those are release-blocking trust-boundary defects even while every built-in
platform backend honestly refuses.

## Trusted computing base

The intended trusted computing base is:

- the host kernel and administrator/root account;
- the reviewed process-broker control plane;
- reviewed first-party native helper source and the exact built artifact named
  by the attestation;
- mandatory system-or-higher configuration locks and the policy evaluator;
- the controlled egress relay, resolver, and trust store when service egress is
  enabled; and
- the release process that records platform evidence and artifact digests.

Repository content, prompts and model output, tool output, project/user
configuration below mandatory locks, arbitrary `SandboxBackend`
implementations, backend self-description, and serializable attestation data
are untrusted.

An opaque JavaScript object prevents configuration, JSON, and ordinary
TypeScript structural typing from minting authority. It does not protect
against a compromised trusted Node process that can execute package-private
implementation code or mutate the process broker. Persisted evidence will not
be accepted as authority unless a later design adds an external trust root and
replay protection; no package-embedded signing key will be used.

## Admission lifecycle

1. Parse the immutable request, grant, descriptor, and body-free attestation.
2. Resolve and hash the executable as close to use as the current tool contract
   permits.
3. Verify exact identity, lease, policy, approval, environment, path, network,
   quota, output, deadline, and tool containment.
4. Invoke the selected backend's `validateGrant()` and require a stable
   available result.
5. In production, verify an opaque first-party registration against backend
   object identity, descriptor fingerprint, platform, current time, helper and
   protocol identities, endpoint policy, and complete per-boundary evidence.
6. Prepare bounded isolation state without running repository-controlled code.
7. Verify a single-use opaque preparation receipt against the exact execution
   binding and current registration.
8. Revalidate lease and expiry, then spawn the initial process already inside
   every claimed boundary.
9. Treat unconfirmed process-tree termination, egress revocation, or sandbox
   disposal as containment failure. Such a failure can never be reported as a
   successful production execution and invalidates the evidence source.

Development mode may continue to use
`unsafe-development-current-user` explicitly. It never receives production
registration, never emits production-compatible routing evidence, and is not a
fallback from a production refusal.

## Grant containment semantics

Containment is fail-closed and field-by-field:

- project, workspace, attempt, grant, lease, run/task trace, policy, snapshot,
  and approval evidence must match or be a subset as defined by their contract;
- the executable tool and digest/immutable reference must be granted;
- a working directory must be covered by a granted readable or writable path;
- requested environment names must be explicitly authorized and remain bound
  into the policy subject;
- `denied` network is a subset of every grant, `loopback-only` is only a subset
  of the same mode, and an allowlist is a subset only when every normalized
  destination is granted; any non-denied request also needs `network-access`;
- each numeric quota must be equal to or lower than the grant's limit;
  requesting an unbounded dimension where the grant is finite is widening;
- output limits must fit inside both the request and grant output quota; and
- the request deadline cannot outlive the grant or lease.

The Stage 17 service-egress contract is distinct from general workload network
rights. No endpoint is inferred from a provider or model name. Until an exact,
locked provider/adapter endpoint policy and an enforcing relay are implemented
and measured, production service egress remains unavailable.

## Platform decisions and current evidence

### Windows

The target design requires a restricted primary token or supported lower
identity, initial suspended creation with an explicit safe handle list,
race-free Job Object ownership before untrusted code runs, task-owned filesystem
grants that do not retain the interactive user's ambient access, deny-by-default
networking with a separately controlled service channel, and confirmed tree
cleanup. A Job Object alone is explicitly insufficient.

The current Windows host has no Visual Studio C/C++ toolchain or Windows SDK in
the normal locations. The available .NET SDK does not solve the filesystem and
network boundary. No AppContainer profile/exemption, WFP/firewall rule,
external ACL, Hyper-V change, driver, signing key, or privileged installation
is authorized. The Windows backend therefore remains unavailable.

### Linux

The target design requires user/mount/PID/network namespaces, a minimal
filesystem view, dropped capabilities and `no_new_privs`, a measured seccomp or
LSM posture, delegated cgroup v2 enforcement, private networking, and
cgroup-wide cleanup. Tool presence is only a probe.

No WSL distribution, Linux VM/container CLI, remote, or executable Linux CI
surface is available on this host. Linux remains unavailable and unverified.

### macOS

The target design will use only a supported documented Apple containment
foundation, most likely a virtualization/container design if its exact
hardware, OS, entitlement, image, sharing, network, quota, and cleanup
requirements can be met. Deprecated `sandbox-exec` and private sandbox APIs are
not acceptable.

No macOS host or runner is available, and the checked-in CI has no macOS job.
macOS remains unavailable and unverified.

## Evidence and release consequence

The machine-readable truth table is authoritative only about observations, not
intent. Unit, contract, mocked-protocol, cross-compilation, and feature-probe
results are labelled non-enforcement. A platform can become
`secure-enforcing` only after the versioned positive-control escape corpus runs
on that exact platform/helper combination and all claimed boundaries pass.

Because actual Windows, Linux, and macOS enforcement evidence is not available,
this work must end as a committed gated checkpoint. Stage 17 stays gated,
Stage 18 stays blocked, and `v0.17.0-secure-execution-backends` must not be
created.

## Rejected alternatives

- **Backend ID plus descriptor allowlist:** forgeable self-assertion.
- **Successful probe or spawn:** proves availability, not containment.
- **Job Object without restricted identity/filesystem/network enforcement:**
  process accounting is not a sandbox.
- **Bubblewrap/cgroup file probes:** do not prove namespace or controller
  enforcement.
- **`sandbox-exec` on macOS:** deprecated and unsupported as a production
  foundation.
- **Mocks or cross-compilation as platform proof:** false cross-platform
  evidence.
- **Hard-coded Claude/OpenAI domains:** unverified endpoint authority and an
  unsafe maintenance seam.
- **Package-embedded attestation signing key:** callers could extract it and
  mint evidence.
- **Unsafe fallback after production refusal:** a silent privilege downgrade.
