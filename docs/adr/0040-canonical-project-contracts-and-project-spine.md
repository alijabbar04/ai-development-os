# ADR 0040: Canonical project contracts and project spine

- Status: Accepted for Stage 20 Phase B checkpoint C6
- Date: 2026-08-29
- Governing parent: ADR 0038
- Supersedes no repository contract

## Context

The Stage 20–21 architecture dossier reserved the prospective label “ADR 0037”
for the canonical project model. The live repository subsequently assigned ADR
0037 to Stage 18 development acceptance and ADRs 0038–0039 to the Stage 20
split and read-only control-service boundary. The next free committed number is
therefore 0040. This ADR is the repository realization of that prospective
decision; the dossier number is provenance, not an alternate repository ADR.

Stage 20A C0–C5 is complete and externally reviewed on sealed source commit
`b331f1d8bb6edf094470522acd288aaa29916190`. It provides a production-disabled
six-read, zero-command local control plane. C6 needs one canonical vocabulary
for later project persistence and experiences, but must not add persistence,
commands, scheduling, execution, or production authority.

Two design dossiers overlap and occasionally disagree. Repository contracts
and accepted ADRs take precedence, followed by the explicit C6 operator
decision, reconciliation deltas, and then the earlier canonical dossier. This
ADR records the non-mechanical choices instead of hiding them in parsers.

## Decision

Create the pure `@ai-dev-os/project` package as the canonical C6 project spine.
It owns strict data contracts, validation, canonical serialization, total state
transition tables, contract-layer recovery directives, and pure projections.
It performs no I/O, starts no background work, reads no ambient clock, registers
nothing, and exposes no command or runtime capability. Its production flag is
literal `false`.

The package adopts all 21 canonical records: `Project`, `ProjectBrief`,
`Constraint`, `ProjectPlan`, `PlanStage`, `Task` (also named `ProjectTask` in
TypeScript), `Dependency`, `AgentRun`, `Session`, `Handover`, `Decision`,
`ApprovalRequest`, `SpendingRequest`, the existing scheduler
`UsageReservation` shape, `EvidenceRecord`, `Deliverable`, `Blocker`,
`Notification`, `CommunicationThread`, `ExternalIntegration`, and
`ProjectHealthProjection`.

The operator-approved reconciliation also adds `ProjectStop` as a contract-only
record, `ProjectSummaryProjection`, `operator-paused` as a blocker kind,
`budget-extension-accepted` as a decision kind, finite session/plan/approval/
usage display vocabularies, and deterministic Normal/Developer presentations.
These are data and copy contracts, not commands or claims that an effect took
place.

`ProjectSummaryProjection.status` adds the reconciled derived word `stopped`
only while the matching `ProjectStop` is active. Durable `Project.status`
remains the canonical three-state machine, so a project-scoped stop is neither
smuggled into project lifecycle nor confused with the global emergency stop.

The reconciliation acceptance-pack shorthand groups invalid reset, future, and
schema evidence with `reset-passed`, while its detailed usage derivation calls
those cases unavailable invalid evidence. C6 chooses the safer detailed rule:
only an actually expired window maps to `reset-passed`; invalid reset ordering,
future evidence, and unsupported schema map to `unavailable` with their rule ID
available to Developer presentation.

### Identity and versioning

Top-level project-owned identities use their record prefixes where the dossiers
define one: `prj:`, `brf:`, `pln:`, `stg:`, `tsk:`, `run:`, `ses:`, `hnd:`,
`dec:`, `apr:`, `spd:`, `reservation:`, `evd:`, `dlv:`, `blk:`, `ntf:`,
`thr:`, `ext:`, and `pst:`. Content-addressed handover, decision, and evidence identities
bind the suffix to their canonical SHA-256 material. Other referenced identities
remain bounded opaque IDs owned by their existing package instead of receiving
a guessed C6 prefix.

The strict parsers establish content-id namespace and truncated-digest shape;
the separate pure `assertContentDerivedIdentity` guard binds each such identity
to a caller's independently computed canonical SHA-256. C6 deliberately does
not import a runtime cryptography implementation merely to hide that
independent-evidence boundary.

