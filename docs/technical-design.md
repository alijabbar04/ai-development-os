# AI Development OS Technical Design

Status: Accepted baseline  
Version: 0.3
Last updated: 2026-08-14

## 1. Executive summary

AI Development OS is a local-first control plane for software engineering agents. It converts a user request into a validated task graph, selects models through a policy-constrained router, executes independent work concurrently in isolated repository snapshots, validates and integrates the results, and records enough state to explain and recover every decision.

The system is not a conversational wrapper. Conversation is one input and presentation mechanism. The durable unit of work is a `Run`; its executable plan is a directed acyclic graph of typed `Task` records; and every side effect occurs through a policy-authorized `Attempt` with an auditable execution lease.

The initial product is a Windows-only single-user desktop application backed by
a local daemon and SQLite. Portable domain and application seams are retained
for later platforms and a future team deployment, but neither is part of the
initial production-release target. The first release is a modular monolith with
isolated worker processes. It does not begin as a fleet of microservices.

## 2. Scope

### 2.1 In scope

- Request analysis, task classification, complexity estimation, token and cost estimation, and duration prediction.
- Bounded product discovery, specialist gap analysis, engineering feasibility, specification synthesis, and requirement-to-evidence coverage tracking for material product work.
- Configurable model routing using deterministic rules, live capabilities, learned outcome statistics, and a structured LLM classifier.
- Static and dynamically extended task graphs with bounded parallel execution.
- OpenAI Responses API, a direct Anthropic inference adapter, Claude Code CLI, and native Ollama adapters.
- Repository discovery, commit-scoped indexing, Git worktree isolation, deterministic validation, and controlled integration.
- Conflict detection, independent review, evidence-based disagreement resolution, and human approval gates.
- Persistent project memory, explicit user preferences, provenance-aware retrieval, and scoped caching.
- Multi-project operation, Windows desktop monitoring, observability, and recovery after crashes.

### 2.2 Non-goals for the first production release

- A general autonomous computer operator.
- Unattended publication, deployment, force-push, or destructive repository operations.
- Training or fine-tuning foundation models.
- A public plugin marketplace accepting untrusted native code.
- Linux or macOS desktop/native integration, packaging, or production support;
  those are deferred to Stage 25 without deleting portable seams.
- Exactly-once execution. The scheduler is at-least-once and side effects are made idempotent or reconciled.
- Automatic trust in model consensus. Deterministic validation and policy always take precedence.

### 2.3 Product scope and release truth

[ADR 0019](adr/0019-windows-first-production-scope.md) defines the initial
Windows-only target and the independent states `implemented`, `measured`,
`verified`, `supported production-release target`, `deferred/non-target`, and
`unavailable/blocked`. Target status never grants availability, and deferral is
never rendered as passing. Detailed future UI, profile-routing, authority, and
communication requirements are in the
[Windows product direction](product-direction.md).

## 3. Architectural principles

1. **Policy before intelligence.** Models may propose tasks, routes, commands, memory, and resolutions. Deterministic code validates and authorizes them.
2. **Durable state before streaming state.** The database is authoritative. UI streams are projections that can be replayed.
3. **Typed artifacts before prose handoffs.** Tasks exchange schemas, diffs, commits, test manifests, and content-addressed artifacts.
4. **Isolation before parallel writes.** Every repository-writing attempt uses its own recorded snapshot and managed worktree.
5. **Capabilities before product names.** Roles map to required capabilities. Model and provider identifiers remain configuration and runtime catalog data.
6. **Local first, not local only.** Sensitive projects can be kept entirely local, while approved projects can use remote providers.
7. **Explain every route.** Candidate rejection reasons, score components, price snapshots, health, and confidence are persisted.
8. **Bound every recursive process.** Graph size, fan-out, depth, attempts, tool calls, tokens, money, wall time, and output bytes all have limits.
9. **Treat all content as untrusted.** Repository text, tool output, memories, model output, plugins, and remote responses can contain prompt injection or hostile data.
10. **Keep the control plane small.** The trusted core contains domain invariants, policy, leases, credentials, audit, and persistence transactions. Provider and plugin processes remain outside it.
11. **Trace scope to evidence.** A run is not complete because an agent says it is. Every approved requirement is implemented, explicitly waived, or left visibly incomplete, with acceptance evidence and provenance.

## 4. System context

```mermaid
flowchart LR
  User[Developer] --> Desktop[Electron desktop]
  Desktop -->|HTTP commands and event stream| API[Local control API]
  API --> App[Application coordinator]
  App --> Router[Routing engine]
  App --> Scheduler[Durable scheduler]
  App --> Memory[Memory and repository index]
  Scheduler --> Workers[Isolated workers]
  Workers --> OpenAI[OpenAI Responses API]
  Workers --> Anthropic[Anthropic inference API]
  Workers --> ClaudeCode[Claude Code CLI]
  Workers --> Ollama[Local Ollama]
  Workers --> Git[Managed Git worktrees]
  App --> Store[(SQLite or PostgreSQL)]
  App --> Artifacts[(Content-addressed artifacts)]
  App --> Events[Audit and telemetry]
```

### 4.1 Runtime processes

| Process | Responsibility | Trust level |
| --- | --- | --- |
| Electron renderer | Dashboard presentation and user input | Untrusted renderer |
| Electron main | Window lifecycle and narrow authenticated bridge | Trusted but capability-minimal |
| Control daemon | API, application use cases, routing, policy, scheduling, persistence | Trusted control plane |
| Worker supervisor | Starts isolated attempts and enforces leases and quotas | Trusted enforcement boundary |
| Attempt worker | Provider adapter and task-specific tools | Untrusted workload |
| Plugin host | Versioned plugin RPC and capability mediation | Untrusted extension |
| SQLite/PostgreSQL | Durable metadata, event journal, indices, and ledgers | Trusted persistence |
| Artifact store | Immutable large payloads addressed by digest | Untrusted content, integrity checked |

The Electron main process launches or discovers exactly one local daemon using an OS-level lock. The daemon listens on a random loopback port and writes a user-readable-only connection descriptor containing a short-lived session credential. A future team daemon uses TLS, OIDC, RBAC, PostgreSQL, and remote artifact storage instead of desktop session authentication.

## 5. Technology baseline

| Concern | Choice | Rationale |
| --- | --- | --- |
| Language | Strict TypeScript on Node.js 22.9+ | Shared contracts across daemon, workers, adapters, and desktop; mature process and SDK support |
| Control API | Fastify with JSON Schema/OpenAPI | Low overhead, explicit validation, streaming support, testable injection model |
| Desktop | Electron, React, Vite, TanStack Query | Direct local process integration and a thin recoverable UI projection |
| Local database | SQLite in WAL mode | Zero-administration, transactional desktop persistence |
| Team database | PostgreSQL | Concurrent leasing, operational tooling, row-level access patterns, optional vector extension |
| SQL access | Kysely plus explicit migrations | Typed queries without hiding transaction and locking semantics |
| Artifact storage | Local content-addressed files; S3-compatible adapter later | Deduplication, integrity checks, and portable metadata |
| Validation | JSON Schema at boundaries; strict TypeScript internally | Provider-neutral schemas and runtime safety |
| Telemetry | OpenTelemetry, structured JSON logs, append-only usage ledger | Correlated traces and vendor-neutral export |
| Tests | Vitest, property tests, provider contract fixtures, Playwright | Fast domain tests plus real desktop and repository behavior |

Dependency versions are pinned in the lockfile. Automated update pull requests run compatibility, provider-contract, desktop, and security suites before merge.

## 6. Module architecture

Dependencies point inward: adapters depend on application ports; application depends on domain; domain has no I/O dependencies.

