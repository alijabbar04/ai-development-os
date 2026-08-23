# Stage 18E-H production-host startup repair ledger

Status: `READY_FOR_PUBLICATION`

## 2026-08-23 visibility/deadline correction

- Starting branch/HEAD/tree: `fix/stage-18e-h-production-startup` / `78cb2a6f8bfae7f5c70118b788eaf84649a40a44` / `28d246d59501356208e2b6de015848c839c59047`.
- Starting source commit/tree: `54ee2de403aeeaa51e0bf19981e386359d9f22cf` / `cb31f23f8c57465156f5f415724bf04a73dc9dbb`; stack base: `cf24aa5fb726e1135947050f34367b935419fe47`.
- Starting canonical manifest: 82 files, zero deletions, 1,157,502 bytes, aggregate `14262b74e6801986c67284bd02bb3ad208429491a43c94fff0b4fd5a51e10d2a`, manifest SHA-256 `c9162993b8084fe84205be8cb1e8b6653f571c77c1700e7b3d7cf398c4bc663d`.
- Starting exact-head CI: run `32610586678`, attempt 2, PASS.
- Correction branch: `fix/stage-18e-h-visible-startup-deadline`, created from the exact starting HEAD with no upstream.
- External Opus disposition: FAIL on MF-1 (`surface-ready` did not prove visible presentation) and MF-2 (deadline armed after fallible bootstrap work). External Fable disposition: PASS overall, with FR-ADV-01 independently confirming the visibility race.
- MF-1 correction: visibility observers install before renderer load; `show()` must be followed by non-destroyed `isVisible() === true`, with at most one immediate event-loop turn. Load and visibility are fail-fast peers. `surface-ready` and deadline cancellation occur only after both and a final close/destroy/visibility recheck.
- MF-2 correction: one module-cached controller arms one fixed 30-second timer in the first synchronous CommonJS bootstrap before Electron binding, protocol registration, runtime import, and async handoff. Ownership transfers once without reset, extension, second timer, alternate input, or retry. One terminal latch controls finite output, cancellation, cleanup conversion, and exit.
- Related correction: pre-ready close, renderer loss, and abort remain failures; an abort is rechecked after asynchronous window construction. The Windows launcher owns exact process-tree failure cleanup and removes settled signal listeners. Packed verification requires a visible window.
- Pre-launch ordinary suite: PASS, 17 Vitest files / 231 tests plus 6 launcher regressions. Focused lifecycle: PASS, 22/22.
- Pre-launch affected coverage: PASS, 92.24% statements (1464/1587), 87.47% branches (894/1022), 100% functions (268/268), 97.45% lines (1188/1219). The first attempt truthfully failed the 100% function threshold on an unused inline default writer; the shared named writer correction and fresh rerun passed.
- Credential UI coverage: PASS, 27 tests, 100% statements/functions/lines and 98.59% branches.
- Pre-launch typecheck/build, CommonJS syntax and byte identity, synthetic/disposable visibility and timeout probes, packed host, packed consumers, Electron smokes, native build/shape, Stage 18 completeness, dependency audit/tree, credential scan, and diff gates: PASS. Native shape observed zero Credential Manager calls; the prohibited native credential smoke was not run.
- Initial independent GPT-5.6 Sol Max read-only review: PASS, zero must-fix findings. Its late-abort advisory was corrected. Delta review: PASS, zero blockers. Remaining advisories: the Windows tree-reaper test is mocked, post-ready fatal behavior remains outside this startup boundary, and the packed visibility wrapper is test-only supporting evidence.
- Frozen launch-confirmed inventory: `2026-08-23T11:23:56.515Z`, 23 present paths, zero staged paths, aggregate `1378161829ed0fd2b6f6ebb01cac26ebef83a6a6eae2e26d74bac4ec9a303c41`.
- Real-launch count under this authority: exactly one. Route: `npm --prefix apps/credential-setup start`, without arguments or variation.
- Confirmation: after 10.010 seconds, no bounded failure existed and exactly one responsive Electron window existed with handle `8849566`, exact title `Credential setup — AI Development OS`, and an accessibility document showing `Providers & integrations`, exactly four named provider items, zero saved credentials, production disabled, development-only provider behavior, and live validation disabled. No password/edit field or credential-entry dialog existed. A content-protected screenshot did not expose the app surface and is not used as proof.
- Interaction: no provider/action control was invoked. Only the exact returned window received one normal `Alt+F4`. The route exited `0` with no additional output, no task-scoped termination, no remaining exact window, and zero remaining task processes.
- Post-close: at `2026-08-23T11:28:46.0870606Z`, the frozen aggregate was exact and all three named persistent files remained absent.
- Safety: no credential was entered, pasted, saved, rotated, removed, read, decrypted, or validated. No real credential dialog, provider call, network validation, clipboard action, Windows Credential Manager action, Account Manager private-state action, or production action occurred.
- Authority: consumed. No further real launch is authorized.
- Fresh post-confirmation root `npm run check`: PASS, exit `0`, including full typecheck, all workspace tests, and all workspace builds.
- Exactly one final full root `npm run test:coverage`: PASS, exit `0`, across all workspaces. Credential-host coverage: 92.24% statements (1464/1587), 87.47% branches (894/1022), 100% functions (268/268), and 97.45% lines (1188/1219).
- Dependency and package gates: `npm audit --audit-level=high` PASS with zero vulnerabilities; `npm ls --all` PASS with only expected unmet optional dependencies.
- Fresh packed gates: credential host PASS on Electron `43.4.1` with 9 packages, 76 application files, 3 renderer files, visible readiness, four provider cards, zero password inputs, production disabled, seven preload methods, and no renderer Node globals; Account Manager consumer PASS, 27 probes; app-vault consumer PASS with `electronProductionBoundary=manager-broker-only` and `secretProjected=false`.
- Post-confirmation native gate: the first build attempt truthfully exited `1` because `node-gyp` could not discover Python in the process environment; no credential smoke ran. One scoped retry using the installed Python `3.13.14` executable built successfully, and native shape passed with zero Windows Credential Manager calls. The prohibited native credential smoke remained unrun.
- Post-confirmation integrity gates: Stage 18 completeness PASS 10/10; three CommonJS syntax/source-build identities PASS; starting manifest verification PASS; protected-foundation diff empty; `git diff --check` PASS with line-ending warnings only.
- Fresh changed-path credential scan: 26 present paths, zero candidate paths, zero matched values emitted, and no value disclosure. Post-gate check: all three named persistent files absent and zero scoped Electron/Node task processes.
- External advisory dispositions: Opus ADV-1 through ADV-6 addressed by finite pre-ready fatal ownership, exact spawned-PID-tree interruption cleanup, removal of the vestigial protocol phase, truthful cleanup failure classification, non-reinvocable bootstrap exports, and live cleanup vocabulary. Opus ADV-7 remains an accepted test-only `app.setPath` override statically absent from the normal launcher. Fable FR-ADV-01/02 addressed by the visible-readiness invariant and visibility regressions; optional FR-ADV-03 launcher prose and FR-ADV-04 second-instance focus not adopted; FR-ADV-05 addressed by this dated evidence refresh; post-ready FR-ADV-06 explicitly deferred outside this startup boundary.
- Final independent GPT-5.6 Sol Max read-only source/security/evidence review: PASS, zero must-fix findings. Independent non-Electron verification passed 73/73 focused tests, 6/6 launcher regressions, all three CommonJS syntax and source/build identities, and `git diff --check`. It confirmed both external findings closed, the 27-entry source/evidence topology, unchanged hardening/capability boundaries, and consumed launch authority; it neither launched Electron nor mutated the repository.
- Final-review advisories, all non-blocking: exact Windows descendant-tree cleanup has command-construction/mock rather than live orphan proof; post-ready fatal handling intentionally returns to Electron/Node defaults; packed temporary `app.setPath` identity remains test-only supporting evidence.
- First visibility/deadline publication: source/evidence commit `aceb39af3efb7c7bddef29f24d976629d1f0c34e`, tree `d3fc6a030a18e576a90b421c291352c4c241abf4`; manifest-only child `435057cf040d37df92f6f36479d760718f8a8c9c`, tree `27ae8ed955db6103512bd2d7b8cb934e73059506`. Its 87-blob, zero-deletion, 1,232,779-byte manifest had aggregate `68ca6dc3b9973e1605bb6f2a031a4649551e747c05ef9e4f4e417972ec2d75a0` and file SHA-256 `0b67f993a114e5b34fb94a02c5a86e14319c69811c4005f05849a654cf25b239`; canonical and independent verification passed before the non-force push.
- First visibility/deadline exact-head CI: run `32640580936`, attempt 1, exact HEAD `435057cf040d37df92f6f36479d760718f8a8c9c`, completed `failure`. Dependency audit, PostgreSQL integration, both Windows packed gates, and coverage passed.
- Genuine changed-test failure: Ubuntu injected `platform: "win32"` into the new exact-tree reaper regression while supplying literal `C:\Windows` to the host platform's `path.isAbsolute()`. Linux therefore used the direct-kill fallback and recorded zero taskkill spawns instead of one. This was a regression-portability defect, not a production-startup failure.
- Conclusively unrelated failure in the same run: Windows timed out the unchanged application SQLite-reopen test `reopens exact reservation, dispatch, pending, and reconciled boundaries without redispatch` after 6.986 seconds against its fixed 5-second limit. Blob `490edee30f9f5cdbac8b82b22ba5cdb6fa947c1c` is identical at the stack base, failed HEAD, and current candidate; the path has no stack-base diff. Credential-host tests passed 231/231 plus launcher regressions 6/6 in that job.
- Rerun disposition: no failed-job rerun was requested because the run also contained a genuine changed-test defect. The single conclusively-unrelated-runner rerun allowance remains unused.
- Test-only correction: the regression now derives a host-absolute synthetic system root from `appRoot` and checks the corresponding `System32/taskkill.exe` path and working directory. Production startup and all credential/provider/IPC/private-state/hardening source bytes are unchanged from `aceb39af3efb7c7bddef29f24d976629d1f0c34e`; no Electron process was launched.
- Post-correction local gates: direct launcher regressions PASS 6/6; credential-host ordinary suite PASS, 17 files and 231 Vitest tests plus six regressions; fresh root `npm run check` PASS, exit `0`, with full typecheck, every workspace test, and every workspace build. The already-consumed single final full local root coverage gate was not repeated.
- Fresh post-CI-correction independent GPT-5.6 Sol Max read-only delta review: PASS, zero must-fix findings. It confirmed the portable synthetic-system-root test preserves the exact taskkill/PID-tree/argument/cwd/no-shell assertions, production-source byte identity to `aceb39af3efb7c7bddef29f24d976629d1f0c34e`, truthful CI classifications, the unused rerun allowance, correct manifest topology, and no leakage or capability expansion. Its non-Electron launcher run passed 6/6; it performed no launch, private-state access, or repository mutation. Its only advisory remains the accepted mock rather than live-orphan proof for Windows descendant-tree cleanup.
- Publication state at this source/evidence record: the superseded canonical manifest is intentionally absent after the fresh independent correction review passed. The correction will be committed, the manifest regenerated from committed Git blobs and added by a manifest-only child, and the replacement pair pushed non-forced for new exact-head hosted CI. Immutable final publication identities belong in the required external handover and are not predicted here.
- Project acceptance truth is unchanged: `AM-02` and `INT-01` remain proven; `ANT-02` and `PLN-02` remain incomplete; `developmentAccepted=false`; `productionAdmitted=false`; Stage 20A remains ineligible.

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
- First repair source/evidence commit: `03645e29d5b2c4c2c0e83021ad324e2243473e11`
- First repair source tree: `3a7d88ea6403a6d1c77a98ba2d12b110b71245a6`
- First repair manifest-only child/current HEAD: `927d36c6922aa35011c33508d194837aad5c3f2b`
- First repair manifest-only tree: `b42b11863eaee365867cfda3c7004a1c59e8ecae`
- Local, tracking, and live remote refs matched that child after the non-force push. The current worktree contains only the subsequent test-hermeticity correction, evidence updates, and intentional deletion of the superseded manifest pending a new append-only commit pair.

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

