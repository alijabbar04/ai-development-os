# Stage 18E-H production-host startup repair ledger

Status: `READY_FOR_PUBLICATION`

## Fixed starting subject

- Starting branch: `fix/stage-18e-h-external-review`
- Starting HEAD: `c58936daefa2c3e463d1840d37f122691d6b3021`
- Starting tree: `338b4b077f3f8e5bb3c9299e5e1787c16cc037b2`
- Source parent: `333e7485eb22067e2033812e2ffd2abf90bddb51`
- Stack base: `cf24aa5fb726e1135947050f34367b935419fe47`
- Starting canonical aggregate: `b26a01fd6574a37d60486a11a83f23cec19a46a1e12517ff032922f0ec6599aa`
- Starting exact-head CI: run `32498542181`, green on attempt 2
- External Opus and Fable reviews: PASS on the starting exact bytes
- Repair branch: `fix/stage-18e-h-production-startup`
- Current HEAD remains the starting HEAD. The repair candidate is uncommitted and unpublished, so there is no ending checkpoint HEAD or tree.

## Authority and frozen state

- The prior credential-save authorization was already consumed before this repair and was not reused.
- Earlier repair authority allowed exactly one instrumented pre-fix real launch and exactly one first post-fix real launch; both were consumed.
- A later one-final-confirmation authority was consumed by exactly one CommonJS/package-root production-disabled launch. It remained windowless for 67.6 seconds and was cleaned up task-scoped as recorded below.
- The current authority permitted exactly one real launch of the subsequently repaired bytes after exhaustive pre-launch gates, review, and freeze. That launch succeeded as recorded below; the authorization is consumed and no relaunch is permitted.
- The three named persistent files were absent at the initial freeze, immediately before and after each real launch, and at the final local recheck:
  - `%APPDATA%\AI Development OS Credential Setup\secrets\app-vault.v1.json`
  - `%APPDATA%\AI Development OS Credential Setup\secrets\app-vault.v1.json.bak`
  - `%APPDATA%\AI Development OS Credential Setup\credential-setup\credential-ui.v1.json`
- No credential was entered, saved, rotated, removed, decrypted, validated, or read back. No credential dialog was opened. No provider, clipboard, Windows Credential Manager, Account Manager, or production action occurred.

## Bounded startup diagnostic

- A diagnostic task owns synchronous and asynchronous startup failures before credential-host application work.
- Its fixed schema contains exactly `schemaVersion`, `operation`, `phase`, `code`, and `terminal`. The operation is `credential-host-startup`; `terminal` is `true`.
- Finite phases are `runtime-binding`, `protocol-registration`, `app-readiness`, `session-hardening`, `service-composition`, `window-creation`, `ipc-installation`, `renderer-load`, `surface-ready`, and `cleanup`.
- Finite public codes are `ELECTRON_RUNTIME_REQUIRED`, `ELECTRON_BINDING_UNAVAILABLE`, `ELECTRON_VERSION_UNREVIEWED`, `SINGLE_INSTANCE_UNAVAILABLE`, `ENCRYPTION_UNAVAILABLE`, `APP_NOT_READY`, `PLATFORM_UNSUPPORTED`, `STARTUP_CONFIGURATION_INVALID`, `CLEANUP_FAILED`, `STARTUP_TIMEOUT`, and `STARTUP_FAILED`.
- Only a reviewed own inert `code` data property can enter the mapping. Foreign, inherited, accessor-backed, proxy, cyclic, hostile, or otherwise unknown input becomes `STARTUP_FAILED`.
- Failure output is at most one bounded JSON line on stderr. It contains no raw message, stack, path, command line, environment content, cause, serialized object, credential material, clipboard content, provider material, vault document, metadata, or user-profile content. Success is silent.
- Failure preserves exit code `1`. The bootstrap uses normal `app.exit(1)` when safe and a hard process fallback only when no safe application exit exists or application exit throws.
- A fixed, non-configurable 30-second watchdog starts before the asynchronous startup task, tracks only the last reviewed phase, is unreferenced, and is cleared at `surface-ready` or terminal failure. Expiry emits one `STARTUP_TIMEOUT` record and enters the same single controlled-exit boundary. It has no environment, command-line, retry, or alternate-deadline route.

## Independent pre-fix review

