# Stage 18C durable runtime and usage-adapter checkpoint evidence

Status: independently reviewed production-disabled source checkpoint with
exact-head source CI green; evidence-finalization publication pending
Evidence window: 2026-08-10 10:04 BST onward
Branch: `feat/stage-18c-durable-runtime-usage-adapter`

## Outcome boundary

This candidate adds the Windows-local, production-disabled application/runtime
composition, a versioned read-only usage-snapshot boundary, and a commit-pinned
static AI Account Manager investigation. It does not activate production,
complete Stage 17, complete all of Stage 18, or begin Stage 19.

Stage 17W remains gated by the exact separately safety-gated Stage 17W native
stateful operation. That operation was not invoked, inspected, modified,
reproduced, described, rerouted, retried, approximated, or bypassed during
Stage 18C work.

## Canonical dependency chain and worktree state

The Stage 18C branch was created directly from the clean, published Stage 18B
head:

- base commit: `b4b0e00d19245e5e4976407d445982f6c183dafc`;
- base tree: `df8f6b94a6661c87f2e0a75b5d246f5aa9814b64`;
- exact-head Stage 18B CI: run `31354345397`, with dependency audit, Ubuntu
  check, coverage, and Windows check passed; and
- branch: `feat/stage-18c-durable-runtime-usage-adapter`.

There was no pull, merge, rebase, reset, history rewrite, destructive checkout,
or deletion of an existing branch, commit, worktree, tag, evidence artifact, or
ignored coverage directory.

The separately preserved Stage 17W work remains on
`feat/stage-17w-complete` at local reviewed head
`f310f7db173cd55b37be5971af2b8c02462f1988`, tree
`7d5e38d3315c162839965809731f0dacbdedfbab`, two focused commits ahead of its
remote. Its task-owned operator, independent-build, and reproduction worktrees
remain present and Git-visible clean. Stage 18C does not merge that later Stage
17W work into the already published Stage 18 dependency line.

## Architecture and ownership

ADR 0023 records a modular-monolith composition:

- `@ai-dev-os/scheduler` remains the sole owner of durable ready work,
  attempts, leases, fencing, retries, backoff, capacity, fairness, deadlines,
  usage intents, dispatch identity, terminal reconciliation, and replay;
- `@ai-dev-os/application` composes that runtime with an explicit persistence
  adapter or explicit absolute Windows-local SQLite path;
- the existing `@ai-dev-os/persistence` transaction/event-journal boundary is
  the only persistence framework; and
- the existing route candidate, routing policy, task budget, normalized usage,
  circuit, and provider/profile identity contracts remain authoritative.

No second scheduler, task graph, usage ledger, provider registry, workspace or
Git boundary, policy broker, persistence framework, API, daemon, UI, messaging
adapter, PostgreSQL substitute, or Stage 19 behavior is added.

The application exposes a schema-closed typed dispatcher for the versioned
worker commands. Unknown, null, or extra-field input fails with a finite error.
That dispatcher is an internal seam for a later Stage 20 boundary, not an HTTP,
IPC, service, or ambient command surface.

Both production flags are literal `false`. Public refusal covers provider,
workspace, Git, network, native-worker, credential, and production-registration
effects. The Windows-local constructor performs the explicitly supplied native
SQLite/file persistence effect; it discovers no account, provider, credential,
workspace, repository, executable, or user directory. No live executor or live
usage reader is bundled. Caller-injected executable ports remain trusted input
and are not claimed to be sandboxed or effect-free.

## Durable worker state and exact replay

One immutable work definition binds the stable task/envelope identity, exact
normalized route candidate, capacity pool and fairness key, ready/deadline
times, retry policy, estimated usage, and task budget. Unknown estimated cost
or an estimate already beyond a task budget is rejected at admission.

The persisted state machine is:

| State | Meaning | Normal successor classes |
| --- | --- | --- |
| `ready` | durably queued and eligible for a bounded claim | lease or deadline cancellation |
| `leased` | one attempt owns the current monotonically fenced lease | renewal, usage reservation, retry/failure, cancellation, or expiry |
| `running` | the exact prepared dispatch was durably marked started | completion, failure, cancellation, expiry, or reconciliation requirement |
| `retry-wait` | the previous attempt is terminalized and awaits exact backoff | ready or deadline cancellation |
| `completed` | terminal success with exact cumulative usage | none |
| `failed` | terminal finite failure | reconciliation only when explicitly required |
| `cancelled` | terminal cancellation | reconciliation only when explicitly required |

Commands/events are closed bounded JSON objects. Every event retains its exact
canonical command projection. Replay checks schema/version, contiguous
sequence and time, event and command identity uniqueness, deterministic
scheduler-owned IDs, exact command-legal transition, aggregate envelope,
configuration/adapter binding, full journal, and byte-equivalent checkpoint.
The new closed persistence discriminator is `worker-run`; Stage 18A retains
`task-run`, so unrelated orchestration history cannot defeat the worker
retention bound.

`maximumQueueDepth` bounds nonterminal queue admission and
`maximumRetainedWorkItems` bounds all worker aggregates, including terminal
history, to a configured 1–10,000. Each aggregate also has at most eight
attempts and a bounded renewal count. No compaction is claimed or implemented.

Claim ordering uses effective priority with wait-only aging, prior fairness-key
attempts, the current `readySince`, stable fairness key, and work identity.
Retries reset `readySince`; time leased/running/backing off does not manufacture
queue age. Claims and global capacity decisions run in one short persistence
transaction under both memory and SQLite adapters.

Lease IDs bind definition, worker, attempt, fence, and command identity. Every
mutation rechecks the exact lease, worker, fencing token, expiry, and deadline.
Started lease expiry becomes reconciliation-required and is never silently
redispatched. Scheduler-owned tick events use a reserved deterministic command
namespace that public commands cannot claim.

Attempt usage is added exactly once into bounded cumulative usage across
retries and restart. Unknown cost from any started attempt cannot be erased by
a later attempt. Completion with an unknown cumulative cost becomes
`usage-cost-unknown`; completion beyond a token/tool/cost budget becomes
`usage-budget-exceeded`. Replay derives the same outcome and branch order.

## Usage, circuit, and cross-work capacity evidence

Reservation, preparation, and start use the same two-phase fail-closed pattern:

1. load and fence the exact attempt;
2. reject static route, availability, capability, authorization, model,
   borrowed-policy, and candidate-health failures before invoking the reader;
3. require the live adapter identity/schema to match the persisted native-v2
   binding before invoking it;
4. validate finite closed-circuit evidence;
5. perform a bounded abortable scoped usage read without holding a persistence
   transaction;
6. apply the complete existing hard routing and usage policy;
7. open a short transaction, reload the state/fence and persistence-wide
   liability ledger, and revalidate at the commit clock; and
8. append the exact state and event atomically.

Exact duplicate reserve/prepare commands return the durable prior result before
another external read, even after lease expiry. Invalid-state commands also
fail before a read. Close prevents new reads, aborts registered reads, and late
results cannot write.

Reservations persist source adapter version/fingerprint, profile/provider and
ownership, observation, five-hour and weekly window IDs/reset/use, predicted
increments, estimated usage, and complete circuit evidence. Preparation and
start require refreshed native-v2 evidence, nondecreasing usage/circuit
observations, stable source/circuit identity, and exact route scope. Dispatch
request fingerprints hash the complete normalized usage and circuit evidence,
not caller-declared IDs alone.

Borrowed capacity is audited persistence-wide in exact
`EventRecord.globalSequence` order. Every reserve, prepare, start, release, and
reconciliation observation is preserved. Ownership is stable per adapter,
schema, provider, and profile; window rollover requires monotonic authoritative
evidence and cannot be claimed before the prior reset. The audit is linear in
bounded retained worker evidence rather than an all-pairs scan.

