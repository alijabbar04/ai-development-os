# AI Development OS Implementation Roadmap

Status: Active  
Last updated: 2026-08-11

## Delivery rule

Implementation proceeds one dependency-ordered module at a time. A module advances only when its public contract, failure behavior, tests, type check, production build, and relevant security checks pass. The main branch must remain buildable between modules. External-provider tests use deterministic fakes in normal CI and budget-capped live canaries outside pull-request CI.

## Status legend

| Status | Meaning |
| --- | --- |
| Complete | Acceptance gate passes and deliverables are committed |
| In progress | Current implementation slice |
| Planned | Contract is identified but implementation has not started |
| Gated | Requires a prior security, credential, platform, or product decision |
| Deferred | Deliberately outside the current release target and assigned to a later track |

Release plans use the taxonomy in
[ADR 0019](adr/0019-windows-first-production-scope.md): implemented, measured,
verified, supported target, deferred/non-target, and unavailable are independent
states. A supported target is not automatically available, and a deferred
platform is never represented as passing.

## Stage 0: Repository foundation

Status: Complete in the initial delivery.

Deliverables:

- npm workspace with strict shared TypeScript configuration.
- Reproducible lockfile and workspace-level `build`, `test`, `typecheck`, and `check` commands.
- Technical design, dependency direction, roadmap, and contribution conventions.
- CI skeleton for Windows, Linux, dependency audit, and test artifacts; repository-host secret scanning is a required project setting.

Exit criteria:

- A clean checkout installs with `npm ci`.
- `npm run check` is the single local quality gate.
- No production provider or repository side effect is enabled by scaffolding.

## Stage 1: Task-graph domain kernel

Status: Complete in the initial delivery.

Package: `@ai-dev-os/task-graph`

Deliverables:

- Versioned JSON snapshot contract for run graphs and task nodes.
- Atomic batch task creation and dependency mutation during planning.
- Topology sealing, cycle detection, deterministic topological order, and ready ordering.
- Explicit legal state transitions for pending, ready, running, waiting, resolution, success, failure, cancellation, and blockage.
- Recursive dependency failure/cancellation propagation.
- Optimistic version checks and ordered, transaction-acknowledged domain events.
- Enforced limits of 10,000 tasks, 256 dependencies per task, 100,000 edges, depth 128, and 1,000 output artifacts per task.
- Defensive hydration with runtime validation and no partial mutation on invalid commands.

Tests:

- Unit coverage for every command and legal/illegal transition.
- Atomicity tests for duplicate, missing, self, and cyclic dependencies.
- Snapshot round-trip and hostile/malformed snapshot tests.
- Deterministic ready and topological ordering tests.
- Failure, cancellation, and graph outcome propagation tests.
- Event sequence and optimistic concurrency tests.

Exit criteria:

- Package has no runtime dependencies or I/O.
- Public exports compile to ESM with declarations.
- Tests, type check, build, and package tarball inspection pass.
- The aggregate cannot represent a cyclic or internally inconsistent hydrated graph.

## Stage 2: Core value objects and artifact contracts

Status: Complete.

Packages: `@ai-dev-os/domain`, `@ai-dev-os/artifacts`

Delivered:

- Branded project, run, task, task-run (attempt), lease, artifact, approval, event, agent, provider, model, workspace, and trace IDs with one canonical format and runtime guards.
- Integer-micro money with checked exact arithmetic, disjoint token categories, millisecond durations, hard/soft token/monetary/time budgets, and an immutable budget-reservation state machine (reserve, commit, release, cancel, account cancellation) with idempotent replay, optimistic versioning, and structured `BudgetDecision`/`BudgetExceededError` outcomes.
- Estimated-versus-actual usage records and exact ledger aggregation across task, run, and project scopes.
- Five-level data classification with floor-enforcing `DataHandlingPolicy`, deterministic provider-neutral disclosure/eligibility evaluation producing structured decisions (reasons, required redactions, required approvals, audit rule codes), and routing question helpers.
- Provider-neutral `ModelCapabilities`/`ModelRequirements` matching with `UnsupportedCapabilityError` and exact BigInt cost estimation from micro-unit-per-million-token pricing.
- Typed artifact descriptors with digests, safe display names, explicit storage locations, traversal-safe relative paths (Windows device names, control characters, UNC, and drive letters rejected), provenance, classification, bounded unique parent references, and task-run manifests. No free-form metadata maps.
- Structured domain error hierarchy (validation, invariant, serialization, budget, policy, capability, concurrency) whose messages and details never echo raw input values.
- Deterministic canonical JSON serialization, prototype-pollution-safe parsing, and `schemaVersion`-checked hydration for every persisted aggregate.
- Shared zero-dependency validation toolkit exported as the documented `validation` namespace; the minimal internal validator was chosen over adding a validation library to keep the domain layer dependency-free and consistent with `@ai-dev-os/task-graph` (decision recorded in the package README).

Tests and gate (passing):

- 143 tests across both packages: hostile-input, boundary-value, state-transition, serialization round-trip, policy decision, path-safety, deterministic-output, and seeded pseudo-random arithmetic sweeps proving money arithmetic cannot silently overflow or use floating-point currency.
- Coverage gates met (domain 97.8% statements / 92.5% branches; artifacts 100% statements / 98.1% branches) at the repository thresholds.
- Zero runtime dependencies in `@ai-dev-os/domain`; `@ai-dev-os/artifacts` depends only on `@ai-dev-os/domain`. No provider, UI, or I/O dependency enters either package.
- `npm run check`, `npm run test:coverage`, `npm audit`, package dry-run inspection, and a consumer-style smoke test against packed tarballs all pass.

## Stage 3: Persistence and event journal

Status: Complete.

Packages: `@ai-dev-os/persistence`, `@ai-dev-os/persistence-memory`, `@ai-dev-os/persistence-sqlite`

Delivered:

- Provider-neutral persistence ports: a generic versioned aggregate store (closed aggregate-type union covering projects, task graphs, task runs, budget accounts, and artifact manifests; later stages extend the union as their aggregates land), an append-only event journal with strictly increasing global sequences and occurred/recorded time separation, a transactional outbox with exclusive leasing (claim, acknowledge, retry, dead-letter, idempotent re-acknowledgement, duplicate-idempotency-key rejection), and immutable artifact descriptor/manifest metadata validated on write and read.
- Envelopes carry aggregate id/type, payload schema version, optimistic aggregate version, canonical payload, sha-256 checksum over canonical bytes, created/updated timestamps, and trace/causation correlation ids. Reads re-verify checksums and fail structurally on corruption without leaking payload contents.
- Single `transact` unit-of-work: aggregate update, event append, and outbox insert are atomic; rollbacks leave no partial state and preserve the caller's error; nested transactions, use-after-completion, and use-after-close are structured failures; retries cannot duplicate events or outbox messages.
- Strict optimistic concurrency: create requires absence (version 1), update requires the exact current version (stores +1); no last-write-wins path exists.
- Deterministic keyset pagination (opaque validated cursors, id/sequence tie-breakers) for every listing; malformed cursors are structured errors.
- Pure migration planner (ordered checksummed ids, duplicate/out-of-order/checksum-mismatch/schema-too-new rejection) plus SQLite migrations applied transactionally with clean recovery after a failed migration.
- In-memory reference adapter that is semantically identical to SQLite (snapshot-rollback transactions, explicit counters, checksum verification, deterministic ordering) with test-only corruption injection.
- SQLite adapter on better-sqlite3 v12 (decision and alternatives documented in the package README): STRICT tables, WAL + NORMAL for file databases, foreign keys on, busy timeout, prepared statements everywhere, driver errors translated to stable persistence errors, raw connection never exposed, absolute-path validation.
- Reusable adapter contract suite exported at `@ai-dev-os/persistence/testing`, executed against the memory adapter and SQLite in both :memory: and file-backed modes.
- Injected clock and caller-supplied ids everywhere; lease expiry tested by advancing a manual clock, no sleeps; structured operation observer hooks for later metrics.

Tests and gate (passing):

- 161 Stage 3 tests (repository total 351) including hostile-input, corruption/checksum-substitution, outbox state-machine, lease-expiry/reclaim, concurrent-claim, pagination-under-mutation, migration-tampering, failed-migration recovery, and file-backed write→close→reopen verification.
- Contract suite passes for the in-memory adapter and both SQLite modes; coverage gates met in all three packages (persistence 98.9% statements, memory 99.6%, sqlite 97.0%).
- `npm ci` clean install, `npm run check`, coverage, `npm audit` (0 vulnerabilities), package dry-runs, and a consumer smoke test against packed tarballs all pass on Windows; CI runs the identical commands on Linux.

Deferred within Stage 3 scope: leases/usage/routing/approvals/memories/cache ports arrive with their owning stages (the generic aggregate store and event journal are their foundation); backup metadata moves to the artifact-store/hardening stages; restart-crash simulation between persistence steps lands with the Stage 12 scheduler that drives those sequences.

## Stage 4: Content-addressed artifact store

Status: Complete.

Packages: `@ai-dev-os/artifact-store`, `@ai-dev-os/artifact-store-local`

Delivered:

- Provider-neutral byte-store port (`AsyncIterable<Uint8Array>` streams, validated chunks, mandatory bounds on all in-memory buffering) with structured errors, plus a reusable adapter contract suite at `@ai-dev-os/artifact-store/testing`.
- Local content-addressed storage at `v1/<algorithm>/<prefix>/<digest>` where every path component is a fixed literal or validated lowercase hex — no user-controlled filenames, traversal, UNC/drive injection, or cross-algorithm collisions; layout is versioned for future migration.
- Streaming write protocol: exclusive-create temp files with injected entropy, incremental digest and byte counting (source metadata never trusted), live maximum-size enforcement, fsync-by-default durability with a documented `fast` mode, expected digest/size validation, realpath containment checks against symlink/junction escape, atomic rename promotion, concurrent-writer-safe deduplication, and guaranteed temp cleanup on failure. Partially written objects are never visible.
- Verified reads (corruption reported structurally at stream completion, never silently repaired), exact stat, existence checks, full integrity verification, deterministic locations, and digest-keyed idempotent deletion.
- Bounded stale-temp cleanup restricted to the store's own strict temp format, driven by an injected clock, with per-file failures reported rather than thrown.
- Transformation boundary producing new content objects (sources immutable) with an explicitly-rule-based literal redaction transform that matches UTF-8 byte sequences across chunk boundaries; no pretend generic secret/PII detection. This boundary is the seam for the later encryption hook.

Tests and gate (passing):

- 93 Stage 4 tests (repository total 443): contract suite in default and fast-durability modes plus implementation-specific coverage of partial writes, temp collisions, tamper and digest-substitution detection, concurrent identical/different writers, oversized and endless streams, hostile keys, junction escape (exercised on Windows), non-file object locations, cleanup, close/reopen, and verified-read gates proving a matching digest never marks content trusted.
- Coverage gates met (artifact-store 100% across all metrics; artifact-store-local 92.4% statements / 100% functions); `npm ci`, `npm run check`, `npm audit` (0 vulnerabilities), package dry-runs, and a packed-tarball consumer smoke test including write → close → reopen → verified read all pass on Windows, with the identical commands in the Linux CI matrix.

Deferred within Stage 4 scope (recorded deliberately): reference tracking, retention, delayed orphan collection, and export belong to the later metadata/retention service — the byte store deletes only by validated digest and documents that byte/descriptor coordination is not a distributed transaction; the encryption hook arrives via the transformation boundary when the secrets/policy stage lands; disk-full behavior surfaces as structured `WRITE_INTERRUPTED`/`STORAGE`-class failures and is exercised end-to-end in the Stage 19 chaos suite.

## Stage 5: Provider contracts and deterministic fakes

Status: Complete.

Packages: `@ai-dev-os/providers`, `@ai-dev-os/provider-testkit`

Delivered:

- Separate inference-provider and coding-agent-provider contracts sharing identity, capability, health, trace, usage/cost, disclosure, error, and event-envelope vocabulary while keeping requests, results, and event kinds distinct. No provider SDK, HTTP, process, or filesystem dependency exists in either package.
- Versioned provider descriptors (locality, retention/training behavior, supported Stage 2 classifications, instance capabilities) combined with Stage 2 ModelCapabilities via documented AND semantics; provider health and model availability.
- A finite runtime-validated message/content model (text, artifact and image-artifact references instead of inline blobs, JSON values, model-generated tool invocations vs caller-provided tool results) with portable conversation ordering rules; tool declarations with risk, approval requirement, and execution location — tool execution itself is explicitly deferred to a later policy-enforcing layer.
- One ordered immutable event stream per operation (sequences start at 1 and increment by exactly one, clock-stamped, exactly one terminal event, nothing after it, cumulative usage snapshots) with two enforcement layers: an operation controller that makes adapters correct by construction, and a consumer-side guard so a transport success can never bypass result validation (the Stage 5 gate). Results settle in agreement with terminal events, never require stream draining, and never produce unhandled rejections. Unread buffering is bounded at 10,000 events and 16 MiB of canonical UTF-8 JSON; overflow produces a structured secret-safe terminal protocol failure, and consumed events are released.
- Structured provider errors (21 stable codes) carrying retry dispositions (strategy, delays, provider retry-after, request reusability, may-still-be-running, idempotency requirement) and rate-limit information; deterministic cancellation (idempotent, first-terminal-wins), absolute-instant deadlines enforced pre-start and mid-stream, and lifecycle semantics (close cancels active work as provider-closed; start-after-close rejects).
- Exact usage/cost integration with Stage 2 (estimates on requests, actual token categories and integer-micro Money on results, locally computed cost from pricing metadata) sufficient for later reservation reconciliation.
- Deterministic in-process fakes for both provider kinds driven by immutable scripts (streaming, structured output, tool calls, usage snapshots, warnings, virtual-time delays, scripted failures, raw-stream and terminal-mismatch injection for contract-negative tests), a manual scheduler (no real sleeps anywhere), secret-safe request capture, and policy assertions proving disallowed classifications never reach a provider.
- Reusable contract suites (30 behavioral tests across both kinds) exported at `@ai-dev-os/providers/testing`, executed against the fakes via standard scenario harnesses and designed for reuse by the concrete Ollama, Claude Code, and OpenAI adapters.

Tests and gate (passing):

- 144 Stage 5 tests (repository total 544): both contract suites against the fakes, event-parser unit coverage for every event kind, hostile-input and prototype-pollution rejection, sequence/timestamp/usage-monotonicity fuzz-style negatives with enforced per-event plus aggregate count/canonical-byte buffer bounds, deterministic byte-identical script replay, cancellation/deadline/close races on virtual time, and secret-canary leakage checks.
- Coverage gates met (providers 98.3% statements / 100% functions; provider-testkit 96.6% / 98.4%); `npm ci`, `npm run check`, `npm audit` (0 vulnerabilities), package dry-runs, and a packed-tarball consumer smoke test all pass on Windows with the identical commands in the Linux CI matrix.

Noted deviation: the fakes are deterministic in-process providers rather than a fake HTTP server and fake CLI; process-level transport fakes belong with the concrete adapters (Stages 7, 9, 10), where transport parsing exists to exercise, and the contract suites are already shaped for that reuse.

## Stage 6: Configuration, secrets, and policy broker

Status: Complete.

Packages: `@ai-dev-os/config`, `@ai-dev-os/policy`, `@ai-dev-os/secrets`, `@ai-dev-os/secrets-memory`

Delivered:

- Provider-neutral schema-v1 configuration for application identity, provider instances and SecretRef credentials, loopback local-model endpoints, aliases/preferences, routing, integer-exact Stage 2 budgets, data handling, approvals, workspace limits, artifact/persistence/observability settings, feature flags, and genuine user preferences. Unknown or inline-secret fields are rejected; namespaced extension JSON is canonical and bounded to 16 KiB/depth 8.
- Deterministic precedence of compiled defaults < system < user < project < environment/launch < explicit runtime. Objects merge only by declared fields; collections require explicit replace or merge-by-ID semantics; locks stop later layers weakening mandatory sections. Resolution returns a deeply immutable configuration, per-leaf provenance that survives partial and collection merges, canonical JSON/fingerprint, stable issues, sensitive-field classification, and safe audit metadata.
- A frozen configuration change plan with sorted changed fields, redacted summaries, affected providers/subsystems, policy implications, and live/provider/workspace/application/active-operation/invalid-transition classifications. The stage describes required lifecycle actions but does not execute them.
- Finite immutable SecretRef variants for named, environment, OS-keychain, encrypted-file, and external-vault locators; canonical safe display/fingerprints; text/bytes separation; stable structured errors; callback-scoped non-serializing secret material; policy-before-resolution composition; and attempt/outcome audit hooks with explicit failure semantics.
- A deterministic in-memory secret broker with defensive copies, snapshot concurrency, replacement/revocation, idempotent close, wait-for-active-callback semantics, practical buffer zeroing, no dump-all surface, and reusable adapter contracts. JavaScript/OS/backend memory-erasure limits are documented without claiming secure erasure.
- A deny-by-default central policy broker over Stage 2 classification/handling and Stage 5 provider/model capabilities. Organization, project, then user rules are evaluated in stable order while denials and restrictions accumulate conservatively across disclosure, locality, persistence, logging, workspace, command, network, tool, secret, approval, retention, export/deletion, Git, and package actions.
- Deeply frozen allow/deny/conditional decisions with ordered reasons, matched rules, transformations, structured approvals, locality/logging/retention/capability restrictions, safe audit records, policy version, and canonical SHA-256 fingerprints. One-shot/reusable evidence is checked for action, risk, scope, approver, expiry, revocation, consumption, and normalized-subject digest; models cannot approve their own requirements, and changed action/subject digests invalidate approval IDs.
- Reusable configuration, policy, and secret-broker contract suites plus deterministic clocks, injected policy IDs/audit hooks, and in-memory configuration sources. Denied or unresolved conditional secret decisions are proven not to invoke the broker.

