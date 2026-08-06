# Stage 17 Windows helper lifecycle and crash-cleanup proof

Date: 2026-08-06

Outcome: **PASSED BOUNDED TEST-ONLY HELPER LIFECYCLE AND CRASH-CLEANUP
PROOF; WINDOWS PRODUCTION REMAINS UNAVAILABLE**

Starting commit:
`df3846743fba7bf19733c8fc133414e57128bd77`.

Implementation commit:
`77c42949396cc75a126c0c1de18984b7a0849648`.

This file is the required pre-execution working note. It will be replaced with
measured evidence only after the bounded matrix completes. Windows remains
`unavailable`, production capability flags remain false, quota dimensions
remain unsupported, and Windows actual-native corpus evidence remains 0/40.

## Pre-execution ownership model

- The controller creates and retains the only supervisory handle to one fresh,
  unnamed private Job per scenario. The Job is configured before either the
  helper or target exists with kill-on-close, active-process limit one, and no
  breakaway flag.
- A fresh helper receives only four explicitly inherited handles: the request
  pipe read end, response pipe write end, a duplicate reference to that exact
  private Job, and one NUL handle used for all standard streams. The controller
  retains the opposite non-inheritable pipe ends and the exact helper process
  handle returned by `CreateProcessW`.
- The request contains one fixed command, one exact scenario enum, one fresh
  lowercase 32-hex token, and the expected helper apphost, helper payload, and
  fixture SHA-256 values. The helper derives the profile and direct-TEMP paths
  from the token; no arbitrary workload body or command is accepted.
- The helper owns the profile SID allocation, target process/thread/token and
  fixture-pipe handles, process-creation attribute allocations, and normal-path
  cleanup. It resolves the profile folder only after profile creation. The
  controller independently resolves and retains the same exact folder while
  the profile exists, so helper termination cannot erase the recovery manifest.
- Target membership is assigned at creation through the controller-owned Job
  handle in `PROC_THREAD_ATTRIBUTE_JOB_LIST`. The controller never terminates
  by name or PID: it terminates only the exact helper process handle and the
  exact task Job handle created for that scenario.
- For an injected helper termination, the controller waits for the helper
  handle, terminates/drains the exact Job, deletes only token-derived exact
  files and empty direct-TEMP directories, deletes the exact AppContainer
  profile, and polls the exact folder/mapping/storage records. For client EOF
  and the normal case, the helper must clean first; any residue makes that
  scenario fail before the controller performs bounded safety recovery.
- Every controller handle is closed before the independent scan. That scan is
  separate from helper cleanup and checks exact and task-prefix filesystem,
  process-image, profile-folder, mapping/storage registry, and marker state.
  Any nonzero result stops the matrix and remains a failed observation even if
  later bounded recovery succeeds.

## Pre-execution protocol and safety review

- Protocol version: 5; schema version: 1.
- Frame: four-byte little-endian length followed by strict UTF-8 JSON; maximum
  payload 4,096 bytes; bounded 30-second frame waits.
- One request per fresh helper. Exact phases are `request-accepted`,
  `setup-complete`, `target-suspended`, `target-ready`, `target-exited`, and
  `cleanup-complete`; controls must acknowledge the immediately preceding
  phase.
- Exact-property parsing rejects malformed UTF-8/JSON, duplicate or unknown
  properties, unknown commands/scenarios/phases, oversized frames, and
  duplicate/out-of-order frames with stable body-free codes.
- Helper and fixture source paths are absolute, exact-name, non-reparse paths.
  The apphost and its managed payload are separately hashed before every helper
  launch and again inside the helper. The source and staged fixture are hashed
  before every AppContainer launch.
- Helper creation uses an explicit handle list, fixed empty-baseline
  environment, exact `lpApplicationName`, and no shell. Target creation reuses
  the reviewed zero-capability AppContainer plus creation-time private-Job
  composition. No public network, DNS, provider, repository workload,
  credential, broad kill, recursive delete, privilege, or system-policy path
  exists in the new lifecycle code.

