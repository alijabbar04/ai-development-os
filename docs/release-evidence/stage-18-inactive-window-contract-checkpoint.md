# Stage 18 inactive-window contract checkpoint

- Status: Source candidate independently reviewed; publication proceeding under
  a newly authorized first-party hosted packed-consumer gate (first hosted
  execution pending on push); `AM-02` remains incomplete
- Date: 2026-08-13 (publication path added 2026-08-15)
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

## Next live boundary

Only after this AI Development OS branch is independently reviewed, committed,
pushed, and exact-head green may the operator refresh the named owned profile
and separately authorize exactly one repaired installed-state read. That read
must use the maintained reader, one explicit profile allowlist, a 15-second
deadline, safe before/after store metadata, redacted evidence, and no retry.
