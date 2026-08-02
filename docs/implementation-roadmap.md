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

Status: Planned.

Package: `@ai-dev-os/artifact-store-local`

Deliverables:

- Streaming writes with maximum size, digest verification, atomic rename, encryption hook, and metadata transaction.
- Safe reads, reference tracking, retention, delayed orphan collection, export, and deletion.
- Structured redaction pipeline for text artifacts and logs.

Tests and gate:

- Partial write, collision, tamper, disk-full, concurrent writer, oversized payload, traversal, symlink/junction, and cleanup tests.
- Artifact content never becomes trusted because its digest matches.

## Stage 5: Provider contracts and deterministic fakes

Status: Planned.

Packages: `@ai-dev-os/providers`, `@ai-dev-os/provider-testkit`

Deliverables:

- Separate inference-provider and coding-agent-provider interfaces.
- Versioned manifests, model capabilities, health, normalized stream events, usage, cancellation, and reconciliation.
- Scriptable fake inference server and fake coding-agent CLI.
- Shared adapter contract suite for malformed streams, duplication, latency, failure, and cancellation.

Tests and gate:

- Every provider behavior can be exercised without network access or paid tokens.
- Stream parsers are fuzzed and enforce event and output bounds.
- A provider transport success cannot bypass result validation.

## Stage 6: Configuration, secrets, and policy broker

Status: Planned.

Packages: `@ai-dev-os/config`, `@ai-dev-os/policy`, `@ai-dev-os/secrets`

Deliverables:

- Schema-versioned default, user, project, profile, and run configuration layers.
- Locked settings that lower layers cannot weaken.
- OS-keychain secret references and sanitized process environments.
- Deny-by-default action-intent policy, capability grants, one-shot approvals, and audit decisions.
- Data disclosure, egress, filesystem, process, Git, package, and budget policies.

Tests and gate:

- Precedence, unknown key, locked policy, secret redaction, and rotation tests.
- Property tests for path/action normalization and approval digest binding.
- A model response cannot create or approve a capability grant.

## Stage 7: Ollama provider and local capacity manager

Status: Planned.

Package: `@ai-dev-os/provider-ollama`

Deliverables:

- Native Ollama discovery, health, streaming chat, structured output, reasoning, usage, cancellation, and keep-alive integration.
- Configurable role preferences for DeepSeek R1, Gemma, Mistral, Qwen, and Llama families.
- Local model digest catalog, concurrency semaphore, load/unload policy, and resource telemetry.
- Capability-aware fallback rather than exact-name assumptions.

Tests and gate:

- Fake-server contract tests cover missing model, malformed stream, disconnect, slow load, cancellation, and overload.
- Opt-in live tests run against every installed configured model with fixed prompts and no repository writes.
- Ollama is verified loopback-only before autonomous use.

## Stage 8: Workspace and process isolation

Status: Planned.

Packages: `@ai-dev-os/process-broker`, `@ai-dev-os/workspace`

Deliverables:

- Repository discovery and immutable clean/dirty snapshot capture without mutating the user tree.
- Dedicated worktree lifecycle, sanitized Git configuration, hook suppression, restricted protocols, diff and commit manifests.
- Structured argument-array process execution, quotas, output limits, process-tree cancellation, and lease enforcement.
- Pluggable Windows, macOS, and Linux sandbox backends with an explicitly labeled unsafe development backend.

Tests and gate:

- Temporary-repository matrix covers dirty trees, untracked files, hooks, filters, submodules, remotes, locks, conflicts, and target movement.
- Hostile fixtures cover traversal, symlinks, Windows junctions/reparse points, environment theft, process escape, unlimited output, and cancellation.
- Production mode refuses autonomous repository execution without an approved secure isolation backend.

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

Stages 1 through 3 are complete: the task-graph kernel, the domain vocabulary, and the persistence contract with in-memory and SQLite adapters are stable. Implement Stage 4 (content-addressed artifact store) next, or Stage 5 (provider contracts and deterministic fakes) if artifact byte storage is not yet needed. Do not begin provider adapters or autonomous repository execution before their contracts and fakes exist.
