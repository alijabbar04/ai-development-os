# ADR 0032: Stage 18 development-closure candidate integration

- Status: Accepted integration decision; `AM-02` is promoted to proven, `ANT-02`
  remains the only development blocker, and neither development acceptance nor
  production admission is granted
- Date: 2026-08-16

## Context

Two independently completed, independently reviewed, exact-head-green Stage 18
branches existed side by side and neither could see the other:

- `fix/stage-18-anthropic-diagnostic-envelope` at
  `edefcb80aaa794b572d048dfa6c3cb0bea36c0e1`
  (tree `d04f7c3e3c2cebc5bcc44e2d0dda8e2c3f801a9a`, parent
  `d26a68f695e16fcbd43f33b6717ec69e0e9c0982`), exact-head CI run `31938139741`
  passing all five jobs on attempt 1.
- `fix/stage-18-inactive-usage-window-contract` at
  `0197176eeb13d6b39e09f998e01a580da3b9b5b6`
  (tree `5082eb2a177ae3f7c07c0829100af2d04b0b673a`), exact-head CI run
  `31917172046` passing all six jobs on attempt 1, including the first-party
  `packed consumer (windows)` gate.

Their merge base is `c50c4725981013f123ebef0d0a87082f085b333d`. Neither is an
ancestor of the other; both descend independently from that base. Because the
two lanes ran in parallel, each branch's copy of the shared Stage 18
current-state documents and of the acceptance matrix reflected only its own
lane's progress, and each was stale about the other's.

The `AM-02` lane's own matrix was additionally stale about itself. Its matrix
row was written in the publication commit `7116c39`, before the two evidence
commits that completed the row: `fdff306` (hosted packed-consumer evidence) and
`0197176` (the successful separately authorized installed-state read). No
single existing head therefore stated the true combined Stage 18 position.

## Decision

Integrate the two exact reviewed tips into one candidate branch,
`feat/stage-18-development-closure-candidate`, using a history-preserving
non-fast-forward merge that keeps both parents and both complete evidence
ancestries reachable. Neither source branch is rebased, rewritten, retagged, or
deleted, and neither remote ref is moved.

A non-fast-forward merge is chosen deliberately over any rewriting method. The
value of both inputs is that specific reviewed bytes passed specific exact-head
hosted runs. Rebasing would create new commits that no CI run and no review
verdict describes, silently invalidating the evidence chain that makes the rows
provable at all. Squashing would additionally destroy the per-commit boundary
between the AM lane's implementation commit and its two evidence commits, which
is what establishes the ordering of publication, hosted gate, and authorized
read.

Conflicts are resolved by present truth rather than by side. No whole-merge
`ours` or `theirs` strategy is used. For each conflict the question asked is
whether the content is *historical evidence* or *current state*:

- Historical evidence is preserved exactly as recorded, including outcomes that
  later work superseded. The frozen Phase A completeness-audit subject, its
  recorded result, and its embedded matrix snapshot are read from frozen blobs
  at the frozen subject head and are not restated.
- Current-state documentation is reconciled to the combined truth, in
  `README.md`, `docs/product-direction.md`, `docs/technical-design.md`,
  `docs/implementation-roadmap.md`, `docs/adr/0027-…`,
  `packages/application/README.md`, and the authoritative acceptance matrix.
- Statements that are true of a *specific past subject* keep their scope. Where
  a document said the Phase A audit found `ANT-02` and `AM-02` failing, that
  remains recorded as the frozen Phase A outcome, with the note that `AM-02`
  was proven after that subject was taken.

Both branches' source and tests are carried across byte-identically. Every
load-bearing file of both lanes hashes equal to its reviewed blob on the
merged tree; the merged tree differs from *both* parents only in the shared
files that genuinely required reconciliation.

## Why `AM-02` becomes proven

`AM-02` requires: *a supported read-only live Account Manager integration
supplies authorized profile snapshots without UI or credential extraction*.

Every element of that criterion is satisfied by committed evidence that is
already exact-head green, and nothing in this integration creates the proof:

- The supported route is the maintained reader pinned at commit
  `f958ccaee81452f919e7321078899de692f0c81c`, tree
  `04c22c65d5839a2c80f716e55f4f41d5ab79c6a7`, normalized reader SHA-256
  `ba17ed90c603351c0e3737d9d10552b7571fecd19ff4fd451820111857d3b894`,
  protocol v2, runtime 1.4.1, consumed through
  `packages/application/src/account-manager-usage.ts`.
