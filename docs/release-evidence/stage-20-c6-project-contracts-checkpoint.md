# Stage 20 Phase B C6 canonical project-contract checkpoint

## Scope and publication boundary

This checkpoint closes only Stage 20 Phase B checkpoint C6. It introduces the
pure, production-disabled `@ai-dev-os/project` contract package, ADR 0040,
focused documentation, tests, package verification, and this evidence record.
It does not add project persistence, a persistence aggregate, a database
migration, intake or plan-assembly behavior, commands, approvals, spending,
emergency-stop behavior, scheduling, process or agent launch, provider/session
execution, credential access, desktop composition, or production activation.

The independently reviewed candidate is the complete staged tree described by
the terminal handoff. Recording that tree, its future commit identifier, its
post-push remote equality, or its hosted-CI URL inside the same tree would be an
impossible self-reference. The terminal handoff therefore supplies those facts
after this file is reviewed, committed, non-force-pushed, and observed by exact
head. This document does not transfer any earlier PASS to changed bytes.

## Exact entry identity

The sealed input was verified before editing:

- source worktree:
  `C:\Users\mrali\Projects\ai-dev-os-stage20a-readonly-control-plane-20260826`;
- source branch: `feat/stage-20a-read-only-control-plane`;
- HEAD: `b331f1d8bb6edf094470522acd288aaa29916190`;
- tree: `6ae48559ddfef998f78fcef87014cfc7555c81f8`;
- parent: `83c72a06c1e2e446938c8e512ebaf5f296dae47a`;
- upstream and live remote equal to HEAD, divergence `0/0`;
- clean index and worktree, with no Git operation or lock; and
- hosted CI run `33232359972`, attempt 1, bound to that HEAD with all seven
  jobs successful.

Stage 18 evidence remained `ANT-02=proven`, `AM-02=proven`,
`INT-01=proven`, `developmentAccepted=true`, `stage20AEligible=true`,
`productionAdmitted=false`, and `PLN-02` incomplete. The C0-C5 ADRs and
checkpoint evidence were present. C6 was isolated in worktree
`C:\Users\mrali\Projects\ai-dev-os-stage20-project-contracts-20260829` on
branch `feat/stage-20-project-contracts`; the source worktree and branch were
not modified.

The Stage 18 published-descendant verifier continues to pass with published
HEAD `f90a779fce8c14cb6c4c3166ed89b0af5355b660`, published tree
`f4a0035c03150970f700435af64cd2bd4e0968e4`, and aggregate SHA-256
`0cb4729cc4211dca11ef1f166ccd4340ad82db4ba50310c6b5e97244fcbd1d66`.

## Input reviews and design reconciliation

Both external reviews apply only to the sealed C3-C5 input:

- Fable input: 11,121 bytes, SHA-256
  `d676f8c0d0b0197b99fe98f33dfc9d8f903f14efcf0afb28ad073b9afe2e8dd9`,
  PASS with zero must-fix findings; and
- Opus input: 20,976 bytes, SHA-256
  `0509cc2d0a6dfc78a4c79962a0b361a39d72f0cd5f54f32a08c9213d94e758c1`,
  PASS with zero must-fix findings.

Their complete reports, the architecture dossier, the reconciliation dossier,
existing ADRs, repository conventions, and the current domain, policy,
scheduler, process-broker, secrets, and `RUN_STATUSES` contracts were read
before design. ADR 0040 records each material reconciliation rather than
silently choosing between source documents. In particular:

- all 21 canonical records are present and `ProjectStop` is the separately
  accepted 22nd parser-registry record;
- `ProjectSummaryProjection` is derived and not a persistence record;
- durable `Project.status` remains three-state, while active project-stop data
  derives summary word `stopped` without changing global stop semantics;
- plan successors have a new identity, gap-free revision, and explicit
  predecessor rather than mutating one identity in place;