- A GPT-5.6 Sol Max read-only source/security review ran before the pre-fix launch.
- Findings corrected before launch included inherited-property exclusion, enclosing Electron-dependent imports inside the diagnostic task, retaining the named Electron binding route, and preserving pre-readiness privileged-scheme timing.
- Pre-launch verdict: PASS, zero remaining must-fix findings.

## Authorized pre-fix real launch

- Count: exactly one.
- Before launch: all three named files absent; task process count zero.
- Result: no visible window, no bounded diagnostic record captured, and no exit code captured through the Windows GUI route.
- Truthful phase/code: unavailable. No phase or code is reconstructed from later evidence.
- The launch was not retried or varied.
- After launch: task process count zero; all three named files absent; no credential-capable action occurred.

## First proven cause and first repair candidate

- Static inspection found the explicit allowlisted control `ELECTRON_RUN_AS_NODE` inherited and active. No raw value or unrelated environment entry was emitted into evidence.
- A plain-Node compiled-entry probe produced one finite `runtime-binding` / `STARTUP_FAILED` record and exit `1`.
- A non-host pinned-Electron expression probe confirmed that Electron was operating in Node mode.
- Proven first cause: the inherited control made the direct Electron command execute the entry as Node and bypass the Electron application/window lifecycle.
- The first candidate introduced a fixed no-argument Node launcher that removed only that control with exact ASCII case folding and spawned pinned Electron without a shell. It still passed the built ESM file directly and entered Electron/readiness through dynamic imports.

## Authorized post-fix real launch

- Count: exactly one. This authorization is consumed and must not be reused.
- Launch route: the fixed production command, `npm --prefix apps/credential-setup start`.
- Before launch: all three named files absent; task process count zero.
- Observation: one responsive `electron.exe` process appeared, but it had no renderer/GPU child, no window handle, and no visible or accessibility-discoverable credential-setup window. No bounded stderr diagnostic appeared, and the vault/metadata directories remained absent.
- The process remained in that state beyond the bounded observation period. No normal ready state or normal close was possible.
- The launch session was interrupted once. The npm/launcher route then exited `1` because of the interruption, while its exact task-scoped Electron child remained. That child alone was force-terminated, after which the task process count was zero.
- Truthful phase/code: unavailable. No finite diagnostic was captured, so none is inferred.
- After launch: all three named files absent; no credential control, dialog, clipboard, provider, credential, or production action occurred.
- Required visible-ready, normal-close, and clean self-shutdown confirmation: FAIL.

## CommonJS/package-root candidate after the first post-fix launch

- The consumed launch exposed a second defect in the first candidate: dynamic ESM evaluation could reach Electron only after readiness, while its `app.whenReady()` path could then wait indefinitely. It also failed to prove synchronous privileged-scheme registration before readiness.
- Passing a built file directly also made `app.getAppPath()` depend on direct-file launch semantics instead of binding it deterministically to the application package root.
- The current candidate uses `dist/main/startup-bootstrap.cjs` as a synchronous CommonJS package main.
- The bootstrap validates the exact Electron `43.4.1` binding, fixes the app name, synchronously registers the privileged `app-credential` scheme, then starts the bounded task and asynchronous ESM imports.
- The startup entry no longer re-registers the scheme or calls `app.whenReady()`. A readiness helper either returns when `app.isReady()` is already true or synchronously attaches a one-shot `ready` listener.
- The no-argument launcher validates the pinned Electron package/distribution/executable/version and the package `main`, passes the application package root as Electron's sole argument, fixes the working directory, removes inherited ASCII `ELECTRON_` and `NODE_` control namespaces plus `GOOGLE_API_KEY`, fixes `NODE_ENV=production`, inherits stdio, uses `shell: false`, and has no forwarded arguments, development URL, debug/storage override, or retry.
- Build copies the reviewed CommonJS bootstrap byte-for-byte. The packed-runtime wrapper is also CommonJS so it can invoke the same bootstrap synchronously before readiness.
- Five Node regressions cover exact launcher identity, narrow control removal including Unicode-lookalike preservation, finite failure output, synchronous CommonJS entry under a non-Electron runtime, and refusal of forwarded arguments/shell execution.
- This subsequent correction was exercised once by the later CommonJS/package-root confirmation below. Its package entry still contained a `require.main === module` guard.

## Authorized CommonJS/package-root confirmation

