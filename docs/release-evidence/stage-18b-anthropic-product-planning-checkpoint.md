# Stage 18B direct Anthropic and product-planning checkpoint evidence

Status: independently reviewed candidate pending commit, push, and exact-head CI
Evidence window: 2026-08-09 22:12 BST through 2026-08-10 04:35 BST
Branch: `feat/stage-18b-anthropic-product-planning`

## Outcome boundary

This candidate adds a production-disabled direct Anthropic inference adapter and
a bounded, durable product-completeness planner integrated with the existing
Stage 18A scheduler and task graph. It does not admit production execution,
complete Stage 17, complete all of Stage 18, or begin Stage 19.

The separately authorized Stage 17W native stateful operation remains the exact
Stage 17 dependency. It was not invoked, inspected, reproduced, described,
rerouted, retried, or approximated during this work.

## Canonical dependency chain

Preflight began from a clean `feat/stage-18a-orchestration-foundation`:

- local/upstream/remote commit:
  `ea0ff33cfda9623455755280a25a84a757f88f42`;
- tree: `3c35c9738381f35cf1fa9b18b063acfb71a95670`;
- exact-head Stage 18A CI: run `31329534909`, dependency audit, coverage,
  Windows check, and Ubuntu check passed;
- frozen Stage 17W branch/head:
  `feat/stage-17w-complete` at
  `a8f5bf4f3182a8e47bbbb27260f6a7d159102a8c`;
- exact-head Stage 17W CI: run `31321848500`, all four jobs passed; and
- no tag, release, deployment, in-progress Git operation, lock, divergent
  linked worktree, or unattributable local change was present.

The Stage 18B branch was created directly from that exact Stage 18A commit.
There was no pull, merge, rebase, reset, history rewrite, or destructive
checkout.

## Architecture decisions

ADR 0022 records these decisions:

- Direct Anthropic is a cloud `InferenceProvider`, not the Claude Code
  coding-agent/session boundary.
- The profile is pinned to `POST https://api.anthropic.com/v1/messages`, API
  version `2023-06-01`, one configured model alias, and one exact expected
  response-model identity.
- No SDK or external dependency was added. Runtime transport, clock, policy,
  and scoped-secret resolution are injected; automated tests use only the
  explicit testing subpath and deterministic fake ports.
- Policy and retention preflight precede scoped credential resolution, which
  precedes the injected transport. The public constructor has no transport or
  credential port and fails closed.
- Stream processing has finite event, byte, output, tool-argument, wall-time,
  deadline, cancellation, and backpressure bounds. Model substitution,
  malformed ordering, duplicate terminal data, contradictory usage, and raw
  provider errors fail closed.
- Product planning treats all model output as untrusted proposals with
  `authority: "none"`. Scope requires exact human/deterministic authority,
  requirement digest, plan version, reason, approval reference, and time.
- Discovery, specialist, engineering, and synthesis phases are stable scheduler
  tasks with exact route/configuration/source evidence. Material and high-risk
  plans require trusted discovery/synthesis and engineering/synthesis route
  independence after alias resolution.
- Candidate deduplication retains every candidate identity, contribution,
  provenance item, unresolved question, finding, and dissent item. Deterministic
  specification synthesis cannot silently discard them.
- Planning persists as a distinct `product-plan` aggregate plus its exact
  task-graph event stream in one transaction. Stage-before-terminal
  reconciliation survives restart and applies the phase's one exact terminal
  contribution once.
- Accepted requirement work is appended atomically to the same sealed active
  `TaskGraph`; no second graph, persistence framework, provider registry, or
  usage ledger was introduced.
- Budget preview, reservation, and reconciliation are immutable intents only;
  no account or external usage mutation exists.
- The already reviewed borrowed-profile interval is explicitly reconciled as
  the half-open weekday interval `[09:00, 17:00)` in `Europe/London`. Existing
  tests prove 09:00 inside and 17:00 outside in summer and winter.
- No Stage 18A persisted payload or event changed. The persistence aggregate
  discriminator gains `product-plan`, and the non-persisted scheduler adapter
  request gains attempt and accumulated-usage context; no prior-payload
  migration is required.

Official Anthropic sources consulted on 2026-08-09 are linked directly from
ADR 0022: Messages, API versioning, streaming, structured output, tool use,
errors, model identifiers, standard retention, and contracted zero-data
retention.

## Public and effect boundaries