- `AgentRun`, `Handover`, `Decision`, `EvidenceRecord`, `Deliverable`,
  `Blocker`, and `ProjectStop` include the revision/state/binding facts needed
  by the reviewed state and stale-reference rules;
- budget-extension decisions bind an exact task, plan identity, and plan
  revision and remain decisions rather than payments;
- only actually expired usage windows derive `reset-passed`; malformed,
  future, or inconsistent evidence derives unavailable;
- the current structured `SecretRef` union wins over an older string sketch;
  a local pure structural parser is compile-checked by type-only import; and
- the complete future approval vocabulary is declarative only and does not
  modify the current policy package's enforcement tables.

The dossier's prospective ADR 0037 maps to repository ADR 0040 because live
ADRs 0037-0039 were already occupied.

## Contract and authority boundary

The package registry contains `Project`, `ProjectBrief`, `Constraint`,
`ProjectPlan`, `PlanStage`, `Task`, `Dependency`, `AgentRun`, `Session`,
`Handover`, `Decision`, `ApprovalRequest`, `SpendingRequest`, the existing
`UsageReservation` shape, `EvidenceRecord`, `Deliverable`, `Blocker`,
`Notification`, `CommunicationThread`, `ExternalIntegration`,
`ProjectHealthProjection`, and the accepted `ProjectStop` addition. It also
exports `ProjectSummaryProjection`, session display state, plan and approval
display words, and usage display derivation. Accepted values
`operator-paused` and `budget-extension-accepted` do not claim a suspended
provider process, payment, or executed effect.

Parsers require exact shapes and schema versions; bounded NFC strings and
arrays; finite enums; canonical timestamp text in the inclusive years
2000-9999; exact identity prefixes; duplicate-free and internally consistent
references; structurally exact unions; explicit workload class; and explicit
authority. A bounded JSON scanner refuses duplicate keys before
materialization. Canonical serialization refuses accessors, symbol keys,
sparse arrays, exotic objects, cycles, non-finite numbers, prototype-pollution
shapes, and unsupported values without invoking hostile getters. Refusals use
a closed safe taxonomy, collapse proxy/reflection failures and forged thrown
errors, expose only package-owned root paths, and do not echo rejected input or
caller-supplied diagnostics. Nested canonical JSON strings are NFC-normalized
and reject zero-width/control text.

Content-derived handover, decision, and evidence identities have exact
namespace and digest shape. The separate pure identity assertion checks them
against an independently computed full digest. C6 ratifies the six P-2
conditions but exposes no scheduling-authorization or scheduling-eligibility
predicate. Their complete decision requires C9-owned authoritative
specification, coverage, project-ceiling, candidate-requirement, and scope-
approval records bound to the exact project, plan identity/revision, plan
digest, and candidate set. State text, caller booleans, digest-shaped strings,
and cross-plan or cross-project approvals grant nothing in C6.

Model-origin data always has `authority:"none"`; model-origin hard constraints
are structurally impossible. Handovers may reference approval records but do
not contain transferable authority. Provider session and transcript/chat
references are data or audit/display links only. Removing those transcript
references cannot change parsing of durable records, transitions, or
projections. A README or model response is never an operator objective.
`SpendingRequest` cannot purchase, and no record is executable.

Both Normal and Developer projections expose `authority:"none"` and an empty
command tuple. Normal is an explicit recursive product subset that omits
developer-only identifiers, health source-sequence, stale-reason, and blocking-
rule fields while retaining product-required freshness truth: health
`computedAt` and summary `confidence`, `sourceSequence`, and `computedAt`.
Developer returns only a re-parsed canonical projection; callers cannot supply
arbitrary diagnostic objects. Mode never changes authority or available actions.

Blocker, notification, and needs-you copy is selected from finite typed
serializers. Actionable deep links use exact authenticated own-app route and
parameter unions. Free model prose, paths, digests, usage numbers, code,
secrets, arbitrary routes, URLs, and extra parameters are refused.

## State machines and projections

