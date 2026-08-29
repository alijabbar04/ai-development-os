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
health nonce first and sends the bearer only after an exact identity match on
the same still-open TCP channel. It never reconnects for the authenticated
read, and one monotonic deadline bounds the complete adoption sequence.
The descriptor, health probe, authenticated session response, and returned
client-attachment bootstrap bind the listener's actual Normal or Developer
presentation. A requested/actual mismatch refuses before transport creation.
The authenticated session response also supplies the existing listener's
bounded running-session count plus exact computation time and literal current
confidence. The listener refuses stale or request-time-future evidence, and the
adopter exact-parses the evidence and rejects computation after the response's
server-owned time. The adopter's own unused dataset cannot supply or replace
the count.

Descriptor and lock artifacts have fixed names and exact schemas. Storage uses
no directory enumeration, rejects linked roots/artifacts, promotes create-only
files, rechecks opened/named identities, and removes only an exact artifact it
previously identified and whose PID/nonce still match. Lock age is never proof
of staleness; ambiguous, invalid, or live-foreign ownership refuses. A
create-only transient mutation claim serializes cooperating artifact writers
and removers across the ownership-check/unlink interval. An orphaned claim is
an availability failure and is not removed by age.

C5 extends the host to an exact six-route, zero-command inventory. Four
authenticated projection reads use the C2 projection envelope: `health`,
`usage.policyConstants`, one named `usage.profiles` record, and one named
stored `routing.latest` decision. Normal and Developer presentation are fixed
at composition and have byte-identical route and command authority; no request
field or query named `mode` is accepted.

The Stage 20A projection source is a strictly parsed bounded in-memory dataset,
not an effectful adapter or callback. It contains the existing service's
bounded running-session count, provider-health, probe, usage, and stored-routing
evidence but no caller-supplied startup-mode, restart, sweep, or recovery facts.
It is composed only after the single-instance decision proves this caller owns
a fresh listener, and before that listener is created. An adopter consumes the
authoritative client-attachment result and never composes its unused dataset
into the existing service. The source has no dependency on Account Manager, a
vault, credentials, providers, scheduler commands, tasks, workspaces,
repositories, or Git. A missing named record fails closed with the finite C2
`SERVICE_NOT_READY` refusal. Source exceptions and validation detail are not
projected.

Separate Normal and Developer schemas make diagnostic fields structurally
absent rather than cosmetically hidden. Normal has product-owned finite copy
and no mechanism identifiers. Developer may add only the reviewed PID/nonce
reference, sweep timing, profile/window/reservation/task/decision identifiers,
source classification, schema/failure fields, and exact policy rule IDs.
Neither presentation can expose `sourceFingerprint`, generic fingerprints,
borrowed-owner identity, credentials, authorization headers, paths, hashes,
model-authored prose, raw errors, or a different profile's reservation.

The usage projection preserves four window states without turning inactive or
unavailable into zero. Eligibility is source-served and independently checked
against the ten exact freshness rules and two borrowed-cap rules. It also
enforces the scheduler's canonical authority/source equivalence, distinct
window identities, freshness-not-beyond-active-reset invariant, and coherent
unavailable/failure/confidence state. Ambiguous authorization, unknown
revocation, stale/unavailable evidence, invalid reset evidence, and expired
windows stay ineligible. Caps are derived only from served `serverNow` using
the explicit `en-GB` / `Europe/London` weekday `[09:00,17:00)` contract:
5,000 basis points for the borrowed five-hour window during that interval and
7,000 basis points weekly at all times. Current usage at a cap refuses;
current-plus-outstanding reservations equal to a cap remains eligible; a total
over a cap refuses. Normal copy distinguishes source unavailability from
provider-authority/high-confidence requirements, and cap copy is true for both
current-at-cap and current-plus-outstanding-reservations refusal branches.
Snapshot observation may not postdate the usage record's own computation. The
stored-routing projection contains only the already selected alias/agent,
finite reasons, the exact scheduler selected top-level rule set, and timestamps.
Its strictly parsed but unprojected workload class proves the scheduler's
borrowed-Fable invariant; borrowed Fable workloads and borrowed Fable-agent
selections are rejected. Owned/borrowed reasons must agree with the selected
route and every hard denial rule is rejected;
Stage 20A does not implement C16 outcomes or forecasts.