Tests and gate (passing):

- 59 Stage 6 tests (repository total 603 passing, with 5 additional platform/capability cases skipped): exact layer precedence/replay, merge/provenance/locks, hostile and bounded config, canonical/redacted change plans, all reference forms, serialization/inspection/error leakage, text/byte and empty/missing distinctions, concurrent replace/close/zeroing, audit attempts/outcomes, full finite-action normalization, conservative rule ordering, disclosure/capability/logging/retention restrictions, subject-digest approval binding, structured evidence expiry/revocation/scope/one-shot behavior, and policy-before-broker counters.
- Coverage gates met: config 95.83% statements / 83.8% branches / 100% functions; policy 95.16% / 90.47% / 100%; secrets 97.72% / 96.29% / 100%; secrets-memory 96.45% / 82.82% / 100%. `npm ci`, the full typecheck/test/build `npm run check`, repository coverage, `npm audit` (0 vulnerabilities), dependency/security/console scans, all four package dry-runs, and a packed-tarball consumer smoke test pass on Windows. Linux remains covered by the configured CI matrix but was not claimed for this unpushed local commit.

Noted deviations: the requested six-layer contract uses explicit system and environment/launch layers in addition to compiled/user/project/runtime rather than separate hidden profile/run merge rules. `@ai-dev-os/secrets-memory` was added as the deterministic reference adapter requested for this stage. OS-keychain/environment/encrypted-file/vault forms are contracts only; concrete platform adapters and sanitized process-specific injection remain with the later provider/workspace/plugin stages so provider-neutral packages never read ambient environment values or construct process environments. The broker decides capability constraints and validates normalized-subject digests but does not mint execution grants, normalize platform paths/commands, or mutate budget ledgers; those enforcing mechanisms remain in the Stage 8 workspace and Stage 12 scheduler where the necessary platform and reservation state exists.

## Stage 7: Ollama provider and local capacity manager

Status: Complete.

Package: `@ai-dev-os/provider-ollama`

Delivered:

- Native-API adapter (`/api/tags`, `/api/show`, `/api/ps`, `/api/chat`, `/api/generate` for keep-alive, `/api/version`) implementing the Stage 5 InferenceProvider contract: streaming chat over a bounded incremental NDJSON parser (UTF-8 splits, LF/CRLF, per-record/aggregate/record-count bounds), structured output via the documented `format` JSON-Schema mode with defensive final-value parsing and no repair loop, documented `think` boolean/effort-level controls with reasoning emitted as events strictly separate from answer text and fully suppressible per request, tool declarations/invocations with deterministic call IDs and undeclared-call rejection (no tool execution), exact prompt/eval token mapping with unknown-cost semantics and derived nanosecond→millisecond duration telemetry, cancellation (idempotent, first-terminal-wins, response aborted, lease always released), absolute deadlines enforced pre-start, while queued, and mid-stream on an injected scheduler, and per-request keep-alive.
- Loopback-only enforcement: only literal `127.0.0.0/8` dotted-decimal or `[::1]` HTTP endpoints are accepted (strict grammar cross-checked against the URL parser, so hostnames including `localhost`, `0.0.0.0`/`::`, IPv4-mapped IPv6, octal/hex/integer host tricks, user-info, queries, fragments, and base paths are all rejected); redirects are rejected before any second request; no ambient proxy; all request URLs derive from a finite six-endpoint table with model-management operations (pull/delete/copy/create/push) unrepresentable; error bodies are classification-only and never propagate.
- Digest-validated model catalog: deterministic name-sorted discovery independent of response order, normalized sha256 digests with configured pins (mismatched/unverifiable pins make models ineligible with stable reason codes), bounded metadata only (no templates/licenses/token tables), capability normalization from reported `/api/show` tokens with per-field provenance (reported/derived/configuration-restricted/unknown; restrictive-only configuration overrides; versioned family knowledge used solely for Stage 2 rating/latency fields), context length from `model_info`, and a sha256 catalog fingerprint that excludes volatile runtime state and replays byte-identically.
- Role preferences for the DeepSeek R1, Gemma, Mistral, Qwen, and Llama families using the shared config role vocabulary: ranked exact-name then family matching (never name substrings), capability/context/size/quantization/digest-pin requirements, deterministic explainable selection results (evidence, rejected candidates with sorted reason codes, fallback status, catalog fingerprint), and a structured `no-eligible-local-model` result for the later router.
- Deterministic capacity manager: global and per-model concurrency limits, byte budget with safety reserve, strict-FIFO bounded queue with admission timeout, absolute-deadline expiry, cancellation while queued, idempotent lease release on every terminal path with underflow/overflow guards, immutable snapshots, and close semantics. Keep-alive policies (unload-immediately / bounded retain / keep-loaded) map to documented wire values; residency planning unloads only instance-owned idle models (never active/queued leases, never externally observed models — skipped as `not-owned`), executes through empty-prompt `/api/generate`, and supports explicit preloads.
- Health as both the contract ProviderHealth and a richer snapshot (healthy/degraded/overloaded/unavailable/incompatible/closed with structural evidence); structured secret-safe observations for discovery, admissions, operations, and residency; stable ProviderError mapping with conservative retry dispositions and no prompt/output/reasoning/tool-argument/raw-body leakage through errors or observability.
- One provider-neutral upstream addition: the `reasoning-delta` inference event kind in `@ai-dev-os/providers` (the Stage 5 vocabulary had no reasoning event), backward compatible and covered by focused tests.

Tests and gate (passing):

- 136 Stage 7 package tests (130 deterministic + 6 opt-in live): the full Stage 5 inference contract suite runs against the adapter through a deterministic loopback-only fake HTTP server (missing model, malformed stream, disconnect, slow load via held responses, cancellation races, deadline races, overload, secret canaries), plus focused suites for loopback enforcement (encoded-host tricks, redirects, user-info, LAN/public/unspecified addresses), NDJSON/wire hostile input (prototype pollution, unsafe integers, negative durations, invalid timestamps, oversized lines/streams/record counts, invalid UTF-8, hostile tool arguments), deterministic discovery/fingerprint/selection replay, capacity admission/queue/release/close semantics, residency ownership guards, and adapter behaviors — all deterministic tests on virtual time with no real sleeps.
- Opt-in live tests (single `AI_DEV_OS_OLLAMA_LIVE_URL` loopback opt-in plus a model allowlist; never pulling/deleting models, fixed harmless prompts, low output limits, bounded deadlines, no repository writes, no tool execution) passed against a local Ollama 0.32.5 with deepseek-r1:8b, gemma3:12b, mistral:7b, qwen3:8b, and llama3.2:3b installed.
- Coverage gates met; `npm ci`, `npm run check`, repository coverage, `npm audit`, package dry-run, and a packed-tarball consumer smoke test pass on Windows; Linux remains covered by the configured CI matrix.

Noted deviations: `tool_choice` `required`/`named` are rejected because the native API cannot enforce them; image input stays disabled until the Stage 8+ artifact resolver exists; digest identity cannot be re-verified per chat response (not on the wire) and is enforced at selection/start against the latest catalog.

## Stage 8: Workspace and process isolation

Status: Complete.

Packages: `@ai-dev-os/process-broker`, `@ai-dev-os/workspace`

Delivered:

- Versioned, runtime-validated process requests carrying an executable plus an explicit argument array. There is no command-string API and no option that enables one; shell execution is deliberately unrepresentable and deferred as its own future action category. Bounded argument count/size/aggregate bytes, environment binding count and value size, stdin, timeouts, and quotas; deeply frozen and prototype-pollution safe.
- Executable identity through trusted tool descriptors: absolute paths only (never a `PATH` lookup), link and reparse indirection refused, file-type and containment checks, digest verification immediately before spawn, and Windows `.cmd`/`.bat` shims rejected so a package manager is represented as a verified interpreter plus entry point. The same-user digest check is documented as time-of-check/time-of-use evidence rather than a boundary.
- Child environments constructed from an empty baseline with a finite platform allowlist, broker-owned temporary/profile/config locations, deterministic locale, and an explicit PATH. A unique fresh backend session profile takes precedence over any longer-lived trusted workspace profile and appears only as `HOME` on POSIX or `USERPROFILE` on Windows; the ambient home, opposite platform name, Windows legacy components, SSH, askpass, credential-helper, cloud, registry, CI, language-startup, Git-redirection, and proxy values are not inherited. Windows native-spawn parent injection is suppressed for every name omitted from the complete broker block. Requests cannot bind profile/config/credential redirectors in any casing, and the public environment builder rechecks typed bindings. Secrets resolve late, are scoped to one invocation, are literally redacted from captured output across chunk boundaries, and never reach results, audit records, or errors. Session creation refuses a pre-existing target, repeated grants cannot share a profile, and cleanup failure is reported rather than audited as success.
- Bounded output with separate stdout/stderr caps, a combined cap, digests, truncation classification, and terminal-control stripping on decode; a quota breach terminates the process tree and produces a structured failure rather than a truncated success.
- Deterministic process lifecycle with first-terminal-wins settlement, idempotent cancel and close, start-after-close rejection, deadline timers released on every path, and process-tree cancellation (POSIX process groups; Windows `taskkill /T /F`), reporting `termination-unconfirmed` when the tree cannot be proven gone.
- A sandbox backend contract with per-dimension quota honesty (`enforced` / `observed` / `estimated` / `unsupported`), a security classification a backend cannot self-promote, and a production gate that refuses unless the backend is available, explicitly approved by trusted configuration, classified secure-enforcing, and able to enforce every requested dimension. Refusal happens before any child process starts, with no silent downgrade.
- An explicitly named `unsafe-development-current-user` backend that documents its own lack of filesystem, network, credential, and process containment, plus honest Windows, Linux, and macOS probe seams that report exactly which platform primitive is missing and refuse to spawn.
- Repository discovery and immutable clean/dirty snapshot capture that leaves the source working tree, index, refs, configuration, and object database byte-identical: private object directory plus read-only alternates, a copied index, working-tree bytes hashed through `--no-filters --stdin`, `update-index --cacheinfo`, and `write-tree`/`commit-tree` plumbing that runs no hook and moves no reference.
- Dedicated managed private repositories and worktrees: `git worktree add` is never run against the user's repository, so `.git/worktrees` is never created there. Generated paths, exclusive creation, ownership markers, ownership- and containment-checked cleanup, idempotent removal, lease-blocked cleanup, partial-creation reconciliation, and bounded stale discovery.
- Sanitized Git configuration on every invocation, disabling hooks, credential helpers, askpass, signing, editor, pager, external diff, fsmonitor, submodule recursion, automatic maintenance, and all protocols by default.
- Changed-file and commit manifests parsed from NUL-delimited raw diff output (never localized status), covering add/modify/delete/rename/copy/type-change/mode-change/gitlink, with commit creation verified by reading back object type, tree, and parent rather than trusting a zero exit code.
- Read-only target-movement classification (unchanged, advanced, rewound, deleted, replaced, unavailable, unrelated history) and in-memory conflict detection via `merge-tree`, mutating neither the source repository nor the managed worktree.
- Bounded workspace read/write ports validating lease, grant operation, path scope, containment, and link state before every side effect, with no absolute-path or raw filesystem surface.

Tests and gate (passing):

- 308 Stage 8 tests (process-broker 201, workspace 107; repository total 1,041 passing with 11 skipped): the temporary-repository matrix covers clean and dirty trees, staged/unstaged/deleted/type changes, untracked and ignored files, detached HEAD, stale index locks, remotes, submodule gitlinks, target movement in all directions, and conflicts. Hostile fixtures cover traversal, symlink escape, Windows junction escape, `.git` administrative paths, environment theft with canaries, child-and-grandchild process escape, signal-ignoring processes, unlimited output, and cancellation races. Production refusal is proven to occur before any process starts.
- Two real defects were found by adversarial testing and fixed rather than documented around: `git diff-files` re-hashes racily-clean entries and thereby executes a repository's clean filter, which is now neutralized by enumerating the repository's own filter/textconv/merge drivers and overriding each on the command line; and `git merge-tree` emits informational text after the machine-readable conflict section, which was being reported as file names. A positive-control assertion proves the hostile fixtures genuinely fire for ordinary Git, so the "no marker appeared" assertions are not vacuous.
- Coverage gates met (process-broker 92.5% statements / 87.1% branches / 93.6% lines; workspace 90.3% / 81.3% / 90.9%). Both packages set the function threshold to 90 with a recorded reason: process-tree termination and link handling are platform-split by construction, so no single host can execute both halves; each is covered on its own platform by the CI matrix, following the `@ai-dev-os/provider-ollama` precedent.
- `npm ci`, `npm run check`, repository coverage, `npm audit` (0 vulnerabilities), package dry-runs, and a packed-tarball consumer smoke test pass on Windows; Linux remains covered by the configured CI matrix.

Noted deviations: no built-in backend is classified secure-enforcing, because none of the required platform primitives (Windows Job Objects with a restricted token, Linux namespaces with cgroup limits, a supported macOS sandbox) can be implemented without native dependencies or privileged installation that are out of scope here. The platform backends are therefore honest probe seams and production mode refuses all of them — the security gate is the deliverable, not a claim that every platform is already contained. Git plumbing is invoked directly rather than through the process broker, because the broker exists to supervise untrusted workload and requires a grant that repository discovery must run in order to issue; the same argument-array, constructed-environment, bounded-output, and deadline rules still apply. Durable lease persistence and the recovery loop remain with the Stage 12 scheduler, which receives records and hooks from this stage.

## Stage 9: Claude Code coding-agent adapter and usage telemetry

Status: Complete.

Package: `@ai-dev-os/provider-claude-code`

Delivered:

- Versioned, runtime-validated, deeply immutable adapter configuration covering the trusted executable descriptor, CLI compatibility floor and validated ceiling, permitted models and effort levels, turn and integer-micro budget ceilings, process/operation deadlines, output/record/stream/record-count bounds, diagnostic and patch limits, session-persistence policy, capacity staleness, authentication classification, supported classifications, and endpoint classification. Inline credentials, arbitrary argument arrays, shell command strings, permission-bypass switches, Chrome, ambient MCP/hooks/plugins/settings, advisor, fallback model, and "continue" are unrepresentable by field name, so no configuration document can enable them. A Stage 6 extension namespace (`claude-code`) is consumed structurally without depending on `@ai-dev-os/config`; extensions may only tighten limits and may not restate identity or the executable. Canonical SHA-256 fingerprints exclude volatile health and capacity data.
- Executable discovery with no `PATH` lookup at spawn time, link/reparse refusal, and Windows `.cmd`/`.bat` shim rejection in both the configuration parser and the process broker, with structured installation guidance that contains no filesystem path. Script entry points are reached the Windows-safe way (trusted interpreter image plus a pinned argument prefix). The `--version` probe runs through the same execution seam as a session, starts no session, and cannot consume model usage.
- A versioned compatibility matrix (`COMPATIBILITY_MATRIX_VERSION = 1`) written and verified against the installed Claude Code 2.1.201 by reading that binary's own `--help` output. A version above the validated ceiling reports `newer-than-validated` and keeps the last validated capability set rather than assuming new capability. The matrix records `maxTurns: false` because the 2.1 CLI exposes no `--max-turns` flag; the adapter enforces the turn ceiling itself from the stream's turn accounting rather than claiming a CLI-enforced cap.
- A finite adapter-owned argument vector — print mode, `stream-json`, verbose, partial messages, safe mode, `--no-chrome`, `--strict-mcp-config`, empty `--setting-sources`, an explicit built-in `--tools` surface, a full `--disallowed-tools` deny list including `mcp__*`, `--permission-mode dontAsk`, explicit model/effort, budget cap, explicit session identity or exact resume, and `--no-session-persistence` by default. Task instructions travel on bounded stdin, never in argv. Every element is a literal or a pattern-checked token that cannot start with `-`, with a final assertion at vector assembly. `--allowedTools` is deliberately unused, because an allow-list of names is not by itself a tool restriction.
- Conservative tool and permission translation. `commandPolicy: "allow-listed"` is refused with `UNSUPPORTED_CAPABILITY` rather than approximated by a Bash command-prefix glob, because a textual prefix rule over a shell line cannot enforce an executable allowlist. `commandPolicy: "none"` removes Bash entirely. `networkPolicy: "proxied"` is refused because no shipped backend can enforce egress, and the descriptor reports `networkAccess: false` since Claude's control-plane connection is not agent web access. Approvals resolve structurally before launch; a conditional policy decision terminates with `AUTHORIZATION_FAILED` rather than waiting, and a reported permission denial becomes an `approval-requested` event with a matching decision. Tool arguments are never surfaced — only argument key names.
- A bounded incremental UTF-8 NDJSON decoder handling arbitrary byte boundaries, split multi-byte characters, LF/CRLF, blank lines, and a final record without a newline, with per-record, total-stream, and record-count bounds enforced while decoding. Invalid UTF-8 fails rather than silently substituting. Records fail closed on unknown top-level types, unrecognized assistant content blocks, duplicate terminals, post-terminal records, session-id mismatch, non-monotonic or negative usage, prototype pollution, unsafe numbers, and self-contradicting results; unknown informational `system` subtypes produce a bounded compatibility warning. An init record listing a loaded MCP server or plugin, or a hook lifecycle event, is a hard failure. A zero exit without the terminal result record is `MALFORMED_RESPONSE`.
- Workspace reconciliation as the sole source of truth. Every terminal path — success, failure, cancellation, deadline, malformed output, budget exhaustion — re-inspects the managed worktree and computes actual add/modify/delete/rename through `@ai-dev-os/workspace`, checking each path against request prefixes, grant writable prefixes, administrative state, hostile shapes, and link/reparse escape verified against the live filesystem. A violation fails the operation even when the session reported success; violations are reported as counts by category, never as paths. Partial edits after a failed or cancelled run are detected and preserved for the later scheduler. Commits are created only from verified state through the workspace layer's safe commit facility, and `resultRevision` never comes from a hash printed in Claude's output.
- Artifact extraction through provider-neutral interfaces: canonical patch derived from the reconciled workspace, bounded command log holding only tool names, target paths, and argument key names, a structural diagnostics summary containing no raw stderr, a machine-readable test report, and session metadata when policy permits. Raw stderr remains bounded in memory for finite failure classification and is never persisted because it may echo prompts, credentials, or paths. Raw transcripts are never persisted, and a denied artifact write still yields a valid result with the content written nowhere else. Structured test results require machine-verifiable workspace evidence; a narrative claim that tests passed produces nothing.
- Session ephemerality by default, `--continue` never used, and resume restricted to the adapter's own opaque token whose provider instance, project, workspace, snapshot lineage, model, effort, and configuration fingerprint are bound into digests the verifier recomputes, so a token cannot be edited to point elsewhere and discloses nothing. Policy is checked before the token is parsed.
- Honest usage and cost mapping: Claude's `input_tokens` plus `cache_creation_input_tokens` become `inputTokens`, `cache_read_input_tokens` becomes `cachedInputTokens`, and `reasoningTokens` stays zero because this surface reports none. Cumulative snapshots are reconciled rather than summed, so partial-stream and terminal values cannot double count. `total_cost_usd` maps to `providerReported` only under API-key, cloud-provider, or gateway billing; under a personal subscription login the cost is `UNKNOWN_COST` and the figure travels only as a provider-specific observation, because an API-equivalent estimate for work billed another way is not a charge.
- A capacity observation seam fed only by a host-supplied Claude status document. Nothing is scraped, the user's global Claude settings are never read or edited, no collector is installed, missing quota data stays `unknown` rather than zero, an unobserved reset time stays null, and an observation past its staleness window reports `stale`. Refreshing a quota figure consumes no model usage.
- Deterministic cancellation and lifecycle: idempotent cancel, first-terminal-wins, pre-start/mid-stream/post-edit/during-reconciliation coverage, results settling immediately on cancellation while adapter-owned cleanup completes under `close()`, and `cancellation: "best-effort"` reported honestly because no shipped backend can prove a process tree is gone.
- Structured secret-safe observations for probe outcome and tier, operation start and terminal category, requested versus observed model and effort, permission profile category, tool and artifact counts, changed-file count, backend id and security class, usage totals, cost-known versus cost-unknown, capacity status, latency, retry category, reconciliation outcome, and termination confirmation. No console logging exists in package source, and an observer that throws is contained without its thrown value being inspected.

AI Development OS authentication boundary: no Claude credential file, OAuth token, session cookie, API key, or credential-helper output is ever read, parsed, copied, exported, logged, serialized, or returned. There is no subscription-token field. Secret-backed environment bindings carry only a reference fingerprint and resolve through the Stage 8 resolver after policy approval, immediately before process creation. A personal installed-CLI login is refused without an explicit development-canary opt-in and is never presented as distributable. On Linux and Windows, the process broker builds the child environment from an empty baseline, then supplies a unique broker-owned session home as `HOME` or `USERPROFILE` rather than inheriting the invoking user's home. The opposite home name, Windows legacy home components, Windows application-data paths, XDG redirectors, `CLAUDE_CONFIG_DIR`, and Claude OAuth token/refresh/scopes remain absent. Request bindings cannot set those names in any casing, while an explicitly authorized `ANTHROPIC_API_KEY` remains supported. macOS Claude credentials live in the user's Keychain, which `HOME` redirection cannot isolate, so distributable authentication modes refuse before any task process until a Keychain-isolating backend exists. The explicit personal canary remains outside the distributable boundary. Profile redirection does not make user-readable filesystem paths or same-user credential stores unreachable under the unsafe development backend.

L-01 correction: the original Claude security test unconditionally rejected
`HOME`, so it failed on POSIX and passed on Windows without checking
`USERPROFILE`. Contract reconstruction also found that Node's Windows spawn path
copied ambient `HOMEDRIVE` and `HOMEPATH` into a child even though the broker's
constructed object omitted them. The first bounded repair suppressed those
parent values for the synchronous spawn call and added simulated
POSIX/Windows/null-home/override tests plus a real fake-CLI assertion. Exact
commit `6bd96c4005f24c575e5e4d849a9d5299e2901a08` passed both hosted checks and
Windows coverage in run `31226295963`, while the dependency-audit job reported
`GHSA-2v37-7h3g-55p8` against unchanged `nanoid@3.3.16`. A fresh contract review
then found a differently-cased Windows request could introduce `HOME`, typed
bindings could bypass parser-only rejection, a longer-lived workspace profile
could win over the backend session home, and the purported artifact-canary
assertion inspected only artifact category names while raw stderr was actually
persisted. Independent review additionally found macOS Keychain lookup
unaffected by `HOME`, broader Windows native-spawn injection, deterministic
session-directory reuse, concealed cleanup failure, and a credential fixture
capable of serializing future injected values. The follow-up reserves all
home/config/OAuth names case-insensitively at both boundaries, gives a unique
fresh backend home precedence, refuses distributable macOS starts until Keychain
isolation exists, suppresses every omitted Windows parent name, reports cleanup
failure, persists only structural diagnostic evidence, and keeps the fake-CLI
proof canonical, controlled, bounded, and credential-value-free.

Strengthened exact commit `774802bf575b82611a906f86aeb79e12aebcaba4`
passed the Ubuntu check, Windows check, and Windows coverage job in exact-head
run `31254868909`: all 45 Claude security tests executed on both hosts,
process-broker passed 259 tests with only the physically unavailable Windows
cross-volume vector skipped on Ubuntu and all 260 on Windows, and all retained
L-03 vectors remained green. Process-broker coverage was 91.58% statements /
85.60% branches / 92.03% functions / 92.20% lines; Claude-provider coverage was
90.72% / 83.85% / 94.34% / 90.74%, above unchanged floors. The run's separate
dependency audit still reported the same single high-severity `nanoid@3.3.16`
finding, so the home-isolation proof is complete but the required
zero-vulnerability final gate is not called closed without separately authorized
dependency remediation.

That separate authorization is now integrated without widening dependency
policy: exact commit `bfb06ff54fa0902908a7769d9e4d6a8d18e77604` changes only the
single `package-lock.json` `nanoid` object from 3.3.16 to 3.3.18. The dedicated
Stage 17 integration tree resolves one chain,
`vitest@4.1.10` -> `vite@8.2.0` -> `postcss@8.5.25` -> `nanoid@3.3.18`; local
clean install and both audit forms report zero findings. Hosted integration
evidence remains pending until the exact two-parent merge commit is pushed and
its workflow completes.

Tests and package gates:

- 257 Stage 9 tests passing with 7 opt-in live canaries skipped. The fake CLI is a real executable reached through a trusted `node` image plus a pinned script argument — no `.cmd` shim, no shell — driven through the real process broker over the real `unsafe-development-current-user` backend against a real managed private worktree of a real temporary Git repository. Coverage covers version probing and unsupported versions, read-only completion, successful and partial edits, completed-no-changes, arbitrary byte splits (1/3/7/64-byte pieces), split UTF-8, CRLF and missing final newline, stdout/stderr separation, retry events, usage and cache categories, reported cost, session creation and verified resume, model mismatch, unsupported effort, permission requests, denied tools, turn and budget exhaustion, rate limit with retry-after, context limit, malformed JSON, prototype pollution, oversized record and stream, excessive record count, missing/duplicate/post-terminal records, contradictory results, non-monotonic usage, non-zero exit, hang, signal-ignoring processes, nested children, cancellation and close races, forbidden path changes, and secret canaries in stdout, stderr, errors, artifacts, observations, and fingerprints.
- The reusable Stage 5 coding-agent contract suite passes against the adapter through the fake CLI (11 tests, all ten scenarios).
- Production refusal is proven with an armed start marker: the marker is never written in production mode, and a development-mode positive control proves the same fixture genuinely writes it, so the negative assertion is not vacuous.
- Live canaries: the probe canary was executed on Windows against the actually installed Claude Code **2.1.201** and passed (compatible tier, `usableForProduction` true, no adapter credential read). The five live task canaries were **skipped**, not passed: no `AI_DEV_OS_CLAUDE_LIVE_API_KEY` opt-in was present, and the Windows brokered CLI's default isolated-home lookup cannot discover an installed login; adapter code never reads the credential file itself. macOS distributable task starts now refuse before their operation-owned probe or task process because `HOME` cannot isolate Keychain access. No live edit canary ran, so no model usage was consumed.
- Coverage gates met without lowering any threshold: 90.72% statements / 83.85% branches / 94.34% functions / 90.74% lines. The package sets the function threshold to 90 with a recorded reason (platform-split executable discovery cannot execute both halves on one host), following the `@ai-dev-os/workspace` and `@ai-dev-os/provider-ollama` precedent.
- The original Stage 9 delivery recorded an `npm ci`-clean install, `npm run check` (typecheck, test, build), repository `npm run test:coverage`, `npm audit --audit-level=high` with zero vulnerabilities, `npm pack --dry-run` for the new package and all five affected publishable packages, and a packed-tarball consumer smoke test in a fresh temporary consumer outside the repository. Nine verification scans passed: no console logging, no direct process creation, no shell execution surface, no forbidden CLI flag emitted, no inline credential signature, dependency-boundary conformance, declared-dependency conformance, no generated artifacts in the package tree, and no orphan module. The later L-01 exact-head audit result and blocker are recorded above rather than conflated with that historical delivery evidence.

Two real defects were found by the tests and fixed rather than documented around. The control-character guards in three modules were written as the character range space-to-hyphen instead of the intended control range, which silently rejected every ordinary hyphenated model identifier and file path; a regression test now asserts that `claude-fable-5` and `src/my-hyphenated-file.ts` are accepted. Separately, the session policy was evaluated after the CLI version probe, so a denied session still started a Claude process; policy now runs before any process is created, proven by an armed marker.

Noted deviations: `commandPolicy: "allow-listed"` and `networkPolicy: "proxied"` are unsupported and return `UNSUPPORTED_CAPABILITY` rather than a weaker approximation. Turn limiting is adapter-side because the installed CLI has no `--max-turns`. Structured test results require a machine-readable report at a configured workspace path rather than trusting the transcript, and the test events are emitted from that evidence at reconciliation time. Reasoning content is discarded rather than surfaced, because the neutral coding-agent contract has no disclosure-checked channel for it. No upstream provider-contract change was required: the existing Stage 5 event vocabulary covered every mapping.

## Stage 10: Codex coding-agent adapter and Codex usage telemetry

Status: Complete.

Packages: `@ai-dev-os/provider-codex`, `@ai-dev-os/process-broker` (provider-neutral duplex extension)

Delivered:

- A persistent, bounded, byte-oriented process session that reuses Stage 8 executable resolution, admission, capability grants, leases, environment construction, policy fingerprints, sandbox preparation, deadlines, output quotas, process-tree termination, audit records, and production refusal. Writes are serialized and byte-bounded; unread events fail closed; first terminal outcome wins; startup cancellation and close/termination races are covered.
- A versioned Codex App Server adapter over newline-delimited JSON-RPC on brokered stdio. It performs `initialize`/`initialized`, `thread/start` or policy-bound `thread/resume`, `turn/start`, `turn/interrupt`, correlated client requests, server approval requests, bounded notifications, and terminal `turn/completed` handling. `thread/shellCommand` is never used as a sandbox substitute.
- Trusted absolute executable configuration with no `PATH` lookup or command shim, version and generated-schema probes through the process broker, a finite compatibility matrix, operator-supplied model/effort allowlists, JSONL/session/deadline/token/process bounds, conservative sandbox and approval mappings, and explicit authentication classification.
- Account, rate-limit, token-activity, and turn-usage observations through App Server methods rather than auth-file access. Unknown billed cost remains unknown; subscription/account state is never presented as a monetary charge.
- Managed-workspace reconciliation as the authority for changed files, commits, patches, and machine-readable test evidence. Claimed transcript paths cannot override the Stage 8 snapshot/diff boundary.
- Current App Server compatibility was checked against the first-party manual and the schema generated by the installed `codex-cli 0.146.0-alpha.9.2`. A live probe and authenticated read-only account/rate-limit/usage canary passed without model work or repository content. Integration added support for the schema-backed timestamped `remoteControl/status/changed` notification and fixed the initialize-response race it exposed.

Tests and gate (Windows, Node 24.17.0, npm 11.13.0):

- Process broker: 233 tests passed; coverage 91.47% statements / 86.31% branches / 90.32% functions / 92.51% lines.
- Codex adapter: 89 tests passed and 4 live-only tests were explicit; coverage 90.20% statements / 84.60% branches / 93.22% functions / 97.69% lines. The real probe and account telemetry canaries passed; read-only and edit model turns remained skipped because no model/cost authorization was supplied and no provider call was needed for release evidence.
- Repository aggregate: 1,417 tests passed and 22 expected platform/live skips; numerator-weighted coverage 93.45% statements / 86.58% branches / 96.44% functions / 94.35% lines. The first aggregate coverage attempt reproduced a 5-second Windows coverage-load timeout in the unread-event-queue adversarial test; a narrowly scoped 15-second test timeout preserved all production bounds, and the exact aggregate rerun passed.
- Clean install, repository typecheck/test/build, all coverage thresholds, `npm audit --audit-level=high` (0 vulnerabilities), package dry-runs, dependency and package-content scans, and a fresh eight-tarball public-export consumer smoke passed.
- Process-level fakes cover malformed/oversized/invalid-UTF-8 frames, duplicate and unknown IDs, timestamped handshake notifications, approvals, cancellation, process exit, queue overflow, restart/close behavior, model substitution, partial edits, and transcript-versus-workspace disagreement with positive controls.

Limitations: no built-in backend is classified `secure-enforcing`, so production autonomous execution still refuses before spawn. Live model turns, Linux, macOS, and CI were not run locally. App Server does not provide a verified billed-cost value; API-key and Bedrock usage gaps remain unsupported/unknown rather than zero. Account login UI, purchases, cloud tasks, arbitrary MCP/apps/plugins, connector exposure, and external-sandbox equivalence remain outside this adapter.

## Stage 11: OpenAI Responses inference adapter

Status: Complete.

Package: `@ai-dev-os/provider-openai`

Delivered:

- A strict OpenAI Responses adapter over the exact `https://api.openai.com/v1` origin and fixed create/get/cancel routes. It supports JSON and bounded SSE, text, structured output validated against the caller schema, caller-executed function tools, image references through an injected artifact resolver, reasoning controls, background create/poll/resume/cancel, usage reconciliation, and safe structural rate-limit/request metadata. Hosted tools, audio, MCP, arbitrary origins, redirects, and organization administration/usage/cost endpoints fail closed or are unrepresentable.
- An operator-supplied, dated, provenanced, effective-time model/capability/price catalog with deterministic SHA-256 fingerprints and restrictive-only overrides. The package and README ship no OpenAI model id, context/output limit, or price; unavailable facts remain unavailable and missing prices produce unknown cost rather than a guess.
- Request-scoped policy and secret composition: disclosure precedes artifact access, credential resolution, and network I/O; persistence and background temporary state require separate authorization; ordinary inference has one text `SecretRef` and no admin-key or implicit-default-model control. Safety identifiers are bounded salted HMAC values, never raw usernames or email addresses.
- Retention reporting that distinguishes `store` from the roughly ten-minute temporary state required by background mode and treats an operator-declared Zero Data Retention arrangement as provenance-bearing configuration, not an inference from `store: false`.
- Strict semantic-event and response reconciliation: unknown events/items fail closed; lifecycle event names must agree with embedded status; response id and model identity cannot change; per-item text/refusal completion, tool-call uniqueness, cursor continuity, replay deduplication, terminal usage, and integer-exact cost are checked.
- Retry behavior is explicit and bounded. Only caller-identical GET polling/resume requests use the configured retry ceiling and cancellation/deadline-aware backoff; create and cancel POSTs remain single-attempt because no public idempotency guarantee was assumed. Retry dispositions preserve `operationMayStillBeRunning` and idempotency requirements for the later scheduler.
- Current first-party documentation was rechecked on 2026-08-03: OpenAPI 2.3.0 still declares the fixed server and Responses routes, GET resume query, background cancel, safety identifier bound, semantic SSE events, and background temporary storage. Model/commercial facts remain external operator data even where current guidance names model families.

Tests and gate (Windows, Node 24.17.0, npm 11.13.0):

- OpenAI provider: 321 hermetic tests passed and 2 opt-in live tests were explicit skips; coverage 92.42% statements / 87.35% branches / 95.39% functions / 92.68% lines, above the 90/80/90/90 gate. The reusable Stage 5 inference contract suite passes against the fake transport.
- Repository aggregate: 1,738 tests passed with 24 expected platform/live skips; numerator-weighted coverage 93.29% statements / 86.72% branches / 96.31% functions / 94.07% lines. Clean install, repository typecheck/test/build, and every package coverage threshold passed on the exact Release 11 checkpoint.
- `npm audit --audit-level=high` reported zero vulnerabilities. The OpenAI package dry-run contains 70 files (108,281 packed bytes / 500,465 unpacked bytes), limited to README, package metadata, and `dist`; a fresh consumer installed six packed runtime-closure tarballs and completed a public-export-only end-to-end stream/usage/retention smoke.
- Dependency, package-content, generated-artifact, inline-secret, direct-console, ambient-environment, filesystem/process, and shipped-model-fact scans passed. Tests cover denied disclosure/secret access before side effects, redirects, body/event bounds, malformed UTF-8/JSON/SSE, unknown semantic additions, response/model substitution, tool protocol disagreement, cancellation/close/backoff races, and error/observation secret canaries.
- The live canary was skipped because `AI_DEV_OS_OPENAI_LIVE`, an API key, an explicitly selected model, dated input/output price facts, and a cost ceiling were not supplied. No model call, spend, or repository/user content left the machine. Linux, macOS, and CI were not run locally.

Integration found and fixed release blockers rather than recording them as limitations: the parsed retry policy was dead; a background streaming response did not publish its response handle in time for remote cancellation; retry/poll delays could hold `close()` after cancellation; latency state was shared across concurrent operations and excluded initial request time; model/response identity and event/status agreement were not enforced; multi-item text completion used one global comparator; duplicate tool starts overwrote state; and unused admin-key/default-model fields implied capabilities the package did not provide.

Limitations and deferred work: organization usage/cost APIs remain out of scope rather than partially implemented; create/cancel POST retry remains caller-owned; additive SSE event types require an adapter update; health is local-only to avoid a credentialed/billable probe; current Linux/macOS behavior is unverified locally. The proposed shared `cacheWriteTokens`/cache-write pricing and explicit applied-redaction transformation vocabulary were reviewed but not merged: one adapter does not yet justify widening shared contracts, so Stage 13 should evaluate them while building the normalized ledger.

## Stage 12: Multi-provider gateway and curated free-tier adapters

Status: Complete.

Packages: `@ai-dev-os/provider-catalog`, `@ai-dev-os/provider-gateway`, `@ai-dev-os/provider-openai-compatible`, `@ai-dev-os/provider-gemini`

Delivered:

- A strict, immutable, versioned provider/model catalog with exact HTTPS origins and path templates, official-source provenance, dated verification windows, deterministic SHA-256 provider/model/catalog fingerprints, restrictive whole-provider overlays, and signed remote-envelope verification. Unknown fields, normalized-identity collisions, encoded traversal, unsupported capability claims without evidence, and fingerprint drift fail closed. The package performs no network refresh and does not compete with Stage 11's operator-owned OpenAI model/price catalog.
- The built-in snapshot was generated/verified at `2026-08-03T00:00:00.000Z`; verified-free eligibility expires at `2026-08-10T00:00:00.000Z`. Its catalog fingerprint is `56874888955077c641b225a862dc3bac8b9a4fe774a326e5b81dee3eb926173b`. The exact models are Google `gemini-3.5-flash`, Groq `openai/gpt-oss-120b`, Cerebras `gpt-oss-120b`, and OpenRouter `openai/gpt-oss-20b:free`; the nondeterministic `openrouter/free` router is absent.
- A composition gateway that requires an explicit provider instance and contract model for every invocation. Registration binds one available provider model, one exact catalog model/profile, and one exact-instance text `SecretRef`; rejects token-limit/capability overclaims and credential reuse; exposes frozen, fingerprinted instance snapshots; and keeps independent health/quota observations outside configuration identity. It performs no ranking, recommendation, selection, retry, fallback, cross-provider substitution, or fan-out.
- Finite Groq, Cerebras, and OpenRouter Chat Completions profiles over fixed documented endpoints. Callers cannot supply origins, paths, redirects, authorization/security headers, proxies, or compatibility profiles. OpenRouter pins one concrete model and sets `allow_fallbacks: false`, `require_parameters: true`, and `data_collection: "deny"`. Strict JSON/SSE parsing validates model, role, choice, finish, usage, tool identity/arguments, stream completion, UTF-8, and byte bounds; total request timeout includes body consumption.
- A native Gemini `v1beta` adapter using fixed `generateContent`/`streamGenerateContent` routes and `x-goog-api-key`, with bounded inline artifact-resolved images, caller-executed functions, structured JSON, reasoning parts/signatures, safety settings, usage, strict JSON/SSE parsing, and policy-before-artifact-before-secret-before-HTTP ordering. It is not an OpenAI compatibility approximation.
- First-party provider documentation was rechecked on 2026-08-03 before the refresh boundary. Cerebras was corrected to a 40,960-token maximum completion and an organization-scoped, payment-method-gated $5 Free Trial whose credits expire after 30 days; this is not recurring free capacity. OpenRouter access remains account/rate/upstream constrained, and every free claim is dated rather than a production-capacity promise.

Tests and gate (Windows, Node 24.17.0, npm 11.13.0):

- Catalog: 28 tests; coverage 91.17% statements / 88.03% branches / 97.01% functions / 100% lines.
- Gateway: 13 tests; coverage 97.81% statements / 92.98% branches / 97.43% functions / 98.55% lines. Fakes prove runtime descriptor/model validation, exact credential binding, explicit invocation, disabled/expired eligibility, quota isolation, failure isolation, immutability, and catalog limit/capability enforcement.
- OpenAI-compatible profiles: 38 tests; coverage 91.46% statements / 83.75% branches / 94.23% functions / 96.60% lines. The reusable finite-profile contract suite passes for Groq, Cerebras, and OpenRouter; adversarial tests cover canonical upstream IDs, pre-aborted no-effect behavior, valid joined multi-part content above the domain canonical string limit, serialized request bounds, oversized error-body status classification, and terminal stream continuation/usage conflicts.
- Gemini: the worker's 14 tests covered only 89.29% statements / 79.53% branches / 85.89% functions / 96.84% lines behind lowered 85/75/85/90 gates. Integration restored 90/80/90/90, added meaningful protocol, secret, cancellation, deadline/body-timeout, actual 20,000,000-byte serialized-request, positive multi-megabyte image, artifact, function-mode, endpoint-policy, terminal-evidence, status-classification, and error-normalization tests, and now passes 25 tests at 91.77% / 84.68% / 91.76% / 98.31%.
- The final shared OpenAI Responses adapter passes 324 tests with 2 explicit live skips at 92.49% statements / 87.42% branches / 95.40% functions / 92.75% lines after the same oversized-error-body status fix was applied without changing its Release 11 operator-owned model-fact boundary.
- Repository aggregate: 1,845 tests passed with 24 expected platform/live skips; numerator-weighted coverage is 93.16% statements (13,110/14,072) / 86.57% branches (8,700/10,050) / 96.12% functions (2,553/2,656) / 94.38% lines (11,612/12,303). The first pre-audit aggregate pass exposed three inherited process-broker tests hitting Vitest's 5-second harness limit under coverage instrumentation. Their production output/deadline bounds were unchanged; two test-local ceilings were narrowly raised to 15 seconds, the focused 233-test process-broker coverage suite passed, and two pre-audit aggregate reruns passed. After audit remediation, the exact full typecheck/test/build gate passed in 759.7 seconds and the exact aggregate coverage run passed in 501.3 seconds.
- Independent read-only Claude Opus 5 High review found no exploitable security, privacy, history, protocol, or concurrency blocker. Its valid findings were fixed before release: top-level compatible-wire serialization no longer misclassifies valid joined content; oversized non-success bodies cannot override HTTP status classification in OpenAI, compatible, or Gemini adapters; publish manifests/build configs exclude compiled unit/live tests; the gateway test now proves the actual exact-instance SecretRef invariant; Gemini cross-checks its fixed routes against the curated endpoint policy and has a positive multi-megabyte request control. A proposed pre-policy Gemini size rejection was declined because configured artifact limits are upper bounds, not actual request sizes; policy-before-artifact and byte-bound-before-secret ordering is documented instead.
- Package dry-runs contain no source, unit-test, live-canary, cache, or build-state files: catalog 26 files / 21,316 packed bytes, gateway 22 / 9,990, OpenAI-compatible 46 / 28,996, and Gemini 34 / 23,815. Build-only TypeScript configs prevent clean builds from emitting unit/live tests, while manifest exclusions also protect against stale local `dist` outputs.
- Live canaries for Gemini, Groq, Cerebras, and OpenRouter remained explicit skips because their provider-specific opt-ins and API keys were absent. No paid request or repository/user content left the machine. Linux, macOS, and CI were not run locally.

Limitations and deferred work: the bundled commercial/free facts require refresh after 2026-08-10 and fail closed for `verified-free-only` use; the catalog has no downloader; health and quota are current observations rather than durable history; no automatic routing, retry, fallback, or capacity promise exists; Gemini audio/video/PDF and Files API uploads are unsupported; OpenAI-compatible profiles implement a finite Chat Completions subset, not Responses parity. Stage 13 owns normalized usage/cost/quota/health history, reset estimation, and forecasting. Intelligent selection and routing remain later-stage work.

## Stage 13: Unified quota, cost, health, and capacity ledger

Status: Complete.

Package: `@ai-dev-os/telemetry-ledger`

Release checkpoint:

- Release 12 base: annotated tag `v0.12.0-provider-gateway`, commit `d12ea1295a488e2711952ca1cb4898e6d4bb329b`.
- Additive Stage 3 prerequisite: commit `524e4c996eda3c93d8176cb75bcd65a69fec1774` adds the closed `telemetry-ledger` aggregate type and contract evidence.
- Verified Stage 13 implementation: commit `571c592a8fcb58d4766b1fec3e6720b4618e8e91`.
- Final completion record: the commit containing this entry, released by annotated tag `v0.13.0-telemetry-ledger` (the tag is the immutable exact commit reference and can be resolved with `git rev-list -n 1 v0.13.0-telemetry-ledger`).

Delivered:

- A strict schema/algorithm-versioned, exact-key, deeply frozen, content-free observation vocabulary for estimates, cumulative and terminal usage, cost, provider health, quota/capacity, corrections/tombstones, derived state, forecasts, and account usage. Every store binds one logical ledger across ingest, authorization, reads, export, verification, idempotency, correction lookup, and partition limits.
- Ledger-local disjoint token accounting preserves uncached input, cache writes, cached reads, visible output, reasoning, unknown/combined tokens, tool calls, and category completeness without widening the released Stage 2 `TokenUsage` contract. Cumulative stream snapshots and terminal totals reconcile as replacement evidence, not deltas; a bounded 64-seed property test proves terminal usage is never added on top.
- Integer-exact, currency-separated cost components retain provider-billed, locally computed, subscription-equivalent, verified-zero, and unknown semantics. Provider-scoped source fingerprints deduplicate generic/provider-specific views without adding bills and estimates together; known plus unknown remains partial.
- Staleness/effective-interval-aware current quota, capacity, and health snapshots keep primary/secondary, five-hour/seven-day, model, instance, dimension, and provider-window identities distinct. Deterministic fixed-point forecasts support absolute remaining units and percentage basis points, segment at resets, expose confidence/sample evidence, and fail closed for incomparable or insufficient samples.
- Append-only journal events and bounded per-partition checkpoints use the Stage 3 transaction, checksum, optimistic-concurrency, and pagination ports. Atomic append/checkpoint updates, live-clock idempotency, global per-ledger collision checks, cross-partition corrections, checkpoint recovery, checksum/new-schema refusal, close races, memory/SQLite contracts, and replay fingerprint verification are covered. A proactive checkpoint-size guard fails as `PARTITION_FULL` before the persistence text bound.
- Required deny-conservative authorization/audit injection, exact subject/organization/project/workspace matching, per-observation disclosure filtering, partial-result propagation, bounded content-free audit records, hostile payload canaries, and no console/process/environment/network/filesystem bypass in production code.
- Pure public bridges for Ollama, Claude Code, Codex, OpenAI, the Stage 12 gateway, and the generic Gemini/Groq/Cerebras/OpenRouter provider contract. Bridges consume already-obtained public facts only; they never poll providers, read credentials/auth files, redeem credits, pool keys, select routes, retry, or mutate budget/scheduler state.
- ADR 0013 keeps cache-write categories ledger-local and defers a new shared applied-redaction vocabulary because the ledger stores no prompt/response content and no second released consumer requires the same transformation list.

Tests and gate (Windows, Node 24.17.0, npm 11.13.0):

- Telemetry ledger: 54 tests pass across schema/configuration, reconciliation/property/adversarial cost cases, provider bridges, authorization/privacy, pagination/queries, correction semantics, deterministic forecasting, corruption/recovery/concurrency/close behavior, and the reusable memory/SQLite persistence contract. Coverage is 93.54% statements (870/930), 82.64% branches (762/922), 100% functions (201/201), and 97.33% lines (693/712), above the 90/80/98/90 release gates.
- Repository aggregate: 1,899 tests pass with 24 expected platform/live skips. Numerator-weighted coverage is 93.18% statements (13,980/15,002), 86.22% branches (9,461/10,972), 96.39% functions (2,754/2,857), and 94.54% lines (12,305/13,015).
- A clean `npm ci` preserves lockfile SHA-256 `cb5c4df83a1d2c9fb3ed6e22bf8dc1c2c8efa73986c94ce72a6f408f67d5f590` and reports zero vulnerabilities. The exact full `npm run check` passes in 687.9 seconds, aggregate `npm run test:coverage` passes in 404.8 seconds, and `npm audit --audit-level=high` reports zero vulnerabilities.
- Dry-run packages contain only declared public artifacts: telemetry ledger 54 files / 58,873 packed bytes / 312,905 unpacked bytes; persistence 46 / 37,633 / 181,986. A fresh external consumer installs 17 packed local dependencies with zero vulnerabilities and uses only root, `./providers`, and persistence-memory public exports to bridge, ingest, audit, filter by model, query, verify, and close (`consumer-ok ce536e069baa14797c4d539da0093935c2ee76534f71fae1bacf4cb6bdc9ecef`).
- Static scans find no package-private imports, provider back-edge, console/process/environment/network/filesystem/better-sqlite3 bypass, conflict marker, or ambient credential access. Stage 14 remains at clean provisional commit `ebb5a3d63eda97d80ce21bda80c5f29dc44f6ddb`; neither Stage 13 nor Stage 14 is in the other's ancestry.
- The first exact Claude Opus 5 High read-only audit invocation timed out without a report or mutation. Three subsequent exact Opus 5 High read-only passes completed. The first found six blockers (denial audit short-circuit, receipt-time idempotency, oldest-page reads, correction-window failure/chains, provider-window collapse, and Claude capacity state); the second verified those fixes and found four more (non-usage-only summary failure, later correction retraction, unscoped ledgers, and unreachable multi-signal/percentage forecasts); the final pass verified all ten fixes and found only a stale README quickstart, which was corrected before release. Its final verdict found no code, integrity, isolation, or replay blocker.

