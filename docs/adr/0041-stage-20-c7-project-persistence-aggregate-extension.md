# ADR 0041: Stage 20 C7 project persistence aggregate extension

- Status: Accepted for Stage 20 Phase B checkpoint C7
- Date: 2026-08-29
- Governing parents: ADR 0038 and ADR 0040
- Exact prerequisite: C6 commit
  `fd94ffba31d45e3ea75d12d5a2f417ba1538a29c`, tree
  `54543b8bf70cbb72cab0dbe949c06d97ab45f242`
- Supersedes no released migration or project contract

## Context

ADR 0040 established the pure canonical project spine without persistence.
The architecture dossier had prospectively labelled its persistence decision
ADR 0038, but the live repository assigned 0038 to the Stage 20 subdivision,
0039 to the read-only control-service boundary, and 0040 to C6. The next free
repository number is therefore 0041. This ADR is the repository realization
of that prospective persistence decision.

C7 must give independently changing project records their own optimistic-
concurrency and event-journal lifetimes without teaching the generic
persistence layer what their payloads mean. It must preserve every released
migration byte, remain production-disabled, and add no application command,
write route, state-machine execution, process, provider, credential, or project
runtime behavior.

## Decision

Retain the existing ten-member `AGGREGATE_TYPES` prefix. The architecture
dossier proposed the first nine additions, from `project-brief` through
`external-integration`; the reconciliation dossier separately accepted
`project-stop` as the tenth. Append exactly those ten project-owned
discriminators:

| Aggregate type | C6 owner | Independent lifetime |
| --- | --- | --- |
| `project-brief` | `ProjectBrief` | Immutable brief revisions and supersession |
| `project-plan` | `ProjectPlan` | Sealing, revision, and optimistic update history |
| `agent-session` | `Session` | Provider-session lifecycle observations |
| `handover` | `Handover` | Assembly, acknowledgement, expiry, and supersession |
| `approval-request` | `ApprovalRequest` | Decision, consumption, expiry, void, and revocation history |
| `spending-request` | `SpendingRequest` | Quote and operator-reported reconciliation history |
| `notification` | `Notification` | Durable notification and delivery state |
| `communication-thread` | `CommunicationThread` | Durable typed message/audit references |
| `external-integration` | `ExternalIntegration` | Configuration, revocation, and verification binding |
| `project-stop` | `ProjectStop` | Project-scoped engage/resume evidence |

The existing `project` discriminator continues to own `Project`. The complete
closed runtime union now has exactly 20 members.

Do not add aggregate types for `PlanStage`, `Task`, `Dependency`, `Decision`,
`UsageReservation`, `EvidenceRecord`, `Deliverable`, `Blocker`, `Constraint`,
`ProjectHealthProjection`, or `ProjectSummaryProjection`. They are embedded in
their owning aggregate, owned by an existing persistence domain, or derived as
recorded by ADR 0040. In particular, projections are not durable command
sources, and the global emergency stop remains distinct from `ProjectStop`.

### Generic boundary

`@ai-dev-os/persistence` validates the discriminator, identity, versions,
canonical payload and checksum, event/outbox records, optimistic concurrency,
and migration history. It does not import `@ai-dev-os/project`, call a project
parser, execute a project state table, or infer authority. Project payload
meaning remains exclusively owned by `@ai-dev-os/project`, which stays
byte-compatible and retains zero runtime dependencies.

No repository, application composition, command, route, listener, scheduler,
session allocator, approval consumer, spending executor, or stop executor is
introduced by C7.

### Adapter and migration impact

- The memory adapter already indexes generic validated aggregate text. It
  requires no physical schema change.
- SQLite migration `0001-initial-schema` already stores `aggregate_type` as
  generic `TEXT NOT NULL` in both aggregate and event tables. Runtime validation
  supplies the closed union, so inventing a SQLite migration would add no
  invariant. Its released migration remains byte-identical.
- PostgreSQL physically constrains both columns. Append
  `0004-project-persistence-aggregates`; within the existing advisory-locked,
  per-migration transaction it replaces both named check constraints with the
  exact 20-member vocabulary. It performs no row update or destructive data
  rewrite.

Released PostgreSQL definitions remain immutable and retain these SHA-256
content checksums:

| Migration | SHA-256 |
| --- | --- |
| `0001-initial-schema` | `34413d60368bc485b1cbdc088d5000baa4ce31829c71ff0947d813aae1545f11` |
| `0002-evaluation-run-aggregate` | `aeeee92ba9db56fb762e6f44dfcb782a840897582d3cc135d6b1cfb7a2e594a3` |
| `0003-integration-run-aggregate` | `595f8bea3d06baae44370aeeca5f1a21f57cadf55f2970fb20b054e9ad29c065` |

The new `0004` content checksum is
`5de038634e296881ba4f258f5b784fe749117515e6758c6cde77818b3e1ce5aa`.
Startup continues to serialize with the repository-owned PostgreSQL advisory
lock. Each migration commits independently. A failing `0004` transaction
restores the earlier constraints and leaves the applied prefix unchanged; a
later open with corrected bytes resumes from that prefix. Checksum drift,
history gaps, and unknown future migrations still refuse startup.

### Assurance

Tests own literal expected inventories independent of production arrays and
SQL. Compile-time equality ties the public `AggregateType` union to the runtime
inventory. Runtime tests refuse unknown, case-drifted, whitespace-padded,
confusable, embedded, and projection discriminators. A planted SQL-vocabulary
mutation proves the PostgreSQL parity oracle is load-bearing.

The reusable suite exercises every new discriminator on memory, both SQLite
modes, the deterministic PostgreSQL seam, and hosted PostgreSQL: create at
version 1, duplicate refusal, exact read, conditional update, stale/future
conflict, aggregate and event pagination, global/per-aggregate journals,
cross-type identity isolation, checksum identity, close refusal, and durable
reopen where storage is durable.

Hosted PostgreSQL additionally proves fresh schema parity, upgrade from every
released prefix, and exact preservation of every physical column in old
aggregate/event rows. Non-default trace and causation values plus a planted
trace rewrite make that equality oracle load-bearing. It also proves concurrent
startup, exact `0004` rollback/resume, checksum drift, and schema-ahead refusal.
The pre-existing real-server suite continues to re-prove:

- `PER-02`: complete shared persistence and physical application reopen
  contracts; and
- `PER-03`: migration locking, independent `SERIALIZABLE` optimistic conflicts,
  native `SKIP LOCKED` claims, finite lock timeout, commit-ordered identity,
  redacted finite failures, backend-loss recovery, and explicit caller-owned
  retry rather than hidden operation retry.

## Consequences and nonclaims

- C7 is an isolated persistence-schema checkpoint; C8 intake and C9 plan
  assembly have not started.
- Stage 20B commands, approvals, spending effects, pause/kill, durable global
  emergency-stop authority, sessions/allocation runtime, desktop work, and
  production activation remain absent.
- Stage 18 development acceptance remains complete. `PLN-02` remains
  incomplete and `productionAdmitted=false`.
- No real project record is created. Tests use only task-owned memory, SQLite
  files, and disposable PostgreSQL schemas.
- C7 completion still requires focused/root validation, an independent review
  of the exact candidate tree, non-force publication, and exact-head hosted CI.
