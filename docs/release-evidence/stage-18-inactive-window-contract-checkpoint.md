# Stage 18 inactive-window contract checkpoint

- Status: Published. Source-head hosted CI is green on attempt 1 across all
  six jobs, including the first execution of the first-party packed-consumer
  gate; `AM-02` remains incomplete pending the separately authorized
  installed-state read
- Date: 2026-08-13 (publication path added 2026-08-15; published 2026-08-15)
- AI Development OS branch: `fix/stage-18-inactive-usage-window-contract`
- AI Development OS base: `c50c4725981013f123ebef0d0a87082f085b333d`

## Outcome boundary

The Account Manager and AI Development OS now share an explicit versioned
active/inactive usage-window projection. This deterministic repair is not an
installed-state proof. No installed Account Manager file was read or changed
while producing this candidate, and `AM-02`, `developmentAccepted`, and
`productionAdmitted` remain false pending the separately authorized fresh read
and the final exact-head hosted gate.

No Anthropic request, credential discovery, Stage 17 elevation, protected-leaf
operation, production effect, PR, merge, tag, release, signing, registry
publication, force push, or history rewrite occurred.

## Exact Account Manager dependency

The repaired reader is published on
`fix/inactive-usage-window-contract` at:

- commit `f958ccaee81452f919e7321078899de692f0c81c`;
- tree `04c22c65d5839a2c80f716e55f4f41d5ab79c6a7`;
- 32-path inventory SHA-256
  `1c22b7d9ed06654563254f37495a774f7c81c7dd6bc376b5af43c84ff710c9e4`;
- normalized reader bytes: 22,845;
- normalized reader SHA-256
  `ba17ed90c603351c0e3737d9d10552b7571fecd19ff4fd451820111857d3b894`;
- exact-head hosted run `31698454113`: success.

The previously reserved rerun of original run `31549101139` was consumed once.
Attempt 2 acquired the Windows runner and passed at exact original commit
`5279113728a344a87a7e49c4222741a618b67dd5`; no second rerun occurred.

## Contract decision

Account Manager reader protocol v2 emits each required window as exactly one of:

- `active`: stable window identity, bounded used/remaining basis points, and a
  bounded reset timestamp; or
- `inactive`: stable inactive identity and null used, remaining, and reset
  fields.

An inactive required window is valid source evidence but never allocatable. It
is not zero usage, unlimited capacity, or an active reset. Irrelevant inactive
model-scoped weekly evidence is ignored only after bounded exact parsing.
Missing required kinds, ambiguous duplicates, contradictory active/inactive
fields, malformed JSON, stale evidence, or source/configuration/profile drift
still fail closed.

AI Development OS scheduler snapshot schema v3 preserves that union. Routing
requires both required windows to be active before any owned or borrowed
allocation or cap arithmetic. Usage-snapshot schema-v1/v2 remains a bounded
standalone parser/audit migration but never authorizes new dispatch. Worker
runtime state, aggregate, and event schema v2 explicitly refuse rather than
silently reinterpret v1 aggregates or journals containing legacy snapshots;
work definitions remain v1. Borrowed
weekday five-hour 50-percent, weekly 70-percent, predicted-crossing, authorization,
revocation, freshness, provider/profile identity, and Fable exclusions remain
unchanged.

## Local validation

Exact-current-byte results on the AI Development OS candidate:

- scheduler: 5 files, 155/155 tests passed;
- application: 8 files passed, 1 hosted-PostgreSQL file skipped locally,
  52/52 executed tests passed;
- literal root `npm run check`: exit 0 after 29m09s, including every workspace
  typecheck, test, and production build;
- literal root `npm run test:coverage`: exit 0 after 18m00s with all 39 package
  coverage roots present. Aggregate exact fractions are 26,968/28,941
  statements, 18,827/21,664 branches, 5,215/5,346 functions, and
  24,462/25,804 lines, yielding floor-to-two-decimal coverage of 93.18%,
  86.90%, 97.54%, and 94.79%;
- scheduler coverage is 1,906/2,093 statements, 1,592/1,808 branches,
  308/317 functions, and 1,817/1,954 lines;
- application coverage is 356/374 statements, 244/264 branches, 42/43
  functions, and 339/356 lines;