Explicit total tables cover project, plan, task, agent-run, session, handover,
approval, spending, blocker, and notification-delivery lifecycle. Every
state/event cell has exactly one legal next state or one finite illegal-cell
refusal. Terminal states and deterministic revision progression are explicit.
Contract-layer recovery produces data directives only; it does not start a
timer, retry, lease, recovery loop, or process. Uncomfortable states including
`termination_unconfirmed`, `lost`, `orphaned`, `abandoned`, and `rejected`
remain representable.

Pure exhaustive projections cover the full `(task state x blocker kind or
null)` product into the scheduler-owned `RunStatus`, all documented session
display states, project health and summary, plan and approval words, and the
active/inactive/stale/unavailable/ambiguous usage distinctions. Compile-time
`never` guards are paired with independently owned expected inventories and
runtime fixtures; test expectations do not import or restate production
transition tables. A complete session-product oracle verifies that stopping,
unconfirmed, lost, orphaned, and other live safety states precede contradictory
run-terminal copy. Usage failure/invalid evidence precedes ambiguity,
staleness, and expiry so an invalid expired snapshot cannot render as reset-
passed.

All legal approval state edges produce a parseable durable record, including
approved or partially consumed approvals that later expire or are voided while
preserving their decision history. `UsageReservation` mirrors its scheduler
owner for all four states: `reconciled` and `released` both require actual usage
and reconciliation time. Every write scope or code-edit capability requires a
managed worktree. Handovers require canonical repository revisions, coherent
result/disposition fields, and completed evidence closure. Briefs, handovers,
decisions, and evidence refuse self-supersession; prior-record and supplied-
history guards reject wrong lineage and cycles.

## Package boundary and changed inventory

`@ai-dev-os/project` has zero runtime dependencies. Its domain, policy,
scheduler, process-broker, and secrets references are development-only
type imports that compile out. Emitted JavaScript has no internal workspace
import. Production source has no filesystem, network, process, environment,
Git, database, credential, provider, Electron, child-process, timer,
ambient-clock, registration, background-work, or mutable-global capability.
`PROJECT_PRODUCTION_ENABLED` is literal `false`; runtime capabilities and
available commands are empty.

The C6 source inventory is limited to:

- `packages/project/` package manifest, README, TypeScript/Vitest configuration,
  pure source modules, six focused test modules, fixtures, and packed-consumer
  verifier;
- `docs/adr/0040-canonical-project-contracts-and-project-spine.md`;
- this checkpoint evidence;
- scoped updates to root README, technical design, product direction, and
  implementation roadmap; and
- the root lockfile entries for the new workspace package's type-only
  development links.

There is no change under a persistence package, no new `AGGREGATE_TYPES`, and
no migration.

## Validation evidence before publication

Lockfile-based dependency installation completed. The first scheduler
diagnostic after an intentionally script-disabled install produced three
native SQLite load failures because `better-sqlite3` had not been built. This
was an environment preparation failure, not a contract failure. The complete
first output was preserved; rebuilding that existing native dependency on the
unchanged candidate produced 155/155 scheduler tests passing. No test was
weakened or excluded.

Focused C6 results:

- typecheck: PASS;
- build: PASS;
- tests: 6 files, 71 tests, all PASS;
- coverage: PASS at 91.44% statements (1,293/1,414), 86.73% branches
  (935/1,078), 99.56% functions (230/231), and 95.81% lines
  (1,123/1,172);
- dry pack: 42 files, 79,154 bytes packed, 439,466 bytes unpacked, SHA-1
  `1d9642cef2c03eb73f643d1d6368b48222b8346b`, with no retained tarball; and
- clean packed consumer: PASS, 42 files and zero runtime dependencies.

Affected regression suites passed: API 49/49, control service 105/105, domain
120/120, scheduler 155/155, and the focused Stage 18 application acceptance
set 4/4. The complete root test matrix passed. Repository coverage targets
passed their maintained package thresholds; the final workspace target was
also observed independently at 114/114 tests with 90.66% statements, 81.21%
branches, 91.15% functions, and 92.63% lines. C6 coverage was rerun after the
11-finding repair, its focused regression additions, and the leakage-sentinel
split; the exact final pre-review counts are recorded above.

