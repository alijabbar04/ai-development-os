# ADR 0043: Stage 20 C9 plan assembly and sealing

- Status: Accepted for Stage 20 Phase B checkpoint C9
- Date: 2026-09-04
- Governing parents: ADR 0038, ADR 0040, ADR 0041, and ADR 0042
- Exact prerequisite: C8 commit
  `1bfe9769d662a45a7e4b7f114a016328476d5215`, tree
  `5fd1a3dc8f5593e76fd96cdbbec2e830502f76d3`
- Production activation: prohibited

## Context

C6 established strict canonical project records and their lifecycle tables. C7
extended generic persistence with the `project-plan` discriminator. C8 added a
production-disabled intake library whose only durable action is explicit
acceptance of a `ProjectBrief`. None of those checkpoints proves that a plan
was assembled from the current accepted brief, preserves specification and
coverage provenance, or satisfies all six sealing conditions.

C9 supplies that missing library contract without adding an application route,
command, production adapter, task dispatch, scheduling eligibility, approval,
spending authority, credential access, provider call, or context-pack
implementation. The repaired C9 readiness dossier is normative design input.
Its final 99-file manifest has SHA-256
`c2b266517e36ae39e7184ae2a68959604bfe8552d0cf2020fdac1b4867b0c4f6`.
The dossier's Markdown and JSON invariant matrices are retained byte-for-byte
under `docs/development/stage-20-c9/` so their 98 identifiers remain directly
auditable beside the implementation.

## Decision

Create `@ai-dev-os/plan` as a pure, deterministic, production-disabled package.
Its root runtime workspace dependency is exactly `@ai-dev-os/project`. The
root owns value parsing, deterministic assembly, record and graph invariants,
the two-layer lifecycle, seal evaluation, projections, canonical persistence
material, read-only ambiguity observation, and the `PlanStore` port.

The C8/C7 conformance composition is isolated at `@ai-dev-os/plan/testing`.
Only that subpath imports intake, persistence, domain, product-planning, and
the memory/SQLite adapters. It contains the synthetic one-shot commit-
authorization issuer used by tests. No issuer, persistence adapter, transaction
handle, application composition, or runtime capability is exported from the
production root.

`PLAN_PRODUCTION_ENABLED` is literal `false`. `PLAN_AVAILABLE_COMMANDS` and
`PLAN_RUNTIME_CAPABILITIES` are frozen empty tuples.

## Proposal and assembly contract

`PlanAssemblyRequest` is exact-key parsed. It carries the complete proposal,
new plan identity, independently retained proposal/specification/coverage
digests, one task-budget allocation per task, and the nullable complete
specification adapter input. It carries no authentication evidence. A caller
cannot set task state, ordinal, seal metadata, retry, timeout, priority,
workload class, or handover policy.

The proposal digest excludes no authority-bearing proposal field and is not
self-referential. Specification and coverage use separate non-recursive digest
materials. Every expected digest is recomputed before assembly and again at
the persistence boundary. Set-like collections normalize by their documented
keys, while declared stage order is semantic and derives dense ordinals.

Every assembled task starts at `state:"pending"`, `stateRevision:1` and uses
the C9-owned fixed execution policy:

```text
retry={maximumAttempts:1,initialBackoffMs:0,maximumBackoffMs:0,retryableFailures:[]}
timeout={dispatchMs:1,attemptMs:1}
priority="normal"
workloadClass="general"
handoverPolicy={requires:"none",acceptFrom:[],maximumAgeMs:null}
```

The plan limits are 64 stages, 512 tasks, 64 tasks per stage, 1,024
dependencies, depth 32, fan-in 32, and fan-out 32. Compile-time and runtime
checks keep these within the C6 and applicable task-graph ceilings. Ordering
dependencies must form an acyclic graph. Topological ties resolve by stage
ordinal then task ID. Advisory edges neither constrain stage placement nor
topological order.

The complete parsed assembly request is durable review evidence in every plan
event. Model `narrativeRef` is an opaque nullable `nar:` digest token. It is
never resolved, Normal omits it, and Developer can expose only the labelled
token or null. Operator-origin proposal claims remain untrusted until a
separately issued capability binds byte-equal node-qualified evidence.

## Specification and provenance

