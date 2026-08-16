# Stage 18 development-closure candidate checkpoint

- Status: Integration candidate. `AM-02` is proven, `ANT-02` remains the only
  development blocker, `developmentAccepted` and `productionAdmitted` remain
  `false`. This packet records an integration of two already-published,
  already-reviewed, already-green branches; it creates no new live proof.
- Date: 2026-08-16
- Branch: `feat/stage-18-development-closure-candidate`
- Merge base: `c50c4725981013f123ebef0d0a87082f085b333d`
- Decision record: `docs/adr/0032-stage-18-development-closure-candidate-integration.md`

## Outcome boundary

No credential was read, listed, exported, validated, written, or deleted. No
Windows Credential Manager operation occurred. No API key was requested and no
clipboard was used. No Anthropic or other provider request ran. No live-canary
environment variable was set. No live-canary marker was created, and neither
consumed marker was read, copied, hashed, modified, deleted, or reused. No
historical canary script was executed. No Stage 17W operation, Stage 20 work,
Stage 21 work, pull request, merge to `main`, rebase, force push, tag, release,
production enablement, or destructive cleanup occurred. The Codex v5/v6 lane
and the Fable Stage 21 UX lane were not inspected, modified, or executed.

## Exact inputs

Both inputs were verified against their required bindings before the
integration branch was created.

### Input A — Anthropic diagnostic envelope

- Branch `fix/stage-18-anthropic-diagnostic-envelope`
- HEAD `edefcb80aaa794b572d048dfa6c3cb0bea36c0e1`
- Tree `d04f7c3e3c2cebc5bcc44e2d0dda8e2c3f801a9a`
- Parent `d26a68f695e16fcbd43f33b6717ec69e0e9c0982`
- Worktree clean; local, upstream, tracking, and live remote refs all equal
- Exact-head CI run `31938139741`: attempt 1, success, five jobs, no rerun —
  `95143191748` PostgreSQL integration, `95143191760` dependency audit,
  `95143191777` check (ubuntu-latest), `95143191800` coverage,
  `95143191805` check (windows-latest)
- Changed exactly its 8 intended paths versus its parent (+2,969 / −42)
- 18 diagnostic categories; 213 Provider-Anthropic tests; no live provider call
- `ANT-02` deliberately left incomplete and the acceptance matrix deliberately
  not edited by that lane

### Input B — AM-02 inactive-usage-window contract

- Branch `fix/stage-18-inactive-usage-window-contract`
- HEAD `0197176eeb13d6b39e09f998e01a580da3b9b5b6`
- Tree `5082eb2a177ae3f7c07c0829100af2d04b0b673a`
- Worktree clean; local, upstream, tracking, and live remote refs all equal
- Commits `7116c39` (implementation + hosted packed-consumer gate),
  `fdff306` (hosted packed-consumer evidence),
  `0197176` (successful separately authorized installed-state read)
- Exact-head CI run `31917172046`: attempt 1, success, six jobs, no rerun —
  `95090890689` dependency audit, `95090890694` PostgreSQL integration,
  `95090890699` coverage, `95090890714` packed consumer (windows),
  `95090890736` check (windows-latest), `95090890776` check (ubuntu-latest)
- Changed 38 paths versus the merge base (+3,153 / −204)

### Ancestry

- `git merge-base edefcb80… 0197176e…` = `c50c4725981013f123ebef0d0a87082f085b333d`
- `edefcb80…` is not an ancestor of `0197176e…`
- `0197176e…` is not an ancestor of `edefcb80…`
- `c50c4725…` is an ancestor of both

Both the target path
`C:\Users\mrali\Projects\ai-dev-os-stage18-development-closure-candidate-20260816`
and the branch `feat/stage-18-development-closure-candidate` were proved absent
locally and on the live remote before creation.

## Merge method

A single history-preserving non-fast-forward merge of `0197176e…` into a branch
based at `edefcb80…`. Both parents and both complete evidence ancestries remain
reachable. Neither source branch was rebased, rewritten, moved, or deleted; no
whole-merge `ours`/`theirs` strategy was used. The reasoning is recorded in
ADR 0032.

## Conflicts and resolutions

Seven paths conflicted. Two more (`docs/technical-design.md`, `package.json`)
auto-merged as unions and were verified.

