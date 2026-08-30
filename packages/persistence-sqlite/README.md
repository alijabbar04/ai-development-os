# @ai-dev-os/persistence-sqlite

Production SQLite implementation of the `@ai-dev-os/persistence` contract,
built on `better-sqlite3`. Passes the same shared contract suite as the
in-memory reference adapter, in both `:memory:` and file-backed modes.

## Usage

```ts
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";

const adapter = createSqlitePersistenceAdapter({
  file: "C:/Users/me/AppData/Roaming/ai-dev-os/state.db", // absolute path
  // or: memory: true
  clock: myInjectedClock,   // optional
  observer: recordMetrics,  // optional
  busyTimeoutMs: 5_000,     // default
  journalMode: "wal",       // default for file databases
});
```

Opening applies pending migrations and validates the applied history; the
returned object exposes only `transact`, `migrationStatus`, and `close` —
the raw SQLite connection never crosses the package boundary.

Stage 20 C7 adds no SQLite migration. Both `aggregates.aggregate_type` and
`events.aggregate_type` have always been generic `TEXT NOT NULL`; the shared
runtime parser supplies the exact closed vocabulary before a statement runs.
Released `0001-initial-schema` remains byte-identical and checksummed while the
complete shared suite proves every new discriminator in memory and file modes,
including physical close/reopen for the file database.

## Driver decision

**Chosen: `better-sqlite3` (v12 line).** Mature and actively maintained,
prepared statements everywhere, explicit synchronous transaction control
that maps directly onto the serialized `transact` contract, prebuilt
binaries for Windows and Linux on current Node, and no ORM layer.

Alternatives considered:

- **`node:sqlite`** — zero-dependency and attractive, but still marked
  experimental and unavailable/flagged on the older Node 22 releases this
  repository's `engines` floor (`>=22.9.0`) permits. Worth revisiting once
  it is stable across the supported engine range.
- **Kysely** (mentioned in the technical-design baseline) — a typed query
  builder adds abstraction without value at this schema size (a handful of
  static statements); it can be layered in when the PostgreSQL adapter
  (Stage 18) makes multi-dialect queries real. This is a documented
  deviation from the design baseline, not an accident.
- **better-sqlite3 v13** — ships prebuilds inside the npm tarball, but its
  script-less install shape trips an npm quirk where `npm ci` synthesizes a
  default `node-gyp rebuild` (despite `"gypfile": false`) and fails on
  machines without a C++ toolchain. The v12 line's explicit
  `prebuild-install || node-gyp rebuild` flow installs reliably under both
  `npm install` and `npm ci`; pin stays on v12 until the ecosystem settles.

## SQLite configuration

| Setting | Value | Rationale |
| --- | --- | --- |
| `journal_mode` | `wal` for file databases (default) | Standard durable desktop configuration; readers never block the writer. A power loss can roll back the newest commits but never corrupts the file. `delete` mode is available for strict per-commit durability. |
| `synchronous` | `NORMAL` under WAL, `FULL` under delete mode | Matches the journal-mode durability trade-off. |
| `foreign_keys` | `ON` | Required by the Stage 3 contract. |
| `busy_timeout` | 5000 ms (configurable 0–600000) | Bounded waiting instead of immediate `SQLITE_BUSY`. |
| Tables | `STRICT` | Exact TEXT/INTEGER domain semantics; no silent affinity coercion. Canonical JSON payloads live in TEXT, so large integers (money micros up to `Number.MAX_SAFE_INTEGER`) round-trip exactly. |

All value binding uses prepared statements with `?` placeholders. The only
string-built statements are the two PRAGMAs, whose inputs are a validated
bounded integer and a closed enum (PRAGMAs cannot take bound parameters).
Sequences (`globalSequence`, outbox `sequence`) are assigned as
`MAX + 1` inside the ambient transaction, giving the same
rollback-and-reuse behavior as the in-memory reference adapter.

## Path handling

`file` must be an absolute, NUL-free, non-URI path (max 1024 chars) whose
parent directory already exists; anything else is rejected before the
database is opened. `memory: true` opens a private in-memory database
(WAL does not apply there).

## Migrations

Defined in `SQLITE_MIGRATIONS` as immutable checksummed SQL documents
(`0001-initial-schema`, ...). On open, the shared planner validates the
applied history (order, checksums, unknown-future migrations) and each
pending migration runs in its own transaction, recorded with id, checksum,
application time, and ordinal. A failed migration rolls back completely and
leaves the database at the last successful migration; a corrected build
resumes from there. A database containing unknown migration ids fails with
`SCHEMA_TOO_NEW` instead of being opened.

## Error translation

Driver failures are translated at the boundary into
`PersistenceError("STORAGE_FAILURE")` carrying at most the SQLite error
code — never SQL text, bound values, or row contents. Contract errors
(conflicts, duplicates, corruption, not-found) are raised by the adapter's
own pre-checks, identical to the memory adapter.

## Testing

- The shared contract suite runs twice: `:memory:` mode and file-backed
  mode (temp directory per test, cleaned up afterwards, parallel-safe).
- File mode additionally covers: reopen-with-a-new-adapter state
  verification, WAL configuration, tampered payloads and substituted
  checksums (via a separate raw connection), tampered migration checksums,
  future-schema rejection, failed-migration recovery, exact
  integer/timestamp round-trips, and path validation.

## Known limitations

- Single process, single writer: `transact` serializes; multi-process
  coordination is out of scope until the PostgreSQL adapter (Stage 18).
- Backup metadata and retention tooling are deferred to the artifact-store
  and hardening stages.