Limitations and deferred work: the Stage 3 port has no authorized delete primitive, so configured retention durations are recorded but physical journal deletion remains deferred and checkpoint-only compaction is lossless. Cross-partition idempotency/correction checks perform a bounded full-ledger scan on writes, and complete aggregate reads page through the authorized event set rather than promising a transactionally frozen multi-page snapshot. Raw history/exports deliberately retain superseded facts and must not be used to recompute corrected totals. Burn units are dimension-labelled (basis points for percentages, absolute units otherwise). Forecasts remain evidence rather than provider-policy predictions or availability promises. Stage 13 does not rank, route, retry, fall back, reserve budget/quota, admit tasks, allocate work, or integrate the provisional Stage 14 branch.

## Stage 14: Repository index, memory, artifacts, and context packs

Status: Complete.

Packages: `@ai-dev-os/repository-index`, `@ai-dev-os/memory`, `@ai-dev-os/context`

Release checkpoint:

- Exact integration base: annotated tag `v0.13.0-telemetry-ledger`, peeled commit `1c381f880caae5c0a2b5415164fc820fbea3fae3`.
- Completed provisional lane: `parallel/stage-14-context-memory` at `ebb5a3d63eda97d80ce21bda80c5f29dc44f6ddb`, based on `84f8531b16f2abf6fd201e48f868ef551d60625d`. The lane and the Stage 13 release were clean, shared that merge base, contained neither history in the other, and had zero changed-file overlap.
- Ordered cherry-pick mapping: `c961dcb00b05232adc393ace080ed257fdbda1ca` -> `a4abcf88999e6fac24d62aa41d4b0e996597ac06`; `de719376fe13d38e714a12d16082ff76d0aa792b` -> `e15a4d993b23f1434c36f4331bf5c2b19b875322`; `e48bde77ba79b21875481e1f169c5cb869f581f8` -> `5c6578c866094ddccd6cf4fb7908a3e77f0bb368`; `abfc0f3a56f8bc1d08ec8135f3de0b10e0166a1a` -> `0540e1f1e7688bcec0dc43c1de77028475977b3b`; `5c6f0e07176ac70b1a8f2833ca1b02e1d17d8b58` -> `51080b61804580bf0f020385566c91ac6aa6607a`; `8450a69627a529a239b09d1ca4132d216ed7fd89` -> `2e833f140e1ac476580dc5e058e43f6955073fe3`; `dd1488887e9e745d92d7c2b208626519b2ff368a` -> `ae9a264135f47fbb7b159d67f5ef9bca314e5a08`; `342e47a9c917b0ff2b266919dcfceceadaf7b288` -> `f57a63513f1b407263f43e33f69f73e7cdac64cc`; `ebb5a3d63eda97d80ce21bda80c5f29dc44f6ddb` -> `942b1e8b982b441eabb10cf8663306882bbdc18f`.
- Combined-workspace lock reconciliation: `89428e1b9693c686d1800df0cd00ba883efc04df`; audit remediation and regressions: `12ba241f5cd9f5019e2c9a0615ada5843b85af6b`.
- Final completion record: the commit containing this entry, released by annotated tag `v0.14.0-context-memory` (the tag is the immutable exact commit reference and can be resolved with `git rev-list -n 1 v0.14.0-context-memory`).

Delivered:

- `@ai-dev-os/repository-index` exposes deterministic `createRepositoryIndexer`, full and incremental builds, queries, strict configuration parsing, content/tombstone fingerprints, and a bounded lexical/manifest model. It reads only an already-authorized immutable `SnapshotReadPort`; direct filesystem, Git, process, environment, network, hook, filter, build, and package-manager authority is absent. Paths, case collisions, rejected-path digests, tokenization, scoring, ordering, limits, and fixed-revision validation fail closed and locale-independently. Supported manifests remain the documented npm package manifest, npm lockfile v2/v3 behavior, and TypeScript project configuration; duplicate/prototype-pollution JSON keys are rejected and unresolved formats stay unresolved. Symbol extraction is bounded regex analysis, not AST parsing.
- `@ai-dev-os/memory` exposes provenance-aware append, candidate confirmation/rejection, explicit supersession, tombstoning, queries, snapshots, configuration, and record fingerprints across organization/project/user/workspace/subject scopes. Authorization is deny-by-default and two-phase so an unauthorized caller cannot distinguish absence from denial. Every entry write and required audit event is atomic at the port, inferred candidates cannot silently replace explicit preferences, sealed replacements must carry their exact predecessor, and inactive records do not reappear through weaker fallback. The in-memory port is a deterministic reference adapter, not a crash-durable production-store claim.
- `@ai-dev-os/context` exposes deterministic packer creation, planning/building, fingerprints, summaries, and length-prefixed rendering. Repository entries, memory records, and artifact references are selected under explicit total/per-source/category byte, unit, and item budgets; every retrieved item is exactly `untrusted`; marker-like text cannot escape framing; input permutation and equal-score ties remain byte-stable. The conservative estimator is `conservative-utf8-bytes-per-3` with `exact: false` and `bytesPerUnit: 3`. Packs are returned to the caller: there is no ambient sink, prompt compiler, model/provider call, credential read, route, schedule, or source-repository mutation.
- The graph remains acyclic and narrow: repository index -> domain/artifacts; memory -> domain/artifacts; context -> domain/memory/repository-index. There is no dependency on telemetry, persistence, providers, gateway, policy, secrets, process broker, workspace, or ambient host APIs, and no pre-existing package points back into Stage 14. Stage 13 telemetry evidence and Stage 14 memory/context remain separate data and authority domains.
- Repository index/index-change/configuration schemas are version 1. Index/path/classifier/tokenizer/scoring/manifest/lexical algorithms and npm-package/npm-lockfile-v3/TypeScript-configuration parsers remain version 1. The default repository-index configuration fingerprint is `f0618354962fcd21448369d9fb8b89571e7ef25cd92234d535a935dccaba7ff5`.
- Memory record/configuration schemas remain version 1; the default memory configuration fingerprint is `083aa76b9e642e2e930d0ccdf55a74de7ee4a5f435e8370888aaa43425ad8de5`. Context schema, selection algorithm, and frame remain version 1. No serialized or fingerprinted semantic version changed merely because the commits were replayed.

Tests and gate (Windows NT 10.0.26200.0, Node 24.17.0, npm 11.13.0, Git 2.54.0.windows.1):

- Repository index: typecheck, build, 155 tests, and coverage pass at 96.13% statements (1,219/1,268), 87.53% branches (660/754), 100% functions (198/198), and 96.06% lines (1,196/1,245).
- Memory: typecheck, build, 124 tests, and coverage pass at 94.27% statements (840/891), 86.75% branches (511/589), 99.41% functions (170/171), and 94.27% lines (824/874). Two integration regressions prove a direct append with a missing or already-superseded predecessor fails before replacement state or audit events mutate.
- Context: typecheck, build, 84 tests, and coverage pass at 98.46% statements (579/588), 90.19% branches (322/357), 99.11% functions (112/113), and 98.43% lines (566/575). All three packages remain above the unchanged 90/80/98/90 gates.
- Repository aggregate: 2,262 tests pass with the same 24 expected platform/live capability skips. Numerator-weighted coverage from all 28 emitted package reports is 93.62% statements (16,618/17,749), 86.45% branches (10,955/12,672), 96.85% functions (3,234/3,339), and 94.79% lines (14,891/15,709). The exact post-fix `npm run check` passes in 1,120.8 seconds and `npm run test:coverage` passes in 462.5 seconds without a Stage 8 subprocess timeout.
- A clean `npm ci` preserves combined lockfile SHA-256 `65f7ce437a1efc99d410e35b6c7ebb82f2bb4f53bfbe3e8c90518fbaea364d9a` and reports zero vulnerabilities. `npm audit --audit-level=high` also reports zero vulnerabilities. The repository still has no lint script; none was invented or silently skipped.
- Package dry-runs contain only declared README, package manifest, compiled JavaScript/declarations/maps, and public testing artifacts: repository index 54 files / 81,325 packed bytes / 358,098 unpacked bytes; memory 46 / 58,449 / 270,714; context 50 / 52,405 / 218,972. No source, unit test, coverage, cache, or build-state file is in the payload.
- A fresh GUID-named temporary consumer packed and installed domain, artifacts, repository index, memory, and context with zero vulnerabilities. With no Vitest present it imported all three root and `./testing/fixtures` entry points, indexed and queried a fixed-revision fixture without source mutation, appended/queried scoped memory, and planned an untrusted bounded context item (`consumer-ok 0961915ed7e8bf4e24788f3dd2097083d33e054dee9ad8ee04f7990358cde286`). After Vitest was added as a dev dependency, all three declared `./testing` contract entry points resolved. The exact temporary directory was then removed.
- Static scans find zero dependency cycles, orphan Stage 14 modules, pre-existing reverse edges, tracked `dist`/coverage/`node_modules`/tarball/temp/database/journal/secret artifacts, package-private imports, conflict markers, disabled tests, direct console/environment/network/filesystem/child-process/dynamic-code calls, ambient clock/randomness, credential access, or forbidden authority-package dependencies. The only Stage 14 subpath import is the declared repository-index `./testing/fixtures` export. Credential-signature matches are confined to armed hostile-content tests, and the only forbidden-package-name match is a comment explaining why `SnapshotReadPort` avoids a workspace dependency.
- Adversarial suites cover traversal/absolute/drive/UNC/device/mixed-separator/control/case-collision paths; hostile Git metadata and manifests; duplicate/prototype-pollution JSON; deterministic exhaustion, full/incremental replay, tombstones, and permutations; scope isolation, denied-versus-absent behavior, audit failure, replay/races/expiry/revocation/tombstone/supersession and poisoned memory; injection/fake frames/NUL/control/Unicode, authorization order, stale/digest-mismatch refusal, exact budgets, leakage, and source non-mutation. Reproducible property seeds are repository index `1,7,42,1337,90210`, memory `5,23,101,4099,32768`, and context `3,11,58,719,65521`.
- Independent audit used the installed authenticated Claude Code CLI with the requested `opus` alias and High effort under plan/read-only tools. The CLI reported the actual model as `claude-opus-4-8`, not Opus 5, so no Opus 5 claim is made. A 36-turn base-to-candidate pass found no concrete release blocker and one non-blocking API-consistency defect: direct append could commit a dangling supersession replacement before returning `NOT_FOUND`. The defect was fixed with two regressions; a separate 15-turn focused read-only pass verified the fix, precedence and sealed-replacement invariants, unchanged schema/authority boundaries, and found no final blocker. Both passes preserved HEAD and worktree state.
- No provider live call, paid request, model context, repository content, credential, or user secret left the machine through product code. Only the explicitly requested independent audit prompt/diff review used the authenticated Claude CLI. Linux, macOS, CI, and real isolation backends were not executed locally. No remote is configured, so no push was performed.

Limitations and deferred work: tombstones and `observedAt` remain outside the repository content fingerprint and are covered separately; full/incremental equivalence is void only when the recorded global limit is exhausted; authorization remains a documented two-phase contract; there is no context-pack artifact sink; symbol extraction is bounded regex rather than parsing. Embeddings, vector search, learned ranking, language servers, AST evaluation, model calls, prompt compilation, routing, and provider-specific token estimation remain deferred. The in-memory memory adapter is not durable secure production storage. Production autonomous execution remains blocked until Stage 17 supplies real platform isolation backends.

## Stage 15: Replaceable thinker and deterministic prompt compiler

Status: Complete.

Packages: `@ai-dev-os/prompt-compiler`, `@ai-dev-os/thinker`

Release checkpoint:

- Exact base: annotated tag `v0.14.0-context-memory`, tag object `56bf74457911284941474987a4ec7beb912bae38`, peeled release commit `7537d5b12a980fc41f1b5f81425a0667a01ebce0`; the Stage 13 release is an ancestor.
- Isolated release lane: `feat/stage-15-thinker-prompt-compiler` in `C:\Users\mrali\Projects\ai-dev-os-stage-15-thinker`. Focused commits add the public context-pack validator (`22d4752`), prompt compiler (`923d8d5`), thinker (`cbd209f`), and workspace/lock/documentation registration (`891a8cb`). The Stage 14 source worktree remained clean and unchanged.
- Final completion record: the commit containing this entry, released by annotated tag `v0.15.0-thinker-prompt-compiler` (the tag is the immutable exact commit reference and can be resolved with `git rev-list -n 1 v0.15.0-thinker-prompt-compiler`).

Delivered:

- `@ai-dev-os/context` now exposes a complete strict `parseContextPack` public boundary. It reconstructs, freezes, and verifies externally supplied snapshots and their exact pack/request/item/omission/accounting relationships instead of trusting TypeScript assertions. Seven new regressions raise the package to 91 tests. Stage 14 documentation now assigns prompt compilation to Stage 15 while leaving provider-exact token estimation in Stage 16.
- `@ai-dev-os/prompt-compiler` exposes strict configuration/request/authorization/compiled-prompt parsers, deterministic compilation and fingerprinting, body-free summaries, deny-all and policy-aware authorizers, a reusable contract suite, and Vitest-free fixtures. Authorization is two-step and fail-closed: only an exact, current, fully allowed decision bound to subject, scope, trace, classification, target, context/evidence digests, policy fingerprint, restrictions, and proven transformations can seal an authorization.
- The compiler emits exactly three messages: fixed compiler-owned system instructions, deterministic trusted developer constraints, and the Stage 14 rendered context pack as explicitly untrusted user evidence. It emits `tools: []`, exact `toolChoice: { mode: "none" }`, and one finite strict structured-output schema. It never selects or invokes a provider, truncates trusted instructions, copies policy internals into the prompt, or calls ambient filesystem/network/process/environment/clock/random sources. Oversized inputs fail with `REPACK_REQUIRED`.
- `@ai-dev-os/thinker` exposes strict configuration/request/proposal parsers, deterministic target resolution, the provider-gateway port, proposal validation/fingerprinting/summaries, one guarded thinker lifecycle, a reusable backend contract suite, and Vitest-free fixtures. It resolves the explicit override alias or the first configured `planning` alias, rejects missing/disabled/non-inference/coding-agent targets, and never advances to another alias.
- Each think performs one compilation, one preflight, and exactly one guarded inference invocation. Request, gateway snapshot, provider instance/model, operation event, and result substitutions fail closed. Events and results are fully drained; reasoning/text/output bodies and warning bodies are discarded; tool events and non-stop finishes fail closed; close/cancel are idempotent and the post-invoke close race is covered. There is no retry, fallback, routing, quota/cost ranking, telemetry selection, second model call, task-graph mutation, execution, scheduling, or authority grant.
- Proposals use a closed bounded schema and validate exact evidence identities/digests, unique IDs/edges, an acyclic DAG, capability/edit-scope ceilings, minimum risk, and non-lowered classification. Unknown, prototype-pollution, approval, grant, secret, command, tool, and runtime-state fields fail closed. Successful values are deeply immutable, have a semantic proposal fingerprint separate from operational receipt data, and carry the literal `authority: "none"`.
- Dependencies remain public, narrow, and acyclic: prompt compiler -> context/domain/policy/providers; thinker -> config/domain/prompt-compiler/provider-gateway/providers. Neither production package imports concrete adapters, coding-agent providers, telemetry, scheduler, application, workspace, process broker, filesystem, network, credentials, or private package source. Model/provider IDs remain opaque configuration data. A concrete Claude model requires an eligible `InferenceProvider` registration; this repository still has no direct first-party Anthropic inference adapter, and Claude Code/Codex remain separate `CodingAgentProvider` surfaces blocked from production execution until Stage 17 isolation.
- Prompt compiler schema, template, authorization schema, proposal-output schema, and prompt fingerprint algorithm are version 1. Thinker configuration/result schema, plan schema, thinker/result fingerprint algorithm, and semantic plan fingerprint algorithm are version 1. The reviewed golden prompt fingerprint is `8e9b5c3af2a61c054a0e8a9d2b21116979da7bdd6fd06b55abcd1e68871d3b83`; golden changes require the explicit review/update script.

