# Stage 20 Phase B C7 persistence-extension checkpoint

## Scope and publication boundary

This checkpoint closes only Stage 20 Phase B checkpoint C7. It extends the
generic persistence aggregate vocabulary for the C6 project spine, appends one
forward-only PostgreSQL migration, expands adapter and migration assurance,
records ADR 0041, and updates persistence documentation. It does not add C8
intake, C9 plan assembly, an application repository, a write route, a command,
approval or spending execution, emergency-stop behavior, session allocation,
desktop composition, project runtime behavior, or production activation.

The independently reviewed candidate is the complete staged tree described by
the terminal handoff. Recording that tree, its future commit identifier,
post-push remote equality, hosted-CI URL, or final external-review prompt inside
the same tree would be an impossible self-reference. The terminal handoff
therefore supplies those exact facts after review, commit, non-force push, and
exact-head CI. No earlier review PASS transfers to changed bytes.

## Exact entry identity

The sealed C6 input was verified before editing:

- source worktree:
  `C:\Users\mrali\Projects\ai-dev-os-stage20-project-contracts-20260829`;
- source branch: `feat/stage-20-project-contracts`;
- HEAD: `fd94ffba31d45e3ea75d12d5a2f417ba1538a29c`;
- tree: `54543b8bf70cbb72cab0dbe949c06d97ab45f242`;
- parent: `b331f1d8bb6edf094470522acd288aaa29916190`;
- upstream, tracking ref, local ref, and live remote equal to HEAD, with
  divergence `0/0`;
- clean index and worktree, with no Git operation or lock; and
- hosted CI run
  `https://github.com/alijabbar04/ai-development-os/actions/runs/33273314868`,
  attempt 1, bound to that exact HEAD with all seven jobs successful.

ADR 0040 and the C6 release evidence were present. `@ai-dev-os/project` had
zero runtime dependencies, its complete 71-test suite and packed-consumer gate
were green, and C6 had left the persistence aggregate union at exactly ten
members. The task resumed only in the intended isolated worktree
`C:\Users\mrali\Projects\ai-dev-os-stage20-c7-persistence-20260829` on branch
`feat/stage-20-c7-persistence-extension`, based exactly on the supplied C6
HEAD. The sealed C6 worktree remained clean and unchanged.

Stage 18 remained development-accepted and Stage 20A C0-C5 plus C6 remained
complete. Production remained disabled, `PLN-02` remained incomplete, and
`productionAdmitted=false`. The Stage 18 published-descendant verifier passed
with published HEAD `f90a779fce8c14cb6c4c3166ed89b0af5355b660`, published
tree `f4a0035c03150970f700435af64cd2bd4e0968e4`, source commit
`bd26bc1cf8238c23406fc5e0a63fed046c988136`, source tree
`9ef3a12c3434d3a838da02706413c9573f235aa5`, 45 files, and aggregate
SHA-256 `0cb4729cc4211dca11ef1f166ccd4340ad82db4ba50310c6b5e97244fcbd1d66`.

## Governing design and ADR reconciliation

The complete required repository surfaces, architecture dossier, and
experience-architecture reconciliation dossier were read before design. ADR
0041 records the resolution under the required priority order. The
architecture dossier's persistence decision was prospectively numbered 0038;
the live repository already used 0038-0040, so the next free actual number is
0041.

The architecture dossier supplied the original nine additions from
`project-brief` through `external-integration`. The reconciliation separately
accepted `project-stop` as the tenth. `ProjectStop` is project-scoped evidence;
it does not alter or implement the global emergency-stop boundary.

The exact final runtime inventory is:

1. `artifact-manifest`
2. `budget-account`
3. `evaluation-run`
4. `integration-run`
5. `project`
6. `product-plan`
7. `task-graph`
8. `task-run`
9. `telemetry-ledger`
10. `worker-run`
11. `project-brief`
12. `project-plan`
13. `agent-session`
14. `handover`
15. `approval-request`
16. `spending-request`
17. `notification`
18. `communication-thread`
19. `external-integration`
20. `project-stop`

