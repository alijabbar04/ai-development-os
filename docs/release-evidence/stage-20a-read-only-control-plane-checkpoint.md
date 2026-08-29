# Stage 20A C3-C5 read-only control-plane checkpoint

## Scope and publication boundary

This checkpoint closes only the production-disabled Stage 20A C3-C5 source
slice. It adds identity, exact artifacts, lifecycle/adoption, a literal-loopback
read host, and leakage-safe injected projections. It does not begin Stage 20B,
the project spine, desktop composition, commands, task or agent supervision,
provider dispatch, credential access, installation, production activation, a
pull request, merge, tag, or release.

The exact executable source reviewed independently is recorded below. This
evidence document and the status-line updates are a documentation-only
publication delta. Embedding the final evidence commit hash, its hosted-CI run,
or post-push remote equality inside that same commit would create an impossible
self-reference. The terminal handoff therefore supplies those final exact-head
facts after this file is committed, validated, non-force-pushed, and observed
remotely. No review verdict is transferred to changed executable bytes.

## Entry identity

The preserved Stage 20A C0-C2 base was:

- worktree: `C:\Users\mrali\Projects\ai-dev-os-stage20a-api-foundation-20260825`;
- branch: `feat/stage-20a-api-contract-foundation`;
- HEAD: `c85aad248c8f7a9ce73c1440f147971405d6ab02`;
- tree: `b59d18ef0e3ff3e335e046418184c737d2c4370e`;
- hosted CI: run `32968199670`, attempt `1`, seven successful jobs; and
- authoritative checkpoint:
  `docs/release-evidence/stage-20a-api-foundation-checkpoint.md`.

C3-C5 was isolated in:

- worktree:
  `C:\Users\mrali\Projects\ai-dev-os-stage20a-readonly-control-plane-20260826`;
- branch: `feat/stage-20a-read-only-control-plane`; and
- exact base: `c85aad248c8f7a9ce73c1440f147971405d6ab02`.

The entry identity, upstream/live-remote equality, divergence `0/0`, clean
index/worktree, and clean `git diff --check` were verified before edits. The
C0-C2 worktree and branch were not edited.

## Checkpoint history

| Checkpoint | Commit | Tree | Meaning |
| --- | --- | --- | --- |
| C3 | `03dca171dbca48519aba68a51bcf76bd30a21abc` | `7ef20eab75388c684c3b1dccdaa0ede04602b826` | Identity, descriptor, lock, lifecycle, and adoption boundary |
| C4 freeze | `d60ab9a8988c7d70dea8bf9fd999ee360e8717a9` | `4ca4448cdd0738f058be74bb20ed81beb3822add` | First literal-loopback Fastify read listener |
| C4 repair | `eb31f760666bd23fb97deb874aa02929628622e1` | `ce728aea8c503c6daf9ca1aa7fb3033342cebfc9` | Closed the first security-review findings |
| C5 projection | `cbd50f717b97d82b76659ac8d9f696af232ab28e` | `c48ddcfde1615e04bd60118b5f2d6e5f9a04ee29` | First four UI-facing projections |
| C5 truth repair | `fece1e70543a0d61df44c410c15b2265b47c01b6` | `4458f412985d5288a78b5afe405216362c24246e` | Bound source truth and policy parity |
| C5 detector freeze | `384f082cb0898c777ac7e25f3d9f53d7b671bd09` | `84a4dc8ac608fbe10dac504d680b137b5df2f700` | Completed the first hostile/detector corpus |
| Review repair | `286d75530f4e1fddc160e5a34e949bc87c4494e1` | `a561ed4c2652722a3f79088617dba59bae0662ea` | Presentation, W3, route-selection, and copy repairs |
| Leakage repair | `8765a46c9375cc99e18a10a69d5ffc77bf72ae21` | `6c6c235d3d946a35a5acfa5fc0d46451d75db903` | Real-bearer and borrowed-Fable refusals |
| Reviewed source | `9a7d03ee6ed0ab9212f336d54d7eb6b7bac572b2` | `d2498883a9db16920cad9b5fd0803467b8f6f40b` | Usage/session temporal-evidence binding |
| Hosted Windows fixture repair | `82eb99af2ecdd83e6b218c9c04686d9b1274380d` | `9394deaada3a4dbeec978774d070aa93fc04b917` | Canonical disposable test roots; production source unchanged |
| Credential smoke clock repair | `83c72a06c1e2e446938c8e512ebaf5f296dae47a` | `aa5b461cacf5ac1144bb3e66614b79cb168842ba` | Aligns only the synthetic host/authorization clock with the smoke start; production source unchanged |

