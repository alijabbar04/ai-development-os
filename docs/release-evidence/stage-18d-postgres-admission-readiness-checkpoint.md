# Stage 18D PostgreSQL and admission-readiness checkpoint evidence

Status: Stage 18D production-disabled source checkpoint published and
exact-head hosted PostgreSQL/CI verified
Evidence window: 2026-08-10 21:56 BST onward
Branch: `feat/stage-18d-postgres-admission-readiness`

## Outcome boundary

This candidate adds a real PostgreSQL persistence adapter and hosted-real
contract boundary, a refusal-only Stage 18D application admission projection,
and a machine-checkable full Stage 18 development acceptance matrix. It keeps
SQLite as the Windows-local single-user default and keeps every production
effect disabled.

The permitted outcome, after every pending publication gate passes, is
`Stage 18D production-disabled checkpoint complete`. The matrix accurately
retains the live Anthropic canary, supported live Account Manager reader, and
external-effect crash/idempotency proof as incomplete Stage 18 items. It does
not permit a claim that all Stage 18 development scope is complete.

Stage 17W remains gated by the exact separately safety-gated Stage 17 native
stateful operation. That operation and the restricted procedure/corpus were not
invoked, inspected, modified, reproduced, described, approximated, encoded,
renamed, wrapped, split, rerouted, retried, or bypassed during this work.

## Canonical branch and integration history

The Stage 18D branch was created from exact published Stage 18C:

- base commit: `992fb4dd606a8f2ed074921c6eb96d938ec8a43d`;
- base tree: `48aa1d965b282e0aa58a60557ddcbbd55ed65e8e`;
- base exact-head CI: run `31409095768`, all four jobs passed; and
- branch: `feat/stage-18d-postgres-admission-readiness`.

The reviewed Stage 17W repair branch was first preserved and published:

- final repair head: `f310f7db173cd55b37be5971af2b8c02462f1988`;
- tree: `7d5e38d3315c162839965809731f0dacbdedfbab`;
- focused commits: `1cd722859800e8c889b1c558afd098bde6ac343f`
  and `f310f7db173cd55b37be5971af2b8c02462f1988`;
- exact-head CI: run `31432092078`, dependency audit, Ubuntu, coverage, and
  Windows jobs passed; and
- local, upstream, and live remote equality was confirmed with a clean
  worktree.

Stage 18D then integrated that exact repair head with ordinary non-rewriting
merge commit `aa5c62cc9aa56ac3a21e5fd612992b9ea535776d`, tree
`e99cd799a549eaee538fc18ae67b1963856a5be1`, parents
`992fb4dd606a8f2ed074921c6eb96d938ec8a43d` and
`f310f7db173cd55b37be5971af2b8c02462f1988`. No rebase,
cherry-pick, squash, amend, reset, force push, or main-branch change occurred.

## Architecture and authority boundary

ADR 0024 records the following ownership:

- `@ai-dev-os/persistence-postgres` implements the existing provider-neutral
  persistence port for multi-process/team-coordination contract proof;
- SQLite remains the Windows desktop single-user default;
- the scheduler remains the sole owner of work, lease, fencing, usage,
  reconciliation, and replay semantics;
- application composition owns only explicit adapter construction and bounded
  effect-free claim retry; and
- the private Stage 17 broker/verifier remains the only future execution
  authority.

The Stage 18D admission schema has no admitted union member. It always returns
an immutable `admitted:false`, `productionEnabled:false`,
`grantsAuthority:false` projection with finite rule IDs. Malformed input has no
diagnostic fingerprint. `assertAdmitted`, including an extracted receiver-free
method, always throws finite `PRODUCTION_DISABLED`. Caller booleans retained
for scheduler source compatibility are parsed but cannot affect the
unconditional Stage 17 and production-disabled rules.

The application validates runtime composition and exact nested PostgreSQL
option keys before importing or calling the persistence factory. Omitted
`clock`/`observer` fields and arbitrary extras cannot be smuggled through an
untyped caller. Application production refusal occurs before injected
production-effect callbacks. The explicitly configured PostgreSQL factory may
perform its bounded database network/persistence effect; it still wires no
provider, account, workspace, Git, credential, native-worker, or registration
effect.

