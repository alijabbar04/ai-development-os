# Stage 18 Windows credential secret-broker checkpoint

Date: 2026-08-14

Status: production-disabled enabling checkpoint; `ANT-02` remains incomplete

## Outcome

AI Development OS now has a narrow Windows Credential Manager implementation of
its existing `SecretBroker` contract and a policy-aware Anthropic credential
composition. It accepts one exact allowlisted text `keychain` reference, hashes
the canonical locator into one bounded Win32 target, and exposes only exact
availability/read. It does not expose enumeration, mutation, process,
credential-file fallback, arbitrary-path, environment, browser,
registry-generic, service, or network authority. The sole file load is the fixed
package-relative reviewed native addon and occurs lazily on an operation.

This checkpoint configured and read no real credential. It made no Anthropic or
other provider call. The public Anthropic provider remains production-disabled.
Therefore `ANT-02`, `AM-02`, `PLN-02`, development acceptance, and production
admission remain unchanged.

## Source identity and scope

- Base branch: `feat/stage-18-live-integration-closure`.
- Exact base commit: `c50c4725981013f123ebef0d0a87082f085b333d`.
- Exact base tree: `eaf01bc25651033c9bc4e32428b04151caea8e9b`.
- Candidate branch: `feat/stage-18-windows-secret-broker`.
- Current scope is exactly 46 Git-visible paths: 24 modified tracked paths and
  22 untracked paths. The ordinal LF-terminated path list is 1,933 bytes with
  SHA-256 `ab12d2ac36ae9852a522a4d9d7b5a5bc0f02f8f67a385f1d471077e961994ac0`.
- Final commit/tree, staged identity, upstream, remote, and exact-head CI remain
  publication boundaries and are recorded only after they occur.

The implementation adds `@ai-dev-os/secrets-windows`, updates the generic
Anthropic credential port, pins the Windows native compile in CI, and updates
the ADR, threat model, architecture, roadmap, acceptance matrix, and package
documentation. No application production registration or admission variant is
added.

## Security boundary

- Reference type `keychain`, kind `text`, null version, and exact namespace,
  service, account, and optional provider instance only.
- Target `AI-Dev-OS:v1:<namespace>:<sha256(canonical locator)>`; raw account,
  service, provider-instance, user/email, and path text are absent.
- Central policy-aware resolver binds secret subject digest, operation/provider/
  trace scope, classification, and approval evidence before native access.
- Repository-owned async C/N-API exports only `availability` and `read`, calls
  only `CredReadW`/`CredFree`, caps material at 16,384 bytes, and maps a closed
  result set with no raw Win32 detail.
- Native/Node mutable copies are overwritten where controlled; immutable V8,
  OS/runtime, paging, crash-dump, and malicious-callback copies remain explicit
  nonclaims.
- Close rejects new work and waits for entered OS/callback work. Cancellation
  and deadline are checked before/after the non-preemptive local Win32 read;
  late material is zeroed.
- Production exports exclude the fake/native port; testing exports contain only
  the two-operation port and fake-backed broker factory. No binary is committed
  and `gypfile: false` prevents npm from synthesizing an install hook.

ADR 0028 and the companion threat model contain the complete decision and
residual-risk analysis.

## Deterministic proof

All results below target the frozen 46-path candidate on Node 24.17.0 and npm
11.13.0:

- focused suites and no-emit typechecks pass for all six materially affected
  packages: secrets 15/15, Windows secrets 48/48, Anthropic 135/135, OpenAI
  325 pass plus 2 intentional skips, Gemini 26/26, and OpenAI-compatible 39/39;
  588 tests pass and 2 are intentionally skipped in those six suites;
- exact affected coverage is:

  | Package | Statements | Branches | Functions | Lines |
  | --- | ---: | ---: | ---: | ---: |
  | secrets | 96.37% (186/193) | 94.67% (160/169) | 100% (40/40) | 100% (147/147) |
  | secrets-windows | 94.86% (462/487) | 96.91% (314/324) | 98.57% (69/70) | 94.53% (363/384) |
  | provider-anthropic | 93.30% (850/911) | 88.41% (771/872) | 99.06% (106/107) | 96.71% (737/762) |
  | provider-openai | 92.65% (1,791/1,933) | 87.77% (1,400/1,595) | 95.40% (270/283) | 92.91% (1,758/1,892) |
  | provider-gemini | 91.82% (483/526) | 84.82% (369/435) | 91.86% (79/86) | 98.34% (237/241) |
  | provider-openai-compatible | 91.98% (574/624) | 84.71% (410/484) | 94.28% (99/105) | 97.34% (404/415) |

- root `npm run check` passes the complete 40-workspace typecheck, test, and
  build chain in 1,379.6 seconds;
- root `npm run test:coverage` passes in 797.1 seconds. All 40 coverage roots
  exist. Aggregate exact fractions are 27,551/29,551 statements,
  19,304/22,153 branches, 5,297/5,429 functions, and 24,924/26,281 lines,
  yielding floor-to-two-decimal coverage of 93.23%, 87.13%, 97.56%, and 94.83%;