Every active or reconciliation-required prediction remains chargeable across
window rollover. Reconciled usage cannot by itself prove provider basis-point
accounting has caught up: it remains charged to the origin window through its
reset, or, when reconciliation occurs after that reset, remains unassigned
until the next authoritative observation binds it to the successor window
through that reset. Only a reservation released before dispatch drops
immediately. This closes serial, concurrent, reset-boundary, equal-clock,
lagging-provider, and restart oversubscription paths.

The borrowed-profile rules remain:

- `Europe/London`, calendar/DST safe;
- weekday work interval `[09:00, 17:00)`;
- during that interval, refuse at 50% five-hour use or any predicted crossing;
- at all times, refuse at 70% weekly use or any predicted crossing;
- landing exactly on a ceiling from below is allowed, while beginning another
  task at the ceiling is not;
- explicit authorized Claude Code task and allowed-model decisions are
  required; and
- borrowed profiles never serve Fable work.

No score, cost preference, fallback, health value, or exhaustion state can
revive an ineligible candidate.

## Usage snapshot compatibility and provenance

Native schema v2 adds stable source fingerprint/class, compatibility,
authorization/revocation, `freshUntil`, and stable five-hour/weekly window IDs
while retaining opaque profile/provider scope, ownership, basis points,
reset/observation times, timezone, confidence, and authority.

Schema-v1 snapshots and the former public `CanonicalUsageSnapshot` and
`UsageWindowSnapshot` construction shapes remain source-readable through an
input union and deterministic migration. Because v1 lacks the required source,
authorization, revocation, window-identity, and freshness evidence, migration
marks it audit-only and it can never authorize a dispatch. A v1 adapter or a
live adapter identity/schema drift is rejected before its callback runs.

## Commit-pinned AI Account Manager investigation

The static investigation pins:

- repository: `https://github.com/alijabbar04/ai-account-manager.git`;
- branch: `main`;
- commit: `99be1cc6fa0fbbcfffcb4b7042d9bf0bf5ae0ae0`;
- tree: `49eb2f93f3012836b9a88ac705de8a9df1e8646f`;
- declared runtime version: `1.4.1`;
- tracked files: 23, with no submodules, LFS pointers, or tag at the commit; and
- path/size/SHA-256 inventory digest:
  `1898a7fdbe6236828d6bfac7b6064e94fe65a3859d56ae5fff86061906f129ff`.

The clone was inspected read-only outside this repository. No dependency was
installed; no source was modified; and no application, setup, build, test,
Electron runtime, UI, credential/session path, Codex process, or provider
endpoint was executed. Both PDF pages were extracted, rendered, and visually
checked as static documentation.

The MIT-licensed upstream exposes only internal Electron IPC, local JSON,
credential/OAuth/provider paths, provider API-key analytics, or a spawned
signed-in Codex App Server—not a supported versioned external read-only
library/API/export. Its root has no lockfile and its reviewed checkout contains
compiled runtime rather than the original source tree described by comments.
Stage 18C copies no upstream code. The investigation records exact source-line
and stable-symbol anchors for Claude credential/usage handling, Codex RPC,
poll/focus cadence, local encrypted state/history, provider analytics, and
preload/IPC surfaces.

`createAccountManagerFixtureUsageAdapter` therefore accepts only one explicit
fixture callback and one opaque scoped profile observation. It validates the
pinned upstream identity, provider/profile/ownership/authorization/revocation,
authority, timezone, freshness, and complete windows. Missing, duplicate,
partial, malformed, negative, contradictory, cross-profile, or source-drift
data fails with finite redacted errors. `ACCOUNT_MANAGER_LIVE_ACCESS_ENABLED`
is literal `false`. The `fixtureOnly: true` marker is an asserted protocol
field, not a sandbox; injected callbacks remain caller-trusted.

