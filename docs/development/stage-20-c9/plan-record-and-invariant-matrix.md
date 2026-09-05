# Plan record and invariant matrix

Status: `[REBOUND PROPOSAL]`. Machine form:
`plan-record-and-invariant-matrix.json`. Active input is published C8 HEAD
`1bfe9769d662a45a7e4b7f114a016328476d5215`, tree
`5fd1a3dc8f5593e76fd96cdbbec2e830502f76d3`.

Every invariant is machine-checkable. The **Owner** column says who enforces
it today: `C6` = already enforced by `@ai-dev-os/project` (C9 re-proves it at
its own layer but adds nothing), `C9` = new work in `@ai-dev-os/plan`,
`later` = out of C9's scope and named. No invariant invents a field that
conflicts with a parser; every C9 invariant is expressible with the existing
record shapes plus journal-event payloads.

## 1. Project

| # | Invariant | Owner | Check |
| --- | --- | --- | --- |
| PR-1 | `projectId` matches `^prj:` and the identifier pattern | C6 | `parseProject` |
| PR-2 | Every payload C9 touches carries the same `projectId`; the `project-plan` aggregate ID equals that `projectId`; the separately derived decorated/hash-based `project-brief` aggregate ID is correlated through its validated acceptance proof and is **not** equated to `projectId` | **C9** | exact comparisons at every entry point; `plan.project.mismatch` |
| PR-3 | `Project.status` is `active` before C9 will write anything; `paused` and `archived` refuse. The concrete commit adapter re-reads and parses the current `project` aggregate **inside the same C7 transaction**; no request-carried project value is accepted. Before promote, scope-approval escalation, or seal, its aggregate version/content digest must also equal the assembly basis in the proven head event; mismatch is `plan.proposal.stale`. Draft/redraft/revision reassemble from the current Project; terminal cleanup and audit-only annotation are exempt only from basis equality | **C9** | transactional `parseProject`; `plan.project.not-active` or `plan.proposal.stale`, with zero writes |
| PR-4 | An active `ProjectStop` (`resumedAt === null`) refuses every C9 write. The adapter completes its bounded in-transaction current-stop query, parses every matching head through `parseProjectStop`, and calls `isProjectStopActive`; request bytes cannot assert absence | **C9** | transactional control snapshot; active stop → `plan.project.stopped`; invalid/malformed/repeated/non-advancing/empty-continuation pagination → `plan.store.cursor-invalid`; malformed envelope/payload/checksum → `plan.store.corrupt`; adapter failure/bound exhaustion → `plan.store.unavailable`; every refusal writes nothing |
| PR-5 | The global emergency stop is **not** consulted, engaged, or asserted by C9 — it does not exist yet (C12) | C9 (by absence) | static-policy: no e-stop symbol in C9 source |
| PR-6 | `Project.repositoryRoots` are absolute canonical paths and never leak into a Normal projection | C6 + **C9** | `absoluteCanonicalPath`; Normal leakage corpus |

## 2. ProjectBrief