- repository `npm audit --json`: exit 0, zero
  info/low/moderate/high/critical vulnerabilities across 246 dependency
  records; `npm audit --audit-level=high`: exit 0, zero vulnerabilities;
- `npm ls --all`: exit 0 with only expected platform/peer optional omissions;
- scheduler dry pack: 78 entries, 106,202 packed bytes, 618,838 unpacked
  bytes, shasum `8f2db55f3c69c371f676444596d636d6d274790c`, zero bundled dependencies;
- application dry pack: 30 entries, 30,712 packed bytes, 152,592 unpacked
  bytes, shasum `5ffb53a8bb995b9babae891aaf1574fa3fc77377`, zero bundled dependencies;
- the exact Account Manager fixture has normalized bytes and SHA-256 equal to
  the published reader identity above; and
- independent GPT-5.6 Sol/Max same-family, strictly read-only review of the
  exact 31-path candidate: PASS, with no remaining source/package/test/docs
  blocker. The review did not exercise installed/private/live state.

The required fresh packed-consumer command was rejected before execution by
the command safety policy in the original session. The continuation recovered
that exact prior tool call from its preserved session record and submitted it
once unchanged at `2026-08-13T16:30:24Z`; the safety policy again rejected it
before execution. On 2026-08-14 the operator granted a fresh exact one-attempt
authorization for that same ordinary command. It was submitted once unchanged
and the safety policy again rejected it before execution. None of the three
refusals created a temporary directory, package install, tarball, or consumer
process. The action was not rerouted, rewritten, split, wrapped, substituted,
or retried after the newly authorized refusal.

## First-party hosted packed-consumer gate — 2026-08-15 publication path

On 2026-08-15 the operator explicitly authorized publication of this exact
preserved candidate through a new, repeatable, repository-owned hosted CI
mechanism instead of the consumed local command. The consumed local one-shot
remains consumed: it was not retried, rewritten, split, wrapped, renamed,
moved, or disguised, and no equivalent pack-install-import flow was executed
locally while preparing this delta. Before any edit, the candidate's exact
starting identity was preserved externally and re-verified byte-for-byte
(30 modified + 1 untracked paths; aggregate 898,461 bytes; ordinal
`state|path|bytes|sha256` manifest 3,887 bytes, SHA-256
`70a6311d869619c693847d6d16511151f701a36c69ca6c1dd6d610e678e4c420`, equal to
the rebaselined binding recorded on 2026-08-14).

The new gate consists of:

- `packages/application/scripts/packed-consumer/verify-packed-consumer.mjs` —
  the orchestrator the dedicated CI job runs (root script
  `verify:packed-consumer`). It packs the seven consumer-relevant workspaces
  (`domain`, `artifacts`, `persistence`, `persistence-sqlite`,
  `persistence-postgres`, `scheduler`, `application`) from the exact
  checked-out head, records each tarball's nonsecret identity (entry count,
  packed/unpacked bytes, npm shasum, SHA-256), enforces a payload policy of
  exactly `package.json` + `README.md` + `dist/**`, installs the tarballs into
  a fresh task-owned consumer directory on the hosted runner with lifecycle
  scripts disabled plus lockfile-pinned registry dependencies
  (`better-sqlite3@12.11.1`, `pg@8.23.0`, `pg-pool@3.14.0`), performs the
  repository's single sanctioned lifecycle exception (one explicit
  `npm rebuild better-sqlite3`, required because the application production
  root eagerly composes the SQLite adapter), verifies the post-rebuild
  dependency graph (`npm ls --all`) and the high-severity audit, records the
  generated consumer lockfile digest, and then executes the consumer probe.
  Any mismatch or ambiguity exits non-zero.
- `packages/application/scripts/packed-consumer/probe.mjs` (+ shared
  `lib.mjs`) — runs inside the consumer and imports only the documented
  production package roots from the installed tarballs. It proves: the exact
  pinned Account Manager identities (commit `f958ccae…`, tree `04c22c65…`,
  reader SHA-256 `ba17ed90…b894`, protocol v2, runtime 1.4.1); that
  testing-only entry points are absent from production roots; reader
  protocol-v2 active and inactive window behavior against bounded synthetic
  stores (inactive windows preserved as null capacity and refused by
  `usage.window.inactive` before any cap arithmetic); the borrowed 50%
  working-hours five-hour and 70% weekly hard caps and their working-hours
  scoping; the borrowed-profile Fable exclusion; schema-v2 migration remaining
  dispatch-ineligible; and a fail-closed matrix covering missing, malformed,
  future-dated, capacity-contradictory, ambiguous-duplicate, stale, cached,
  cancelled, deadline-expired, profile-substituted, reader-tampered, and
  configuration-substituted cases — each with its finite refusal code and no
  store-value echo. It uses only synthetic stores beneath the consumer
  directory: no installed Account Manager state, profile enumeration,
  credential, browser, UI, or network access exists in the probe.