Health truthfully reports `dispatchPaused: false` and
`estopAvailability: not-implemented`. The health projection's
`service-process` scope is separate from the returned handle's
`client-attachment` fresh/adopted bootstrap result. Because Stage 20A performs
no recovery sweep, process startup is fixed to fresh with zero stopped,
recovered, unresolved, and unconfirmed counts and no sweep timestamp or timing
rows. `recovery-in-progress` is not an accepted C5 stale reason because no such
mechanism or evidence exists. The client-attachment bootstrap instead carries
the actual presentation plus either zero stopped-by-restart input for a fresh
listener or the authenticated existing-service running-session count for an
adoption. The six deferred
parameterized C2 refusals receive condition-specific finite product copy at the
C5 presentation boundary without changing their codes, details, or next-step
semantics.

## Honest platform boundary

Node's `0o600` mode request does not prove a Windows DACL. JavaScript-level
path and identity checks narrow races but cannot establish a boundary against a
hostile process running as the same user, nor can Node alone prove PID creation
identity across every reuse race. Dead-PID cleanup therefore requires an
injected affirmative liveness result plus two matching exact artifacts;
ambiguous evidence refuses. The subsequent nonce probe is required before an
existing live owner is adopted. Windows deletion durability is not claimed:
Node does not expose a proof that a parent-directory entry was durably flushed.

## Consequences

- C4 is frozen and independently security-reviewed before C5 bytes are added.
- The repaired frozen C4 candidate passed its fresh independent re-review with
  zero must-fix findings before C5 began; that verdict does not transfer to C5.
- A later C5 re-review of frozen commit `384f082` returned FAIL with four
  must-fix findings: presentation-unbound adoption, incomplete adopted W3
  evidence plus unsupported recovery metadata, selected-route denial
  contradictions, and condition-inaccurate usage copy. The repairs recorded by
  this ADR remain candidates until a fresh exact-identity C5 review and focused
  adoption-path C4 security re-review pass.
- The focused C4 re-review of repaired commit `286d755` passed with zero
  must-fix findings. Its fresh C5 review returned FAIL with two new must-fix
  findings: an unprefixed real 43-character service bearer could pass as an
  identifier, and an impossible borrowed-Fable stored selection could be
  described positively. The next candidate rejects both shapes and requires a
  fresh C5 verdict; the C4 PASS remains scoped to `286d755`.
- Frozen C5 commit `8765a46` resolved both findings but returned FAIL with two
  temporal truth findings: usage observation could postdate its own computation,
  and the bare adopted running-session count bypassed stale/future health
  evidence. The replacement candidate orders usage evidence and binds session
  count, computation time, current confidence, and response `serverNow`; its
  changed session contract required fresh focused C4 review as well as a fresh
  C5 verdict.
- Exact replacement source commit
  `9a7d03ee6ed0ab9212f336d54d7eb6b7bac572b2`, tree
  `d2498883a9db16920cad9b5fd0803467b8f6f40b`, passed both the complete C5
  truth/privacy review and the focused changed-session C4 security review with
  zero must-fix findings. The verdict is scoped to those exact source bytes and
  does not pre-authorize Stage 20B or transfer to later executable changes.
- The final reviewer retained one non-blocking maintenance advisory: the
  control-service forbidden-import test enumerates source files manually and
  detects imports lexically. Its planted controls pass and no forbidden current
  import was found; a future maintenance change should derive the production
  module closure and parse import syntax robustly.
- C5 accepts only injected deterministic records and C2 allowlist projection
  schemas; it does not read real installed state.
- Stage 20B owns all commands and mutation. Stage 21 owns desktop composition.
- No Windows Service, scheduled task, startup registration, elevation, provider
  contact, credential lookup, real repository mutation, or production dispatch
  is authorized by this decision.