Stateful execution is not permitted until the two deterministic builds,
read-only self-tests, source scans, and final pre-execution review below are
green.

## Attempt 1 pre-execution gate

The gate was green for the exact first candidate:

- probe/controller source envelope SHA-256:
  `98e5d8c11cd80de00ef2983c6c3f3e116e00d762e889cdec0b7337e1e5a4f9aa`;
- fixture source envelope SHA-256:
  `c19c356f2ce0bfd4bf7c00dc2e33e509b6b996fe199ba09e521096ffac781272`;
- helper apphost: 156,672 bytes,
  `94c25f8b9370c61f60dfdbc6e4fd294df49d492b3c712a4d5f44568923f6bfc1`;
- helper managed payload: 217,600 bytes,
  `f8e65df8be7b74f22d7c919b2046c55b0662b05c5b4258b7dd79a90fb1e0eaa2`;
- helper deps/runtime configuration SHA-256:
  `edb3906cbfcc8e80f3dbc56769089ce90f7a0efd0e821a09f5abffb65f4571b5`
  / `e3a9d5d0a25ca066e8b70401b5869b5cfc92d16f5fe89b83077cdfd4b7427711`;
- self-contained fixture: 70,923,627 bytes,
  `271c8297bfe77850b173f8c250e692cd3ef868a9f122a0101f004d98069aa1fa`;
- two helper/controller builds byte-identical: true;
- two fixture publishes byte-identical: true;
- both read-only self-tests: exit 0, deterministic/body-free/protocol checks
  true, no profile or process mutation;
- both normal probes: exit 2 with
  `windows-native-process-composition-and-corpus-unverified`;
- both unknown-command checks: exit 64 with `unsupported-command`;
- compiler/analyzer result: zero warnings and zero errors for every build;
- added lifecycle source broad-kill, recursive-delete, public-network, DNS,
  provider, credential, and shell scan: zero matches; and
- pre-stateful task-prefix directory/process/storage/mapping residue counts:
  0 / 0 / 0 / 0.

The reviewed creation sites are exactly one helper `CreateProcessW` using the
four-handle list and one target `CreateProcessW` using security capabilities,
the private Job list, and a two-handle list. The only termination sites consume
the returned exact helper handle or the fresh unnamed Job handle. Cleanup
accepts only the validated token-derived file names and uses non-recursive
deletion of empty direct-TEMP directories. Registry access is read-only except
for the exact AppContainer profile records created/deleted by the documented
profile APIs.

## Honest iteration record

Attempt 1 stopped during the first normal-lifecycle scenario, as required.
The request/setup and suspended target checkpoints passed: the profile,
staging/canary state, staged fixture, zero-capability token, and creation-time
private-Job membership were observed, and the marker was absent before resume.
After resume the helper returned a frame that the first controller could only
classify as `invalid-checkpoint-frame`; no READY or later scenario ran. The
controller terminated the exact helper/Job handles, performed its token-bound
emergency recovery, and the independent post-recovery and final scans both
reported eight zero residue counts. No residue was present before development
continued.

Attempt 1 consumed exactly one profile creation, one helper process, and one
AppContainer fixture process. Its non-sensitive fingerprints were profile
name `4edb3b6e53c67dfa7769799d84f666eed15e6b5fc87e32e6d2e05fd8aeaae334`,
profile SID `9f338b09e4a8c7f6ebab9014a91490c6d842079a39912c7521fb2a466f0bdd44`,
staging root `a2b01c33c858064c1ca22390a308747b76261f068b72575c9eb5b4d853cb8e7c`,
and canary root `e767b232b17d06024899af18d6964ad8198af10beb23718aa5af853e67867389`.
It is permanently recorded as failed; later recovery or a later passing
candidate cannot convert it to passed.

