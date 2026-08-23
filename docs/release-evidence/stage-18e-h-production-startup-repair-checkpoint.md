# Stage 18E-H production-host startup repair checkpoint

Date: 2026-08-23
Status: `READY_FOR_PUBLICATION`

## 2026-08-23 external-review follow-up

This follow-up is bound to starting branch
`fix/stage-18e-h-production-startup`, commit
`78cb2a6f8bfae7f5c70118b788eaf84649a40a44`, tree
`28d246d59501356208e2b6de015848c839c59047`, source commit
`54ee2de403aeeaa51e0bf19981e386359d9f22cf`, source tree
`cb31f23f8c57465156f5f415724bf04a73dc9dbb`, and stack base
`cf24aa5fb726e1135947050f34367b935419fe47`. The starting canonical
manifest contained 82 files, zero deletions, and 1,157,502 bytes with aggregate
`14262b74e6801986c67284bd02bb3ad208429491a43c94fff0b4fd5a51e10d2a`
and manifest-file SHA-256
`c9162993b8084fe84205be8cb1e8b6653f571c77c1700e7b3d7cf398c4bc663d`.
Its exact-head hosted run `32610586678`, attempt 2, passed. Both external
dossiers were read and independently identity-checked before work began.

The external Opus review failed that exact subject on two startup findings.
MF-1 found that renderer load completion could mark `surface-ready`, cancel the
deadline, and report success even if the hidden `BrowserWindow` never became
observably visible. MF-2 found that the production 30-second deadline began
only after Electron binding, protocol registration, runtime-module import, and
handoff, leaving those pre-watchdog paths unbounded. The external Fable
review passed overall, but its FR-ADV-01 independently described the same
visibility race. This correction changes no project acceptance claim.

On branch `fix/stage-18e-h-visible-startup-deadline`, one module-cached startup
controller now arms exactly one fixed, non-configurable 30-second deadline in
the first synchronous CommonJS bootstrap, before Electron selection, protocol
registration, runtime loading, or asynchronous handoff. Bootstrap and runtime
claim the same controller once; no reset, extension, second timer, alternate
deadline, environment route, argument route, or retry exists. One terminal
latch owns the bounded diagnostic, controlled exit, timer cancellation, and
cleanup-failure conversion. Pre-ready process failures enter that same finite
boundary without serializing attacker-controlled error content.

The lifecycle now observes `ready-to-show`, close, renderer-gone, and abort
before renderer load begins. It calls `show()`, requires a non-destroyed window
whose `isVisible()` is true, and permits only one event-loop turn for that
observable state. Renderer load and visibility are fail-fast peers. Only after
both pass and a final window-state recheck does the lifecycle enter
`surface-ready` and cancel the original bootstrap deadline. A pre-ready close,
renderer loss, or abort cannot be converted into normal application success.
The launcher also owns exact-tree Windows failure cleanup and removes its
one-shot signal handlers after child settlement. Packed verification now
requires an actually visible window.

Before the sole authorized launch, ordinary credential-host tests passed 231
Vitest cases across 17 files plus six launcher regressions. Affected coverage
passed at 92.24% statements (1464/1587), 87.47% branches (894/1022), 100%
functions (268/268), and 97.45% lines (1188/1219). Credential UI coverage
passed 27 tests at 100% statements/functions/lines and 98.59% branches. Root
typecheck/build, CommonJS syntax and three source/build byte-identity checks,
the visible-startup disposable Electron probe, packed-host verification,
packed Account Manager and app-vault consumers, safe-storage and credential
host Electron smokes, native build/shape, Stage 18 completeness, dependency
audit/tree, changed-path credential scan, and diff checks passed. The native
shape reported zero Credential Manager calls; the prohibited native credential
smoke was not run. The first affected-coverage attempt truthfully failed its
100% function threshold because a new inline default writer was uncalled; the
implementation was narrowed to the shared named writer and the fresh rerun
passed.

GPT-5.6 Sol Max performed an independent read-only source/security review before
the launch and returned PASS with zero must-fix findings. Its late-abort
advisory was addressed with explicit signal gates after asynchronous window
construction; focused lifecycle coverage then passed 22/22, and a delta review
again returned PASS with zero blockers. Remaining non-blocking advisories are
that the Windows tree-reaper regression uses a mock rather than a live orphan,
post-ready fatal behavior remains intentionally outside this startup boundary,
and the packed visibility wrapper is supporting test instrumentation rather
than production-route proof.

