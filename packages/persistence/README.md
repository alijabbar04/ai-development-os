# @ai-dev-os/persistence

Provider-neutral persistence contracts for AI Development OS: storage ports,
persisted record shapes, structured errors, checksum and cursor utilities,
the migration planner, shared outbox state-machine logic, and the reusable
adapter contract-test suite.

This package defines *what* durable storage must do. It contains no SQLite,
no database driver, and no I/O beyond `node:crypto` (checksums) and
`node:async_hooks` (nested-transaction detection). Concrete adapters live in
`@ai-dev-os/persistence-memory` and `@ai-dev-os/persistence-sqlite`.

## Responsibilities and non-responsibilities

**Owns:** port interfaces (`PersistenceAdapter`, `TransactionContext`,
`AggregateStore`, `EventStore`, `OutboxStore`, `ArtifactMetadataStore`),
record envelopes and their validation, `PersistenceError` codes, sha-256
payload checksums, keyset cursors, `planMigrations`, pure outbox
transitions, and the behavioral contract suite every adapter must pass.

**Does not own:** SQL, drivers, network publishers, retention policy,
business aggregates. The aggregate payloads it stores are opaque canonical
JSON; domain meaning stays in `@ai-dev-os/domain` / `@ai-dev-os/task-graph`.

Dependency rule: `persistence-memory → persistence → domain/artifacts` and
`persistence-sqlite → persistence → domain/artifacts`. Nothing here may
import providers, Electron, HTTP frameworks, or UI code.

## Persistence model

One generic **versioned aggregate store** persists every Stage 3 aggregate,
typed by the closed `AGGREGATE_TYPES` union (`project`, `task-graph`,
`task-run`, `budget-account`, `artifact-manifest`, `telemetry-ledger`). Each
envelope carries:

| Field | Meaning |
| --- | --- |
| `aggregateType`, `aggregateId` | Stable identity (validated id format) |
| `schemaVersion` | Caller-declared payload schema version |
| `aggregateVersion` | Optimistic-concurrency version (see below) |
| `payload` | Canonical JSON (Stage 2 `toCanonicalJson` form) |
| `checksum` | `{ algorithm: "sha-256", hex }` over the canonical UTF-8 bytes |
| `createdAt` / `updatedAt` | Adapter-clock timestamps |
| `traceId` | Optional correlation id |

Immutable artifact descriptors and manifests are stored separately (they
are validated by `@ai-dev-os/artifacts` on write **and** on read, are
create-only, and have no version).

## Aggregate-version semantics

- `create` requires the aggregate to be **absent** and stores version **1**;
  creating an existing aggregate fails with `CONCURRENCY_CONFLICT`.
- `update` requires `expectedVersion` to equal the stored version exactly
  and stores `expectedVersion + 1`; any mismatch (stale or future) fails
  with `CONCURRENCY_CONFLICT` carrying `expectedVersion`/`actualVersion`.
- `update` of a missing aggregate fails with `NOT_FOUND`.
- There is no last-write-wins path.

## Transaction semantics

`adapter.transact(work)` is the only way to reach the stores, so aggregate
update + event append + outbox insert are atomic by construction:

- Callback resolution commits; rejection rolls back **all** writes and
  rethrows the original error unchanged.
- Transactions are serialized per adapter (single-writer).
- `transact` inside an active transaction throws `NESTED_TRANSACTION`.
- Using a context after its callback settles throws `TRANSACTION_COMPLETED`.
- `close()` waits for in-flight work, is idempotent, and everything after
  it throws `ADAPTER_CLOSED`.
- Retrying a rolled-back transaction with the same ids cannot duplicate
  events or outbox messages.

## Event semantics

Events are append-only with an adapter-assigned strictly increasing
`globalSequence` (starting at 1; gaps after rollbacks are permitted, order
is never violated). Each record separates `occurredAt` (caller fact time)
from `recordedAt` (adapter clock) and carries `traceId`/`causationId`.
Replayed `eventId`s fail with `DUPLICATE_ID`. The store does not interpret
event payloads and does not enforce aggregate existence — transactional
discipline belongs to the application layer.

## Outbox state machine

```text
enqueue       -> pending
claim         -> leased         pending & available, or lease expired;
                                attemptCount += 1
acknowledge   -> acknowledged   leased, same owner; terminal; repeat = no-op
scheduleRetry -> pending        leased, same owner; availableAt moves forward
deadLetter    -> dead-lettered  leased, same owner; terminal
```

