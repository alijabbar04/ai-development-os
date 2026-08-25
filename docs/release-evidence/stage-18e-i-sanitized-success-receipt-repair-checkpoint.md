# Stage 18E-I sanitized success-receipt repair checkpoint

Date: 2026-08-24

Status: `REPAIR_SOURCE_CANDIDATE`

## Fixed starting subject

The repair began only after verifying the exact published original candidate:

- branch `feat/stage-18e-anthropic-validation-enablement`;
- HEAD `b438ed13b7213640e6a637d173bfefcf697ca9b8`;
- tree `e16992277457ae6e621d6579c6bbb1c186e9d1dc`;
- manifest aggregate
  `a0932fb572b5fe1f70aec062bc37bd7784581682aabe39ab35a01768d7197e26`;
- GitHub Actions run `32676577018`, attempt 1, all seven jobs successful.

Local HEAD, upstream, tracking branch, and live remote were equal; the index and
worktree were clean; ancestry and committed manifest independently matched.
The repair branch is `fix/stage-18e-i-sanitized-success-receipt`.

No task in this repair launched the real credential host, opened the real vault
or stored credential, read clipboard content, opened or changed the real marker
or metadata, contacted Anthropic or another provider, executed an AI task, or
activated production. Tests use synthetic secrets and disposable roots only.

## Historical outcome and exact defect

Credential validation succeeded, but the full ANT-02 evidence envelope was not
retained; the authorization is consumed and cannot be reused.

At original-candidate lines 77–115 of
`apps/credential-setup/src/main/anthropic-validation.ts`, the application
independently validated the complete `AnthropicLiveCanaryResult`. Line 115 then
returned only `{"outcome":"valid","resultCode":"VALIDATION_OK"}`. Lines
316–317 returned that reduction from the validation port. Metadata could store
only the reduced outcome/code and ordinary credential/version facts. The actual
duration and token observations disappeared before any durable evidence boundary.

Packet limits are not result observations, and the marker proves only
pre-dispatch consumption. Synthetic regression proves that different duration
and usage envelopes produced identical historical metadata. The lost values
cannot be invented, copied from fixtures, or safely inferred. The historical
result remains `BLOCKED_EVIDENCE` and the consumed request will never be rerun.

## Repair

ADR 0036 defines one exact flat 38-field sanitized success receipt and a
non-self-referential canonical digest convention. The full independently
validated provider envelope now survives until the receipt store validates and
commits it. Only the terminally committed receipt can return reduced Valid with
an exact receipt ID and SHA-256.

The durable transition is:

```text
candidate-bound authorization verified
  -> marker atomically consumed
  -> SecretRef resolved in one callback
  -> one fixed provider dispatch attempt
  -> complete success envelope produced and independently validated
  -> sanitized pending receipt returned and SecretMaterial callback released
  -> canonical sanitized receipt body create-only committed
  -> exact terminal commit sidecar create-only committed
  -> reduced Valid plus receipt pointer
  -> current-version metadata/UI commit
```

Provider success followed by any receipt failure becomes
`evidence-incomplete` / `EVIDENCE_RECEIPT_UNAVAILABLE`; it is not an invalid
credential, carries no `ANT-02` claim, preserves prior definitive knowledge, and
cannot retry. Legacy reduced Valid is explicitly `historical-missing`. Metadata
and committed-receipt disagreement projects nondefinitively as a receipt
mismatch. A receipt that precedes a failed metadata write remains independently
projectable by exact ID and candidate.

The isolated projection CLI reads only two pre-named bounded files. It performs
no enumeration, marker/metadata/vault mutation, credential resolution, Electron
launch, network request, task execution, or retry.

## External baseline reviews and dispositions

Both reviews cover only the original candidate. Their PASS does not transfer to
changed bytes.

Fable reviewed original HEAD/tree/aggregate above and returned PASS with zero
must-fix findings. Its report is 22,286 bytes with SHA-256
`2f6711550ff10986a1c2188e1bfd6a9e932c3107a7bd6b1a4335578e40539ea7`.

