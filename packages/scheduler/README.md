# `@ai-dev-os/scheduler`

Stage 18A's provider-neutral durable orchestration foundation. It validates
versioned task/result/event envelopes, persists `task-run` checkpoints and an
append-only journal atomically through `@ai-dev-os/persistence`, replays legal
state transitions, bounds concurrency/retries/backoff/deadlines/turns, and
produces deterministic usage-aware routing decisions.

The public scheduler is deliberately production-disabled. Dispatch emits a
durable terminal policy block because Stage 17 production admission is not
satisfied; permission modes cannot weaken that result. Deterministic fake
execution exists only under `@ai-dev-os/scheduler/testing` for lifecycle and
recovery tests. No provider credential, live thread, UI automation, native
proof, or external account-manager access exists in this package.

Borrowed-profile routing uses `Europe/London` calendar projection, a weekday
09:00-inclusive/17:00-exclusive rolling five-hour ceiling of 50%, an always-on
weekly ceiling of 70%, and an unconditional Fable prohibition. Every candidate
is surfaced with machine rule IDs and human-readable reasons; denied routes are
never revived as fallback.

Stage 18A deliberately replays the complete bounded journal on each load and
compares it with the stored aggregate checkpoint. Snapshot/compaction and
multi-worker fencing are later Stage 18 performance work; they must preserve
the same replay result and corruption detection rather than weakening them.
