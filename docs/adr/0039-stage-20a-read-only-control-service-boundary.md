# ADR 0039: Stage 20A read-only control-service boundary

- Status: Accepted for Stage 20A C3-C5
- Date: 2026-08-26
- Governing parent: ADR 0038

## Decision

Keep `@ai-dev-os/api` pure and route-free. Place the C3-C5 filesystem,
session, adoption, loopback listener, and UI-projection composition in the new
`@ai-dev-os/control-service` package. The package is callable by task-owned
tests but has no executable entry point, production bootstrap, machine install,
or ambient host/port/configuration surface.

The only listener address is the literal IPv4 loopback address `127.0.0.1` and
the production start path always requests port `0`. Runtime address inspection
is a second, fail-closed assertion. Stage 20A exposes reads only, has an empty
command registry, fixes `productionEnabled` to false, and composes no provider,
credential, account, task, agent, workspace, repository, Git, scheduler-command,
or process-launch boundary.

Per-launch nonce and bearer values are separately generated from cryptographic
random bytes and use incompatible exact shapes. The connection descriptor is
the only plaintext bearer handoff. The server retains its digest and compares
fixed-length digests in constant time. Adoption probes the unauthenticated
health nonce first and sends the bearer only after an exact identity match.

Descriptor and lock artifacts have fixed names and exact schemas. Storage uses
no directory enumeration, rejects linked roots/artifacts, promotes create-only
files, rechecks opened/named identities, and removes only an exact artifact it
previously identified and whose PID/nonce still match. Lock age is never proof
of staleness; ambiguous or live-foreign ownership refuses.

## Honest platform boundary

Node's `0o600` mode request does not prove a Windows DACL. JavaScript-level
path and identity checks narrow races but cannot establish a boundary against a
hostile process running as the same user, nor can Node alone prove PID creation
identity across every reuse race. Dead-PID cleanup therefore requires an
injected affirmative liveness result plus two matching exact artifacts;
ambiguous evidence refuses. The subsequent nonce probe is required before an
existing live owner is adopted.

## Consequences

- C4 is frozen and independently security-reviewed before C5 bytes are added.
- C5 accepts only injected deterministic records and C2 allowlist projection
  schemas; it does not read real installed state.
- Stage 20B owns all commands and mutation. Stage 21 owns desktop composition.
- No Windows Service, scheduled task, startup registration, elevation, provider
  contact, credential lookup, real repository mutation, or production dispatch
  is authorized by this decision.