The revised candidate gives the marker its own exact staging subdirectory
with an explicit AppContainer `Modify` grant and points only the fixture's
`TEMP`/`TMP` there. It also parses a strict refusal frame before classifying an
unexpected checkpoint and accepts the three prior process/profile counts as
bounded inputs so the final result enforces and reports cumulative hard-cap
usage. A complete six-scenario rerun would produce cumulative maxima of seven
profiles, seven helpers, five fixtures, and twelve helper/fixture processes,
all below the authorized 10/10/20 limits.

## Attempt 2 pre-execution gate

The revised exact candidate again passes every pre-stateful gate:

- probe/controller source envelope SHA-256:
  `ebc6dabb1c3035438b71cc29b15b2f5e43a84b062abdeb26923fa1fb48f2ca2f`;
- unchanged fixture source envelope SHA-256:
  `c19c356f2ce0bfd4bf7c00dc2e33e509b6b996fe199ba09e521096ffac781272`;
- helper apphost: 156,672 bytes,
  `94c25f8b9370c61f60dfdbc6e4fd294df49d492b3c712a4d5f44568923f6bfc1`;
- revised helper payload: 221,696 bytes,
  `261c87013f02a67668fef2a87485263a81b67d1e7b4ddc9a7de12c6f7d74dd41`;
- deps/runtime configuration:
  `edb3906cbfcc8e80f3dbc56769089ce90f7a0efd0e821a09f5abffb65f4571b5`
  / `e3a9d5d0a25ca066e8b70401b5869b5cfc92d16f5fe89b83077cdfd4b7427711`;
- fixture: 70,923,627 bytes,
  `271c8297bfe77850b173f8c250e692cd3ef868a9f122a0101f004d98069aa1fa`;
- two builds/publishes byte-identical: true;
- two read-only self-tests exit 0 and two normal probes exit 2 unavailable;
- builds have zero warnings/errors and the lifecycle forbidden-surface scan has
  zero matches; and
- immediately before attempt 2, task-directory, helper/fixture-process, and
  storage-record counts are 0 / 0 / 0.

Attempt 2 likewise stopped in the first normal scenario after the suspended
token/Job checkpoint. The improved controller surfaced the exact stable helper
code `lifecycle-target-ready-frame-invalid`. Token-bound emergency recovery
again completed and both eight-field scans were zero. Attempt 2 consumed one
additional profile, helper, and AppContainer fixture, bringing those cumulative
counts to 2 / 2 / 2. Its profile-name/profile-SID/staging/canary fingerprints
were `a82a362c8c6f813f8a9a764fd89736b1e2673774c7e592c79de1318f2f31563d`,
`596224777adcbc9167bc9c7787c318ba4e71e54136b9da0ad6844dac6828485d`,
`721cf4a00a0c0ee42251942f359628bb90ee500e902dc52a5e8770036d92b515`,
and `b198d3658d7cf005664d715ad43a1a0ff04f4186fa2958a81b30cce0ff9a5b74`.
This attempt also remains failed permanently.

One ordinary, non-AppContainer fixture positive control then used the same
digest-pinned fixture with a fresh exact marker directly under the user TEMP.
It emitted exactly `lifecycle-ready`, exited zero after the fixed one-second
hold, created the marker, and the controller removed that exact file. This
consumed one non-AppContainer fixture process and left zero marker residue. It
proved that the fixture mode and serialized READY record were sound.

The next defect was helper-side framing: the historical structured proof
read fixture output only after process exit, while the lifecycle helper made a
single read with the READY writer still alive. A pipe read may therefore expose
only a prefix of the JSON line. The final candidate uses a 4,096-byte bounded,
strict-UTF-8 incremental reader that waits for a newline under the same
30-second deadline and rejects non-newline trailing data. It also treats a
strict fixture failure record as a finite stable refusal, and considers the Job
drained only after a bounded wait plus an accounting query showing zero active
processes (including a Job that never received a target).