| Path | Nature | Resolution |
| --- | --- | --- |
| `.github/workflows/ci.yml` | Both lanes rewrote the trailing "deliberately does NOT do" block | Union of both truths: the combined workflow really does compile the credential-reader addon *and* really does run the packed-consumer job, so both statements are kept |
| `README.md` | Two current-state blocks | Rewritten to the combined truth: `AM-02` proven, `ANT-02` sole development blocker, frozen Phase A outcome preserved as historical |
| `docs/adr/0027-…` | "Consequences and remaining work" | Split into a satisfied Account Manager boundary and an unsatisfied Anthropic boundary; the acceptance criterion text is retained verbatim in scope and marked satisfied, not weakened |
| `docs/implementation-roadmap.md` | Stage 18 status paragraph | Diagnostic-lane structure kept (it carries two paragraphs the AM lane never had); first paragraph reconciled; the frozen Phase A result kept, with `AM-02`'s later promotion noted rather than restated into it |
| `docs/product-direction.md` | Account Manager live-route paragraph | Reconciled to record the successful 2026-08-16 read and the inactive-window projection |
| `docs/release-evidence/stage-18-development-acceptance-matrix.json` | `branch`, `ANT-02` anchors, `AM-02` anchors and status | `branch` set to this candidate; `ANT-02` anchors unioned and extended with the diagnostic-envelope records, status unchanged; `AM-02` promoted with a rationale bound to its actual evidence |
| `packages/application/test/stage-18-acceptance-matrix.test.ts` | Pinned branch string | Repinned, and strengthened (see below) |
| `docs/technical-design.md` | Auto-merged union | Stale `AM-02` sentence reconciled |
| `package.json` | Auto-merged union | Keeps the AM lane's `verify:packed-consumer` script and the diagnostic lane's `node >= 22.9.0` engine and `node-gyp` devDependency; no unrelated dependency added |

Two further stale current-state statements were reconciled outside the conflict
set: `packages/application/README.md` (which claimed `AM-02` was still pending)
and the ADR 0027 status header.

### Integration defect found and fixed

`packages/evaluation/test/stage-18-completeness-audit.test.ts` asserts on the
*live* `.github/workflows/ci.yml`. It came from the diagnostic lineage and
expected exactly four checkout jobs; the AM lane had added a fifth
(`packed-consumer`). Its job-slicing helper would also have mis-sliced the
`postgres` job body up to the trailing comment, swallowing the new job. The
guard was extended to cover five jobs and to bound `packed-consumer`
explicitly, asserting that it carries exactly one checkout, exactly one
`persist-credentials: false`, and no `fetch-depth`. The rule that only the two
audit-executing jobs receive subject history is unchanged and still enforced.

This defect existed only on the combination; neither branch could have caught
it alone.

## Preservation proof

Measured on the merge commit itself by comparing blob ids
(`git rev-parse <ref>:<path>`), not on the working tree. Both lanes are
measured against the **same denominator** — the paths each changed versus the
merge base `c50c472` — so the two figures are comparable:

- Diagnostic lane: **56 of the 66** paths it changed versus the merge base are
  byte-identical to `edefcb80…` at the merge commit. (Narrowing to the 8 paths
  its own final commit introduced, all 8 are identical.)
- AM lane: **28 of the 38** paths it changed versus the merge base are
  byte-identical to `0197176e…` at the merge commit.
Those two shortfalls overlap but are not identical. Exactly **9** files were
edited by both lanes and reconciled deliberately: `ci.yml`, `README.md`,
ADR 0027, `implementation-roadmap.md`, `product-direction.md`, the acceptance
matrix, `technical-design.md`, `package.json`, and the matrix guard test
`packages/application/test/stage-18-acceptance-matrix.test.ts`.

Each lane contributes one further single-lane file:

- diagnostic lane only —
  `packages/evaluation/test/stage-18-completeness-audit.test.ts`, changed to fix
  the integration defect described below;
- AM lane only — `packages/application/README.md`, whose `AM-02` statement
  became stale on the combination.

The merge commit therefore differs from *both* parents in exactly **13** paths:
those 11, plus the two records this candidate adds (ADR 0032 and this
checkpoint). It differs from the diagnostic parent in 41 paths and from the AM
parent in 69 paths.

Consequently: the diagnostic source and tests remain semantically equivalent to
the reviewed diagnostic branch; the AM source and tests remain semantically
equivalent to the reviewed AM branch; no credential or secret-broker behavior
changed; the fixed Anthropic request did not change; marker behavior did not
change; no provider call became enabled; no production state changed; and no
unrelated dependency appeared.

## Stage 18 acceptance state

