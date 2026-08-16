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

Every load-bearing file of both lanes hashes equal to its reviewed blob on the
merged tree — 8 diagnostic paths against `edefcb80…` and 20 AM paths against
`0197176e…`, all `IDENTICAL` by `git hash-object` versus `git rev-parse <head>:<path>`.

The merged tree differs from *both* parents in exactly nine paths, which are
precisely the reconciled shared files listed above. It differs from the
diagnostic parent in 38 paths (the AM lane's contribution plus reconciliation)
and from the AM parent in 66 paths (the diagnostic lane's contribution plus
reconciliation).

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

## Exact remaining `ANT-02` requirement

One successful live Anthropic transport result from the pinned endpoint, API
version, and model, satisfying the exact bounded result contract, recorded as a
nonsecret result envelope, on a published green head, under a fresh one-shot
authorization with a genuinely new marker namespace.

Explicitly insufficient: synthetic diagnostics; receipt of an HTTP response;
credential provisioning or replacement; provider-console inspection; an
ambiguous attempt; output-validator compatibility; runtime-closure review.

Both prior canary markers stay consumed and were not accessed by this session.

## Validation

Recorded in the "Local validation", "Independent review", "Commits and remote"
and "Exact-head hosted CI" sections below once each gate has actually run. No
result is claimed before it exists.