## PostgreSQL adapter and migration contract

The package uses exact `pg@8.23.0`, exact `pg-pool@3.14.0`, and
`@types/pg@8.21.0`. Production imports `pg/lib/client.js` and supplies that
pure-JavaScript client constructor directly to `pg-pool`; the root `pg` entry
is type-only and ambient `NODE_PG_FORCE_NATIVE` cannot select the optional
native driver. Host, port, database, user, password, TLS, pool, and timeout
fields are explicit; the driver pins timezone options, UTF-8 encoding,
non-replication, binary mode, application names, and SSL negotiation defaults.
Ordinary public construction does not read `PG*`, a connection string, or a
default credential path.

Connection, acquire, idle-pool, statement, query, lock, idle-transaction,
whole-transaction, rollback, startup-cleanup, and shutdown waits are finite.
One monotonic absolute transaction deadline spans BEGIN, local SET commands,
the caller callback, already-started operation drain, transaction-health probe,
and COMMIT. Rollback cleanup has its own finite bound. The transaction context
closes immediately when the callback settles, so escaped calls cannot enter
during drain/probe. A caught local/domain store rejection may still commit when
the callback resolves, matching memory and SQLite; an actual PostgreSQL-aborted
transaction is distinguished by the bounded `SELECT 1` health probe.

Transactions use SERIALIZABLE isolation without invisible callback replay.
SQLSTATE `40001` becomes retryable `CONCURRENCY_CONFLICT`; reviewed deadlock,
lock/query timeout, capacity, and connection-loss classes are finite and
redacted. Checked-out client socket errors are locally contained, listeners are
removed before release, failed clients are destroyed, and later healthy pool
use remains possible.

Aggregate updates are optimistic and conditional. Event and outbox global
identity allocation is protected by one schema-stable transaction advisory
lock acquired immediately before sequence allocation, so keyset readers cannot
miss a lower identity committed late. Native outbox claiming uses ordered
`FOR UPDATE SKIP LOCKED` and updates while row locks remain held. Stored
aggregate, event, outbox, descriptor, and manifest records are fully parsed,
canonically revalidated, checksum-checked, and bound to their physical row
keys; invalid stored state maps to finite corruption.

Migration `0001-initial-schema` is forward-only and checksummed as
`34413d60368bc485b1cbdc088d5000baa4ce31829c71ff0947d813aae1545f11`.
Migration startup uses an explicit session advisory lock with finite wait and
release/destroy behavior. Each migration commits separately, so a committed
prefix survives a later failure and cleanly resumes. Checksum drift and
unknown future history fail closed. Migration definitions are capped at 1,024,
the applied-ledger read is bounded to the active definition count plus one,
and a schema-ahead error retains only the first unknown identifier. Injected
testing definitions are bound consistently through startup and later status
reads. Application schema names reject `public`, `information_schema`, and
every PostgreSQL-reserved `pg_` prefix before pool construction.

## Hosted-real concurrency boundary

No local Docker, Podman, PostgreSQL service, or `psql` executable was available,
so no local real-server case was called passed. The definitive job is isolated
in hosted CI and requires sentinel `AI_DEV_OS_REQUIRE_POSTGRES_TESTS=1` plus a
complete exact numeric-loopback configuration. Without that exact sentinel the
two live suites skip; with it, missing, malformed, DNS, or non-loopback hosts
fail before any pool or child process.

The workflow pins:

`postgres:18.4-alpine3.24@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15`

to `127.0.0.1:5432`, fixed test-only credentials, no volume, and a 30-minute
job bound. The hosted tests are designed to prove:

- two migration-lock waiters plus committed-prefix failure/resume, checksum
  drift, and schema-ahead refusal;
- forced same-snapshot SERIALIZABLE conflict with exact retry classification;
- native disjoint `SKIP LOCKED` claims;
- event and outbox commit-order/keyset behavior under a held writer;
- finite lock timeout and backend-termination recovery/redaction;
- the complete shared persistence and physical application reopen contract;
- independent application connections and separate Node processes claiming
  distinct work; and
- a synchronized two-adapter write-skew race against one near-cap borrowed
  profile, where at most one reservation may commit.