The reviewed source parent is
`8765a46c9375cc99e18a10a69d5ffc77bf72ae21`. Its branch, HEAD, tree, parent,
staged/unstaged/untracked path lists, and final post-review status were checked
exactly and were clean.

The control-service production source tree is
`7d7955cc498777700214b6ad75dab711ad401c40` at reviewed source `9a7d03e`,
hosted-Windows repair `82eb99a`, and credential-smoke repair `83c72a0`. The
first hosted repair changes only six control-service test files and two
test-infrastructure files. The second changes only credential-setup synthetic
test-harness code and its focused unit regression. The credential-host
production-main tree remains `0a67b5431ba9ac16cc6767b1b15da3c2aee81b74`,
byte-identical to parent `6be5c2d`. Neither repair adds packaged or exported
code, a route, schema, command, dependency, listener authority, provider call,
credential access, or production path.

## Component boundary

`@ai-dev-os/api` remains the C2 pure, framework-independent envelope and
allowlist-projection package with an explicit zero-route registry. Server,
filesystem, session, and listener code is confined to the separate
`@ai-dev-os/control-service` package. That host imports the pure API and domain
contracts, has no executable entry point or production bootstrap, and has no
provider, credential, vault, Account Manager, scheduler-command, task, agent,
workspace, repository, Git, environment-selected host, CLI-selected host, or
process-launch adapter.

Fastify is pinned exactly to `5.12.1`; no optional listener plugin was added.
The lock-resolved complete workspace dependency tree is inspected with
`npm ls --workspace @ai-dev-os/control-service --all`, and the repository
dependency gate is `npm audit --audit-level=high` with zero vulnerabilities.
Final rerun results are bound by the exact-head handoff rather than projected
in advance here.

## C3 identity, artifacts, lifecycle, and adoption

Per launch, the nonce and bearer use separate cryptographic random draws and
incompatible exact shapes. The descriptor is the only plaintext bearer
handoff. The server retains only SHA-256 digest material and uses a
fixed-length constant-time comparison. Active, expired, and refused states are
finite; there is no renewal or mutation route.

Descriptor and lock files have fixed names, strict exact-key parsing, bounded
size, exact named reads, create-only promotion, component/root containment,
linked-artifact refusal, opened/named identity rechecks, and cleanup bound to
the exact PID, nonce, and file identity previously observed. No directory is
enumerated. A create-only mutation claim serializes cooperating writers across
ownership-check/unlink. Age alone never establishes staleness; ambiguous or
live-foreign evidence refuses, and dead-PID replacement still requires two
matching exact artifacts.

The lifecycle transition table is total across absent, starting, adopting,
ready, stale, draining, lost, and closed states. Illegal cells produce typed
refusal, fresh/adopted startup remains distinct, unresolved recovery remains
unresolved, and no transition grants production, task, or provider authority.

Adoption strictly parses the descriptor, refuses a requested/descriptor
presentation mismatch before creating transport, then uses one private TCP
socket and one monotonic deadline. `/v1/health` is unauthenticated. Nonce,
version, and presentation must match before `/v1/session` receives the bearer.
The socket cannot reconnect after peer closure. The authenticated response
repeats identity and supplies exact, current running-session evidence; stale,
future, malformed, missing, or extra evidence refuses. The adopter also
requires the evidence computation time not to exceed the response `serverNow`.
A real task-owned replacement-listener fixture proves no Authorization header
is sent after the verified listener closes, and its planted positive control
proves the fixture detects disclosure.