New project-owned records use exact `schemaVersion: 1`. `UsageReservation` is
reused without adding a second schema field or duplicate runtime type; compile
parity is checked against the scheduler definition. Future incompatible changes
require a new exact schema version and parser rather than permissive defaulting.
Timestamps use canonical millisecond UTC text and the explicit inclusive range
`2000-01-01T00:00:00.000Z` through `9999-12-31T23:59:59.999Z`.

Project plans have immutable revision identity: revision 1 has no predecessor;
each successor has a new `planId`, a gap-free next `revision`, and `supersedes`
the prior `planId`. This resolves the dossiers' conflict between immutable
revisions and examples that reused a plan identity. Briefs, handovers, decisions,
and evidence likewise represent replacement with explicit new records and
supersession according to their contract. No parser mutates an accepted input.

Decision scope adds `planRevision` beside `planId`. The canonical dossier's
scope example omitted it, but its own cross-record rule and the reconciliation's
budget-extension decision both require stale-plan detection. A
`budget-extension-accepted` decision is therefore operator-only and must bind
one task plus the exact plan identity and revision.

The canonical digest covers the sealed stages, tasks, dependencies, and budget
ceiling. A post-seal edit is a new plan revision. C6 ratifies all six P-2
conditions but deliberately exposes no scheduling-authorization or scheduling-
eligibility predicate. A complete decision also needs authoritative
specification, coverage, project-ceiling, candidate-requirement, and scope-
approval records with exact project, plan identity/revision, plan digest, and
candidate-set bindings. Those records and bindings belong to C9 plan assembly
and sealing. Until C9, plan state, caller assertions, digest-shaped strings, and
cross-project or cross-plan approvals cannot be interpreted as scheduling
authority. The C6 package contains no scheduling command or runtime capability.

### Authority

Authority is explicit and cannot be inferred from prose or provenance:

- model-origin records carry `authority: "none"`;
- model-origin hard constraints are structurally refused;
- operator objectives originate only in an operator `ProjectBrief`;
- handovers may name already-consumed approvals but contain no transferable
  token or authority;
- provider session references are opaque data, never identity or authority;
- communication threads and transcript/narrative references are audit/display
  links and are excluded from durable decision material;
- `budget-extension-accepted` records a decision only and moves no money;
- a `SpendingRequest` can describe and bind evidence but cannot purchase;
- `operator-paused` is an orchestration label and does not assert safe provider
  process suspension; and
- `ProjectStop` is project-scoped and neither implements nor weakens the global
  emergency-stop contract.

The complete 14-class approval vocabulary and its exact action mapping are
declarative in C6. Where that future vocabulary exceeds the current policy
package, type-only composition records the superset locally; C6 does not change
the enforcing policy tables. This avoids silently expanding current runtime
authority while preserving the reviewed project contract.

### Validation, state, and presentation

Parsers require exact object shapes and schema versions; bounded NFC strings and
arrays; finite enums; exact prefixes; internally consistent references;
duplicate-free identities; acyclic dependencies; finite-range timestamps; and
explicit security, workload, routing, and authority values. JSON text parsing
rejects duplicate keys before materialization. Canonical serialization sorts
keys and rejects cycles, symbols, accessors, prototype-pollution-shaped objects,
non-finite numbers, unsupported values, and non-normalized nested text.
Boundary validators snapshot property descriptors without invoking getters;
proxy reflection failures and forged thrown errors collapse to finite package-
owned refusal codes and root paths. Public callers cannot inject diagnostic
paths. Refusals use a closed ten-code taxonomy with safe static explanations
and never echo input.

Notification, blocker, and needs-you prose is selected only by finite typed
serializers. Actionable destinations are a closed own-app route union with an
exact parameter shape for each route; URLs, filesystem paths, arbitrary route
parameters, model prose, digests, usage numbers, code, and secret material
cannot become display copy. These records remain data and grant no navigation
or command capability inside C6.