- root `npm ls --all --json` exits 0 with no actual problem entry. Repository
  `npm audit --json` exits 0 with zero info/low/moderate/high/critical
  vulnerabilities across 264 dependency records, and `npm audit
  --audit-level=high` exits 0 with `found 0 vulnerabilities`;
- the provider composition tests run disclosure policy, secret-access policy,
  exact fake native read, callback-scoped material, and deterministic injected
  transport in order. They perform no HTTP request. Static policy pins the
  complete native/export/install authority and maintained-consumer contract;
- exact dry packs with scripts disabled contain zero bundled dependencies:

  | Package | Files | Packed bytes | Unpacked bytes | SHA-1 |
  | --- | ---: | ---: | ---: | --- |
  | secrets | 14 | 17,397 | 81,217 | `7702b09365bac56794797281e27466675a593751` |
  | secrets-windows | 28 | 19,892 | 94,379 | `6c90119963c14f6136d05c79685fb9556e0cfe53` |
  | provider-anthropic | 38 | 47,639 | 241,216 | `ec9367233dbed72aaf80da2383caf4d8e948e2f2` |
  | provider-openai | 70 | 108,476 | 501,761 | `a21bb3b60aae55c2dfd5809b35032c9842e8d31c` |
  | provider-gemini | 34 | 23,964 | 108,870 | `13b4d225ecb3d672085a73847eab797b633f6ddc` |
  | provider-openai-compatible | 46 | 29,118 | 137,653 | `93226325c1c8e203a6f8cb236e98bcc6089f8673` |

- one fresh external consumer installed seven exact internal tarballs offline
  with scripts disabled. It had seven dependencies, zero `npm ls` problems and
  zero audit vulnerabilities, confirmed the packed Windows package is private,
  has `gypfile: false`, has only `.` and `./testing` exports, bundles nothing,
  and produced no native build output. It imported the real production/testing
  entries, constructed and closed the production broker without loading the
  addon, and passed one synthetic fake-native -> central policy -> Anthropic
  callback flow while proving the returned native byte view was zeroed. It
  called no OS credential or provider boundary;
- the one exact, contained recursive cleanup command for that consumer was
  safety-blocked. It was not retried or rerouted. The nonsecret task-owned
  directory remains at
  `C:\Users\mrali\Projects\ai-dev-os-stage18-windows-secret-broker-consumer-20260814`
  with generated tarballs, installed public packages, and the two smoke files;
- scans find no probable credential/key material, no generated binary/archive/
  coverage/log path in Git, and the distinctive synthetic broker marker only
  in its explicit test fixture. All six changed JSON files parse, `git
  diff --check` exits 0, and no Git lock exists; and
- independent GPT-5.6 Sol/Max same-family, strictly read-only source/package/
  ADR/threat-model/test review is exhausted at PASS. Every reported must-fix
  authority, binding, lifetime, error, native, lifecycle, export, package, CI,
  consumer, and mutation-discrimination finding was repaired. The reviewer did
  not compile/run native code or access credentials, providers, installed
  state, or protected state.

## Native proof

The workstation has Node 24.17.0 headers and `node.lib`, but no Visual Studio C++
workload, Windows SDK libraries, MSVC linker, or LLVM linker. The exact local
`node-gyp rebuild` therefore refused during toolchain discovery before compiling
source, with the finite requirement for Visual Studio Desktop Development with
C++. No UAC or toolchain installation was attempted.

Hosted Windows CI explicitly builds the addon with MSVC `/W4 /WX`, SDL, and CFG,
proves a bounded malformed-target table refuses before native work is queued,
then requires actual `not-found` results through both availability and read for
one fresh random synthetic target that the project never creates. Those results
and the run/job identity are required before final checkpoint completion. If an
unexpected matching generic credential existed, exact `CredReadW` would access
and zero its returned blob before the script failed; therefore no native
credential access is claimed until both hosted `not-found` results exist. The
probes create, mutate, delete, and enumerate nothing. A test-only native
writer/deleter was intentionally not created because it would widen credential
authority solely for testing.

## Final reconciliation

Local source, tests, coverage, dependency, audit, package, consumer, scan, and
independent source-review gates are complete on the frozen bytes. No path is
staged and no candidate commit, upstream push, or hosted run exists yet. Final
commit/tree identity, local/upstream/live-remote equality, and exact-head hosted
CI remain future publication facts and are not claimed by this pre-publication
packet.

## Acceptance truth

- `INT-01`: proven.
- `ANT-02`: incomplete; no eligible real reference and no live request.
- `AM-02`: incomplete.
- `PLN-02`: incomplete.
- `developmentAccepted=false`.
- `productionAdmitted=false`.

No Stage 17W operation or protected-state read, installed Account Manager read,
inactive-window packed-consumer retry, PR, main mutation, force push, tag,
release, registry publication, or production activation occurred.