| Module | Primary responsibility | May depend on |
| --- | --- | --- |
| `domain` / `task-graph` | IDs, tasks, graph invariants, artifacts, budgets, state transitions | Standard library only |
| `application` | Request lifecycle, run coordinator, use cases, transaction boundaries | Domain ports |
| `product-planning` | Product intent, bounded planning phases, contribution/disposition schemas, and coverage invariants | Domain, task-graph, thinker/router ports |
| `scheduler` | Readiness, leases, heartbeats, retry policy, capacity, cancellation | Domain, persistence ports, policy port |
| `router` | Profiling, feasibility filters, scoring, fallback, decision explanation | Domain, provider catalog ports, metrics ports |
| `providers` | Normalized inference and coding-agent contracts | Domain contracts |
| `provider-openai` | OpenAI Responses adapter | Provider contract, OpenAI SDK |
| `provider-anthropic` | Direct Anthropic inference adapter | Provider contract, bounded HTTPS transport |
| `provider-claude-code` | Claude Code process adapter and reconciliation | Coding-agent contract, process broker |
| `provider-ollama` | Ollama inference and local capacity adapter | Provider contract, HTTP client |
| `workspace` | Repository snapshots, worktrees, diffs, validation, integration | Git/process ports, policy |
| `memory` | Facts, decisions, preferences, repository index, retrieval, cache | Domain, storage and embedding ports |
| `evaluation` | Schema checks, critics, deterministic validators, arbitration | Domain, provider and workspace ports |
| `plugins` | Manifest discovery, compatibility, RPC, permission grants | Domain, policy and process ports |
| `persistence` | SQLite/PostgreSQL repositories, migrations, outbox, artifact metadata | Application ports |
| `api` | Authenticated HTTP commands, queries, OpenAPI, event replay | Application use cases |
| `desktop` | Dashboard, query cache, projections, approvals | Generated API client only |
| `observability` | Trace propagation, redaction, metrics, audit and usage events | Cross-cutting ports |

Provider adapters, plugins, persistence implementations, and the UI do not call one another directly.

## 7. Core domain model

### 7.1 Principal records

| Record | Purpose |
| --- | --- |
| `Project` | Repository roots, data policy, configuration, budgets, memory scope |
| `RepositorySnapshot` | Immutable source identity: project, Git SHA, dirty overlay digest, index version |
| `Run` | One accepted user objective and its global budgets and outcome |
| `ProductIntent` | User outcomes, audiences, constraints, non-goals, assumptions, and unresolved questions derived without widening authority |
| `ProductSpecification` | Versioned approved scope containing stable requirements and their dispositions |
| `PlanningContribution` | One phase- and route-attributed set of candidate requirements, risks, conflicts, and unknowns |
| `CoverageEntry` | Trace from one requirement to tasks, implementation artifacts, validation evidence, waiver, and completion state |
| `Task` | Typed unit in a run DAG, with dependencies and acceptance criteria |
| `TaskEdge` | Dependency relation between tasks |
| `Attempt` | One leased execution of a task by one provider/model in one workspace |
| `Artifact` | Immutable typed output with digest, media type, schema, size, and provenance |
| `RoutingDecision` | Complete candidate set, filters, score terms, selected route, and confidence |
| `Approval` | One-shot authorization bound to a normalized action digest |
| `Memory` | Scoped, sourced, confidence-bearing fact, decision, or summary |
| `Preference` | Explicit preference or untrusted inferred candidate pending confirmation |
| `ProviderHealth` | Capability and availability snapshot used for a route |
| `UsageEntry` | Immutable estimated/reserved/actual token, money, time, and local compute ledger entry |
| `DomainEvent` | Ordered fact emitted by a successful state transaction |

### 7.2 Task specification

Each task includes:

- Stable task ID, kind, title, objective, and priority.
- Stable requirement IDs covered by the task; every approved requirement must be covered by at least one task or an explicit waiver.
- Dependency task IDs and typed input artifact references.
- Declared output artifact schemas.
- Required capabilities such as reasoning, repository read, code edit, shell, testing, or documentation.
- Workspace mode: none, immutable snapshot, or isolated writable worktree.
- Acceptance criteria and deterministic validation commands.
- Data classification and allowed provider classes.
- Token, cost, duration, retry, tool-call, output-size, and recursion budgets.
- Idempotency class: pure, replayable, reconcilable, approval-bound, or irreversible.
- Merge strategy and files or ownership areas when known.

### 7.3 State machines

Task states are:

```text
pending -> ready -> running -> succeeded
                    |  |  |
                    |  |  +-> failed
                    |  +----> waiting -> running
                    +-------> needs_resolution -> running

pending/ready/running/waiting/needs_resolution -> cancelled
pending/ready -> blocked when an upstream dependency ends unsuccessfully
```

Attempt states are separate from task states:

```text
leased -> running -> succeeded
   |         |  +-> failed
   |         +----> cancelled
   +--------------> abandoned
```

The separation is essential: a retry creates a new attempt while the task can remain logically runnable. Terminal task failure occurs only after retry policy or a non-retryable failure is resolved.

All mutations use optimistic aggregate versions. The persistence adapter reads pending events without removing them, saves the current state and idempotent event inserts in one transaction, commits, and only then acknowledges the persisted event sequence in memory. A rollback leaves the events available for retry.

## 8. End-to-end request lifecycle

1. **Accept.** Validate project, objective, requested scope, data policy, and budget. Create an immutable request artifact and `Run`.
2. **Inspect.** Capture a repository snapshot and retrieve high-signal structure, manifests, ownership rules, prior decisions, and explicit preferences.
3. **Profile.** Produce a schema-validated `TaskProfile` with kind, complexity, context need, risk, edit scope, reasoning need, and confidence.
4. **Estimate.** Predict input/output tokens, provider cost, queue time, execution duration ranges, local compute load, and validation time.
5. **Frame.** Compile a `ProductIntent` that separates explicit outcomes and constraints from inferred assumptions, candidate opportunities, non-goals, and questions requiring the user.
6. **Discover.** For material product work, a product-discovery route proposes a broad but bounded set of user journeys, expected-quality requirements, edge cases, and optional delight candidates. Simple bounded work may collapse this and the next two phases into one planning pass.
7. **Challenge.** Independent specialist routes inspect the framed intent and discovery contribution for material gaps such as security, privacy, accessibility, data lifecycle, failure recovery, testing, operations, and maintainability. An engineering-feasibility route checks the repository and implementation constraints.
8. **Synthesize and scope.** A separate synthesis route produces one cited specification and a disposition for every contributed requirement. Deterministic code rejects silent omission, duplicate identities, unsupported scope widening, or an unbounded graph. Material inferred scope requires an approval before it becomes executable.
9. **Validate plan.** Deterministic code checks requirement coverage, acyclicity, scopes, permissions, budgets, graph quotas, schemas, and provider feasibility.
10. **Route.** Filter impossible candidates, score eligible routes, reserve budget, and persist the routing decision.
11. **Dispatch.** The scheduler leases ready tasks subject to project fairness, provider rate limits, local compute capacity, and workspace locks.
12. **Execute.** A worker receives a scoped lease, sanitized context pack, provider request, workspace grant, and cancellation signal.
13. **Collect.** Stream normalized events to durable storage. Store large or sensitive payloads as redacted content-addressed artifacts.
14. **Validate.** Check schemas, diffs, allowed paths, compilation, tests, static policy, task-specific acceptance criteria, and linked requirement evidence.
15. **Integrate.** Serialize repository integration in dependency order. Revalidate against the current target snapshot.
16. **Resolve.** Use deterministic merge conflict detection first. A resolver model may propose a patch, but validation and policy decide acceptance.
17. **Review.** An independent quality route examines the combined result and evidence, not merely individual outputs.
18. **Audit completeness.** A completeness route compares the approved specification and coverage matrix with the integrated result. It may identify gaps but cannot declare an unsupported requirement complete or authorize more work.
19. **Complete.** Deterministic completion requires every required requirement to have valid evidence or an explicit waiver. Reconcile actual usage, create the run summary, propose durable memories, and expose provenance and remaining gaps in the dashboard.

Every step is resumable after a daemon restart from the database, attempt leases, provider IDs, worktrees, commits, and artifact digests.

### 8.1 Product-completeness planning assembly

The normative planning decision is recorded in [ADR 0016](adr/0016-product-completeness-planning-assembly.md).