`@ai-dev-os/provider-anthropic` exports the reviewed configuration, wire
contracts, and production-disabled provider. Its fake constructor is exported
only by `@ai-dev-os/provider-anthropic/testing`.

`@ai-dev-os/product-planning` exports versioned intent, configuration, phase,
contribution, requirement, decision, specification, coverage, event, store,
and production-disabled coordinator contracts. The exercising coordinator and
inference-agent adapter are exported only by
`@ai-dev-os/product-planning/testing`.

Both packages expose a literal `false` production flag. Static policy and an
isolated tarball consumer prove the main exports contain no fake constructor.
Production sources contain no ambient filesystem, child-process, HTTP/socket,
`fetch`, environment-secret, SDK, browser/UI, or dynamic-load authority.

## Bounded state machines

Compiled maxima are phases 16, specialists 12, contributions 64, candidate
requirements 1,000, calls 64, total tokens 4,000,000, cost
100,000,000,000 micros, contribution output 4 MiB, total output 32 MiB, wall
time 24 hours, synthesis rounds 3, retries 4, graph nodes 2,000, depth 64, and
dependency fan-out 64. Configuration may lower but cannot raise these values.

Planning accepts one immutable normalized intent and creates a sealed phase
graph. A scheduler result is first staged durably, then verified against the
terminal scheduler provider/evidence identity, then applied idempotently.
Non-synthesis phases complete in graph order; synthesis remains running until
an exact approved specification compiles every executable decision into a
stable requirement task and completes the synthesis task. A failed scheduler
terminal fails its target phase/task and blocks or cancels remaining work; a
cancelled terminal cancels remaining planning work. An approved specification
accepts no later contribution or scope change.

Journal replay validates exact envelopes, contiguous sequence/version and
aggregate-version batches, before/after digests, full bounded checkpoints,
configuration identity, and task-graph event payload/projection parity.
Aggregate and both event streams commit atomically. Duplicate calls with the
same canonical identity are write-free; conflicting reuse fails.

## Changed-file inventory

The candidate contains exactly 48 reviewed paths including this evidence file:

- `docs/adr/0022-stage-18b-anthropic-product-planning.md`
- `docs/product-direction.md`
- `docs/release-evidence/stage-18b-anthropic-product-planning-checkpoint.md`
- `package-lock.json`
- `packages/persistence/README.md`
- `packages/persistence/src/records.ts`
- `packages/scheduler/src/provider.ts`
- `packages/scheduler/src/scheduler.ts`
- `packages/task-graph/README.md`
- `packages/task-graph/src/index.ts`
- `packages/task-graph/src/task-graph.ts`
- `packages/task-graph/test/task-graph.test.ts`
- `packages/provider-anthropic/README.md`
- `packages/provider-anthropic/package.json`
- `packages/provider-anthropic/tsconfig.json`
- `packages/provider-anthropic/vitest.config.ts`
- `packages/provider-anthropic/src/config.ts`
- `packages/provider-anthropic/src/contracts.ts`
- `packages/provider-anthropic/src/index.ts`
- `packages/provider-anthropic/src/provider.ts`
- `packages/provider-anthropic/src/structured-schema.ts`
- `packages/provider-anthropic/src/testing/index.ts`
- `packages/provider-anthropic/src/wire.ts`
- `packages/provider-anthropic/test/config-wire.test.ts`
- `packages/provider-anthropic/test/contract.test.ts`
- `packages/provider-anthropic/test/helpers.ts`
- `packages/provider-anthropic/test/provider-adversarial.test.ts`
- `packages/provider-anthropic/test/static-policy.test.ts`
- `packages/provider-anthropic/test/structured-schema.test.ts`
- `packages/product-planning/README.md`
- `packages/product-planning/package.json`
- `packages/product-planning/tsconfig.json`
- `packages/product-planning/vitest.config.ts`
- `packages/product-planning/src/contracts.ts`
- `packages/product-planning/src/coordinator.ts`
- `packages/product-planning/src/errors.ts`
- `packages/product-planning/src/index.ts`
- `packages/product-planning/src/plan.ts`
- `packages/product-planning/src/schema.ts`
- `packages/product-planning/src/store.ts`
- `packages/product-planning/src/testing/index.ts`
- `packages/product-planning/src/testing/inference-agent.ts`
- `packages/product-planning/test/adversarial.test.ts`
- `packages/product-planning/test/fixtures.ts`
- `packages/product-planning/test/persistence.test.ts`
- `packages/product-planning/test/plan.test.ts`
- `packages/product-planning/test/scheduler-integration.test.ts`
- `packages/product-planning/test/static-policy.test.ts`

