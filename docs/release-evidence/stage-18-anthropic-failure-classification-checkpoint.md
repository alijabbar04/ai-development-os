# Stage 18 Anthropic failure-classification checkpoint

- Date: 2026-08-15
- Status: deterministic repair and its final evidence head are published
  exact-head hosted-green; one later authorized attempt is consumed without the
  required successful proof; this result-only reconciliation remains unpublished
- Branch: `fix/stage-18-anthropic-result-classification`
- Base head: `f47bc3b8d1702ae3ff487a415078f46e45d155fc`
- Base tree: `4db86b74f943aaeecb27a726d585a584bfd9c954`
- Source head: `a597e58c253a9765a2005f2b56e95b820f16ef6f`
- Source tree: `caa4e5a372a4b0291a9b37466e483bb58b9e8aef`
- Published evidence head: `e365cd63d4c05b646c5d68e75693bf13b9f59e39`
- Published evidence tree: `aebcffa0fba019a2b545703e7f2e2599d08dcb93`

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

The deterministic repair does not identify the historical path. One later live
attempt exercised the repaired classifier and returned
`TRANSPORT_FAILURE/response-received`; that finite result establishes response
observation but is not the exact successful proof. `ANT-02` remains
`incomplete`.

## Preserved attempt boundary

The prior attempt marker remains exactly:

- path:
  `C:\Users\mrali\Documents\Projects (Claude Code x Codex)\ai-dev-os-anthropic-live-canary-attempt-2026-08-14.json`;
- bytes: `67`;
- SHA-256:
  `7ac193d9b6ab1962827ef677655cb686f42c9caed4c622347b97ccfcc2348956`;
- semantic projection: `attemptConsumed=true`, `retryAuthorized=false`.

It was neither edited nor deleted. No credential availability read, credential
material read, or credentialed Messages-create/canary request occurred during
diagnosis or source repair. The sole network diagnostic for that repair was the
body-free unauthenticated `HEAD` recorded below.

## Later one-attempt operator boundary

After the repair and final evidence head were exact-head hosted-green, the
operator supplied distinct authority for exactly one new attempt with no retry.
The frozen nonsecret boundary was:

- operator wrapper: `22,022` LF bytes, SHA-256
  `258a50b72eaf3672daacc7d99eb8cb04fda039a4887c520715ed2d3e9113716d`;
- bootstrap: `32,865` LF bytes, SHA-256
  `e46cb3a25f0ad9f29f06e4f94fb5e29358cd567922834b9b3eb395b7966d1016`;
- PowerShell launcher: `7,307` LF bytes, SHA-256
  `93db9e099ed83c78cd81276183f7163fc73078d34a74c0367090fe885f8dca1d`;
- authorization packet: `3,172` LF bytes, SHA-256
  `6091bf327a65ad3b7986d8062e874ba1b3a0c0c04f7d125924a23a7933ad1b6d`;
- canonical 53-key authorization subject SHA-256
  `e618efd4789d78889fc865d43d200bb81b9e882ad64276f3a420ed80e27c8338`;
- catalog fingerprint
  `a7ea187ba1c07c40ae60292f314dd2ca39c2221847dd1d1da7c204892a734294`;
- decision fingerprint
  `d38d1c3b7981cb6e846157b059e435ddcf7ae6f69cb93f4c175746ad908e52a3`;
- fixed 116-byte request fingerprint
  `0982d0a5d19ff6bf01bc87a40b96da6a33e84bccd294846ea7ecf1ccd2d7a13a`;
- captured runtime: `196` files / `1,170,716` bytes, 21,809-byte
  manifest SHA-256
  `7af4fa250ff0b3b2840bdc596f5b69f9162ae6ed441290c7f3b956b185bf1dca`;
- retention: `standard-30-day`; external retry authorization: `false`.

The bootstrap exports no capability. It serves captured runtime bytes, stages
only the exact captured native addon, and passes closure-private constructors
only to the captured wrapper's sole `reviewedMain` export. A same-family,
strictly read-only audit returned PASS on the exact four artifact hashes. Its
limitation was explicit: it did not execute a mode, inspect either marker, or
access credential, native, provider, or network state.

The pure synthetic launcher self-test passed `12/12` with zero native
credential access, secret-material access, provider access, or transport
invocation. The immediately preceding preflight then passed exact policy and
configuration validation and reported only that the reviewed target was
available. It created no new attempt marker and made no HTTP request.

The single `run` invocation atomically created and synced the new marker before
credential or network work. It emitted exactly this bounded public result:

```json
{"schemaVersion":1,"status":"failed","code":"TRANSPORT_FAILURE","failurePhase":"response-received"}
```