Everything else — foreign owners, acknowledging a pending message,
transitioning a terminal message — fails with `OUTBOX_STATE_CONFLICT`.
Idempotency keys are unique per store (`DUPLICATE_IDEMPOTENCY_KEY`).
Claims are ordered by enqueue sequence and lease exclusively: concurrent
workers can never hold the same message. Failure categories are short
validated codes, never error text. The transitions themselves are exported
pure functions (`applyClaim`, `applyAcknowledge`, ...) so every adapter
shares one implementation. No network publisher exists in Stage 3.

## Checksum format

`sha-256` over the UTF-8 bytes of the canonical JSON text, stored alongside
an explicit algorithm identifier. Every read re-verifies; mismatches throw
`CORRUPTION_DETECTED` naming the record kind and id but never its contents.
Corrupted records are never repaired or reinterpreted.

## Migration guarantees

`planMigrations(definitions, applied)` is a pure planner used by durable
adapters. It rejects duplicate ids, unordered definitions, histories that
diverge from the defined order (`MIGRATION_FAILED`), changed checksums for
applied migrations (`MIGRATION_CHECKSUM_MISMATCH`), and databases newer
than the build (`SCHEMA_TOO_NEW`). Migration ids are `NNNN-kebab-name` and
definitions are immutable after release.

## Pagination guarantees

All listings use deterministic ordering with opaque keyset cursors
(base64url canonical JSON, fully validated; malformed or wrong-kind cursors
throw `INVALID_CURSOR`):

| Listing | Order | Cursor |
| --- | --- | --- |
| aggregates | `aggregateId` ascending (unique) | string-key |
| events | `globalSequence` ascending | sequence |
| outbox | enqueue `sequence` ascending | sequence |
| artifacts | `id` ascending (unique) | string-key |

Page sizes are 1–1000 (default 100). Because cursors are keyset-based,
records inserted or removed between page requests can neither duplicate nor
skip results. Raw offsets are not part of the contract.

## Observability

Adapters accept an optional `observer` receiving structured
`OperationRecord`s (`operation`, `outcome`, `aggregateType`, `durationMs`
measured with the injected clock). Records never contain payloads, ids, or
error text. Library code never writes to the console.

## Determinism

Adapters take an injected `Clock`; all ids are caller-supplied; nothing
uses randomness. The contract suite drives lease expiry with a manual clock
— no sleeps anywhere.

## Contract-test suite

`@ai-dev-os/persistence/testing` exports `runPersistenceContractSuite`
(vitest is an optional peer dependency, needed only by adapter test
suites). Adapter packages provide a `ContractHarness` (adapter, manual
clock, observer capture, and optional reopen/corruption capabilities) and
get ~45 behavioral tests covering CRUD, version conflicts, atomicity,
rollback, retry-without-duplicates, ordering, pagination, outbox leasing
and lifecycle, corruption, hostile input, secret hygiene, lifecycle, and
migration status. Capability-gated tests (reopen, corruption) are skipped
only where the capability is genuinely absent (e.g. reopening a pure
in-memory store).

## Security considerations

- Every input is validated with the shared Stage 2 validation toolkit:
  malformed ids, prototype-polluted payloads, non-canonical JSON, NaN,
  oversized payloads (10 MB serialized cap), and invalid timestamps are
  rejected before touching storage.
- Errors carry only identifiers, codes, and counts — never payload
  contents, SQL text, raw rows, or driver messages.
- Checksum substitution is covered: payload and checksum must agree with
  the recomputed digest.

## Example

```ts
await adapter.transact(async (tx) => {
  const graph = await tx.aggregates.update({
    aggregateType: "task-graph",
    aggregateId: runId,
    schemaVersion: 1,
    payload: snapshot,
    expectedVersion: 4,
  });
  await tx.events.append({
    eventId: `${runId}:5:task.added`,
    aggregateType: "task-graph",
    aggregateId: runId,
    aggregateVersion: graph.aggregateVersion,
    eventType: "task.added",
    eventSchemaVersion: 1,
    payload: eventBody,
    occurredAt: nowIso,
  });
  await tx.outbox.enqueue({
    messageId: `${runId}:5:publish`,
    topic: "events.publish",
    schemaVersion: 1,
    payload: { after: graph.aggregateVersion },
    idempotencyKey: `${runId}:5`,
  });
});
```

## Known limitations

- Single-writer: transactions serialize per adapter instance. Concurrent
  multi-process access is a PostgreSQL-stage concern (Stage 18).
- The event store does not verify that appended events reference existing
  aggregates or contiguous versions; callers own that discipline.
- No downgrade migrations (per roadmap).
