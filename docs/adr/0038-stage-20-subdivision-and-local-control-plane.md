# ADR 0038: Stage 20 subdivision and local control-plane hosting

- Status: Accepted.
- Date: 2026-08-25.
- Scope: Stage 20 and the future Stage 21 desktop; production remains refused.
- Dossier crosswalk: logical ADR-0036 became repository ADR 0038 because ADRs
  0036 and 0037 were allocated by Stage 18 before this decision landed.

## Context

The sealed Stage 18 parent has `developmentAccepted=true` and makes Stage 20A
eligible. The operator separately authorized Stage 20A entry and adopted the
reconciled Opus implementation contracts and Fable product-experience direction.
The earlier roadmap described a single Stage 20 that mixed contracts, queries,
commands, listener security, and emergency-stop authority. That grouping is too
large to review honestly and obscures the point at which mutation authority first
appears.

The initial product is Windows-only and single-user. Its future desktop needs a
recoverable local control plane, but machine registration, installers, updates,
and auto-start are later product concerns. Existing Stage 18 provider, secret,
workspace, process, and production-admission boundaries must remain intact.

## Decision

### Stage subdivision

Stage 20 is delivered as two explicit stages:

- **Stage 20A is read-only.** It owns pure API contracts, later lifecycle and
  descriptor contracts, a later loopback listener, and later UI-facing
  projections. It exposes no commands or mutations.
- **Stage 20B is effectful and later.** It may introduce commands,
  idempotency/replay controls, approvals, pause/kill, and durable emergency-stop
  authority only after its own design and review gates.

Stage 20A is further sequenced without collapsing review boundaries:

1. C0 verifies entry from the exact Stage 18 seal.
2. C1 is this governing decision.
3. C2 creates framework-independent response/projection contracts and an
   explicit route registry containing exactly zero routes.
4. C3 will later own connection descriptor, identity nonce, single-instance,
   adopt-existing, and lifecycle contracts.
5. C4 will later introduce the **first listener**. It requires an independent
   security review.
6. C5 will later introduce the **first UI-facing projections**. It requires an
   independent leakage review.

C2 contains no Fastify dependency, server, socket, listener, route, command, or
mutation. Fastify is accepted for C4, subject to the repository's ordinary
lockfile, zero-known-vulnerability, import, test, and hosted-CI gates. Runtime
validation contracts remain framework-independent and use the established
`@ai-dev-os/domain` validation boundary.

### Local process model

The control plane is a local child process owned by the future Electron desktop
shell. Electron main starts it on explicit application launch or adopts the one
matching existing instance after identity verification. It is not a Windows
Service, scheduled task, machine daemon, auto-start entry, or installer action.
Those machine lifecycle concerns remain Stage 23 work.

The C4 listener is loopback-only. Its composition must make wildcard, LAN, and
external-interface binding structurally unavailable rather than relying on a
caller-supplied host string or a convention. The later connection descriptor
uses per-launch authentication and user-local storage, with honest documentation
that a same-user compromise is outside that descriptor's security boundary.

No local or remote listener is created in C0-C2.

### Product and authority boundaries

- Every Stage 20 component is production-disabled. No real agent, task, model,
  provider, workspace, Git, credential, or secret dispatch is permitted before
  production admission.
- Windows is the only supported product platform. Linux and macOS integration is
  deferred; portable contract code does not claim platform support.
- The Stage 21 desktop later consumes a frozen client. It is not built in Stage
  20A C0-C2.
- Normal and Developer modes have identical authority. Developer mode changes
  visibility and permits only bounded direct-to-task communication; it cannot
  widen scope, permissions, profiles, budget, approvals, or recipient identity.
- Normal mode has one coordinator persona, **AI Powerhouse**, which is a control
  role rather than a persistent privileged agent.
- Chat transcripts and provider transcript files never become the system of
  record. Typed records, decisions, handovers, and evidence do.
- External/manual VS Code session observation is outside v1. A later read-only
  extension needs separate authorization and an ADR. UI automation is not the
  application's agent-integration mechanism.
- Stage 20/21 never purchases, subscribes, raises a spending limit, or executes
  a payment. A later bounded request may be prepared, but the operator performs
  any transaction externally.
- Emergency-stop resume will offer “also return to Contained permissions,”
  defaulted on, and record the choice visibly; this is a future Stage 20B/21
  requirement, not authority introduced here.
- A bounded Windows Job Object spike is permitted later under its own scope. It
  is not part of C0-C2 and does not prove filesystem, network, credential, or
  Stage 17W isolation.
- Relevant licence documents require operator review before Stage 23 packaging
  decisions.
- MCP, installers, updates, auto-start, machine registration, external messaging,
  the project spine, and the Stage 21 shell are not introduced by this decision.

## Assurance requirements

C2 must prove strict exact envelope parsing, the complete finite refusal
catalogue, deterministic allowlist projection, bounded hostile-input refusal,
Normal/Developer authority parity, a zero-route registry, and direct/transitive
forbidden-import detection with positive controls. A guard-removal mutation must
make the suite fail.

C4 must prove loopback-only binding, authentication, origin and request limits,
single-instance/descriptor identity, and listener teardown before its independent
security review. C5 must prove its Normal-mode allowlist, cross-profile isolation,
credential/path/source-fingerprint canaries, stable redaction, and no
model-influenced free text before its independent leakage review.

## Consequences

The smaller checkpoints expose authority transitions to review. Headless local
operation remains possible because the desktop owns a child rather than hosting
the control plane in-process. UI restart can later adopt an independently
lifecycle-managed child without creating machine persistence.

The roadmap's old combined Stage 20 endpoint list is design intent, not an
implemented route inventory. No endpoint exists until C4, and no effectful
command exists until Stage 20B.

## Alternatives rejected

- **In-process control plane:** couples desktop and orchestration crash/lifecycle
  domains and prevents an honest adopt-existing model.
- **Windows Service, scheduled task, machine daemon, or auto-start:** expands
  installation and machine authority into Stage 20; those remain Stage 23.
- **Named pipe as an authentication substitute:** does not remove the need for
  explicit identity and same-user threat modelling.
- **Adding Fastify in C2:** introduces listener-framework surface before a route
  exists and makes pure contracts depend on transport.
- **Commands in Stage 20A:** hides the first mutation boundary inside a
  nominally read-only stage.

## Nonclaims

This ADR changes no Stage 18 acceptance row, does not affect the Stage 17W
production gate, and creates no runtime capability. It does not start C3-C5 or
Stage 20B, implement a listener/client/desktop/project spine, activate
production, authorize a provider operation, access a secret, or support any
non-Windows product platform.
