# AI Development OS Implementation Roadmap

Status: Active  
Last updated: 2026-08-02

## Delivery rule

Implementation proceeds one dependency-ordered module at a time. A module advances only when its public contract, failure behavior, tests, type check, production build, and relevant security checks pass. The main branch must remain buildable between modules. External-provider tests use deterministic fakes in normal CI and budget-capped live canaries outside pull-request CI.

## Status legend

| Status | Meaning |
| --- | --- |
| Complete | Acceptance gate passes and deliverables are committed |
| In progress | Current implementation slice |
| Planned | Contract is identified but implementation has not started |
| Gated | Requires a prior security, credential, platform, or product decision |

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
- Child environments constructed from an empty baseline with a finite platform allowlist, workspace-scoped temporary/profile/config locations, deterministic locale, and an explicit PATH; home, SSH, askpass, credential-helper, cloud, registry, CI, language-startup, Git-redirection, and proxy variables are absent. Secrets resolve late, are scoped to one invocation, are literally redacted from captured output across chunk boundaries, and never reach results, audit records, or errors.
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

## Stage 9: Claude Code coding-agent adapter

Status: Planned after Stage 8.

Package: `@ai-dev-os/provider-claude-code`

Deliverables:

- CLI version/capability probe and compatibility matrix.
- Non-interactive machine-readable streaming execution in a granted worktree.
- Permission broker integration, tool restrictions, budget/turn caps, cancellation, session IDs, and reconciliation.
- Changed-file, commit, validation, usage, and diagnostic artifact extraction.

Tests and gate:

- Fake CLI covers every exit mode, partial edit, malformed line, nested process, timeout, permission request, and restart case.
- Opt-in installed-CLI canary performs a read-only task and an isolated disposable-repository edit.
- Production configuration prohibits permission bypass.

## Stage 10: OpenAI inference adapter

Status: Gated for live tests by an OpenAI secret reference; implementation and fake tests do not require a key.

Package: `@ai-dev-os/provider-openai`

Deliverables:

- Responses API structured output, tool events, streaming, background status, cancellation, continuation, and reconciliation.
- Runtime model capability/pricing catalog with configuration override and effective-time snapshots.
- Token-category and cost ledger integration, provider retention controls, and safety identifier support.

Tests and gate:

- Fake HTTP contract tests cover throttling, retry headers, background polling, stream resume, malformed usage, storage policy, and cancellation races.
- Budget-capped live canary uses a configured secret reference and records no key or prompt secret.
- No permanent model ID is embedded in domain or routing logic.

## Stage 11: Profiler, estimators, and routing engine

Status: Planned.

Packages: `@ai-dev-os/profiler`, `@ai-dev-os/router`

Deliverables:

- Repository-aware task profile with measured context and schema-validated classifier fallback.
- Provider-specific token estimators and conservative fallback bounds.
- Cost reservation and actual reconciliation using versioned pricing.
- Duration quantiles using queue, provider, tool, test, and integration components.
- Hard feasibility filters, configurable score terms, task-kind outcome priors, confidence, fallbacks, circuit breakers, and explanations.

Tests and gate:

- Golden routing corpus covers task types, repository scales, privacy, health, cost, context, local capacity, preferences, and low confidence.
- Invariants prove hard constraints cannot be overridden by classifier output or learned scores.
- Offline replay measures selection accuracy, calibration, cost, latency, and fallback behavior.

## Stage 12: Durable scheduler and run coordinator

Status: Planned.

Packages: `@ai-dev-os/scheduler`, `@ai-dev-os/application`

Deliverables:

- Request acceptance, planning commands, bounded dynamic graph mutation, and complete run lifecycle.
- Durable ready queues, attempt creation, leases, heartbeats, fencing, retries, capacity pools, fairness, cancellation, and reconciliation.
- Budget reservation before dispatch and release/reconciliation after terminal attempts.
- Transactional state and event changes with resumable publication.

Tests and gate:

- Integration tests cover parallel DAGs, dependency failures, duplicate delivery, expired leases, daemon and worker crashes, cancellation races, provider fallback, budget exhaustion, and dynamic graph limits.
- Chaos tests prove restart recovery without duplicate Git integration or external mutation.

## Stage 13: Repository index, memory, preferences, and cache

Status: Planned.

Packages: `@ai-dev-os/repository-index`, `@ai-dev-os/memory`, `@ai-dev-os/cache`

Deliverables:

- Commit/file-digest repository map, manifest/dependency extraction, incremental lexical index, and context packer.
- Provenance-aware facts, decisions, summaries, explicit preferences, inferred candidates, confirmation, expiry, and supersession.
- Hybrid lexical retrieval with optional embedding port.
- Scope-complete reusable cache with validation and retention policies.

Tests and gate:

- Cross-project and cross-user isolation, poisoned memory, stale snapshot, deletion, expiry, and provenance tests.
- Cache-key property tests cover every provider, policy, repository, schema, tool, and security dimension.
- Retrieved content remains untrusted prompt material.

## Stage 14: Evaluation, merge, and disagreement resolution

Status: Planned.

Packages: `@ai-dev-os/evaluation`, `@ai-dev-os/integrator`

Deliverables:

- Output-schema, changed-path, compilation, test, static-analysis, and acceptance-criteria evaluators.
- Deterministic structured merge strategies and serialized Git integration.
- Structural, scope, semantic, and intent conflict detection.
- Rubric-based independent evaluator and fresh-worktree resolution flow.