Tests and gate (Windows NT 10.0.26200.0, Node 24.17.0, npm 11.13.0, Git 2.54.0.windows.1):

- Prompt compiler: typecheck, build, golden/contract/unit/adversarial/property suites, and 35 tests pass. Coverage is 95.49% statements (445/466), 87.54% branches (253/289), 100% functions (129/129), and 96.22% lines (433/450), above the unchanged 90/80/98/90 gates.
- Thinker: the same public contract passes against two differently identified fake inference targets; typecheck, build, contract/unit/adversarial/property suites, and 69 tests pass. Coverage is 95.47% statements (591/619), 91.64% branches (406/443), 100% functions (118/118), and 96.21% lines (559/581).
- Context: 91 tests pass after the seven strict-parser regressions. Coverage is 98.47% statements (710/721), 89.28% branches (375/420), 99.27% functions (136/137), and 98.57% lines (693/703).
- Repository aggregate: 2,373 tests pass with the same 24 expected platform/live capability skips (2,397 total, 571 passing suites, zero failures), exactly reconciling Stage 14's 2,262 passes plus 111 new tests. Numerator-weighted coverage across all 30 workspace reports is 93.77% statements (17,785/18,967), 86.63% branches (11,667/13,467), 97.09% functions (3,505/3,610), and 94.91% lines (16,010/16,868).
- A clean `npm ci` preserves lockfile SHA-256 `008397bd78e19b5d0d6f0858de7790a5594981d1e3b2a3ec19e80a7ea5221b24` and audits 171 packages with zero vulnerabilities. Full `npm run check` passes in 879.003 seconds, `npm run test:coverage` passes in 485.596 seconds, and `npm audit --audit-level=high` reports zero vulnerabilities. The repository still has no lint script; none was invented or claimed.
- Package dry-runs contain only README, manifest, and intended compiled `dist` public artifacts: prompt compiler 34 files / 41,325 packed bytes / 196,731 unpacked bytes; thinker 38 / 39,767 / 185,891. No source tests, coverage, `node_modules`, tarball, journal, database, prompt capture, or credential is included.
- A fresh exact GUID-named consumer installed 13 transitive internal tarballs with zero vulnerabilities. Before Vitest existed, it imported fixture entry points, reproduced the golden prompt, resolved default and explicit alternate aliases, returned an authority-free fake-target proposal, rejected widening/poisoned output, and proved errors/inspection exclude bodies (`packed-consumer-ok 8e9b5c3af2a61c054a0e8a9d2b21116979da7bdd6fd06b55abcd1e68871d3b83 5f4179e2a8b3d2e6e947541369bc96dff5b3dcceb1c6c2fbedc883541bf21dfb`). After Vitest installation, both public contract entry points passed 6/6 tests; the consumer audit remained clean and the exact verified temporary directory was removed.
- Static scans find zero internal dependency cycles, undeclared Stage 15 imports, package-private imports, pre-existing reverse edges, orphan Stage 15 modules, tracked generated/temp/secret artifacts, workspace tarballs, conflict markers, disabled Stage 15 tests, production console/filesystem/network/process/environment/dynamic-code calls, ambient time/randomness/locale comparison, commercial model names, concrete-adapter imports, or credential signatures. The exact closed proposal and task schemas have no authority-bearing keys and set `additionalProperties: false`.
- Adversarial coverage includes injection/fake role and frame markers; Unicode/control/zero-width/bidi and exact UTF-8 boundaries; denied/conditional/stale/unavailable/malformed/substituted authorization; target/context/policy/transformation substitution; no-tools/no-second-call enforcement; stream/result/request/model disagreement; refusal/filter/length/tool finishes; cancellation/deadline/close races; malformed/prototype-polluted proposals; DAG/evidence fabrication; authority widening/risk or classification lowering; observer failures; and body-free errors/inspection/serialization. Reproducible Stage 15 property seeds are `0x15c0ffee`, `0x15da600d`, and `0x15e22025`.
- Independent audit used Claude Code CLI 2.1.201 with requested alias `opus`, High effort, plan-mode/read-only tools, and exact base/candidate SHAs. The JSON envelope reported the primary model `claude-opus-4-8` (plus auxiliary `claude-haiku-4-5-20251001` usage), 28 turns, and a $1.91774075 total. It traced all Stage 15 production boundaries and supporting released guards, found no release blocker, recorded only two non-blocking implementation observations, and returned `PASS`. No audit fix or post-fix pass was required; HEAD and clean status were identical before and after.
- No product live canary or provider/model call was run. Product code sent no prompt, context, repository content, credential, or secret externally; only the explicitly required independent Claude audit received the audit request and repository read access. Linux, macOS, CI, a real inference adapter, and real enforcing isolation were not exercised. No remote is configured, so no push is performed.

Limitations and deferred work: Stage 15 produces bounded proposals and safe receipts only. Provider-specific exact token estimators, task profiling, quota/capacity-aware ranking, cost scoring, fallback, and circuit breakers remain Stage 16; real secure platform isolation remains Stage 17; durable queues, leases, attempts, reservations, scheduling, and application lifecycle remain Stage 18; evaluators, disagreement handling, merging, and Git integration remain Stage 19. A first-party Anthropic inference adapter and later desktop/API/UI surfaces remain separate future work.

## Stage 16: Deterministic quota-aware routing engine

Status: Complete.

Packages: `@ai-dev-os/profiler`, `@ai-dev-os/router`

Release checkpoint:

- Verified predecessor: annotated tag `v0.15.0-thinker-prompt-compiler`, tag object `186af08edc740d7c024f28f301dac1c045927697`, peeled commit `62430da153e962960142865a90cbae64a2622bc9`. The tag is annotated, contains both Stage 15 public packages, is descended from the Stage 14 release, and was clean before Stage 16 work began.
- Delivery branch/worktree: `feat/stage-16-quota-aware-routing` in `C:\Users\mrali\Projects\ai-dev-os-stage-16-router`. Focused implementation commits are `1030ea935b9ba4ce6e24300d5da6f1b2435b1f72` (profiler), `b12579603eb7e0e99cda9dc7ca57bf9fed2227f1` (router), `7fb3e1c3f6e242212160f372aa8e2ef047ab9362` (independent-audit hardening), and `d5dc401f67065311e867bcdde43447f14cd032cb` (post-audit boundary tightening).
- Final completion record: the commit containing this entry, released by annotated tag `v0.16.0-quota-aware-routing` (the tag is the immutable exact commit reference and can be resolved with `git rev-list -n 1 v0.16.0-quota-aware-routing`).

Delivered:

- `@ai-dev-os/profiler` exposes strict immutable configuration, request, profile, authority-ceiling, classifier-hint, estimator-descriptor, and token-estimate boundaries; `profileTask`/`createTaskProfiler`; safe summaries; an exact-identity estimator registry; reusable contract tests; and Vitest-free fixtures. Profile provenance remains separated into declared, measured, inferred, classifier, and structured-unknown facts. Repository/context/prompt/proposal measurements are bounded summaries and never contain repository bodies, prompt text, model output, paths, identities, or secrets.
- Deterministic rules take precedence over the optional classifier fallback. The classifier is disabled by default, receives only a bounded structural input, cannot lower trusted risk/classification/authority or override measured facts, and returns a conservative structured unknown on malformed, refused, unavailable, or low-confidence output. No profiler path invokes a model by itself.
- Estimator descriptors bind an opaque provider ID, transport profile, contract model ID, catalog-model fingerprint, algorithm/evidence versions, framing proof, input bound, and accuracy class. Only complete tokenizer/framing evidence may claim `exact`; a declared conservative ratio may claim `proven-upper-bound`; heuristic estimates cannot prove hard context fit. All overhead categories and safety margins are explicit and safe-integer checked.
- `@ai-dev-os/router` exposes strict candidate/evidence/request/decision parsing, configuration, finite rejection codes, route summaries/explanations, `routeTask`/`createRouter`, a pure circuit breaker, and budget reservation/reconciliation planning. It consumes only normalized gateway/catalog, Stage 13 quota/usage/health/capacity, policy, secure-execution, estimator, configuration, and budget snapshots through public acyclic dependencies.
- Every candidate is canonicalized and hard-filtered before scoring for configuration and explicit-pin identity; policy/classification/locality/retention/training/logging/network restrictions; provider kind/capabilities/ratings; catalog enablement/freshness/free-tier proof; context/output/estimator identity and accuracy; health; exact quota scope/completeness/freshness/remaining use including reservation margin; local capacity; circuit admission; fresh secure-enforcing coding-agent evidence; exact cost/currency/budget; latency; and deadline. Unknown or stale evidence is never treated as zero or unlimited. An excluded candidate never reaches scoring or fallback selection.
- The versioned thirteen-term score vector uses bounded integer values/weights and BigInt intermediates for capability margin, quality, cost, latency, locality, alias order, verified-free evidence, quota/reset headroom, protected request/token reserve, capacity, health, context headroom, and confidence. User cost/latency/locality preferences scale soft terms only. Protected reserves are deliberately soft so a sole otherwise-feasible route is not turned into an invented outage. Stable candidate fingerprints provide the final total-order tie-break.
- Explicit aliases are strict pins unless that request explicitly permits fallback. Primary and bounded fallback choices come only from the same hard-feasible set, carry safe explanations and confidence, expire at the earliest evidence boundary, require execution-time revalidation, and state `authority: "none"`, `grantsAuthority: false`, `providerInvocationPerformed: false`, and `durableMutationPerformed: false`.
- Circuit transitions are pure, identity-bound, versioned, duplicate/out-of-order safe, and deterministic across closed/open/half-open states. Budget functions return conservative expected-version reservation and reconciliation commands plus immutable previews; they do not mutate the Stage 2 account or Stage 13 ledger. Stage 18 remains responsible for durable application.
- The router can select any eligible configured GPT or Claude inference target without hard-coded names or provider preference. Direct Claude Code and Codex remain coding-agent providers, not thinker inference models. Usage/reset evidence comes only from normalized authorized observations. Because no built-in Stage 17 backend is currently `secure-enforcing`, production autonomous coding-agent execution remains infeasible.
- Profiler configuration/profile/provenance/classifier schemas, estimator contract/token-estimate schema, and their algorithms are version 1. Router configuration/candidate/evidence/decision/circuit schemas and configuration/routing/circuit algorithms are version 1. Default configuration fingerprints are profiler `88264b130b1dd86f78211560b1a665a942cb9f938b836f0101c6a0dba8ce79c0` and router `c0e16d1839a3a26360f37be26243b01802cd41fe6d85bd8dfb5775660265579b`.

Tests and gate (Windows NT 10.0.26200.0, Node 24.17.0, npm 11.13.0, Git 2.54.0.windows.1):

- Profiler: typecheck, build, contract/unit/adversarial/property suites, and 32 tests pass. Coverage is 92.53% statements (409/442), 85.40% branches (199/233), 99.18% functions (122/123), and 93.14% lines (394/423), above the unchanged 90/80/98/90 gates.
- Router: typecheck, build, contract/golden/unit/adversarial/property suites, and 99 tests pass. Coverage is 93.73% statements (823/878), 88.40% branches (625/707), 100% functions (190/190), and 95.12% lines (781/821).
- Repository aggregate: 2,504 tests pass with 24 expected platform/live capability skips across 125 passing test files. Numerator-weighted coverage across all 32 workspace reports is 93.74% statements (19,017/20,287), 86.69% branches (12,490/14,407), 97.30% functions (3,817/3,923), and 94.88% lines (17,185/18,112). The full post-audit `npm run check` passes in 1,495.496 seconds and `npm run test:coverage` passes in 685.915 seconds.
- Manifest-driven lock regeneration produces no unexpected diff. A clean `npm ci` completes in 4.825 seconds, preserves lockfile SHA-256 `818aa42c91c84d8272eff3b4287daf554396810b5021d40244bdca65685594f6`, and reports zero vulnerabilities; `npm audit --audit-level=high` also reports zero vulnerabilities. The repository has no lint script, so none was invented or claimed.
- The reviewed golden corpus contains 20 executable scenarios spanning 87 required matrix tags. Its 21,425-byte JSON has SHA-256 `24a12fc29657d8e454102ce5876541a50efa5d4c09e518883dcb11cd219b776d`; replay verifies exact decision fingerprints and input-permutation stability, and regeneration refuses to run without explicit `--approve`. Reproducible property seeds are profiler `160316`, `160317`, `1051920` and router `160401`, `160402`, `1051921`.
- Package dry-runs contain only declared README/manifests, compiled JavaScript/declarations/maps, public testing artifacts, and the reviewed router golden: profiler 34 files / 37,821 packed bytes / 195,435 unpacked bytes; router 47 / 78,018 / 421,961. Payload scans find no source tests, coverage, `node_modules`, tarballs, databases, journals, raw telemetry, prompts, context, credentials, secrets, or temporary artifacts.
- A fresh exact temporary consumer installed the two new tarballs and their 22 additional transitive internal runtime tarballs. With Vitest absent it imported both fixture entry points and exercised two profile shapes, exact/conservative estimation, fake local/paid-cloud/verified-free/quota-limited candidates, explicit primary/alternate pins, a high-scoring policy denial, deterministic primary/fallback/no-route fingerprints, reservation/reconciliation, and a circuit transition. Repeated fingerprints were byte-identical and outputs retained zero authority/invocation/mutation. After Vitest installation, both public contract entry points passed 8/8 tests; the consumer audit reported zero vulnerabilities and the verified 1,748-file temporary tree was removed.
- Complete dependency scanning reports 32 internal packages, 103 internal edges, zero cycles, zero undeclared imports, zero package-private imports, and no reverse edge from an upstream package into profiler/router. All 8 profiler and 11 router source modules are reachable from public entries. Static scans find no tracked generated/temp/secret artifacts, conflict markers, disabled/focused Stage 16 tests, credential signatures, or production console/filesystem/network/child-process/environment/eval/ambient-clock/locale/randomness/provider-invocation/durable-mutation sinks. Fixture URLs are reserved `.invalid` evidence plus loopback; provider/capability/free-tier strings are normalized evidence, not model-name or commercial-policy heuristics.
- Adversarial tests cover malformed and prototype-polluted inputs; classifier refusal/poisoning/confidence; estimator identity/accuracy/overflow; fingerprint substitution; classification/locality/retention/training/logging/network policy; stale/future/catalog/quota/health/capacity/security evidence; exact cost/currency/budget/quota margin; incapable/unknown/unavailable models; pins/fallbacks/ties/permutations; circuit duplicates/order/races; observer failure; leakage canaries; and per-candidate arithmetic containment. Routing twice produces identical decisions and performs no provider, task-graph, workspace, process, budget-ledger, or durable account mutation.
- Independent audit used Claude Code CLI 2.1.201 with requested alias `opus`, High effort, plan-mode/read-only tools, and exact Stage 15 base/candidate SHAs. The first audit of candidate `b12579603eb7e0e99cda9dc7ca57bf9fed2227f1` reported primary model `claude-opus-4-8` (plus a small auxiliary `claude-haiku-4-5-20251001` call), 32 turns, seven valid non-blocking findings, no blocker, and `PASS`. Fixes added request-reserve use, documented soft reserve semantics, quota safety margin, secure-evidence freshness/revalidation, dependency/dead-code cleanup, router-owned estimator accuracy, and per-candidate arithmetic containment with regressions. A 22-turn post-fix pass on `7fb3e1c3f6e242212160f372aa8e2ef047ab9362` used the same requested alias/effort and reported actual `claude-opus-4-8`, no permission denials, all seven fixed, no release blockers, and `PASS`; its three non-blocking cleanup observations were also addressed and the affected package gates rerun. A final 22-turn read-only pass over exact code commit `d5dc401f67065311e867bcdde43447f14cd032cb` plus the pending release evidence again reported actual `claude-opus-4-8`, no permission denials, no evidence inaccuracy, no release blocker, and `PASS`.
- No product live canary, paid provider call, credential lookup, or privileged installation was performed. Product code sent no prompt, context, repository content, telemetry body, policy prose, credential, or secret externally; only the explicitly required independent Claude audits received their audit instructions and read-only repository access. Linux, macOS, CI, real provider quota/reset observations, production tokenizer claims, and a real enforcing isolation backend were not exercised. No remote is configured, so no push is performed.