| Row | Status | Blocks development | Blocks production |
| --- | --- | --- | --- |
| `ADM-01` | proven | no | yes |
| `ANT-01` | proven | no | no |
| `ANT-02` | **incomplete** | **yes** | yes |
| `PLN-01` | proven | no | no |
| `PLN-02` | incomplete | no | yes |
| `SCH-01` | proven | no | yes |
| `SCH-02` | proven | no | yes |
| `PER-01` | proven | no | yes |
| `PER-02` | proven | no | yes |
| `PER-03` | proven | no | yes |
| `USE-01` | proven | no | yes |
| `AM-01` | proven | no | yes |
| `AM-02` | **proven** | yes | yes |
| `INT-01` | proven | no | yes |
| `EVD-01` | proven | no | yes |
| `PRD-01` | production-gated | no | yes |

- `developmentAccepted` = `false`, derived from `ANT-02` rather than asserted.
- `productionAdmitted` = `false`.
- `permittedOutcome` = `Stage 18D production-disabled checkpoint complete`.
- Stage 20A remains ineligible.

The guard test was strengthened, not relaxed: it now pins the exact set of
development-blocking rows that are not proven to `["ANT-02"]`, and additionally
pins `INT-01` proven and `PRD-01` production-gated.

## `AM-02` evidence verification

The criterion is *a supported read-only live Account Manager integration
supplies authorized profile snapshots without UI or credential extraction*.

Verified against committed evidence rather than narrative:

- Pinned maintained reader: commit `f958ccaee81452f919e7321078899de692f0c81c`,
  tree `04c22c65d5839a2c80f716e55f4f41d5ab79c6a7`, normalized reader SHA-256
  `ba17ed90c603351c0e3737d9d10552b7571fecd19ff4fd451820111857d3b894`,
  22,845 normalized bytes, protocol v2, runtime 1.4.1.
- Hosted packed-consumer gate green twice: source head run `31897858353`
  job `95043852228`; evidence head run `31917172046` job `95090890714`.
  Probe result 27/27 assertions passed, 0 failed, synthetic stores only.
- One separately authorized installed-state read, 2026-08-16, exactly one
  attempt, no retry: started `00:20:46.865Z`, completed `00:20:46.877Z`,
  deadline `00:21:01.873Z`, exit 0, one allowlisted owned profile, read-only,
  no UI automation, no credential access, no profile enumeration.
- Store metadata byte-identical before and after: `profiles.json` 988 bytes
  SHA-256 `ae67f39f…cbb51`; `usage-snapshots.json` 2,559 bytes SHA-256
  `ede1ca9e…4725d`. Only those two named files were opened.
- Reader-reported configuration fingerprint
  `4e542833a481ca7eb2148de55a4486f0c03b3523801f548ae2b903ea1be9e3f4`
  matched the adapter's expected value.
- Normalized schema-v3 result: the required five-hour window was genuinely
  inactive (`claude-code:five-hour:inactive`, null used/remaining/reset) and
  normalized instead of refusing; the weekly window was active at
  8,800/1,200 basis points; the snapshot honestly self-described as past
  `freshUntil`, so downstream allocation still refuses fail-closed.

Proving the read-only input route grants no allocation authority, no standing
live-access authority, and no production admission.

### Stated limitations of this verification

These are recorded so the promotion is not read as stronger than it is.

- The live-read facts — reader digests, store file hashes, timings, the
  configuration fingerprint, and the 27/27 probe result — are **operator- and
  runner-attested**. They trace to the AM-lane checkpoint committed at
  `0197176` and to an operator-side preservation record outside this
  repository. This session did not re-execute the read and could not: doing so
  would require a new operator authorization. What *was* verified here is that
  every repository-side anchor matches — the reader commit, tree, and SHA-256
  pinned in `packages/application/src/account-manager-usage.ts` and in the
  packed-consumer library equal the values the evidence cites, and the cited
  adapter entry points exist.
- The promotion itself is **new work introduced by this merge**. Commit
  `0197176` added the successful-read evidence but never updated the matrix
  row, so no earlier lane review passed judgement on the promotion. It is
  covered instead by this candidate's own independent review and by the
  strengthened guard test.
- Both input lanes were exact-head green, but the **merged tree** is verified by
  this candidate's own exact-head hosted CI, recorded below. Input greenness is
  not a substitute for it.

## Exact remaining `ANT-02` requirement

One successful live Anthropic transport result from the pinned endpoint, API
version, and model, satisfying the exact bounded result contract, recorded as a
nonsecret result envelope, on a published green head, under a fresh one-shot
authorization with a genuinely new marker namespace.

Explicitly insufficient: synthetic diagnostics; receipt of an HTTP response;
credential provisioning or replacement; provider-console inspection; an
ambiguous attempt; output-validator compatibility; runtime-closure review.