The planning assembly is a bounded protocol, not a model committee and not an authority transfer. The application coordinator invokes finite operation classes such as `product-discovery`, `specialist-gap-analysis`, `engineering-feasibility`, `plan-synthesis`, and `completeness-audit`. Each operation is routed independently through the existing capability, policy, locality, quota, cost, and health constraints. Deployment configuration may prefer different provider/model aliases for these operations, but production code never derives a role from a commercial model name.

Each planning contribution is immutable and contains stable candidate requirement IDs, source references, affected user journeys, priority class, assumptions, conflicts, risks, and proposed acceptance evidence. Priority classes are `required`, `expected-quality`, `delight`, and `deferred-candidate`. A contribution grants no scope or execution authority.

Synthesis must emit a disposition for every candidate: `accepted`, `deferred`, `rejected`, `duplicate-of`, or `needs-user-decision`. Accepted requirements retain source provenance and receive stable specification IDs. Rejection and deferral require bounded reasons; dissent and unresolved uncertainty remain visible. Majority vote, model self-confidence, or a more capable model label cannot settle a policy, security, scope, or validation question.

The coverage matrix maps every accepted requirement to user journeys, tasks, acceptance criteria, validation commands or review rubrics, implementation artifacts, and final evidence. Required and expected-quality entries block normal completion until satisfied or explicitly waived by an authorized actor. Delight entries never become executable merely because a model proposed them. The initial request and any later approval define the scope ceiling.

Configuration bounds the phase count, specialist set, candidate requirements, synthesis rounds, graph expansion, provider calls, tokens, money, wall time, and output bytes. High-risk or material greenfield work requires an authoring route and an independent review route when policy has an eligible alternative. If independence cannot be achieved, the run records that limitation and follows the configured approval or conservative-failure path rather than disguising self-review.

## 9. Task graph and scheduler

### 9.1 Graph rules

- Planning may add nodes and edges atomically until the graph is sealed.
- Dynamic expansion after sealing is a separate validated command and is bounded by maximum nodes, depth, fan-out, and remaining budget.
- A task becomes ready only when all dependencies succeed.
- An unsuccessful dependency blocks downstream work recursively.
- Topology changes never occur through raw database writes.
- Ready order is deterministic by priority and stable insertion order before scheduler fairness and capacity constraints are applied.
- Cancellation is hierarchical: run cancellation revokes leases, stops process trees, and marks remaining tasks without erasing partial evidence.

### 9.2 Leasing and recovery

The scheduler provides at-least-once execution:

1. Atomically select a ready task and create an attempt and expiring lease.
2. Reserve provider and budget capacity in the same transaction.
3. Start the worker with an unforgeable lease token scoped to project, snapshot, worktree, actions, deadline, and limits.
4. Renew the lease through heartbeats and persist provider continuation identifiers.
5. On completion, reconcile artifacts and side effects before committing attempt success.
6. If the worker disappears, wait for lease expiry, inspect its worktree/provider state, and then mark succeeded, failed, or abandoned before retry.

SQLite desktop mode has one authoritative scheduler process and multiple isolated workers. Team mode uses PostgreSQL row locks with `SKIP LOCKED` semantics and fencing tokens. Both implementations satisfy the same scheduler contract.

### 9.3 Idempotency

- Provider calls carry an attempt ID and provider-supported idempotency key where available.
- Generated files live only in the attempt worktree until integration.
- Commits and artifacts are content-addressed and can be reconciled after a crash.
- External mutations such as push or deployment require approval, record an action digest, and use a dedicated idempotency record.
- Retries never assume a timed-out call failed. The adapter must reconcile when the provider exposes continuation or response status.

### 9.4 Capacity and fairness

Resource pools cover remote concurrency, provider rate limits, local CPU, local RAM, GPU/VRAM, worktree count, disk, and per-project concurrency. Weighted fair queuing prevents one project or recursive plan from monopolizing workers. Backpressure stops new admissions before resource exhaustion.

## 10. Intelligent routing

### 10.1 Task profile

The request analyzer emits a versioned structure containing:

```ts
interface TaskProfile {
  kind: "plan" | "architecture" | "implement" | "refactor" | "debug" |
    "review" | "test" | "document" | "shell" | "explain" | "transform";
  complexity: 1 | 2 | 3 | 4 | 5;
  repositoryFiles: number;
  repositoryBytes: number;
  relevantContextTokens: number;
  expectedOutputTokens: number;
  reasoning: "low" | "medium" | "high" | "extreme";
  editScope: "none" | "single-file" | "multi-file" | "cross-package";
  risk: "low" | "medium" | "high" | "critical";
  requiredCapabilities: string[];
  dataClass: string;
  confidence: number;
}
```

Repository metrics are measured. Token counts use provider-compatible tokenizers where available and conservative byte-based bounds otherwise. Complexity combines deterministic features with a structured classifier. Duration estimates are ranges, not single promises, and include provider queue, inference, tools, tests, and integration.

### 10.2 Routing pipeline

1. **Hard feasibility filters:** data policy, capabilities, context window, required tools, repository write support, model health, authentication, budget, deadline, plugin grants, and local resource availability.
2. **Rule route:** high-confidence rules select routine specialist work without an LLM classifier.
3. **Classifier route:** low-confidence requests use an inexpensive structured classifier. Its output is schema-validated and cannot override hard constraints.
4. **Candidate scoring:** eligible candidates receive an explainable score.
5. **Fallback construction:** persist an ordered fallback chain before dispatch.
6. **Reservation:** reserve the p90 estimated cost and capacity; reconcile with actual usage later.

Stage 18 extends hard feasibility with authorized profile ownership and
source-attributed five-hour/weekly usage windows. Borrowed-profile ceilings,
freshness, reset, timezone, and fail-closed rules are normative in the
[Windows product direction](product-direction.md). A usage cap is an admission
rule, never a score term, and a profile identifier never grants credential or
execution authority.

The supported Account Manager route is an exact-pinned, read-only input to this
policy rather than an authority source. A bounded reader emits only one
allowlisted `claude-code` profile observation; the application adapter binds
the reviewed commit/tree/artifact, a nonsecret canonical reader-configuration
fingerprint, and a separately trusted ownership/authorization/revocation
projection before constructing a canonical snapshot. The historical fixture
route remains for deterministic compatibility. No installed-state read ran in
the implementation checkpoint, so `AM-02` and all production use remain gated.
One later authorized read failed closed on the pre-repair route. The reader
repair is published exact-head green, but the preserved AI Development OS
consumer candidate was safety-blocked before publication and no post-repair
installed-state read ran; `AM-02` therefore remains incomplete.

A baseline score is:

```text
utility =
    qualityWeight     * predictedSuccess
  - costWeight        * normalizedCost
  - latencyWeight     * normalizedP90Duration
  + localityWeight    * localPreference
  + reliabilityWeight * recentReliability
  + preferenceWeight  * explicitUserFit
  - queueWeight       * normalizedQueueDelay
```

`predictedSuccess` uses task-kind-specific Beta priors and decayed observed outcomes. Latency uses rolling quantiles. Exploration is disabled for high-risk tasks and tightly bounded elsewhere. Model-generated quality scores never update success statistics until deterministic checks or an explicit user outcome provide a label.

### 10.3 Confidence and escalation

- High-confidence, low-risk selections execute directly within policy.
- Low-confidence selections can request one independent classifier or use the configured conservative route.
- Critical tasks can require plan review, implementation, and independent review by different routes.
- Material greenfield product work uses separately routed discovery, feasibility, synthesis, and completeness operations; a single model response is not treated as exhaustive coverage.
- Independence is an evidence property bound to route/provider/model and contribution fingerprints. When required, an author cannot satisfy its own independent-review slot.
- If top candidates disagree within a configured margin, the router favors the lower-risk candidate or asks for approval rather than creating false precision.

### 10.4 Configured role policies

The requested default roles are represented as editable policy, not source-code conditionals:

| Logical role | Default route policy |
| --- | --- |
| Product discovery and architecture | Approved planning inference route with high/extreme reasoning, sufficient context, strict structured output, and strong product/architecture evidence |
| Engineering feasibility | Repository-aware planning route with coding, dependency, testing, and estimation evidence |
| Specification synthesis | Planning route selected independently from discovery when required; must preserve contribution provenance and emit complete dispositions |
| Primary implementation, broad refactor, complex debugging, repository editing | Eligible coding-agent route with fresh secure-execution evidence |
| Independent review and completeness audit | Review route distinct from the author when policy requires independence; consumes specification, coverage, and deterministic evidence |
| Reasoning, planning, algorithms | Local `deepseek-r1:8b` preference |
| Documentation, summaries, Markdown | Local `gemma3:12b` preference |
| Shell, scripting, lightweight code | Local `mistral:7b` preference |
| Tests, regular expressions, transformations | Local `qwen3:8b` preference |
| Explanation and lightweight interaction | Local `llama3.2:3b` preference |

The named local entries are editable deployment examples, not semantic inference from model strings. A deployment can map maximum-capability, balanced-synthesis, coding-specialist, free-tier, and local-private aliases differently as catalogs change. The operation class and verified capabilities determine eligibility.

Health, data policy, measured performance, context fit, and budget can override a default preference. The routing decision records that override.

## 11. Provider framework

Inference providers and autonomous coding agents have different contracts:

```ts
interface InferenceProvider {
  describe(): ProviderManifest;
  listModels(signal?: AbortSignal): Promise<ModelDescriptor[]>;
  health(signal?: AbortSignal): Promise<HealthReport>;
  invoke(
    request: InferenceRequest,
    context: AttemptContext,
  ): AsyncIterable<NormalizedProviderEvent>;
  cancel(attemptId: string): Promise<void>;
  reconcile(attemptId: string): Promise<ReconciliationResult>;
}

interface CodingAgentProvider {
  describe(): ProviderManifest;
  health(signal?: AbortSignal): Promise<HealthReport>;
  start(
    request: CodingRunRequest,
    workspace: WorkspaceGrant,
    context: AttemptContext,
  ): AsyncIterable<CodingRunEvent>;
  cancel(attemptId: string): Promise<void>;
  reconcile(attemptId: string): Promise<ReconciliationResult>;
}
```

Normalized events cover lifecycle, text deltas, reasoning summaries where policy allows them, tool intents, tool results, file changes, usage, warnings, errors, and terminal results. Raw provider events can be retained as encrypted diagnostic artifacts subject to retention policy, but application logic consumes only normalized events.

### 11.1 OpenAI adapter

- Use the Responses API for reasoning, structured outputs, tools, streaming, and provider continuation.
- Support foreground streaming and background responses for long work. Persist response identifiers before polling or reconnecting.
- Expose model capabilities and pricing through a versioned runtime catalog. Do not hardcode a permanent flagship model ID.
- Record input, output, cached, and reasoning token categories exactly as returned.
- Make provider storage and retention behavior explicit per project; support `store: false` where compatible with the selected execution mode.
- Use a stable privacy-preserving safety identifier when configured for multi-user service mode.
- The adapter is disabled until a secret reference is configured. Keys never enter project configuration or worker-wide environments.

### 11.2 Anthropic inference adapter

- Implement the provider-neutral `InferenceProvider` contract over one reviewed, versioned first-party Anthropic API profile; do not route inference through Claude Code or reuse its account/session state.
- Require an explicit operator catalog entry and permitted-model binding. Ship no permanent model IDs, role inference from names, guessed context limits, or guessed prices.
- Map only capabilities proven by the selected profile and catalog evidence, including strict structured output, streaming, reasoning controls, usage, cancellation, and retention behavior. Unsupported capability combinations fail before credential access or HTTP.
- Use one fixed origin/path policy, reject redirects and caller-defined authorization/transport headers, resolve credentials by scoped secret reference, and bind data handling to the exact provider instance.
- Reject request/model/role substitution, malformed or oversized streams, incomplete structured output, unknown state-changing events, and usage disagreement. Raw response bodies and hidden reasoning are not persisted by default.
- Pass the shared inference-provider contract suite, adversarial parser/transport tests, deterministic fake-server tests, and explicit opt-in budget-capped live canaries before any concrete model becomes eligible.

This adapter enables configured Anthropic models to participate in discovery, synthesis, review, and other inference operation classes. Claude Code remains a separate coding-agent surface and cannot satisfy an inference alias.

The Stage 18 live-boundary checkpoint keeps the production provider disabled
and exposes its single-attempt real-service canary only from the testing
subpath. That canary has a fixed endpoint, API version, pinned model, harmless
body, scoped-secret reference, exact policy/catalog/retention preflight, and
finite response/time/result surface; ordinary CI substitutes deterministic
transport. It is implementation evidence only until an already configured
owned secret route runs it successfully.

On 2026-08-14 one exact owned-reference canary ran under a separate one-attempt
approval and returned the finite but ambiguous code `TRANSPORT_FAILURE`. It was
not retried and does not prove the reviewed transport, so `ANT-02` remains
incomplete and the general provider stays production-disabled.

Deterministic analysis then found a classification defect rather than evidence
about that historical request: transport and response parsing ran inside the
secret callback, while the Windows broker deliberately maps every thrown
consumer error to one finite `CONSUMER_FAILURE`. The canary therefore could
relabel an HTTP response, response-parse failure, material callback failure, or
broker outcome-audit failure as generic transport failure. ADR 0030 returns an
exact bounded success/failure outcome through the callback, waits for material
disposal and broker audit, then reconstructs the finite error outside. An
orthogonal effect phase distinguishes `pre-dispatch`, `possibly-dispatched`,
`response-received`, and `post-response`; `possibly-dispatched` remains
conservative and never proves that no provider effect occurred. A separate
`CALLBACK_RESULT_FAILURE` prevents broker/result failures from masquerading as
transport failures. Synthetic tests exercise every phase and byte disposal;
no credential read or new provider call is evidence for this repair.

The subsequent Windows credential checkpoint supplies the missing persistent
resolution infrastructure without enabling that canary. One exact schema-v1
`keychain` reference is allowlisted by namespace, service, account, text kind,
null version, and provider instance. A canonical projection hashes to the sole
bounded Credential Manager target, so raw account, user, and path text never
reaches Win32. `@ai-dev-os/secrets-windows` exposes availability/read only
through a repository-owned asynchronous C/N-API `CredReadW` boundary; it has no
enumeration, write/delete, environment/credential-file/arbitrary-path/process/
browser/network, or fallback authority; it lazily loads one fixed package-relative
reviewed addon. The provider credential port uses the central policy-aware resolver,
so secret-access subject/scope/approval policy completes before the OS read and
before transport. Native and Node mutable copies are overwritten where
controlled, while immutable strings and runtime/OS copies remain an explicit
erasure nonclaim. Imports and fake-backed tests remain cross-platform; only the
hosted Windows job compiles the addon, proves malformed native targets refuse,
and requires observed `not-found` through availability and read for one fresh
random synthetic target the project never creates. An unexpected exact-target
collision would access that credential before failing. ADR 0028 records the
exact security and packaging boundary.

### 11.3 Claude Code adapter

- Probe the installed CLI version and supported features at startup.
- Use non-interactive print mode with machine-readable streaming output.
- Pass prompts over stdin or protected files, not shell-concatenated command strings.
- Run in a managed worktree with a scrubbed environment, explicit tool restrictions, turn and budget caps, and an approval broker for permission prompts.
- Never use permission-bypass flags in production.
- Parse partial and malformed streams defensively, cap output, sanitize terminal controls, and terminate the entire process tree on cancellation.
- Treat a zero exit code as transport success only. Task success still requires artifact, diff, path-policy, and validation checks.
- Reconcile a crash by inspecting session metadata, worktree diff, commits, and expected artifacts.

The installed CLI can expose new flags over time, so the adapter maintains a tested version-capability matrix instead of assuming `--help` is exhaustive.

