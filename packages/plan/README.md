# @ai-dev-os/plan

C10 compatibility: canonical ID comparisons use explicit UTF-16 code-unit order,
preserving numeric stage/version precedence. Earlier sealed records whose order
differs are refused under the current invariant, never rewritten. Original
accepted packets stay immutable. Declared stage order and existing presentation
bytes in proposal material retain their prior semantics. Joint durable scope
consumption and plan sealing remain R2 work; C10 adds no plan lifecycle/event.

Stage 20 Phase B checkpoint C9: pure, deterministic plan proposal parsing,
assembly, review, sealing predicates, lifecycle state, and persistence ports.

The saved AI preview's distinct adoption path uses `computeModelPlanProposalDigest`
and `prepareModelPlanAdoption`. The host supplies the exact saved, validated model
proposal and explicitly confirmed edits to existing stage/task prose fields.
The source remains `kind: "model"`, `authority: "none"`, with its original route
and contribution references. Edited fields use `operator-edit`, retaining exact
previous text and provenance; assembly and durable reopen reconstruct and verify
the original proposal digest. Graph, coverage, budgets and source metadata cannot
be edited through this factory. Ordinary model proposals still cannot claim
operator authorship.

Preparation issues no authority. The host must validate its immutable contribution,
project/brief/plan bindings and exact native confirmation, then supply every returned
edit row both in review evidence and in its private commit-authorization facts.
Missing, substituted or extra rows fail closed. Adoption remains a saved draft;
model-derived edited scope still requires the existing separate scope review and
sealing conditions. This helper supplies no planning assembly, completeness audit,
provider invocation or execution capability.

The three projection functions require an explicit, exact-key parsed
`PlanProjectionContext` and digest port. They read no clock: callers provide
`computedAt`, accepted/current brief bindings, the finite assembly-session
state, the acceptance-proven private brief aggregate ID, and any complete
correlated historical head. The private aggregate ID is labelled and visible
only in Developer mode. Normal remains a strict recursive product subset of
Developer with identical actions, empty commands, and no authority.

Production is deliberately disabled. The package exports no command, route,
provider access, scheduler eligibility, approval issuer, persistence adapter,
or execution capability. Its root runtime graph depends only on
`@ai-dev-os/project`.

`@ai-dev-os/plan/testing` contains the isolated C8/C7 persistence conformance
composition and a synthetic one-shot authorization issuer. It is test-only and
must never be imported by production composition. The composition applies a
finite evidence deadline (30 seconds by default) around every accepted-brief,
head, journal, Project, and stop-snapshot read and checks it immediately before
the first mutation. Tests may inject a monotonic clock and a shorter bound. An
expiry detected before capability consumption leaves the one-shot authorization
reusable. Consumption happens before the one transaction attempt; expiry during
its evidence reads rolls the transaction back with zero mutation but leaves that
authorization consumed. There is no automatic retry, and the caller receives a
finite refusal or not-attempted outcome appropriate to the failed evidence. The
C7 adapter has no cancellation/deadline parameter, so an in-flight adapter call
is awaited rather than detached; no background operation can later mutate state
after the returned refusal.

The exported assembly-session transitions are deterministic advisory state, not
proof that a caller is entitled to render or invoke an action. Stage 21 must
compose and parse session state at its trusted boundary, reject fabricated
objects, and render no enabled action while that composed session is locked. C9
deliberately adds no Stage 21 composition.

`PLAN_RULE_IDS` pins an 81-member cross-layer vocabulary. Seventy-three members
have concrete C9 emitter branches. `plan.sealed.immutable`,
`plan.size.too-large`, and the outcome-shaped `plan.store.conflict` are retained
as projection/display or wire-mapping vocabulary rather than fabricated runtime
emissions. `plan.brief.insufficient`, `plan.provenance.ambiguous`,
`plan.coverage.evidence-insufficient`, `plan.task.irreversible-unbound`, and
`plan.task.handover-source-unknown` are reserved for later owning boundaries.
The inventory assertion is not a claim that all 81 identifiers are independently
behaviorally emitted.