Tests and gate:

- Fixture matrix includes clean merges, textual conflicts, non-overlapping semantic breaks, stale target, failing resolver, fabricated tests, and policy violations.
- No LLM verdict can mark deterministic validation as passed or authorize a merge.

## Stage 15: Versioned API and event streaming

Status: Planned.

Packages: `@ai-dev-os/api`, `@ai-dev-os/client`

Deliverables:

- Fastify `/v1` command/query API, OpenAPI document, generated TypeScript client, idempotency middleware, and error envelope.
- Loopback session authentication, strict origins, request limits, WebSocket/SSE event replay, slow-client handling, and artifact download policy.
- Daemon lifecycle, single-instance lock, connection descriptor, health, and diagnostics.

Tests and gate:

- API contract, auth, origin, schema, idempotency, rate, reconnect, cursor replay, and daemon restart tests.
- Fuzz tests cover JSON limits and event payload versioning.

## Stage 16: Desktop dashboard

Status: Planned.

App: `apps/desktop`

Deliverables:

- Electron main/preload/renderer split with no Node integration in the renderer.
- Runs, task DAG, attempts, timeline, estimates versus actuals, routing explanation, provider health, projects, memory, approvals, conflicts, plugins, and settings.
- Accessible dense operational UI, reconnect/replay behavior, bounded live logs, sanitized Markdown/diffs, cancellation, and exact approval detail.
- Signed package and update configuration for supported platforms.

Tests and gate:

- Component and Playwright Electron tests cover desktop/mobile-sized windows, long content, reconnect, daemon restart, active cancellation, approvals, unsafe links, IPC sender validation, CSP, and non-overlap screenshots.
- Release artifact passes Electron security checklist, signature, install, update, rollback, and uninstall tests.
- The daemon URL is printed for browser-based development; packaged desktop uses the authenticated local descriptor.

## Stage 17: Plugin host

Status: Planned.

Package: `@ai-dev-os/plugins`

Deliverables:

- Signed manifest validation, versioned JSON-RPC stdio, lifecycle, health, timeouts, cancellation, grants, revocation, and secret broker.
- Provider, routing-strategy, memory, validator, and tool extension points with explicit compatibility versions.
- Admin/user installation and upgrade workflow with capability-diff approval.

Tests and gate:

- Hostile plugin fixtures cover malformed RPC, crashes, hangs, oversized messages, spoofed identity, permission expansion, secret requests, path escape, and network denial.
- General third-party installation remains disabled until the supported OS sandbox passes its security review.

## Stage 18: PostgreSQL and team deployment

Status: Planned after desktop workflow validation.

Packages: `@ai-dev-os/persistence-postgres`, team deployment assets

Deliverables:

- PostgreSQL implementation of every persistence contract and concurrent lease semantics.
- S3-compatible encrypted artifact adapter, TLS, OIDC, RBAC, tenant scopes, remote audit export, quotas, backup, restore, and operations runbooks.
- Horizontal API and worker scaling with measured need; no change to domain behavior.

Tests and gate:

- Cross-adapter contract suite, concurrency/load tests, tenant isolation, rolling migration, backup/restore, failover, and disaster recovery exercises.
- External penetration test before team general availability.

## Stage 19: Production hardening and release

Status: Planned.

Deliverables:

- OpenTelemetry dashboards and alerts, incident runbooks, kill switch, circuit operations, retention/export/delete workflows, and support diagnostics.
- SBOM, provenance, license report, signed releases, verified updates, rollback, and dependency policy.
- Versioned evaluation suite, live-provider canaries, routing calibration process, and cost anomaly alerts.
- Threat-model review and external penetration test focused on repository, process, plugin, desktop, and cross-project boundaries.

Release gate:

- All production release gates in the technical design pass.
- Secure isolation is available on each advertised platform.
- Recovery, cancellation, budget, and audit objectives are measured rather than assumed.
- Documentation covers installation, provider setup, data handling, backups, security limits, and incident recovery.

## Recommended release slices

| Release | Included stages | User-visible outcome |
| --- | --- | --- |
| `0.1` orchestration core | 0-7, 10-12 | Durable read-only multi-model planning and routing with local models and fakes |
| `0.2` isolated coding | 8-9, 14 | Claude Code edits in managed worktrees with deterministic validation and integration |
| `0.3` memory and API | 13, 15 | Persistent multi-project daemon with repository intelligence and full API |
| `0.4` desktop | 16 | Operational desktop dashboard and approvals |
| `0.5` extensions | 17 | Trusted signed plugins with explicit grants |
| `1.0` hardened desktop | 19 | Signed, recoverable, audited single-user production release |
| `1.x` team | 18 plus team hardening | Authenticated concurrent service deployment |

## Immediate next module after this delivery

Stages 1 through 8 are complete: the task-graph kernel, the domain vocabulary, persistence, artifact byte storage, the provider contracts, configuration/secrets/policy, the Ollama adapter, and now workspace and process isolation. Implement Stage 9 (Claude Code coding-agent adapter) next; it consumes the workspace grant, the managed worktree, and the process broker delivered here.

One constraint carries forward and must not be quietly dropped: no built-in sandbox backend is currently classified secure-enforcing, so production autonomous execution refuses to start. Stage 9 can be developed and tested against the explicitly unsafe development backend, but shipping autonomous repository execution to users requires a real enforcing backend on each advertised platform first.