## C4 listener and authority

The host binds and runtime-verifies only literal IPv4 `127.0.0.1`; production
composition always requests ephemeral port `0`. Wildcard, IPv6-any, LAN,
environment, CLI, and caller-selected binding are structurally absent. The
descriptor is published only after bind/address verification. Teardown removes
only the exact owned descriptor and lock.

The complete Stage 20A authority is:

| Method | Path | Authentication | Checkpoint |
| --- | --- | --- | --- |
| `GET` | `/v1/health` | none; supplied Authorization refuses | C4 |
| `GET` | `/v1/session` | exact bearer | C4 |
| `GET` | `/v1/projections/health` | exact bearer | C5 |
| `GET` | `/v1/projections/usage.policyConstants` | exact bearer | C5 |
| `GET` | `/v1/projections/usage.profiles?profileId=...` | exact bearer | C5 |
| `GET` | `/v1/projections/routing.latest?taskId=...` | exact bearer | C5 |

The totals are six GET routes and zero commands. There is no POST, PUT, PATCH,
DELETE, effectful OPTIONS, `usage.refresh`, or mode-dependent authority.
Normal and Developer inventories are byte-identical and
`productionEnabled` is always false.

Authentication refuses missing, duplicate, alternate-case, malformed, or
oversized Authorization input without echo. Any supplied Origin refuses; the
fixed allowlist is empty and no CORS reflection or credentialed origin exists.
Finite owned limits cover parser and owned headers, URL/query components,
body, structural JSON, concurrency, session rate, deadline, response size,
and requests per socket. Bodies, media types, encoded URLs, duplicate/unknown
queries, protocol upgrades, CONNECT, Expect, unsupported methods, and missing
or duplicate Host receive finite owned refusals without attacker prose,
headers, stack traces, paths, or Fastify internals.

## C5 projection truth and leakage boundary

C5 consumes only one strictly parsed, bounded, injected in-memory dataset. It
cannot read installed account state, a credential or vault, providers, real
profiles, repositories, tasks, agents, or scheduler commands. Separate Normal
and Developer allowlist schemas cover every field; recursive comparison proves
Normal is a strict subset while shared facts remain equal. Presentation is
fixed at composition and cannot be selected by request input.

Health reports the finite service-process facts, `dispatchPaused:false`, and
`estopAvailability:not-implemented`. There is no recovery sweep, so service
startup remains fresh with zero recovery counts. Client-attachment bootstrap
is separate: fresh carries zero stopped-by-restart; adopted carries only the
authenticated existing listener's bounded current running-session count.
`recovery-in-progress` is refused.

Usage preserves active, inactive, stale, and unavailable as separate states;
inactive and unavailable remain null rather than becoming zero. Ambiguous
authorization, unknown revocation, stale/unavailable evidence, future or
expired evidence, and invalid reset relationships fail closed. Snapshot
`observedAt` must not exceed record `computedAt`, which must not exceed served
`serverNow`. All ten freshness rule IDs and both cap IDs are reachable. The
served policy constants match the scheduler: schema 3, `Europe/London`,
weekday half-open `[09:00,17:00)`, a 5,000-basis-point borrowed five-hour cap
inside that interval, and a 7,000-basis-point borrowed weekly cap always.
Only outstanding reserved/reconciliation-required predictions count. Current
usage at cap and projected usage over cap refuse; projected equality is
allowed. Policy evaluation uses served `serverNow`, never local clock.

The stored-routing projection accepts only a coherent already-selected
scheduler decision with exact top-level rule `route.deterministic-selection`,
positive usage/ownership reasons, and no denial rule. An unprojected workload
class preserves the scheduler borrowed-Fable invariant: either a borrowed
Fable workload or borrowed Fable agent refuses. C16 outcomes, forecasts,
wait/reroute/ask/refuse states, and project-spine fields do not exist here.