The reviewer independently recomputed all 23 inventory rows to the declared
digest.

## Changed-file inventory

The candidate contains exactly 38 reviewed paths including this evidence file:

- `README.md`
- `docs/adr/0023-stage-18c-durable-runtime-usage-adapter.md`
- `docs/implementation-roadmap.md`
- `docs/investigations/ai-account-manager-99be1cc-static-usage-integration.md`
- `docs/release-evidence/stage-18c-durable-runtime-usage-adapter-checkpoint.md`
- `package-lock.json`
- `packages/application/README.md`
- `packages/application/package.json`
- `packages/application/tsconfig.json`
- `packages/application/vitest.config.ts`
- `packages/application/src/account-manager-usage.ts`
- `packages/application/src/application-runtime.ts`
- `packages/application/src/errors.ts`
- `packages/application/src/index.ts`
- `packages/application/src/testing/index.ts`
- `packages/application/src/testing/runtime-contract.ts`
- `packages/application/test/account-manager-usage.test.ts`
- `packages/application/test/runtime-contract.test.ts`
- `packages/application/test/static-policy.test.ts`
- `packages/persistence/README.md`
- `packages/persistence/src/records.ts`
- `packages/persistence/test/records-and-migrations.test.ts`
- `packages/product-planning/test/scheduler-integration.test.ts`
- `packages/scheduler/README.md`
- `packages/scheduler/src/errors.ts`
- `packages/scheduler/src/index.ts`
- `packages/scheduler/src/routing.ts`
- `packages/scheduler/src/scheduler.ts`
- `packages/scheduler/src/store.ts`
- `packages/scheduler/src/usage.ts`
- `packages/scheduler/src/worker-runtime-codes.ts`
- `packages/scheduler/src/worker-runtime-command.ts`
- `packages/scheduler/src/worker-runtime-state.ts`
- `packages/scheduler/src/worker-runtime-types.ts`
- `packages/scheduler/src/worker-runtime.ts`
- `packages/scheduler/test/fixtures.ts`
- `packages/scheduler/test/routing-usage.test.ts`
- `packages/scheduler/test/worker-runtime.test.ts`

## Validation evidence

All commands ran from the repository, named package, or disclosed task-owned
temporary consumer directory. Automated tests used deterministic fixtures and
the memory/SQLite persistence adapters. They did not use a live provider,
account, credential, Account Manager UI/runtime, workspace, Git mutation, or
native worker. The application contract and fresh consumer did exercise the
existing `better-sqlite3` native/file persistence path.

### Focused and affected-package gates

- `packages/scheduler`: 149/149 tests passed.
- `packages/application`: 18/18 tests passed.
- `packages/persistence`: 28/28 tests passed.
- `packages/persistence-memory`: 43 passed, one existing conditional skip.
- `packages/persistence-sqlite`: 90 passed, three existing conditional/platform
  skips.
- `packages/product-planning`: 45/45 tests passed, including the updated
  scheduler consumer seam.
- Direct no-emit TypeScript checks passed for scheduler, application, and all
  affected parents; root typecheck passed in 360.1 seconds.
- Root test passed in 598.3 seconds: 3,059 passed and 25 intentional
  conditional/platform skips, 3,084 runtime results total. Stage 18C added no
  skip/only directive and changed no existing skip classification.
- Root build passed in 292.9 seconds.
- The exact separate typecheck/test/build sequence passed in 1,251.3 seconds.

- Definitive final-tree `npm run check`: PASS, exit 0, 1,193.5 seconds. It ran
  the literal root wrapper over all workspaces and completed root typecheck,
  test, and build. This result is measured independently from, and agrees with,
  the earlier separate component sequence.

### Concurrency, replay, and restart repetition

