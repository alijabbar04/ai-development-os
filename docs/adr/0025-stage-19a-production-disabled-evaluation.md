# ADR 0025: Stage 19A production-disabled deterministic evaluation

- Status: Accepted for the Stage 19A checkpoint
- Date: 2026-08-11

## Context

Stages 18A–18D provide bounded planning, durable scheduling, usage accounting,
SQLite/PostgreSQL persistence, and a fail-closed production admission decision.
They deliberately do not let completion prose, a model verdict, or the presence
of an artifact prove that an implementation satisfies its approved product
scope. Stage 19 owns that evaluation boundary and the later serialized Git
integrator.

The overnight Stage 19 window begins only after the exact Stage 18D evidence
head is published and all hosted jobs are green. The remaining feature window
is sufficient for a coherent evaluation aggregate, but not for an honest
implementation and complete fixture proof of the Git integrator. This decision
therefore defines Stage 19A without partially opening Stage 19B authority.

## Decision

Add `@ai-dev-os/evaluation` as a provider-neutral, production-disabled package.
The package owns versioned requests, exact subjects, externally authorized
criterion manifests and waiver digests, deterministic evidence, model
advisories, criterion/result
projections, disagreement records, completeness findings, and durable run
events. It depends only on `@ai-dev-os/domain` and `@ai-dev-os/persistence`.

The public service and every checkpoint carry literal `productionEnabled:
false`. There is no provider, process, workspace, Git, network, credential,
native-worker, approval, or registration port in the package. Evaluation does
not imply execution or integration authority.

### Evidence precedence

The supported deterministic kinds are output schema, changed paths,
compilation, tests, static analysis, acceptance criteria, requirement coverage,
and repository state. Each item binds repository ID and exact Git head/tree,
product-specification and subject digests, criterion kind/configuration,
kind-specific evidence-contract and derived input digests, exact evaluator
ID/version and exact expected artifact digests, and canonical observation and expiry times.
Requirement coverage is an exact bounded collection of explicit
requirement-to-task-to-result edges.

Mismatched, stale, future, malformed, partial, or wrong-head evidence is not a
pass. Any valid deterministic failure dominates model advice. Required and
expected-quality failure or absence blocks acceptance. Delight and deferred
gaps remain visible without blocking unless a future exact scope decision
promotes them.

The service receives one fingerprinted authority configuration from trusted
composition. Its allowlist binds exact criterion manifests to the subject
digest and exact canonical evidence and waiver instances. A request therefore
cannot omit required product-specification criteria, authorize its own reduced
manifest, or fabricate a structurally passing evidence record. A waiver input
is usable only when its operator/product-owner/security
reviewer claim, approval reference, reason, subject and criterion bindings,
approval time, and expiry hash to one of those preauthorized digests. Inline
authority text alone never authorizes. The package does not execute or
authenticate an evaluator, authenticate a human, or mint, approve, widen, or
reinterpret a waiver; configuration provenance and reviewed evidence production
are external trusted deployment responsibilities.

### Advisory disagreement and completeness

Model advisories are immutable inputs with route-independence keys. Their
recommendations never affect deterministic status. A disagreement record is
created whenever an advisory differs from the deterministic projection.
Majority vote has no special meaning.

The separate completeness audit reads only a validated evaluation result. It
retains every non-passing criterion and may emit a stable corrective-task
proposal key. It explicitly has no authority to authorize execution, approve a
waiver, widen scope, mark missing evidence complete, or integrate code.

### Bounds and replay

All arrays, strings, paths, attempts, timestamps, JSON, and digests have finite
closed bounds. Before nested parsing, a request-wide traversal enforces 75,000
nodes, reserving the enclosing domain JSON budget for the authority configuration,
derived result, durable snapshot, and event. It also enforces 2,000,000 UTF-16 text code units, depth 32, plain dense data, and no
cycles or aliases. Requests allow at most eight attempts and one canonical
deadline. The run state is `pending`, `completed`, `failed`, `cancelled`, or
`expired`.

Add the closed persistence discriminator `evaluation-run`. SQLite requires no
schema change. PostgreSQL receives append-only migration
`0002-evaluation-run-aggregate`, which replaces only the two aggregate-type
check constraints; released migration `0001-initial-schema` and its checksum
remain byte-identical.

Each event contains the exact command, full next snapshot (including the
trusted configuration), prior/current
digests, deterministic ID, sequence, and aggregate version. Replay re-executes
the command and requires the canonical event and final checkpoint to match.
Checkpoint plus journal writes share one persistence transaction. The lifecycle
permits at most nine events; replay reads at most one tenth overflow sentinel
and rejects non-progressing pagination.
Exact retries are write-free and conflicting identity/version reuse fails
closed. New acceptance uses one exact current authority configuration; durable
load separately requires the run's persisted configuration fingerprint in a
bounded trusted registry. This permits explicit per-run configuration rotation
without silently treating a later superset as the original exact authority.

## Rejected alternatives

- Trusting CI badges, prose, or model verdicts would make authority narrative.
- Treating a provider response as deterministic evidence would let advisory
  output manufacture completion.
- Reusing `project` or `task-run` persistence records would erase aggregate
  identity and replay boundaries.
- Editing PostgreSQL migration 0001 would invalidate released migration
  history; migration 0002 is the compatible extension.
- Beginning a partial Git command wrapper without the required fixture matrix,
  fencing, recovery, and authority proof would create misleading Stage 19B
  surface, so the integrator remains absent.

## Consequences and remaining work

Stage 19A can create bounded deterministic evaluations, preserve advisory
disagreement, produce non-authoritative completeness findings, and survive
persistence replay. Production remains disabled and Stage 17 admission remains
unsatisfied.

Stage 19B must still add `@ai-dev-os/integrator`, an injected reviewed Git port,
serialized lease/fencing/idempotency, exact repository/ref/tree/path policy,
fresh task-owned worktrees, conflict classification/resolution, rollback and
reopen evidence, and the full real disposable-repository fixture matrix. No
actual AI Development OS ref, index, worktree, push, PR, tag, release, or
production registration is authorized by this ADR.
