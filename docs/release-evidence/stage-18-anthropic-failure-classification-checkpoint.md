# Stage 18 Anthropic failure-classification checkpoint

- Date: 2026-08-15
- Status: deterministic repair source published and exact-source-head hosted
  green; final evidence publication and any newly authorized live attempt remain
  future boundaries
- Branch: `fix/stage-18-anthropic-result-classification`
- Base head: `f47bc3b8d1702ae3ff487a415078f46e45d155fc`
- Base tree: `4db86b74f943aaeecb27a726d585a584bfd9c954`
- Source head: `a597e58c253a9765a2005f2b56e95b820f16ef6f`
- Source tree: `caa4e5a372a4b0291a9b37466e483bb58b9e8aef`

## Outcome

The previously consumed owned-reference canary remains ambiguous. Its finite
`TRANSPORT_FAILURE` does not establish whether the request was never submitted,
might have been submitted, received an HTTP response, or completed response
validation before a callback/audit failure. It was not retried.

Source inspection found a deterministic classification defect. The canary ran
transport and response parsing inside `SecretMaterial.useText`, while the
Windows credential broker deliberately maps every thrown consumer exception to
fixed `CONSUMER_FAILURE`. The canary then mapped that broker error to
`TRANSPORT_FAILURE`. HTTP status, response parsing, secret-callback, and broker
outcome-audit failures could therefore collapse to one code.

The repair carries an exact bounded success/failure outcome through the secret
callback, lets the broker dispose material and finish auditing, and reconstructs
the finite error afterward. Every error also carries exactly one conservative
phase: `pre-dispatch`, `possibly-dispatched`, `response-received`, or
`post-response`. A separate `CALLBACK_RESULT_FAILURE` identifies broker,
outcome-projection, clock, or finalization failure without pretending it was a
transport failure. Injected callback results are exact-key and enum-bound before
use; mutable option methods are captured without caller-shadowable `bind`.
Both the broker callback and the nested `SecretMaterial.useText` callback are
bound to exactly one entered, settled, projected outcome. Early return, saved
late invocation, duplicate invocation, no invocation, and substituted outcomes
fail closed. One shared bounded drain follows cancellation of already-entered
synthetic callback work; the checkpoint makes no claim that a deliberately
uncooperative injected callback is stopped after that drain expires.

This checkpoint does not identify the historical path and is not live evidence.
`ANT-02` remains `incomplete`.

## Preserved attempt boundary

The prior attempt marker remains exactly:

- path:
  `C:\Users\mrali\Documents\Projects (Claude Code x Codex)\ai-dev-os-anthropic-live-canary-attempt-2026-08-14.json`;
- bytes: `67`;
- SHA-256:
  `7ac193d9b6ab1962827ef677655cb686f42c9caed4c622347b97ccfcc2348956`;
- semantic projection: `attemptConsumed=true`, `retryAuthorized=false`.

It was neither edited nor deleted. No distinct new live-attempt packet or marker
has been created at this source-candidate boundary. No credential availability
read, credential material read, or credentialed Messages-create/canary request
occurred during diagnosis or repair. The sole network diagnostic was the
body-free unauthenticated `HEAD` recorded below.

## Noncredential diagnostics

Read-only diagnostics used no key, request body, provider-authentication header,
or credential store access:

- process proxy/TLS/Node diagnostic variables were absent;
- WinINET proxy was disabled and WinHTTP reported direct access;
- DNS, TCP port 443, TLS 1.3, and default certificate validation succeeded for
  `api.anthropic.com`;
- one body-free unauthenticated `HEAD /v1/messages` returned HTTP `405` with a
  bounded JSON content type in approximately `103 ms`.

These current observations prove only ordinary endpoint reachability. They do
not classify the earlier credentialed request or prove that it had no provider
effect.

Anthropic's primary documentation was rechecked on 2026-08-15. It still exposes
the Messages create route, documents the required
`anthropic-version: 2023-06-01`, and lists the exact dated model
`claude-haiku-4-5-20251001`. No endpoint, API-version, model, request-body,
token, response, timeout, reference, or retention identity changed in this
repair.

Primary references:

- <https://platform.claude.com/docs/en/api/messages/create>
- <https://platform.claude.com/docs/en/api/versioning>
- <https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions>

## Candidate scope

The bounded candidate changes exactly these paths:

1. `README.md`
2. `docs/adr/0027-stage-18-live-boundary-checkpoint.md`
3. `docs/adr/0030-stage-18-anthropic-effect-classification.md`
4. `docs/implementation-roadmap.md`
5. `docs/release-evidence/stage-18-anthropic-failure-classification-checkpoint.md`
6. `docs/release-evidence/stage-18-development-acceptance-matrix.json`
7. `docs/security/windows-credential-secret-broker-threat-model.md`
8. `docs/technical-design.md`
9. `packages/provider-anthropic/README.md`
10. `packages/provider-anthropic/src/testing/index.ts`
11. `packages/provider-anthropic/src/testing/live-canary.ts`
12. `packages/provider-anthropic/test/anthropic-live-canary.test.ts`

No production provider entry point, credential broker, native addon, application
registration, workflow, dependency, lockfile, or production-admission code is
changed.

## Deterministic validation on current source bytes