- Count: exactly one real host launch. A preceding PTY transport attempt was rejected by Windows before PowerShell, npm, Node, or Electron creation; zero processes, windows, and persistent files were reconfirmed, so it was not a host launch.
- Route: `npm --prefix apps/credential-setup start`.
- Frozen pre-launch aggregate: `a8651d13df75630205d80a700017c010b9fc958b571e6a3510a408277e6b4cc4`; exact 20-entry inventory; task process count zero; all three named files absent.
- Actual npm process creation: `2026-08-22T13:19:18.1540600Z`. At `2026-08-22T13:20:26.2599773Z`, the main Electron process had remained responsive for 67.6 seconds but still had window handle `0`. Three Electron processes existed, but no visible or accessibility-discoverable credential-setup window and no bounded diagnostic existed.
- The session was interrupted once and exited `1`. Its exact remaining six-process npm/shim/launcher/Electron tree was verified by PID, role, executable or command identity, and creation time, then terminated task-scoped. Cleanup ended `2026-08-22T13:22:06.0141266Z` with zero task processes and no credential-setup window.
- All three named persistent files remained absent. The 20-entry aggregate remained exact and the index remained unstaged. No source/evidence byte changed during the confirmation.
- No normal ready state or normal close was possible. No credential dialog/control, credential, provider, clipboard, Windows Credential Manager, Account Manager, or production action occurred.

## Causal proof and current repaired candidate

- The leading hypothesis was tested rather than assumed. A disposable Electron `43.4.1` control using a direct ESM package main plus module-level awaited readiness timed out before readiness or window creation. In contrast, both awaited and detached ESM startup reached readiness and created a window when entered through the candidate's synchronously completing CommonJS package main and dynamic import. Therefore the current CJS-to-ESM top-level await was not the cause of the consumed 67.6-second failure.
- A second disposable package-root pair established the actual cause. Electron reported `require.main === module` as `false`. The guarded CommonJS entry timed out without calling startup or creating a window; the otherwise identical unconditional entry reached readiness and created a window. This exactly reproduces the responsive, diagnostic-free, handle-`0` host.
- The package main is now a minimal unconditional `startup-bootstrap.cjs` entry. The separately testable `startup-bootstrap-runtime.cjs` retains exact Electron selection, application naming, synchronous privileged-scheme registration, finite bootstrap diagnostics, asynchronous ESM loading, and controlled exit. Node module caching plus a unit VM regression prove one invocation; the packed wrapper consumes the exported `bootstrapStarted` result and does not invoke startup twice.
- The asynchronous startup task now owns the fixed 30-second watchdog described above. Successful return before `surface-ready` becomes finite `APP_NOT_READY`; expiry at every pre-surface phase becomes one finite `STARTUP_TIMEOUT`; late rejections and duplicate terminal callbacks cannot emit or exit twice.
- Disposable Electron tests prove the direct-ESM deadlock control, the exact CJS-to-ESM awaited/detached distinction, the old guarded-entry failure, the unconditional-entry success, one pre-window timeout record, successful watchdog cancellation, test-window creation, and clean shutdown, all under temporary app/user-data roots.
- The launcher, package-root binding, Electron `43.4.1` pin, bounded ASCII environment-control removal, synchronous privileged-scheme order, production-disabled composition, and existing Electron/IPC hardening remain fixed. The repaired bytes were exercised exactly once through the production route as recorded below.

## Authorized repaired-candidate confirmation

