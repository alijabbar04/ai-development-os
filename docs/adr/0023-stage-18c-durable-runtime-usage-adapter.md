# ADR 0023: Production-disabled durable application runtime and usage adapter

Status: Accepted for the Stage 18C source checkpoint
Date: 2026-08-10

## Decision

Stage 18C adds a Windows-local, production-disabled application composition
over the existing scheduler and persistence ports. It also versions the
canonical usage snapshot, records a commit-pinned static investigation of AI
Account Manager, and supplies a fixture-only Account Manager protocol adapter.

The implementation remains a modular monolith:

- `@ai-dev-os/scheduler` owns durable ready work, attempts, leases, fencing,
  retries, capacity, fairness, usage intents, dispatch identity, and replay;
- `@ai-dev-os/application` composes that runtime with an explicitly supplied
  persistence adapter or an explicit absolute Windows-local SQLite path;
- the existing `@ai-dev-os/persistence` transaction and journal contracts
  remain the only persistence abstraction; and
- the existing routing and usage contracts remain the only eligibility and
  usage model.

No second scheduler, task graph, provider registry, usage ledger, workspace,
Git boundary, policy broker, or persistence framework is introduced. No API,
daemon, UI, messaging adapter, PostgreSQL substitute, or Stage 19 behavior is
implemented.

## Application boundary

`createProductionDisabledApplication` accepts explicit persistence, usage,
clock, and runtime-configuration ports. It exposes the canonical durable
runtime and a typed dispatcher over the versioned worker commands. This is the
internal seam a later Stage 20 API may call; it is not itself an HTTP, IPC, or
service surface.

`createWindowsLocalProductionDisabledApplication` is the only concrete desktop
composition. It requires an explicit absolute database path and creates the
existing SQLite adapter in its standard desktop WAL mode. It does not
discover a user directory, environment variable, account, provider, workspace,
repository, or executable. The application owns and closes the adapter it is
given.

Both application and worker-runtime production flags are literal `false`.
Finite refusal methods cover provider, workspace, Git, network, native worker,
credential, and production-registration effects. They do not refuse the
explicit SQLite/file persistence effect created by the Windows-local
composition. No live executor or usage reader is bundled, so a reservation or
prepared dispatch has no in-package path to a provider call. An injected
`UsageSnapshotAdapter` is nevertheless caller-supplied executable code: the
application validates its returned value but does not sandbox that callback or
prove what external effects it performs.

## Durable work state and commands

One immutable `WorkerWorkDefinition` binds:

- a stable work identity and existing `OrchestrationTaskEnvelope`;
- one exact normalized route candidate and workload class;
- one capacity pool and fairness key;
- ready time, deadline, retry policy, and estimated normalized usage; and
- the task budget and requested route already defined by Stage 18A.

Definitions reject estimated usage above the task's input, output, tool-call,
or known-cost budget. The runtime state progresses through:

| State        | Meaning                                                            | Legal next classes                                                  |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `ready`      | durable, eligible for a bounded claim                              | lease, deadline cancellation                                        |
| `leased`     | one fenced attempt owns the work                                   | renewal, reserve, retry/failure, cancellation, expiry               |
| `running`    | the exact prepared dispatch was marked started                     | completion, failure, cancellation, expiry                           |
| `retry-wait` | prior attempt terminalized its intents and waits for exact backoff | ready, deadline cancellation                                        |
| `completed`  | terminal success and actual usage reconciliation                   | none                                                                |
| `failed`     | terminal finite failure                                            | none, except pending usage reconciliation where explicitly recorded |
| `cancelled`  | terminal cancellation                                              | none, except pending usage reconciliation where explicitly recorded |

Worker commands and events are bounded, schema-closed JSON objects with
deterministic IDs and fingerprints. Every event retains its complete canonical
command projection, and replay verifies that projection against the exact
event transition rather than trusting an opaque digest. The public parser
recomputes command and event identity; replay reparses every event, requires
contiguous sequence/time, refuses duplicate event or command identity, and
applies command-legal projections. Aggregate checkpoints are compared
byte-for-byte through canonical JSON against the complete append-only journal.
Persisted event type, version, time, trace, aggregate version, and causation
must match their embedded event.

