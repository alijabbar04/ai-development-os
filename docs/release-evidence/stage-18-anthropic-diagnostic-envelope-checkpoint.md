# Stage 18 Anthropic diagnostic envelope checkpoint

- Status: Source-only diagnostic extension, production-disabled, synthetic-only.
  No live provider request, credential access, or attempt marker occurred
- Date: 2026-08-16
- Branch: `fix/stage-18-anthropic-diagnostic-envelope`
- Base: `d26a68f695e16fcbd43f33b6717ec69e0e9c0982`
  (tree `312ef4f6af4fc43ae66cfe378a799eebdcfed8d9`, branch
  `fix/stage-18-anthropic-result-classification`, clean and synchronized at
  branch creation)
- Decision record: `docs/adr/0031-stage-18-anthropic-diagnostic-envelope.md`

## Outcome boundary

This checkpoint records a source and test change only. It is **not** an
`ANT-02` completion claim and contains no live evidence. `ANT-02` remains
`incomplete`, `developmentAccepted` remains `false`, and `productionAdmitted`
remains `false`. The `stage-18-development-acceptance-matrix.json` file is
deliberately **not** modified by this lane: its recorded `branch` belongs to a
different lineage, its `ANT-02` row is unchanged in substance, and editing it
here would imply progress this change does not establish.

The problem addressed is that `TRANSPORT_FAILURE` at
`failurePhase=response-received` — the exact public result of the consumed
2026-08-15 attempt — is produced identically by an expired credential, a spend
cap, an organization permission refusal, a rate limit, a withdrawn model, a
malformed request, a provider outage, and an unparseable payload. The previous
response projection rejected any non-200 status before reading anything else,
so the status was discarded by construction. Diagnostics now carry the cause.

Nothing here reclassifies the historical 2026-08-14 or 2026-08-15 attempts.
Both remain consumed, ambiguous, and un-retried.

## Changed paths

| Path | Change |
| --- | --- |
| `packages/provider-anthropic/src/testing/live-canary-diagnostics.ts` | New. Envelope types, allowlists, bounded payload projection, classifier, untrusted-boundary re-validation |
| `packages/provider-anthropic/src/testing/live-canary.ts` | Diagnostics on the error and its `toJSON()`; response projection defers acceptance until status and error envelope are observed; direct transport records socket-error family, request-id presence, and bounded `retry-after`; callback outcomes carry and re-validate diagnostics |
| `packages/provider-anthropic/src/testing/index.ts` | Exports the new envelope surface |
| `packages/provider-anthropic/test/anthropic-live-canary-diagnostics.test.ts` | New. 58 deterministic tests |
| `packages/provider-anthropic/test/anthropic-live-canary.test.ts` | One serialization assertion updated for the additive member and strengthened to pin the envelope's exact key set |
| `packages/provider-anthropic/README.md` | Documents the envelope, the unchanged success contract, and the no-prose rule |
| `docs/adr/0031-stage-18-anthropic-diagnostic-envelope.md` | New decision record |
| `docs/release-evidence/stage-18-anthropic-diagnostic-envelope-checkpoint.md` | This checkpoint |

No production source, provider registration, workflow, dependency, or lockfile
was modified. `git diff --stat -- package-lock.json` is empty.

## Diagnostic categories implemented

`local-precondition`, `broker-unavailable`, `network-transport`,
`local-timeout`, `credential-unauthenticated`, `billing-unavailable`,
`permission-denied`, `model-or-resource-unavailable`, `request-invalid`,
`request-conflict`, `request-too-large`, `rate-limited`,
`provider-internal-error`, `provider-timeout`, `provider-overloaded`,
`provider-refusal`, `response-unusable`, `unknown`.

Precedence is fixed: local cause, then transport, then HTTP status, then
response body. `unknown` is a first-class answer; an undocumented status is
reported as `unknown` with the numeric `httpStatus` retained rather than being
folded into a plausible family.

Classification never reads `error.message`. This diverges deliberately from the
readiness plan's §A2 proposal to pattern-match message prose for billing
detection; the documented `402 billing_error` type makes that channel
unnecessary, and message text can echo request content. See ADR 0031.

## Live request boundary — unchanged and proven

Asserted by `41. preserves the exact fixed request body, fingerprint, and token
cap`, reading the request the canary actually handed to the transport:

- endpoint `https://api.anthropic.com/v1/messages`; API version `2023-06-01`
- model `claude-haiku-4-5-20251001`
- body exactly
  `{"model":"claude-haiku-4-5-20251001","max_tokens":4,"messages":[{"role":"user","content":"Reply with exactly OK."}]}`,
  measured at 116 bytes, keys exactly `model`, `max_tokens`, `messages`
- SHA-256 of the observed body recomputed in the test as
  `0982d0a5d19ff6bf01bc87a40b96da6a33e84bccd294846ea7ecf1ccd2d7a13a`, equal to
  the published fingerprint and to the canary's own reported
  `requestFingerprint` (literal, independently computed, and reported values
  all compared)