Corrective source head `9281ee0b1cc397a5dff224601efb3be5862fa9db`
completed exact-head run `31450506575` successfully. The PostgreSQL job passed
the real server suite, application contract, and focused coverage; the full
dependency, Ubuntu, coverage, and Windows jobs also passed. Query-native
high-throughput team scheduling, remote deployment, tenant/RBAC administration,
TLS server operations, backups/restore, and destructive migrations remain
explicit nonclaims. Any future destructive migration remains backup-gated and
must be exercised on production-scale fixtures.

## Stage 18 acceptance matrix

`stage-18-development-acceptance-matrix.json` is schema-closed, rejects
duplicate IDs and broken/missing anchors, and separates development acceptance
from production admission. Every row binds authority, implementation, tests,
evidence, owner stage, blocking dimensions, and rationale.

At this published source checkpoint:

- `ADM-01`, `SCH-02`, `PER-02`, `PER-03`, and `EVD-01` are proven;
- prior Stage 18A–18C implementation rows remain proven by their published
  evidence;
- `ANT-02`, `AM-02`, and `INT-01` accurately remain incomplete; and
- `PRD-01` remains production-gated on Stage 17W.

Therefore `developmentAccepted` and `productionAdmitted` remain `false` and the
permitted outcome is exactly
`Stage 18D production-disabled checkpoint complete`. Broader Stage 18
development acceptance and every production claim remain blocked by the
separate incomplete/production-gated rows.

## Changed-file inventory

The candidate contains exactly 54 paths including this evidence file:

- `.github/workflows/ci.yml`
- `CONTRIBUTING.md`
- `README.md`
- `docs/adr/0024-stage-18d-postgres-admission-readiness.md`
- `docs/implementation-roadmap.md`
- `docs/product-direction.md`
- `docs/release-evidence/stage-18-development-acceptance-matrix.json`
- `docs/release-evidence/stage-18d-postgres-admission-readiness-checkpoint.md`
- `docs/technical-design.md`
- `package-lock.json`
- `packages/application/README.md`
- `packages/application/package.json`
- `packages/application/src/application-runtime.ts`
- `packages/application/src/index.ts`
- `packages/application/src/production-admission.ts`
- `packages/application/src/testing/index.ts`
- `packages/application/src/testing/runtime-contract.ts`
- `packages/application/test/fixtures/postgres-claim-worker.mjs`
- `packages/application/test/postgres-factory.test.ts`
- `packages/application/test/postgres-live-configuration.test.ts`
- `packages/application/test/postgres-live-configuration.ts`
- `packages/application/test/postgres-runtime-contract.test.ts`
- `packages/application/test/production-admission.test.ts`
- `packages/application/test/runtime-contract.test.ts`
- `packages/application/test/source-compatibility.test.ts`
- `packages/application/test/stage-18-acceptance-matrix.test.ts`
- `packages/application/test/static-policy.test.ts`
- `packages/application/test/type-fixtures/stage18c-consumer.ts`
- `packages/application/test/type-fixtures/tsconfig.json`
- `packages/persistence-postgres/README.md`
- `packages/persistence-postgres/package.json`
- `packages/persistence-postgres/src/driver-modules.d.ts`
- `packages/persistence-postgres/src/driver.ts`
- `packages/persistence-postgres/src/index.ts`
- `packages/persistence-postgres/src/migrations.ts`
- `packages/persistence-postgres/src/postgres-adapter.ts`
- `packages/persistence-postgres/src/testing.ts`
- `packages/persistence-postgres/test/contract.test.ts`
- `packages/persistence-postgres/test/driver.test.ts`
- `packages/persistence-postgres/test/fake-pool.ts`
- `packages/persistence-postgres/test/fixtures/import-with-force-native.mjs`
- `packages/persistence-postgres/test/live-harness.test.ts`
- `packages/persistence-postgres/test/live-harness.ts`
- `packages/persistence-postgres/test/postgres-adapter.test.ts`
- `packages/persistence-postgres/test/postgres-live.test.ts`
- `packages/persistence-postgres/test/static-policy.test.ts`
- `packages/persistence-postgres/tsconfig.json`
- `packages/persistence-postgres/vitest.config.ts`
- `packages/persistence/README.md`
- `packages/persistence/src/index.ts`
- `packages/persistence/src/migration.ts`
- `packages/persistence/src/testing/contract-suite.ts`
- `packages/scheduler/src/policy.ts`
- `packages/scheduler/test/routing-usage.test.ts`