Attempt 3 again stopped during the first normal-lifecycle scenario. Request,
setup, and suspended-target checkpoints passed, but the bounded incremental
reader then surfaced the fixture's exact stable refusal
`fixture-lifecycle-validate-failed`. The controller used only its exact helper
and Job handles and token-derived recovery paths. Its post-recovery and final
eight-field scans were zero. This attempt consumed one additional profile,
helper, and AppContainer fixture, bringing those cumulative counts to 3 / 3 /
3. Its profile-name/profile-SID/staging/canary fingerprints were
`a5d43b3cc0a0115701f1802f7cde96a5a01384630cac7ccfff6402ee44d50f77`,
`73c68963a54bfc7744550627de06153de6bdce62e68bc2b38786d4a781ee4960`,
`947ea6fa321c7f0c792506422c6d1bd317cc9ddb04780ade1abb8d7972622bd2`,
and `89ec937c2c5e412f282ddfe2c0c676ad6d94de4d7f9e057447e4ef6e12de9147`.
It remains a failed attempt permanently.

The refusal showed that the lifecycle fixture was still binding its marker to
the AppContainer's ambient TEMP identity. The retained candidate instead
derives the only accepted lifecycle marker from its own exact staged image:
`stage17-helper-fixture-<token>.exe` may write only the sibling
`marker/stage17-helper-lifecycle-<same-token>.marker`. Boundary-fixture marker
validation remains bound to the fixture TEMP used by the historical proof.

A second ordinary, non-AppContainer positive control exercised that final
validator from an exact staged image. Source and staged fixture SHA-256 were
both `041e7d1d88e21b7cecd6013a0cd220ea5ec3ce806cd48954370c441b292cee13`.
It emitted exactly schema 1 / `ready` / `lifecycle-ready`, created the exact
marker with `stage17-helper-lifecycle-ready-v1`, exited 0 after the fixed
one-second hold, and left neither marker nor staging directory after exact
non-recursive cleanup. This brought ordinary fixture controls to two and total
helper/fixture process creations before the retained matrix to eight.

## Final candidate pre-execution gate

The final candidate was built twice in separate task-owned external output and
intermediate directories after the marker-validator correction. Both builds
had zero warnings and zero errors. The two output sets are byte-identical,
ordinary non-reparse files and contain:

- probe/controller source envelope SHA-256:
  `19b2829ebb3a70a0f4c57c6f2ea8251c79000dde0827408218d7b6103b188845`;
- fixture source envelope SHA-256:
  `74e146e1d21ffba65bd671d499629e3c6d54829837ae5d3a95d986ba6fcf30ef`;
- helper apphost: 156,672 bytes,
  `94c25f8b9370c61f60dfdbc6e4fd294df49d492b3c712a4d5f44568923f6bfc1`;
- helper payload: 223,744 bytes,
  `800f2dea9eea797d5ef82d11ce1de8359ab57b98a5af88d65714c7f65db906fc`;
- deps/runtime configuration:
  `edb3906cbfcc8e80f3dbc56769089ce90f7a0efd0e821a09f5abffb65f4571b5`
  / `e3a9d5d0a25ca066e8b70401b5869b5cfc92d16f5fe89b83077cdfd4b7427711`;
- fixture: 70,923,627 bytes,
  `041e7d1d88e21b7cecd6013a0cd220ea5ec3ce806cd48954370c441b292cee13`;
- both read-only self-tests exit 0 with deterministic, body-free output and
  lifecycle protocol checks true; both normal probes exit 2 unavailable; and
  both unknown-command checks exit 64 with `unsupported-command`.

The retained run carried prior counts 3 profiles / 3 helpers / 3 AppContainer
fixtures / 2 ordinary fixtures into its cap checks. All six scenarios ran, so
the cumulative counts are 9 / 9 / 7 / 2, or 18 total helper/fixture processes,
within the exact 10 / 10 / 20 authorization. Immediately before
execution, task-directory, package-folder, helper-process, fixture-process,
storage-record, and mapping-record residue counts were all zero. The final
lifecycle-only source scan found no public-network, DNS, provider, credential,
shell, name-based kill, recursive-delete, dependency, unsafe-code, or secret
surface. The historical boundary fixture still contains its previously
reviewed parent-controlled loopback probes, and the historical synthetic proof
still contains its digest-pinned `cmd.exe` fixture; neither is reachable from
the new finite lifecycle command.

