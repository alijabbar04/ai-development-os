# `@ai-dev-os/application`

Stage 18D production-disabled Windows application composition. The
package owns use-case transaction boundaries and composes the canonical
scheduler and SQLite persistence contracts. It does not own a second task
graph, scheduler, usage ledger, provider registry, workspace implementation,
or policy broker.

The historical Account Manager fixture adapter remains available for
deterministic compatibility tests. A second supported, production-disabled
route now loads only the exact reviewed Account Manager usage-reader artifact
from an explicit absolute module path, verifies its normalized source SHA-256,
and restricts that fixed source's CommonJS `require` resolution to
`node:crypto`, `node:fs`, and `node:path`. This is an exact-source boundary,
not a general VM capability sandbox. The route binds the exact upstream commit/tree/inventory, the
reader artifact, canonical store/allowlist/freshness configuration fingerprint,
opaque profile authority, and normalized observation into snapshot identity.
It has no UI, browser, credential, session-refresh, or provider-call authority.

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

## Supported Account Manager usage reader

`createAccountManagerSupportedUsageAdapter` accepts an explicit path to the
supported `ai-account-manager-desktop/usage-reader` CommonJS artifact plus its
reader configuration, one independently authorized profile projection, the
expected nonsecret configuration fingerprint, and a freshness ceiling. The
compiled source pin is:

- repository commit `5279113728a344a87a7e49c4222741a618b67dd5`;
- tree `e8c342a77eaf01535db2bed2819e5ad87e1876df`;
- 29-path inventory SHA-256
  `df89d81c692f298b56ead07c4822a8efc87113919d5594ec0069df59d1161bf3`;
- normalized reader-source SHA-256
  `7626a6e24a10cf479983de7a1c7882ebf87a4ae45bf442c1b1f5a9d65ed04e40`.

The reader emits only the `claude-code` provider identity. Its cached local
quota observations must still pass the scheduler's freshness, authority,
revocation, ownership, and 50%/70% admission rules. Module substitution,
configuration substitution, reader-method drift, cross-profile results,
malformed/oversized nested data, cancellation, and expired deadlines fail with
finite redacted application errors. Lexical UNC/device module paths are refused;
deployment remains responsible for excluding mapped/network-backed drive roots.
This checkpoint did not read the installed
Account Manager store; `ACCOUNT_MANAGER_LIVE_ACCESS_ENABLED` remains literal
`false`, and `AM-02` remains incomplete pending an explicitly authorized live
read and exact-head hosted evidence.