The new marker was observed at `2026-08-15T04:39:19Z` and remains exactly:

- path:
  `C:\Users\mrali\Documents\Projects (Claude Code x Codex)\ai-dev-os-anthropic-live-canary-attempt-2026-08-15.json`;
- bytes: `724`;
- SHA-256:
  `0972d178bc57d882d89328448d54af62d0498321d721a3cd56189851417cd37a`;
- semantic projection: `attemptConsumed=true`, `retryAuthorized=false`;
- namespace: `anthropic-live-canary-attempt:2026-08-15`.

No retry was attempted or authorized. `response-received` means only that an
HTTP response or response stream was observed. The boundary deliberately
retains no response status, headers, body, credential, or raw error, so this
record does not infer authentication, rate limiting, provider acceptance, model
execution, or response-schema cause. The API key value was not observed,
logged, returned, written to evidence, or persisted outside its pre-existing
Credential Manager entry.

Self-test diagnostics had already left `214` task-owned nonsecret temporary
runtime directories. One carefully bounded cleanup attempt was refused by the
execution safety control before it ran; the operation was not rephrased,
rerouted, or retried. Availability preflight and the consumed run each left one
additional staged-addon directory, for `216` preserved task-owned directories
in total. Each of the two latest directories contains exactly one 112,640-byte
`packages\secrets-windows\build\Release\ai_dev_os_windows_credential.node`
file with SHA-256
`1cc8b83c98cbae3063cf32114c1d9326310d02c5a1311442e249832da926d16d`
and nothing else. The bounded inventory found no credential material; no
destructive cleanup is claimed or authorized by this checkpoint.

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

The published deterministic source candidate changed exactly these paths:

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
step failed.

The result-only checkpoint was then committed as published evidence head
`e365cd63d4c05b646c5d68e75693bf13b9f59e39`, tree
`aebcffa0fba019a2b545703e7f2e2599d08dcb93`, parent
`a597e58c253a9765a2005f2b56e95b820f16ef6f`, and pushed once without force.
Exact-final-head CI run
[`31858402377`](https://github.com/alijabbar04/ai-development-os/actions/runs/31858402377)
completed `success` on attempt `1` from `2026-08-15T02:08:21Z` through
`2026-08-15T02:32:59Z`: dependency audit `94947253166` passed in `11s`;
PostgreSQL `94947253185` in `1m07s`; Ubuntu `94947253189` in `8m45s`;
coverage `94947253286` in `14m23s`; and Windows `94947253187` in `24m33s`,
including the production-disabled credential-addon build and native smoke. The
same one-warning-per-job annotation pattern remained non-failing. No job or
step failed, and no rerun was used.

This later live-result reconciliation changes exactly eight tracked paths:
`README.md`, ADRs 0027 and 0030, the implementation roadmap, this checkpoint,
the development-acceptance matrix, the technical design, and the Anthropic
package README. It changes documentation plus only `ANT-02`'s matrix rationale;
the row remains `incomplete`. Its own explicit commit, non-forced push, and
exact-head hosted result remain future at this candidate boundary. It does not
promote `ANT-02` or authorize another attempt.

Current reconciliation validation ran on the same executable and matrix bytes.
The validation paragraph and subsequent reviewer-required documentation-only
truth/scope corrections were applied afterward; they changed no executable,
matrix, test, gate, or acceptance result:

- focused acceptance-matrix plus fixed-subject completeness-audit tests:
  `2` files, `13/13` tests passed in `6.49s`;
- root `npm run check`: exit `0` after `1,439.9s` (`24m00s`);
- matrix JSON parse: exit `0`;
- secret-pattern scan across the eight changed paths: `0` hits;
- `git diff --check`: exit `0`.

No executable source, dependency, lockfile, workflow, package manifest or
export map, or coverage configuration changed. Root coverage was therefore not
repeated for this result-only delta; the exact source-head coverage fractions
recorded above remain the applicable implementation evidence, while hosted
coverage on the eventual exact documentation head remains a publication gate.

## Acceptance and nonclaims

- `ANT-02=incomplete`: no successful new bounded canary exists.
- `AM-02=incomplete`: the packed-consumer gate remains safety-blocked and
  unpublished; no post-repair installed-state read is eligible.
- `PLN-02=incomplete`: no separately authorized later subject consumes Phase A.
- `PRD-01=production-gated`.
- `developmentAccepted=false`.
- `productionAdmitted=false`.

No retry, production activation, Stage 20 source, Account Manager operation,
Stage 17 operation, credential discovery, secret export, repository-content
provider disclosure, purchase, release, package publication, or main-branch
mutation is claimed or authorized by this checkpoint.