| # | Invariant | Owner | Check |
| --- | --- | --- | --- |
| BR-1 | `origin` is the literal `"operator"`; a model cannot author a brief | C6 | `parseProjectBrief` |
| BR-2 | `revision` is literal `1`; accepted lineage position is `AggregateEnvelope.aggregateVersion` | C6 + C8 | `parseProjectBrief` plus accepted-head proof |
| BR-3 | Every G1–G7 read proves the current aggregate/event binding over project ID, independently derived aggregate ID, aggregate version, brief ID, `briefContentDigest`, `acceptedCandidateDigest`, acceptance-event ID, parsed event payload, and envelope/event correlations | **C9 composition** | `accepted-brief-binding.md` §§1–5; stale → `plan.brief.superseded`; malformed/missing proof → `plan.brief.acceptance-proof-invalid` |
| BR-4 | `ProjectPlan.briefRevision` is written as the literal `1` and any other value refuses, despite C6 accepting integers ≥1 | **C9** | `plan.brief.revision-not-one` (CG-01) |
| BR-5 | The independently recomputed canonical `briefContentDigest` equals the bound value, separate from the event's accepted-candidate digest, and the acceptance event remains proof-valid | **C9** | mismatch → `plan.brief.content-digest-mismatch`; proof failure → `plan.brief.acceptance-proof-invalid` |
| BR-6 | Published C8's parsed acceptance event already proves no blocking open question; C9's frozen defence scans only durable `openQuestions[].blocking` booleans on the acceptance-proven parsed brief. It never reconstructs C8's five ephemeral candidate bases; fixtures cover each upstream basis through C8 resolution/acceptance | **C8 + C9** | `plan.brief.blocking-unanswered`; parser/predicate conformance fixtures B-16 |
| BR-7 | A brief `Constraint` with `enforcement: "hard"` has a non-null `machineForm` | C6 | `parseConstraint`, bidirectional |
| BR-8 | A `Constraint` with `origin: "model"` is advisory and `authority: "none"` | C6 | `AUTHORITY_VIOLATION` |
| BR-9 | Brief prose never becomes plan prose without provenance: no `objective`, `outcome`, `nonGoal` or `assumption.text` string is copied into **any of the six authority-bearing paths** — `stage.title`, `stage.intent`, `stage.exitCriteria[]`, `task.title`, `task.objective`, `task.acceptance[].criterion` (PV-6's set) — unless the proposal marks it `derivedFrom` that exact field. Narrower than the six would let brief prose reach `stage.exitCriteria[]` under a `model` label unchecked | **C9** | provenance binding, section 3 of `proposal-provenance-and-trust-boundary.md` |
| BR-10 | The brief is read, never written, through the narrow `readAcceptedBriefHead` result (`absent`, `accepted`, `invalid-proof`, `unresolved`) | **C9** | port exact-key/static-policy tests; isolated test composition validates with `parseIntakeAcceptanceEvent`, while production application wiring is deferred |

## 3. ProjectPlan

| # | Invariant | Owner | Check |
| --- | --- | --- | --- |
| PL-1 | Exact 21-key shape; no extra or missing key | C6 | `exact(...)` |
| PL-2 | `origin: "model"`, `authority: "none"` — both literal | C6 | `parseProjectPlan` |
| PL-3 | `(revision === 1) ⟺ (supersedes === null)`; no self-supersession | C6 | `parseProjectPlan` |
| PL-4 | `planDigest` equals SHA-256 of `planDigestMaterial(plan)`, verified on **every** read and before **every** write | **C9** | `assertPlanDigest` with an independently computed digest (C6 stores but never checks it) |
| PL-5 | Stage ordinals are gap-free `1..N` in the assembled plan | **C9** | `plan.stage.ordinal-not-dense` (C6 only requires uniqueness) |
| PL-6 | `stages` are stored sorted by `ordinal` ascending; `tasks` sorted by `(stage ordinal, taskId)`; `dependencies` sorted by `(fromTaskId, toTaskId, kind, artifactKind)` | **C9** | canonical-order assertion; makes the record byte-deterministic |
| PL-7 | For a non-null validated `SpecificationBinding`, `specificationRef` is exactly `"spec:" + expectedSpecificationDigest.slice(0, 32)` and `coverageRef` is exactly `"coverage:" + expectedCoverageDigest.slice(0, 32)`; the binding and assembled plan carry the same two values. The distinct upstream `product-specification:*` ID remains in `SpecificationBinding.specificationId` | **C9** | C6 enforces no prefix or derivation; digest mutation and reference-substitution fixtures (CG-09, PV-19) |
| PL-8 | `specificationRef` and `coverageRef` are both non-null iff the validated `SpecificationBinding` is non-null; otherwise both are null. A plan cannot claim a specification without its coverage or carry detached references | **C9** | `plan.specification.incoherent` |
| PL-9 | Seal metadata, stated so it does not contradict PL-11: `state === "sealed"` ⇒ `sealedAt !== null`; `state ∈ {drafting, clarifying, proposed, awaiting_scope_approval, rejected, abandoned}` ⇒ `sealedAt === null`; `state === "superseded"` ⇒ `sealedAt` is byte-identical to the predecessor's, whether that is null (superseded from `proposed`) or non-null (superseded from `sealed`). C9 never produces the five execution states | **C9** (stricter than C6 except for `superseded`, which C6 leaves free in both directions) | `plan.seal.metadata` |
| PL-10 | Every `ProjectPlan` written by C9 has `sealedByApprovalId === null`. A synthetic consumed approval may satisfy the pure condition-6 evaluator in tests, but C9 owns no `scope-approval-consumed` transition and that fixture never reaches persistence. Non-null durable metadata is reserved for the later C10 composition | **C9** | `plan.seal.approval-binding` |
| PL-11 | A real supersede preserves `sealedAt`/`sealedByApprovalId` byte-identically. On the `plan.superseded` discard path the subject is the committed record; on either `plan.revised` mode it is the `PlanPredecessorStamp` produced from the legal post-fold superseded predecessor. A `plan.drafted` redraft does **not** supersede its drafting predecessor: its `PlanDraftReplacementStamp` instead preserves that predecessor's null seal fields and truthfully records `state: "drafting"` | **C9** | tests M-10, P-19, P-24 |
| PL-12 | `budgetCeiling` is componentwise ≤ the resolved project ceiling and, when the budget account has a token budget, `maximumInputTokens + maximumOutputTokens` is ≤ its hard `maxTotalTokens` (implemented by checked subtraction) | **C9** | P-2 condition 5, sections 9 and 9.1 |
| PL-12b | Every write is checked by one explicit state/postcondition rule. Operations with an L1 edge must equal that fold. First create has no predecessor and must commit `PLAN_STATE_MACHINE.initial` (`drafting`). Redraft has no L1 edge and must replace an exact `drafting` predecessor with a new `drafting` record under the explicit create-versus-redraft/mode oracle. `plan.revised` first folds the `proposed`/`sealed` predecessor to `superseded` and stamps that exact post-fold result, then commits the distinct new head at `drafting`. `plan.budget-extended` advances no head and must preserve the plan byte-identically. No record write or annotation is unguarded | **C9** | `plan.state.illegal`; tests P-24, P-35 |
| PL-13 | The serialized canonical payload is ≤ `MAX_PAYLOAD_TEXT_LENGTH` (10,000,000 chars) | C7 + **C9** | pre-checked by C9 so the refusal is a plan refusal, not a storage failure |
| PL-14 | All prose fields are free of bidi overrides and isolates (`U+202A–202E`, `U+2066–2069`) | **C9** | `plan.text.bidi`; C6 rejects only control/zero-width (mirrors C8's `intake.text.bidi`) |
| PL-15 | `createdAt`/`updatedAt`/`sealedAt` are supplied by the caller, never read from an ambient clock | **C9** | static-policy: no `Date.now`, no `new Date()` |
| PL-16 | A plan read from the store re-parses successfully; a parse failure is `CORRUPTION_DETECTED`-class, not a validation refusal | **C9** | `plan.store.corrupt` |
| PL-17 | `state === "sealed"` ⇒ a non-null, non-empty validated `SpecificationBinding` and its exact PL-7 references (therefore both plan references are non-null by PL-8). Without it, seal conditions 3 and 6 are **vacuously satisfied** and a wholly model-invented plan seals. A null binding with both references null stays legal for `drafting` and `proposed` | **C9** | `plan.specification.absent` (SB-8) |
| PL-18 | Every complete plan is re-derived at the raw commit boundary, with the oracle dispatching on event kind **and** `operation.mode`. First draft uses revision 1/null supersedes and no predecessor/link. Same-brief redraft preserves the head's brief/revision/supersedes, stamps the exact drafting predecessor, and byte-copies its prior R2 link. Stale-draft R2 redraft resets to revision 1/null supersedes and carries an exact drafting replacement stamp plus fresh draft-replacement link. Revised R1 uses the same brief, head revision + 1, head plan ID as `supersedes`, a post-fold superseded stamp, and null rebase; revised R2 uses the later brief, revision 1/null supersedes, the post-fold superseded stamp, and a fresh superseding link. All five assembly branches use the embedded parsed request, transactionally parsed current Project (including task `dataClassification`), and store-owned coordinates; every other operation equals its literal field-delta transform. Promote, scope-approval escalation, and seal additionally bind the current Project version/content digest to the proven head event's assembly basis. Equality covers all 21 plan keys and complete event material | **C9** | `deriveExpectedPlanMutation`; raw-JavaScript substitution and Project-drift tests P-35 |

## 4. PlanStage

| # | Invariant | Owner | Check |
| --- | --- | --- | --- |
| ST-1 | `stageId` prefix `stg:`, unique within the plan | C6 | `parseProjectPlan` |
| ST-2 | `ordinal` unique within the plan | C6 | `parseProjectPlan` |
| ST-3 | `taskIds` is a one-to-one partition of the plan's tasks | C6 | `REFERENCE_INCONSISTENT` |
| ST-4 | `exitCriteria` ≥ 1 and `exitEvidenceKinds` ≥ 1 | C6 | `parsePlanStage` |
| ST-5 | Stage count ≤ `PLAN_LIMITS.maxStages` (C9-owned, ≤ 1,024) | **C9** | `plan.graph.too-many-stages` |
| ST-6 | Tasks per stage ≤ `PLAN_LIMITS.maxTasksPerStage` | **C9** | `plan.graph.stage-too-large` |
| ST-7 | Stage order is consistent with the dependency graph, **over ordering edges only** (`finish-to-start` and `artifact`): no such dependency points from a task in stage ordinal *i* to a task in stage ordinal *j* with `j < i`. `advisory` edges are deliberately exempt, so an advisory edge can never constrain stage placement — the same reason DP-11 excludes them from the topological order | **C9** | `plan.graph.stage-order-inconsistent` — prevents a plan whose stage numbering contradicts its own edges |
| ST-8 | Every `exitEvidenceKind` is a bounded ≤128-char kind string, and none of them is treated as satisfied at plan time | C6 + **C9** | evidence is an execution-time fact; C9 records the requirement only |
| ST-9 | `gate: "operator-review"` creates no approval and no blocker at plan time | **C9** | static: C9 emits no `ApprovalRequest`, no `Blocker` |

## 5. ProjectTask

| # | Invariant | Owner | Check |
| --- | --- | --- | --- |
| TK-1 | `taskId` prefix `tsk:`, unique within the plan; `stageId` exists | C6 | `parseProjectPlan` |
| TK-2 | `editScope !== "none"` ⇒ `capabilities` includes `code-edit` | C6 | `INVARIANT_VIOLATION` |
| TK-3 | repository-write capability ⇒ `workspaceMode === "worktree"` | C6 | `AUTHORITY_VIOLATION` |
| TK-4 | `acceptance` ≥ 1 criterion | C6 | `parseProjectTask` |
| TK-5 | **`state === "pending"` and `stateRevision === 1` for every task in a plan C9 writes** | **C9** | `plan.task.not-pending` — the structural "sealing runs nothing" guard |
| TK-6 | All five execution-policy fields are explicit C9 literals, not C6 defaults or caller inputs: `retry={maximumAttempts:1,initialBackoffMs:0,maximumBackoffMs:0,retryableFailures:[]}`, `timeout={dispatchMs:1,attemptMs:1}`, `priority="normal"`, `workloadClass="general"`, and `handoverPolicy={requires:"none",acceptFrom:[],maximumAgeMs:null}` | C6 (required shapes) + **C9** | assembly equality and PV-15 |
| TK-7 | `requirements.risk` and `requirements.complexity` are present and explicit | C6 | `parseTaskRequirements` |
| TK-8 | `budget` is componentwise ≤ the plan `budgetCeiling` | **C9** | `plan.budget.task-exceeds-ceiling` |
| TK-9 | The componentwise sum of all task budgets is ≤ `budgetCeiling` | **C9** | `plan.budget.sum-exceeds-ceiling` — an honest ceiling, not a per-task one |
| TK-10 | `idempotencyClass: "irreversible"` or `"approval-bound"` ⇒ the plan cannot seal without either the corresponding approval binding or an explicit operator `Decision(conflict-resolution)` recording that the task will require approval at dispatch | **C9** | `plan.task.irreversible-unbound` — keeps "the plan promised nothing dangerous" honest |
| TK-11 | `handoverPolicy.acceptFrom` names only task ids that exist in the same plan and are upstream in the dependency graph | **C9** | C6 checks the prefix only; `plan.task.handover-source-unknown` |
| TK-12 | `requirementIds` are non-empty for every task whose stage has a `required` coverage obligation | **C9** | traceability, P-2 condition 3 |
| TK-13 | `expectedOutputSchema` is a canonical `JsonObject` with no prototype-pollution shape | C6 | `jsonObject` → `canonicalizeProjectJson` |
| TK-14 | `acceptance[].validationCommand`, when present, is ≤256 arguments of ≤32,768 chars each, and is **never executed** by C9 | C6 + **C9** | static-policy: no process import anywhere |
| TK-15 | No task names a provider, model, profile, account, or credential | **C9** | `plan.task.provider-fact` — routing is the scheduler's at dispatch |

## 6. Dependency

| # | Invariant | Owner | Check |
| --- | --- | --- | --- |
| DP-1 | Both endpoints exist in the plan's task set | C6 | `REFERENCE_INCONSISTENT` |
| DP-2 | No self-dependency | C6 | `parseDependency` |
| DP-3 | `kind === "artifact"` ⟺ `artifactKind !== null` | C6 | bidirectional |
| DP-4 | The `(from, to, kind, artifactKind)` tuple set is duplicate-free | C6 | `DUPLICATE_IDENTIFIER` |
| DP-5 | **No cycle** | C6 | the DFS inside `parseProjectPlan` (the `assertPlanDag` helper is module-private and not importable) |
| DP-6 | **Deterministic topological order** exists and is computed by a total, tie-broken algorithm: Kahn's algorithm with a min-heap keyed on `(stage ordinal, taskId)` | **C9** | `computePlanOrder(plan)` is a pure total function; equal inputs give byte-identical output regardless of array order |
| DP-7 | Graph depth (longest path in edges) ≤ `PLAN_LIMITS.maxDepth` | **C9** | `plan.graph.too-deep` — enforced by neither C6 nor task-graph for a `ProjectPlan` (CG-07) |
| DP-8 | Per-task out-degree and in-degree ≤ `PLAN_LIMITS.maxFanOut` / `maxFanIn` | **C9** | `plan.graph.fan-out` / `plan.graph.fan-in` |
| DP-9 | Total edge count ≤ 1,024 (the C6 array bound) and pre-checked so the refusal is a plan refusal | C6 + **C9** | `plan.graph.too-many-dependencies` |
| DP-10 | No duplicate *edge pair* even across differing `kind` — at most one dependency per ordered task pair, so the graph is simple | **C9** | C6 allows `(A,B,finish-to-start)` and `(A,B,advisory)` simultaneously; C9 refuses `plan.graph.parallel-edge` for determinism and reviewability |
| DP-11 | An `advisory` dependency is **not** an ordering constraint: `computePlanOrder` ignores it (DP-6) and ST-7 exempts it. It is still counted for the cycle check (DP-5), the edge-count bound (DP-9), the degree bounds (DP-8) and the parallel-edge rule (DP-10), so it can neither hide a cycle nor escape the graph budget | **C9** | documented and tested; prevents an advisory edge from silently gating work while keeping it inside every bound |

## 7. Constraint, Decision, Blocker, Deliverable, EvidenceRecord, UsageReservation

| # | Invariant | Owner | Check |
| --- | --- | --- | --- |
| CN-1 | Every brief `Constraint` has an explicit **disposition** in the plan: `satisfied-by-design`, `enforced-by-task`, `waived-by-decision`, or `not-applicable` — recorded in common `PlanReviewEvidence` on every journal event, keyed by `constraintId`, and copied byte-for-byte after first-draft/redraft/revision derivation | **C9** | `plan.constraint.no-disposition`; a constraint that is silently ignored cannot seal, including after reopen |
| CN-2 | Every `enforcement: "hard"` constraint has a `machineForm` **and** a C9-recognised machine-form schema for its `kind` | **C9** | P-2 condition 4; `plan.constraint.machine-form-unrecognised` (CG-06) |
| CN-3 | A `waived-by-decision` disposition names an operator `Decision(waiver-granted)` whose `scope` binds the exact `planId` and `planRevision` **and whose bytes match the private payload of the issued commit authorization**; `decidedBy` alone is not authentication | **C9** | `plan.constraint.waiver-unbound` |
| DC-1 | Decision ids are `dec:` + first 32 hex of an independently computed SHA-256, asserted by `assertContentDerivedIdentity` | C6 | `DIGEST_MISMATCH` |
| DC-2 | `decidedBy` is never `"model"` — structurally impossible | C6 | closed enum |
| DC-3 | Every C9 decision binds `scope.planId` **and** `scope.planRevision`, and the staleness predicate is the **pair**: a decision whose `scope.planId` **or** `scope.planRevision` differs from the current plan's refuses as stale. Both halves are load-bearing: every redraft mints a new `planId`; an ordinary same-brief redraft preserves `revision`/`supersedes`, while a stale-draft R2 redraft resets them to 1/null. Thus a revision-only predicate can let a decision bound to the replaced draft survive whenever its revision happens to equal the replacement's, even though its task set may differ | **C9** | `plan.decision.stale-binding` (ADR 0040 requires this for `budget-extension-accepted`; C9 applies it to all plan decisions) |
| DC-4 | `budget-extension-accepted` is operator-only and binds exactly one `taskId` plus the exact `planId`/`planRevision` | ADR 0040 + **C9** | `plan.decision.budget-extension-shape` |
| DC-5 | C9 emits only the seven plan-time decision kinds; the other six refuse. The same rule also refuses one of the seven carried on the wrong event, under a total, single-valued map — each kind rides exactly one event (`plan-persistence-and-idempotency.md` §4): four kinds ride `plan.sealed`, and `scope-rejected`/`plan-revision-accepted`/`budget-extension-accepted` ride `plan.scope-rejected`/`plan.revised`/`plan.budget-extended` respectively. `plan.proposed` and `plan.scope-approval-required` carry no decision, so any decision on either refuses | **C9** | `plan.decision.kind-out-of-scope` |
| DC-6 | A supplied decision history is acyclic and duplicate-free | C6 | `assertAcyclicSupersession` |
| BL-1 | C9 creates **no** `Blocker`. Blockers are runtime observations; a plan-time blocker would be a fabricated fact | **C9** | static-policy: `parseBlocker` is never called constructively |
| BL-2 | Blocking items in a plan are never hidden: a plan that cannot seal reports every failing condition and every undisposed constraint, in a finite, ordered list | **C9** | `evaluateSealConditions` returns all six verdicts, never short-circuits |
| DL-1 | C9 creates **no** `Deliverable`. A stage declares `exitEvidenceKinds`; deliverables are produced by execution | **C9** | static-policy |
| DL-2 | A stage's `exitEvidenceKinds` are explicit and non-empty — the plan states what evidence will be required | C6 | `parsePlanStage` |
| EV-1 | C9 creates **no** `EvidenceRecord`. `EvidenceRecord.runId` is a required `run:` identifier and no run exists at plan time | C6 (structural) + **C9** | `context-pack-and-attachment-boundary.md` |
| EV-2 | Coverage claims supplied to C9 that cite evidence must cite evidence whose `producedBy` would satisfy `canEvidenceCloseRequirement`; operator- or provider-produced evidence cannot close a requirement | C6 helper + **C9** | `plan.coverage.evidence-insufficient` |
| UR-1 | C9 creates, reserves, releases or reconciles **no** `UsageReservation` | **C9** | static-policy: no scheduler runtime import |
| UR-2 | A plan's `budgetCeiling` is a *declaration*, not a reservation; no projection may render it as money held | **C9** | copy rule + projection test |

## 8. Project stops and the global emergency stop

| # | Invariant | Owner | Check |
| --- | --- | --- | --- |
| SP-1 | An active `ProjectStop` refuses every C9 write with `plan.project.stopped` | **C9** | PR-4 |
| SP-2 | C9 never engages, resumes, or reads through a `ProjectStop`'s effects; it only observes `resumedAt === null` | **C9** | static + test |
| SP-3 | C9 does not implement, reference, or claim the global emergency stop; the `emergency-stop` blocker kind is display vocabulary only | ADR 0041 + **C9** | static-policy |
| SP-4 | A stopped project's plan remains readable and its projection reports `stopped` via `ProjectSummaryProjection.status` without touching `Project.status` | C6 | `deriveProjectSummaryProjection` |

## 9. The six P-2 sealing conditions, made machine-checkable

`evaluateSealConditions(input)` returns a frozen six-slot verdict — never a
boolean, never short-circuited — so the operator sees everything that is
wrong at once. Each slot is `{condition, passed, ruleIds}`.

| Condition | Statement (canonical P-2) | C9 realization | Refusal |
| --- | --- | --- | --- |
| **1** | acyclic DAG | the DAG check **inside `parseProjectPlan`**, re-run at seal time on the exact stored bytes. Note: the helper `assertPlanDag` is module-private in `packages/project/src/parsers.ts` — it is not exported from `index.ts` and is absent from `dist/*.d.ts`, so C9 obtains the check only by calling `parseProjectPlan`, which it does on every read and before every write anyway | `plan.seal.condition-1` → `SEAL_CONDITION_FAILED {condition: 1}` |
| **2** | node, depth, **fan-in** and fan-out within configured bounds | `PLAN_LIMITS` = `{maxStages, maxTasks, maxTasksPerStage, maxDependencies, maxDepth, maxFanIn, maxFanOut}`, **all** ≤ the C6 array bounds, and compile-checked ≤ `TASK_GRAPH_LIMITS` **where a counterpart exists** — `maxStages` and `maxTasksPerStage` have none and are bounded by the C6 array limit alone (SP-9) | `plan.seal.condition-2` with the specific sub-rule id |
| **3** | every `required` requirement covered by a task or an authorized waiver | over the deterministically transformed `SpecificationBinding`: each row preserves upstream `decisionId`, digest, disposition, executable flag, and provenance; every non-null upstream `requirement-task:*` coverage ID maps exactly once to a unique in-plan `tsk:*`; each `required`/`expected-quality` requirement has that task or a plan-bound waiver whose complete Decision bytes match the issued host authorization. A caller-authored `decidedBy: "operator"` shape is not authorization. `delight-candidate` may carry a task but does not block when absent; `waived` requires a host-authenticated waiver and no task; other non-executable dispositions carry no task. **SB-8 requires a non-null, non-empty binding and unconditional reverse coverage of every in-plan task at seal** | `plan.seal.condition-3` |
| **4** | every `enforcement: "hard"` constraint carries a `machineForm` | C6 already makes this bidirectional at parse time; C9 additionally requires a **recognised machine-form schema** per constraint kind and a disposition (CN-1, CN-2) | `plan.seal.condition-4` |
| **5** | budget ≤ project ceiling | componentwise `plan.budgetCeiling ≤ resolvedProjectCeiling.ceiling` and, when `accountMaximumTotalTokens !== null`, `plan.budgetCeiling.maximumInputTokens ≤ total` then `plan.budgetCeiling.maximumOutputTokens ≤ total - input`. The exact evidence is recomputed inside the commit transaction from the current parsed budget-account aggregate plus the acceptance-proven brief schemas in §9.1; it is never accepted from request/event verdict bytes. TK-8/TK-9 also apply. **No decision relaxes this** | `plan.seal.condition-5` |
| **6** | material inferred scope requires a **consumed** `scope-expansion` approval | material inference is derived from preserved upstream provenance and task/stage provenance, including every unauthenticated `origin: "operator"` claim and SB-4c. The pure evaluator accepts an explicit `SealEvaluationInput.scopeApproval` for predicate testing. The durable C9 commit boundary always supplies literal `null`, independently recomputes the verdict, and requires byte equality with event verdicts; synthetic or caller-authored approvals cannot persist a seal before C10. **SB-8 independently requires a non-null, non-empty binding**. Evidence loss or capability mismatch fails `plan.coverage.provenance-inconsistent`; honest inference without approval fails `plan.seal.condition-6` | `plan.seal.condition-6` → `SEAL_CONDITION_FAILED {condition: 6}` |

**Condition 6 in the C9 world.** Approvals arrive in C10. The pure evaluator
accepts a parsed consumed approval only so the predicate can be unit-tested.
The durable commit path constructs its own `SealEvaluationInput` from trusted
transactional reads and passes `scopeApproval: null`; neither the request,
event, nor commit authorization has an approval slot in C9. The synthetic
matching record therefore cannot drive an L1 cell, invoke persistence, or
populate seal metadata. Since no approval can be consumed before C10, **any
plan containing material inferred scope simply cannot complete a C9 seal
transition.** That is the honest outcome. Invariant P-3
(auto-enter `awaiting_scope_approval`) makes it visible rather than silent.
This is **OD-C9-03**.

### 9.1 The project ceiling for condition 5

There is no ceiling field on `Project`. The serialized commit request carries
no authoritative ceiling. Inside the same C7 transaction as the proposed
write, the concrete adapter gets the current `Project`, follows its exact
`budgetAccountId`, reads that current `budget-account` aggregate, validates it
with the real domain parser, requires `status: "open"` and
`scope:{scopeType:"project",scopeId:projectId}`, and combines it with hard
budget constraints from the acceptance-proven brief. The resulting
`ResolvedProjectCeilingEvidence` contains a C9-owned five-component
`OrchestrationBudget`, the orthogonal
`accountMaximumTotalTokens: number | null`, the budget-account aggregate and
state versions/content digest, and the brief-content digest. It is recorded in
`PlanSealEvidence` for audit and recomputed before use. The total-token value
is evidence for condition 5, not a sixth serialized `OrchestrationBudget`
component.

The two source families are:

1. the resolved `AggregateBudget` for `Project.budgetAccountId`
   (`@ai-dev-os/domain`, type-parity import); and
2. hard `budget-money` / `budget-tokens` `Constraint`s from the accepted head
   brief, whose `machineForm` must match the C9 exact schemas
   `{currency,maximumCostMicros}` and
   `{maximumInputTokens,maximumOutputTokens,maximumToolCalls,maximumTurns}`.

When the account token budget is present,
`accountMaximumTotalTokens = maxTotalTokens`; its directional candidates are
`maxInputTokens ?? maxTotalTokens` and
`maxOutputTokens ?? maxTotalTokens`. When it is absent, the account supplies no
token candidate and `accountMaximumTotalTokens = null`. Each resolved
input/output component is the minimum of all present finite account and hard-
brief candidates; no candidate means zero. Cost uses the account hard money
limit and same-currency hard-brief candidates, with no account money meaning
zero. Tool-call and turn ceilings have no domain counterpart: they come only
from the brief schema, and absence means zero. Across multiple matching hard
constraints C9 takes componentwise minima after exact parsing.

For every overlapping component, a brief maximum above the account maximum, a
currency mismatch, missing/cancelled/wrong-scope budget account, or internally
inconsistent source/evidence refuses `plan.budget.ceiling-conflict`; C9 never
accepts the proposal's ceiling as a source of truth. Soft limits and time
budgets do not become plan-ceiling components. Condition 5 applies the five
component comparisons and, when the account total exists, first proves the
subject `plan.budgetCeiling.maximumInputTokens` no greater than that total and
then proves `plan.budgetCeiling.maximumOutputTokens <= maxTotalTokens -
plan.budgetCeiling.maximumInputTokens`. The subtraction form cannot overflow.
The resolved directional evidence may legitimately remain 100/100 against a
total of 100: that exact evidence rejects a 60-input/60-output subject plan,
while 60/40 is the exact-bound positive control. This is **OD-C9-05** and
**CG-06**.

The account's existing reservations and usage do not get subtracted to create
a false "remaining" figure. C9 records a declarative ceiling, creates no
reservation, and grants no spending authority (UR-1/UR-2). The checkpoint that
actually reserves or spends must evaluate then-current account capacity under
the domain budget-account contract.


### 9.2 Condition 6 failure versus adapter-integrity failure

There is no caller-supplied requirement-level provenance label. Two distinct
checks remain, but only the first is a condition-6 verdict:

| Situation | Code | Class |
| --- | --- | --- |
| Derived material-inference is true from upstream provenance, the covering task, the containing stage, an unauthenticated operator-origin claim, or SB-4c; durable C9 evaluation supplies no approval | `plan.seal.condition-6` | `PLAN_SEAL_CONDITION_FAILED` |
| A planted/compromised specification transform or common review-evidence snapshot drops or changes upstream provenance, `decisionId`, task/stage provenance, or authenticated operator evidence relative to its embedded request and issued capability | `plan.coverage.provenance-inconsistent` | `PLAN_AUTHORITY_VIOLATION` |

The second is not a seal verdict; the adapter refuses before a binding can be
used. Honest model/provenance/paraphrase cases reach the first code. Tests:
`plan.seal.condition-6` by G-7, S-6h, S-6m2, S-6l, S-6l-b, S-6l-c, and
S-6l-d; `plan.coverage.provenance-inconsistent` only by the planted broken
adapter controls in G-11/PV-18.

### 9.3 Condition 5 and the budget extension in the C9 world

Condition 5 has **no consumption term**, and this is deliberate. The
resolved ceiling has exactly the two sources of §9.1; a
`Decision(budget-extension-accepted)` is not one of them, and the write that
records it commits no plan record and raises no task budget and no ceiling
(`plan-persistence-and-idempotency.md` §4).

**So a budget extension cannot change a C9 seal verdict.** The reason is
authority, not omission. Making the decision relax condition 5 would let a
plan-time operator decision raise effective spend authority past a project
ceiling — precisely the power C10 exists to own. C9 would then be granting
spending authority under a different name. The parallel with **OD-C9-03** is
exact: approvals arrive in C10, so a plan needing one simply cannot seal
here, and saying so plainly is the honest outcome.

What the write is therefore *for*: it is an **audit record**, durable at
plan time, bound to one `taskId` and to the exact `planId`/`planRevision`
(DC-3, DC-4), that the checkpoint owning spend consumes later. C9 records
it, refuses it when malformed or stale, and reads nothing into it. That is
the whole of its C9 semantics.

Three consequences are load-bearing and must not be softened:

1. The **recovery text for `plan.seal.condition-5` must not offer a budget
   extension**, because within C9 that repair cannot work. The catalogue
   says "lower the plan's `budgetCeiling` or the task budgets, or raise the
   project ceiling at its source" instead. Offering a repair that cannot
   succeed is the false-recovery defect the dossier polices elsewhere (M-15,
   the two origin-specific `sealing-from-*` states' digest-mismatch split).
2. TK-8 and TK-9 already refuse a record whose task budgets exceed its
   ceiling **at validation**, so a plan that would "need" the extension
   cannot be assembled in the first place. Condition 5 is the seal-time
   re-check of a bound that assembly has already enforced.
3. Section 4.1 (`Budget-annotation session precheck`) of
   `plan-state-machine.md` permits the write from `drafting`,
   `proposed` and `awaiting_scope_approval`. From `awaiting_scope_approval`
   no C9-drivable path reaches `sealed` (§3 cell 4 needs C10), so a decision
   recorded there can never be consumed **by C9** — which is true of the
   decision from every head, since C9 consumes none. The permission is
   about where an audit record may honestly be attached, not about
   reachability of a seal, and it is narrow for the reason §4.1 gives:
   a `sealed` or terminal head must not acquire new authority-bearing
   records after its only review.

Test **G-13**: a supplied `Decision(budget-extension-accepted)`, however
well-formed, changes no condition-5 verdict — the seal refuses identically
with and without it. Positive control: a variant that lets the decision
raise the resolved ceiling seals a plan that must not seal.

## 10. Honesty invariants (the ones that catch fabrication)

| # | Invariant | Check |
| --- | --- | --- |
| H-1 | No plan field asserts that an effect took place. The plan declares intent; `sealedAt` records that a review completed, nothing more | copy + projection tests |
| H-2 | Unavailable providers, accounts, quotas or capacity never become plan facts (TK-15) | `plan.task.provider-fact` |
| H-3 | Production-disabled state is structural: no code path in C9 could execute a task, so no flag can enable one | static-policy import scan with positive controls |
| H-4 | A refusal never echoes input: C9 mirrors C6's finite diagnostic roots and static explanations | error-shape test with a hostile-string fixture |
| H-5 | Every claim rendered as "covered", "satisfied", or "ready" traces to a record, never to prose | projection test over a plan whose task titles claim completion |
| H-6 | A model-authored sentence can never reach an authority-bearing field **unlabelled**, and can never reach an **authority-conferring position** at all. The two halves are different claims and both are load-bearing. Model prose *does* appear in the six authority-bearing prose paths — that is what a review is for (`normal-developer-projection-contract.md` §4) — but always carrying its `origin: "model"` label (PV-6, PV-7b), and it can never occupy `origin`, `derivedFrom`, `authority`, `sealedByApprovalId`, a `Decision`, or an `ApprovalRequest` | `proposal-provenance-and-trust-boundary.md`, with a planted canary string |
| H-7 | Stale is rendered, never hidden: a plan bound to a superseded brief renders with its staleness, and the seal action is disabled with a discoverable reason | projection + copy test |