- Count: exactly one. The authorization is consumed and these bytes were not relaunched.
- Formal freeze: `2026-08-22T23:15:38.0174320Z`; branch `fix/stage-18e-h-production-startup`; HEAD `c58936daefa2c3e463d1840d37f122691d6b3021`; tree `338b4b077f3f8e5bb3c9299e5e1787c16cc037b2`; 23 Git entries, 22 present and one deleted; staged path count zero; aggregate `2c7df08478a2688d6409cc7d83acf119d00214c0c8d153f9100d2ad52c7b2e30`.
- Immediate pre-launch reconfirmation at `2026-08-22T23:16:45.3264501Z`: aggregate exact; task process count zero; all three named files absent; Electron `43.4.1`; production validation disabled; both CommonJS source/build pairs byte-identical; no provider transport import in production composition.
- Route: exactly `npm --prefix apps/credential-setup start`, invoked once with no arguments or variation. After the first 10.005-second observation, the route remained active and exactly one new accessibility-targetable Electron window existed with nonzero window id `919422` and title `Credential setup — AI Development OS`.
- The responsive accessibility tree showed the normal `Providers & integrations` overview, exactly four provider list items (Anthropic, OpenAI, Google Gemini, and OpenRouter), zero saved credentials, `Production disabled`, `Development build — tasks do not run against providers`, and `Live validation disabled`. It contained no edit/password field and no credential-entry dialog. No provider/action control was invoked.
- The startup emitted no bounded failure line and the watchdog did not fire. Screen capture did not supply visual proof because content protection exposed the occluding window rather than the protected Electron surface; the exact Electron accessibility tree supplied the readiness evidence.
- The exact window received only the normal `Alt+F4` close chord. It disappeared from the accessibility window list, the launch session completed without further output, and no task-scoped termination was needed. The orchestration poll did not retain a numeric exit code, so none is invented.
- Post-close check at `2026-08-22T23:19:08.2611705Z`: task process count zero; all three named files absent; 23-entry aggregate unchanged and exact. The application root and `secrets` directory were present and the credential metadata directory was absent; their pre-launch directory presence was not measured, so no directory-creation inference is made.
- No credential was entered, pasted, saved, rotated, removed, decrypted, read, or validated. No provider, clipboard, Windows Credential Manager, Account Manager private-state, production, or network-validation action occurred.

## Validation of the current local bytes

- Credential host ordinary suite: PASS, 16 files and 209 Vitest tests.
- Launcher regressions: PASS, 5/5.
- Targeted credential-host coverage: PASS, 209 tests plus 5 launcher regressions; 92.75% statements (1422/1533), 87.82% branches (866/986), 100% functions (257/257), and 97.46% lines (1153/1183).
- Fresh post-confirmation root `npm run check`: PASS, exit `0`, including full typecheck, all workspace tests, and all workspace builds.
- First root `npm run test:coverage`: completed all workspaces but exited `1`. One unchanged credential-host test with a 5 ms synthetic timeout observed `providerDispatched=false` instead of `true`; the same test had passed in the immediately preceding root check. Every later workspace coverage suite passed.
- The targeted unchanged credential-host coverage rerun then passed. This supports a transient coverage-timing classification, but the original root command remains recorded as failed and is not relabeled green.
- Exactly one fresh complete post-confirmation root `npm run test:coverage` then passed with exit `0` across all workspaces. Credential-host coverage was 92.75% statements (1422/1533), 87.82% branches (866/986), 100% functions (257/257), and 97.46% lines (1153/1183); the unchanged 5 ms timing test passed in that first and only final full run.
- Credential UI: PASS, 27 tests; 100% statements/functions/lines and 98.59% branches.
- Focused bootstrap, diagnostic, lifecycle, and static-policy tests: PASS, 46 tests. TypeScript no-emit, both CommonJS syntax checks, and source/build byte identity for both CommonJS files: PASS.
- Stage 18 completeness: PASS, 10/10.
- Native build first exited `1` because `node-gyp` could not discover Python in the process environment. A scoped retry using the already installed Python `3.13.14` executable succeeded with the existing Visual Studio 2022 Build Tools. Native addon shape then passed with Windows Credential Manager call count `0`. The native credential smoke was intentionally not run because that prohibited boundary is not part of the CI native contract.
- Real-Electron credential smoke: PASS, 77 synthetic/disposable cases. The current rerun inherited only the bounded production child environment.
- Real-Electron app-vault safe-storage smoke: PASS with synthetic-only material.
- Disposable lifecycle probe: PASS for direct-ESM deadlock control, CJS-to-ESM awaited/detached success, guarded/unconditional package-entry distinction, finite watchdog timeout, successful cancellation, window creation, and clean shutdown. Its current rerun used the bounded production child environment.
- Current disposable packed host: PASS with Electron `43.4.1`, 9 packages, 75 application files, 3 renderer files, clean install/audit, temporary app/user-data paths, `app-credential` renderer URL, production disabled, four provider cards, zero password inputs, seven preload methods, and renderer Node globals absent. Its current rerun used the bounded production child environment.
- Packed AM-02 consumer: PASS, 27 probes with a clean audit and scripts disabled. Packed app-vault consumer: PASS with `electronProductionBoundary=manager-broker-only` and `secretProjected=false`.
- Dependency audit: PASS, zero vulnerabilities. `npm ls --all` exited `0` with only expected unmet optional platform/tooling dependencies.
- Protected-foundation diff from `cf24aa5fb726e1135947050f34367b935419fe47`: empty for `packages/secrets`, `packages/policy`, `packages/provider-anthropic`, and `packages/secrets-windows`.
- Current changed-path credential-pattern scan: 22 present files checked, zero candidate paths, and no matched value emitted.
- Post-confirmation named-file/process check: zero named persistent files present and zero task processes.
- `git diff --check`: PASS, with line-ending warnings only.
- Starting canonical manifest verification: PASS for HEAD `c58936daefa2c3e463d1840d37f122691d6b3021`, 70 source files, and aggregate `b26a01fd6574a37d60486a11a83f23cec19a46a1e12517ff032922f0ec6599aa`.
- The prior canonical manifest is intentionally absent from the source/evidence candidate so it can be regenerated from the new committed Git blobs and re-added only by the manifest-only child commit. No final candidate manifest has yet been generated.

