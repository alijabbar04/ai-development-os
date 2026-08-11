# Stage 19 evaluation and integration foundation checkpoint evidence

Status: Stage 19A production-disabled evaluation source checkpoint is
published and exact-head CI verified; final evidence publication and its
exact-head hosted reconciliation remain pending; Stage 19B integration is
absent

Evidence window: 2026-08-11 03:35 BST onward

Branch: `feat/stage-19-evaluation-integration-foundation`

## Outcome boundary

This stacked branch adds only the coherent Stage 19A evaluation slice. The
permitted checkpoint label, if the remaining explicit staging/publication,
exact-head hosted CI, and final reconciliation gates all pass, is:

`Stage 19A production-disabled evaluation checkpoint complete; integration incomplete`

It does not add `@ai-dev-os/integrator`, a Git port, merge/ref effects, a
production evaluator, production admission, or any Stage 19B fixture claim.
It must not be called Stage 19 complete.

Stage 17W remains gated by the exact separately safety-gated operation. That
operation and the restricted procedure/corpus were not invoked, inspected,
modified, reproduced, described, approximated, encoded, renamed, wrapped,
split, rerouted, retried, or bypassed during Stage 19A work.

## Branch and prerequisite identity

Stage 19A started only after the published Stage 18D exact head and hosted CI
were independently verified green with more than three hours remaining:

- exact base/head at branch creation:
  `b928172c2cdf075462ab088b0705164bdb7d3bf1`;
- base tree: `11e3e0a6df2e741753d6d3b0290a30085bcc1a13`;
- Stage 18D final hosted run: `31451763869`, with dependency audit,
  PostgreSQL integration, Ubuntu, coverage, and Windows jobs successful; and
- stacked branch: `feat/stage-19-evaluation-integration-foundation`, initially
  local with no upstream.

Stage 19B was deliberately not opened: the remaining feature window could not
support an honest serialized Git lease/fencing/recovery implementation and its
required real disposable-repository matrix before the feature cutoff.

## Package and authority boundary

`@ai-dev-os/evaluation` depends in production only on `@ai-dev-os/domain` and
`@ai-dev-os/persistence`. Its service and every snapshot expose the literal
`productionEnabled:false`. Static policy rejects provider, workspace, Git,
process, network, credential, filesystem, and dynamic-code authority from the
package source.

The package validates supplied evidence records; it does not execute or
authenticate an evaluator. Trusted composition supplies one fingerprinted
configuration for new acceptance. That configuration allowlists:

- exact criterion-manifest digests bound to the full subject digest;
- exact canonical evidence-instance digests; and
- exact canonical waiver digests.

Inline evaluator identity, passing data, authority labels, or reduced criteria
therefore cannot authorize themselves. Human authentication, approval
issuance, and reviewed evidence production remain external trusted
responsibilities. Durable load/reopen separately requires the persisted
configuration fingerprint in a bounded trusted-fingerprint registry, which
supports explicit per-run rotation without silently treating a later superset
as the original run authority.

Model advisories remain immutable, non-authoritative inputs. They can create a
stable disagreement record but cannot change deterministic status. The
completeness audit declares `authority:"none"`, cannot approve a waiver, widen
scope, authorize execution, or integrate code, and keeps request-manifest gaps
visible as blocking findings.

## Exact evidence contract

Schema version 1 has eight closed deterministic kinds:

1. output-schema parsing and violations;
2. changed paths against an exact allowed-path contract;
3. compilation command/exit evidence;
4. test suite pass/fail/skip evidence;
5. static-analysis report evidence;
6. acceptance-criterion satisfaction;
7. explicit requirement-to-task-to-result coverage edges; and
8. exact repository head/tree state.

Criteria bind criticality, optional requirement, evaluator ID/version,
configuration digest, kind-specific evidence-contract digest, and exact
expected artifact digests. Evidence binds the same contract plus repository,
same-format Git objects, subject, derived input, observation, and expiry. A
wrong route, wrong contract, wrong artifact set, wrong revision, stale/future
window, fabricated untrusted instance, or unrelated coverage edge is invalid.

Required and expected-quality failed/missing criteria reject the result.
Delight/deferred gaps remain visible and nonblocking. A failed/missing item may
become waived only when its complete active waiver digest is in the trusted
configuration. Narrative or model advice never changes this precedence.

## Bounds, state, and replay

The input preflight rejects non-plain, sparse, aliased, cyclic, accessor, or
symbol-keyed data and enforces a 75,000-node request bound that reserves enclosing
capacity for authority/result/snapshot/event projections, plus result work bounds,
2,000,000 UTF-16 text code units, and depth 32 before nested parsing. Per-field
bounds include 256 criteria, 1,024 evidence items, 256 waivers, 128 advisories,
2,048 identity entries, 4,096 paths/coverage edges, 1,024 artifacts, and eight
attempts.

