# ADR 0021: Stage 18A production-disabled orchestration foundation

Status: Accepted for a stacked, production-disabled implementation checkpoint
Date: 2026-08-09

Extends ADRs 0014, 0016, 0019, and 0020. It does not satisfy the Stage 17W
production-admission gate, start Stage 18 production execution, or supersede the
full Stage 18 deliverables in the implementation roadmap.

## Context

Stage 18 eventually owns durable application of orchestration decisions:
queues, attempts, leases, fencing, retries, capacity, fairness, cancellation,
budget reconciliation, provider lifecycles, and restart-safe recovery. It also
owns hard usage-aware dispatch rules for explicitly authorized profiles.

The Stage 17W defensive implementation is ready for its separately authorized
stateful observation, but that observation has not occurred. A stacked Stage
18A branch can still settle provider-neutral data contracts, deterministic
state transitions, persistence semantics, routing policy, and compatibility
boundaries if every execution route remains compiled closed.

## Decision

Stage 18A adds `@ai-dev-os/scheduler` as a modular-monolith foundation. It uses
the existing persistence contract and its `task-run` aggregate rather than
introducing a service or database. The package exposes production-disabled
scheduling, strict contracts, event replay, usage normalization, hard routing
rules, and provider-neutral lifecycle ports. A testing-only factory accepts a
structurally marked deterministic fake adapter. No public factory accepts a
real adapter while `STAGE_18A_PRODUCTION_ENABLED` is `false`.

This checkpoint is preparation, not admission. A dispatch through the public
production-shaped factory durably records its routing decision and a terminal
policy block. It does not invoke a provider, resolve credentials, create a
process, or mutate a workspace.

## Versioned task, event, and result contracts

The task envelope, journal event, usage snapshot, route candidate, and terminal
result are version 1 exact-key JSON contracts. Unknown fields are refused,
including fields that could smuggle authority. A task carries only a managed
workspace identity (`projectId`, `workspaceId`, `snapshotId`, and base
revision), never a filesystem path, credential, executable, endpoint, process
identifier, raw provider body, or approval grant.

Budgets, timeouts, attempts, backoff, turns, capabilities, permission modes,
identifiers, schemas, and text are bounded. Timestamps cannot move backwards.
An explicitly requested route is all-or-none across provider, model, profile,
and ownership identity. Idempotency is bound to the canonical task fingerprint;
reusing an idempotency key with different task material fails closed.

The required lifecycle journal includes queued, routing decision, dispatched,
started, progress, checkpoint, usage snapshot, approval wait, policy block,
retry schedule, completion, failure, cancellation, and recovery. Replay rejects
sequence gaps, duplicate event identifiers, invalid source states, changed task
identity, decreasing usage, conflicting terminal outcomes, and every event
after a terminal result.

Aggregate state and its corresponding event are written in one persistence
transaction. Loading compares replayed journal state with the stored aggregate
and reports corruption rather than choosing one. The existing in-memory and
SQLite adapters remain the initial single-process implementations; PostgreSQL,
multi-worker fencing, heartbeats, capacity pools, and fairness remain later
Stage 18 work.

## Provider-neutral lifecycle

The agent adapter contract defines explicit `start`, `continue`, `resume`,
`cancel`, `status`, `usage`, `result`, and `close` operations. Thread identity,
provider run identity, dispatch identity, deadlines, and normalized terminal
results cross the boundary. Provider narrative is not validation evidence.
Approval and policy-block signals stop automatic consumption until an exact
human-resume operation is durably authorized; a block is not silently rerouted.

Concurrency, attempts, exponential backoff, deadlines, lease reconciliation,
turn ceilings, cancellation, and restart replay are bounded in the foundation.
Recovery acts on exact stored dispatch and thread identities. It never searches
for an ambient or recent thread and never treats a missing provider result as
success.

## Codex SDK compatibility seam

`@ai-dev-os/provider-codex` exposes a declaration-level compatibility seam for
the reviewed `@openai/codex-sdk` 0.147.0 surface: `startThread`, repeated
`runStreamed` turns, and `resumeThread`. Stage 18A does not add that package or
its optional platform CLI binaries as runtime dependencies, dynamically import
it, or create a live provider thread. The only executable seam mode accepts an
explicitly injected deterministic fake with the exact version marker; default
mode emits a terminal production-disabled policy block.