C9 mirrors the published product-planning shapes at runtime while importing
their TypeScript contracts only as types. It preserves the complete
specification approver, requirement decisions, coverage, and candidate
provenance. Every non-null upstream `requirement-task:*` identity maps exactly
once to one in-plan `tsk:*` identity. The upstream specification identity is
retained only in the binding; local references derive from the verified
specification and coverage digests.

Six authority-bearing prose paths are provenance checked: stage title, intent,
and exit criteria; task title, objective, and acceptance criteria. An
`origin:"operator"` claim is not proof of operator authorship. The private
one-shot capability binds the final commit digest, operation sequence, event
IDs, exact authenticated rows, and exact Decision bytes. A raw JavaScript
lookalike or replay refuses before store I/O.

## Accepted-brief proof

Every G1-G7 read re-proves an accepted brief by correlating the current
`project-brief` aggregate, its current aggregate version, the unique
current-version `project-brief.accepted` event, and a successful C8
`parseIntakeAcceptanceEvent` result. The reader validates exactly one accepted
event at every lineage position from 1 through the current aggregate version,
including each expected prior version/head and `brief.supersedes` link. The
proof binds aggregate/event/project/brief identities, version, payload,
checksum, time, cursor, provenance, decision material, candidate digest, and
independently hashed brief content. An absent aggregate is accepted as truly
absent only when both its exact journal and the project-plan aggregate are also
absent; orphan events or an already-bound plan fail closed as invalid proof.

The read result is closed to `absent`, `accepted`, `invalid-proof`, and
`unresolved`. Missing or malformed proof is corruption; stale accepted
lineage is `plan.brief.superseded`; brief-content digest disagreement is
`plan.brief.content-digest-mismatch`. Adapter failure, finite evidence-bound
exhaustion, and internal cursor faults remain unresolved observations and do
not become corruption or evidence of absence.

C9 does not reconstruct C8's five ephemeral blocking-question bases from
prose. It relies on the public C8 acceptance parser and repeats only the frozen
`openQuestions[].blocking` defence at seal time.

## Lifecycle and sealing

C9 reuses exactly seven C6 plan-state cells and adds a total 21-state by
25-symbol assembly/session table: 525 cells, 107 legal cells, and nine locked
states. Pending write state retains the exact operation, origin, observation
kind, and immutable prepared request. Only a caller's later explicit action
may begin another bounded read or mutation after refusal or ambiguity.

The first durable plan write is only version 1, `plan.drafted`, state
`drafting`, with null seal metadata. Promotion is a separate transition.
Sealing is a later transaction from an existing proposed head. Revision and
rebase create new drafting records through the real C6 supersession guards;
redraft replaces only drafting state without pretending a C6 supersession
edge occurred. Supersession and abandonment retain historical accepted-brief
binding without falsely re-proving it as current.

Sealing recomputes all six conditions from the transactionally proven plan,
review evidence, accepted brief, current project/control snapshot, resolved
budget ceiling, and capability-authenticated decisions. It requires a
non-empty specification binding and no blocking open question. The current
budget account must be open and project-scoped. Directional token limits and
the account's orthogonal total-token limit are retained separately; total-token
compliance uses checked subtraction. C9 creates no reservation and makes no
claim about later remaining spend capacity.

Durable C9 always evaluates `scopeApproval:null`. A synthetic consumed approval
exists only to test the pure condition-6 predicate. It drives no state
transition or store call. Every C9-written plan has
`sealedByApprovalId:null`; C10 owns future approval consumption.

## Persistence and ambiguity

There is one `project-plan` aggregate per project and its aggregate identity is
exactly the project ID. Every mutation requires a valid unused
`PlanCommitAuthorization`. Before its single persistence-mutation adapter
dispatch attempt, the composition exact-key parses all request/event material,
recomputes digests and checksums, validates complete event shapes, and consumes
the capability. There is no retry.

Inside the same serialized C7 transaction, every write reparses the current
Project, requires it to be active, completes a bounded current-project-stop
scan, and recomputes `PlanMutationControlEvidence`. Promotion, approval
escalation, and seal also require the Project version/content digest to match
the assembly basis retained by the current head event. Draft/redraft/revision
reassemble from the current Project. Every refusal or injected fault writes
neither aggregate nor event.