The command lifecycle is `accept -> pending`, then pending to completed,
retry-pending, failed, cancelled, or expired. Standalone snapshot parsing
enforces command-reachable version/attempt/time/terminal projections. Every
event contains the exact command, full snapshot and authority configuration,
prior/next digest, deterministic ID, sequence, and aggregate version. Replay
rejects sparse/custom/reordered/non-command-equivalent journals.

A reachable run contains at most nine events. The durable store reads only a
tenth overflow sentinel, rejects empty/repeated/non-progressing pagination,
replays the exact journal, and compares the final checkpoint. Checkpoint/event
writes are atomic through the persistence transaction. Exact retries are
write-free; conflicting identity/version/configuration use fails closed.

## Persistence extension

The shared persistence discriminator adds only `evaluation-run`. Memory and
SQLite need no schema migration. PostgreSQL migration
`0002-evaluation-run-aggregate` replaces only the aggregate/event closed-type
checks and has pinned SHA-256
`aeeee92ba9db56fb762e6f44dfcb782a840897582d3cc135d6b1cfb7a2e594a3`.
Released migration 0001 remains byte-identical.

The deterministic PostgreSQL suite validates the two-entry migration history.
The hosted-real test additionally writes an `evaluation-run` aggregate and
event, physically closes, reopens, and checks exact durable identity. The real
future-migration fixture uses ordinal 3 after asserting the exact 0001/0002
prefix. The exact source-head hosted run recorded below passed that proof.

## Changed-file inventory

The candidate contains exactly 27 Git-visible paths including this evidence
file:

- `README.md`
- `docs/adr/0025-stage-19a-production-disabled-evaluation.md`
- `docs/implementation-roadmap.md`
- `docs/release-evidence/stage-19-evaluation-integration-foundation-checkpoint.md`
- `package-lock.json`
- `packages/evaluation/README.md`
- `packages/evaluation/package.json`
- `packages/evaluation/src/contracts.ts`
- `packages/evaluation/src/errors.ts`
- `packages/evaluation/src/evaluate.ts`
- `packages/evaluation/src/index.ts`
- `packages/evaluation/src/run.ts`
- `packages/evaluation/src/schema.ts`
- `packages/evaluation/src/store.ts`
- `packages/evaluation/test/evaluation.test.ts`
- `packages/evaluation/test/fixtures.ts`
- `packages/evaluation/test/static-policy.test.ts`
- `packages/evaluation/test/store.test.ts`
- `packages/evaluation/tsconfig.json`
- `packages/evaluation/vitest.config.ts`
- `packages/persistence-postgres/src/migrations.ts`
- `packages/persistence-postgres/test/fake-pool.ts`
- `packages/persistence-postgres/test/postgres-live.test.ts`
- `packages/persistence-postgres/test/static-policy.test.ts`
- `packages/persistence/README.md`
- `packages/persistence/src/records.ts`
- `packages/persistence/test/records-and-migrations.test.ts`

Before this evidence file, the exact 26 staged-Git-blob path/SHA-256 rows
sorted by ordinal code-unit path and joined as `path<TAB>sha256` with LF have
digest
`25a267c0458ac4c37cbb45fd6b6b2c5729cd3e8d86e439f12575c518ef991580`.
This binds committed blob content rather than checkout-filtered working bytes.

Stable load-bearing source/test bindings are:

| Path | SHA-256 |
| --- | --- |
| `packages/evaluation/src/contracts.ts` | `d14b693c35dba6f235b9b750d8930c25d0251f2beb3ed697dcee73204a40297e` |
| `packages/evaluation/src/schema.ts` | `66727755c84ef68200ac1669c85b3d4cc4ab15a30288d1856a921c676a4c007c` |
| `packages/evaluation/src/evaluate.ts` | `f8880baaa5578dac69f15f0c1deea5fd18c7999d87c9ce8d21896914eade9c24` |
| `packages/evaluation/src/run.ts` | `93037d625c1ed29b3e826fb3276eadbea49ba7175160bec6a87edc69361f0727` |
| `packages/evaluation/src/store.ts` | `21fda2a4175082c4fffcdf9da1ce14f498d08fdb11a5b62a864c891e9e307a08` |
| `packages/evaluation/test/evaluation.test.ts` | `3319a518b1795c14fd7363540a3033ed396df57f7bd57c6b57339f6b195d7ffa` |
| `packages/evaluation/test/store.test.ts` | `3c0b374dc89f714d629f7035400a3b71f1498e158bdfd7aafec73da5218d4a2d` |
| `packages/persistence-postgres/src/migrations.ts` | `5772454a4b2af7f47c1146380bee7e4fbc1d144727aaa7f10fd342f13982bec8` |
| `packages/persistence-postgres/test/postgres-live.test.ts` | `4adbc8a829298bed97f35f8550111cc47a099bde9c903a5466c9168423dfee46` |

## Focused validation

Definitive local evidence on the frozen source candidate is:

- evaluation direct no-emit TypeScript check: exit 0;
- evaluation tests: three files and 20/20 tests passed;
- evaluation coverage: 90.67% statements (642/708), 84.82% branches
  (492/580), 93.28% functions (139/149), and 92.48% lines (591/639);