The seam resolves the envelope's workspace identity through an injected
managed-private-workspace resolver. It rejects mismatched identity, relative or
non-canonical paths, the managed root itself, and a path outside that root. Even
in deterministic tests it chooses only `read-only` or `workspace-write`, keeps
approval `on-request`, disables network and web search, performs the Git check,
and grants no additional directory.

SDK thread and turn events map to bounded lifecycle checkpoints, cumulative
usage, and terminal metadata. Agent messages, reasoning, commands, file-change
details, MCP arguments/results, web-search queries, and provider error text are
not persisted by this seam. A future production adapter must be separately
reviewed against the then-current official SDK, process-broker boundary,
retention behavior, installed component identity, and Stage 17 admission
evidence. SDK, API, MCP, and app-server streams remain untrusted provider input;
none is authority merely because it is structured.

## Usage-aware authorized-profile routing

A canonical usage snapshot identifies one provider and profile using scoped
non-secret identifiers. It records source adapter/version, ownership,
observation/reset times, the fixed `Europe/London` timezone, five-hour and
weekly windows, and authoritative/confidence state. It carries no credential or
cross-profile session material. A future adapter may emit this contract only
after separate authorization and source review.

Hard feasibility runs before scoring:

- the candidate must be explicitly authorized, available, healthy, fresh, have
  every required capability and permission mode, and exactly match any explicit
  route;
- exactly one identity-matching authoritative, high-confidence, fresh,
  internally consistent snapshot must exist;
- an authorized-borrowed profile is never eligible for Fable work;
- its predicted weekly usage may not exceed 70 percent at any time; and
- on London weekdays from 09:00 inclusive to 17:00 exclusive, its predicted
  five-hour usage may not exceed 50 percent.

The 17:00 instant is outside the special work-hours window. This makes the
implementation-roadmap phrase “09:00-through-17:00” a half-open scheduling
interval and resolves the product-direction wording “at or before 17:00” for
this versioned contract. A future requirement change must version the policy
and its boundary fixtures rather than silently changing existing decisions.

Missing, duplicate, stale, future-dated, expired, low-confidence,
non-authoritative, contradictory, or identity-mismatched capped-profile data
fails closed. A scoring preference cannot revive an ineligible route.
Deterministic score and candidate-identifier ordering make equal inputs replay
to the same decision.

## Account Manager and UI boundary

This checkpoint does not inspect, install, run, automate, scrape, or depend on
the Account Manager repository or its UI. Such a review requires separate
authorization, exact commit pinning, an all-files inventory, license review,
and an end-to-end authority and credential analysis. The only present boundary
is `UsageSnapshotAdapter`, a read-only port that can return an untrusted value
for strict validation. UI automation is not a fallback integration strategy.

## Downstream projections

The durable task, event, route, usage, policy, and terminal-result contracts are
intended as inputs to later stages, not implementations of them:

- Stage 19 can evaluate outcomes but cannot convert provider output into
  deterministic validation evidence or integration authority.
- Stage 20 can project redacted events through its typed loopback boundary;
  hidden provider content, credentials, and authority material remain excluded.
- Stage 21 can reconstruct Normal/Developer views from projections; visibility
  modes cannot alter scheduler policy or execution authority.
- Stage 22 communication adapters can relay redacted typed notifications and
  exact commands only after the Stage 20 boundary; free-form messages cannot
  authorize scheduler side effects.

## Consequences and nonclaims

This branch may compile, test, package, and demonstrate deterministic fake
lifecycle behavior. Those facts prove only the ordinary software contracts.
They do not prove a Windows installed runtime, AppContainer/Job enforcement,
credential isolation, provider availability, usage-source authority, live SDK
compatibility, multi-process coordination, UI behavior, or production safety.

Stage 17W remains gated on its exact separately authorized operation. Stage 18
remains blocked on Stage 17W production admission. No merge, tag, release,
production registration, live provider thread, Account Manager integration,
or production workload is authorized by this decision.