The existing `project` discriminator maps to `Project`. The ten additions map
respectively to `ProjectBrief`, `ProjectPlan`, `Session`, `Handover`,
`ApprovalRequest`, `SpendingRequest`, `Notification`, `CommunicationThread`,
`ExternalIntegration`, and `ProjectStop`. Each receives an independent
optimistic-concurrency and journal lifetime because its revision or lifecycle
can change without rewriting the owning `Project` aggregate.

`PlanStage`, `Task`, `Dependency`, `Decision`, `UsageReservation`,
`EvidenceRecord`, `Deliverable`, `Blocker`, `Constraint`,
`ProjectHealthProjection`, and `ProjectSummaryProjection` remain embedded,
owned by an existing persistence domain, or derived. They do not receive C7
aggregate discriminators.

## Generic persistence and authority boundary

The shared persistence package continues to validate only aggregate type and
identity, schema and aggregate versions, canonical payload/checksum, event and
outbox contracts, optimistic concurrency, and migration history. It does not
import `@ai-dev-os/project`, parse project payload meaning, execute a project
state machine, or infer authority. `@ai-dev-os/project` remains the payload
owner and retains zero runtime dependencies.

C7 adds no application repository, runtime composition, provider, credential,
vault, Account Manager, Electron, child-process, shell, outbound network
client, listener, environment-selected migration, or caller-selected SQL.
Production capabilities and commands remain absent.

## Adapter and migration evidence

Memory already stores the public aggregate discriminator as generic validated
text, so it needs no physical migration. SQLite migration
`0001-initial-schema` already declares both aggregate-type columns as generic
`TEXT NOT NULL`; its runtime closed union supplies the invariant, so no SQLite
migration was invented. Its released runtime checksum remains
`22634a6fa46f0c27e4e5839357b114e449760cf4bca2648bbc0d50182eadd9ea`.

PostgreSQL physically constrains both aggregate and event tables. C7 appends
only `0004-project-persistence-aggregates`. Its static repository-owned SQL
drops and recreates the two named check constraints with the exact 20-member
vocabulary inside the existing advisory-locked, per-migration transaction. It
does not update or rewrite data.

The migration order and SHA-256 content checksums are pinned independently:

| Ordinal | Migration | SHA-256 |
| --- | --- | --- |
| 1 | `0001-initial-schema` | `34413d60368bc485b1cbdc088d5000baa4ce31829c71ff0947d813aae1545f11` |
| 2 | `0002-evaluation-run-aggregate` | `aeeee92ba9db56fb762e6f44dfcb782a840897582d3cc135d6b1cfb7a2e594a3` |
| 3 | `0003-integration-run-aggregate` | `595f8bea3d06baae44370aeeca5f1a21f57cadf55f2970fb20b054e9ad29c065` |
| 4 | `0004-project-persistence-aggregates` | `5de038634e296881ba4f258f5b784fe749117515e6758c6cde77818b3e1ce5aa` |

The first three released definitions were not edited, reordered, squashed, or
replaced. Static tests pin their prior checksums and exact prefix. Upgrade tests
start from every released prefix. Fresh, upgrade, concurrent-start, rollback,
corrected-resume, checksum-drift, history-gap, and schema-ahead cases retain
the existing finite refusal behavior. An injected failing `0004` leaves both
old ten-member constraints and the first-three migration history intact; a
corrected reopen applies the full fourth migration. Existing aggregate and
event rows are compared field-for-field before and after upgrade. The oracle
snapshots every physical column as exact text or null values, including
identity, type, schema/aggregate/event versions, payload text, checksum,
timestamps, trace/causation identifiers, and global sequence. Non-default
trace/causation fixtures and a planted trace rewrite prove the equality check
fails if a formerly omitted field changes.

Independent literal inventories check the TypeScript union and both physical
PostgreSQL constraints. A planted `project-stop` to `project-stopped` mutation
must make the parity oracle throw, proving the test is load-bearing.

## Contract parity and accepted-guarantee re-proof