| Fable advisory | Repair disposition |
| --- | --- |
| F1: consumed strip should require a new separately bound authorization | Implemented in visible overview and initial screen-reader announcement |
| F2: expired and invalid collapsed into generic disabled copy | Implemented distinct visible and announced expired/invalid states |
| F3: in-flight copy should say consumed and no retry | Implemented in focused heading, help copy, and live-region announcement using “one dispatch attempt” |
| F4: programmatically focused headings need visible focus | Implemented `:focus` outline, offset, and forced-colours support for headings |
| F5: hardcoded `en-GB` timestamp format lacked an app contract | Replaced with an explicit credential timestamp contract using the reviewed document-language locale, operator OS time zone, and bounded date/time styles |

Opus reviewed the same original subject and returned PASS with zero must-fix
findings. Its complete input is 11,675 bytes with SHA-256
`c9d4eb8c9c9262f0860df6677ecd0ca3ba9c5d4555a97d9dcd5787f4a07bd372`.
The two receipt source files it observed untracked were created by this active
repair and have been preserved and reconciled.

| Opus advisory | Repair disposition |
| --- | --- |
| A1: `application/json` prefix admitted JSONP/JSON-seq | Implemented exact base media-type equality after splitting parameters; focused refusal tests cover JSONP, JSON-seq, text JSON, and problem+json |
| A2: callback context did not pin all fixed fields | Implemented exact runtime checks for access form, classification, operation ID, and singleton approval evidence reference, with independent substitution tests |
| A3: marker parent durability and `lstat`→`open` window | Strengthened without weakening `wx`: pin real path/directory identity, compare opened-handle/path identity before and after write, POSIX parent sync, Windows exact-file re-open/sync. Residual: Node cannot prove Windows parent-directory fsync or provide portable `openat`; no such claim is made |
| A4: pre-dispatch filesystem preparation is not individually deadline-bounded | Investigated and deliberately not wrapped in a timeout: Node filesystem promises are non-cancellable and a race would create a detached late mutation. Existing post-prepare expiry/abort checks prevent dispatch. Residual availability delay is documented |
| A5: “Exactly one request” overclaimed observation before `req.end()` | Replaced relevant text with precise “one dispatch attempt; no retry” wording |
| A6: TypeScript `Omit<..., "transport">` was compile-time only | Added an exact ordinary-object runtime composition boundary refusing `transport`, every unknown/symbol key, proxy, accessor, and abnormal prototype; live-canary transport validation remains independent |

Both baseline reviews correctly made no `ANT-02` claim because no complete
success receipt existed. Targeted re-review prompts must bind the final repaired
manifest-only candidate and include every disposition above.

## Independent repair review

The first read-only GPT-5.6 Sol Max review of the changed repair bytes returned
four must-fix findings and two advisories. No finding caused access to real
application or provider state.