## First publication and hosted-CI correction

- Source/evidence commit `03645e29d5b2c4c2c0e83021ad324e2243473e11` (tree `3a7d88ea6403a6d1c77a98ba2d12b110b71245a6`) was created with parent `c58936daefa2c3e463d1840d37f122691d6b3021` and subject `fix(credential-setup): repair production startup lifecycle`.
- Manifest-only child `927d36c6922aa35011c33508d194837aad5c3f2b` (tree `b42b11863eaee365867cfda3c7004a1c59e8ecae`) was created with that source commit as its sole parent and subject `docs(stage-18e-h): refresh startup repair subject manifest`.
- The first manifest bound 82 committed blobs, zero deletions, and 1,148,051 total bytes with aggregate `0d8df3d84671002fe0fb37483536b2473812a5c3207fa3bb75096ab3d734d42b`; its file SHA-256 was `ac07d6474e2a61f156a1192ffd3fd6083e4d5fd5750e79e1b4b63c4aed56a235`. The canonical verifier and an independent PowerShell/.NET implementation both passed.
- The pair was pushed non-forced to `fix/stage-18e-h-production-startup`. No PR, merge, tag, release, production activation, force-push, or history rewrite occurred.
- Exact-head push run `32608234691`, URL `https://github.com/alijabbar04/ai-development-os/actions/runs/32608234691`, ran against `927d36c6922aa35011c33508d194837aad5c3f2b` and completed `failure`.
- PostgreSQL integration, dependency audit, packed credential host on Windows, and packed consumer on Windows passed. Ubuntu check, Windows check, and coverage failed at the same launcher regression: `CommonJS bootstrap enters synchronously and bounds a non-Electron runtime failure` observed stdout `Downloading Electron binary...\n` instead of the required empty stdout. The credential-host Vitest suite and production startup behavior were not the failure.
- Cause: the regression executed the real bootstrap under plain Node from the application root. A clean runner's real `electron` package entered its binary-recovery path before the expected invalid-runtime adjudication, so the test depended on local Electron installation state.
- Classification: genuine changed-test hermeticity defect, not unrelated runner infrastructure. No failed-job rerun was requested; the single unrelated-runner rerun allowance remains unused. No Electron or production host was launched while diagnosing or correcting it.
- Correction: copy the exact `startup-bootstrap.cjs` and `startup-bootstrap-runtime.cjs` into a fresh disposable root, install a synthetic `node_modules/electron/index.js` that exports a deliberately invalid binding, execute that copied bootstrap under plain Node, retain the exact exit-`1`, empty-stdout, finite-stderr assertions, and remove only the disposable root in `finally`.
- Scope: only `apps/credential-setup/scripts/launch-production-host.regression.mjs` changed in code. Production startup, credential, IPC, provider, private-state, and hardening source bytes remain identical to the launch-confirmed source commit.