## Retained six-scenario result

The retained command exited 0 with stable reason
`helper-lifecycle-crash-proof-passed`, `capsRespected: true`,
`stoppedAfterFailure: false`, `manualRecoveryRequired: false`, and
`productionBackendAvailable: false`. It reported a 4,096-byte frame maximum,
one request per fresh helper, no inherited ambient environment, and exactly
four explicitly inherited helper handles.

| Scenario | Required checkpoint | Target observation | Cleanup owner | Result |
| --- | --- | --- | --- | --- |
| `normal-lifecycle` | `cleanup-complete` | suspended, READY, zero exit; marker consumed before cleanup | helper | passed |
| `client-disconnect-before-target` | `setup-complete` | no fixture created; helper observed channel loss and exited 7 | helper | passed |
| `helper-terminated-after-setup` | `setup-complete` | no fixture created; exact helper handle exited 17 | supervisor | passed |
| `helper-terminated-target-suspended` | `target-suspended` | marker absent; target never reached READY | supervisor plus exact Job | passed |
| `helper-terminated-target-running` | `target-ready` | marker observed; target killed and Job drained | supervisor plus exact Job | passed |
| `helper-terminated-after-target-exit` | `target-exited` | READY and zero target exit observed before persistent teardown | supervisor plus exact Job | passed |

Every scenario observed its exact expected phase. All four injected helper
terminations used the exact process handle returned by controller creation and
reported helper exit 17. The two pre-target Jobs had total-process accounting
0; each Job that received a target reported total 1 and active 0 after drain.
No descendant survived, every controller handle was closed, and every
scenario's independent and post-recovery eight-field residue scans were zero.
The normal and disconnect paths used helper-owned cleanup; the four injected
terminations used the predesigned supervisor recovery. None required manual or
ad-hoc recovery.

The retained non-sensitive scenario fingerprints were:

| Scenario | Profile name | Profile SID | Staging root | Canary root |
| --- | --- | --- | --- | --- |
| normal | `ee22c17603fb1acc70d84e75caea33c64a6e36e645c0f4deb75669cbd839c6ca` | `a71977a8b5167188579cba6e0a9cfe8d130ca1811591723553233c4c3d902020` | `5c3e96af2ec64c17ae042761c24b8727a2998659eb4453cd8b8d26a724843060` | `9e330f524fdaa8e894171eb102197c16004bcc258f784aeafc1ba293cc37b01b` |
| disconnect | `bbeb11ecc96e0a3add73c50cdd9e74bf7a4ad97b33324748a0f32c1ebcf7ca4d` | `e8f0df4020bd2c0537a8f0a6899498c1fa5f92c275907a045fe771a1b80cc163` | `b6bf9d5fce349cf480eb588f3847c54b33db237f3306cd2ce6d1fee07b92517a` | `bf0c6f6f3648cb864ebf094b8c04313af620e5c3ea7ac9a70b0286b2f8f3f66c` |
| terminated after setup | `6f3dfbbd0d08eac8c26f79c661ea964f291bc4c4f40667d47076c446fd0a210d` | `5efa27fc51aae18fccf54bd2e0022c94e4b5d72d939e49d8fb1d57822dcc4df4` | `6c462d9bef64f92d2b96c1ea21273d8acad26bb4a45a1fa0d0ad4c2fbc0f1183` | `713f918a6b093be8a06f69aaa6a863ba8f42f6d4210b24537e09605c51f5ae51` |
| terminated suspended | `09ff4897543721b527f7081047f0481cd28d56f1346ce7484a2160f23adcc4cc` | `59f63407b1d3bee864d0e518fb60dc231d15c003b9cf815d1120e4653bd12dc0` | `be0be76a8a8059053681d6333c5e0ef13d336aaa7eca5019435152c9513f9b83` | `ace92088026436fbbbb8d14ecb91f0f311cf4f803838455c2551d9f2d9536595` |
| terminated running | `6c09a3775196fdf3740a8e069d159afc7b75a30d05ab8a91b6d802551872a844` | `57ed057ce2683245b1fe58c0bb03bc30e3bc17b8a42551069811d2421801fba5` | `5b5d58b97276611414ac9619fae593af0669d025923b4cc08fd505b2d591030c` | `5d4b83d4ac8ca640c416e637b946544e12be4c90cf2bd8d252f5afbc446f9e3a` |
| terminated after exit | `105004342073251a7d4830c2082060c5d3df90237ebfa76114a9dff21026b60b` | `635a5639d5d7afc3ea14df75e9f969d6d98865ee2bbf284d7c386b02a16f851e` | `750c9dcfb74db7ef35c1adfcd546722735e4c3d0a01f5541fc863f01f5db8780` | `a8554e16f697d70f24e531027a608990cbb1b61a5813d94efa092235d66537d3` |

