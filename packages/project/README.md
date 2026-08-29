# `@ai-dev-os/project`

Pure, deterministic, production-disabled contracts for the AI Development OS
project spine. This package defines data; it does not create projects, build
plans, schedule tasks, run agents, contact providers, persist records, or grant
authority.

## Boundary

The package has zero runtime dependencies and no runtime registration. Its
references to `@ai-dev-os/domain`, `@ai-dev-os/policy`,
`@ai-dev-os/process-broker`, `@ai-dev-os/scheduler`, and `@ai-dev-os/secrets` are type-only
development dependencies used to prove vocabulary parity during compilation.
The packed JavaScript imports none of them.

Production source may not access filesystems, databases, Git, the network,
processes, environment variables, credentials, providers, timers, ambient
clocks, Electron, or child processes. Static policy tests include planted
positive controls for that boundary. `PROJECT_PRODUCTION_ENABLED` is literally
`false`, and both `PROJECT_RUNTIME_CAPABILITIES` and
`PROJECT_AVAILABLE_COMMANDS` are empty.

## Contracts

Schema version 1 covers the 21 canonical records:

1. `Project`
2. `ProjectBrief`
3. `Constraint`
4. `ProjectPlan`
5. `PlanStage`
6. `Task` (`ProjectTask` is also exported as its unambiguous local name)
7. `Dependency`
8. `AgentRun`
9. `Session`
10. `Handover`
11. `Decision`
12. `ApprovalRequest`
13. `SpendingRequest`
14. `UsageReservation`
15. `EvidenceRecord`
16. `Deliverable`
17. `Blocker`
18. `Notification`
19. `CommunicationThread`
20. `ExternalIntegration`
21. `ProjectHealthProjection`

C6 also adopts `ProjectStop` as a contract-only reconciliation record and adds
`ProjectSummaryProjection`. `operator-paused` is a blocker kind;
`budget-extension-accepted` is a decision kind. Neither value implies that a
provider process was suspended, that money moved, or that any effect occurred.

Strict parsers enforce exact object shapes, finite vocabularies, bounded NFC
text and arrays, identity prefixes, exact schema versions, reference integrity,
duplicate-key refusal for JSON text, authority constraints, and timestamps from
`2000-01-01T00:00:00.000Z` through `9999-12-31T23:59:59.999Z`. Errors expose
only finite codes and package-owned root labels, never rejected input or a
caller-supplied path. Boundary reflection snapshots plain records and arrays
without invoking property getters; proxy/reflection failures collapse to one
finite refusal.

## Revisions and authority

Project-plan revisions are immutable records. A successor has a new `planId`,
the next gap-free `revision`, and `supersedes` the previous `planId`. Brief,
handover, decision, and evidence replacements likewise use new identities and
explicit supersession. Prior-record assertions and a supplied-history cycle
guard make self-reference, identity reuse, wrong lineage, and cycles explicit.
This resolves the source dossiers' conflict between immutable revision history
and examples that reused a record identity.

Sealed plan content is digest-bound, but C6 exposes no scheduling-authorization
or scheduling-eligibility predicate. The complete six-condition P-2 decision
depends on exact specification, coverage, project-ceiling, candidate-requirement,
and scope-approval records that C9 will own and bind. A state word, caller
boolean, digest-shaped string, or approval from another project or plan cannot
stand in for those records. Strict plan parsing refuses an executing unsealed
plan and any invented scheduling-authority/proof field. A post-seal change is a
new revision. Model-origin constraints and evidence always carry
`authority: "none"`; model-origin hard constraints are unrepresentable.
Handovers may reference approvals but cannot contain or transfer authority.
Provider sessions, chat messages, and transcript references are display or
audit links only.

Repository-writing tasks require `workspaceMode: "worktree"`. Handovers bind
canonical 40- or 64-hex repository revisions, a conservative branch form,
coherent worktree disposition/result metadata, and completed claims whose
evidence is closed by the handover's top-level evidence set. The local
`UsageReservation` parser mirrors the scheduler owner: both `reconciled` and
`released` are terminal accounting states with actual usage and reconciliation
time.

Handover, decision, and evidence parsers require their content-identity prefix
and truncated-digest shape. `assertContentDerivedIdentity` then checks the id
against a caller's independently computed canonical SHA-256; the package does
not import a runtime cryptography provider or silently trust the id text.

External integrations carry the repository's exact structured `SecretRef`,
never a string or secret value. Its C6 validator is a pure structural projection
of the owning package because importing that package's runtime parser would pull
runtime cryptography and policy composition across this zero-runtime boundary.

The project approval vocabulary is declarative and intentionally wider than
the currently enforcing policy package. It does not change policy tables or
create a second enforcement source. C7 persistence integration is deliberately
absent.

## Pure state and projections

Explicit total transition tables cover project, plan, task, agent-run, session,
handover, approval, spending, blocker, and notification-delivery state. Illegal
state/event pairs return one finite typed refusal, terminality is explicit, and
contract-layer recovery directives never run a timer or perform recovery.

Pure projections provide:

- the exhaustive task-state/blocker product into the scheduler's existing
  `RunStatus` union;
- all documented session display states;
- project health and summary views;
- finite plan, approval, and usage display vocabularies; and
- explicit recursive Normal and Developer schemas with identical empty command
  and authority surfaces.

Normal presentations retain the freshness truth required by their product
surface: health `computedAt`, plus summary `confidence`, `sourceSequence`, and
`computedAt`. They omit developer-only schema, health source-sequence,
diagnostic identity, stale-reason, and blocking-rule fields at every nested
level. Developer presentations contain only a re-parsed canonical health or
summary projection; callers cannot append arbitrary diagnostics. Blocker,
notification, and needs-you copy comes from finite typed serializers, while
actionable links are exact own-app route/parameter unions rather than prose or
URLs. No model, path, digest, usage amount, code, or secret text is interpolated.

An active `ProjectStop` is projected as summary status `stopped` without adding
that value to the durable `Project.status` state machine or conflating it with
the global emergency stop.

## Verification

From the repository root:

```powershell
npm run typecheck --workspace @ai-dev-os/project
npm run build --workspace @ai-dev-os/project
npm test --workspace @ai-dev-os/project
npm run test:coverage --workspace @ai-dev-os/project
npm run verify:packed-consumer --workspace @ai-dev-os/project
```

The packed-consumer check installs the generated tarball into one bounded
task-owned temporary root and proves the public ESM entry without relying on
monorepo source or workspace links.

See [ADR 0040](../../docs/adr/0040-canonical-project-contracts-and-project-spine.md)
for the design decision and the
[C6 checkpoint evidence](../../docs/release-evidence/stage-20-c6-project-contracts-checkpoint.md)
for the validation boundary.