The normalized runtime configuration and exact usage-adapter identity/schema
are retained in the first event and every state, then canonicalized and
SHA-256 bound. A reopen under a different queue, lease, renewal, freshness,
circuit, usage-read timeout, aging, capacity-pool, total-retention, or adapter
policy fails closed instead of silently changing future behavior. No snapshot
compaction is implemented in this checkpoint; every load replays the bounded
journal. Attempts are limited to eight by the existing task schema and lease
renewals are independently bounded per attempt, so each aggregate journal is
finite. The separate `maximumRetainedWorkItems` setting bounds all worker
aggregates, including terminal history, to 1–10,000 (default 1,000). At the
bound, new work fails with backpressure while exact existing duplicates remain
write-free. Compaction/archival is intentionally deferred.

## Queue, capacity, fairness, and deadlines

Queue depth and total retained work are bounded before enqueue in the
persistence transaction. Claim
scans the durable projection in one short transaction, counts active work per
configured capacity pool, and admits at most that pool's maximum. Concurrent
logical claimers therefore cannot own the same ready item or exceed pool
capacity through the memory or SQLite adapter.

Ordering is deterministic and locale-independent:

1. explicit task priority plus bounded wait-time aging, capped at critical;
2. fewer prior attempts for the fairness key;
3. earlier ready time;
4. stable fairness key; and
5. stable work identity.

Wait-time aging lets old low-priority work reach the highest effective rank
without manufacturing a priority above critical. Deadline expiry cancels work
before another claim or retry becomes eligible.

## Leases, fencing, retry, and split brain

Every claim increments the attempt and monotonically increasing per-work
fencing token. The lease ID hashes definition identity, worker, attempt, fence,
and command identity. Renewal requires the exact current lease/worker/fence,
an unexpired lease, a strictly later heartbeat and expiry, and remaining
per-attempt renewal capacity. Initial and renewed leases cannot outlive the
task's dispatch/attempt timeout or overall deadline. Reservation, dispatch
preparation/start, completion, and worker failure repeat the same fence check.

Stale, expired, or split-brain workers cannot complete or mutate current work.
An expired pre-dispatch lease either schedules the exact bounded exponential
backoff or terminal-fails when attempts are exhausted. An expired started
dispatch terminal-fails with
`lease-expired-reconciliation-required`; it is never automatically redispatched
because the external operation may have run.

Worker-declared retry is allowed only when the requested classification is in
the immutable task retry policy and attempts remain. Backoff is exact,
exponential, and capped by the task policy. Reservation and dispatch intents
from the prior attempt are released/reconciled and terminalized before work can
be ready again.

## Usage, circuit, reservation, and dispatch transaction

No persistence transaction is held across the injected usage read. The read
has a configured finite timeout and an abort signal; close aborts registered
reads and late results cannot write. The runtime uses this two-phase
fail-closed pattern at reservation, dispatch preparation, and dispatch start:

1. load the exact fenced attempt;
2. run the existing non-usage routing rules against the exact persisted
   candidate and reject unavailable, unauthorized, incapable, stale/future
   health, permission, or borrowed-policy failures before invoking the port;
3. require the live adapter ID/schema to match the persisted binding and require
   native schema v2 before invoking the port;
4. validate bounded closed circuit evidence for the exact provider/profile;
5. read one scoped usage snapshot through the injected adapter;
6. run the complete existing hard routing/usage policy without synthesizing
   replacement candidate-health evidence;
7. open the short persistence transaction;
8. reload the exact attempt and fence;
9. revalidate circuit, candidate health, and usage freshness at the commit
   clock instant; and
10. append the aggregate projection and journal event atomically.

Reservation records contain the source adapter version/fingerprint, source observation,
five-hour and weekly window IDs and used amounts, predicted increments,
estimated usage, and complete bounded circuit evidence. The corresponding
canonical usage snapshot is retained in the event so replay can re-evaluate
authorization, revocation, source freshness, reset windows, profile scope, and
hard routing caps. Dispatch preparation requires a second usage read; usage
source/window identities and circuit source identity cannot change, usage and
circuit observations cannot move backwards, and the same full circuit checks
repeat. Marking the intent started performs a third read and repeats exact
candidate health, freshness, reset, circuit, source,
cross-work liability, and work-hours checks at the exact start clock. Every
refreshed canonical snapshot is journaled. The dispatch intent binds one
deterministic dispatch ID, exact route, reservation, the complete preparation
snapshot, complete circuit evidence, and a request fingerprint over all of
that normalized evidence—not only caller-declared IDs.