Before this evidence file, the exact 53 path/SHA-256 rows sorted by path and
joined as `path<TAB>sha256` with LF have digest
`880357468bb56e3f1338a77fec30194fdc6f11c3cb69122f602c161c4bfc2536`.

## Validation evidence

Stage 18D database/application tests used deterministic seams, memory/SQLite,
or the capability-gated PostgreSQL harness. Existing workspace-wide packages
also exercised their ordinary task-owned temporary filesystem, subprocess, and
Git-fixture tests. No live/production Stage 18D workspace, Git, provider,
account, credential, UI, communications, or native-worker boundary was
invoked. Real native `better-sqlite3` file persistence did run in the
application contract; that is distinct from a native worker or the Stage 17
operation.

### Focused and affected-package gates

Current stable-tree results are:

- PostgreSQL: 92 passed, three expected live-service skips;
- application: 39 passed, one expected live-service skip;
- scheduler: 150/150 passed;
- persistence: 28/28 passed;
- persistence-memory: 44 passed, one existing conditional skip;
- persistence-sqlite: 92 passed, three existing conditional/platform skips;
- product planning: 45/45 passed;
- direct Anthropic provider: 113/113 passed;
- task graph: 52/52 passed; and
- process broker: 445 passed, one expected physical-platform skip.

Direct no-emit TypeScript checks passed for persistence, memory, SQLite,
PostgreSQL, scheduler, application, and product planning. The package test
lifecycle now builds the PostgreSQL/application package itself before any
fresh-process fixture imports ignored `dist`; ordinary `npm test` proved that
self-build path.

Two earlier root `npm run check` attempts were stopped after independent review
found source defects that invalidated the running tree. They are disclosed as
inconclusive/pre-fix, not passed. On the stable source-audited tree, literal
root `npm run check` exited 0 in 1,095.2 seconds and literal root
`npm run test:coverage` exited 0 in 557.1 seconds. All 37 package coverage
configurations met their configured thresholds.

### Focused coverage

| Package | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| PostgreSQL | 97.05% (461/475) | 87.81% (209/238) | 98.31% (117/119) | 97.17% (447/460) |
| application | 94.03% (142/151) | 88.88% (80/90) | 100% (25/25) | 94.48% (137/145) |
| scheduler | 91.07% (1,868/2,051) | 88.18% (1,567/1,777) | 97.08% (300/309) | 93.05% (1,783/1,916) |

Every package floor remains at least repository 90/80/90/90. The validation
wrappers left 37 ignored package-local `coverage` directories; they were not
deleted or added to the candidate.

### Mutation and targeted defect proofs

Stage 18C evidence already records discriminating mutation kills for duplicate
command identity, fencing mismatch, atomic-boundary failure, stale usage, both
borrowed caps, borrowed Fable prohibition, and production refusal.

Stage 18D additionally applied ten isolated mutants one at a time, required the
named focused test to fail, and restored with `apply_patch` before continuing:

1. removed the transaction-abort health probe;
2. replaced rollback with commit;
3. substituted a stored migration checksum;
4. assigned a forged fingerprint to malformed admission input;
5. made `assertAdmitted` return instead of refuse;
6. removed the unconditional Stage 17 scheduler rule;
7. raised the weekly borrowed cap by one basis point;
8. raised the work-hours five-hour cap by one basis point;
9. substituted the borrowed-Fable predicate; and
10. removed stale-usage refusal.

All ten were killed. Post-restoration focused suites passed, `git diff --check`
passed, and mutation-marker/value scans were empty. Final SHA-256 bindings are:

| Restored source | SHA-256 |
| --- | --- |
| `packages/persistence-postgres/src/postgres-adapter.ts` | `f483fec758f04f48d807d123924d71a2ee23f5e215faaa34d9491203e026bb4e` |
| `packages/persistence-postgres/src/migrations.ts` | `479ad338cfacfe40942a05f715f492d93287837ad9eb8b9cb806d0b7ab7783af` |
| `packages/application/src/production-admission.ts` | `2c6f6377d63b963ed9942f7a4aef8e978dfc2fa9c8088e8696c4976723e3d5da` |
| `packages/scheduler/src/policy.ts` | `e30c2a0bc10496b7a8c202ea60b137c970f57b1151409353103cc5e1416ee266` |
| `packages/scheduler/src/routing.ts` | `ea828381bc0dd102af8e1f230a64d0395642d514b8348202549d86a666602d2a` |
| `packages/scheduler/src/worker-runtime.ts` | `8fdd32f77371e624125f0d3c979c8268e663761f5be9dcb32c9513decded6f72` |

### Package, dependency, license, and consumer evidence

Exact dependency inspection currently reports:

- `npm ls --all --json`: zero problems, 41 top-level workspace/dependency
  entries;
- `npm audit --json`: 0 info/low/moderate/high/critical vulnerabilities across
  187 production, 22 development, 54 optional, 242 total records; and
- `npm audit --audit-level=high`: `found 0 vulnerabilities`.

The direct PostgreSQL runtime chain is permissively MIT/ISC licensed. `pg-int8`
and `split2` are ISC; the other reviewed runtime records are MIT. No package in
the new runtime chain has a preinstall/install/postinstall script.

Current dry runs are closed and bundle no dependency:

- PostgreSQL: 22 files, 25,745 packed bytes, 118,618 unpacked bytes, shasum
  `5fdbd28c6da7e49de60429e521c2810cd66b308a`; and
- application: 30 files, 21,812 packed bytes, 100,219 unpacked bytes, shasum
  `e7cee1b938b34d18361cab5f809c2377d979ec34`.

The task-owned fresh consumer was refreshed with final-tree tarballs for
domain, artifacts, persistence, and PostgreSQL. It installed with scripts
disabled, printed `fresh-consumer-ok` under `NODE_PG_FORCE_NATIVE=1`, passed
`npm ls --all` with only declared optional peers absent, and audited zero
vulnerabilities across 18 records. Its final PostgreSQL tarball SHA-256 is
`f4bd9cf30e3c659e4a0e90388bd8aa694ef4aca2b350fdfe2487f32e63dd1674`.
An intermediate refresh using the
consumer's older workspace-directory links passed runtime smoke but made
`npm ls` fail on first-party link resolution; it was not hidden or called a
pass. Replacing those links with the exact packed tarballs fixed the consumer
graph before the final successful run.

### Static, diff, and residue evidence

Current stable-tree scans report:

- `git diff --check`: exit 0, with informational LF-to-CRLF checkout notices;
- 53 candidate paths before this evidence file and no candidate under
  `coverage`/`dist` or with executable/library/source-map/database/archive/image
  extension;
- zero merge-conflict marker, private-key header, GitHub/OpenAI/Anthropic token
  pattern, Git lock, or in-progress Git operation;
- 37 package directories with manifests and 37 ignored package-local coverage
  directories; and
- no local container/runtime/service was started.

One task-owned fresh-consumer directory remains at
`C:\Users\mrali\AppData\Local\Temp\ai-dev-os-stage18d-consumer-20260811-0018`.
Its validated cleanup command was blocked by the product safety layer before
execution. It was not retried, rephrased, split, rerouted, or approximated, and
will not be deleted during this run. Previously preserved worktrees, evidence,
and ignored coverage directories remain untouched.

## Independent read-only review

Planck, an independent read-only GPT-5.6 Sol reviewer at Max effort, audited the
PostgreSQL SQL, migrations, driver boundary, locking, transaction/error paths,
package graph, hosted workflow, and real-test discrimination. It had no edit,
Git/GitHub, provider, account, credential, native-worker, UAC, or unrelated
authority. The static implementation verdict was PASS; subsystem admission
remains incomplete until the exact-head hosted PostgreSQL job is green.