The test-only C8/C7 composition also applies an injected finite evidence
deadline around each awaited proof read and immediately before the first
mutation. An expiry detected before capability consumption is unavailable
evidence and leaves the one-shot authorization reusable. The capability is
consumed before the single transaction attempt; expiry during in-transaction
evidence reads rolls that transaction back with zero mutation while the
authorization remains consumed. No automatic retry follows either outcome, and
the caller receives the honest finite refusal or not-attempted result. The C7
port exposes no cancellation primitive, so an in-flight adapter operation is
awaited rather than raced or detached; the contract proves that elapsed evidence
cannot start a later mutation after the outcome, not that an adapter promise can
be preempted.

The nine closed event variants are `plan.drafted`, `plan.proposed`,
`plan.scope-approval-required`, `plan.scope-rejected`, `plan.sealed`,
`plan.revised`, `plan.superseded`, `plan.abandoned`, and
`plan.budget-extended`. Each uses payload schema version 1 inside a C7 event
envelope schema version 1. Head reads require exactly one complete correlated
head-advancing event at the aggregate version. Journal-only annotation does
not advance or change the plan.

After an ambiguous head write, the only permitted action is bounded exact
head/event observation. After an ambiguous annotation, it is bounded ascending
journal observation. Exact target presence is committed, conclusive unchanged
prior state is not-recorded, and incomplete, contradictory, unavailable, or
bound-exhausted evidence remains unknown. Duplicate identities never prove
success and no observation path writes or retries.

## Projection boundary

Normal and Developer projections are pure frozen values with identical
`authority:"none"`, actions, and empty command tuples. Normal structurally
omits internal identities, digests, provenance, rule IDs, `narrativeRef`, and
resolved-ceiling audit evidence. Developer labels those fields but exposes no
callback, transaction/driver handle, command, approval, eligibility token, or
runtime authority. The accepted brief's private aggregate ID is supplied only
by the acceptance-proven composition and appears as a labelled Developer field;
Normal omits it. The orthogonal account total-token ceiling likewise appears
only as labelled Developer readiness evidence.

The raw assembly-session transition helpers and caller-carried session object
are advisory, not authorization or trusted UI state. Stage 21 must safely compose
and parse that state, reject fabricated objects, and suppress enabled actions
whenever the composed session is locked. That application/UI boundary is not
added by C9. The technical action identifier `wait-for-c10` remains stable, but
Normal copy says "Waiting for scope-approval support" and requires no checkpoint
knowledge.

## Validation and packaging

Tests exercise pure parsing, deterministic reruns, property/fuzz inputs,
mutation controls, graph/record/provenance/seal invariants, every lifecycle
cell, leakage/parity, static boundaries, rollback, concurrency, ambiguous
observation, memory, real SQLite, and installed packed-consumer composition.
The packed verifier installs the plan tarball and every dependency loaded by
the testing composition into a task-owned temporary root. Workspace links are
refused and the production main graph is checked not to reach `./testing`.

Literal inventories bind all 70 API codes, 21 C9-relevant codes, 26 wire
mappings over 13 bases, ten package refusal codes, 81 rule IDs, 51 intake
runtime and 46 type-only exports, the C6 13-state/20-event/21-cell machine,
the nine event variants, all 98 matrix IDs, and the complete 21 by 25 C9 table.
The 81-rule assertion pins vocabulary, not 81 independent behavioral emitters:
73 identifiers have current emitter branches; three are display/wire vocabulary
(`plan.sealed.immutable`, `plan.size.too-large`, and outcome-shaped
`plan.store.conflict`); five are explicitly reserved for later owners
(`plan.brief.insufficient`, `plan.provenance.ambiguous`,
`plan.coverage.evidence-insufficient`, `plan.task.irreversible-unbound`, and
`plan.task.handover-source-unknown`).

## Explicit deferrals and nonclaims

C9 adds no route, listener, command, application wiring, migration, aggregate
type, production adapter, context pack, attachment ingestion, approval or
spending authority, reservation, scheduler eligibility, task execution,
provider/network call, credential access, emergency-stop implementation,
desktop UI, message, release, or production activation. The three context-pack
blockers remain deferred. `PLN-02` and production admission remain incomplete.

## Consequences

Later checkpoints can compose a deterministic, provenance-preserving plan
contract and independently review its exact durable evidence. C10 must add the
approval-owning boundary before material inferred scope can seal. Stage 20B
must separately authorize commands and mutation routes. Stage 21 owns the UI.
No later checkpoint may infer authority merely from a C9 sealed plan or from
this ADR.