Explicit total transition tables cover project, plan, task, agent-run, session,
handover, approval, spending, blocker, and notification delivery. Every
state/event cell is either one documented next state or an illegal-transition
refusal. Terminal states and gap-free revision progression are explicit.
Recovery is represented only as a pure directive; no timer, retry, lease,
process, or recovery loop exists here.

Pure exhaustive projections map the complete `(task state × blocker kind or
null)` product to the scheduler's existing `RunStatus`, map the complete
run/session/blocker/allocation product to the documented display vocabulary,
and derive finite plan, approval, usage, project-health, and project-summary
views. Live session safety states take precedence over contradictory run
terminal words until stop is confirmed. Usage failure, unavailable,
unauthorized, revoked, future, reset-invalid, and schema-invalid evidence takes
precedence over expiry; ambiguity and staleness likewise win before a coherent
expired-window `reset-passed` word.

Normal and Developer forms have the same `authority: "none"` and empty command
tuple. Normal is an explicit recursive product subset that omits internal
identities, health source-sequence, stale-reason, and blocking-rule diagnostics,
while preserving product-required freshness truth: health `computedAt` and
summary `confidence`, `sourceSequence`, and `computedAt`. Developer returns only
the strict canonical projection. The boundary no longer accepts an unconstrained
generic value or caller-authored diagnostic object.

### Package graph

The package has zero runtime dependencies. Type-only development dependencies
on domain, policy, scheduler, process-broker, and secrets prove compatibility with their
owning vocabulary and compile away. The tarball and clean consumer verification
must prove that emitted JavaScript imports no internal workspace package and
installs without a runtime dependency graph.

## Reconciliation dispositions

The canonical dossier omitted some lifecycle facts that its state-machine and
reconciliation documents require. C6 adds `planRevision` to `AgentRun`;
revision, supersession, and state to `Handover`; revision/supersession to
`Decision` and `EvidenceRecord`; explicit acceptance state to `Deliverable`;
state and clearing evidence to `Blocker`; and identity/revision to
`ProjectStop`. These additions make stale-reference refusal and immutable
history representable without inventing runtime behavior.

Prior-record assertions cover brief, plan, handover, decision, and evidence
lineage, with an additional cycle check for supplied supersession histories.
Repository-writing tasks require managed worktrees. Handover repository
bindings use canonical 40- or 64-hex revisions, coherent disposition/result
metadata, and closed completed-claim evidence. Approval terminal records retain
any earlier decision and partial-consumption history, and all legal approval
state edges remain parseable. The scheduler-owned reservation parity is exact:
both `reconciled` and `released` require actual usage and `reconciledAt`.

`ProjectSummaryProjection` remains a derived projection and is not added to the
canonical persistence record registry. `ProjectHealthProjection` is the 21st
canonical record. `ProjectStop` is the one separately approved 22nd parser
registry member. No new persistence `AGGREGATE_TYPES` member is added in C6.

The dossier writes `ExternalIntegration.credentialRef` as a string while naming
it an existing `SecretRef`. The current repository contract takes precedence:
C6 uses the exact structured `SecretRef` union. A local pure structural parser
is compile-checked against that type because importing the owning runtime parser
would pull Node cryptography and policy composition across this package's
zero-runtime boundary. Raw strings and secret material are unrepresentable.

## Consequences

- C7 alone will decide persistence integration and separately re-prove memory,
  SQLite, and PostgreSQL contracts. C7 has not started.
- C8 intake, C9 plan assembly, Stage 20B commands, approval consumption,
  spending execution, emergency-stop behavior, scheduling, process launch,
  provider/credential access, and desktop work remain absent.
- `PLN-02` remains incomplete, `productionAdmitted=false`, and production stays
  disabled.
- Removing every chat/transcript reference cannot affect validation, transition,
  or projection outcomes because no such payload is an input to those functions.
- The C3–C5 review PASS is baseline evidence only and does not transfer to C6.
- C6 publication requires focused and repository-wide validation plus an
  independent read-only review of the exact candidate bytes.