### 11.4 Ollama adapter

- Use the native local API for model discovery, health, chat streaming, structured output where supported, reasoning controls, and keep-alive behavior.
- Treat local inference as metered: record prompt/evaluation tokens, load time, generation time, queue delay, CPU/GPU time, and peak memory.
- Use a capacity manager so large models do not compete for unavailable VRAM/RAM.
- Bind Ollama to loopback or place it behind an authenticated local gateway. It is not exposed directly to a LAN.
- Validate installed model identity and digest. A configured family preference may fall back only to a capability-compatible local or approved remote route.

## 12. Repository intelligence and Git

### 12.1 Repository model

The repository service discovers roots, workspaces, languages, manifests, build/test commands, ownership rules, generated files, ignore rules, dependency edges, and symbol indices. Every index record is keyed by repository snapshot and file digest. Incremental indexing uses Git changes and file hashes.

Context selection is layered:

1. Project rules and explicit architectural decisions.
2. Repository map, manifests, and dependency neighborhoods.
3. Task-relevant symbols and files using lexical search.
4. Optional embedding retrieval as a recall aid.
5. Recent validated task artifacts and failures.

Retrieved content carries source, commit, path, byte range, trust label, and token count. Summaries never silently replace authoritative source for changes.

### 12.2 Working-tree safety

- The user's working tree is never edited, stashed, reset, cleaned, or committed implicitly.
- A clean project uses a recorded base commit.
- A dirty project requires an explicit snapshot capture. Tracked changes and selected untracked files are copied into a private snapshot object store or temporary Git object database without mutating the source tree.
- Every writing attempt receives a dedicated managed worktree based on the captured snapshot.
- Git runs with sanitized configuration, hooks disabled, restricted protocols, no automatic submodules, and no ambient credential helper.
- Worktree ownership, attempt ID, base SHA, lease, and cleanup state are persisted.

### 12.3 Integration and conflict handling

Writing tasks produce a commit or patch, a machine-readable changed-file manifest, validation results, and output artifacts. The integrator serializes candidate commits per repository/target through a durable lease and monotonically fenced intent, then uses one fresh task-owned integration worktree and private index. The effect-start marker is durable before Git; an uncertain outcome is reconciled from exact commit/ref evidence and is never automatically repeated.

Conflict handling has five levels:

1. **Structural:** Git three-way merge detects overlapping textual conflicts.
2. **Scope:** Path and ownership policy rejects undeclared or protected changes.
3. **Semantic:** Dependency impact, type checks, tests, static analysis, and changed API contracts expose non-overlapping incompatibilities.
4. **Intent:** Independent reviewers compare the combined diff against task acceptance criteria and project decisions.
5. **Specification:** The combined tree remains bound to the approved product specification, requirement-to-task-to-result coverage, authorized waivers, and unresolved security/feasibility dissent.

For a resolvable conflict, an arbiter receives base/ours/theirs, both task intents, relevant decisions, and failed validation evidence. It proposes a patch in a fresh worktree. Deterministic validation and policy decide whether that patch can be integrated. A second model's agreement is never authorization or proof of correctness.

If the target branch advances after validation, the Stage 19B checkpoint fails the compare-and-swap update and requires a new evaluation-bound request on the new head; it never silently rebases or reruns an ambiguous effect. Remote pushes, primary-branch changes, and production registration remain absent and require a later explicit authority decision.

## 13. Output merging and disagreement resolution

Each task declares a merge strategy:

- `select-one`: rank alternatives against a rubric and retain evidence.
- `structured-union`: merge schema-keyed records with deterministic duplicate policy.
- `ordered-append`: concatenate independent artifacts in declared order.
- `git-integrate`: apply commits through the repository integrator.
- `synthesize`: ask a designated evaluator to build a new artifact from cited inputs.

Disagreement is detected through schema conflicts, contradictory claims with shared keys, incompatible patches, divergent test evidence, or reviewer rubric thresholds. Resolution uses an independent evaluator with the original goal, constraints, candidates, provenance, and deterministic evidence. It returns a structured decision with selected claims, rejected claims, uncertainty, and required validation. Majority voting alone is not used.

Product-planning synthesis uses the same evidence rule at requirement granularity. Every contributed candidate must appear in an immutable disposition ledger, including duplicates, rejections, deferrals, and questions returned to the user. Synthesis cannot silently drop a feature, convert a delight candidate into approved scope, lower an acceptance criterion, or erase a dissenting security or feasibility finding. The final completeness evaluator reads the approved specification and coverage matrix rather than trusting planning or implementation narratives.

The 2026-08-14 Stage 18 audit candidate applies that boundary to an immutable
baseline: all 16 acceptance-matrix rows and all ten ADR 0016 specialist
concerns are explicitly dispositioned and connected by requirement-task-result
edges. The checkpoint-specific overlay is not the shipped product-planning
`ProductSpecification` schema. The published packet records exact external
operator authorization for the frozen manifest and all 16 candidate evidence
digests, with zero waivers and no outcome authority. Deterministic evaluation
then passes the 12 frozen proven rows and retains failed outcomes for `ANT-02`,
`AM-02`, `PLN-02`, and `PRD-01`; the result remains rejected and permanently
non-authorizing. Development projection treats only `ANT-02` and `AM-02` as
development blockers and retains `PRD-01` as the correct production gate. The
fixed audit cannot consume its own result. Phase A is now published and
source-head hosted-green, but no separately authorized later subject consumes
that result as evidence, so `PLN-02` cannot change. Route metadata remains
unauthenticated and same-family. ADR 0029 records this two-phase boundary;
neither phase can activate production or begin Stage 20 while development
acceptance is false.

## 14. Memory, preferences, and cache

### 14.1 Memory classes

| Class | Examples | Write rule |
| --- | --- | --- |
| Run evidence | Transcripts, events, patches, test results | Immutable and automatic |
| Repository fact | Language, command, module owner, API contract | Must cite snapshot and source |
| Project decision | Chosen architecture, policy, accepted convention | Explicit user action or validated decision artifact |
| User preference | Style, provider preference, cost/latency tradeoff | Explicit preference is trusted |
| Inferred preference candidate | Repeated observed choice | Never enforced until confirmed |
| Summary | Compacted run or repository context | Must retain source references and supersession |

Every memory has project/user scope, type, source artifact, source author, confidence, creation time, expiry, supersession link, sensitivity, and trust label. A model proposes memory writes through a schema; the memory service validates scope and policy. Retrieved memory is data, not executable instruction.

### 14.2 Retrieval

SQLite full-text search is the desktop baseline. PostgreSQL full-text search is the team baseline. Embeddings are optional and improve recall but do not determine authority. Hybrid ranking combines lexical relevance, scope, recency, confidence, source quality, and optional vector similarity. The context packer enforces token budgets and records exactly which memory influenced a task.

### 14.3 Cache

Cache keys include provider and model version, generation parameters, prompt template digest, tool and plugin versions, policy snapshot, repository snapshot, input artifact digests, output schema, and data scope. Entries have TTL, sensitivity, provenance, validation status, and hit accounting.

Read-only classification, summaries, repository maps, embeddings, and deterministic transformations are cacheable. Autonomous edit attempts are not cached by default. No cache or retrieval result crosses project or user security scopes.

## 15. Plugin system

This remains a post-Stage 25 architecture target rather than part of the
numbered initial Windows release path. Built-in adapters use the same capability
concepts so a later third-party plugin system can run out of process over
versioned JSON-RPC on stdio without changing core authority semantics.

A manifest declares:

```json
{
  "apiVersion": "devos.plugin/v1",
  "id": "example.provider",
  "version": "1.0.0",
  "entrypoint": ["node", "dist/main.js"],
  "provides": ["inference-provider"],
  "permissions": {
    "filesystem": [],
    "network": ["https://api.example.com"],
    "process": [],
    "secrets": ["example-api-key"]
  },
  "configurationSchema": "config.schema.json"
}
```