- The published package surface is proved by the first-party hosted
  packed-consumer gate, green at the source head (run `31897858353`, job
  `95043852228`) and again at the evidence head (run `31917172046`, job
  `95090890714`), with a 27/27 probe result over synthetic stores only.
- The live proof is exactly one separately authorized installed-state read on
  2026-08-16 under that green head: one allowlisted owned profile, a 15-second
  deadline, one attempt, no retry, read-only, no UI automation, no credential
  access, and no directory enumeration. Only two named store files were opened
  and both were byte-identical before and after.
- The result is a normalized schema-v3 authorized-profile snapshot. The real
  five-hour window was genuinely inactive and was projected as null-capacity,
  non-allocatable evidence instead of refusing — the exact condition that had
  produced the earlier refusals. The weekly window projected normally. The
  snapshot honestly self-described as past `freshUntil`, so downstream
  allocation still refuses fail-closed.

Proving the read-only *input* route grants no allocation authority, no standing
live-access authority, and no production admission.
`ACCOUNT_MANAGER_LIVE_ACCESS_ENABLED` remains literal `false`, and any further
read requires a new operator approval cycle.

## Why `ANT-02` stays incomplete

`ANT-02` requires one successful live transport proof: an exact successful
result from the pinned endpoint, API version, and model, satisfying the bounded
result contract, recorded as a nonsecret envelope on a published green head
under a fresh one-shot authorization.

No such result exists. Two separately authorized attempts are consumed: the
2026-08-14 attempt returned an unphased `TRANSPORT_FAILURE`, and the 2026-08-15
attempt observed a provider response and failed closed with `TRANSPORT_FAILURE`
at `failurePhase=response-received`. Neither was retried and both markers stay
consumed and unread.

The diagnostic envelope introduced by ADR 0031 improves how a future finite
failure is *classified* across eighteen categories. It is explicitly not
transport proof. `ANT-02` is not promoted by synthetic diagnostics, by receipt
of an HTTP response, by credential provisioning or replacement, by an ambiguous
attempt, by provider-console inspection, by output-validator compatibility, or
by runtime-closure review. Only the exact successful live transport result
promotes it.

## Effect on the live-canary runtime closure

The canary's structured result changed on the diagnostic branch, so the runtime
closure that a future attempt would execute is not the closure any earlier
authorization described. Two consequences follow.

First, the historical 2026-08-15 launcher cannot simply be reused. It is bound
to superseded source and to a consumed authorization and marker, and its output
validator predates the additive diagnostic envelope. It is retained as design
evidence and is neither executed nor modified.

Second, a future attempt requires a runtime closure rebuilt from this exact
combined head and a validator that accepts the extended envelope while still
refusing everything the narrower contract refused. Both are prepared
synthetically outside the repository as readiness artifacts. They are
non-effect: they use fake brokers and fake transports only, create no real
marker, and read no credential.

## Acceptance state

- `AM-02` — proven.
- `ANT-02` — incomplete; the only remaining development blocker.
- `INT-01` — proven.
- `PLN-02` — incomplete; production-track, owner Stage 19.
- `PRD-01` — production-gated on Stage 17W.
- `developmentAccepted` — `false`, derived from `ANT-02` rather than asserted.
- `productionAdmitted` — `false`; the version-1 admission schema still has no
  admitted member.

Stage 20A remains ineligible: it requires an authoritative integrated head
where `developmentAccepted` is true, and this candidate is not that head.

## Consequences and nonclaims

This integration performs no credential operation, no provider or network
request, no marker creation, read, or reuse, no production enablement, no pull
request, no merge to `main`, no rebase, no force push, no tag, and no release.
It starts no Stage 20 or Stage 21 work and executes no Stage 17W operation.

The matrix guard test is strengthened rather than relaxed: it now pins the
exact set of unproven development-blocking rows to `["ANT-02"]`, so a later
edit cannot quietly promote `ANT-02` or silently regress `AM-02`.

Operator acceptance remains a separate decision. Setting `developmentAccepted`
requires the successful `ANT-02` proof first, and `productionAdmitted`
additionally requires Stage 17W and later deployment gates.