Dependency inspection passes; optional platform/browser Vitest packages are
reported only as optional. `npm audit --audit-level=high` reports zero
vulnerabilities. All 115 tracked or candidate JSON files parse strictly. The
Stage 18 descendant verifier passes. Static purity and forbidden-import tests,
including planted positive controls, pass. Leakage scanning finds no secret
shape in candidate files.

The first pre-commit root `npm run check` passed root typecheck and the entire
test matrix, then produced exactly one build refusal:
`CANDIDATE_BINDING_WORKTREE_NOT_CLEAN` from the existing Stage 18 candidate-
binding generator. That lifecycle guard intentionally refuses every dirty
published descendant and has no bypass; a C6 candidate cannot both be an
uncommitted review tree and satisfy it. The refusal was preserved and the
guard was not changed. After independent review, the reviewed tree is committed
first, then the full root check is rerun on that same clean tree before push.
The terminal handoff reports that observed clean-tree result, final Markdown/
local-link and diff checks, independent-review verdict, commit/tree identity,
and exact-head CI rather than projecting them in advance.

## Initial independent candidate review and repair

Independent read-only reviewer Plato examined the complete initial staged C6
candidate at tree `e60c0cb6f39ebdc0d7a3e0d0ab9cf4919daaf003`. The review
started and ended on that exact tree with 28 staged paths, zero unstaged paths,
zero untracked paths, zero unmerged paths, and a passing diff check. It reran
the focused typecheck and then-current 58-test suite, read the complete task,
baseline reviews, design/reconciliation dossiers, source, tests, package, ADR,
and evidence, and returned **FAIL with 11 must-fix findings**. No commit was
made from that failed candidate.

The findings and implemented dispositions are:

1. Public validation reflection and caller paths could surface raw proxy
   failures or caller text. Records/arrays now use bounded descriptor snapshots;
   canonicalization and every public parser collapse hostile reflection,
   forged errors, and caller paths to finite package-owned refusals.
2. Blocker/notification copy and deep links admitted free text and broad route
   data. Finite typed copy serializers and exact own-app route/parameter unions
   now reject model text, paths, digests, usage, code, secrets, URLs, and extras.
3. The generic presentation wrapper returned the same unconstrained value in
   both modes. It is now a closed health/summary union with explicit recursive
   Normal subsets and strict canonical Developer values.
4. Run terminal words preceded session safety. The full product now gives live
   session state precedence, with terminal success/failure used only when the
   session is absent or confirmed stopped.
5. Expiry preceded usage failures. Failure/invalid, ambiguity, and staleness
   now fail closed before a coherent expired-window word.
6. Released reservation accounting disagreed with the scheduler owner. Both
   released and reconciled now require actual usage plus reconciliation time,
   with parity tests for all four statuses.
7. Expired/voided approvals discarded reachable decision history. The parser
   now permits and validates preserved decision/partial-consumption evidence;
   every legal state edge produces a parseable result fixture.
8. Write-capable tasks could name `workspaceMode:"none"`. Any non-none edit
   scope or `code-edit` capability now requires a managed worktree.
9. Immutable content could self-supersede and lacked prior-record checks. Four
   parsers refuse self-reference; brief, handover, decision, and evidence
   lineage assertions plus a supplied-history cycle guard cover replacement.
10. Handover Git/result/evidence bindings were loose. Base/result revisions,
    disposition/result coherence, acknowledgement ordering, and completed-claim
    evidence closure were tightened; the next review found the branch subset
    still incomplete, as recorded below.
11. The plan predicate checked only state/seal/digest while claiming scheduling
    authorization. The first repair renamed and expanded it, but the next review
    proved that caller assertions and unbound evidence still bypassed it. The
    final disposition is recorded below.