- PostgreSQL deterministic package: 92 passed, three intentional live
  capability skips;
- persistence package: 28 passed in the pre-review focused run;
- reviewer-focused PostgreSQL static plus persistence migration/record tests:
  18/18 passed;
- literal root `npm run check`: exit 0 in 1,147.1 seconds;
- literal root `npm run test:coverage`: exit 0 in 570.8 seconds, with all
  38 package configurations meeting their thresholds;
- `git diff --check`: exit 0 (Git emitted only working-copy line-ending
  notices);
- root dependency graph: `npm ls --all` exit 0;
- repository audit JSON and `npm audit --audit-level=high`: zero
  vulnerabilities across 189 production, 22 development, 54 optional, and
  244 total records; and
- 38 package manifests and 38 ignored package-local coverage directories.

The final evaluation dry-run produced 30 reviewed package entries, 37,336
packed bytes and 200,708 unpacked bytes, shasum
`363fc2321702110106f2a6179216d1edc4db3ac2`; it bundles no dependency. A fresh consumer installed
packed domain/artifacts/persistence/evaluation tarballs with scripts disabled,
imported the public package, constructed an exact authorized request, obtained
one accepted production-disabled result, and reported zero vulnerabilities.

Two earlier direct full-package wrapper attempts were inconclusive and are not
called passes: one pre-final invocation hit its 122.3-second wrapper limit and
reported EPIPE; a later dot-reporter invocation was stopped after returning no
usable output while the independent reviewer was also checking the shared
tree. The subsequent definitive package coverage lifecycle, independent
20/20 run, literal root check, and root coverage all completed successfully.

Coverage output is ignored and not in the candidate. The 38 generated
package-local coverage directories were preserved; no cleanup was attempted.
No local container, PostgreSQL service, provider/account/credential boundary,
production evaluator, production Git effect, or separately safety-gated Stage
17 operation ran. Ordinary build/test activity did use task-owned temporary
filesystem, SQLite-native file persistence, subprocess, and Git-fixture seams.

Cleanup of the exact task-owned consumer path was blocked by the product safety
layer. No retry or reroute occurred. The preserved generated consumer is:

`C:\Users\mrali\AppData\Local\Temp\ai-dev-os-stage19a-consumer-20260811-0435`

## Independent review

An independent read-only GPT-5.6 Sol reviewer at Max effort audited the complete
candidate across contracts, parsing, evaluation semantics, state/replay/store,
PostgreSQL migration/test parity, package/static policy, and documentation. The
iterative review found and drove repairs for cumulative nested bounds, exact
evaluator/contract/artifact provenance, explicit coverage edges, criterion
manifest completeness, external waiver/evidence authorization, configuration
rotation, exact lifecycle/journal bounds, sparse replay, snapshot reachability,
detached-result canonicality, PostgreSQL hosted-test gaps, direct public
evaluator input validation, and durable envelope headroom.

The final stable-tree verdict is PASS with no remaining blocking or substantive
source finding. Reviewer-side no-emit TypeScript, 20/20 evaluation tests,
18/18 focused persistence/PostgreSQL tests, and diff-check all passed.
Opposite-family review was unavailable in this environment; model usage/cost
was not exposed. The review was same-family GPT-5.6 Sol at Max effort and
read-only throughout.

## Source publication and hosted proof

The exact reviewed 27-path source/evidence candidate was committed and pushed
non-forced on the existing stacked branch:

- source commit: `4fd90d553378fef8e12b5f6f9df40b9255bc6c4e`;
- source tree: `d19b8b455e22b431d602c76c7654bb183553ec17`;
- parent/base: `b928172c2cdf075462ab088b0705164bdb7d3bf1`; and
- subject: `feat(evaluation): add production-disabled stage 19a foundation`.

Local, upstream, and live remote branch refs were equal at that commit and the
worktree was clean. Exact-head GitHub Actions run `31458270035` completed
successfully at the source commit:

| Job | Result | Wall time |
| --- | --- | ---: |
| dependency audit | success | 12s |
| PostgreSQL integration | success | 45s |
| check (Ubuntu) | success | 435s |
| coverage | success | 721s |
| check (Windows) | success | 1,233s |

The PostgreSQL job executed the capability-gated live migration/history,
evaluation-run write/close/reopen, concurrency, and application contract
proofs against the pinned hosted service. The other jobs repeated the exact
dependency, full check, coverage, and Windows/Ubuntu package graph at the same
source head.

## Pending definitive gates

The following final evidence-publication gates remain pending and must not be
inferred from the source-head result:

- independent review of this evidence-only delta;
- explicit staging, one evidence-only commit, and non-forced push;
- exact-head hosted dependency audit, PostgreSQL integration, Ubuntu,
  coverage, and Windows jobs at that final evidence head; and
- final clean-worktree/ref/tree/lock/residue reconciliation.

Until those gates pass, this document records a CI-verified source checkpoint
with pending evidence finalization, not the final published Stage 19A
checkpoint. No merge to `main`, tag, release, signing, registry
publication, PR merge, production registration, or product Git effect is
authorized.