## Validation evidence

All commands ran from the repository or named package directory with Node/npm
from the canonical toolchain. No live provider, account, credential, workspace,
Git mutation, or native operation was exercised by a test.

### Focused and package gates

- Anthropic shared provider contract: 20/20 passed.
- `packages/provider-anthropic`: 113/113 tests passed. Coverage: statements
  93.41% (752/805), branches 88.29% (679/769), functions 98.92% (92/93),
  lines 96.87% (652/673).
- `packages/product-planning`: 45/45 tests passed. Coverage: statements
  90.74% (1176/1296), branches 83.88% (817/974), functions 95.65%
  (308/322), lines 92.60% (1014/1095).
- `packages/task-graph`: 52/52 tests passed. Coverage: statements 91.69%
  (806/879), branches 84.64% (518/612), functions 99.24% (131/132), lines
  92.05% (765/831).
- `packages/scheduler`: 85/85 tests passed. Coverage: statements 91.39%
  (722/790), branches 86.70% (502/579), functions 93.60% (117/125), lines
  95.67% (664/694).
- `packages/persistence`: 28/28 tests passed. Coverage: statements 98.92%
  (184/186), branches 98.88% (89/90), functions 98.27% (57/58), lines
  98.90% (181/183).
- Typecheck, test, and coverage commands passed for every affected package,
  323/323 affected-package tests total. Product planning also rebuilt its
  exact domain/persistence/provider/scheduler/task-graph prerequisites.
- At mutation-proof time, the exactly restored suites passed Anthropic 102/102
  and planning 36/36. Subsequent independently reviewed hardening increased
  those suites to the current 113/113 and 45/45 counts; both current suites and
  every parent gate were rerun on the final tree.
- Deterministic candidate-order property test covered all 24 permutations.
- Seed `18022026` repetition gates passed: product-planning scheduler/restart
  integration 20/20, Anthropic cancellation/deadline races 30/30, and dynamic
  task-graph append 30/30.
- Existing scheduler policy coverage includes explicit summer/winter 09:00 and
  17:00 edges plus DST/weekend cases.

### Full repository gates

- Definitive post-review `npm run check`: PASS, exit 0, 1,655.6 s. This
  completed root
  typecheck, test, and build across every workspace.
- Definitive post-review `npm run test:coverage`: PASS, exit 0, 802.2 s. Every package
  threshold remained green.
- The 35 runtime workspace summaries totaled 3,002 tests: 2,977 passed and 25
  pre-existing conditional or platform skips. `npx vitest list --json`
  independently enumerated 2,982 static entries; runtime summaries, not the
  static inventory, are the pass/skip authority.
- No changed test skip, exclusion, threshold, or snapshot bypass exists.

### Packaging and dependency evidence

- `npm install --package-lock-only --ignore-scripts` and then
  `npm install --ignore-scripts`: PASS. Lockfile drift contains only the two
  first-party workspaces and their existing first-party edges.
- `npm ls --all`: PASS, exit 0.
- `npm pack --dry-run --json --ignore-scripts`:
  - provider: 30 files, 34,305 packed bytes, 170,999 unpacked bytes;
  - planning: 38 files, 63,329 packed bytes, 367,037 unpacked bytes.
- A task-owned fresh directory outside the repository packed and installed the
  complete first-party runtime closure (domain, artifacts, providers, policy,
  secrets, persistence, scheduler, task graph, Anthropic, and planning).
  Dynamic imports of both main packages and the planning testing subpath
  passed; both production flags were `false`, and fake factories were absent
  from main exports. Subsequent hardening did not change those entrypoints or
  package manifests; the current packages were rebuilt by the root check and
  re-inspected by the dry-run package gates above.
- No new third-party package, install script, native module, or SDK was added.
- `npm audit --json`: PASS; info 0, low 0, moderate 0, high 0, critical 0.
- `npm audit --audit-level=high`: PASS, `found 0 vulnerabilities`.

### Mutation/defect proofs

Each mutant was applied alone, required its named focused test to fail, and was
then immediately removed before the next mutant:

1. production-disabled coordinator refusal;
2. exact Anthropic response-model substitution rejection;
3. policy-before-credential-before-transport ordering;
4. synthesis retention of prior contributions/questions/dissent;
5. scope-decision requirement-digest binding;
6. independent-route collision classification;
7. exact duplicate contribution idempotency; and
8. hard contribution-output bound.

Restoration hashes were exact:

- planning coordinator:
  `ed21fe5cf9f7690e29511ffe874f4f7b84bd7627b95669be6b43622b7b0001e2`;
- Anthropic provider:
  `ddbf5558e8c6327f9afff8c9f7319387de255fa4a95b618ab222ea4a924652a`;
- planning aggregate:
  `0870c5d060fd6878d3eb4462dc928d541fa170772ec25918fd207816e053cb08`.

These are the hashes immediately after each isolated proof was restored;
subsequent reviewed repairs intentionally changed the current files. The
restored full package suites passed, and an exact residue scan found none of
the mutation text.

### Static, document, and residue evidence

- New package static-policy tests passed in their package counts above.
- `git diff --check`: PASS; only informational LF-to-CRLF checkout warnings
  were emitted for nine already tracked text files.
- Reviewed paths contained no private-key, Anthropic/OpenAI/GitHub/AWS/Slack
  token pattern and no merge-conflict marker.
- No generated executable, library, database, archive, image, coverage output,
  or temporary file is tracked or present among the 48 Git-visible candidate
  paths. The complete coverage wrapper left 35 ignored package-local
  `coverage` report directories.
  A validated exact-path cleanup was blocked by the product safety layer before
  execution; it was not retried, rephrased, or rerouted, and no file was
  removed. This ignored test-output residue is reported rather than hidden.
- No raw credential, account/session material, live provider body, hidden
  reasoning, unsupported platform implementation, UI/communications path,
  or Stage 19 implementation was added.

## Independent review

Tesla, an independent read-only GPT-5.6 Sol reviewer at Max effort, reviewed
the exact base, full uncommitted tree, public contracts, ADR, package graph,
effect ordering, planner state machine, journal replay, hydration, route
independence, redaction, tests, and validation. It had no edit, Git/GitHub,
provider, credential, native-operation, or unrelated-system authority. Reported
cost/usage was unavailable. No opposite-family reviewer is exposed by the tool
environment; that limitation is not relabelled as opposite-family review.

The initial verdict was FAIL. Iterative read-only review found and repaired the
initial unsatisfiable schema, stage/idempotency, graph-bound, budget,
cancellable-preflight, aggregate-type, wire-error, and identity defects, plus
later sealed-append/journal replay, usage-before-stage, terminal cancellation,
hydrate/envelope/approval, canonical ordering/ID, exact task-graph checkpoint,
message ordering, caller-schema compatibility/bounded-work/control-flow/Unicode
semantics, pricing consistency, and finite error-redaction defects. The final
floating-point `multipleOf` fail-open counterexample was closed by excluding
that keyword at preflight. Fresh final source recheck found no remaining
substantive issue. After verifying the refreshed evidence, exact 48-path
inventory, stable critical hashes, and repository status, the reviewer returned
explicit **PASS** with no blocking or substantive finding remaining. The 35
ignored coverage directories were accepted as accurately disclosed,
nonblocking validation residue; their blocked cleanup was not retried or
rerouted.

## Commit, remote, and hosted CI

Pending. Before acceptance, only the 48 paths above will be staged explicitly,
the focused commit will be pushed non-forced to the matching branch, and the
exact commit must pass the existing dependency-audit, coverage, Windows-check,
and Ubuntu-check hosted jobs. Local/upstream/remote SHA and tree equality plus
a clean index/worktree will then be recorded here.

## Deferred work and nonclaims

- The exact separately authorized Stage 17W native stateful operation remains
  pending operator authority.
- Stage 18 still requires durable application/runtime composition, real
  PostgreSQL contract parity, any approved read-only normalized usage adapter,
  and production admission.
- Stage 19 retains completeness evaluation, disagreement calibration,
  integration gates, and final audit behavior.
- No UAC, native lifecycle/proof, live provider/account, credential, quota, UI
  scraping, browser/account automation, workspace/Git effect, communication,
  Linux/macOS product integration, PR, merge, tag, release, signing,
  publication, production registration, or repository-settings change occurred.

Stage 18B must not be labelled complete while review, commit/push, or exact-head
CI is pending.
