# `@ai-dev-os/persistence-postgres`

Production-disabled PostgreSQL implementation of the provider-neutral
`@ai-dev-os/persistence` contract. SQLite remains the single-user Windows
desktop default; this adapter is the Stage 18D coordination/test boundary for
independent processes and future team deployments.

The package does not provision a server, discover `PG*` environment variables,
accept a connection string, read a credential store, or enable a worker/provider
effect. Its public async factory requires every host, port, database, user,
password and TLS choice explicitly. The application composition that uses it
still reports `productionEnabled: false` and refuses every production effect.
The driver also pins binary mode, startup options, client encoding, replication
mode, SSL negotiation and both application-name fields, so the supported
`PGBINARY`, `PGOPTIONS`, `PGCLIENTENCODING`, `PGREPLICATION`,
`PGSSLNEGOTIATION`, and `PGAPPNAME` inputs cannot substitute ambient behavior.
Production construction imports the reviewed pure-JavaScript
`pg/lib/client.js` implementation and supplies it to exact `pg-pool@3.14.0`
directly. It never evaluates the root `pg` runtime entry, so ambient
`NODE_PG_FORCE_NATIVE` cannot select an optional native driver or make package
import depend on that peer.

## Transaction and locking model

- One checked-out `pg` client owns each transaction; `pool.query` is never used
  inside a transaction.
- Transactions use PostgreSQL `SERIALIZABLE`. A serialization failure is
  returned as a finite retryable `CONCURRENCY_CONFLICT`; the adapter never reruns a
  caller callback invisibly.
- Transactions remain FIFO-serialized within one adapter, matching the existing
  port. Independent adapter instances provide the real database contention
  surface.
- Aggregate updates use one conditional version write. Expected conflicts are
  classified without leaving the transaction aborted.
- Outbox workers select eligible rows in sequence order with
  `FOR UPDATE SKIP LOCKED`; acknowledgement/retry/dead-letter operations lock
  the exact message row.
- PostgreSQL identity sequences assign event and outbox order. A schema-scoped
  transaction advisory lock serializes allocation through commit, so a keyset
  cursor cannot miss an earlier identity that commits late. Rollback gaps are
  allowed, identities remain unique and increasing, and every returned `BIGINT`
  is checked against JavaScript's safe-integer ceiling.

## Migration model

The async factory obtains one explicitly owned session advisory lock, creates a
strict package schema, validates the complete checksummed migration history, and
applies each pending migration in its own transaction. Released migration text
is immutable. A future migration, checksum drift, history gap, or failed
migration refuses startup; a failed migration rolls back and a later corrected
open resumes from the last committed prefix.

Canonical JSON remains `TEXT` because its exact UTF-8 representation is the
checksum identity. Timestamps are canonical UTC text from the injected clock,
avoiding driver conversion/truncation. Mixed-case identifiers use PostgreSQL's
`C` collation to preserve the contract's deterministic ordering.

## Bounds and redaction

Pool size, acquisition, query, server statement, lock, idle-pool,
idle-in-transaction, whole-transaction and shutdown waits all have validated
finite bounds. TLS is either explicitly disabled for a task-owned local/CI
database or verification is mandatory, with an optional injected CA. Expected
domain errors retain their finite contract fields. Serialization and storage
failures expose only a finite local classification, retryability and an
optional validated SQLSTATE; bounded local timeouts use fixed timeout reasons.
`MIGRATION_FAILED` instead exposes only the finite migration ID and optional
validated SQLSTATE. Errors never serialize SQL, parameters, connection fields,
credentials, server detail/hint text, raw rows, or payloads.

## Validation

The deterministic driver seam runs the complete reusable persistence contract
and keeps Windows/offline coverage meaningful. It is not database evidence.
The dedicated hosted job uses the pinned disposable PostgreSQL service to run
the same contract, physical close/reopen application contract, concurrent
migration startup, conditional-write contention, native `SKIP LOCKED` claims,
event/outbox commit-ordered identities, real lock-timeout and backend-termination
classification, and synchronized shared borrowed-cap contention.

```powershell
npm test --workspace @ai-dev-os/persistence-postgres
npm run test:coverage --workspace @ai-dev-os/persistence-postgres

# Explicit opt-in real service only
$env:AI_DEV_OS_REQUIRE_POSTGRES_TESTS = "1"
$env:AI_DEV_OS_TEST_POSTGRES_HOST = "127.0.0.1"
$env:AI_DEV_OS_TEST_POSTGRES_PORT = "5432"
$env:AI_DEV_OS_TEST_POSTGRES_DATABASE = "ados_test"
$env:AI_DEV_OS_TEST_POSTGRES_USER = "ados_test"
$env:AI_DEV_OS_TEST_POSTGRES_PASSWORD = "task-owned-test-value"
npm run test:live --workspace @ai-dev-os/persistence-postgres
```

## Nonclaims

This checkpoint is not a remote/team deployment, tenant/RBAC design, TLS server
administration guide, artifact-blob store, vector index, daemon, or production
admission. The generic scheduler currently chooses an opaque ready aggregate in
application code; PostgreSQL can make conflicting transactions fail closed, but
the persistence port does not expose a scheduler-specific queryable `SKIP
LOCKED` claim primitive. Bounded process-separated scheduler claims, bounded
application-level conflict retry, and the shared-cap race are explicit hosted
acceptance-matrix proofs rather than inferences from outbox locking. A
query-native, high-throughput team scheduler remains a deployment-scale
nonclaim for this checkpoint.