- Fresh lockfile install with lifecycle scripts disabled: `181` packages added,
  `0` vulnerabilities.
- Focused canary test: `1` file, `32/32` tests pass.
- Full `@ai-dev-os/provider-anthropic` suite: `7` files, `155/155` tests pass.
- Provider coverage: `93.30%` statements (`850/911`), `88.41%` branches
  (`771/872`), `99.06%` functions (`106/107`), and `96.71%` lines
  (`737/762`).
- Provider TypeScript no-emit check: exit `0`.
- Provider build: exit `0`.
- Focused Stage 18 matrix test: `1` file, `3/3` tests pass.
- Dependency-tree validation: exit `0`, zero reported problems.
- Dependency audit: `264` dependencies, zero vulnerabilities at every severity.
- Provider dry pack: `38` files, `54,487` packed bytes, `275,727` unpacked
  bytes, SHA-1 `dc3f5403bb164ffb521e24df8c64b9ecb3ea69c4`, integrity
  `sha512-qVM0HztQS+eveArRHbv3QSFCviVtJwdxfSORnIUeq5ulVmcjaN6UCqhT6JYgXFlyUPbxBuneE6nWfb72iShbQQ==`,
  and zero bundled dependencies.
- The first root `npm run check` reached the SQLite-backed scheduler and
  telemetry tests but exited `1` after `1,118.0` seconds because the fresh
  `npm ci --ignore-scripts` had intentionally not created the
  `better-sqlite3` native binding. One explicit local
  `npm rebuild better-sqlite3` exited `0`; an in-memory open then reported
  SQLite `3.53.2`. This changed only ignored dependency-build artifacts.
- The unchanged root `npm run check` rerun then exited `0` after `1,430.6`
  seconds (`23m51s`).
- Root `npm run test:coverage` exited `0` after `837.1` seconds (`13m57s`).
  All `40` coverage roots were present: `39` HTML reports plus the application
  package's JSON-only report. Direct covered/total aggregation yielded
  statements `27,557/29,551` (`93.25%`), branches `19,314/22,153` (`87.18%`),
  functions `5,301/5,429` (`97.64%`), and lines `24,927/26,281` (`94.84%`),
  using floor-to-two-decimal convention.
- `git diff --check`: exit `0`.

The new vectors distinguish preflight refusal, availability failure, request
construction, possibly-dispatched request failure, received-response stream and
HTTP failure, malformed response, public timeout, callback-collapsing broker
behavior, outer and nested callback provenance/lifetime, post-callback broker
failure, substituted outcomes, exact redacted JSON, intrinsic response-byte
zeroing, and bounded drain expiry. They use synthetic material and injected
local seams, including the deterministic fake transport and the source-private
HTTPS request seam; none opens the native credential addon or network.

An independent same-family, strictly read-only source/design/test audit passed
on frozen source SHA-256
`21b86a91b68bc86974de78bba62698d9e8c01a439d574851c9ab467b5ab36211`
(`43,628` bytes) and test SHA-256
`35a261b9b5039eab3cb339c5bbdc589272ffd9c738931a90ec362bc6d439bc90`
(`73,381` bytes). The reviewer independently reran the focused `32/32` test and
`git diff --check`. The review did not exercise credential, native, provider,
installed-state, protected-state, or network boundaries.

## Source publication and hosted validation

The reviewed 12-path delta was staged by explicit path, cached-diff checked,
committed as `a597e58c253a9765a2005f2b56e95b820f16ef6f` with tree
`caa4e5a372a4b0291a9b37466e483bb58b9e8aef` and parent
`f47bc3b8d1702ae3ff487a415078f46e45d155fc`, then pushed once without force to
the named feature branch. No PR, main mutation, tag, release, or package
publication occurred.

Exact-source-head CI run
[`31856877552`](https://github.com/alijabbar04/ai-development-os/actions/runs/31856877552)
completed `success` on attempt `1` from `2026-08-15T01:34:20Z` through
`2026-08-15T02:01:55Z`:

- dependency audit `94943216549`: `12s`, success;
- PostgreSQL integration `94943216578`: `57s`, success;
- Ubuntu check `94943216569`: `8m11s`, success;
- coverage `94943216522`: `14m50s`, success;
- Windows check `94943216544`: `27m31s`, success, including the explicit
  production-disabled Windows credential-addon build and native smoke.

GitHub emitted one non-failing `warning` annotation on each job: the pinned
checkout/setup-node actions target Node.js 20 and were forced onto Node.js 24;
the coverage annotation also names its pinned upload-artifact action. No job or
step failed. This result-only evidence edit still requires an explicit commit,
non-forced push, and exact-final-head hosted reconciliation. It does not make a
new live canary eligible by itself.

## Acceptance and nonclaims

- `ANT-02=incomplete`: no successful new bounded canary exists.
- `AM-02=incomplete`: the preserved packed-consumer attempt remains consumed and
  no installed-state read is eligible.
- `PLN-02=incomplete`: no separately authorized later subject consumes Phase A.
- `PRD-01=production-gated`.
- `developmentAccepted=false`.
- `productionAdmitted=false`.

No retry, production activation, Stage 20 source, Account Manager operation,
Stage 17 operation, credential discovery, secret export, repository-content
provider disclosure, purchase, release, package publication, or main-branch
mutation is claimed or authorized by this checkpoint.