Borrowed-profile capacity is a persistence-wide, globally sequenced audit per
adapter/schema/provider/profile authority. It retains every reserve, prepare,
start, and release observation in `EventRecord.globalSequence` order, enforces
stable ownership and legal window rollover, rejects backwards observation or
used values, and sums every outstanding predicted liability before each hard
cap decision. This avoids both same-clock ordering ambiguity and independent
task reservations oversubscribing one profile. An active or
`reconciliation-required` prediction remains chargeable across provider-window
rollover. Reconciled usage cannot prove that provider basis-point accounting
has caught up, so its prediction remains conservatively charged to the
originating window through reset; when reconciliation occurs after that reset,
the charge remains unassigned until the next authoritative observation binds
it to the successor window through that window's reset. Only a reservation
released before dispatch drops immediately.

Prepared and started dispatch records are intents only. They neither invoke a
provider nor grant provider authority. Known actual usage above a task budget
cannot record success; it becomes a finite `usage-budget-exceeded` failure with
the exact actual usage. Unknown actual monetary cost likewise cannot prove a
finite cost ceiling and becomes `usage-cost-unknown`, never success.

Completion and worker failure atomically terminalize dispatch and reconcile or
release the reservation. If a started dispatch expires or is cancelled before
actual usage is known, its reservation becomes
`reconciliation-required`—not falsely reconciled at zero. A typed
`reconcile-usage` command later binds the exact terminal reservation and
dispatch, records actual usage once, and cannot redispatch work. Duplicate
identical reconciliation is write-free; conflicting reuse fails.

Fault injection after aggregate update but before event append proves the
underlying transaction rolls back enqueue, claim, reservation, dispatch
preparation/start, completion, lease-expiry marking, and deferred
reconciliation as one unit.

## Usage snapshot version 2

The canonical usage snapshot advances from version 1 to version 2. Native v2
adds:

- source fingerprint and finite source class;
- explicit compatibility class;
- explicit authorization and revocation classes;
- source-declared `freshUntil`; and
- stable five-hour and weekly window identities.

It preserves provider/profile/ownership scope, used/remaining basis points,
reset and observed times, confidence, authority, and the fixed
`Europe/London` timezone. Used and remaining must total 10,000; windows must be
distinct; freshness cannot outlive a reset; invalid/future/expired resets and
freshness fail closed.

Version-1 values remain readable through a deterministic migration for audit.
Because v1 had no authorization, revocation, source-fingerprint, window-ID, or
source-freshness evidence, migration marks authorization ambiguous and
revocation unknown. A migrated v1 value is never dispatch-eligible. This is an
intentional secure compatibility boundary rather than invented authority.

The `UsageSnapshotAdapter` port accepts either declared adapter schema version
so older implementations remain constructible, but hard routing refuses any
observation that cannot produce eligible native v2 evidence.

## Borrowed-profile policy

Routing retains the previously accepted half-open weekday work interval
`[09:00, 17:00)` in `Europe/London`, including DST-safe calendar projection.
During that interval a borrowed profile is ineligible at 50% five-hour use or
when predicted work would cross 50%. It is always ineligible at 70% weekly use
or when predicted work would cross 70%. Landing exactly on a ceiling from
below is allowed; starting another task at the ceiling is not.

Borrowed profiles require an explicit `claude-code` task authorization and an
explicit allowed-model decision in addition to the existing profile
authorization. Borrowed profiles never serve Fable work. Scoring, health,
cost, or fallback cannot revive an ineligible route.

`borrowedPolicy` is an optional additive member of the existing version-1
`RouteCandidate` source/wire shape. A legacy owned candidate without the member
normalizes to `null`. A borrowed candidate without the complete explicit
policy fails closed. This preserves existing owned callers without treating
absence as borrowed authority.

## AI Account Manager investigation and adapter

The static investigation pins:

- repository `https://github.com/alijabbar04/ai-account-manager.git`;
- commit `99be1cc6fa0fbbcfffcb4b7042d9bf0bf5ae0ae0`;
- tree `49eb2f93f3012836b9a88ac705de8a9df1e8646f`;
- runtime version `1.4.1`; and
- 23-file checkout inventory digest
  `1898a7fdbe6236828d6bfac7b6064e94fe65a3859d56ae5fff86061906f129ff`.

The upstream code is MIT-licensed but exposes no suitable supported external
read-only interface. Its useful paths are internal Electron IPC, local JSON,
credential/OAuth/provider access, or a spawned signed-in Codex App Server.
None was executed. Stage 18C therefore copies no runtime code and exposes only
`createAccountManagerFixtureUsageAdapter`.

The fixture reader must declare `fixtureOnly: true`. Each observation binds the
exact source identity, one opaque requested/scoped profile, provider,
ownership, authorization/revocation, source authority, timezone, freshness,
and complete windows. Missing, duplicate, partial, malformed, negative,
contradictory, cross-profile, or source-drift data fails with finite redacted
application errors. Reader failures cannot forward arbitrary messages.
`ACCOUNT_MANAGER_LIVE_ACCESS_ENABLED` is literal `false`.

`fixtureOnly` is a schema assertion, not an executable capability boundary.
The repository supplies only a deterministic fixture reader and no ambient
Account Manager/network/credential implementation; callers injecting either
this reader callback or the general usage-adapter port remain trusted to honor
the declared authority.

## SQLite now and PostgreSQL later

Current Windows single-user composition uses the existing SQLite adapter and
its short transactions, checksums, optimistic versions, and append-only event
store. A reusable application persistence contract runs against the memory
reference adapter and a real close/reopen SQLite file. It proves typed
reservation/dispatch/reconciliation, exact state/journal reopen, idempotent
enqueue, configuration-drift refusal, and no redispatch.

PostgreSQL parity remains required for multi-process/team deployment and is
not claimed. A future adapter must pass the same application contract plus
real row-lock/contention, concurrent-claim, migration, isolation, crash, and
reopen tests. No fake PostgreSQL implementation or local PostgreSQL service is
introduced here.

## Compatibility and migration summary

- Existing Stage 18A orchestration task/run/event schemas remain version 1 and
  unchanged.
- Stage 18A continues to use `task-run`. Stage 18C extends the persistence
  aggregate union with a closed `worker-run` discriminator and
  `worker-runtime:` IDs, so unrelated orchestration history cannot defeat the
  worker-retention bound. SQLite stores the discriminator as text, so this
  additive type requires no schema migration.
- Worker definition/state/event schemas are new version-1 contracts and have
  no prior persisted payload to migrate.
- Usage snapshots advance to v2 with the audit-only v1 reader described above.
- `UsageSnapshotAdapter.schemaVersion` adds v2 without removing v1.
- `RouteCandidate.borrowedPolicy` is additive/optional for legacy owned
  candidates and mandatory in semantics for borrowed candidates.
- Application contracts and the application package are new.
- No external runtime dependency is added; workspace dependency closure is
  recorded in the lockfile.

Any later change that enables production, changes the work-hour interval,
widens borrowed-model authority, changes persisted worker projections, adds
compaction, or permits another usage source must version the affected contract
and prove old replay/migration explicitly.

## Consequences and nonclaims

The checkpoint proves deterministic production-disabled orchestration over
memory and Windows-local SQLite with the bundled fixture usage evidence. It
does not prove Stage 17 production admission, make a provider call, reserve a
real account, mutate a usage ledger, execute a workspace/Git/native worker
effect, or support PostgreSQL/team concurrency. The explicit SQLite
persistence path is a real native file/storage effect and is not included in
that worker-effect nonclaim. It does not claim AI Account Manager's internal
surfaces are stable or authorized for integration.
It also does not prove that arbitrary caller-injected usage callbacks are
effect-free; those executable ports are explicitly trusted inputs.

Stage 18 still requires PostgreSQL parity, final Stage 17 dependency
integration/admission wiring, and a complete Stage 18 acceptance audit. Stage
19 evaluation/integration, Stage 20 API/daemon, UI/comms, live-account
integration, and Linux/macOS product paths remain outside this decision.