For each of the ten additions, the reusable contract suite proves create at
version 1, duplicate conflict, exact get, conditional update, aggregate
checksum identity, stale and future-gap conflict, aggregate pagination,
type isolation, same-ID cross-type isolation, event append, per-aggregate and
per-type journal listing, global pagination, adapter-close refusal, and durable
reopen where supported. Tests own their expected discriminator literals rather
than importing the production inventory.

Local adapter results on the exact pre-review candidate were:

| Surface | Result |
| --- | --- |
| persistence core | 30/30 passed |
| memory | 54 passed, 1 capability skip |
| SQLite memory/file | 113 passed, 3 capability skips |
| PostgreSQL deterministic seam/unit | 103 passed, 3 hosted-only capability skips |

The complete shared suite ran through memory, SQLite, and the PostgreSQL seam.
SQLite exercised a real file close/reopen. No test was skipped because of a new
aggregate type. No local PostgreSQL capability was present: the repository's
`AI_DEV_OS_TEST_POSTGRES_*` variables were absent, and neither `psql` nor
Docker was installed. No database was installed and no live result is
fabricated. The existing hosted PostgreSQL CI job is therefore a required
exact-head publication gate and supplies the real-server proof in the terminal
handoff.

The real PostgreSQL suite continues to re-prove:

- `PER-02`: the complete shared contract plus physical application persistence
  and reopen behavior; and
- `PER-03`: advisory migration locking, independent `SERIALIZABLE`
  optimistic-conflict behavior, native `SKIP LOCKED` outbox claiming, finite
  lock timeout, commit-ordered sequence identity, redacted finite database
  failures, backend-loss recovery, and caller-owned retry with no hidden retry
  inside an adapter operation.

The fake seam preserves deterministic coverage of migration and adapter
failure branches; only hosted exact-head CI may close the real PostgreSQL part
of these claims.

## Validation evidence before publication

Lockfile-based dependency installation completed with 244 packages and no
lockfile change. Affected typechecks passed for persistence core, memory,
SQLite, and PostgreSQL. Focused coverage passed maintained thresholds:

| Package | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| persistence | 98.40% (185/188) | 97.87% (92/94) | 98.24% (56/57) | 98.37% (182/185) |
| memory | 99.58% | 92.52% | 100% | 99.57% |
| SQLite | 97.33% | 87.80% | 100% | 97.14% |
| PostgreSQL | 97.05% | 88.23% | 98.31% | 97.17% |

Root coverage completed successfully across every workspace. The final
workspace target passed 114/114 tests at 90.66% statements, 81.21% branches,
91.15% functions, and 92.63% lines. C6 compatibility remained green: all
71/71 `@ai-dev-os/project` tests passed, its coverage remained 91.44%
statements, 86.73% branches, 99.56% functions, and 95.81% lines, and its clean
packed consumer passed with 42 files and zero runtime dependencies. No project
source, contract, authority, projection, package manifest, or plan-sealing API
changed.

All direct persistence consumers passed: application 71 tests plus one
capability skip, evaluation 30/30, integrator 64/64, product planning 45/45,
scheduler 155/155, and telemetry ledger 54/54. Package dry runs and packed
consumers passed for persistence core, memory, SQLite, PostgreSQL, project,
application, and app-vault. The application consumer completed all 27 probes;
app-vault proved pure and filesystem behavior with manager/broker-only
production composition and no projected secret.

`npm audit --audit-level=high` reported zero vulnerabilities. The complete
dependency tree passed; missing packages were only declared optional
platform/browser packages. The Stage 18 descendant verifier passed. Static
production scans found no provider, project-runtime, secret, Electron,
child-process, network, listener, environment-selected migration, or
credential/vault capability in persistence source. New migration SQL is
static, and existing schema/table interpolation remains constrained to the
repository-owned validated identifier mechanism. Package and packed-consumer
checks found no credential or payload leakage. All 115 JSON files parsed
strictly. The nine changed Markdown files had balanced fences and 19 valid
inline or reference links. The exact 17-path inventory, leakage scan,
production-boundary scan, and `git diff --check` passed.