Both audiences exclude bearer/token/digest material, Authorization headers,
credentials, owner identity, paths, `sourceFingerprint`, generic fingerprints,
hashes, opaque handles, cross-profile reservations, model prose, raw provider
or network wording, stack traces, and unallowlisted mechanism vocabulary.
A genuine unprefixed 43-character service-bearer shape is refused centrally
from every identifier source before either presentation. The complete Normal
route corpus passes the leakage patterns, and planted leak controls are
detected.

## Independent review history

The first frozen C4 candidate was independently reviewed before C5. Its
findings drove the `eb31f76` repair, including same-socket/no-reconnect
adoption, one absolute deadline, stronger exact artifact mutation ownership,
and finite malformed-request controls. The repaired C4 candidate passed with
zero must-fix findings before C5 began; that verdict was not transferred to C5.

C5 review history is intentionally retained:

1. `384f082` returned FAIL with four must-fix findings: presentation-unbound
   adoption; incomplete adopted W3 evidence plus unsupported recovery state;
   denial/contradiction-bearing selected routes; and inaccurate cap/authority
   copy.
2. `286d755` closed those four. Its focused C4 review passed, while C5 returned
   FAIL with two must-fix findings: a real unprefixed service bearer could pass
   as an identifier, and impossible borrowed-Fable stored selection was
   accepted.
3. `8765a46` closed those two and returned FAIL with two temporal findings:
   usage observation could postdate computation, and the adopted count bypassed
   stale/future health evidence.
4. Exact source `9a7d03ee6ed0ab9212f336d54d7eb6b7bac572b2`, tree
   `d2498883a9db16920cad9b5fd0803467b8f6f40b`, received a fresh complete C5
   truth/privacy review and focused changed-session C4 security review. Both
   verdicts were PASS with zero must-fix findings. Review began and ended with
   the exact identity and an empty staged, unstaged, and untracked path set.
5. Exact test-infrastructure repair
   `82eb99af2ecdd83e6b218c9c04686d9b1274380d`, tree
   `9394deaada3a4dbeec978774d070aa93fc04b917`, received a fresh focused C4
   security and C5 truth/privacy review. It passed with zero must-fix findings.
   The reviewer verified the unchanged production source tree, reran all
   changed suites, exercised linked-root and linked-ancestor controls, found
   zero matching temporary-root residue, and began and ended on the exact clean
   identity.
6. Exact credential-smoke repair
   `83c72a06c1e2e446938c8e512ebaf5f296dae47a`, tree
   `aa5b461cacf5ac1144bb3e66614b79cb168842ba`, received a fresh focused
   security/authority and leakage/privacy review. It passed with zero must-fix
   findings. The reviewer independently confirmed the date-boundary diagnosis,
   unchanged Stage 20 and credential production trees, time-zone/DST-safe epoch
   arithmetic, bounded one-hour synthetic authorization, unchanged one-shot
   controls, and excluded `dist/testing` payload. Review began clean at the
   exact identity. Its global end-state check saw only this root-owned
   checkpoint edit, made concurrently after review began; the three reviewed
   paths and index remained clean. The terminal handoff therefore supplies a
   fresh clean final-head reconciliation rather than suppressing that evidence.

Six non-blocking advisories remain:

1. `static-policy.test.ts` manually enumerates source files and uses lexical
   import detection. Its planted controls work and manual inspection found no
   forbidden current import. A future maintenance change should derive the
   production module closure and parse import syntax robustly.
2. The canonical-temporary-root regression detector is positive-controlled but
   lexical and scans direct `*.test.ts` files. Aliased expressions, nested
   fixtures, or alternate syntax could evade it; a future structural lint rule
   would be stronger.