External Opus advisories ADV-1 through ADV-6 are addressed: pre-ready process
fatal events have one finite terminal owner; Windows interruption reaps the
exact spawned PID tree; the vestigial protocol phase is removed; cleanup
failure uses `cleanup`/`CLEANUP_FAILED`; bootstrap is not re-invocable through
its exports; and that cleanup vocabulary is now live. ADV-7 remains an
accepted test-only temporary-identity override, statically absent from the
normal launcher. Fable FR-ADV-01 and FR-ADV-02 are addressed by the visible
readiness contract and visibility probes. Optional launcher prose
(FR-ADV-03) and second-instance focus (FR-ADV-04) were not adopted; the former
would conflict with silent successful startup and neither is required by this
repair. FR-ADV-05 is addressed by this dated evidence refresh. FR-ADV-06
remains explicitly deferred because post-ready fatal behavior is outside the
bootstrap-to-visible boundary.

The launch-confirmed source/test inventory froze at
`2026-08-23T11:23:56.515Z`: 23 present Git paths, zero staged paths, and
aggregate `1378161829ed0fd2b6f6ebb01cac26ebef83a6a6eae2e26d74bac4ec9a303c41`.
The immediate pre-launch check reconfirmed that aggregate, Electron `43.4.1`,
zero task processes, all three named persistent files absent, production
disabled, validation disabled, and no provider transport in production
composition.

The exact normal route `npm --prefix apps/credential-setup start` was invoked
once and only once. After 10.010 seconds it had emitted no diagnostic and
exposed exactly one responsive, accessibility-targetable Electron window with
nonzero handle `8849566` and title `Credential setup — AI Development OS`.
The accessibility document showed the normal `Providers & integrations`
surface, exactly four provider items (Anthropic, OpenAI, Google Gemini, and
OpenRouter), zero saved credentials, `Production disabled`, `Development build
— tasks do not run against providers`, and `Live validation disabled`; it had
no password/edit field and no credential-entry dialog. The protected screenshot
did not expose the app surface and is not treated as readiness evidence. No
control was invoked. Only that exact window received `Alt+F4`; the route exited
normally with code `0`, no additional output, no task-scoped termination, and
no remaining exact window or task process.

At `2026-08-23T11:28:46.0870606Z`, all three named persistent files remained
absent and the frozen aggregate remained exact. No credential entry, paste,
save, rotation, removal, read-back, decryption, or validation occurred; no real
credential dialog opened; and no provider, network-validation, clipboard,
Windows Credential Manager, Account Manager private-state, or production action
occurred. The launch authorization is consumed. No further real launch is
authorized.

Post-confirmation documentation is current. A fresh root `npm run check` passed
with exit `0`, including full typecheck, every workspace test, and every
workspace build. Exactly one final full root `npm run test:coverage` passed with
exit `0` across all workspaces; credential-host coverage remained 92.24%
statements (1464/1587), 87.47% branches (894/1022), 100% functions (268/268),
and 97.45% lines (1188/1219). Dependency audit passed with zero
vulnerabilities, and `npm ls --all` exited `0` with only expected unmet
optional dependencies.

Fresh post-confirmation packed-host verification passed on Electron `43.4.1`
with 9 packages, 76 application files, 3 renderer files, a visible window,
four provider cards, zero password inputs, production disabled, seven preload
methods, and no renderer Node globals. Packed Account Manager and app-vault
consumers passed, including `electronProductionBoundary=manager-broker-only`
and `secretProjected=false`. The first native-build attempt exited `1` only
because `node-gyp` could not discover Python in that process environment; no
credential smoke ran. A scoped retry using the already-installed Python
`3.13.14` executable built successfully, and native shape again reported zero
Windows Credential Manager calls. Stage 18 completeness passed 10/10, all
three startup CommonJS files passed syntax and source/build byte identity, the
starting manifest independently reverified, the protected-foundation diff was
empty, and `git diff --check` passed with line-ending warnings only.

The fresh changed-path credential scan covered 26 present paths, found zero
candidate paths, emitted zero matched values, and disclosed no values. The
launch-confirmed source/test aggregate remained exact, all three named
persistent files remained absent, and zero scoped Electron/Node task processes
remained. The final independent GPT-5.6 Sol Max read-only source/security/
evidence review passed this exact 27-entry source/evidence candidate with zero
must-fix findings. Its independent non-Electron checks passed 73/73 focused
tests, 6/6 launcher regressions, all three CommonJS syntax and byte-identity
checks, and `git diff --check`; it performed no launch or repository mutation.
Only the append-only source/evidence plus manifest-only publication sequence
remains pending. Its immutable identities belong in the external handover and
are not predicted here.