The worker suite contains fixed seeds
`3, 17, 29, 41, 53, 67, 79, 97, 109, 127`. A focused gate repeated five
times and passed all 20 selected test executions: the ten-seed concurrent
capacity property, concurrent borrowed SQLite reservations, close-versus-read
preflight, and cancellation/deadline races. This is 50 fixed-seed claim
iterations plus 15 additional race/reopen executions. Each run passed four
tests; the 55 other tests were filter-excluded, not skipped. Per-run durations
were 1.70, 1.76, 1.69, 1.70, and 1.78 seconds.

The complete worker suite passed 59/59. It also covers exact duplicate and
conflicting delivery, reorder/tamper replay, lease renew/expire, stale fences,
split brain, retry exhaustion, tick lost races, every persistence-boundary
fault, restart, real SQLite close/reopen at reserved/prepared/started/pending/
reconciled/retry-cancel boundaries, no redispatch, usage-read timeout/close,
capacity retention, circuit changes, and borrowed-cap rollover.

### Coverage

Definitive root `npm run test:coverage`: PASS, exit 0, 656.9 seconds. All 36
workspace package thresholds and the repository 90/80/90/90 floors passed.
Combined `coverage-summary.json` totals were:

- statements: 93.3044% (24,331/26,077);
- branches: 86.7294% (16,685/19,238);
- functions: 97.6701% (4,737/4,850); and
- lines: 94.6133% (22,043/23,298).

Load-bearing affected package totals were:

| Package | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| application | 93.06% (94/101) | 87.50% (56/64) | 100% (15/15) | 93.81% (91/97) |
| scheduler | 91.07% (1,867/2,050) | 88.20% (1,571/1,781) | 97.08% (300/309) | 93.05% (1,782/1,915) |
| persistence | 98.92% (184/186) | 98.88% (89/90) | 98.27% (57/58) | 98.90% (181/183) |
| persistence-memory | 99.59% (241/242) | 92.52% (99/107) | 100% (76/76) | 99.58% (235/236) |
| persistence-sqlite | 97.00% (291/300) | 86.99% (107/123) | 100% (99/99) | 96.79% (271/280) |
| product-planning | 90.74% (1,176/1,296) | 83.88% (817/974) | 95.65% (308/322) | 92.60% (1,014/1,095) |

The wrapper produced 36 ignored package-local `coverage` directories. They
remain untracked and untouched; no cleanup was attempted against them.

### Mutation and targeted defect proofs

Eight isolated mutants were applied one at a time to the final source family,
their named focused test was required to fail, and the exact original file was
restored before continuing:

1. duplicate command-fingerprint conflict incorrectly returned the prior
   result;
2. fencing-token mismatch was ignored;
3. the injected atomic-boundary fault was suppressed;
4. stale usage age was accepted;
5. the weekly borrowed ceiling was disabled;
6. the work-hours five-hour ceiling was disabled;
7. borrowed Fable prohibition was disabled; and
8. the application production flag was enabled.

All eight mutants were killed. The exactly restored focused selection passed
8 tests with 99 filter exclusions. A post-restoration residue scan was empty.
Final source hashes are:

- worker runtime:
  `8fdd32f77371e624125f0d3c979c8268e663761f5be9dcb32c9513decded6f72`;
- worker replay/state:
  `2c4014a103b28daa650c4b9f32faf544efb1256030b16e70c95fdb8dea2ed6ec`;
- usage contracts:
  `6309cb9cf516b79cd6ef53eda5c4cb9aa7e66517f6f99c888f389482643f7725`;
- routing:
  `ea828381bc0dd102af8e1f230a64d0395642d514b8348202549d86a666602d2a`;
- application composition:
  `d8ac99cb8be294d82036c4e7ed8223e9ead8cf86cd0430f362346ae855abf20b`;
- worker tests:
  `25f40e8c025db5624a5de686724e9de175bc2910736716a29b56c6c1f4e19254`.

### Package, dependency, license, and consumer evidence