An external read-only host scan immediately after the retained command also
reported zero matching task directories, package folders, storage records,
mapping records, helper processes, and staged fixture processes.

## Package and repository gates

The unchanged process-broker production code passed exactly the required
package gates after the retained proof:

- typecheck: passed;
- unit tests: 5 files and 319/319 tests passed;
- coverage: 92.36% statements (1,597/1,729), 85.92% branches
  (995/1,158), 98.32% functions (293/298), and 92.99% lines
  (1,539/1,655), above every configured threshold;
- build: passed; and
- npm pack dry-run with scripts ignored on the implementation candidate: 102
  files, 122,983 package bytes, 581,955 unpacked bytes, and zero native entries;
  after the package README evidence update in commit
  `cacf2ed35fa7597ebdfab46f51882efaaee173d7`, the exact package inventory was
  rerun at 102 files, 123,477 package bytes, 583,234 unpacked bytes, and still
  zero native entries. This release-evidence-only reconciliation does not enter
  that package, so the final inventory is unchanged.

`packages/process-broker/src`, package manifests, the lockfile, install hooks,
native packaging allowlists, and production registrations/issuers have no diff
from the starting commit. No provider, credential, repository workload, paid
call, public network, privilege, policy, firewall, proxy, service, scheduled
task, remote, tag, push, package publish, or external model audit was used.

Task-owned compiler and publish output remains under the user TEMP, including
the retained exact final build root
`ai-dev-os-stage17-helper-lifecycle-final-v4-c9dce8f5362a4876aba5cd59f2ca4c2c`
and earlier build-only iteration roots. They contain no AppContainer profile,
ACL grant, registry record, running helper/fixture process, or proof token
directory and are excluded from npm packaging. They were intentionally not
removed because this authorization limited cleanup to exact files and empty
directories and prohibited broad recursive deletion.

## Release consequence and limitations

This result proves a narrow, test-only lifecycle protocol and supervised
cleanup design on one Windows host. It does not supply a production helper,
installed-package native artifact, production registration or receipt,
executable-immutability guarantee against same-user replacement, general
filesystem/network/IPC/credential containment, kernel quotas, controlled
provider egress, or any escape-corpus result. Linux, macOS, and CI were not
executed.

Windows therefore remains `unavailable`; every production capability remains
false; every quota dimension remains `unsupported`; actual Windows corpus
coverage remains 0/40 with result `not-run`; Stage 17 remains gated; Stage 18
remains blocked; and no `v0.17*` tag, remote, or push is permitted by this
checkpoint. The smallest separately authorized next step is to design and
package a production Windows helper with an immutable installed artifact and
then run the complete armed 40-vector Windows corpus, including the still
unproved general boundaries and quotas.