## Scope and identity

This repair record started from branch `fix/stage-18e-h-external-review`, commit
`c58936daefa2c3e463d1840d37f122691d6b3021`, and tree
`338b4b077f3f8e5bb3c9299e5e1787c16cc037b2`, on repair branch
`fix/stage-18e-h-production-startup`. The confirmed repair was first published
as source/evidence commit `03645e29d5b2c4c2c0e83021ad324e2243473e11`
(tree `3a7d88ea6403a6d1c77a98ba2d12b110b71245a6`) and manifest-only
child `927d36c6922aa35011c33508d194837aad5c3f2b` (tree
`b42b11863eaee365867cfda3c7004a1c59e8ecae`). Local, tracking, and
live remote refs then matched that child.

The first exact-head hosted run exposed one non-hermetic Node regression, not a
production-startup failure. The current worktree changes only that regression
and this evidence, while intentionally removing the superseded manifest for a
new append-only source/evidence plus manifest-only publication pair. Production
startup, credential, provider, IPC, and private-state source bytes are unchanged
from the launch-confirmed source commit. The affected local gates and fresh
independent read-only correction review pass; the replacement publication/CI
sequence remains pending.

The repair grants no credential entry, save, rotation, removal, decryption,
validation, read-back, provider, clipboard-read, Windows Credential Manager,
Account Manager, production, PR, merge, tag, release, or later-stage authority.

## Diagnostic and causes

The finite startup boundary permits at most one bounded JSON failure record with
schema version `1`, operation `credential-host-startup`, one reviewed phase,
one reviewed code, and `terminal: true`. Unknown or hostile inputs become
`STARTUP_FAILED`; raw errors, stacks, paths, command lines, environment content,
objects, causes, and secret-bearing material are never serialized. Failure exits
`1`; success is silent.

The one instrumented pre-fix real launch showed no window and yielded neither a
captured bounded record nor a captured exit code. Its truthful phase/code is
unavailable. Static and non-host synthetic evidence proved that inherited
`ELECTRON_RUN_AS_NODE` made pinned Electron execute the entry in Node mode.

The first repair candidate removed only that exact control through a fixed
launcher. Its one authorized post-fix real launch produced one responsive
Electron process but no renderer/GPU child and no visible or
accessibility-discoverable window. It emitted no finite record and remained
running. After one interruption, the launcher exited `1`; its exact remaining
task child was then terminated. No normal ready state, normal close, or clean
self-shutdown occurred, so the confirmation failed and its authorization is
consumed.

That launch led to a CommonJS/package-root correction. A later authorized launch
of that correction created three Electron processes, but after 67.6 seconds its
responsive main process still had window handle `0`, no visible or
accessibility-discoverable window, and no bounded diagnostic. After one session
interruption, the exact remaining six-process task tree was verified and
terminated. All three named persistent files remained absent and no
credential-capable action occurred.

A disposable Electron `43.4.1` matrix then separated two mechanisms. A direct
ESM package main with module-level awaited readiness did deadlock, but both
awaited and detached ESM startup reached readiness and created a window when
entered through the synchronously completing CommonJS package main. The current
CJS-to-ESM top-level await therefore did not cause the 67.6-second failure.
Package-root probes instead showed `require.main === module` is `false` under
Electron: the guarded entry never called startup, while an otherwise identical
unconditional entry reached readiness and created a window. This exactly
explains the responsive, diagnostic-free, handle-`0` process.

## Current correction

The local candidate now enters through a minimal unconditional CommonJS package
main. A separate testable CommonJS runtime validates Electron `43.4.1`, fixes
the app name, registers the privileged `app-credential` scheme before
asynchronous imports/readiness, and invokes startup exactly once. The packed
wrapper consumes the exported start result without a second invocation.

The bounded startup task now owns a fixed, non-configurable 30-second watchdog.
It tracks only the last reviewed finite phase, is unreferenced, and is cleared at
`surface-ready` or terminal failure. Expiry produces one terminal record for
that phase with code `STARTUP_TIMEOUT` through the same one-exit boundary. It has
no environment, command-line, alternate-deadline, or retry route; late rejection
or callback cannot emit or exit twice.

The fixed no-argument launcher validates the pinned Electron package,
distribution, executable, version, and package `main`; passes the application
package root as the sole Electron argument; fixes the working directory; removes
inherited ASCII `ELECTRON_` and `NODE_` control namespaces plus
`GOOGLE_API_KEY`; fixes `NODE_ENV=production`; and spawns without a shell. It
offers no forwarded arguments, development URL, storage override, debug mode, or
retry. The packed-runtime path uses the same synchronous CommonJS bootstrap.

