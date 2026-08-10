# AI Account Manager static usage-integration investigation

Status: complete commit-pinned static investigation for the Stage 18C checkpoint
Investigation date: 2026-08-10
Execution boundary: read-only source and document inspection only

## Decision

The reviewed AI Account Manager revision does not expose a supported external
library, API, database schema, or body-free export suitable for direct
integration. Its useful account and quota observations are reached through an
internal Electron IPC surface, direct credential/OAuth handling, provider
HTTP calls, or a spawned local `codex app-server`. Adopting any of those paths
would cross the authorization boundary for this checkpoint and would couple AI
Development OS to compiled application internals.

Stage 18C therefore implements only a fixture-backed, versioned protocol. It
accepts one opaque scoped profile and provider-authoritative five-hour/weekly
observation at a time, binds it to this exact upstream identity, and normalizes
it into the existing scheduler `UsageSnapshotAdapter`. The repository bundles
no reader that launches or queries Account Manager, Codex, Claude, a browser,
or an installed account. Its fixture reader is still a caller-supplied
executable callback, and `fixtureOnly: true` is an asserted protocol field—not
a capability sandbox. A future live adapter requires a separately reviewed,
supported body-free interface and separate credential/account authorization.

## Method and authority boundary

The repository was cloned to a task-owned analysis directory outside AI
Development OS. All 23 tracked files were inspected. The application, setup,
build, tests, package manager, Electron runtime, Codex process, provider
endpoints, and credential paths were not executed. No dependencies were
installed, no installed UI was scraped, no credential/session file was read,
and no account/provider request was made. The clone remains clean.

The two-page `assets/USAGE_TRACKING_GUIDE.pdf` was extracted, rendered, and
visually checked as a static source document. Both pages rendered legibly with
no observed clipping or overlap. The document explains user-facing usage
tracking; it is not a versioned integration contract.

## Pinned source identity

| Field                        | Exact value                                                        |
| ---------------------------- | ------------------------------------------------------------------ |
| Repository                   | `https://github.com/alijabbar04/ai-account-manager.git`            |
| Default branch               | `main`                                                             |
| Commit                       | `99be1cc6fa0fbbcfffcb4b7042d9bf0bf5ae0ae0`                         |
| Tree                         | `49eb2f93f3012836b9a88ac705de8a9df1e8646f`                         |
| Declared application version | `1.4.1`                                                            |
| Tracked files                | 23                                                                 |
| Submodules                   | none                                                               |
| Git LFS pointers             | none                                                               |
| Tags at the commit           | none                                                               |
| Checkout state               | clean, `main...origin/main`                                        |
| Checkout inventory SHA-256   | `1898a7fdbe6236828d6bfac7b6064e94fe65a3859d56ae5fff86061906f129ff` |

The inventory digest is SHA-256 over path-sorted UTF-8 rows of
`path<TAB>checked-out-byte-count<TAB>file-sha256<LF>`. Byte counts and hashes
therefore bind the exact Windows checkout, including its checked-out line
endings, while the commit/tree bind canonical Git content.

## Complete tracked-file inventory