Both prior canary markers stay consumed and were not accessed by this session.

## Local validation

Run on the exact merged bytes.

| Gate | Result |
| --- | --- |
| Literal root `npm run check` (typecheck + test + build, all workspaces) | **exit 0**, 1,623s (27m03s) |
| Literal root `npm run test:coverage` | **exit 0**, 967s (16m07s), 40 coverage roots |
| Aggregate coverage | statements 27,605/29,603 = 93.25%; branches 19,346/22,191 = 87.17%; functions 5,310/5,438 = 97.64%; lines 24,971/26,329 = 94.84% — every enforced floor (90/80/90/90) met |
| Aggregate tests | 3,469 passed, 29 skipped, 0 failed across 40 workspaces |
| Provider-Anthropic suite | 8 files, **213 passed** — the exact reviewed count |
| Scheduler suite | 5 files, **155 passed** — the exact reviewed count |
| Application suite | 10 files passed + 1 hosted-PostgreSQL file skipped locally, 70 passed / 1 skipped |
| Evaluation + audit suite | 4 files, 30 passed |
| `npm audit --audit-level=high` | **exit 0**, zero vulnerabilities at every severity across 264 dependency records |
| `npm ls --all` | **exit 0**, only expected platform/peer optional omissions (cross-platform TypeScript binaries, `pg-native`, `@vitest/browser`) |
| Lockfile integrity | `package-lock.json` is byte-identical to the diagnostic parent's (`9d28b70c…`), which is the superset carrying `node-gyp`; `npm ci` succeeded, proving it matches the merged `package.json` |
| Secret scan | 1,867,184 bytes across the 97 paths changed versus the merge base; one candidate, the synthetic PostgreSQL test-fixture password in `packages/application/test/postgres-factory.test.ts`, dispositioned non-secret |
| Static-policy scans | pass within their package suites |
| Documentation validation | the matrix guard test resolves every authority/implementation/test/evidence anchor to an existing path |
| Synthetic closure/validator suite | 59 tests, 0 failed (external readiness subject) |

Coverage did not regress. The AM lane's published aggregate was
93.18/86.90/97.54/94.79; this candidate is at or above it on every metric.

The PostgreSQL integration gate runs hosted only and is covered by the
exact-head CI recorded below.

## Independent review

A fresh independent read-only session reviewed the combined candidate, the
integration diff, the conflict resolutions, the acceptance-matrix change, the
AM-02 evidence, the diagnostic contract, the runtime closure, the validator,
the tests, the fixed request, and the synthetic marker model. It re-derived
rather than trusted — recomputing the fixed-request fingerprint from the pinned
constants without importing repository code, re-running three suites, and
checking every run and job id against the hosted records.

**Round 1 verdict: FAIL**, with three must-fix findings. All three were in the
external readiness subject; the repository merge claims were confirmed clean —
merge topology, zero content loss, no request drift, ANT-02 not promoted,
frozen evidence intact, gates strengthened rather than relaxed.

The three must-fix findings and their resolutions:

1. The validator's duplicate-key defense compared raw key slices, so a
   `\uXXXX`-escaped duplicate (`"code"` vs `"code"`) evaded it while
   `JSON.parse` collapsed the pair. A record could read `post-response` in its
   raw bytes and parse as `pre-dispatch`, inverting whether a request reached
   the provider. Fixed by comparing decoded key names; regression test added
   with a positive control.
2. A child could emit the validator's own `INTERNAL_REFUSAL` sentinel and be
   accepted, producing a record byte-identical to a genuine validator refusal
   and letting a real dispatched attempt be recorded as an apparent no-op.
   Fixed by restricting the accepted set to exactly the nine codes the canary
   emits and refusing the sentinel from a child.
3. The runtime closure's graph walker matched only `from "…"`, so it missed
   `require("…/ai_dev_os_windows_credential.node")` — the addon that reads the
   real credential — and pinned no `secrets-windows` compiled file, no
   `binding.gyp`, and no toolchain. Fixed: the walker now follows `require`
   and dynamic `import`, the closure grew from 37 to 42 compiled files, the
   native addon is pinned, and because it is not built in this worktree the
   manifest reports `complete: false` with an explicit blocker instead of
   presenting a finished closure.

Nine advisories were raised; seven were fixed and two accepted with the reason
recorded. Full detail, including dispositions, is in the readiness subject's
`review/independent-review-round-1.md`.

No finding touched the repository merge, no evidence was rewritten, no gate was
weakened, and ANT-02 was correctly not promoted.