3. If post-creation identity validation itself fails, the test helper refuses
   before returning the path and can leave one empty bounded owned directory.
   This is deliberately safer than recursively deleting a path whose identity
   was not proved; future identity-bound cleanup could improve hygiene.
4. The focused smoke-clock unit test proves exact alignment and authorization
   window arithmetic, while the maintained real Electron smoke remains the
   end-to-end renderer-freshness regression. The unit test title could state
   that narrower role more literally.
5. The smoke-clock helper rejects non-finite timestamps but does not separately
   reject finite values outside JavaScript's representable `Date` range. Its
   inputs are constrained to `Date.now()` and existing valid `Date` values, so
   this is unreachable in the reviewed harness; an explicit range check would
   make the helper independently total.
6. The pre-existing explicit future-time presentation scenario uses
   `2099-01-01`. It is safely beyond current CI time but is not indefinitely
   calendar-proof.

None of these advisories widens current runtime authority.

## Guard-removal assurance

After the final source review, each following guard was weakened temporarily,
one at a time. Its named focused test exited nonzero, the exact reverse patch
was applied, the edited file's Git blob hash matched its pre-mutation value,
and `git status --porcelain=v1 --untracked-files=all` returned empty before the
next mutation. No mutated listener using a wildcard host was launched.

| Removed or weakened guard | Focused detector result |
| --- | --- |
| literal-loopback bind | static wildcard test failed |
| bearer withheld from the health probe | nonce-mismatch hostile listener captured the planted early bearer |
| health nonce equality | hostile listener received an impermissible second authenticated read |
| single private socket/no reconnect | replacement listener captured the planted bearer |
| ambiguous liveness refusal regardless of age | old ambiguous owner was incorrectly replaced and the test failed |
| exact live-owner artifact match | PID-reuse/foreign owner was incorrectly adopted and the test failed |
| empty supplied-Origin policy | single supplied Origin incorrectly reached success and the test failed |
| GET-only method gate | POST changed from the required method refusal and the test failed |
| owned header-value limit | oversized owned header incorrectly passed and the test failed |
| exact six-route inventory | planted seventh route was detected |
| empty command registry | planted `usage.refresh` command was detected |
| exact-key record parsing | an extra descriptor field was accepted and the test failed |
| real service-bearer identifier refusal | the genuine bearer-shaped corpus escaped refusal and the test failed |
| same-profile reservation binding | a cross-profile reservation escaped refusal and the test failed |
| inactive null preservation | inactive usage was converted to zero and the test failed |
| server-owned policy time | local-clock evaluation broke the clock-skew test |
| fingerprint field prohibition | a planted `sourceFingerprint` projection was rejected by the schema detector |
| descriptor/requested presentation binding | mismatched presentation opened transport and the zero-call test failed |
| selected-route denial-rule exclusion | a planted denial family escaped refusal and the test failed |
| borrowed-Fable invariant | an impossible borrowed-Fable selection escaped refusal and the test failed |
| usage `observedAt <= computedAt` | impossible temporal usage was accepted and the test failed |
| current/non-future running-session source | future session evidence was accepted and the test failed |
| adoption evidence `computedAt <= serverNow` | future authenticated session evidence was accepted and the test failed |
| canonical disposable-root fixture policy | a planted raw `mkdtemp(join(tmpdir(), ...))` expression was detected |

The planted bearer and source-fingerprint checks cover the required
token-projected/leakage positive controls without writing a real credential or
contacting installed state.

## Deterministic validation evidence

On exact reviewed source `9a7d03e`, before the first documentation-only delta:

- control-service typecheck passed;
- all 12 control-service test files passed, 103 tests total;
- control-service coverage passed unchanged floors at 90.57% statements
  (1,125/1,242), 84.49% branches (725/858), 98.97% functions (194/196), and
  94.31% lines (1,012/1,073); and
- `git diff --check` and exact clean-state checks passed.