Limitations and deferred work: Stage 16 profiles and routes fixed evidence; it does not collect provider usage, infer commercial facts, invoke a provider, execute a coding agent, persist a circuit, mutate a task graph/workspace, or durably reserve/reconcile budget. Production estimator registrations and tokenizer/framing evidence remain deployment responsibilities. Evidence may expire immediately after a decision, so Stage 18 must revalidate every declared requirement and apply version-bound commands atomically. Stage 17 must supply and prove real platform isolation before autonomous coding-agent routes can become feasible. Stage 18 adds durable scheduling/application; Stage 19 adds evaluation, disagreement handling, and Git integration. A first-party Anthropic inference adapter and later desktop/API/UI surfaces remain separate future work.

## Stage 17W: Windows production secure-execution backend

Status: Gated on Windows production evidence. **Blocks production autonomous execution.**

Package: `@ai-dev-os/process-broker` platform backends

Product scope decision (2026-08-08): the initial desktop product and Stage 17
production-release target are Windows only. `17W` names the remaining Windows
closure without renumbering completed history. Linux/macOS native enforcement,
cross-platform packaging, parity evidence, and L-02 are deferred to Stage 25.
Portable interfaces, safe denial, POSIX behavior, tests, and evidence remain in
place. See [ADR 0019](adr/0019-windows-first-production-scope.md) and the
[Windows product direction](product-direction.md).

Gated checkpoint progress (2026-08-05; not a Stage 17 release):

- Work began from the verified peeled Stage 16 release commit `c344b1e9264e5306fb648abaa7add6cebc17c3cc`. ADR 0014 defines the trust boundary: backend IDs, approved-ID filters, descriptors, probes, mocks, and successful spawn are not enforcement evidence. Production now requires an opaque backend-instance registration plus a single-use receipt from secure preparation, both bound to canonical body-free fingerprints and revalidated before spawn.
- Capability-grant schema 2 adds immutable tool references, exact environment-name authority, credential-reference fingerprints, and a separately bound control-plane endpoint-policy fingerprint. Both normal and duplex broker paths now invoke `validateGrant()` and reject identity, lease, policy, approval, tool, path, environment, credential, network, endpoint, quota, output, or deadline widening. Descriptor schema 2 distinguishes unsupported networking, deny-all workload networking, and controlled service egress.
- Enforcement-attestation schema/algorithm 1 records exact host/helper/build, boundary, quota, corpus, endpoint, observation, expiry, and limitation facts. A serializable summary always projects advisory; only revalidation of its live opaque registration can produce non-authorizing secure routing evidence. Final admission consumes an exact-bound receipt. Unconfirmed tree termination, production disposal failure, or backend close failure cannot report success and invalidates the evidence source.
- Endpoint-policy schema/algorithm 1 accepts only finite exact lowercase public DNS destinations over HTTPS port 443, rejects IP/local/internal/wildcard/IDNA/trailing-dot/proxy-style widening, disables QUIC, bounds redirects, and contains no guessed Anthropic/OpenAI domains. No relay or exact production Claude/Codex endpoint set is shipped, and no live provider or credential canary ran, so controlled service egress remains unavailable.
- Targeted measured evidence passes: process-broker 308/308 tests, including 75 explicitly non-enforcement Stage 17 parser/containment/forgery/two-phase/lifecycle tests; process-broker coverage is 90.69% statements (1,569/1,730), 85.20% branches (985/1,156), 93.39% functions (283/303), and 91.64% lines (1,514/1,652). Workspace passed 107/107 tests, Claude Code 255 passed with 7 intentional skips, and Codex 89 passed with 4 intentional skips; their typechecks and builds passed.
- The repository-wide `npm run check` passed on the post-audit code candidate in 1,320.653 seconds with 2,579 tests passing and 24 intentional skips. Aggregate coverage across 32 packages is 93.6215% statements (19,448/20,773), 86.5966% branches (12,857/14,847), 97.4359% functions (3,876/3,978), and 94.7471% lines (17,586/18,561). The aggregate coverage command completed 31 packages before a host-suspend/wrapper-timeout interruption; the sole interrupted workspace was rerun successfully at 107/107 and its fresh summary reconciled the 32-package totals. The final handoff records the exact-final-evidence-tree reruns separately.
- The reusable escape-corpus v1 contract inventories 42 deeply immutable filesystem, process-tree, IPC, network, credential, quota, and cleanup vectors and requires an armed open positive control before each candidate assertion. Its fingerprint is `125b809194d26cf1be518249b96727b78be80c25088826464ec94154a6fb3652`; 40 vectors apply to Windows and 41 each to Linux and macOS. Opaque registration now rejects a substituted version, fingerprint, or shortened host count. It has not run against a native backend: actual enforcement tests and positive controls are 0 on Windows, Linux, and macOS. The machine-readable truth table is `docs/release-evidence/stage-17-platform-truth-table.json`.
- An independent read-only audit requested Claude Opus at High effort and actually reported `claude-opus-4-8` (with `claude-haiku-4-5-20251001` used only by the CLI support path). It found one valid non-blocking medium future-soundness issue: registration did not pin the canonical corpus identity/count. Commit `11c0a41beb1f61bc7330d1e06f464cc8f1dfbb38` fixed it with regressions; a fresh focused Opus/High post-fix audit passed with no residual finding. HEAD and status were unchanged by both audits.
- Static, dependency, secret, install-script, package, and consumer checks are recorded in `docs/release-evidence/stage-17-gated-checkpoint.md`. Fresh packed consumers proved the public root/testing imports, private issuer export boundary, opaque-forgery refusal, canonical corpus identity, unavailable platform selection, unsafe production refusal, body-free errors, and zero audit vulnerabilities.
- Observed host: Windows 11 Pro 10.0.26200 build 26200, x64, Node 24.17.0, npm 11.13.0, Git 2.54.0.windows.1, .NET SDK 9.0.316; no C/C++ compiler/Windows SDK, WSL, container CLI, VM CLI, Linux/macOS runner, configured Git remote, or executable CI surface was available. Checked-in CI names Ubuntu and Windows only and cannot be treated as an execution result without a remote/run.
- Windows continuation checkpoint: a warnings-as-errors, dependency-free .NET 9 evidence tool loaded the exact System32 `processmodel.dll`, reproduced its SHA-256 `eff290093568efbe27f3918112f3b5f44e8980412d07addfcd69ca7a03f61049`, and confirmed both experimental sandbox exports plus the documented public AppContainer/Job/restricted-token export set. Its ordinary probe/self-test path is read-only, the tool is not packaged as a production helper, and Windows actual-native corpus evidence remains 0/40.
- The experimental path is blocked because Microsoft documents schema `0.1.0` and FlatBuffer identifier `SBOX` but neither the installed host nor the published Microsoft documentation/source provides the authoritative `SandboxSpec.fbs` table layout or generated bindings. Field ordinals were not inferred and no unofficial dependency was copied. The preferred path remains the documented public Win32 AppContainer plus creation-time Job-list composition.
- After explicit authorization, protocol version 2 created exactly one uniquely named same-user test AppContainer profile with zero capabilities and one matching task-owned ACL directory, launched no workload, observed the folder/mapping/storage/ACL state, restored the exact original DACL, freed the returned SID, deleted the directory and profile with one successful delete call, and independently found zero measured folder, registry, mapping, storage-key, or ACL-directory residue. This removes the profile-lifecycle feasibility blocker only; it proves no process identity, filesystem denial, network denial, Job ownership, quota, crash, packaging, or escape-corpus boundary. ADR 0015 and `docs/release-evidence/stage-17-windows-profile-lifecycle-proof.md` record the exact evidence.
- After fresh explicit authorization, protocol version 3 proved one final synthetic process composition on the same host. A byte-matched staged System32 `cmd.exe` was created suspended with a zero-capability AppContainer identity, a private kill-on-close/no-breakaway/one-process Job list, and an explicit two-handle list in one `STARTUPINFOEX`. Before resume, the token matched the profile SID with zero capabilities and the private Job contained exactly one process; the fixed built-in marker then exited zero. All process/Job/ACL/file/directory/profile/registry cleanup passed, and a generic independent scan found zero residue across the implementation attempts. No provider, repository workload, production helper, registration, receipt, or corpus vector ran. This removes only the narrow identity/creation-time-Job feasibility blocker; `docs/release-evidence/stage-17-windows-synthetic-process-proof.md` records the exact boundary.
- After another explicit authorization, protocol version 4 replaced the shell marker with a digest-pinned structured fixture. A fixed staged read succeeded; staged write and protected same-user canary access were denied; eight normal and eight `CREATE_BREAKAWAY_FROM_JOB` attempts were natively denied under the one-process/no-breakaway Job. Live parent TCP/UDP loopback controls passed. The AppContainer TCP connect timed out and neither a TCP connection nor UDP datagram reached the parent, although bind/listen and UDP `SendTo` returned success and are truthfully not represented as denied. Normal cleanup and an independent generic residue scan passed. This is a bounded feasibility slice, not a production helper or any of the 40 Windows corpus vectors; `docs/release-evidence/stage-17-windows-structured-boundary-proof.md` records the exact result.
- A final explicit bounded authorization advanced the evidence protocol to version 5 and placed the reviewed composition behind a finite test-only helper/controller protocol. Normal lifecycle, client disconnect before target creation, and actual exact-handle helper termination after setup, with the target suspended, while running after READY, and after target exit all passed. The controller-owned private Job drained to zero active processes, no descendant survived, every helper/controller handle closed, and each independent/post-recovery/final residue scan was zero. Three failed development attempts remain recorded as failed and recovered. Cumulative authorization use was 9 profiles, 9 helpers, 7 AppContainer fixtures, and 2 ordinary fixture controls (18 total helper/fixture processes), within 10/10/20 caps. Process-broker typecheck/build, 319/319 tests, 92.36/85.92/98.32/92.99 coverage, and a 102-file package dry run with zero native entries passed. This removes only the bounded test-helper lifecycle/crash-recovery feasibility blocker; it is not a production helper or corpus evidence. `docs/release-evidence/stage-17-windows-helper-lifecycle-crash-proof.md` records the exact result.

- The native handle-relative proof installer replaced PowerShell as filesystem security authority (ADR 0018), and an independent audit of it returned FAIL with three HIGH findings, every one inside the boundary ADR 0018 section 7a identifies as unverifiable by simulation: an ancestor-chain link the simulation supplied and the adapter did not, two information-class ordinals from the wrong Win32 enum family with a FALSE return read as end-of-enumeration, and a per-handle byte offset that was never reset so a re-measurement hashed zero bytes. All three are fixed with observable regressions, twelve defect proofs were run by reintroducing each guarded defect against a copy of the source, and a second independent audit returned PASS. Measured: sealed 150 vectors and reviewed-proof 190 vectors both passing with verifiably distinct digests; repository-wide 2,684 tests passing with 24 intentional skips; process-broker coverage 92.53/86.00/98.34/93.66 against 90/80/90/90 floors, up on all four axes with no threshold modified. The fix changed no truth state: `docs/release-evidence/stage-17-native-installer-audit-fix.md` records the checkpoint, and the native marshalling layer still has never executed.
- GitHub became the remote system of record. The repository is private, `main` carries the completed release lineage plus governance and deliberately no Stage 17 code, and the Stage 17 branch is pushed, unmerged, and untagged. The first CI run on Linux — the first this repository has ever had — found exactly two genuine defects across 32 packages, recorded as L-01 and L-02 in `docs/development/github-workflow.md` and deliberately not fixed under CI time pressure: a `provider-claude-code` security assertion that passes on Windows only because Windows takes the other branch of a workspace-scoped-home decision, and `@ai-dev-os/workspace` coverage floors that platform-specific branches make unreachable on Linux. No test was weakened and no threshold lowered. Secret scanning, push protection, and private vulnerability reporting are unavailable for this plan and are recorded as unavailable rather than worked around.
- Exact two-parent candidate `e06db598bc14238156b8d7b378320e35b2e064cf`
  composes the completed L-03 canonical tool-containment repair, strengthened
  L-01 fresh-home/environment/cleanup contract, and exact lockfile-only audit
  repair into Stage 17W. Its parents are Stage 17
  `dd5617d04957108b1847d0f1bac4b38ef08a93c7` and stack
  `bfb06ff54fa0902908a7769d9e4d6a8d18e77604`. It resolves one transitive
  `nanoid@3.3.18`, has zero audit findings, received an independent Claude Opus
  4.8/max read-only `PASS` with no findings, and passed Ubuntu check, Windows
  check, coverage, and dependency audit in hosted run `31275835049`. The
  candidate is not a production release or target-branch integration;
  production remains unavailable and fail-closed.

- Defensive Stage 17W implementation checkpoint (2026-08-09; not a release):
  the sealed supervisor and helper now contain the ordinary installed-closure,
  exact-handle process topology, target-at-creation containment, bounded
  journal/cleanup/recovery, and fixed body-free provider-canary paths that a
  production runtime would need. Fault injection and installation remain in
  separately identified proof-only components whose mutating commands require
  an explicit reviewed-proof build and whose identities are excluded from
  production discovery and npm packaging. A checked runtime projection keeps
  production code independent of the retained feasibility assembly while a
  static parity gate prevents drift. Two clean direct publish sets were
  byte-identical for each affected production artifact; their exact 193-file
  union is compiled into the proof installer's reviewed candidate table with
  source-envelope fingerprint
  `16f327aa858f25e85c9f335d658e1879d1c93729940648df19cd6966326eb5c8`.
  Pure native self-tests and the 176-test Stage 17 static/security slice pass.
  No stateful lifecycle or live provider canary ran, no production fingerprint
  was admitted, and the separately required safety-gated operation remains
  unrun. ADR 0020 and
  `docs/release-evidence/stage-17w-defensive-implementation-checkpoint.md`
  define the exact implementation/evidence boundary.

Release consequence: Windows production enforcement remains unavailable and
unverified beyond the bounded profile, synthetic identity/Job, structured
filesystem/loopback/process-count, and test-helper lifecycle/crash-recovery
feasibility observations. General filesystem/network/credential/IPC/quota,
production-crash, installed-artifact, packaging, controlled-egress, and all 40
Windows vectors remain unproved. Windows therefore remains unavailable,
production continues to refuse, Stage 17W remains gated, Stage 18 remains
blocked, and no Stage 17 release tag may be created from this checkpoint.
Linux and macOS also remain unavailable and unverified, but their absent native
evidence is assigned to Stage 25 and is not, by itself, an initial Windows-only
release blocker.

Deliverables:

- A Windows restricted-identity plus creation-time Job backend classified
  `secure-enforcing` only after it genuinely enforces the complete filesystem,
  process-tree, credential, IPC, network, cleanup, and quota contract.
- An approved Windows egress path permitting exact reviewed provider service
  destinations while denying other network access.
- Portable platform interfaces and fail-closed Linux/macOS probes retained for
  Stage 25 rather than treated as Windows-release evidence.

Tests and gate:

- The complete armed 40-vector Windows corpus runs with positive controls on the
  exact installed supervisor/helper and reviewed production composition.
- Installed-artifact lifecycle, fail-closed supervisor recovery,
  handle-relative containment, controlled provider egress, packaging, cleanup,
  and every existing Windows gate pass on exact reviewed heads.
- The production admission gate admits the Windows backend only after its
  enforcement is demonstrated, not declared.
- Until Stage 17W lands, production autonomous execution continues to refuse
  before any agent process starts.

## Stage 18: Durable orchestration and usage-aware authorized-profile routing

Status: In progress, production-disabled. Stage 18A, 18B, and 18C checkpoints
are published and exact-head green. Stage 18D adds the real PostgreSQL adapter,
hosted-service contract/concurrency gates, a refusal-only application admission
schema, and the first machine-checkable full acceptance matrix. Production
admission remains blocked on Stage 17W and no Stage 18 checkpoint changes that
gate. The matrix currently keeps the direct live Anthropic canary, supported
live Account Manager reader, and external-mutation crash proof incomplete;
Stage 18D's bounded process-separated scheduler claim/retry proof remains
pending its exact-head hosted PostgreSQL run. Query-native, high-throughput team
scheduling remains a deployment-scale nonclaim rather than a Stage 18
development-acceptance item. This is therefore not yet a claim that the entire
Stage 18 development scope is complete.

Packages, in implementation order: `@ai-dev-os/provider-anthropic`,
`@ai-dev-os/product-planning`, `@ai-dev-os/scheduler`,
`@ai-dev-os/application`, `@ai-dev-os/persistence-postgres`, plus a
usage-snapshot adapter boundary selected only after the Account Manager
investigation.

Deliverables:

- Request acceptance, planning commands, bounded dynamic graph mutation,
  durable scheduling, application lifecycle, and restart-safe reconciliation.
- A first-party direct Anthropic `InferenceProvider` adapter, separate from
  Claude Code, with a fixed versioned endpoint/profile, scoped secret
  references, operator-supplied catalog facts, strict capability preflight,
  bounded streaming/structured output, normalized usage, cancellation,
  retention disclosure, and substitution rejection. Claude Code sessions do
  not satisfy this inference adapter.
