# `@ai-dev-os/scheduler`

Stage 18A/18C's provider-neutral durable orchestration foundation. It validates
versioned task/result/event envelopes, persists `task-run` checkpoints and an
append-only journal atomically through `@ai-dev-os/persistence`, replays legal
state transitions, bounds concurrency/retries/backoff/deadlines/turns, and
produces deterministic usage-aware routing decisions.

The public scheduler is deliberately production-disabled. Dispatch emits a
durable terminal policy block because Stage 17 production admission is not
satisfied; permission modes cannot weaken that result. Deterministic fake
execution exists only under `@ai-dev-os/scheduler/testing` for lifecycle and
recovery tests. No provider credential, live thread, UI automation, native
proof, or live account-manager implementation is bundled. The injected usage
adapter remains caller-trusted executable code; the production-disabled
runtime validates its returned data but cannot constrain effects performed
inside that callback.

Borrowed-profile routing uses `Europe/London` calendar projection, a weekday
09:00-inclusive/17:00-exclusive rolling five-hour ceiling of 50%, an always-on
weekly ceiling of 70%, and an unconditional Fable prohibition. Every candidate
is surfaced with machine rule IDs and human-readable reasons; denied routes are
never revived as fallback.

Stage 18A deliberately replays the complete bounded journal on each load and
compares it with the stored aggregate checkpoint. Snapshot/compaction and
PostgreSQL parity remain later Stage 18 work; they must preserve the same replay
result and corruption detection rather than weakening them.

Stage 18C adds a distinct `worker-run` aggregate family with
`worker-runtime:` identities, isolated from Stage 18A `task-run` history. It
owns bounded ready queues, deterministic
priority aging/fairness, capacity pools, attempts, heartbeats, leases,
monotonic fencing, exact retry backoff, deadlines, and cancellation. The
normalized runtime-configuration fingerprint is persisted with each work item,
along with the normalized configuration and exact usage-adapter binding, so
reopening under a different policy or source fails closed. Each event retains
its bounded canonical command and replay checks command-equivalent state
changes. Dispatch and attempt timeouts plus a finite renewal limit bound every
attempt journal. `maximumRetainedWorkItems` also bounds all retained worker
aggregates, including terminal history (default 1,000; configured range
1–10,000). No compaction is implemented: once that total-history bound is
reached, new enqueue is refused while exact duplicates remain readable and
write-free.

Usage is read outside short persistence transactions under a finite timeout
and then revalidated at the commit clock instant. Before invoking that port,
the runtime applies the existing non-usage routing rules to the exact persisted
candidate and requires the live adapter ID/schema to equal the persisted native
v3 binding; it never invokes known-ineligible v1/v2 or drifted adapters and never
fabricates available/healthy replacement evidence.
Reservation, preparation, and the durable dispatch-start boundary each journal
the complete canonical usage snapshot plus exact source/window and
  closed-circuit evidence. Preparation preserves circuit source identity and
  nondecreasing circuit observation time across the reservation boundary. A
  globally sequenced per-authority audit retains every observation and release,
  carries active predicted liability across window rollover, and re-evaluates
  the same hard caps during restart replay. Reconciled predictions remain
  conservatively charged through the applicable provider window's reset because
  token/cost reconciliation does not prove that basis-point reporting has caught
  up; only unused pre-dispatch releases drop immediately. Started work that
  expires or is
cancelled cannot be blindly replayed or falsely reconciled at zero: it becomes
terminal with a `reconciliation-required` reservation, and a later exact
idempotent command may record actual usage without redispatch. Aggregate and
journal changes remain atomic at every boundary.

Canonical usage snapshot version 3 adds an exact `active`/`inactive` state to
each required provider window. Active windows retain bounded basis-point and
reset evidence. Inactive windows carry only a stable identity plus null usage,
remaining-capacity, and reset fields: they are preserved as truthful evidence
but are never dispatch-eligible or interpreted as zero usage or unlimited
capacity. Usage-snapshot versions 1 and 2 remain readable as bounded standalone parser/audit
inputs but are never dispatch-eligible because they lack the complete current
authority/window projection. Worker runtime state, aggregate, and event schema
v2 make that persisted projection change explicit; work definitions remain v1.
This checkpoint does not migrate or replay v1 worker runtime aggregates or
journals containing legacy snapshots; they fail closed before callbacks. Legacy owned route candidates may omit the
additive borrowed-policy member; borrowed candidates require explicit Claude
Code task and model authorization and remain forbidden for Fable.