The pre-commit root `npm run check` passed root typecheck and the complete test
matrix, then returned exactly one build refusal:
`CANDIDATE_BINDING_WORKTREE_NOT_CLEAN` from the existing Stage 18
candidate-binding generator. That guard intentionally refuses any dirty
published-descendant worktree and has no bypass. It was not changed. After the
exact staged tree passes independent review, that tree is committed and the
full root gate is rerun on the clean commit before publication. The terminal
handoff reports the clean-tree result rather than projecting it in advance.

## Exact C7 changed inventory

The candidate is limited to these 17 paths:

- `docs/adr/0041-stage-20-c7-project-persistence-aggregate-extension.md`
- `docs/implementation-roadmap.md`
- `docs/product-direction.md`
- `docs/release-evidence/stage-20-c7-persistence-extension-checkpoint.md`
- `docs/technical-design.md`
- `packages/persistence-memory/README.md`
- `packages/persistence-postgres/README.md`
- `packages/persistence-postgres/src/migrations.ts`
- `packages/persistence-postgres/test/postgres-adapter.test.ts`
- `packages/persistence-postgres/test/postgres-live.test.ts`
- `packages/persistence-postgres/test/static-policy.test.ts`
- `packages/persistence-sqlite/README.md`
- `packages/persistence-sqlite/test/sqlite-specific.test.ts`
- `packages/persistence/README.md`
- `packages/persistence/src/records.ts`
- `packages/persistence/src/testing/contract-suite.ts`
- `packages/persistence/test/records-and-migrations.test.ts`

No CI workflow, package manifest, lockfile, project package, application
package, provider package, credential surface, desktop surface, or production
composition is changed.

## Independent review boundary

The initial independent reviewer examined exact staged tree
`604732a620b2c8f894854bd90ce482bdaad2ddad`. Its start and end state matched:
17 staged paths, zero unstaged, untracked, or unmerged paths, and a passing
cached diff check. The reviewer returned **FAIL with one must-fix finding**, so
that tree was not committed or published. The hosted every-prefix upgrade test
had compared payload, checksum, and timestamps but omitted other physical row
columns while this evidence called the check field-for-field.

The repair seeds non-default event trace and causation identifiers, snapshots
all ten aggregate and all fourteen event columns, requires exactly one row from
each table, compares the complete snapshots before and after upgrade, and
plants a trace rewrite that must fail the same equality oracle. Documentation
now describes that exact proof. The reviewer found no other must-fix issue and
recorded no advisory, but its FAIL does not imply a repaired-tree PASS.

C7 still requires a fresh independent read-only review of the new exact staged
tree. The review must cover aggregate mapping and `project-stop`, prior-
migration immutability, PostgreSQL parity and SQL, concurrent migration safety,
rollback/resume, adapter parity, `PER-02`/`PER-03`, redaction, finite failures,
test independence and positive controls, evidence accuracy, and absence of
application/runtime authority. Any further must-fix finding requires another
repair and fresh exact-byte re-review; a PASS cannot transfer to changed bytes.

No review PASS is claimed in this pre-review evidence file. The terminal
handoff records reviewer identity, exact reviewed tree, start/end cleanliness,
verdict, and advisories. It also records the path and identity of the targeted
external Opus persistence-review prompt prepared for the final published HEAD.
Fable review is not required for this backend-only checkpoint.

## Resource discipline and nonclaims

Drive C free space at entry was 103,643,447,296 bytes. Task validation reused
the existing worktree and package caches. No repository copy, machine install,
database install, unrelated worktree deletion, or rerouted safety-blocked
cleanup occurred. Final free space and the exact remaining generated residue,
task process, listener, and test-schema observations are supplied in the
terminal handoff after publication.

No real project record was written outside test-owned stores. No task, agent,
provider, credential, vault, Account Manager, external communication,
purchase, listener, desktop host, or production action occurred. No PR, merge,
rebase, force-push, tag, release, C8, C9, Stage 20B, or Stage 21 work occurred.
Stage 20 as a whole is not claimed complete. Production remains disabled,
`PLN-02` remains incomplete, and `productionAdmitted=false`.

The smallest safe next action after successful exact-head C7 publication is a
separately authorized C8 intake checkpoint. It is not part of this task and
must not begin in this session.