`npm install --ignore-scripts` repaired only the missing first-party application
workspace link. The lockfile diff is 25 additive lines: the application
workspace record/link and its four existing first-party edges. No external
package, version, integrity, registry source, SDK, or install script was added.
Subsequent `npm ls --all --json` passed with zero problems.

Both audit forms passed:

- `npm audit --json`: info 0, low 0, moderate 0, high 0, critical 0; and
- `npm audit --audit-level=high`: `found 0 vulnerabilities`.

Package dry runs passed with no bundled dependency and no source, test,
coverage, native binary, database, or archive leakage:

- application: 26 files, 17,758 packed bytes, 81,626 unpacked bytes;
- scheduler: 78 files, 104,297 packed bytes, 604,059 unpacked bytes; and
- persistence: 46 files, 37,621 packed bytes, 181,896 unpacked bytes.

A fresh task-owned consumer installed six current tarballs—application,
artifacts, domain, persistence, persistence-sqlite, and scheduler—plus the
existing runtime closure. It passed:

- strict NodeNext TypeScript compile using the old public v1
  `CanonicalUsageSnapshot` and `UsageWindowSnapshot` construction shapes;
- `npm ls --all`, with only declared optional Vitest peers absent;
- `npm audit --json`, 0 vulnerabilities across 44 installed dependency
  records; and
- runtime import, v1 migration (`migrated-v1`), literal-false application and
  Account Manager flags, finite provider refusal (`PRODUCTION_DISABLED`), real
  SQLite open/close, and exact temporary database removal.

The install used existing `better-sqlite3@12.11.1` (MIT), whose reviewed install
script is `prebuild-install || node-gyp rebuild --release`; the prebuilt native
path succeeded. Across the 38 external installed package records every package
had a recognized MIT, ISC, Apache-2.0, BSD, or declared SPDX-alternative
license. The six first-party package manifests do not add license fields. No
new external dependency was introduced by this checkpoint. The only install
warning was that transitive `prebuild-install@7.1.3` is deprecated.

The validated recursive removal of the task-owned fresh-consumer directory was
blocked by the product safety layer before execution. It was not retried,
rephrased, split, or rerouted. The disclosed external temp directory remains at
`C:\Users\mrali\AppData\Local\Temp\ai-dev-os-stage18c-consumer-71f2c9a5`;
its runtime database had already been removed by the consumer itself.

### Static, diff, and residue evidence

- `git diff --check`: PASS; only informational LF-to-CRLF checkout notices were
  emitted for already tracked text files.
- The candidate inventory contained 37 paths before this evidence file and 38
  after it. It contains no generated executable, library, source map, database,
  archive, image, package output, or coverage report.
- Path-only scans found no private-key, Anthropic/OpenAI/GitHub/Google/Slack
  token pattern, merge-conflict marker, or test skip/only directive.
- No coverage floor, threshold, workflow gate, or existing exclusion was
  lowered. The new application coverage configuration uses the repository
  90/80/90/90 floors and excludes only its barrel and explicit testing subpath.
- The application static-policy test recursively scans production TypeScript
  while excluding only `src/testing/**`; it found no ambient process, network,
  browser, credential, environment-secret, Electron, live-account, or dynamic
  execution authority.
- No Git operation or lock is in progress, and no task-owned Node/npm/test/
  compiler process remains.
- The repository now contains 36 package directories with manifests; the root
  README records 36 rather than the previously stale count.
- No raw provider body, credential, cookie, token, session, email/profile PII,
  hidden reasoning, unrelated file, unsupported UI/communications path,
  Linux/macOS product integration, or Stage 19 implementation was added.

## Independent read-only review

Tesla, an independent read-only GPT-5.6 Sol reviewer at Max effort, reviewed
the exact base and complete uncommitted source, tests, docs, package graph,
public compatibility, persistence/replay, state machine, route/usage/circuit
policy, SQLite reopen contract, Account Manager evidence, and production/
authority boundaries. It had no edit, Git/GitHub, account, provider,
credential, native-worker, UAC, or unrelated-system authority. Reported
cost/usage was unavailable. No opposite-family reviewer is exposed by this
tool environment, so the independent same-family limitation is disclosed and
not relabelled.