Tesla, a separate read-only GPT-5.6 Sol reviewer at Max effort, audited the
full integration diff, public compatibility, application/admission boundary,
matrix/docs, tests, and evidence. Iterative findings included transaction and
migration semantics, stored-row identity, ambient/native driver selection,
timeouts and client errors, real concurrency discrimination, live-test opt-in,
clean-checkout builds, reserved schemas, loopback-only destructive tests,
receiver-independent admission, nested option projection, matrix anchors, and
documentation accuracy. Confirmed findings were repaired with focused
regressions. Its exhaustive stable-tree source/test/doc/package verdict was
PASS with no substantive blocker remaining.

No opposite-family reviewer is exposed in this environment. The two strongest
same-family independent reviewers and that limitation are disclosed rather
than relabelled. Reviewer cost/usage is unavailable.

## Commit, remote, and hosted CI

The exact 54-path source/evidence candidate was explicitly staged and committed
as `1a48adad511bd68184dd308a903c030d9320c6dc`, tree
`4c80114bc1f27c2b4c8b7d77a64c73993de91ceb`, parent
`aa5c62cc9aa56ac3a21e5fd612992b9ea535776d`. It was pushed non-forced; local,
upstream, and live remote were equal and the worktree was clean.

Exact-head run `31449225977` completed with an overall failure. Dependency
audit (10s), Ubuntu (7m20s), coverage (11m30s), and Windows (19m29s) passed.
The PostgreSQL job failed in 37s after 51/53 live tests passed: one deliberate
`SKIP LOCKED` overlap surfaced the adapter's documented retryable SERIALIZABLE
`40001` when the held transaction attempted to commit later, and one
corruption fixture constructed a display name containing a forbidden colon
before reaching storage. Neither
failure is hidden or called a pass. The focused correction explicitly handles
the surfaced caller retry and uses a valid fixture; its new commit/push and
exact-head hosted run are recorded below. The corrected live-test SHA-256 is
`8781312f07e7b717258e33022849ab1d3aef5a758b7c385384ea817b63b2a6f4`.

The correction was committed as
`9281ee0b1cc397a5dff224601efb3be5862fa9db`, tree
`c49243c506f0c9194efb4e1b8cca607e4c4939ac`, parent
`1a48adad511bd68184dd308a903c030d9320c6dc`, and pushed non-forced. Local,
upstream, and live remote were equal and the worktree was clean. Exact-head run
`31450506575` completed successfully: dependency audit 10s, PostgreSQL
integration 47s, Ubuntu 7m27s, coverage 10m22s, and Windows 19m5s. The
PostgreSQL job passed 53/53 live tests, the application contract, and focused
PostgreSQL coverage at the exact corrective head.

This evidence file and matrix are the only finalization delta after that green
source head. Their own unavoidable commit/tree/live-remote/run self-reference
is delegated to the final handoff; embedding those values here would change
the identity being reported. The finalization must still be an explicit-path,
non-forced evidence-only publication and exact-head green CI before handoff.

## Deferred work and nonclaims

- Stage 17W remains gated by the untouched separately safety-gated operation.
- The live Anthropic canary, supported live Account Manager reader, and
  external-effect crash/idempotency proof remain incomplete Stage 18 work.
- Query-native/high-throughput team scheduling, tenant/RBAC/deployment/TLS
  administration, backup/restore operations, destructive migrations, remote
  artifacts, vector search, daemon/API/UI/communications, Stage 19, Stage 20,
  and Linux/macOS product integration remain outside this checkpoint.
- No UAC/elevation, restricted operation, credential/session extraction, live
  provider/account request, live/production Stage 18D workspace/Git/
  native-worker execution, production activation/registration, PR merge,
  `main` mutation, tag, release, signing, package publication, public
  communication, or repository-setting change occurred.
- Ordinary builds, coverage, packaging, and task-owned tests performed their
  expected temporary filesystem, subprocess, and Git-fixture effects; existing
  SQLite contract validation performed native/file persistence. The Stage 17W
  feature branch was pushed non-forced and its exact-head CI was inspected as
  disclosed. No local PostgreSQL/container effect occurred.

The checkpoint label is exactly
`Stage 18D production-disabled checkpoint complete`. It does not claim Stage
17W completion, broader Stage 18 development acceptance, production admission,
or Stage 19 work.