## Independent final source/security review

- Earlier iterative GPT-5.6 Sol Max read-only review found and drove correction of narrow environment-key matching, hermetic launcher tests, dynamic-ESM readiness ordering, direct-file app-root binding, packed-wrapper synchrony, hostile binding access, vacuous static-order assertions, and terminal fallback behavior.
- The earlier final documentary/current-byte audit passed for the exact 20-entry CommonJS/package-root candidate. It did not and cannot clear the later unconditional-entry/watchdog bytes.
- The fresh independent read-only review of the 22-entry unconditional-entry/watchdog candidate initially returned FAIL with one must-fix finding: the child inherited `NODE_OPTIONS` and Electron debug/file-output controls. No other code must-fix finding remained.
- The launcher and regressions were corrected to strip the inherited ASCII `ELECTRON_` and `NODE_` control namespaces plus `GOOGLE_API_KEY` while fixing `NODE_ENV=production`; the disposable lifecycle, packed-host, and real-Electron smoke launchers now consume the same policy. The affected ordinary, coverage, launcher, static-policy, lifecycle-probe, packed-host, and real-Electron smoke gates pass on the resulting 23-entry/22-present candidate.
- Fresh GPT-5.6 Sol Max read-only rereview of that corrected candidate: PASS, zero must-fix findings. It confirmed the bounded child environment, unchanged startup/watchdog/hardening boundaries, absence of new credential/private-state/provider capabilities, honest harness limitations, current metrics and inventory, and the unused real-launch authorization.
- Final post-confirmation GPT-5.6 Sol Max read-only source/security/evidence review: PASS, zero must-fix findings. It cleared the exact startup correction and evidence for the source/evidence commit; confirmed exactly-once unconditional CJS startup, watchdog ownership and terminality, Electron/package-root/environment binding, preserved Electron/IPC hardening, and absence of new credential/private-state/provider/production capability. Its only advisories were non-blocking: packed-host instrumentation remains supporting rather than production-route proof, and finite `cleanup`/`CLEANUP_FAILED` vocabulary is not used by normal post-ready shutdown.

## Publication decision and remaining truth

- The one repaired-candidate confirmation passed visible readiness, normal close, clean self-shutdown, and named-file absence. Every required post-confirmation local gate and the final independent current-byte review passed. Status is `READY_FOR_PUBLICATION`.
- The current unconditional-entry/watchdog correction is an uncommitted local candidate only. There is no corrected exact head, ending tree, source/evidence commit, manifest-only child commit, final aggregate, upstream publication, exact-head CI run, or clean published worktree to report.
- Phase 6's local if-and-only-if publication condition passed, so its authorized commit/manifest/push/CI sequence may proceed. At this record point, no commit, manifest regeneration, push, CI dispatch/rerun, PR, merge, tag, release, force-push, history rewrite, production enablement, or destructive cleanup has occurred.
- The explicit real-launch authority is consumed. No further launch is authorized. Its scope remained limited to visible-ready observation, normal close, clean shutdown, and named-file absence; it never authorized credential interaction.
- Project truth remains `AM-02` proven, `INT-01` proven, `ANT-02` incomplete, `PLN-02` incomplete, `developmentAccepted=false`, `productionAdmitted=false`, and Stage 20A ineligible.