## Successful repaired-candidate confirmation

The candidate froze at `2026-08-22T23:15:38.0174320Z` with 23 Git entries,
22 present and one deleted, staged path count zero, and aggregate
`2c7df08478a2688d6409cc7d83acf119d00214c0c8d153f9100d2ad52c7b2e30`.
The immediate pre-launch check reconfirmed that aggregate, zero task processes,
all three named files absent, Electron `43.4.1`, production validation disabled,
and both CommonJS source/build pairs byte-identical.

The exact route `npm --prefix apps/credential-setup start` was invoked once. In
the first 10.005-second observation, exactly one new responsive,
accessibility-targetable Electron window existed with title
`Credential setup — AI Development OS`. Its normal provider overview contained
four provider cards, zero saved credentials, production disabled, live
validation disabled, no password/edit field, and no credential dialog. No action
control was invoked. The startup emitted no bounded failure and no watchdog
record.

Only the exact window received `Alt+F4`. It disappeared normally, the route
session completed without further output, and zero task processes remained; no
termination was needed. The numeric exit code was not retained by the orchestration
poll and is not invented. At `2026-08-22T23:19:08.2611705Z`, all three named files
remained absent and the frozen aggregate remained exact. The one launch
authorization is consumed; no relaunch is permitted.

## First publication and hosted-CI correction

The first authorized publication used source/evidence commit
`03645e29d5b2c4c2c0e83021ad324e2243473e11` and manifest-only child
`927d36c6922aa35011c33508d194837aad5c3f2b`. The child bound 82
committed blobs, zero deletions, and 1,148,051 total bytes with aggregate
`0d8df3d84671002fe0fb37483536b2473812a5c3207fa3bb75096ab3d734d42b`.
The manifest file SHA-256 was
`ac07d6474e2a61f156a1192ffd3fd6083e4d5fd5750e79e1b4b63c4aed56a235`;
the canonical verifier and a separate PowerShell/.NET implementation both
passed before the non-force push.

Exact-head push run `32608234691` for `927d36c6922aa35011c33508d194837aad5c3f2b`
completed `failure`. PostgreSQL integration, dependency audit, packed
credential host on Windows, and packed consumer on Windows passed. The Ubuntu
check, Windows check, and coverage jobs all failed at the same launcher
regression, `CommonJS bootstrap enters synchronously and bounds a non-Electron
runtime failure`: actual stdout was `Downloading Electron binary...\n` while
the assertion required empty stdout. The production startup and Vitest suite
had not failed.

The regression had spawned the real source bootstrap under plain Node from the
application root. On a clean runner, `require("electron")` reached the package's
binary-recovery path before the intended non-Electron binding adjudication,
making the test depend on local Electron installation state. This is a genuine
test-hermeticity defect, not an unrelated runner failure, so no CI rerun was
used. The correction copies the exact bootstrap and runtime into a disposable
temporary root, supplies a synthetic `electron` module exporting a deliberately
invalid binding, retains the exit-`1`, empty-stdout, one-finite-stderr-record
assertions, and removes only that disposable root in `finally`. It changes no
production source and launches no Electron process.

Affected validation after the correction passed: the launcher regressions 5/5;
the credential-host ordinary suite, 16 files and 209 Vitest tests plus the five
regressions; targeted credential-host coverage with the unchanged 92.75%
statements, 87.82% branches, 100% functions, and 97.46% lines; and a fresh full
root `npm run check`, exit `0`. The already-required single final full local
root coverage run remains the earlier passing run and was not repeated for this
test-only correction. A new push will create a new exact-head run; it is not a
rerun of run `32608234691`.

## Safety and persistence

All four real repair launches began and ended with the primary vault, backup,
and credential UI metadata files absent. The current recheck also found
all three absent and zero task processes. No credential control/dialog, credential,
provider, clipboard, Windows Credential Manager, Account Manager, or production
action occurred.

## Validation snapshot