| Review finding | Repair disposition |
| --- | --- |
| R1: receipt commit could outlive the host/UI effect timeout while the secret callback remained retained | Split provider-effect completion from receipt settlement. Exact success returns only a sanitized pending receipt; the resolver releases `SecretMaterial`; the satisfied effect timer is cleared; only then does main await receipt settlement before any terminal response. Close drains the settlement and cannot attach late Valid metadata. |
| R2: the receipt accepted impossible duration/timestamp combinations | Require a nonnegative host interval strictly below 20 seconds and `durationMs <= completedAt - startedAt`; focused boundary tests cover zero span, duration greater than span, the accepted upper interior, and the exact deadline. |
| R3: receipt projection checked the digest but not slot/current candidate | New live Valid requires Anthropic slot/provider plus the exact current HEAD/tree/manifest binding. Actual-store restart tests cover a changed candidate and cross-slot committed metadata; metadata parsing independently rejects a committed receipt on non-Anthropic slots. |
| R4: a reopened persistent evidence-incomplete result fell through to generic inconclusive wording | Added the durable `Receipt not saved` projection in both Normal and Developer modes, stating provider success, missing audit receipt, consumed one-shot authorization, and no retry. |
| RA1: named-path identity was not checked again after receipt reads | Added a post-read `lstat` identity comparison against the already-open handle and an injected replacement-race regression. |
| RA2: the Windows parent-directory consequence was understated | Documentation now states that sudden power loss may lose the new marker directory entry, making restart observe no marker; absolute crash-resistant no-retry is not claimed without a separately reviewed native or operational durable-ledger control. |
| R5: the synthetic Electron smoke still asserted superseded timeout and settlement wording | Updated the isolated smoke assertions to the 15-second request profile, 20-second host effect deadline, post-secret audit-receipt settlement, and one-dispatch-attempt copy; the real Electron smoke passes on disposable state. |
| R6: Developer projection could combine a later failed-attempt result code/state with an earlier committed receipt pointer | Select one applicable validation record first, then derive result code, decision fingerprint, receipt state, receipt ID, and receipt SHA only from that same record; focused preservation coverage pins the tuple. |
| RA3: timer-clearing and deadline-loser receipt-I/O invariants lacked direct lifecycle tests | Added one test holding post-secret settlement beyond the expired wall-clock deadline and proving eventual Valid without close, plus one proving a late deadline-losing provider effect invokes no receipt settlement or store commit. |
| RA4: receipt mismatch was described too specifically as a receipt that was not saved | Both renderer projections now distinguish `mismatch` as `Receipt not verifiable`, say the saved receipt could not be verified for this build, remain disconnected, and preserve consumed/no-retry wording; persisted Normal and Developer restart regressions cover it. |
| R7: first exact-head run `32728872456` exposed three publication-gate failures | The run is retained as failed product evidence and is not classified as infrastructure. **Ubuntu check:** local pre-existing build output had masked the projection CLI's static dependency on an absent clean-checkout `dist`; host test/coverage prehooks now compile host TypeScript without invoking the candidate-binding writer, argument validation precedes the dynamic store import, and a disposable missing-module regression pins the ordering. **Windows check:** the hosted runner's valid `RUNNER~1` lexical temp path was rejected because its canonical long `realpath` differed; the first canonical path is now accepted as the binding while final-component non-link checks, filesystem identity, repeated canonical-path comparisons, opened/named-file identity, and all replacement/junction refusals remain. Hosted-Windows lexical-alias regressions cover receipt commit/read and marker consume/restart. **Coverage:** `packages/workspace` measured 89.97% statements against the unchanged 90% threshold (the baseline run measured 90.32%); the threshold is not lowered. Deterministic tests now cover explicit executable selection, directory classification, missing-file refusal, bounded-list refusal, and unresolved-root refusal to remove runner-sensitive margin. Fresh local coverage passes with 114/114 tests and 90.66% statements; credential-host coverage passes with 290/290 tests, all six production-launch regressions, and 90.78% statements. All three dispositions still require fresh exact-head CI verification. |
| R8: second exact-head run `32742500701` failed only the final Windows credential-host Electron smoke at `validation-in-flight-ui-lock` | The run is retained as failed product evidence and is not classified as infrastructure; its other six jobs passed, and the Windows job had already passed the full check, candidate manifest, native shape, and app-vault smoke. The synthetic harness awaited the main-process validation gate but could sample before the renderer's intentional double-`requestAnimationFrame` focus reconciliation completed under hosted-Windows scheduling. The harness now uses its existing bounded DOM wait to require the actual open dialog, busy-heading focus, four disabled detail actions, and disabled dialog/actions before sending Escape and evaluating the complete lock assertion. This changes no production renderer, provider, credential, authorization, marker, or receipt behavior and still fails closed if the UI never reaches that state. Fresh repeated synthetic Electron evidence and a new exact-head CI run are required; the failed run is not rerun. |
| R9: third exact-head run `32769029634` failed only the Windows full-check job when the application test `constructs only an explicit absolute Windows-local SQLite path` reached Vitest's generic five-second test ceiling | The run is retained as failed product evidence and is not classified as infrastructure. Its other six jobs passed, including coverage, Ubuntu check, both packed gates, PostgreSQL integration, and dependency audit. The Windows job reported no assertion failure: the isolated synchronous SQLite lifecycle test timed out at 5,017 ms under hosted-runner load, after 69 sibling application tests had passed; later manifest, native-shape, app-vault, and credential-host smoke steps were consequently skipped. Ten consecutive focused Windows runs then passed locally, with 537-653 ms of test time per run. The single filesystem-backed lifecycle test now has an explicit bounded 15-second Vitest timeout, consistent with other bounded filesystem/process tests and without changing production code or assertions. Fresh focused/full local evidence, independent review, a new manifest-only binding, and a new exact-head CI run are required; the failed run is not rerun. |
| R10: repeated pre-publication R9 Electron smoke exposed one local `forced-colours` observation failure after two passes | The failed sample reached `forced-complete` and failed only the initial forced-colour overview assertion; the later forced-colour controls/result assertions passed. Three immediately following controlled synthetic reruns passed, identifying an intermittent observation gap rather than a persistent CSS failure: after enabling DevTools forced-colour emulation, the harness waited only for the pre-existing heading focus and then sampled the full media/style/focus predicate immediately after one Tab. The harness now polls that exact full predicate for at most five seconds, retains the last computed snapshot for failure diagnostics, and applies the unchanged assertion. This changes only synthetic smoke observation timing; no production renderer, provider, credential, authorization, marker, receipt, or policy behavior changes, and a missing or incorrect forced-colour state still fails. Fresh repeated exact-candidate smoke evidence, independent review, a new manifest-only binding, and exact-head CI are required. |
| R11: fourth exact-head run `32780825706` failed only the final Windows credential-host Electron smoke at `validation-in-flight-ui-lock` | The run is retained as failed product evidence and is not rerun. Its other six jobs passed, and the Windows job had already passed the full check, candidate manifest, native build/shape, and app-vault smoke before the final default-mode smoke failed at the later `renderer-crash-complete` report stage. R8's pre-Escape wait covered only busy-heading focus and disabled controls, while the harness evaluated the complete lock predicate only once after three Escape events; hosted-runner scheduling could therefore expose a remaining one-sample observation gap. A disposable diagnostic run confirmed the complete lock predicate before and after every Escape: Chromium prevented the first two cancel events, while the third exercised the renderer's existing defensive close-handler and reopened the same still-locked dialog. The harness now polls the unchanged complete lock predicate for at most five seconds before Escape and after each event. It additionally latches that the same dialog is restored, is never replaced, all underlying/dialog controls remain disabled throughout, and every cancel is either prevented or matched by that defensive close recovery. This is a strictly stronger synthetic assertion with bounded observation timing; no production renderer, provider, credential, authorization, marker, receipt, or policy behavior changes. Fresh repeated local smoke evidence, focused/full gates, independent review, a new manifest-only binding, and new exact-head CI are required. |
| R12: fifth exact-head run `32789227518` failed only the Windows full-check job when the shared application persistence contract `reopens exact reservation, dispatch, pending, and reconciled boundaries without redispatch` reached Vitest's generic five-second test ceiling | The run is retained as failed product evidence and is not rerun. Its other six jobs passed, including coverage, Ubuntu check, both packed gates, PostgreSQL integration, and dependency audit. The Windows job reported no assertion mismatch: the multi-boundary SQLite reopen test timed out at 5,473 ms after its sibling lifecycle test passed, while 69 other application tests passed; later manifest, native-shape, app-vault, and credential-host Electron smoke steps were consequently skipped. R9's explicit timeout correctly covered a different one-open Windows-local SQLite factory test and did not reach this reusable reopen contract. The shared test now has its own bounded 15-second Vitest timeout for only the SQLite and PostgreSQL harnesses that opt into physical reopen, preserving every assertion and changing no production code. Fresh repeated focused/full local evidence, independent review, a new manifest-only binding, and new exact-head CI are required. |
| R13: sixth exact-head run `32795006653` failed only the final Windows credential-host Electron smoke at `validation-in-flight-ui-lock` | The run is retained as failed product evidence and is not rerun. Its other six jobs passed, and the Windows job had already passed the 27-minute full check, candidate manifest, native build/shape, and app-vault smoke before the default-mode smoke reported the failure at `renderer-crash-complete`. R11's tracker correctly counted the third Escape's unprevented close and required the same still-locked dialog to be restored, but it inferred the transient loss of `open` only from a deferred `MutationObserver`. The renderer's earlier close handler queues `showModal()` in a microtask; under hosted-Windows ordering, the observer can therefore inspect the already-restored dialog and miss the transition even though the close event was counted. The synthetic tracker now latches `openLost` directly in its close-event listener while retaining the observer as a second layer and preserving every same-dialog, event-count, disabled-control, focus, wording, and no-retry assertion. A focused static regression pins event-derived latching before observer installation. No production renderer, provider, credential, authorization, marker, receipt, or policy behavior changes. Fresh repeated local smoke evidence, focused/full gates, independent review, a new manifest-only binding, and new exact-head CI are required. |
| R14: seventh exact-head run `32802034120` failed only the final Windows credential-host Electron smoke at `validation-in-flight-ui-lock` | The run is retained as failed product evidence and is not rerun. Its other six jobs passed, and the Windows job had already passed the full check, exact published-manifest guard, native build/shape, and app-vault smoke before the default-mode report failed at `renderer-crash-complete`. R13 directly latched actual close events, but the tracker still deferred reading `cancel` event `defaultPrevented` until a microtask and then coupled that delayed classification to the independently latched close count. A retained disposable local trace exposed the flaw: after the listener dispatch completed, the delayed event object no longer reliably represented the prevention state observed by a later synchronous listener, so scheduler ordering could leave the bounded predicate unsatisfied even when the same locked dialog was restored. The tracker now snapshots `defaultPrevented` synchronously after the renderer's earlier cancel listener. Each Escape must be accounted for immediately as prevented or unprevented, and every unprevented event must still match an actual close one-for-one plus restoration of the same locked dialog. It also retains event-derived close/open-loss consistency, disabled controls, focus, wording, no replacement, and no retry after every Escape. A focused static regression forbids delayed prevention sampling while preserving the close-recovery match. No production renderer, provider, credential, authorization, marker, receipt, or policy behavior changes. Fresh repeated local smoke evidence, focused/full gates, independent review, a new manifest-only binding, and new exact-head CI are required. |
| R15: repeated exact-R14 pre-publication Electron smoke exposed another intermittent `forced-colours` observation failure | Two retained disposable runs reached `forced-complete`; every forced-colour media, system-colour, badge, rail, secondary-text, outline, and overflow value was correct, but a single synthetic CDP Tab delivery left focus on the programmatically focused `H1` rather than the expected `BUTTON`. First separating media/style settlement from the key transition passed three repeated cycles before the same input-observation gap recurred, proving style reconciliation was not the complete cause. The harness now requires the heading's own visible forced-colour focus indicator, then follows the existing bounded keyboard-path pattern with at most three recorded Tab deliveries, and still requires a visibly outlined button before passing. Missing media, system colours, heading focus, button focus, keyboard movement, or either visible outline still fails; no production renderer, provider, credential, authorization, marker, receipt, or policy behavior changes. A focused static regression pins the bounded ordering and recorded path. Fresh repeated smoke, full gates, independent review, manifest rebinding, and exact-head CI are required. |
| R16: eighth exact-head run `32809415978` failed only the final Windows credential-host Electron smoke at `validation-in-flight-ui-lock` | The run is retained as failed product evidence and is not rerun. Its other six jobs passed, and the Windows job had already passed the 27-minute full check, exact manifest guard, native build/shape, and app-vault smoke before the default-mode report failed at `renderer-crash-complete`. R14 made cancel/close accounting synchronous and exact, but the renderer's defensive recovery from Chromium's later non-cancelable repeated-Escape close only called `showModal()` and relied on browser-default focus restoration. Retained disposable evidence shows the third Escape can be unprevented, close the dialog, and trigger same-dialog recovery; local Chromium happened to preserve the busy-heading focus, while hosted Windows did not reliably do so. The shared in-flight recovery now reopens the same connected dialog and explicitly focuses its existing `[data-busy-focus="true"]` heading after `showModal()`. Validation, removal, and credential-write dialogs all use the same recovery rule. The complete smoke predicate still requires the same dialog, exact event accounting, open-loss recovery, locked controls, visible wording, and busy-heading focus after every Escape. After the unchanged three-Escape assertions, the synthetic smoke now deterministically closes that same dialog once, explicitly blurs the busy heading inside every actual close event, and requires the production recovery to restore it while every lock remains intact. Focused browser-source and static regressions pin show-before-focus ordering, all three production call sites, deliberate focus displacement, and the forced-close recovery. This changes no provider, credential, authorization, marker, receipt, policy, dispatch, retry, or production-activation behavior. Fresh repeated synthetic Electron evidence, focused/full gates, independent review, manifest rebinding, and new exact-head CI are required. |