## Validation of the current local bytes

- Credential host ordinary suite: PASS, 16 files and 209 Vitest tests.
- Launcher regressions: PASS, 5/5.
- Targeted credential-host coverage: PASS, 209 tests plus 5 launcher regressions; 92.75% statements (1422/1533), 87.82% branches (866/986), 100% functions (257/257), and 97.46% lines (1153/1183).
- Fresh post-confirmation root `npm run check`: PASS, exit `0`, including full typecheck, all workspace tests, and all workspace builds.
- After the hosted-CI test-hermeticity correction, direct launcher regressions passed 5/5; the credential-host ordinary suite passed 16 files and 209 Vitest tests plus five regressions; targeted credential-host coverage passed with 92.75% statements (1422/1533), 87.82% branches (866/986), 100% functions (257/257), and 97.46% lines (1153/1183); and one fresh root `npm run check` passed with exit `0`, including full typecheck, all workspace tests, and all workspace builds.
- The already-required single final full local root coverage run was not repeated for the test-only correction. The earlier passing full run remains authoritative locally; a new exact-head hosted coverage job will exercise the corrected test on a clean runner.
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
- First published repair manifest: PASS with the exact identities and two implementations recorded above. It remains historical evidence for source commit `03645e29d5b2c4c2c0e83021ad324e2243473e11` and exact-head run `32608234691`.
- The superseded manifest is intentionally absent from the corrective source/evidence candidate so it can be regenerated from the new committed Git blobs and re-added only by a new manifest-only child commit. No replacement manifest has yet been generated.

