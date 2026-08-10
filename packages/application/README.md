# `@ai-dev-os/application`

Stage 18C production-disabled Windows-local application composition. The
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
real provider/workspace/Git or native worker-execution effects, PostgreSQL
parity, a daemon, API, UI, and messaging adapters are not part of this
checkpoint. The explicit Windows-local composition does create and mutate its
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
- `execute` accepts the typed scheduler worker-command union. `tick` performs
  deadline, retry-ready, and lease-expiry reconciliation only. Neither method
  contains a provider/workspace/Git or native worker executor.
- `assertProductionEffectDisabled` deterministically refuses every finite live
  effect class.

The `@ai-dev-os/application/testing` export provides one reusable application
persistence contract. It currently passes against the memory reference adapter
and a real SQLite close/reopen file. A future PostgreSQL adapter must run the
same suite plus its database-specific contention and multi-process tests; this
package contains no fake PostgreSQL implementation.

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
