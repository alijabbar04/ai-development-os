# Stage 18 audit-overlay-bound completeness audit

Status: deterministic audit executed; local gates and independent source review
pass; decision **rejected**; commit, publication, and hosted CI pending

Date: 2026-08-14

## Exact subject and specification

The production-disabled audit evaluates the immutable local baseline commit
`f5372fece6371385e15b6cbb2edd2f4063c7eac3`, tree
`9f5a842192bb9317127cc4b57af5fbf50d0d36dc`. That commit records the terminal
Stage 17W, Anthropic, and Account Manager operator outcomes without promoting
any incomplete row.

The versioned audit overlay is
`docs/release-evidence/stage-18-audit-specification-overlay-v1.json`. It is an
unapproved checkpoint-specific data contract, not the shipped product-planning
`ProductSpecification` schema and not a product-owner scope decision. Its canonical
evaluation digest is
`105391e28c95fea16c09d6951451352d5e0b94eee858aca04cfba977c649c6fc`.
It binds all 16 matrix rows to 16 unique requirement, task, and result IDs and
explicit requirement-to-task-to-result edges. Eleven criteria are `required`
and five are `expected-quality`; no criterion is silently lowered to delight or
deferred.

All ten ADR 0016 specialist concerns have an explicit disposition: security,
privacy, data lifecycle, failure/recovery, testing, performance, operations,
maintainability, and documentation map to accepted matrix requirements.
Accessibility is explicitly deferred because Stage 18 exposes no production UI
and the relevant UI/platform evidence belongs to later stages. Linux/macOS
production enforcement, query-native team-scale scheduling, and production
activation are also explicit deferred or needs-decision candidates rather than
silent omissions.

The overlay is a repository-bound candidate for this production-disabled
audit. Its authoring/audit route keys are deterministic digests of declared
route metadata, not authenticated route evidence. The declared audit route is
separate and read-only but uses the same GPT-5.6 Sol model family as the
implementation route; external route authentication and full model-family
independence are explicitly unavailable.

The prepublication delta relative to the baseline comprises exactly nine paths:
five modified tracked paths and four additions. The eight non-packet paths have
this ordinal, LF-terminated `path<TAB>sha256<LF>` manifest (878 bytes; SHA-256
`03f34304980c5c82950933af05caa1758320f7bcfe8a40871f8190b75498d3d4`):

```text
.github/workflows/ci.yml	c0a79045232eb12adc915d70024bb2b83d8c3eabd4779cc9bb4d85dd38436f05
README.md	e919a98bcdc714dee0aeb092b6021d1457a8f18b323a7d9d73e48c935f19e954
docs/implementation-roadmap.md	8fa020eb38b9d3ec9e57ab8bf867036ded2b11f28413c2115e8a7c21c380b155
docs/release-evidence/stage-18-audit-specification-overlay-v1.json	06262f67352714dc79645d9daa4be2046fb3f9eb0441ed26126763ad7287b0a3
docs/release-evidence/stage-18-completeness-audit-untrusted-summary.json	cc71ed11e360d93cd5a1a11080fe1ea8a58dbcdbc3778b5fc3fd69d24a5d3645
docs/release-evidence/stage-18-development-acceptance-matrix.json	9ba84f6404253f4b5d4ba052029e6dacd47a779b52ec9128e97d3648fd27c838
docs/technical-design.md	0898c8e24fa5d4b8136892cb242bf19132c4ddaa06b79ef363b381d34a550401
packages/evaluation/test/stage-18-completeness-audit.test.ts	11790260910a908382d223e744e8bf6cb36eaa16681de92a72896a44485d6c2b
```

The ninth path is this evolving checkpoint and is deliberately excluded from
its own manifest.

## Deterministic bundle

The audit test reads every authority, implementation, test, and evidence anchor
from the exact subject commit rather than the moving working tree. Git head/tree
and the SHA-256 of each referenced blob form each criterion's expected artifact
projection. The bundle contains:

- audit-overlay digest
  `105391e28c95fea16c09d6951451352d5e0b94eee858aca04cfba977c649c6fc`;
- subject digest
  `a90c54dd86529297118ad2adc39e828288b68b0401bad199841fd22085b57fbe`;
- 16 exact acceptance criteria and 16 candidate evidence instances;
- candidate criterion-manifest digest
  `b43af73b399f23e0922543efacd4830a7e9aa7ca71219931cf89638a761d03ea`;
- authority-configuration fingerprint
  `3ebe80101f3af5a2b115048ff47469ad5d7a8082905b3f8436b519dfc0dc46c0`;
- zero authorized criterion-manifest, evidence-instance, and waiver digests; and
- request digest
  `23aac0d14c0dbd16ef677f4fdb044ebb58a0e545bf30d42f6b76947373409b1e`.

