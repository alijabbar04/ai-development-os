# Stage 18E-H production-host startup repair checkpoint

Date: 2026-08-23
Status: `READY_FOR_PUBLICATION`

## Scope and identity

This is an unpublished local repair record, not a published checkpoint. Work
started from branch `fix/stage-18e-h-external-review`, commit
`c58936daefa2c3e463d1840d37f122691d6b3021`, and tree
`338b4b077f3f8e5bb3c9299e5e1787c16cc037b2`, on repair branch
`fix/stage-18e-h-production-startup`. HEAD remains the starting commit while
publication is pending. The repaired bytes passed their one authorized real
confirmation, the complete post-confirmation local validation set, and final
independent current-byte review, but there is not yet an ending checkpoint
HEAD/tree, final manifest, publication, or exact-head CI result.

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
- Starting manifest: PASS. The prior canonical manifest is intentionally absent from the source/evidence candidate so it can be regenerated from the new committed Git blobs and re-added only by the manifest-only child commit. No final candidate manifest has yet been generated.
- Earlier independent reviews cleared earlier exact candidates and drove the listed corrections. The first fresh review of the 22-entry unconditional-entry/watchdog candidate found one inherited-environment must-fix issue. Correcting it also bound all disposable Electron harnesses to the same environment policy, producing the launch-confirmed 23-entry/22-present candidate; affected ordinary, coverage, launcher, static-policy, lifecycle-probe, packed-host, and real-Electron smoke gates pass. Fresh GPT-5.6 Sol Max read-only rereview: PASS, zero must-fix findings.
- Final post-confirmation GPT-5.6 Sol Max read-only source/security/evidence review: PASS, zero must-fix findings. It cleared the exact startup correction and evidence for the source/evidence commit, confirmed all hardening and credential/private-state/provider boundaries remain intact, and identified only two non-blocking scope advisories about packed-host instrumentation and unused finite cleanup vocabulary.

## Publication truth

The one authorized real visible-ready/normal-close confirmation passed. Status
is `READY_FOR_PUBLICATION`: every required post-confirmation local gate and the
final independent current-byte review passed. The explicit launch authorization
is consumed, and no additional real launch is permitted.

The local if-and-only-if publication gate passed, so the authorized
source/evidence and manifest-only commit sequence may proceed. At this record
point, no commit, manifest regeneration, push, hosted CI, PR, merge, tag,
release, force-push, history rewrite, production enablement, or destructive
cleanup occurred.

`AM-02` and `INT-01` remain proven; `ANT-02` and `PLN-02` remain
incomplete; `developmentAccepted=false`; `productionAdmitted=false`; Stage
20A remains ineligible.