- The bounded product-completeness planning assembly defined by ADR 0016,
  including product discovery, specialist gaps, engineering feasibility,
  synthesis, explicit dispositions, scope decisions, and requirement-to-task
  coverage.
- Durable ready queues, attempts, leases, heartbeats, fencing, retries,
  capacity pools, fairness, cancellation, budget reservation, terminal
  reconciliation, and exact restart replay.
- PostgreSQL contract parity for deployments that require multi-process
  scheduler coordination; the initial Windows single-user desktop remains on
  SQLite, and this adapter does not authorize the later team deployment.
- Usage-aware dispatch using task capability, model suitability, five-hour and
  weekly usage, reset times, source/freshness, ownership, authorization, policy
  caps, and recent failures. Hard policy runs before scoring.
- Only explicitly authorized profiles are eligible. Borrowed Claude workspace
  profiles may serve allowed Claude Code tasks with models such as Opus or
  Sonnet, but never Fable 5. Weekday 09:00-through-17:00 usage in the configured
  work timezone (default `Europe/London`) has a hard 50-percent five-hour
  ceiling; a hard 70-percent weekly ceiling applies at all times. Predicted work
  may not knowingly cross either active ceiling, and stale, unavailable,
  ambiguous, or inconsistent capped-profile usage fails closed.
- Source-attributed normalized usage snapshots carrying profile/window identity,
  observed/reset times, timezone, freshness, and authoritative-versus-estimated
  status without credentials or cross-profile leakage.
- A separately authorized, commit-pinned, all-files review of
  [`alijabbar04/ai-account-manager`](https://github.com/alijabbar04/ai-account-manager),
  tracing usage/session/profile data, authority, credentials, isolation,
  API/IPC/database/export surfaces, and license/reuse constraints. Prefer a
  read-only adapter; do not scrape its installed UI.

The detailed profile rules are normative in the
[Windows product direction](product-direction.md).

Tests and gate:

- The Anthropic adapter passes the shared contract, adversarial transport,
  credential/policy ordering, substitution, cancellation, and explicit opt-in
  live-canary gates.
- Integration and chaos tests cover planning dispositions, route independence,
  bounded growth, parallel DAGs, duplicate delivery, lease expiry, daemon and
  worker crashes, cancellation, fallback, budgets, and restart without duplicate
  Git or external mutation.
- Usage tests cover both time boundaries, weekdays/weekends, timezone and DST,
  each hard ceiling, predicted overrun, resets, freshness, conflicting sources,
  ownership, revocation, profile isolation, audit redaction, and fail-closed
  dispatch. A scoring preference can never revive an ineligible profile.
- The authoritative status is
  [`stage-18-development-acceptance-matrix.json`](release-evidence/stage-18-development-acceptance-matrix.json).
  A row can be only `proven`, `production-gated`, or `incomplete`; narrative,
  review, CI, branch names, and the presence of files cannot substitute for the
  exact implementation/test/evidence anchors required by a proven row.

## Stage 19: Evaluation, disagreement handling, and integration

Status: Stage 19A evaluation checkpoint published; Stage 19B production-disabled
implementation candidate present, with acceptance incomplete.

Packages: `@ai-dev-os/evaluation`, `@ai-dev-os/integrator`

Stage 19A checkpoint: `@ai-dev-os/evaluation` provides bounded exact-subject
deterministic evidence evaluation, externally configured subject-bound exact
criterion manifests plus exact evidence-instance and canonical waiver-digest consumption,
model-disagreement preservation, authority-free completeness findings, and an
exactly replayed `evaluation-run` persistence aggregate. It remains literal
production-disabled. `@ai-dev-os/integrator` now supplies a production-disabled
exact-request domain, serialized durable intent/receipt/recovery protocol, and a
test-only disposable real-Git port. The full named B3 adversarial repository
fixture matrix below is implemented against actual disposable Git trees.
Stage 19B acceptance remains incomplete pending publication and exact-head
hosted CI; its definitive local gates and independent read-only source review
are complete.

Deliverables:

- Output-schema, changed-path, compilation, test, static-analysis, and acceptance-criteria evaluators.
- Requirement-coverage evaluators that reconcile the approved product specification through explicit requirement-to-task-to-result edges, task results, integrated repository state, deterministic validation, externally preauthorized waiver digests, and unresolved gaps.
- A separately routed final completeness audit for material product work. It may propose missing requirements or corrective tasks, but it cannot mark an unsupported requirement complete, widen scope, authorize execution, or override deterministic evidence.
- Deterministic structured merge strategies and serialized Git integration.
- Structural, scope, semantic, intent, and specification conflict detection, plus a rubric-based independent evaluator and fresh-worktree resolution flow. Dissenting security/feasibility findings and all planning dispositions remain visible to arbitration.

Tests and gate:

- Fixture matrix includes clean merges, textual conflicts, non-overlapping semantic breaks, stale target, failing resolver, fabricated tests, policy violations, missing required features, partially implemented user journeys, lowered acceptance criteria, undocumented waivers, narrative-only completion claims, and post-integration regressions.
- A run cannot reach normal completion while a required or expected-quality coverage entry lacks valid evidence or an authorized waiver. Delight and deferred candidates remain visible without blocking unless explicitly promoted through a scope decision.
- No model verdict can mark deterministic validation as passed or authorize a merge.

## Stage 20: Typed loopback command and notification boundary

Status: Planned.

Packages: `@ai-dev-os/api`, `@ai-dev-os/client`

Deliverables:

- Fastify `/v1` command/query API, OpenAPI document, generated TypeScript
  client, finite error envelope, and one typed command/notification contract
  shared by local and later external adapters.
- Loopback session authentication, strict origins, request limits, idempotency,
  replay protection, recipient/channel identity, approval binding, and redacted
  notifications.
- Read-only product-intent, planning-contribution, specification, disposition,
  coverage, routing, profile-usage, and evidence projections plus exact,
  idempotent scope and approval decisions. Hidden reasoning, credentials, and
  raw provider bodies are excluded.
- WebSocket/SSE cursor replay, slow-client handling, artifact download policy,
  daemon lifecycle, single-instance lock, connection descriptor, health, and
  diagnostics.
- A durable emergency-stop state and typed pause/kill command that can be
  projected consistently into the desktop and future messaging channels.
- Free-form inbound text remains untrusted task input and cannot directly
  authorize a side effect, approval, permission change, or recipient.

Tests and gate:

- API and command-boundary tests cover authentication, origin, schema,
  idempotency, duplicate delivery, replay, approval digest binding, emergency
  stop, rate limits, reconnect, cursor replay, and daemon restart.
- Fuzz tests cover JSON limits, event versions, hostile free-form content,
  recipient substitution, notification redaction, and out-of-order commands.

## Stage 21: Windows desktop application and setup wizard

Status: Planned.

App: `apps/desktop`

Deliverables:

- Electron main/preload/renderer split with no Node integration in the renderer.
- A modern, aesthetic, dark, uncluttered, accessible design system using
  progressive disclosure.
- **Normal mode** for everyday tasks, progress, approvals, results, compact
  health/usage indicators, pause/kill, and essential controls without default
  exposure of implementation internals.
- **Developer mode** for routing decisions, provider/profile telemetry, policy
  traces, process details, logs, evidence, diagnostics, and advanced settings.
  The mode changes visibility, not authorization or safety policy.
- Product blueprint, user journeys, dispositions, exact scope decisions,
  coverage, completeness findings, task DAG, attempts, timeline, estimates
  versus actuals, projects, memory, approvals, conflicts, and settings.
- A planning review surface that accepts, defers, rejects, or clarifies material
  inferred requirements and keeps incomplete, unvalidated, or waived scope
  visible.
- A setup wizard using approved provider installation and credential mechanisms
  only, plus opt-in capacity collection.
- Reconnect/replay behavior, bounded live logs, sanitized Markdown/diffs,
  cancellation, exact approval detail, a visible high-risk-authority state, and
  one-click pause/kill.
- A future Fable 5 review gate for meaningful wireframes/prototypes and the
  implemented desktop experience when that capability is available. Fable
  review remains advisory, and borrowed profiles are never eligible for it.

Tests and gate:

- Component, accessibility, and Playwright Electron tests cover both modes,
  progressive disclosure, window sizes, long content, reconnect, daemon
  restart, active cancellation, emergency stop, approvals, unsafe links, IPC
  sender validation, CSP, and non-overlap screenshots.
- Developer mode cannot bypass policy, and the wizard never offers a credential
  mechanism outside the published provider boundaries.
- Meaningful design artifacts and the implemented experience carry the required
  Fable 5 review disposition once an owned, authorized route is available;
  deterministic accessibility and security gates remain authoritative.

## Stage 22: Discord-first communication adapters

Status: Planned after the Stage 20 typed boundary.

Deliverables:

- Discord first: a private allowlisted bot/channel with outbound progress,
  approval, and completion updates; typed slash commands; idempotency and replay
  protection; emergency stop; and configurable tone and notification policy.
- Telegram second behind the exact same typed command/notification,
  authentication, approval, redaction, and emergency-stop boundary.
- WhatsApp later only after a separate current API, business, cost, privacy,
  retention, and operations assessment. No WhatsApp implementation is assumed.
- Free-form inbound messages remain untrusted task input, never direct
  authority. Default outbound messages exclude source code, raw logs, secrets,
  credentials, and sensitive artifacts.

Tests and gate:

- Adapter contract tests cover allowlists, typed command parsing, sender and
  channel substitution, duplicate delivery, replay, stale approval,
  notification redaction, delivery failure, emergency stop, and revocation.
- No adapter can grant authority, widen a Stage 20 command, select a new
  recipient implicitly, or bypass current production-execution refusal.

## Stage 23: Windows packaging, update, recovery, and operations

Status: Planned after desktop workflow validation.

Deliverables:

- Windows application packaging and an explicit installed-artifact layout with
  immutable component identity and no hidden install hooks.
- Versioned update, side-by-side transition, rollback, removal, quarantine, and
  crash-recovery behavior that preserves fail-closed execution.
- Backup/restore, retention/export/delete workflows, support diagnostics,
  dashboards, alerts, incident runbooks, kill switch, and operational readiness
  checks.
- A versioned release-truth schema/generator follow-up if required to represent
  implemented, measured, verified, supported-target, deferred, and unavailable
  states independently, while preserving every historical evidence artifact.
- SBOM, provenance, license, dependency, installer, and update metadata inputs.
  Signing design may be prepared, but no signing or availability claim follows
  without separately authorized credentials and measured artifacts.

Tests and gate:

- Clean install/update/rollback/removal, interrupted transition, downgrade and
  replay refusal, quarantine, daemon/worker restart, backup/restore, and
  deterministic package-identity tests run without weakening Stage 17W.
- Taxonomy fixtures prove deferred is not passing, target is not availability,
  and missing or contradictory evidence fails closed; historical evidence bytes
  and hashes remain unchanged.

## Stage 24W: Windows production hardening and readiness

Status: Planned.

Deliverables:

- Windows-only provider hardening, controlled egress, sandbox integration,
  operational circuit handling, production diagnostics, and cost anomaly alerts.
- Signed release/installer/update and rollback planning with protected trust-root
  requirements. Signing execution remains a separately authorized release
  operation and may not be simulated into a success claim.
- Versioned evaluation suites for product discovery, irrelevant-feature control,
  specialist gaps, synthesis preservation, requirement traceability,
  implementation evidence, routing calibration, and final completeness.
- Threat-model review and external penetration testing focused on repository,
  process, desktop, provider/profile, messaging, update, and project-isolation
  boundaries.
- Final Windows production-readiness evidence bound to exact reviewed source,
  package, installer, supervisor/helper, policy, and provider configurations.

Release gate:

- Every applicable production release gate in the technical design passes for
  the Windows target; recovery, cancellation, budget, audit, accessibility, and
  operations objectives are measured rather than assumed.
- Stage 17W secure isolation and controlled egress are available on the exact
  advertised Windows matrix. No unproved Windows version, architecture,
  installer, signer, or update channel is advertised.
- Documentation covers installation, provider setup, profile ownership and
  budgets, data handling, backups, permission modes, security limits,
  communication boundaries, and incident recovery.
- Linux and macOS remain explicit deferred/non-target platforms rather than
  passing results or Windows-release blockers.

## Stage 25: Deferred portability

Status: Deferred until the Windows product and release gates are complete.

Deliverables:

- Linux namespace/cgroup/filesystem/network/credential/cleanup enforcement on
  actual supported Linux hosts, plus the complete armed Linux corpus.
- A supported documented macOS containment and credential-isolation foundation
  on actual supported macOS hosts, plus the complete armed macOS corpus.
- L-02 Linux workspace-coverage closure without lowering thresholds, hiding
  platform branches, or moving failures behind `continue-on-error`.
- Linux/macOS desktop/native integration, installers, updates, recovery,
  packaging, accessibility, operations, and parity evidence.
- Cross-platform release-truth projections using the ADR 0019 taxonomy. A
  platform becomes a supported target only through an explicit later product
  decision and becomes available only after its independent gates pass.

Tests and gate:

- Each platform runs its own positive-control escape corpus, packaging lifecycle,
  provider egress, credential isolation, desktop/API, update/rollback, recovery,
  and accessibility gates on exact reviewed artifacts.
- Portable interfaces and Windows behavior remain stable; no platform's result
  is inferred from compilation, mocks, workflow YAML, or another OS.

## Post-Stage 25 backlog: extensions and team deployment

The former Stage 22 plugin-SDK plan and Stage 23 optional team/remote-worker
plan remain desired but are moved out of the numbered Windows release path.
Their stage numbers will be assigned only by a later product decision.

- The extension track retains signed manifests, versioned JSON-RPC, lifecycle,
  grants/revocation, secret brokering, provider/routing/memory/validator/tool/MCP
  extension points, capability-diff approval, and hostile-plugin gates.
- The team track retains production hardening for the Stage 18 PostgreSQL port,
  encrypted S3-compatible artifacts, TLS/OIDC/RBAC/tenant scopes, remote audit,
  concurrent workers, backup/restore/failover, and penetration testing.
- Neither track may bypass platform isolation, add untrusted plugins before a
  supported sandbox exists, or widen the initial Windows single-user release.

## Recommended release slices

| Release | Included stages | User-visible outcome |
| --- | --- | --- |
| `0.1` orchestration core | 0-7, 11-13 | Durable read-only multi-model planning with local models, cloud inference, and a unified usage ledger |
| `0.2` isolated coding | 8-10, 14-16 | Claude Code and Codex edits in managed worktrees with context packs and quota-aware routing |
| `0.3` contained orchestration | 17W-19 | Windows-gated autonomous execution with durable planning, usage-aware routing, scheduling, evaluation, and integration |
| `0.4` desktop and communications | 20-22 | Typed local control boundary, Normal/Developer Windows desktop, Discord-first communication, and Telegram follow-up |
| `1.0` Windows readiness candidate | 23-24W | Packaged, recoverable, reviewed Windows product only after every exact release gate passes |
| Later portability | 25 | Independently verified Linux/macOS enforcement, packaging, and parity before either platform is advertised |
| Later extensions/team | Unnumbered post-25 backlog | Plugin SDK and optional authenticated team/remote-worker deployment after separate product decisions |

Release `0.2` delivers coding adapters whose production execution still refuses.
No `0.3`, `0.4`, or `1.0` availability is claimed here: autonomous repository
execution can run only after Stage 17W makes Windows containment and controlled
egress real on the exact advertised target.

## Immediate next module after this delivery

Stages 0 through 16 are complete. Stage 17W remains gated. The exact integration
candidate `e06db598bc14238156b8d7b378320e35b2e064cf` is reviewed and hosted-green,
but that does not advance containment truth. The Windows profile lifecycle,
synthetic zero-capability AppContainer plus creation-time private-Job
composition, bounded structured filesystem/loopback/child-attempt fixture, and
six-scenario test-helper lifecycle/crash-recovery matrix pass only within their
recorded evidence boundaries.

The smallest next action requires separate authorization: run the bounded
Windows native installed-artifact and production-supervisor lifecycle/recovery
proof from the exact reviewed documentation head. Production must remain
unavailable, and the armed 40-vector Windows corpus must not run until that
stateful lifecycle proof and its preconditions pass. Stage 18 must not start in
place of that closure.

No built-in backend is currently `secure-enforcing`, so production autonomous
execution still refuses before any agent process starts. The initial product
requires a genuinely enforcing Windows backend; Linux/macOS implementations and
their actual-platform evidence are deferred to Stage 25, not inferred from
Windows results or represented as passing.