Installation verifies signature or trusted source, package digest, API compatibility, and declared capabilities. Grants are per user and optionally per project. Capability expansion requires reapproval. Secrets are brokered by reference for one invocation and never returned through general configuration APIs.

Process isolation contains crashes but is not a complete security sandbox.
Initial production builds allow built-in components only and expose no general
third-party installation path. A later explicitly trusted signed-plugin path
requires a separate product decision and capability-diff approval; untrusted
plugins additionally require a supported OS sandbox profile.

## 16. Configuration

Configuration is schema-versioned and layered in this order:

1. Signed application defaults.
2. User configuration in the OS application-data directory.
3. Project configuration in `.devos/config.yaml` after project trust is established.
4. Named execution profile.
5. Validated per-run overrides.

Later layers cannot weaken centrally locked security or data policies. Unknown keys are errors in strict production mode. Configuration values include only secret references, never secret material. Effective configuration and its digest are recorded on every run.

Configurable areas include providers, model catalogs, logical role and planning-operation policies, routing weights and rules, planning phase/specialist/requirement bounds, budgets, concurrency, memory retention, cache, data classification, workspace isolation, approvals, validation commands, telemetry exporters, and plugin grants.

## 17. API layer

The API is versioned under `/v1` and publishes OpenAPI schemas. Commands support idempotency keys. Queries are side-effect free.

Representative endpoints:

```text
POST   /v1/projects
GET    /v1/projects
GET    /v1/projects/{projectId}
POST   /v1/projects/{projectId}/snapshots
POST   /v1/runs
GET    /v1/runs/{runId}
POST   /v1/runs/{runId}/cancel
GET    /v1/runs/{runId}/product-specification
GET    /v1/runs/{runId}/planning-contributions
GET    /v1/runs/{runId}/coverage
POST   /v1/runs/{runId}/scope-decisions
GET    /v1/runs/{runId}/tasks
POST   /v1/tasks/{taskId}/retry
GET    /v1/routing-decisions/{decisionId}
GET    /v1/providers/health
GET    /v1/usage
GET    /v1/memories
POST   /v1/memories/{memoryId}/confirm
DELETE /v1/memories/{memoryId}
GET    /v1/approvals
POST   /v1/approvals/{approvalId}/decision
GET    /v1/events?after={sequence}
GET    /v1/artifacts/{artifactId}
```

The live channel uses WebSocket or SSE with replay from a monotonic event cursor. An event envelope contains schema version, global and run sequence, event ID, aggregate version, zero-based event index, aggregate event count, time, project, run, task, attempt, trace context, type, redaction classification, and typed payload. Consumers apply a complete aggregate-version batch atomically. Slow clients are disconnected and resume from the last persisted cursor rather than consuming unbounded daemon memory.

Before Discord, Telegram, or any later messaging adapter exists, Stage 20 must
provide a typed, authenticated, idempotent command/notification boundary with
replay protection, approval binding, redaction, recipient identity, and durable
emergency stop. Free-form messages remain untrusted task input rather than
authority.

Local desktop authentication uses the per-launch bearer credential, strict origin validation, and loopback binding. Remote mode adds TLS, OIDC, RBAC, CSRF protection, rate limits, and tenant-aware authorization.

## 18. Desktop dashboard

The desktop renderer contains no orchestration state that cannot be reconstructed from API snapshots and events.

The initial desktop is Windows only and uses progressive disclosure. **Normal
mode** presents everyday tasks, progress, approvals, results, compact
health/usage state, and essential controls. **Developer mode** adds routing,
provider/profile telemetry, policy traces, processes, logs, evidence,
diagnostics, and advanced settings. Developer mode changes presentation and
configuration reach only; it cannot weaken authorization or safety policy. The
future design-review and borrowed-profile constraints are defined in the
[Windows product direction](product-direction.md).

### 18.1 Primary navigation

- **Runs:** running and completed work with status, project, route, duration, reserved/actual cost, and tokens.
- **Run detail:** task DAG, active attempts, live output, validation evidence, artifacts, approvals, and cancellation.
- **Product blueprint:** framed intent, user journeys, accepted/deferred/rejected requirements, specialist findings, unresolved questions, and exact scope decisions.
- **Coverage:** requirement-to-task-to-validation traceability, implementation evidence, waivers, incomplete entries, and the final completeness audit.
- **Timeline:** correlated routing, scheduling, provider, tool, Git, validation, memory, and cost events.
- **Projects:** repositories, snapshots, configuration, budgets, data policy, index health, and recent outcomes.
- **Memory:** facts, decisions, preferences, provenance, confidence, retrieval history, confirmation, and deletion.
- **Routing:** candidate table with constraints, score terms, chosen fallback chain, and measured outcome.
- **Models:** provider authentication, installed models, capability catalog, circuit state, latency, queue, and local resource load.
- **Extensions (post-25):** installed versions, signatures, capabilities,
  grants, health, and logs only after the later plugin track is authorized and
  implemented; this surface is absent from the initial Windows release.
- **Settings:** profiles, approval defaults, telemetry, retention, and secret-reference setup.

### 18.2 Interaction rules

- Normal mode prioritizes clarity and an uncluttered dark experience; Developer
  mode may use dense operational layouts for scanning and repeated action.
- Task and attempt state are visually distinct.
- Cost always shows estimate, reservation, actual, currency, and pricing timestamp.
- A cancellation control is available on every active run and attempt view.
- Approval dialogs show normalized action, exact arguments, scope, risk, artifact digest, expiry, and consequence.
- Logs and Markdown are sanitized; raw ANSI, HTML, links, and file paths cannot trigger host actions.
- Renderer IPC is schema-validated through a narrow preload bridge. Node integration is disabled, context isolation and sandboxing are enabled, navigation is blocked, and a restrictive CSP is enforced.

## 19. Persistence design

The initial schema contains:

| Table | Key contents |
| --- | --- |
| `projects` | Identity, repository roots, data policy, effective config digest |
| `repository_snapshots` | Commit, overlay digest, tree digest, index status |
| `runs` | Objective artifact, snapshot, state, budgets, aggregate version |
| `product_intents` | Explicit outcomes, constraints, non-goals, assumptions, questions, provenance, version |
| `product_specifications` | Approved versioned scope, requirement set, source contribution fingerprints, approval binding |
| `planning_contributions` | Phase, operation class, route, immutable candidate requirements, findings, conflicts, uncertainty |
| `requirement_dispositions` | Accepted, deferred, rejected, duplicate, or needs-user decision with source and reason |
| `coverage_entries` | Requirement, tasks, acceptance criteria, validation/artifact evidence, waiver, completion state |
| `tasks` | Specification, current state, priority, topology version |
| `task_edges` | Run-scoped dependency pairs |
| `attempts` | Route, provider IDs, workspace, state, timestamps, reconciliation |
| `leases` | Fencing token, worker, capability digest, expiry, heartbeat |
| `events` | Append-only ordered domain and audit envelopes |
| `outbox` | Transactional events waiting for live publication/export |
| `artifacts` | Digest, type, schema, location, size, sensitivity, provenance |
| `routing_decisions` | Profile, candidates, filters, score terms, price and health snapshots |
| `usage_ledger` | Estimate, reservation, debit, release, and actual usage entries |
| `provider_health` | Model availability, latency, circuit, resource state |
| `memories` | Scope, source, content reference, confidence, trust, expiry |
| `preferences` | Explicit or candidate preference and confirmation state |
| `cache_entries` | Full key digest, scope, artifacts, validation, expiry |
| `approvals` | Action digest, decision, actor, expiry, one-shot consumption |
| `plugin_installations` | Version, digest, signature, manifest, grants, health |

SQLite uses WAL, foreign keys, busy timeouts, short write transactions, and application-level single-writer scheduling. PostgreSQL uses serializable transactions, conditional aggregate writes, row-level locks, `SKIP LOCKED` only for its queue-like outbox, and an explicitly owned advisory session lock only for migration startup. Canonical payload and timestamp identities remain text rather than driver-converted JSON/timestamps. Migrations are forward-only in release artifacts, checksummed, and tested for concurrent startup, rollback, resume, schema-ahead refusal, and checksum drift. Stage 18D contains no destructive migration; any future destructive migration remains backup-gated and must be tested on production-scale fixtures before release. ADR 0024 records the exact adapter and refusal-only application boundary.