| Path                                  |   Bytes | SHA-256                                                            |
| ------------------------------------- | ------: | ------------------------------------------------------------------ |
| `.github/workflows/release.yml`       |   1,053 | `5565377203bd1a2454c0507c88b006e15304442aabe22d51d9f8bf7fde0bafdf` |
| `.gitignore`                          |   2,577 | `4b3bda2bcbd6e1e01a89d036ebcd387ab6e119b620a8f9919204dcfe22243e51` |
| `LICENSE`                             |   1,109 | `19d0d604a83f35ac175ab46edcb33bab4fed5c6790e58829fbc5487607660385` |
| `README.md`                           |  11,383 | `057d9d7e19e05263a1e4bb22ad97e1fb0e6b7ed6965f637157bf6609d34a7ff9` |
| `app/dist-electron/guide-viewer.html` |   2,494 | `3771907c42c792446e9adb6a4d5b5a250130fafb63202fcd4af06dbbe0a02deb` |
| `app/dist-electron/main.cjs`          | 111,302 | `dbf38a43faf0c7482e94260feef827e881187908fe7baffa66d47579dcbc5a0d` |
| `app/dist-electron/preload.cjs`       |   4,499 | `18d71c941f1c95eb84ed866a7164a6dd74c18aee15c259f70870f04ea91e45c5` |
| `app/dist/assets/index-CfQCNBzk.js`   | 509,000 | `03086834aa794fc82b90b1bfc651cfdd16ca56e71f0204d7e08a542a80d51d7c` |
| `app/dist/assets/index-DR09S7BQ.css`  |  36,304 | `215ca946643d68bfdc4011c252e835c89fc16176c2ed947bd9e47a88a108a393` |
| `app/dist/index.html`                 |     665 | `e064a7a8a45108283fb593d3a396133a2577b754de695443ee866554483371d0` |
| `app/package.json`                    |     458 | `b42992909a404fe1197602b8f3647c227334fcca0c46bd58db2aba41a3b2b8c6` |
| `assets/USAGE_TRACKING_GUIDE.pdf`     | 115,282 | `ef0ea7abd28c6ba6e7ca2048c81dc36da1ca9be4ae3e0dcda45eb6f8f88eb276` |
| `build/build.ps1`                     |   3,801 | `b67b93573637887258a928cb3e9828e428b6345d72383bd3940b6483d7d9d1c8` |
| `build/icon.ico`                      |   5,533 | `a1dd74dbc1f04bd4a56117404bbc10fbc2852e8600f5eeb500be5ec9b3f1bcd4` |
| `docs/INSTALL.md`                     |   9,159 | `07a643b2701cdd57a1d2c91ca3b9e8587ac824ffe3f3979bf3e9790921a61ab3` |
| `docs/TROUBLESHOOTING.md`             |  13,992 | `b0cc5939755aa420d6e60e84aac3ba3a71302e92f2d5e603bb39f78c1572c83c` |
| `package.json`                        |   1,894 | `0db7935f94c39f105e07ce2b4d3a45e6d05d942687a15bc422f3b8e50095b904` |
| `release/latest.example.json`         |     324 | `906084e795c31169e6b07e1ec17883648d90d151b65e553a14293adf850cb007` |
| `scripts/lib.cjs`                     |   1,695 | `3840a62376deda6ca7dd55bbfb20c31b8b52f32177535ad5192778ee3a8c71ec` |
| `scripts/make-manifest.cjs`           |   1,238 | `50564069c748542ad354ba75ff19d76062891b423a4e71680529fa765a9a55e3` |
| `scripts/verify-runtime.cjs`          |   2,080 | `ce50db1958f6207a3d1b8b420cb16384d20782fd78c2829887bb4192d3b2b9bd` |
| `setup.ps1`                           |   5,137 | `f0adc8adfd7e660e1ac5f7a3cc4180442e017bac6bd3b779e9383b9ab16d44f7` |
| `tests/runtime.test.cjs`              |   1,258 | `4f70daf0cef9468bac4e75bffae9c24bef1347474238751cffcf5db8f1e0f927` |

## License, dependencies, and operating assumptions

The repository and nested application manifest declare the MIT license. Reuse
is permitted subject to preserving the license/copyright notice. Stage 18C
copies no upstream runtime code; it records only source identity and defines an
independent protocol, so there is no embedded third-party implementation to
attribute in the package.

The root manifest is private and declares `react`/`react-dom` `^19.1.0`, with
development ranges `electron` `^37.2.6`, `electron-builder` `^26.0.12`, and
`prettier` `^3.6.2`. The nested private application repeats React 19.1 ranges.
There is no lockfile, so the dependency graph is not reproducibly pinned by
the reviewed tree. Packaging is Windows x64 NSIS/Electron with a Windows icon,
optional install directory, and the usage PDF as an extra resource.

The repository contains formatted/compiled Electron main, preload, renderer,
HTML/CSS, scripts, and tests, but not the original TypeScript/React source tree
named by comments in the compiled output. The compiled runtime is therefore
the reviewable source of record for behavior at this commit, which raises
maintenance and compatibility risk for any internal integration.

## Static source anchors

The following anchors refer to the exact checked-out bytes bound by the commit,
tree, per-file hash, and inventory digest above. They let a reviewer reproduce
the load-bearing behavioral conclusions without executing the application:

| Finding                                                                        | Pinned relative path and line region             | Stable symbol/string anchors                                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Claude credential refresh and atomic rewrite                                   | `app/dist-electron/main.cjs:770-835`             | `writeCreds`, `getValidAccessToken`, `grant_type: "refresh_token"`                                          |
| Anthropic usage fetch, five-hour/seven-day mapping, and stale-on-failure cache | `app/dist-electron/main.cjs:838-946`             | `USAGE_ENDPOINT`, `UsageService.refresh`, `raw.five_hour`, `raw.seven_day`, `failed`                        |
| Codex App Server process and account/rate-limit/usage RPC                      | `app/dist-electron/main.cjs:2470-2590`           | `spawn(codexExecutable(), ["app-server"])`, `account/read`, `account/rateLimits/read`, `account/usage/read` |
| Polling and focus refresh cadence                                              | `app/dist-electron/main.cjs:2763-2766,2826-2865` | `POLL_INTERVAL_MS`, `FOCUS_REFRESH_MIN_GAP_MS`, `Backend.init`, `browser-window-focus`                      |
| Local JSON paths, API-key vault, encrypted secret operations, and snapshot history | `app/dist-electron/main.cjs:60-100,1515-1717` | `appDataDir`, `apiKeysFile`, `apiKeyVaultFile`, `safeStorage.encryptString`, `appendSnapshot`               |
| Provider API-key analytics and credentialed provider endpoints                 | `app/dist-electron/main.cjs:950-1492,1722-2230`  | `ADAPTERS`, `safeFetch`, `cost_report`, `organization/usage`, `ApiService`, `readLocalLedger`                |
| Renderer preload/IPC surface for usage, launch, and API-key operations          | `app/dist-electron/preload.cjs:3-116`; `app/dist-electron/main.cjs:3108-3178` | `contextBridge.exposeInMainWorld`, `usage:refresh`, `gpt:usage`, `apikeys:list`, `apikeys:validate` |