Only exact `proven` matrix status marks a candidate evidence record satisfied,
but none of those records is externally authorized. Narrative advice, inline
authority text, path existence, or a structurally plausible artifact is not
sufficient. The machine-readable mixed projection is explicitly named and
typed as an untrusted summary; it is neither the public `EvaluationResult` nor
the public `CompletenessAudit` schema:
`docs/release-evidence/stage-18-completeness-audit-untrusted-summary.json`.

## Result

The official authority-free deterministic decision is `rejected` with
`CRITERION_MANIFEST_UNAUTHORIZED`. No criterion passes: all 16 are `missing`
and blocking because the external allowlists are empty. The completeness audit
therefore has 17 findings: one for each criterion and one for manifest
authorization.

Separately, the untrusted semantic status projection identifies the four
current matrix gaps:

- `criterion:stage18:ANT-02` — the sole authorized canary ended ambiguously
  with `TRANSPORT_FAILURE`; no retry or successful live proof exists;
- `criterion:stage18:AM-02` — the repaired packed-consumer gate was blocked
  before execution/publication and no post-repair installed-state read ran;
- `criterion:stage18:PLN-02` — this candidate audit is conservative evidence,
  not a self-authorizing proof or product-owner promotion; and
- `criterion:stage18:PRD-01` — Stage 17W remains production-gated after the
  remover-only exit-code-2 result and no authorized current-state observation.

The result digest is
`b5e19ef8e5c8808349abda988753a3d474412fc3df432050f0c18dd3f4c329fc`.
The derived completeness audit ID is
`completeness-audit:aa448c4cb5fafe1cb1cbc6320d2a0b30` and its digest is
`b30aae9f9a9f42a1935f60bfc7703a9ae7fe4871ac070ee758f5b038d903695b`.
It has `authority: "none"`, cannot authorize execution, cannot approve a waiver,
and cannot widen scope.

## Discriminating proof

The focused local suite currently passes 1 file and 7 tests. The full evaluation
package passes 4 files and 27 tests, and evaluation coverage passes at
91.52/85.68/95.97/92.95. The application package passes 8 files plus 1
intentional hosted-only skip, with 50 executed tests and 1 skipped test. The
audit proof persists the request/result through the production-disabled memory
service, replays the two-event journal exactly, and makes exact retry write-free.
Only the check and coverage jobs fetch full read-only history because they run
this audit. That makes the subject available on the feature branch and
ancestry-preserving merges; squash/rebase publication or later loss of the
subject ref requires a newly bound subject and is not claimed. Adversarial
vectors refuse:

- an omitted requirement or matrix row;
- a lowered criticality or colliding audit route;
- wrong commit/tree identity, false status promotion, or a removed coverage
  edge;
- narrative-only approval, a reduced criterion manifest, or a fabricated
  waiver;
- duplicate evidence; and
- stale, wrong-head, or artifact-substituted evidence.

Definitive local validation on the frozen candidate also records:

- root `npm run check`: exit 0 in 1,644.7 seconds, covering the complete
  40-workspace typecheck, test, and build chain;
- root `npm run test:coverage`: exit 0 in 950.9 seconds, with all 40 coverage
  roots present. Exact aggregate fractions are 27,557/29,551 statements,
  19,309/22,153 branches, 5,301/5,429 functions, and 24,927/26,281 lines,
  yielding floor-to-two-decimal 93.25/87.16/97.64/94.84;
- `npm audit --audit-level=high --json`: exit 0, zero vulnerabilities at every
  severity across 264 dependency records;
- `npm ls --all --json`: exit 0 with no problem entry;
- evaluation dry pack: 30 files, 37,391 packed bytes, 200,840 unpacked bytes,
  SHA-1 `311f369fd54240b3db1b72271b9284ae98982345`, zero bundled dependencies;
- application dry pack: 30 files, 30,200 packed bytes, 149,360 unpacked bytes,
  SHA-1 `a490d334caa60bf734e1214c90e6c745136b0516`, zero bundled dependencies; and
- `git diff --check`: exit 0.

A separate same-family GPT-5.6 Sol route completed a strictly read-only
exact-byte review and returned PASS with no actionable blocker. It independently
re-ran the focused audit, full evaluation, and application suites, but did not
authenticate the declared route, create authority, rerun aggregate coverage,
or exercise any private, installed, protected, credential, provider, or live
boundary.

The explicit-path commit, non-forced feature-branch publication, and exact-head
hosted CI remain future-only. This checkpoint is not yet published.

## Consequence

`PLN-02` remains `incomplete`; this rejected audit cannot certify itself.
`ANT-02` and `AM-02` remain `incomplete`, `PRD-01` remains
`production-gated`, `developmentAccepted` remains `false`, and
`productionAdmitted` remains `false`. Stage 20A did not start. No provider,
credential, installed-state, protected-state, Git-effect, production, or UI
authority was exercised by this deterministic audit.