The reviewer also advised normalizing nested canonical JSON strings; that
non-blocking improvement and focused tests are included. This disposition list
does not claim a repaired-tree PASS. The complete repaired staged tree must be
sent to the same independent reviewer for a fresh exact-byte review, and any
new must-fix finding must repeat the repair/re-review loop before commit.

## Second independent candidate review and repair

The same independent reviewer examined the repaired staged tree
`534aef3b487f471c8b1176b5fe9880741aae0b56`. Start and end identities matched:
29 staged paths, zero unstaged, untracked, or unmerged paths, and a passing diff
check. Its no-emit TypeScript check passed. The reviewer returned **FAIL with
three must-fix findings**, so that tree was not committed or published:

1. Normal health omitted `computedAt`; Normal summary omitted `confidence`,
   `sourceSequence`, and `computedAt`. The explicit Normal schemas and recursive
   freeze functions now retain those product-required freshness fields, with
   focused health and summary assertions. Authority and commands remain equal.
2. A state-only function still claimed scheduling authorization, while the
   replacement P-2 proof accepted caller assertions and did not bind all
   evidence or cross-plan/cross-project scope approvals. C6 cannot soundly make
   that decision before C9 owns the authoritative specification, coverage,
   project-ceiling, candidate-requirement, and approval-binding records. The
   state helper, proof type/parser, and eligibility function were removed. API,
   source-policy, unknown-field, unsealed-plan, and cross-project/cross-plan
   adversarial tests prove that C6 exposes no such decision surface or command.
3. Handover branch validation admitted trailing-dot and dot-prefixed components
   and `.lock` components before a later slash. The pure parser now uses a
   documented conservative ASCII subset with component-wide checks, and tests
   cover the reproduced inputs plus the remaining forbidden Git characters and
   component forms.

This disposition does not claim a new-tree PASS. The newly staged exact bytes
must complete a fresh independent review before commit or publication.

## Inherited maintenance debt

The following C3-C5 advisories are recorded unchanged. C6 does not touch their
mechanisms and does not claim to resolve them:

1. manually enumerated static-policy source list;
2. lexical temporary-root scan;
3. possible empty task-owned directory after failed identity validation;
4. over-broad smoke-test title;
5. finite out-of-Date-range timestamp precision;
6. 2099 fixture horizon;
7. “provider dispatch” versus “real-provider dispatch” wording;
8. prefix-only embedded-path copy guard;
9. missing recursive Normal-subset test;
10. imprecise `usage.future.refused` reachability wording;
11. approval dictionary lacking a compile-time `satisfies` guard;
12. clock-skew spy precision;
13. declaration/runtime route-table parity;
14. hand-maintained route count;
15. Node-owned bare 503 at the per-socket ceiling; and
16. Windows symlink-test EPERM skip behavior.

None widens C6 authority. Any new C6 advisory from the exact-candidate review
is reported in the terminal handoff; no PASS is claimed here before it exists.

## Resource discipline, nonclaims, and next boundary

Drive C free space at task entry was 104,600,780,800 bytes. Coverage directories,
compiler output, package residue, packed-consumer roots, and task-owned
temporary roots are removed after final validation only after resolving each
target inside this exact worktree or proving its task ownership. The terminal
handoff reports final free space, temporary disk growth, and the exact remaining
task-owned process/listener/temp residue count.

No real project, task, agent, provider, session, credential, vault, Account
Manager, network listener, desktop host, or production action occurred. No PR,
merge, rebase, force-push, tag, release, machine installation, C7 work, C8/C9
work, Stage 20B command work, or Stage 21 work occurred. Production remains
disabled, `PLN-02` remains incomplete, and `productionAdmitted=false`.

The smallest safe next action after a successful exact-head C6 publication is
a separately authorized C7 persistence checkpoint. C7 must land alone and
re-prove memory, SQLite, and PostgreSQL aggregate contracts; it is not part of
this checkpoint.