The generic aggregate port deliberately does not pretend an opaque scheduler
document is a queryable PostgreSQL ready queue. Database isolation makes stale
cross-row transactions fail closed, while a future portable scheduler-claim
projection must add indexed readiness/priority fields, a bounded conflict-retry
policy, and memory/SQLite/PostgreSQL parity before efficient multi-process
scheduler coordination is claimed.

Large transcripts, repository bundles, patches, and model payloads stay outside SQL in content-addressed storage. SQL contains digest, size, encryption metadata, and reference counts. Artifact writes use temp file, hash verification, atomic rename, then metadata transaction; orphan collection is safe and delayed.

## 20. Security architecture

### 20.1 Trust model

Every model, repository, dependency, build script, Git remote, tool result, generated patch, plugin, and provider response is untrusted. Only the orchestrator, policy engine, capability broker, credential broker, audit subsystem, and their persistence transactions belong to the trusted computing base.

Non-negotiable invariants:

- No model output directly authorizes a side effect.
- No attempt can access files outside its workspace grant.
- No memory, artifact, log, or cache crosses a project security scope.
- Secrets do not enter prompts, normal logs, reusable caches, or renderer state.
- Security and data routing constraints override learned scores and user convenience settings.
- Every side effect is attributable to a run, attempt, lease, policy decision, and approval when required.
- Recovery and retry cannot duplicate an irreversible effect.

### 20.2 Capability broker

Workers receive expiring grants containing run, project, snapshot, worktree, permitted operations, path prefixes, allowed executable digests, egress domains, cost ceiling, deadline, and nonce. Commands are structured argument arrays with shell parsing disabled by default. Paths are canonicalized and revalidated at use time against symlinks, junctions, reparse points, alternate streams, UNC paths, archive traversal, case folding, and time-of-check/time-of-use replacement.

Approvals bind to the normalized action and artifact digest, are one-shot, and expire. Argument or artifact changes invalidate the approval. Required approvals include remote Git writes, destructive actions, package installation, unrestricted network access, credential access, publication, deployment, and scope expansion.

Future Windows presentation groups grants into **Contained**, **Scoped
autonomous**, and **Trusted Full Access** profiles. These labels do not replace
field-level grants or approvals. Trusted Full Access remains prominent,
revocable, and separately excludes elevation, security-setting changes,
destructive deletion, credential export, purchases, publication, signing, and
new-recipient communication. Untrusted content cannot select or widen a
profile.

### 20.3 Isolation

An attempt runs as an unprivileged principal in an ephemeral sandbox with a dedicated worktree, read-only base, bounded writable paths, process-tree termination, CPU/RAM/disk/output quotas, and default-deny egress. It does not inherit user profiles, SSH agents, Git credential stores, cloud credentials, browser data, or unrelated package caches.

Platform backends can use a hardened container, VM, or OS sandbox. A plain same-user subprocess is a developer convenience mode and is not represented as a security boundary for hostile repositories. Windows is the initial production-release target and must pass its own isolation gates. Linux and macOS are deferred to Stage 25, remain unavailable/unverified, and must later be tested independently because filesystem, credential, packaging, and process-termination behavior differs.

All egress passes through an enforcing proxy that validates DNS and redirects, blocks private and metadata ranges, and records destination and policy decision. Ollama remains loopback-only. Provider data classification is checked before routing quality or price.

The preceding paragraphs describe the required production architecture, not
the capability of the currently shipped backends. At the Stage 17 gated
checkpoint all three platform factories remain unavailable probe seams and no
controlled-egress relay ships. Production admission therefore refuses before
spawn. A descriptor is only advisory: production requires an opaque
first-party registration backed by fresh exact-platform/helper/corpus evidence,
then a single-use receipt from secure preparation bound to the exact
grant/request/policy/lease/workspace/tool/quota/endpoint configuration.
Registration verification pins the canonical escape-corpus version,
fingerprint, and exact host-applicable vector count; an attested shortened or
substituted corpus fails closed.

Serializable attestations and their router projection are body-free and
non-authorizing. Raw attestations always project as advisory; only live opaque
registration verification can project `secure-enforcing`, and the broker still
revalidates at execution. The exact current limitations are recorded in the
Stage 17 ADR and machine-readable platform truth table. No Windows, Linux, or
macOS enforcement result is inferred from compilation, workflow YAML, probes,
or mocks.

### 20.4 Credentials and data

Credentials live in the OS keychain for desktop or a secret manager for team mode. Workers receive a short-lived reference or process-specific injection only when required. Redaction occurs before prompts, logs, traces, events, memories, cache, and UI publication. Persistent sensitive artifacts are encrypted and support retention, export, and deletion workflows.

### 20.5 Supply chain and desktop

- Pin provider CLIs, local model digests, packages, plugins, and build tools.
- Generate an SBOM and provenance attestation; scan dependencies, licenses, secrets, and release artifacts.
- Sign desktop releases and updates, verify update metadata, and test rollback.
- Disable renderer Node integration, enable context isolation and sandboxing, validate every IPC sender and payload, use a custom local protocol, enforce CSP, and block arbitrary navigation and external URL opening.
- Once the post-Stage 25 plugin track is separately authorized, install only
  signed or explicitly trusted plugins until strong plugin sandboxing is
  available; the initial Windows product exposes no plugin installation path.

## 21. Observability and accounting

Every run has a trace ID; every task, attempt, provider call, tool action, validation, and integration step is a span. Logs are structured, bounded, redacted, and carry project/run/task/attempt IDs. User-visible event records and security audit records are separated so retention and access can differ.

Metrics include:

- Queue depth and age by project, task kind, route, and resource pool.
- Active leases, heartbeat lag, retries, cancellations, orphan recovery, and task outcomes.
- Provider health, latency quantiles, time to first token, throughput, rate limits, and circuit state.
- Estimated, reserved, and actual input/output/cached/reasoning tokens and money in integer micros.
- Local model load, queue, evaluation duration, tokens per second, CPU/GPU time, and memory.
- Routing selection, fallback, confidence calibration, success rate, regret, and policy rejection reasons.
- Planning phase cost/latency, candidate requirement counts, disposition outcomes, unresolved-question age, coverage gaps, waivers, and post-implementation completeness findings.
- Cache hit rate, retrieval sources, memory confirmation and expiry, index freshness.
- Worktree count, disk usage, merge conflicts, validation duration, and integration failures.

Pricing records are versioned by provider, model, region, effective time, token category, and currency. Historical cost is never recomputed using today's price. Local routes can have configurable compute and energy accounting even when API price is zero.

## 22. Failure handling

| Failure | Required behavior |
| --- | --- |
| Daemon crash | Restart, replay state, expire and reconcile leases, publish missed events |
| Worker crash or hang | Kill process tree, retain bounded diagnostics, reconcile worktree/provider, retry by policy |
| Provider stream truncation | Preserve partial diagnostic artifact; never accept it as a valid terminal result |
| Provider throttling/outage | Circuit breaker, deadline-aware backoff, persisted fallback route, no retry storm |
| Ollama resource exhaustion | Admission control, model unload policy, fallback, actionable health status |
| Context overflow | Deterministic budget reduction, provenance-preserving summary, task split, or longer-context reroute |
| Invalid structured output | Schema error and at most one bounded repair attempt before fallback/failure |
| Graph explosion | Reject mutation exceeding node, depth, fan-out, time, or budget quota |
| Planning expansion | Stop at phase/requirement/budget bounds, preserve all accepted evidence, and request scope decisions rather than silently trimming or scheduling inferred features |
| Incomplete requirement coverage | Refuse normal completion until evidence is attached, an authorized waiver is recorded, or the run ends with a visible incomplete outcome |
| Disk full | Stop admission, preserve committed state, surface remediation, avoid destructive cleanup |
| Database lock/contention | Bounded retry and backpressure; never hold transactions across provider calls |
| Target branch movement | Fail the exact compare-and-swap request; require a newly evaluated request on the new head before any later effect |
| Plugin or CLI drift | Fail capability handshake and quarantine incompatible adapter |
| Budget exhaustion | Cancel or pause before exceeding reservation; reconcile actual usage and require explicit extension |