- output cap 4; maximum response bytes 65,536; no streaming, tools, system
  prompt, metadata, repository content, or user content
- one dispatch per attempt across success, 429, 500, 504, and 529 — a
  classified-transient outcome causes no retry
- a second `run` after a diagnosed 529 returns `ALREADY_ATTEMPTED` with one
  recorded dispatch

The transport is raw `node:https` with no retry logic. No SDK retry path is
introduced; the official SDKs' default of two automatic retries is not used
anywhere in this canary.

## Validation performed

All commands run in
`C:\Users\mrali\Projects\ai-dev-os-stage18-anthropic-diagnostic-envelope-20260816`.

| Gate | Command | Result |
| --- | --- | --- |
| Package typecheck | `npm run typecheck --workspace @ai-dev-os/provider-anthropic` | exit 0 |
| Package build | `npm run build --workspace @ai-dev-os/provider-anthropic` | exit 0 |
| Package tests | `npm test --workspace @ai-dev-os/provider-anthropic` | exit 0 — 8 files, **213 passed** (155 pre-existing + 58 new) |
| Package coverage | `npm run test:coverage --workspace @ai-dev-os/provider-anthropic` | exit 0 — statements 93.30% (850/911), branches 88.41% (771/872), functions 99.06% (106/107), lines 96.71% (737/762) against floors 90/80/90/90 |
| Dependency audit | `npm audit --audit-level=high` | exit 0 — `found 0 vulnerabilities`; full breakdown 0 across info/low/moderate/high/critical over 264 dependency records |
| Lockfile integrity | `git diff --stat -- package-lock.json` | empty |
| Secret scan | 12 credential patterns over the seven non-checkpoint changed paths, measured on the final bytes | 2 candidates, both the published non-secret request fingerprint; dispositioned by inspection |
| Root check | `npm run check` (typecheck + test + build, all 40 workspaces) | exit 0 in 1,354 s — 0 failures, 40 workspace test summaries, `provider-anthropic` reporting 213 passed |

The root check was run twice, and only the second run is cited above. The first
run (exit 0, 1,337 s, 0 failures) executed `provider-anthropic`'s tests at
09:28:11 reporting **212** passed, which predates the post-review hardening that
added the 213th test. It therefore did not validate the committed bytes for that
package and is recorded here as superseded rather than counted. The cited run
executed the same package at 09:53:11 reporting **213** passed.

Secret-scan measurement basis, so the figure reproduces exactly: the twelve
patterns were applied to the concatenation of the seven non-checkpoint changed
paths, totalling **228,864 bytes** on disk —
`packages/provider-anthropic/README.md` (7,295),
`src/testing/index.ts` (2,618), `src/testing/live-canary.ts` (53,421),
`src/testing/live-canary-diagnostics.ts` (25,173),
`test/anthropic-live-canary.test.ts` (75,555),
`test/anthropic-live-canary-diagnostics.test.ts` (53,520), and
`docs/adr/0031-stage-18-anthropic-diagnostic-envelope.md` (11,282). Both
candidates are the string
`0982d0a5d19ff6bf01bc87a40b96da6a33e84bccd294846ea7ecf1ccd2d7a13a`, which is
the already-published SHA-256 of the public fixed request body and is not a
secret. This checkpoint is excluded from its own corpus because it records the
scan result.

No coverage threshold was lowered and no test was skipped or excluded. The
package's existing `vitest.config.ts` excludes `src/testing/**` from coverage
instrumentation, so the new diagnostics module does not appear in the coverage
table; it is exercised by the 58 deterministic tests rather than by
instrumented percentage.

## Guard discrimination measured

Each guard was removed and the suite re-run, per the repository rule that a
guard whose removal changes nothing observable is not a guard.

| Defect reintroduced | Observed |
| --- | --- |
| Read shadowed `byteLength` instead of the intrinsic accessor | `zeros response bytes through an intrinsic despite fill substitution` fails at `expect(shadowedByteLength).not.toHaveBeenCalled()` |
| Response body outranks HTTP status | `resolves conflicting status and error-type evidence deterministically` fails |
| Classify from `error.message` prose | `ignores provider prose that contradicts the structured evidence` fails |
| Validator stops checking the category allowlist | `rejects every single-field mutation of a valid envelope` fails on `totally-new-category` |
| Remove envelope re-validation only | Still refuses — no test fails |
| Remove diagnostics-aware outcome equality only | Still refuses — no test fails |
| Remove both together | `refuses a substituted diagnostics envelope injected through the broker` fails: the forged `rate-limited` claim surfaces as `TRANSPORT_FAILURE` |
| Supply unallowlisted values directly to the classifier | `normalizes unallowlisted values supplied directly to the classifier` fails |