- A dedicated `packed-consumer` job in `.github/workflows/ci.yml`
  (`packed consumer (windows)`, windows-latest, 35-minute timeout, pinned
  action SHAs, `persist-credentials: false`, workflow-level
  `permissions: contents: read`, no secrets, no privileged token, no
  `pull_request_target`, no artifact upload, no cache writes beyond the
  existing reviewed npm cache, no publication) running on the existing push
  and pull-request triggers.
- Focused deterministic tests
  (`packages/application/test/packed-consumer-lib.test.ts`,
  `packages/application/test/packed-consumer-policy.test.ts`) covering the
  gate's pure helpers and statically pinning the workflow/script security
  policy, including that the helper-library pins equal the compiled
  application constants and that the committed reader fixture equals the
  published reader digest.

This mechanism is a new, visible, continuously repeatable first-party CI gate
— a different mechanism under a different authorization producing a stronger,
durable evidence class — not a retry or disguise of the consumed local
command, whose refusals above remain the historical record. The gate's first
execution occurs on the hosted runner for this branch's push; no hosted
packed-consumer result is claimed in this section, and fresh-consumer
validation, commit, non-forced push, and exact-final-head hosted CI remain
unclaimed until the evidence update that follows those events. `AM-02`,
`developmentAccepted`, and `productionAdmitted` remain false; the separately
authorized installed-state read remains required and is not authorized by the
publication grant.

## Publication and first hosted packed-consumer execution — 2026-08-15 results

The preserved candidate plus the reviewed gate delta were staged by an explicit
38-path list only, committed as source commit
`7116c394d8afb5d5264e4e1f846784330de00bd3` (tree
`124579747e35af2ffa4a7cce075e3f10e14f06c4`, parent exactly the preserved base
`c50c4725981013f123ebef0d0a87082f085b333d`; 38 files, +2,994/−204), and pushed
once, non-forced, establishing upstream
`origin/fix/stage-18-inactive-usage-window-contract`; the remote object id was
verified equal to the local head after the push. No pull request, merge, tag,
release, force push, or history rewrite occurred.