## 23. Testing strategy

### 23.1 Per-module gate

No module is considered complete until it has:

- Strict type checking and a production build.
- Unit tests for success, boundary, and failure behavior.
- Property or fuzz tests for parsers, policies, graph/path invariants, or other combinatorial inputs where applicable.
- Contract tests for every external port.
- Structured error behavior and cancellation tests.
- Security tests proportional to its authority.
- Public API documentation and no dependency-cycle violation.

### 23.2 System test layers

1. **Domain:** graph cycles, legal transitions, propagation, budgets, policy, cost arithmetic, cache scopes, and idempotency.
2. **Provider contracts:** deterministic fake servers/CLIs covering malformed streams, duplicate chunks, disconnects, throttling, auth failure, cancellation races, usage mismatch, and version drift.
3. **Repository:** temporary repositories covering dirty trees, ignored and untracked files, worktrees, hooks, symlinks/junctions, conflicts, target movement, and process cleanup.
4. **Orchestration:** real database and fake models covering parallel DAGs, multi-phase product planning, contribution disposition, scope approval, duplicate delivery, expired leases, crash between side effect and commit, restart, budget exhaustion, and plugin removal.
5. **Adversarial:** hostile repository and prompt-injection corpus attempting secret access, scope change, command injection, path escape, network exfiltration, forged approval, fake test results, or persistent memory poisoning.
6. **Desktop/API:** authentication, origin, CSRF/WebSocket rules, schema confusion, rate limits, XSS in diffs/logs/Markdown, IPC escalation, unsafe links, deep links, reconnect, and event replay.
7. **Quality evaluations:** versioned reference repositories and tasks for product discovery, user-journey and expected-quality coverage, specialist gap recovery, feasibility, synthesis preservation, implementation, refactor, debugging, tests, review, documentation, conflict resolution, final completeness, and recovery.
8. **Load and chaos:** large repositories, concurrent graphs, provider brownouts, local model saturation, database contention, disk exhaustion, network partitions, abrupt termination, backup, and restore.

Deterministic checks, compilers, tests, and sampled human review are authoritative. LLM evaluators supplement them but do not replace them.

### 23.3 Production release gates

- No unresolved critical or high vulnerability without explicit risk acceptance.
- Cross-project isolation and hostile-repository suites pass on every supported
  OS. The initial supported-target family is Windows; deferred Linux/macOS
  absence is not represented as a pass and becomes gating if either is later
  advertised.
- Canary secrets never reach providers, logs, memory, cache, artifacts, or UI.
- Every side effect has complete audit attribution.
- Policy and capability code meets branch and mutation-test thresholds.
- Restart and duplicate-delivery tests demonstrate idempotent recovery.
- Every required or expected-quality requirement in a release candidate has valid acceptance evidence or an explicit authorized waiver; model assertions alone never satisfy coverage.
- Backup restore, signed update, and rollback are tested.
- Live provider canaries pass within fixed cost budgets; normal CI uses deterministic fakes.

## 24. Service objectives

Provider inference time is external and excluded from control-plane latency objectives.

| Objective | Initial target |
| --- | --- |
| Local daemon cold readiness | p95 under 3 seconds on supported developer hardware |
| Non-provider API command/query | p95 under 200 ms at normal desktop load |
| Durable event to visible dashboard | p95 under 500 ms |
| Cancellation signal to supervised process termination | p95 under 2 seconds, with platform-specific hard limit |
| Crash recovery | No committed task/event loss; recovery begins within 10 seconds of restart |
| Budget enforcement | No new charge after hard limit; in-flight variance explicitly reserved and reported |
| Route explainability | 100 percent of dispatched attempts have a persisted candidate and policy record |
| Audit attribution | 100 percent of side effects identify project, run, task, attempt, lease, and policy decision |

## 25. Deployment modes

### 25.1 Desktop mode

- Windows Electron application plus local daemon and worker supervisor for the
  initial production target.
- SQLite WAL and encrypted local content-addressed artifacts.
- Loopback-only authenticated API.
- OS keychain credentials.
- User-selected workspace and sandbox backend.

### 25.2 Headless single-host mode

- The same daemon without Electron, managed as an OS service.
- SQLite for one scheduler or PostgreSQL when multiple daemon instances are required.
- CLI and browser dashboard clients use authenticated API access.

### 25.3 Team mode

- Stateless API/application instances and independently scalable worker pools.
- PostgreSQL, S3-compatible encrypted artifacts, TLS, OIDC, RBAC, and tenant scopes.
- Central secret manager, egress policy, audit export, quotas, and signed plugin administration.
- No Kubernetes requirement until measured workload or organizational operations justify it.

## 26. Key architecture decisions

1. **Modular monolith first.** Transactional workflow correctness matters more than independent service deployment.
2. **Electron desktop.** The existing Node toolchain and local CLI integration outweigh a smaller Rust-based shell for the initial release.
3. **SQLite desktop, PostgreSQL team mode.** A storage port preserves domain behavior while matching local and concurrent deployment needs.
4. **Current state plus event journal.** Pure event sourcing adds reconstruction and migration cost without removing the need for queryable task state.
5. **At-least-once attempts.** Exactly-once external execution is not credible; leases, idempotency, worktrees, and reconciliation make retries safe.
6. **Separate inference and coding-agent ports.** A text inference request is materially different from an autonomous repository-editing process.
7. **Deterministic router constraints.** An LLM classifier enriches a task profile but cannot override privacy, permissions, budget, capability, or health.
8. **Git worktree isolation.** Parallel repository writes are never performed in the user's working tree.
9. **SQL and lexical memory baseline.** Embeddings aid retrieval but are optional and never establish authority.
10. **Out-of-process plugins.** Versioned RPC, manifests, and grants provide lifecycle and crash isolation; untrusted code still requires an OS sandbox.
11. **Windows-first production scope.** Initial platform proof, packaging, and
    release readiness target Windows; portable seams remain, while Linux/macOS
    enforcement and parity move to Stage 25 and cannot be inferred from Windows.

## 27. Requirement traceability

| Requirement | Design location |
| --- | --- |
| Analyze requests and estimate complexity | Sections 8 and 10 |
| Estimate tokens, cost, and time | Sections 10 and 21 |
| Select optimal model | Section 10 |
| Split tasks, run in parallel, merge output | Sections 8, 9, and 13 |
| Detect and resolve conflicts/disagreements | Sections 12 and 13 |
| Persistent project memory and preferences | Section 14 |
| Repository understanding | Section 12 |
| Reusable cache | Section 14 |
| Multiple projects | Sections 7, 14, 17, and 19 |
| Git integration | Section 12 |
| Claude Code, OpenAI, and Ollama | Section 11 |
| Desktop active agents, cost, tokens, tasks, memory, routing, health, timeline | Section 18 |
| Backend, API, agents, router, memory, graph, scheduler, plugins, config | Sections 4 through 17 |
| Logging, metrics, security, testing | Sections 20 through 23 |

## 28. Authoritative integration references

- OpenAI recommends the Responses API for reasoning and tool-oriented workflows; long operations can use background responses with persisted status and polling: [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model), [OpenAI background mode](https://developers.openai.com/api/docs/guides/background).
- Claude Code documents non-interactive print mode, JSON streaming, tool restrictions, permission modes, worktrees, budgets, and session controls used by the process adapter: [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage).
- Ollama's native chat API exposes streaming, reasoning controls, keep-alive, durations, and token counters needed by the local adapter: [Ollama chat API](https://docs.ollama.com/api/chat).
- Electron's security guidance requires renderer isolation, sandboxing, restrictive content policy, navigation control, and IPC sender validation: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security).