- Fresh post-confirmation root `npm run check`: PASS, exit `0`, including full typecheck, all workspace tests, and all workspace builds. Credential host ordinary suite: PASS, 16 files and 209 Vitest tests; launcher regressions: PASS, 5/5.
- Exactly one fresh complete post-confirmation root `npm run test:coverage`: PASS, exit `0`, across all workspaces. Credential-host coverage was 92.75% statements (1422/1533), 87.82% branches (866/986), 100% functions (257/257), and 97.46% lines (1153/1183); the unchanged 5 ms timing test passed in this run.
- Historical first root coverage command before the final run: exit `1` from one unchanged 5 ms synthetic timeout assertion. Its targeted unchanged-host rerun passed. That historical command remains recorded as failed and is not relabeled green.
- Credential UI (27 tests), focused bootstrap/diagnostic/lifecycle/static-policy tests (46 tests), TypeScript no-emit, both CommonJS syntax and source/build identity checks, and Stage 18 completeness (10/10): PASS.
- Disposable lifecycle probe: PASS for the direct-ESM deadlock control, CJS-to-ESM awaited/detached success, guarded/unconditional package-entry distinction, finite watchdog timeout, cancellation, window creation, and clean shutdown.
- Current packed host: Electron `43.4.1`, 9 packages, 75 application files, 3 renderer files, production disabled, 4 provider cards, 0 password inputs, 7 preload methods, and no renderer Node globals.
- Packed AM-02 consumer: PASS, 27 probes with a clean audit and scripts disabled. Packed app-vault consumer: PASS with `electronProductionBoundary=manager-broker-only` and `secretProjected=false`.
- Native build first exited `1` because `node-gyp` could not discover Python in the process environment. A scoped retry using the already installed Python `3.13.14` executable succeeded with the existing Visual Studio 2022 Build Tools. Windows native shape then passed with Credential Manager call count `0`; the prohibited native credential smoke was not run.
- Real-Electron app-vault safe-storage smoke: PASS with `electronAsyncSafeStorage=ok`, `productionBroker=ok`, and synthetic-only material. Real-Electron credential-host smoke: PASS, 77 synthetic/disposable assertions.
- Dependency audit: PASS, zero vulnerabilities; `npm ls --all`: PASS with only expected unmet optional platform/tooling dependencies.
- Current changed-path credential scan: 22 present files, zero candidates; no value emitted.
- Protected-foundation diff: empty. Post-confirmation named-file/process check: all three named persistent files absent and zero task processes. `git diff --check`: PASS with line-ending warnings only.
- First published repair manifest: PASS through both the canonical verifier and an independent implementation, with the exact identities recorded above. The superseded manifest is intentionally absent from the corrective source/evidence candidate so it can be regenerated from the new committed Git blobs and re-added only by a new manifest-only child commit.
- Earlier independent reviews cleared earlier exact candidates and drove the listed corrections. The first fresh review of the 22-entry unconditional-entry/watchdog candidate found one inherited-environment must-fix issue. Correcting it also bound all disposable Electron harnesses to the same environment policy, producing the launch-confirmed 23-entry/22-present candidate; affected ordinary, coverage, launcher, static-policy, lifecycle-probe, packed-host, and real-Electron smoke gates pass. Fresh GPT-5.6 Sol Max read-only rereview: PASS, zero must-fix findings.
- Final post-confirmation GPT-5.6 Sol Max read-only source/security/evidence review: PASS, zero must-fix findings. It cleared the exact startup correction and evidence for the source/evidence commit, confirmed all hardening and credential/private-state/provider boundaries remain intact, and identified only two non-blocking scope advisories about packed-host instrumentation and unused finite cleanup vocabulary.
- Fresh hosted-CI-correction GPT-5.6 Sol Max read-only review: PASS, zero must-fix findings and zero advisories. It confirmed clean-runner hermeticity, exact finite assertions, task-local temporary cleanup, cross-platform behavior, an empty production-source diff from `03645e29d5b2c4c2c0e83021ad324e2243473e11`, factual failed-run evidence, and correct append-only manifest topology.

## Publication truth

The one authorized real visible-ready/normal-close confirmation passed. The
first source/evidence and manifest-only commits were published non-forced, and
the resulting exact-head CI failure is preserved above without relabeling or
rerun. The production repair remains launch-confirmed and unchanged. The
explicit launch authorization is consumed, and no additional real launch is
permitted.

Status is `READY_FOR_PUBLICATION`: all affected local gates and the independent
read-only review for the test-only hermeticity correction pass. New append-only
source/evidence and manifest-only commits, replacement exact-head CI, final ref
equality, and a clean published worktree remain pending. No PR,
merge, tag, release, force-push, history rewrite, production enablement, or
destructive cleanup occurred.

`AM-02` and `INT-01` remain proven; `ANT-02` and `PLN-02` remain
incomplete; `developmentAccepted=false`; `productionAdmitted=false`; Stage
20A remains ineligible.