The same independent reviewer must re-review these changed bytes after the
focused/full gates. Its final verdict remains a publication gate and is not
preclaimed here.

## Verification design

Focused regression coverage includes exact schema/digest, two different valid
duration/usage envelopes producing different receipts, mutation of every
promoting field, the historical reduced-metadata collision, fake/non-success
receipt refusal, marker-before-dispatch and receipt-before-Valid ordering,
receipt and directory-durability failure, metadata failure after receipt,
restart/mismatch reconciliation, create-only conflict, corrupt/truncated/
oversized receipts, symlink/junction/non-file attacks, proxies/accessors/
prototype/duplicate keys, leakage scans, read-only projection, and unchanged
sibling marker/metadata/vault state. Hosted Windows additionally exercises a
lexical 8.3 alias whose canonical path differs while proving that the bound
identity and restart-visible consumption remain stable.

Host lifecycle regressions retain duplicate-process/IPC, late rotation/removal/
disable/close/deadline, no automatic retry, authorization-absent production
disablement, and no task execution coverage. Full verification, independent
GPT-5.6 Sol Max review, final source/manifest identities, coverage, packed and
synthetic Electron results, and exact-head CI are publication gates and are not
preclaimed by this source checkpoint.

## Publication binding

The repair manifest namespace is
`ai-dev-os.stage-18e-i.sanitized-success-receipt.git-blob-subject.v1`. Its fixed
base is the original reviewed candidate
`b438ed13b7213640e6a637d173bfefcf697ca9b8`; its path is
`docs/release-evidence/stage-18e-i-sanitized-success-receipt-subject-manifest.json`.
The source/evidence commit must not contain that path. One manifest-only child
will add it, after which the build writer may emit the exact repaired candidate
binding. Dirty, parent-drifted, wrong-base, noncanonical, or non-manifest-only
states emit no binding or fail closed.

## Preserved project truth

- `AM-02`: proven;
- `INT-01`: proven;
- `ANT-02`: incomplete;
- `PLN-02`: incomplete;
- `developmentAccepted=false`;
- `productionAdmitted=false`;
- Stage 20A: ineligible.

This repair makes a future success retainable. It does not repair the historical
evidence, authorize a new attempt, or advance any acceptance row.
