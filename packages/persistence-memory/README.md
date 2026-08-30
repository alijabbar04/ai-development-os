# @ai-dev-os/persistence-memory

Deterministic in-memory reference implementation of the
`@ai-dev-os/persistence` contract. Semantically equivalent to the SQLite
adapter — same transaction, versioning, event, outbox, pagination,
checksum, and error behavior, verified by the same shared contract suite —
not a weakened mock. Intended for unit tests and for scheduler/router
development in later stages.

Stage 20 C7 needs no adapter change: the implementation already keys its maps
by the shared validated `AggregateType`. The expanded 20-member union therefore
uses the same transaction, checksum, optimistic-concurrency, isolation, event,
and close semantics. The shared suite independently exercises all ten C7
additions; no project parser or runtime behavior is imported.

## Usage

```ts
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";

const adapter = createMemoryPersistenceAdapter({
  clock: myInjectedClock,      // optional; defaults to the system clock
  observer: recordMetrics,     // optional structured operation records
});

await adapter.transact(async (tx) => {
  await tx.aggregates.create({ aggregateType: "project", aggregateId: "p-1", schemaVersion: 1, payload: {} });
});
await adapter.close();
```

## Behavior

- **Transactions with rollback:** state containers are snapshotted at
  transaction start and restored on failure; commits mutate nothing until
  the callback resolves successfully.
- **Optimistic concurrency, uniqueness, append-only events, outbox
  leasing:** identical semantics to SQLite via the shared pure logic in
  `@ai-dev-os/persistence`.
- **Deterministic ordering:** listings sort explicitly by their contract
  keys (never by Map insertion order); event and outbox sequences are
  explicit counters that participate in rollback.
- **Immutability:** stored records hold canonical serialized text; reads
  verify checksums and return freshly parsed, deeply frozen values, so no
  mutable references are shared with callers.
- **Lifecycle:** `close()` waits for in-flight transactions and is
  idempotent; later use fails with `ADAPTER_CLOSED`.

## Fault injection (test-only)

`MemoryPersistenceAdapter` adds corruption hooks used by the contract
suite; they tamper with committed stored text without touching checksums:

```ts
adapter.corruptAggregatePayload("project", "p-1");
adapter.corruptEventPayload("evt-1");
adapter.corruptOutboxPayload("msg-1");
adapter.corruptArtifactPayload("art-1");
```

Subsequent reads of the corrupted record fail with `CORRUPTION_DETECTED`.
These hooks are not part of the persistence contract and must not be used
outside tests.

## Non-responsibilities

No durability: state lives only as long as the adapter instance, so the
contract's reopen test is (correctly) skipped. `migrationStatus()` reports
an empty, up-to-date history since no schema exists.
