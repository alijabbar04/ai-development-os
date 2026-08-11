# ADR 0024: Stage 18D PostgreSQL parity and refusal-only admission readiness

- Status: Accepted for a production-disabled checkpoint
- Date: 2026-08-10
- Scope: Windows-first Stage 18 development; hosted Ubuntu is compatibility and
  disposable PostgreSQL test infrastructure, not Linux product integration
- Depends on: ADR 0016 and ADRs 0019–0023

## Context

Stage 18C established one exact persistence/application contract over memory
and SQLite. SQLite is the right default for one Windows desktop process, but a
file database cannot establish the row-locking, independent-connection and
migration-startup behavior needed for a future team coordinator. At the same
time, the separately controlled Stage 17 native evidence is unavailable. A
database adapter must therefore add no execution authority and must not turn a
passing model review, branch name, CI result, public evidence projection, or
human assertion into production admission.

The existing persistence port stores opaque canonical aggregate documents. It
also owns event ordering, an outbox, immutable artifact metadata and a
forward-only migration planner. Replacing those contracts with PostgreSQL-only
domain tables would create a second application model. This decision instead
adds one concrete adapter and reuses the complete public contract.

## Decision

### 1. Desktop and coordination roles

`@ai-dev-os/persistence-sqlite` remains the Windows single-user desktop
default. `@ai-dev-os/persistence-postgres` is an async, explicitly configured
adapter for independent-process coordination testing and future team mode. Its
presence does not make team deployment eligible. Remote provisioning,
tenant/RBAC policy, TLS server administration, backup/restore, vector search,
artifact-blob storage and cloud operations are later decisions.

The adapter implements the existing `PersistenceAdapter` without changing
aggregate payload meaning. It stores `artifact-manifest`, `budget-account`,
`project`, `product-plan`, `task-graph`, `task-run`, `telemetry-ledger`, and
`worker-run` discriminators exactly as the port defines them.

### 2. Dependency choice

Use direct `pg@8.23.0`, `pg-pool@3.14.0`, and `@types/pg@8.21.0`; do not add
Kysely or `pg-native`. Production construction imports the reviewed
pure-JavaScript `pg/lib/client.js` client and supplies it explicitly to
`pg-pool`; it does not evaluate the root `pg` runtime entry, whose ambient
`NODE_PG_FORCE_NATIVE` switch could otherwise select an optional native peer.
A fresh-process regression sets that variable and proves package import still
uses the JavaScript path. The current SQLite adapter already makes transactions and SQL
visible, while a PostgreSQL-only query builder would add another abstraction
without unifying dialects or the checksum migration planner. The selected
driver and its reviewed runtime chain are pure JavaScript, permissively
MIT/ISC licensed, and declare no install lifecycle hook. Exact versions are lockfile-pinned; the
checkpoint records `npm ls --all`, package content, license, lifecycle-script,
audit and fresh-consumer evidence.