The forged-broker vector discriminates that pair of guards rather than either
member individually; the validator is discriminated independently by the
mutation test. This is recorded rather than presented as two independent
proofs.

Two real defects were found during this work and fixed:

1. The new module initially read `body.byteLength` directly, which a payload can
   shadow with an own property. An existing repository guard caught it. It now
   reads through the intrinsic accessor.
2. The transport-envelope projection initially treated a malformed optional
   `retryAfterSeconds` as invalidating the whole envelope, which let a hostile
   secondary field blind the classifier to the HTTP status. Optional diagnostic
   fields are now fail-soft to their empty values while primary fields stay
   fail-closed.

## Privacy and safety boundaries

No credential was accessed, listed, read, validated, replaced, or deleted. No
Windows Credential Manager operation occurred. No credential marker was
created, read, deleted, or reused; both consumed canary attempt markers are
untouched. No live-canary environment variable was set and no live-provider
test was executed. No Anthropic or other provider request was made. No browser
or account automation occurred. The Codex v5 credential-launcher lane was not
inspected or modified. No Stage 17, Stage 20, Account Manager, production
registration, pull request, merge, rebase, force push, tag, or release action
occurred, and no worktree or preserved evidence was cleaned or deleted.

Every test uses synthetic transports and synthetic secret material. Redaction
vectors plant one recognizable sentinel in provider messages, nested body
fields, content-type, request identifiers, and thrown exception text, and each
redaction assertion is paired with a positive control proving the sentinel was
present in the fixture before classification.

## Required follow-up before any future live attempt

Changing the canary's structured result changes the executed runtime closure.
Per the readiness plan's step-3 rule, the wrapper, bootstrap, launcher, and
runtime-closure hashes must equal reviewed values, or a newly reviewed closure
must be re-audited read-only first. The canary launcher additionally validates
its child's output against its own allowlist, which this lane did not inspect
and must not modify.

Therefore this branch is not a drop-in edit ahead of a live run. Before any
future authorized canary attempt:

1. The Codex lane's credential replacement completes and is independently
   reviewed and approved.
2. The runtime closure containing this change is re-audited read-only.
3. The canary launcher's output validation is confirmed to accept the extended
   envelope.
4. A fresh authorization packet and a fresh marker namespace are issued; both
   existing markers remain consumed and are never reused.
5. Exactly one attempt runs, and its outcome is classified against the
   categories above.

None of those steps is performed, authorized, or implied by this checkpoint.

## Independent review

An independent, strictly read-only review session on a different model family
from the implementing session (Claude Fable 5; the implementation was authored
by Claude Opus 5) reviewed the complete change against the official Anthropic
taxonomy and the stated security and non-live boundaries. The reviewer executed
its own verification rather than accepting claims: package typecheck and the
full package suite, an independent recomputation of the request fingerprint
from the body literal found in source, a read of the classification precedence,
and a diff scan for environment opt-ins, marker operations, and new network
primitives. It made no file modification.

**Verdict: PASS, with zero must-fix findings.**

Independently confirmed by the reviewer: the fixed request body is 116 bytes
and hashes to `0982d0a5…a13a`; `contracts.ts` is untouched; `error.message` is
never read anywhere in the classifier; a 401 carrying an `overloaded_error`
body yields `credential-unauthenticated`; parsing is bounded at every level;
`ensureRecord` is a genuine descriptor-based projection; old three-key
transport responses and failure outcomes still project; the success result is
unchanged; the acceptance matrix is absent from the diff; and no marker or
credential code exists in the change. The reviewer also independently observed
that the change set is eight paths including `README.md`, matching this
checkpoint's manifest.

Five advisories were raised and dispositioned:

1. *The root-check row promised a record that no section provided.* **Applied** —
   the root check is now run on the final bytes and recorded below.
2. *The secret-scan corpus size did not reproduce byte-exact* (a post-scan ADR
   edit changed the total). **Applied** — the scan was re-run over the final
   bytes and the measurement basis is now stated with the file list.
3. *`classifyAnthropicLiveCanaryDiagnostics` passed its inputs through without
   membership re-validation*, coherent today because every producer is
   internal, but fragile for a future caller. **Applied** — the constructor now
   re-checks every field against its allowlist and normalizes anything
   unrecognized, with a new discriminating test.
4. *A `request-id` header longer than the 256-character bound reports
   `requestIdPresent: false`.* **Applied as documentation** — the behavior is
   intentional (presence is claimed only for a value actually validated) and is
   now stated at the function.
5. *Pre-existing reads of `response.statusCode` and `content-type` outside the
   new try/catch in the `end` handler.* **Not changed** — unmodified by this
   diff, reachable only through the testing injection seam, and repairing it
   would alter behavior outside this lane's scope. Recorded here so it is not
   lost.

The review is same-repository and same-session-family in tooling terms; it is
not a vendor-independent audit and does not substitute for one.

## Publication

Recorded below after commit, push, and exact-head hosted CI.
