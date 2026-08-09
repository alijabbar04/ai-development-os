# Stage 18A production-disabled orchestration foundation checkpoint

Date: 2026-08-09

Status: **IMPLEMENTED AND READ-ONLY VALIDATED; PRODUCTION DISABLED**

This evidence records an ordinary software-engineering checkpoint stacked on
the reviewed Stage 17W evidence branch. It does not execute, authorize, or
alter the separately safety-gated Stage 17W operation. It also does not admit
Stage 17 or Stage 18, start a live provider thread, integrate an account
manager, install native components, or establish production eligibility.

## Authority and scope

- Branch: `feat/stage-18a-orchestration-foundation`.
- Exact base commit:
  `a8f5bf4f3182a8e47bbbb27260f6a7d159102a8c`.
- Exact base tree:
  `ecec54699fcd118e58a452ff9e22626c08257ccf`.
- The base branch's exact-head hosted CI run `31321848500` completed
  successfully with all four jobs green.
- The checkpoint consists only of the new scheduler package, the bounded
  provider-Codex declaration compatibility seam and tests, package metadata,
  ADR 0021, and this evidence file.
- No merge, tag, release, signing, production registration, or Stage 18
  admission is part of this checkpoint.

## Production-disabled implementation boundary

`@ai-dev-os/scheduler` provides versioned exact-key task, event, result, usage,
and route contracts; deterministic event replay; atomic aggregate-plus-journal
persistence; provider-neutral lifecycle ports; bounded retry, deadline,
concurrency, cancellation, approval, and recovery behavior; and hard
usage-aware authorized-profile routing. Tasks carry a managed workspace
identity, not a path, executable, credential, endpoint, or ambient authority.

The production-shaped factory keeps dispatch compiled closed and records a
terminal policy block. The only executable lifecycle factory is exported from
the package's testing subpath, requires a structurally marked deterministic
fake adapter, and has no production authority. Full-journal replay and stored
aggregate comparison are deliberately retained in this foundation;
snapshot/compaction and multi-worker fencing remain later work.

The `@ai-dev-os/provider-codex` seam reflects the reviewed
`@openai/codex-sdk` 0.147.0 declaration surface without adding or importing the
SDK at runtime. It accepts only an explicitly injected exact-version fake in
tests. Default start, continue, and resume behavior is a production-disabled
policy block. Even deterministic execution resolves an exact contained managed
workspace, uses only `read-only` or `workspace-write`, keeps approval
`on-request`, disables network and web search, grants no additional directory,
and retains no raw agent message, reasoning, command, MCP, web-search, file
change, or provider-error content.

The scheduler remains a regular provider-Codex package dependency because the
emitted declaration files reference its public lifecycle types and downstream
TypeScript consumers must resolve those declarations. The emitted seam
JavaScript has no scheduler import.

## Routing and durability invariants

- Hard eligibility runs before scoring and cannot be revived by preference or
  fallback ordering.
- Missing, stale, duplicated, contradictory, low-confidence,
  non-authoritative, future-dated, or identity-mismatched usage fails closed.
- Authorized-borrowed profiles have a 70% weekly ceiling and, during London
  weekdays from 09:00 inclusive to 17:00 exclusive, a 50% five-hour ceiling.
  A projection may land exactly on a ceiling; a profile already at it cannot
  begin another task, including a rounded-zero estimate.
- Authorized-borrowed profiles are never eligible for Fable work.
- Journal time cannot precede task creation or move backwards. A retry's
  schedule and event occurrence share one captured timestamp, including a
  zero-delay retry.
- Aggregate and event writes are one transaction. Fault-injection tests cover
  rollback for both in-memory and SQLite adapters; SQLite reopen replay is also
  covered.

## Validation evidence

The following checks used only local deterministic fixtures. The four
provider-Codex live cases remained intentionally skipped; no product provider,
live SDK thread, account-manager UI, native stateful proof, network canary, or
safety-gated operation was invoked.

| Check | Result |
| --- | --- |
| Scheduler typecheck and build | PASS |
| Scheduler coverage suite | 85/85 PASS; 91.39% statements, 86.70% branches, 93.60% functions, 95.67% lines |
| Provider-Codex typecheck and build | PASS |
| Provider-Codex coverage suite | 100 PASS, 4 opt-in live cases skipped; 90.36% statements, 85.37% branches, 93.99% functions, 96.36% lines |
| Initial-candidate repository typecheck | PASS |
| Initial-candidate repository test suite | PASS; all workspaces, with only documented opt-in cases skipped |
| Initial-candidate repository build | PASS |
| Initial-candidate dependency audit | `npm audit --audit-level=high`: zero vulnerabilities |
| Initial-candidate dependency tree | `npm ls --all --omit=optional`: exit 0; platform optionals remained optional |
| Initial-candidate package dry runs | Scheduler: 58 entries, 45,914 packed bytes, 240,709 unpacked bytes; provider-Codex: 70 entries, 65,066 packed bytes, 313,455 unpacked bytes; only declared package files |
| Affected build repeatability | Scheduler: 56 emitted files and zero differences; provider-Codex: 68 emitted files and zero differences |
| Patch hygiene | `git diff --check`: PASS |

The repository-wide rows above were completed before the safe-failing review
advisories were applied. The final post-advisory scheduler and provider-Codex
rows cover every affected source package and are the authoritative local
results for the final candidate. A combined post-advisory root wrapper was
also attempted, but the existing Stage 1 validation chain did not return
within the 40-minute wrapper limit. That attempt is inconclusive and is not
counted as a pass or failure. Exact-head hosted CI remains the final clean-host
repository-wide check.

## Independent read-only review

Claude Code CLI 2.1.201, using actual model `claude-opus-4-8` at max effort
with tools disabled, reviewed the exact staged candidate through standard
input. Session `e240e2cd-541a-4ce8-af4c-a03d43c36bc9` returned **PASS** with no
must-fix finding, no permission denial, and reported API cost `$2.0553565`.

The review's safe-failing advisories were addressed as follows:

1. Cap equality now has explicit policy text and both weekly and five-hour
   fixtures.
2. The scheduler dependency remains regular, with the declaration-resolution
   reason documented above.
3. SQLite now has a fault injected specifically between aggregate and journal
   writes, proving rollback.
4. Full-journal replay cost and later snapshot/compaction work are documented
   without weakening corruption detection.
5. Disabled continue/resume and external/deadline abort paths now have direct
   tests.
6. The testing subpath remains explicitly private, fake-only, and without
   production authority.

## Reviewed source reference

The compatibility design was checked against the official Codex SDK
documentation at <https://learn.chatgpt.com/docs/codex-sdk>. That review does
not substitute for a future exact-version production compatibility and
security review.

## Exact remaining safety-gated operation

The exact remaining safety-gated operation is **the exact separately
authorized Stage 17W stateful operation**. It remains separate and untouched;
this checkpoint neither describes nor recreates its procedure.

Until that gate and all later admission evidence succeed, Stage 17W remains
incomplete, Stage 18 remains production-disabled, and no merge, tag, release,
or production workload is authorized.