The first published documentation candidate was
`b5ec145091503a74cb5ee56da37f6e5a6a2b4a23`. Exact-head hosted CI run
`33225936595`, attempt `1`, completed five jobs successfully and failed the
Windows coverage and Windows check jobs. This was not treated as an
infrastructure flake and no unchanged-head rerun was used. All 50 failing
control-service tests derived their storage root from the ambient
`mkdtemp(join(tmpdir(), ...))` spelling. On that hosted runner the supplied
spelling differed from `realpath(root)`, so the unchanged production artifact
store correctly returned its finite `STORAGE_UNSAFE` refusal.

Repair `82eb99a` now resolves the ambient temporary directory to its canonical
spelling before creating each owned fixture root. It then verifies that the
new root is a direct non-linked directory whose supplied spelling already
equals its real path. The production artifact store still rejects symlink,
junction, reparse, UNC, device, alternate-stream, and non-canonical roots.
Focused package testing passed 13 files and 105 tests; package coverage retained
90.57% statements (1,125/1,242), 84.49% branches (725/858), 98.97% functions
(194/196), and 94.31% lines (1,012/1,073). Root `npm run check` also passed on
exact repair `82eb99a` before this documentation-only publication delta.

The next documentation candidate was
`6be5c2d1825aba8387d8a6e53181fff34ef0909f`. Exact-head hosted CI run
`33228733074`, attempt `1`, completed PostgreSQL integration, packed consumer
on Windows, dependency audit, coverage, Ubuntu check, and packed credential
host on Windows successfully. The Windows check job passed install, the full
root check (including all 105 control-service tests), the Stage 18 descendant
verifier, Windows native shape, and application-vault Electron smoke, then
failed only the maintained credential-host Electron smoke at
`in-flight-started`. No unchanged-head rerun was used.

The same smoke failed locally with `SMOKE_RENDER_TIMEOUT` after its one-shot
marker had been consumed and its complete validation in-flight lock assertion
had passed. The post-result predicate still required a `Validated` badge. The
synthetic host and authorization packet were permanently dated 20 August 2026,
while renderer freshness deliberately uses the current browser time and turns
accepted results into `Check needed` after seven days. Thus the fixture crossed
its real seven-day boundary on 27 August; no Stage 20 source or hosted runner
behaviour caused the failure.

Test-only repair `83c72a0` captures the smoke start once, advances each
synthetic host clock to that instant, and derives the synthetic one-hour
authorization window from that same clock. It does not relax the unchanged
post-result assertion, freshness rule, one-shot marker, authorization gate,
provider-dispatch prohibition, or production-disabled boundary. A focused
regression advances the former fixture beyond seven days and verifies exact
alignment plus the bounded authorization window. The focused regression passed
2 tests, the complete credential-setup suite passed 23 files and 299 tests, and
the real default/reduced/forced Electron smoke passed 71/2/4 assertions both
through direct pre-commit compilation and through the standard clean-candidate
build path.

The final documentation commit is subjected again to package typecheck/tests/
coverage, affected workspace and root checks, root coverage, audit, complete
dependency inspection, dry pack, maintained packed-consumer gates, the Stage
18 descendant verifier, JSON/Markdown/local-link validation, leakage and
secret-shape scans, listener/process residue inspection, `git diff --check`,
and clean-state verification. The final handoff records those actual outcomes,
the dry-pack identity, and the exact hosted seven-job run after they exist.

## Nonclaims and next checkpoint

Node mode bits do not prove a Windows DACL. This package is not a boundary
against a hostile same-user process. Node alone cannot prove PID creation
identity across every reuse race or parent-directory deletion durability on
Windows. No Windows Service, startup entry, scheduled task, elevation, provider
call, credential/vault/account read, real task/agent execution, repository
mutation through the API, production dispatch, PR, merge, tag, or release was
performed.

The smallest safe next product checkpoint after exact-head publication is a
separately authorized Stage 20B design/implementation entry. It must not infer
command, approval, pause/kill, emergency-stop, or production authority from
this read-only checkpoint.