## Data-flow findings

### Claude profiles and five-hour/weekly usage

The main process discovers local profile configuration and reads a Claude
credential structure. Its usage service may refresh and rewrite OAuth material
and sends the resulting access token to an Anthropic usage endpoint. A
successful response maps provider five-hour and seven-day utilization plus
reset timestamps into local limits and stamps `fetchedAt`.

Those successful utilization/reset fields are provider-authoritative at the
instant fetched. They are not an authorization grant for another process. On
failure, the service deliberately retains previous limits and their previous
`fetchedAt` while marking the new snapshot failed. That is cached stale data,
not current provider authority. The runtime does not expose an explicit
fresh-until time, provider-defined stable window ID, configured timezone,
revocation class, or scoped third-party authorization suitable for dispatch.

Local activity history and derived token/time aggregates are locally observed
or calculated, not quota authority. Display identity includes account fields
such as email and plan metadata; those are unnecessary and unsafe for the AI
Development OS usage contract.

### GPT/Codex account usage

The main process resolves and spawns a local `codex app-server`, initializes a
JSON-RPC session, and requests `account/read`, `account/rateLimits/read`, and
`account/usage/read`. The result includes account identity and rate-limit/usage
data and is stamped with local fetch time. This is a live signed-in account
operation and a process effect. It was not invoked in this investigation and
is not a reusable in-process library or supported external service contract.

### API-key analytics

The application also supports provider API-key analytics, local encrypted key
storage, provider-specific balance/usage endpoints, histories, and derived
runway data. Exact organization reports can be authoritative for their own
scope; histories and forecasts are cached/calculated. This surface requires
credential handling and broader provider authority and is outside the
profile-window adapter selected for Stage 18C.

### Cadence and errors

The compiled coordinator polls profile usage and GPT usage every five minutes,
allows manual refresh, and refreshes after focus with a minimum 30-second gap.
Errors are turned into UI-facing strings. Claude fetch failures can retain old
limits, and GPT methods can return partial rate-limit/usage results with a
warning. Consequently, presence of a displayed percentage is not proof of
freshness or completeness.

## Available surfaces and suitability

| Surface                        | Observation                                                        | Adapter decision                                                               |
| ------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Electron preload/IPC           | Renderer-only methods such as usage get/refresh and GPT usage      | Internal UI boundary; not a supported external API; reject                     |
| Local JSON state               | Profiles, snapshots, settings, histories, API-key records          | Unversioned internal storage; may include sensitive/cross-profile data; reject |
| Claude OAuth/provider path     | Reads and can update credential state, then calls provider         | Credential/network authority outside this task; reject                         |
| `codex app-server` JSON-RPC    | Account/rate-limit/usage reads through a spawned signed-in process | Live account/process operation requiring separate authorization; reject        |
| Provider API-key analytics     | Direct credentialed provider endpoints                             | Different ownership and scope model; reject                                    |
| Original source/library export | No original library package or documented external module          | unavailable                                                                    |
| Body-free versioned export     | None present                                                       | fixture-backed protocol only                                                   |

## Required normalization and fail-closed rules

The Stage 18C fixture protocol intentionally requires facts the upstream UI
does not reliably supply as an external contract:

- one opaque local profile ID bound to the requested scope;
- exact provider and ownership class;
- explicit authorization and revocation classes;
- provider-authoritative/high-confidence provenance;
- `Europe/London` timezone;
- observation and source-declared freshness times;
- distinct provider-defined five-hour and weekly window IDs;
- used/remaining basis points totaling exactly 10,000 and future reset times;
- this repository URL, commit, tree, runtime version, and inventory digest; and
- no email, credential, cookie, token, session, provider body, raw error, or
  unrelated profile data.

Missing, duplicate, malformed, partial, stale, future, estimated, cached,
contradictory, unauthorized, revoked, ambiguous, or cross-profile observations
remain representable for audit only where safe and are refused for dispatch by
the scheduler. Reader failures are collapsed to finite redacted application
errors.

## Compatibility risks and future admission criteria

- The internal IPC, JSON files, compiled symbol layout, provider endpoints,
  and Codex App Server calls are not declared external compatibility promises.
- A semver-looking application version does not version any integration
  protocol used here.
- Dependency ranges and the missing lockfile make a rebuilt upstream artifact
  non-identical without further pinning.
- Cached failure behavior can make displayed data look useful after provider
  freshness has expired.
- Provider/account ownership and permission to display a profile do not imply
  authorization for AI Development OS to dispatch work against it.
- A future live adapter must use a supported, authenticated, read-only,
  body-free interface; prove stable profile/window identities, freshness,
  timezone, authorization, revocation, and error semantics; isolate profiles;
  and undergo a new source/version/security review.

This investigation makes no claim that Account Manager is unsafe for its own
documented UI purpose. It concludes only that commit `99be1cc...` does not
provide the supported least-authority integration seam required by this
checkpoint.
