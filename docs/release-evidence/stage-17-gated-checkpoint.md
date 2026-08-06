# Stage 17 gated checkpoint evidence

Date: 2026-08-05

Outcome: **GATED — not a Stage 17 release**

This evidence records safe Stage 17 progress. It does not claim a production
sandbox, native enforcement, controlled provider egress, cross-platform test
execution, CI execution, or release eligibility. Production autonomous
execution still refuses before spawn, Stage 18 remains blocked, and
`v0.17.0-secure-execution-backends` must not be created from this checkpoint.

Follow-up evidence subsequently proved the same-user AppContainer profile
lifecycle, one bounded suspended synthetic AppContainer plus creation-time
private-Job composition, and one structured filesystem/loopback/child-attempt
fixture with zero measured residue. See
`stage-17-windows-profile-lifecycle-proof.md` and
`stage-17-windows-synthetic-process-proof.md`, and
`stage-17-windows-structured-boundary-proof.md`. These observations do not
alter this checkpoint's gated release outcome: no production helper or corpus
vector has passed.

## Provenance and Git lane

- Stage 16 tag type: annotated `tag`.
- Stage 16 tag object: `9fbaf6e1d7cbae7e026b1dadae6109ac46a884e4`.
- Stage 16 peeled commit: `c344b1e9264e5306fb648abaa7add6cebc17c3cc`.
- Stage 15 commit `62430da153e962960142865a90cbae64a2622bc9`
  is an ancestor of the Stage 16 commit.
- Stage 17 branch: `feat/stage-17-secure-execution-backends`.
- Stage 17 worktree:
  `C:\Users\mrali\Projects\ai-dev-os-stage-17-secure-execution`.
- Audited post-fix code candidate:
  `11c0a41beb1f61bc7330d1e06f464cc8f1dfbb38`.
- No Git remote is configured. No push or executable remote CI run occurred.
- No `v0.17*` tag exists. The evidence commit containing this document is
  intentionally not a release tag.

Ordered implementation commits before this evidence document:

1. `e3dc50bf44f31c3f45825e3147129985db5a3a3b` — define the secure-execution trust boundary.
2. `f26e2ca92309cab06a317a05718b6d04405307f1` — require measured production evidence.
3. `91df1a5a44a00012d782f87195721951c612475a` — record the gated platform checkpoint.
4. `270c8256ed39f52acffec2530032a245919881a0` — normalize ADR formatting.
5. `11c0a41beb1f61bc7330d1e06f464cc8f1dfbb38` — pin production registration to the canonical escape corpus.

## Implemented contract

- Capability-grant schema 2 binds immutable tool references, environment-name
  authority, credential-reference fingerprints, and a control-plane endpoint
  policy fingerprint. Normal and duplex execution apply the same monotonic
  grant, lease, policy, path, environment, network, quota, output, and deadline
  checks.
- Backend-descriptor schema 2 separates `unsupported`, `deny-all`, and
  `controlled-service-egress` boundaries. Descriptors and IDs are advisory.
- Enforcement-attestation schema/algorithm 1 is body-free and non-authorizing.
  Opaque first-party registration is tied to backend object identity,
  descriptor, exact host/helper/profile, quota matrix, endpoint policy,
  freshness, boundary evidence, and the canonical escape corpus.
- Production preparation returns a package-private, single-use receipt valid
  for at most five minutes and no longer than the attestation. Final admission
  binds it to the exact execution and sandbox session immediately before
  spawn. Forgery, replay, mismatch, staleness, drift, invalidation, and cleanup
  uncertainty fail closed.
- Endpoint-policy schema/algorithm 1 permits only exact lowercase public DNS
  names over HTTPS/443, bounds redirects, disables QUIC, and rejects IP,
  local/internal, wildcard, IDNA, trailing-dot, proxy, and arbitrary workload
  egress. No provider endpoint is guessed and no relay ships.
- Escape corpus v1 has 42 deeply immutable vectors, fingerprint
  `125b809194d26cf1be518249b96727b78be80c25088826464ec94154a6fb3652`,
  and exact applicable counts of Windows 40, Linux 41, and macOS 41. A
  substituted version/fingerprint/count cannot authorize production.

## Measured tests and coverage

The post-audit process-broker result is 308/308 tests. The focused Stage 17
file is 75/75; these are parser, protocol, admission, lifecycle, and adversarial
composition tests, **not native enforcement tests**.

| Scope | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Process broker | 1,569/1,730 (90.69%) | 985/1,156 (85.20%) | 283/303 (93.39%) | 1,514/1,652 (91.64%) |
| Repository aggregate, 32 packages | 19,448/20,773 (93.6215%) | 12,857/14,847 (86.5966%) | 3,876/3,978 (97.4359%) | 17,586/18,561 (94.7471%) |

Changed consumer results were workspace 107/107, Claude Code 255 passed with
7 intentional live skips, and Codex 89 passed with 4 intentional live skips;
their typechecks and builds passed. The repository-wide `npm run check` passed
on the post-audit code candidate in 1,320.653 seconds: 2,579 passed and 24
intentional skips across 32 workspace suites, 126 passing test files and 2
skipped files.

The aggregate coverage command completed and wrote 31 package reports before
the Windows host suspended from approximately 16:55 to 20:06. The command
wrapper then timed out and left only the final workspace's workers orphaned;
those exact orphan PIDs were verified and terminated. The one missing
workspace suite was rerun successfully in 65.975 seconds at 107/107, producing
the 32nd LCOV report and the totals above. This is recorded as an
infrastructure deviation, not represented as an uninterrupted root-command
success. The final handoff separately records the required exact-final-tree
rerun after the evidence commit.