Node-postgres requires every statement in a transaction to use the same
checked-out client; `pool.query` is therefore forbidden inside the adapter
transaction ([node-postgres transactions](https://node-postgres.com/features/transactions),
[pool lifecycle](https://node-postgres.com/features/pooling)). Values use `$n`
parameters. The only interpolated identifiers are adapter-owned table names and
a schema that first passes a closed ASCII identifier grammar, consistent with
the driver's parameterization guidance
([queries](https://node-postgres.com/features/queries)).

### 3. Explicit connection and pool ownership

The public factory is async and accepts a structured connection:

```ts
createPostgresPersistenceAdapter({
  connection: { host, port, database, user, password, ssl },
  schema,
  maximumPoolSize,
  connectionTimeoutMs,
  idlePoolTimeoutMs,
  statementTimeoutMs,
  queryTimeoutMs,
  lockTimeoutMs,
  idleTransactionTimeoutMs,
  transactionTimeoutMs,
  shutdownTimeoutMs,
});
```

Every field is supplied; no connection string, `PG*` environment fallback,
credential file or default user/database path exists. TLS is either literal
`false` for an explicitly task-owned local/CI service or an object whose
`rejectUnauthorized` is literal `true`, optionally with an injected CA. This
avoids the driver's documented ambiguity between connection-string SSL options
and an SSL object ([client configuration](https://node-postgres.com/apis/client)).
The production driver additionally pins binary mode, startup options, UTF-8
client encoding, non-replication mode, PostgreSQL SSL negotiation and both
application-name fields. A canary regression sets every corresponding
behavior-affecting `PG*` variable and proves the explicit configuration wins.

The adapter owns its pool, installs a finite idle-error handler, checks out one
client per transaction, drains every store promise started in a callback, and
releases the client exactly once. `close` queues behind already submitted work,
is idempotent, and ends the pool under a shutdown bound. Operations after close
refuse. An unbounded caller callback is cut off at the adapter transaction
boundary; its context closes and the database transaction rolls back. The code
cannot cancel arbitrary caller work outside that context, which is not claimed.

### 4. Isolation, locks, sequences and retry

Each callback runs as one PostgreSQL `SERIALIZABLE` transaction. This makes
cross-row read/write races fail closed instead of committing a stale global
view. SQLSTATE `40001` is returned as a finite retryable
`CONCURRENCY_CONFLICT`. The
adapter never automatically reruns the callback because it is caller-controlled
and might contain a non-database effect. A higher application layer may retry a
known idempotent, effect-free command under a separate bounded policy.

Aggregate creation uses `INSERT ... ON CONFLICT DO NOTHING`; aggregate updates
use one `UPDATE ... WHERE aggregate_version = expected RETURNING *`. These
shapes distinguish missing, duplicate and stale writes without catching a
unique violation inside—and thereby aborting—the ambient transaction.

Outbox claim is the narrow native queue primitive:

```sql
SELECT ...
FROM outbox
WHERE eligible
ORDER BY sequence
FOR UPDATE SKIP LOCKED
LIMIT $n
```

This is the PostgreSQL-documented queue-like use for inconsistent lock-skipping
views ([locking clause](https://www.postgresql.org/docs/current/sql-select.html)).
Acknowledgement, retry and dead-letter transitions lock the exact row and reuse
the port's pure state machine. Ordinary reads do not use `SKIP LOCKED`.

Event and outbox order use bounded PostgreSQL identity sequences. Before either
sequence is allocated, the transaction takes one schema-scoped advisory
transaction lock. The lock is held through commit, preventing a later identity
from becoming visible before an earlier identity; keyset pagination therefore
cannot permanently skip a late-committing lower identity. `nextval` is atomic
and not rolled back, so rollback gaps are expected and already allowed by the
port. All `BIGINT` values are parsed locally and must remain safe JavaScript
integers. No global driver type-parser mutation is permitted.

The current scheduler selects opaque `worker-run` aggregates in application
code. The generic persistence port has no queryable priority/ready columns or
scheduler-specific `SKIP LOCKED` method. Serializable transactions prevent
silent stale commits. The application retries only the known effect-free,
idempotent `claim-work` command, at most four total attempts; it never retries a
usage callback, dispatch transition or external effect. Hosted tests use two
independent connections and two separate Node processes to prove contending
workers receive distinct eligible leases. This is bounded correctness evidence,
not a query-native high-throughput team scheduler claim.

### 5. Canonical storage and migrations

Canonical payloads stay `TEXT`, not `JSONB`, because checksums bind exact UTF-8
text. Adapter-clock timestamps stay canonical UTC `TEXT`; this avoids driver
`Date` conversion and PostgreSQL microsecond truncation. Identifier columns use
`COLLATE "C"` so mixed-case ordering is deterministic across server locales.
Database checks constrain discriminators, statuses, algorithms and numeric
bounds, while all records are fully revalidated and checksum-verified on read.

Migration startup has one explicit owner: a dedicated checked-out client holds
the package advisory session lock. After acquiring it, startup creates the
validated schema/migration ledger, rereads the entire applied history, and runs
the existing planner. Each forward migration and history insert commits in its
own transaction. A later failure preserves the earlier exact prefix, rolls back
the failing migration, and resumes after correction. Unknown future history,
ordering gaps and checksum drift refuse every open. The lock is always released;
a broken connection releases it at the server.

This is the permitted narrow advisory-lock case described by the technical
design: ownership is explicit and no application lease is represented by a
database session lock. PostgreSQL's session/transaction advisory distinction is
documented with other explicit locks
([explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)).

### 6. Errors, cancellation and redaction

Expected domain conflicts keep existing `PersistenceError` codes. A
serialization failure is `CONCURRENCY_CONFLICT` with finite reason
`serialization-failure`. Other SQLSTATE-derived or locally classified storage
failures use only `deadlock`, `lock-timeout`, `query-timeout`, `connection`,
`capacity`, `migration`, `shutdown`, or `storage`; bounded local races add
`transaction-timeout`, `rollback-timeout`, and `shutdown-timeout`. Those
envelopes carry a retryable boolean and, only when present and grammatically
valid, the five-character SQLSTATE. `MIGRATION_FAILED` instead carries the
finite migration ID and optional validated SQLSTATE; it does not claim a
`reason` field. No message, detail, hint, SQL, parameter, constraint, host,
database, user, password, TLS material, raw record or payload crosses the
boundary.

Connection acquisition, pool idle, query, server statement, lock,
idle-in-transaction, whole transaction and shutdown all have validated upper
bounds. PostgreSQL server timeouts are used as well as the client query bound;
the documented server controls are `statement_timeout`, `lock_timeout`, and
`idle_in_transaction_session_timeout`
([client timeouts](https://www.postgresql.org/docs/17/runtime-config-client.html)).
No ambiguous connection failure is retried invisibly.

### 7. Refusal-only admission

Application admission schema version 1 has no `admitted: true` member. Its gate
accepts only a small effect-class request and always returns:

- `admitted: false`;
- `productionEnabled: false`;
- `grantsAuthority: false`;
- `resumableByHumanApproval: false`;
- Stage 17 status `safety-gated`;
- finite rule IDs/reasons and, for a valid request, a non-secret diagnostic
  fingerprint.

Malformed, extra-field, unknown-version, copied, contradictory or prose-only
input refuses. The API accepts no Stage 17 evidence object, receipt, signature,
branch, CI or reviewer verdict. A future admitted schema needs a new version and
the existing private Stage 17 verifier/opaque capability; it cannot be built by
flipping a caller boolean. The process broker remains the final pre-spawn
authority even after any future coarse application admission.

The Stage 18A scheduler request retains its legacy `stage17Admitted` and
`productionEnabled` booleans for source compatibility, but schema version 1
parses and ignores them for authority. It unconditionally records the Stage 17
admission requirement and compiled production refusal. A future admitted
schema must replace those diagnostics with private verifier evidence; changing
a caller boolean or compiled constant cannot activate this version.

`createPostgresProductionDisabledApplication` may perform the explicit database
network/persistence effect needed to open/migrate/transact/close. It wires no
provider, workspace, Git, credential, native-worker or production-registration
effect. The literal-false legacy Stage 18C constant remains as a source-compatible
alias.

### 8. Test and CI strategy

No PostgreSQL or container runtime is installed on the development Windows host.
Local capability absence is recorded; it is not replaced with a database claim.
A deterministic driver seam runs the full shared persistence contract and
maintains offline coverage, but it is explicitly supplementary.

The dedicated hosted job uses the immutable image
`postgres:18.4-alpine3.24@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15`
with fixed job-only credentials, a health check, one mapped localhost port and
no volume. GitHub requires service-container jobs on Linux runners; this is
test infrastructure rather than Linux product work
([GitHub PostgreSQL services](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)).
The job requires explicit test fields and fails if any is missing. It runs the
same persistence/application contracts plus concurrent migration, independent
optimistic writes, native `SKIP LOCKED`, real lock timeout, reopen and coverage.

## Consequences and checkpoint labels

SQLite remains simple and local. PostgreSQL adds a real independent-connection
contract without duplicating domain semantics, and production admission remains
structurally closed. The cost is an async factory, an additional pure-JavaScript
dependency chain, SQL dialect code, hosted service time and explicit handling of
serialization conflicts.

The complete Stage 18 acceptance matrix is authoritative. Use
`Stage 18 development scope complete; production admission gated on Stage 17W`
only when every non-production Stage 18 row is proven. Use
`Stage 18D production-disabled checkpoint complete` when the adapter/admission
slice is green but another non-production item—currently the real direct
Anthropic canary—remains. Query-native high-contention team scheduling is a
deployment-scale nonclaim rather than evidence inferred from the bounded
process test. Use
`Checkpoint incomplete` while any mandatory Stage 18D implementation, real
PostgreSQL, review, coverage, push or exact-head CI evidence remains absent.

Nothing in this ADR claims Stage 17 completion, production readiness, a team
deployment, a live provider/account reader, a daemon, external mutation, or
Stage 19 completeness.