## Independent final source/security review

- Earlier iterative GPT-5.6 Sol Max read-only review found and drove correction of narrow environment-key matching, hermetic launcher tests, dynamic-ESM readiness ordering, direct-file app-root binding, packed-wrapper synchrony, hostile binding access, vacuous static-order assertions, and terminal fallback behavior.
- The earlier final documentary/current-byte audit passed for the exact 20-entry CommonJS/package-root candidate. It did not and cannot clear the later unconditional-entry/watchdog bytes.
- The fresh independent read-only review of the 22-entry unconditional-entry/watchdog candidate initially returned FAIL with one must-fix finding: the child inherited `NODE_OPTIONS` and Electron debug/file-output controls. No other code must-fix finding remained.
- The launcher and regressions were corrected to strip the inherited ASCII `ELECTRON_` and `NODE_` control namespaces plus `GOOGLE_API_KEY` while fixing `NODE_ENV=production`; the disposable lifecycle, packed-host, and real-Electron smoke launchers now consume the same policy. The affected ordinary, coverage, launcher, static-policy, lifecycle-probe, packed-host, and real-Electron smoke gates pass on the resulting 23-entry/22-present candidate.
- Fresh GPT-5.6 Sol Max read-only rereview of that corrected candidate: PASS, zero must-fix findings. It confirmed the bounded child environment, unchanged startup/watchdog/hardening boundaries, absence of new credential/private-state/provider capabilities, honest harness limitations, current metrics and inventory, and the unused real-launch authorization.
- Final post-confirmation GPT-5.6 Sol Max read-only source/security/evidence review: PASS, zero must-fix findings. It cleared the exact startup correction and evidence for the source/evidence commit; confirmed exactly-once unconditional CJS startup, watchdog ownership and terminality, Electron/package-root/environment binding, preserved Electron/IPC hardening, and absence of new credential/private-state/provider/production capability. Its only advisories were non-blocking: packed-host instrumentation remains supporting rather than production-route proof, and finite `cleanup`/`CLEANUP_FAILED` vocabulary is not used by normal post-ready shutdown.
- Fresh GPT-5.6 Sol Max read-only review of the exact hosted-CI corrective candidate: PASS, zero must-fix findings and zero advisories. It confirmed that the temp-root synthetic Electron binding is hermetic on clean runners; the exact exit, stdout, finite stderr, and newline assertions remain; cleanup targets only the atomic temporary root; the approach is cross-platform; production source has no diff from `03645e29d5b2c4c2c0e83021ad324e2243473e11`; failed-run evidence reconciles; and the append-only manifest topology is correct.

## Publication decision and remaining truth

- The one repaired-candidate confirmation passed visible readiness, normal close, clean self-shutdown, and named-file absence. Its production bytes are unchanged by the hosted-CI correction. The explicit real-launch authority remains consumed, and no further launch is authorized.
- The first append-only source/evidence plus manifest-only pair was published and its exact-head failed run is preserved above. Current status is `READY_FOR_PUBLICATION`: all affected local gates and the independent review for the test-only correction pass, while a second append-only source/evidence plus manifest-only pair, replacement exact-head CI, final ref equality, and a clean published worktree remain pending.
- The failed run was not rerun. No PR, merge, tag, release, force-push, history rewrite, production enablement, destructive cleanup, credential-capable action, provider call, private-state access, or clipboard access occurred.
- The explicit real-launch authority is consumed. No further launch is authorized. Its scope remained limited to visible-ready observation, normal close, clean shutdown, and named-file absence; it never authorized credential interaction.
- Project truth remains `AM-02` proven, `INT-01` proven, `ANT-02` incomplete, `PLN-02` incomplete, `developmentAccepted=false`, `productionAdmitted=false`, and Stage 20A ineligible.