## Install, dependency, static, and security evidence

- `npm ci`: 142 packages installed; lockfile stayed at SHA-256
  `818aa42c91c84d8272eff3b4287daf554396810b5021d40244bdca65685594f6`.
- Root and packed-consumer `npm audit --audit-level=high`: zero vulnerabilities
  at every severity.
- 32 package manifests, 103 internal runtime edges, no dependency cycle,
  undeclared internal dependency, private-subpath import, or process-broker
  source orphan. Direct reverse edges into process-broker are workspace,
  Claude Code, and Codex; transitive reverse edges additionally reach router
  and telemetry-ledger. Process-broker depends only on artifacts, domain, and
  policy.
- No Stage 17 manifest or lockfile change; no new native dependency, helper,
  binary, download, install hook, or runtime network sink. First-party
  manifests have no preinstall/install/postinstall script. Existing lockfile
  install surfaces are optional `fsevents` and the pre-existing
  `better-sqlite3` dependency of persistence-sqlite.
- No merge marker, tracked generated artifact, added focused/disabled test,
  added high-confidence secret, dynamic code/eval, `shell: true`, source
  network call, or nondeterministic `Date.now`/`Math.random`/`randomUUID`/
  locale comparison exists in process-broker production source. Four
  conditional skips in the unchanged Ollama live-canary file remain explicit
  opt-in live tests.
- Process execution remains structured with `shell: false`. Ambient proxy and
  `NODE_OPTIONS` names occur only in the environment denylist. Raw native
  message checks are not applicable because no native protocol/helper exists.
- No lint script exists; none was invented or claimed.

## Packaging and reproducibility

`npm pack --dry-run --ignore-scripts` contained only README, package manifest,
and compiled `dist` files:

| Package | Files | Packed bytes | Unpacked bytes |
| --- | ---: | ---: | ---: |
| `@ai-dev-os/process-broker` | 102 | 121,159 | 577,200 |
| `@ai-dev-os/workspace` | 62 | 70,105 | 311,586 |
| `@ai-dev-os/provider-claude-code` | 74 | 111,132 | 471,546 |
| `@ai-dev-os/provider-codex` | 66 | 54,843 | 262,193 |

Two fresh post-fix process-broker packs were byte-identical at SHA-256
`a9b213e00ff6ad52f1716f9b633b79b363d2bd78abdfe4b587e7c1a2d91fe4ca`.
A repeated build produced byte-identical compiled output, and fresh processes
reproduced the same corpus fingerprint.

A fresh temporary consumer installed tarballs for all 32 internal packages
plus Vitest. It proved root and `./testing` imports, exact corpus identity and
deep immutability, absence of public registration/receipt issuers, rejection
of the private `trusted-evidence` subpath, null projection for opaque forgery,
and unavailable/mismatch behavior for all platform factories. An earlier
fresh consumer also exercised forged descriptor/ID/summary, stale unissued
evidence, forged session receipt, unsafe production refusal, no-spawn, and
body/path leakage canaries. Both consumer audits were zero; task-owned
consumer and reproducibility directories were removed after verification.

## Independent read-only audit

Claude Code CLI 2.1.201 was invoked twice in fresh non-interactive sessions
with requested alias `opus`, actual reported main model `claude-opus-4-8`,
High effort, plan permission mode, and only Read/Glob/Grep/Bash tools. The CLI
also reported small `claude-haiku-4-5-20251001` support-model usage. Web search
requests were zero, and Write/Edit tools were absent.

- Initial audit session `6b8e43a2-bb49-4a47-8986-f387753812eb` reviewed
  `270c8256ed39f52acffec2530032a245919881a0` against the Stage 16 base. Verdict:
  PASS for a gated checkpoint, with one valid medium future-soundness finding:
  registration accepted a claimed passing corpus without pinning its canonical
  identity and applicable count.
- Fix `11c0a41beb1f61bc7330d1e06f464cc8f1dfbb38` introduced the runtime canonical
  contract, exact verification, stable refusal, and positive/negative tests.
- Focused post-fix session `892ef386-abba-435c-806c-5249a521a1ff` reviewed that
  exact fix. Verdict: PASS; the finding was fully resolved with no residual or
  regression finding.

HEAD and porcelain status were identical and clean before and after both
audits.

## Platform truth and blockers

| Platform | Actual host | Backend status | Native artifact | Actual escape tests | Blocking evidence |
| --- | --- | --- | --- | ---: | --- |
| Windows 11 Pro 10.0.26200 x64 | yes | unavailable/not implemented | none | 0 | reviewed restricted identity, race-free Job ownership, filesystem/network boundary, quotas, and positive-control corpus |
| Linux | no | unavailable/unverified | none | 0 | actual host plus reviewed namespace/cgroup/filesystem/network implementation and corpus |
| macOS | no | unavailable/unverified | none | 0 | actual host plus supported documented containment foundation and corpus |

The observation host had Node 24.17.0, npm 11.13.0, Git
2.54.0.windows.1, and .NET SDK 9.0.316, but no C/C++ compiler, Windows SDK,
WSL, container CLI, VM CLI, Linux/macOS runner, configured remote, or
executable CI surface. Checked-in Ubuntu/Windows workflow names are not run
evidence. Native coverage, helper provenance/digests, signing, hermetic
approved-service egress, and all platform enforcement suites are therefore
not run and must not be inferred.

Release blocker conclusion: Windows, Linux, and macOS require actual reviewed
enforcement implementations and platform evidence; controlled provider egress
requires exact locked endpoint evidence plus an enforcing tested relay. Until
all of those exist, production remains closed, Stage 17 remains gated, Stage
18 remains blocked, and no Stage 17 tag or push is permitted.
