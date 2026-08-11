# `@ai-dev-os/application`

Stage 18D production-disabled Windows application composition. The
package owns use-case transaction boundaries and composes the canonical
scheduler and SQLite persistence contracts. It does not own a second task
graph, scheduler, usage ledger, provider registry, workspace implementation,
or policy broker.

The bundled Account Manager implementation is fixture-backed only. It is
pinned to the reviewed upstream commit and accepts a narrow, body-free protocol
containing only opaque profile identity, window identity, basis-point usage,
reset and observation times, source provenance, and
authorization/revocation classes. This package bundles no Account Manager,
Codex, Electron, browser, provider, credential, or installed-state reader.
The fixture reader and the general `UsageSnapshotAdapter` are injected
executable callbacks, however: they are caller-trusted ports, and the
`fixtureOnly: true` marker is a validated assertion rather than a capability
sandbox. A caller is responsible for ensuring its implementation has only the
authority claimed here.

Production execution remains compiled off. Stage 17 production admission,
real provider/workspace/Git or native worker-execution effects, a daemon, API,
UI, and messaging adapters are not part of this checkpoint. The explicit
Windows-local composition does create and mutate its
requested SQLite persistence file; that native storage effect is in scope and
is not a worker executor.

## Public composition

- `createProductionDisabledApplication` composes an explicitly injected
  persistence adapter, usage adapter, optional clock, and immutable normalized
  runtime configuration. Construction grants no ambient reader, but reserve,
  prepare, and start operations invoke the caller-supplied usage port.
- `createWindowsLocalProductionDisabledApplication` requires one explicit
  absolute SQLite file path and uses the existing default WAL desktop adapter. It does
  not discover a home directory or account location.
- `createPostgresProductionDisabledApplication` is async and requires one fully
  explicit connection. It may perform bounded database network/persistence
  effects to open, migrate, transact, and close that database, but wires no live
  worker/provider/account effect and is not team-deployment admission.
- `execute` accepts the typed scheduler worker-command union. `tick` performs
  deadline, retry-ready, and lease-expiry reconciliation only. Neither method
  contains a provider/workspace/Git or native worker executor.
- Only `claim-work`, whose transaction is effect-free and idempotent, receives
  a fixed four-attempt retry on a persistence `CONCURRENCY_CONFLICT`. Hosted tests
  use independent connections and two separate Node processes to prove distinct
  leases; reserve/prepare/start and external callbacks are never invisibly
  retried.
- The version-1 `admission` gate has no admitted variant. It returns only a
  diagnostic fingerprint, finite rule IDs, `grantsAuthority: false`, and
  `productionEnabled: false`; copied JSON, prose, human approval, CI state, or a
  public Stage 17 projection cannot resume it.
- `assertProductionEffectDisabled` delegates every finite live effect class to
  that refusal-only gate.

The `@ai-dev-os/application/testing` export provides one reusable application
persistence contract. It passes against the memory reference adapter, a real
SQLite close/reopen file, and—only in the dedicated hosted-service job—the real
PostgreSQL adapter with physical reopen. The PostgreSQL package's deterministic
driver seam supplies offline unit coverage but is not substituted for that live
database evidence.

## Fixture usage protocol

The Account Manager fixture adapter is bound to repository commit
`99be1cc6fa0fbbcfffcb4b7042d9bf0bf5ae0ae0`, tree
`49eb2f93f3012836b9a88ac705de8a9df1e8646f`, runtime version `1.4.1`, and the
23-file inventory digest recorded in ADR 0023. It accepts exactly one body-free
observation for the requested opaque profile. Invalid source identity,
duplicates, malformed/partial windows, negative or contradictory totals, and
cross-profile data fail with finite redacted application errors. Stale,
future, cached/estimated, unauthorized, ambiguous, or revoked values remain
ineligible under the scheduler's hard usage policy.