Iterative review initially found substantive defects in cumulative retry usage,
physical SQLite reopen coverage, cross-work reservation caps, persisted adapter
schema and aggregate identity, v1 source compatibility, application command
parsing/construction cleanup, wait-only fairness, bounded usage reads, injected
callback nonclaims, exact terminal outcomes, internal failure/command
namespaces, tick races and identities, dispatch terminal evidence, and
pre-dispatch usage semantics.

Deeper capacity/replay review found and repaired usage/circuit provenance and
fingerprints, duplicate-before-read ordering, candidate-health substitution,
circuit downgrade, global observation sequence, equal-clock ordering, bounded
retained history, the separate `worker-run` aggregate type, preparation/start
revalidation, ownership/window rollover, lagging-provider accounting, active
liability across reset, and reconciliation after reset. The final pre-read
adapter-binding finding was repaired and its v1/identity/schema zero-read
regressions passed. The reviewer has completed a fresh source audit with no
remaining substantive source finding.

The final exact-state reconciliation independently matched the branch/base,
all 38 paths, working-tree inventory, evidence and six restoration hashes,
literal root-check result, clean diff, and absence of a Git lock. The reviewer
returned explicit **PASS** with no blocking or substantive finding remaining.
Focused commit/push and exact-head hosted CI remain separate publication gates
and are not claimed prematurely.

## Commit, remote, and hosted CI

Only the 38 reviewed paths above were staged explicitly. The focused source
checkpoint is commit
`654f0995fb683b611e890ffd0cb1c63125923940`, tree
`3b185543a8957ba4d3abfad9571b7742ef61adfe`, with exact parent
`b4b0e00d19245e5e4976407d445982f6c183dafc`. It was pushed non-forced to
`origin/feat/stage-18c-durable-runtime-usage-adapter`; local, upstream, and
remote all resolved to that SHA with a clean Git-visible worktree.

Exact-head [CI run 31406836621](https://github.com/alijabbar04/ai-development-os/actions/runs/31406836621)
completed successfully for the source checkpoint:

- dependency audit: PASS in 11 seconds;
- Ubuntu check: PASS in 437 seconds;
- coverage: PASS in 681 seconds; and
- Windows check: PASS in 1,316 seconds.

This commit/CI evidence is being finalized in one evidence-only follow-up.
Because a commit cannot record its own SHA or a future hosted run, the final
handoff records the evidence-finalization SHA/tree, exact local/upstream/remote
equality, cleanliness, and its required second four-job exact-head CI result.
No amend, rebase, force-push, merge, tag, signing, release, or repository-setting
change is used.

## Deferred work and nonclaims

- Stage 17W remains gated by the exact separately safety-gated Stage 17W native
  stateful operation. Stage 18C does not satisfy or bypass it.
- Stage 18 still requires real PostgreSQL contract parity, final Stage 17
  dependency integration, production-admission wiring, and the complete Stage
  18 acceptance audit.
- Stage 19 evaluation/integration, Stage 20 API/daemon, desktop UI,
  communications, live Account Manager/account/provider integration, and
  Linux/macOS product paths remain outside this checkpoint.
- No UAC, restricted Stage 17 operation, live account/provider/credential use,
  account mutation, provider request, UI scraping, browser automation,
  workspace/Git/native-worker execution, external communication, production
  activation, PR, merge, rebase, force-push, tag, release, signing,
  publication, production registration, or repository-setting change
  occurred.
- Real native SQLite/file persistence did run in package/contract/consumer
  validation; it is deliberately excluded from the native-worker nonclaim.

The label `Stage 18C production-disabled checkpoint complete` is reserved until
the pending explicit commit, non-forced push, independent final PASS, and exact-
head four-job hosted CI proof are all present.