Exact-source-head hosted run `31897858353`
(https://github.com/alijabbar04/ai-development-os/actions/runs/31897858353)
completed success on attempt 1 with all six jobs passing and no rerun:
dependency audit `95043852195` (12s); PostgreSQL integration `95043852188`
(57s); check (ubuntu-latest) `95043852207` (8m17s); **packed consumer
(windows) `95043852228` (5m50s) — the first execution of the new gate**;
coverage `95043852219` (14m07s); check (windows-latest) `95043852269`
(26m05s).

The packed-consumer job's deterministic evidence (from its log): runner
`win32-x64`, Node `v24.19.0`, npm `11.17.0`, work root in runner temp;
lifecycle scripts disabled during the consumer install (`better-sqlite3`
binding verified absent, then present after the single sanctioned
`npm rebuild better-sqlite3`); consumer manifest SHA-256
`ba32fe19089054b5923d24fe5d0f4b07bc2b6bc53ff143284785e812e104d70a`; generated
consumer lockfile SHA-256
`9827cf127541cca7aac7b6325d5c2ea90be039f9455d78c1ee447a3437279166`;
`npm ls --all` clean with exactly 10 top-level dependencies; high-severity
audit zero; reader artifact re-verified on the runner at 22,845 normalized
bytes, SHA-256 `ba17ed90c603351c0e3737d9d10552b7571fecd19ff4fd451820111857d3b894`;
probe result 27/27 assertions passed, 0 failed (imports, pins,
testing-surface absence, active/inactive normalization, cached/stale
refusals, the eleven-case fail-closed matrix, work-hours calendar, owned
selection, borrowed 50%/70% caps, Fable exclusion, inactive-window refusal
before cap arithmetic, legacy-v2 dispatch refusal, synthetic-only boundary).

Packed tarball identities at the exact source head (`entries / packed bytes /
unpacked bytes / npm shasum / SHA-256`):

- `ai-dev-os-domain-0.1.0.tgz` — 42 / 45,741 / 213,312 /
  `f033aa74bca0a493f65bd8736b201bd3570aa8fb` /
  `021495ced326ed62cdbdfe1489dcc46cf353f0d436979cddfe38ccd54ba63e81`
- `ai-dev-os-artifacts-0.1.0.tgz` — 18 / 12,226 / 47,609 /
  `5364c277d7b2ed2d4496a9c05720ab84c89ae572` /
  `27f4fd35779aa374fe5ec8e2ebcf4018c9d66e4319409dcd4a212895f3cbf8d6`
- `ai-dev-os-persistence-0.1.0.tgz` — 46 / 38,139 / 184,429 /
  `7e5d8c549538029c1e481afdc9ff25d4a060d72e` /
  `ba1cc6f0ed3751180b7b83da75cdc96263b58577534a01fa1f753ba5f0dbd10d`
- `ai-dev-os-persistence-sqlite-0.1.0.tgz` — 18 / 16,699 / 70,862 /
  `953611f3f5ed1ebd5909141f670826bd05e853d4` /
  `878a19a4e0ad9371e1bc3889d985d0a019af31e24e932907069a3f0797805449`
- `ai-dev-os-persistence-postgres-0.1.0.tgz` — 22 / 25,991 / 120,643 /
  `b8e484fa1656cfb1e25c9f4f0a640dc602cfb594` /
  `558965235a518017867054ba48c23eb6e9b9616107b8881090990076a57e310a`
- `ai-dev-os-scheduler-0.1.0.tgz` — 78 / 106,205 / 618,851 /
  `3febc206c4493f8f0bd2738114829f8f1b721463` /
  `58d2c88f3c46fc1cd37363b0b9703f9a40431a73c7a0b5ef74d245b4ec50d286`
- `ai-dev-os-application-0.1.0.tgz` — 30 / 30,715 / 152,613 /
  `33e22cecad8f509f70f7003b4fa5d32e22b0bb9e` /
  `dcb3d326606c2e4c67108a4497897146d902804f474575eed5de21fa229878e6`

Pre-publication validation on the exact committed bytes: focused
packed-consumer tests 18/18; scheduler 155/155; application 70 passed plus
one hosted-PostgreSQL skip; literal root `npm run check` exit 0 in 1,384
seconds across all 39 workspaces; literal root `npm run test:coverage` exit 0
in 972 seconds with every enforced per-package floor met;
`npm audit --audit-level=high` exit 0 with zero vulnerabilities at every
severity across 246 dependency records; a conservative credential-pattern
scan over all 38 committed paths dispositioned its single candidate (a
synthetic PostgreSQL test-fixture password) as non-secret. Independent
review: a strictly read-only same-family (Claude Fable 5) review session
returned FAIL with one must-fix (a CRLF-fragile test assertion that would
have failed the first hosted Windows legs) plus advisories; after repair, a
second strictly read-only same-family review returned PASS on the final bytes
with candidate drift re-verified at zero. Neither review executed code or
exercised installed, private, credential, or provider state, and neither
constitutes model-family-independent review.

Privacy and safety boundaries are unchanged: no installed Account Manager
store, profile, credential, token, browser, or UI state was read or accessed
at any point; the hosted gate used bounded synthetic stores only; no
provider or Anthropic request ran; no Stage 17, Stage 20, production,
registry-publication, PR, merge, tag, or destructive action occurred. **No
installed-state read has occurred. `AM-02` remains incomplete until one
separately authorized repaired installed-state read succeeds and is
published at a green exact head; `developmentAccepted` and
`productionAdmitted` remain false.** This evidence update is itself the only
change in its commit; the final evidence-head hosted run is recorded outside
this file by the publication session.

## Next live boundary

Only after this AI Development OS branch is independently reviewed, committed,
pushed, and exact-head green may the operator refresh the named owned profile
and separately authorize exactly one repaired installed-state read. That read
must use the maintained reader, one explicit profile allowlist, a 15-second
deadline, safe before/after store metadata, redacted evidence, and no retry.
