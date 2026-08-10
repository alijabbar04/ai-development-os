# ADR 0022: Production-disabled direct Anthropic and bounded product planning

Status: Accepted for the Stage 18B checkpoint
Date: 2026-08-09

## Decision

Stage 18B adds two first-party packages:

- `@ai-dev-os/provider-anthropic`, a direct Claude Messages API
  `InferenceProvider` adapter; and
- `@ai-dev-os/product-planning`, a deterministic, durable implementation of
  the bounded planning assembly accepted in ADR 0016.

Both packages are production-disabled. Their ordinary public constructors
cannot perform provider, network, credential, workspace, Git, native, or host
effects. Automated execution exists only through explicitly injected,
deterministic fake ports. This checkpoint does not satisfy Stage 17 admission,
complete Stage 18, or begin Stage 19 evaluation or integration.

## Direct Anthropic boundary

The adapter targets the official direct Anthropic Messages HTTP contract at
the fixed endpoint `https://api.anthropic.com/v1/messages` and API version
`2023-06-01`. A versioned configuration maps one deployment-owned model alias
to one exact Anthropic response model identity and to existing
`ModelCapabilities`. The adapter rejects an unknown alias and rejects any
response that substitutes a different model. It never discovers or silently
falls back to a model.

This is not the Claude Code provider. Claude Code is a coding-agent product
with a workspace/process/session boundary. The new adapter is a stateless
cloud inference boundary implementing the shared `InferenceProvider` contract.
No Claude Code executable, session, account UI, or consumer subscription route
is part of this package.

Current official Anthropic primary documentation consulted on 2026-08-09:

- [Messages API `POST /v1/messages`](https://platform.claude.com/docs/en/api/messages/create)
  and its system/message/tool shapes;
- [API versioning](https://platform.claude.com/docs/en/api/versioning) and the
  required `anthropic-version` header;
- [streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
  event order, cumulative usage, ping, and mid-stream errors;
- [JSON schema structured output](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
  through `output_config.format`;
- [client tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
  and `tool_use` content blocks;
- [finite HTTP errors](https://platform.claude.com/docs/en/api/errors),
  `retry-after`, and request identifiers;
- [model identifiers/versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions);
  and
- commercial API retention, including the
  [standard 30-day deletion statement](https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)
  and the [separately contracted nature of zero-data-retention](https://privacy.anthropic.com/en/articles/8956058-i-have-a-zero-data-retention-agreement-with-anthropic-what-products-does-it-apply-to).

The official TypeScript SDK was considered but is not added. Stage 18B has no
production execution path, and adding the SDK plus its transitive/package
surface would not improve the contract evidence. The package instead defines
an exact, injected Messages HTTP transport seam. It has no `fetch`, socket,
environment, SDK, or dynamic-import path. A later production-admission change
must separately review and implement a real transport or a pinned supported
SDK client.

Configuration includes a scoped existing `SecretRef`, never key material. The
runtime ordering is structural:

1. validate the provider-neutral request and exact model alias;
2. validate capabilities, catalog identity, classification, locality,
   retention profile, and request bounds;
3. obtain a disclosure/policy decision bound to the request fingerprint;
4. only then ask the injected credential port to resolve the scoped reference;
5. only inside that callback may the injected transport open a stream.

Denial at any earlier step therefore observes neither a credential nor a
transport. Errors retain only finite codes, safe counts, retry timing, model
alias, operation identity, and trace identity. Request/response bodies,
headers, provider messages, tool arguments, secrets, and hidden reasoning are
never copied into an error or observer record.

The stream state machine accepts one `message_start`, contiguous single-open
content blocks, exactly one terminal `message_delta`, one `message_stop`, and
bounded ping events. No content block may begin, change, or stop after the
message delta. It reserves tool-call identities when blocks open and
validates exact block identity, bounded initial and streamed tool JSON, stop
reason, structured JSON against the caller's schema, usage consistency, and
the configured response model. Unknown or
malformed wire shapes fail closed as protocol violations. Limits bound events,
wire bytes, output bytes, tool argument bytes, wall time, and the caller's
deadline. Cancellation, provider close, wall-time, and deadline are enforced
from policy entry through credential resolution and streaming. Preflight
awaits race the abort authority; a delayed credential callback rechecks it
before transport access. Established streams use the shared
first-terminal-wins operation controller.

Caller structured-output schemas are validated before policy, credential, or
transport access. The supported recursive subset has finite schema-node,
collection, enum, depth, and 131,072-step evaluation bounds. Malformed values
for supported keywords fail as invalid requests. JavaScript `pattern` and
floating-point `multipleOf` are deliberately unsupported because
caller-controlled backtracking could defeat the wall-time authority and
approximate IEEE-754 divisibility can fail open. Product-planning identifiers
receive their stricter deterministic validation after JSON parsing instead.

Anthropic usage is mapped into the existing disjoint token vocabulary:

- uncached input plus cache-creation input -> `inputTokens`;
- cache-read input -> `cachedInputTokens`;
- authoritative thinking-token detail -> `reasoningTokens`; and
- authoritative output minus thinking -> `outputTokens`.

Missing required usage is a malformed response. Negative, unsafe,
non-cumulative, contradictory, or reasoning-greater-than-output values are
refused. Cost stays unknown because the Messages response is usage evidence,
not a billed monetary amount or a reviewed local price catalog. Stage 18B
therefore rejects non-null configured model pricing, advertises
`pricingAvailable: false`, and returns unknown cost consistently.

The provider descriptor's `retainsData` is configuration evidence, not a claim
that an API key has a zero-data-retention agreement. A request whose disclosure
forbids retention is eligible only for a profile explicitly configured as
zero-data-retention and authorized by policy. Prompt caching, Files, batch, and
provider/server tools are outside this profile.

## Product-planning identities and authority

The planning package defines schema-versioned identities for:

- `ProductIntent` and its immutable intent digest;
- `PlanningPhase` and its scheduler task/idempotency identities;
- `PlanningContribution` and a trusted source/route/configuration fingerprint;
- candidate and deduplicated requirement identities;
- `ScopeDecision`, its actor/authority, requirement digest, plan version,
  reason, approval reference, and time;
- `ProductSpecification` and its approval digest; and
- `RequirementTaskCoverage` linking each executable requirement to exact
  existing task-graph task identities.

Model output has `authority: "none"`. It supplies a contribution draft:
candidate requirements, feasibility findings, unresolved questions, and
dissent. The coordinator stamps route/configuration evidence from trusted
injected configuration; it does not accept a model's claim about its own
provider, independence, authority, or validation status.

Candidate requirements are deduplicated by one normalized semantic key. The
deduplicated identity is a digest of the plan and key. Every contributing
candidate identity, phase, provenance reference, conflict, and dissent item is
preserved. Two candidates may merge; their provenance never does. Reordered
contributions produce the same aggregate projection.

Stable planning IDs hash a canonical JSON array of their parts, so control
characters cannot collide across field boundaries. All canonical planning
ordering uses locale-independent UTF-16 code-unit comparison rather than host
locale/ICU collation, including non-ASCII input and replay across platforms.

ADR 0016's accepted priority and disposition vocabulary is represented as one
finite scope disposition:

- `required`, `expected-quality`, and `delight-candidate` are executable
  accepted classes;
- `deferred`, `rejected`, `duplicate`, and `superseded` are non-executable
  explicit outcomes;
- `blocked` is the durable unresolved/user-decision state; and
- `waived` is a non-executable, explicitly authorized exception.

This preserves ADR 0016's required/expected-quality/delight/deferred priority
classes and its accepted/deferred/rejected/duplicate/needs-user-decision
semantics without silently treating a model proposal as accepted.

Every candidate must receive exactly one current decision before specification
approval. The model-facing synthesis contribution remains non-authoritative;
the approved specification is compiled deterministically only after current
digest-bound decisions exist.
Required/expected-quality promotion, waiver, and resolution of a blocked
material item require an exact approval reference and an allowed actor
authority. The decision is bound to the current plan version and current
requirement digest; stale decisions and replay under another plan are refused.
No model contribution may approve itself, waive another contribution, make a
route eligible, or mark deterministic evidence passed.

Specification synthesis is deterministic software. It checks that every
candidate and dissent is represented by a disposition and retained provenance.
It refuses omission, fabricated candidate identity, unresolved executable
dependency, stale decision, unsupported promotion, and missing route
independence. Approved specifications contain only decisions already
authorized by the state machine.

## Phases, independence, and scheduler integration

One plan has the following durable operation classes:

1. `product-discovery`;
2. zero or more configured `specialist-gap-analysis` phases;
3. `engineering-feasibility`; and
4. `plan-synthesis`.

The deterministic frame is part of `ProductIntent`, not a provider call. Final
completeness audit remains Stage 19.

Each phase has a stable task ID, idempotency key, input digest, route evidence,
attempt, status, and result ID. Material and high-risk plans require configured
independence between discovery and synthesis and between authoring and any
declared independent review phase. Independence means distinct trusted route
keys after alias resolution, not merely different labels. Missing, stale,
colliding, or self-asserted independence fails closed or enters an exact human
approval state; it is never called independent review.

`@ai-dev-os/product-planning` compiles phase and requirement work into the
existing `@ai-dev-os/task-graph`; it does not define a second graph. It uses the
existing `@ai-dev-os/persistence` aggregate/event transaction and the existing
Stage 18A `DurableScheduler` task lifecycle. A testing-only inference-to-agent
adapter translates an injected fake `InferenceProvider` result into bounded
scheduler checkpoints and stores a canonical contribution before the scheduler
terminal event. The coordinator then applies that result idempotently. This
ordering leaves a recoverable staged result if a crash occurs between provider
completion and scheduler/application completion; duplicate terminal delivery
cannot apply it twice.

Plan acceptance atomically creates a distinct `product-plan` aggregate, its
initial sealed phase task graph, the `plan.accepted` event, and every initial
task-graph event.
Dynamic requirement compilation updates the same aggregate and appends the
exact graph events in one persistence transaction. Aggregate checkpoints are
verified against exact parsed planning-event envelopes and full task-graph
journal replay, followed by defensive `TaskGraph.hydrate`. Task-graph replay
enforces command-legal transitions, immutable projections, command batch
ordering, reconciliation, and reason bounds. Planning replay binds each event
to one exact command delta and the exact number of graph command batches.
Nested phase, contribution, decision, specification, coverage, reservation,
reconciliation, and graph projections are rebuilt and compared exactly.
Hydration reapplies admission and cumulative limits, contribution/attempt
linkage, approval and decision policy, exact product task identities, and
generated immutable task fields. A blocked task's `blockedBy` remains
transition-time provenance; exact membership is proved by journal replay while
snapshots require a valid non-empty subset of unsuccessful dependencies.
Partial aggregate/event writes roll back through the persistence transaction.

Budget records are intents only: a preview, immutable reservation intent, and
terminal reconciliation intent. Plan-wide calls, tokens, cost, turns, and
attempts are partitioned across mandatory phases without rounding above the
preview. Provider usage is accumulated durably across retries and carried into
the successful staged contribution or failed terminal. Stage 18B never mutates
an account or usage ledger. Scheduler cancellation, retry, deadline, and
terminal state are bound to the same phase/result identities and reconciled on
restart.

## Hard limits

Configuration may lower but never raise the compiled maxima:

- phases: 16;
- specialists: 12;
- contributions: 64;
- candidate requirements: 1,000;
- provider calls: 64;
- input plus output tokens: 4,000,000;
- money preview: 100,000,000,000 micros;
- contribution output: 4 MiB and total plan output: 32 MiB;
- wall time: 24 hours;
- synthesis rounds: 3;
- retries per phase: 4;
- graph nodes: 2,000;
- graph depth: 64; and
- dependency fan-out: 64.

The existing task-graph's stricter maxima remain authoritative where lower.
Over-limit data is rejected before state mutation. No recursive brainstorming
or unbounded phase creation exists.

## Europe/London work-window reconciliation

ADR 0021 and the shipped Stage 18A tests define borrowed-profile work hours as
the weekday half-open interval `[09:00, 17:00)` in `Europe/London`. Product
direction contained wording that could be read as including 17:00. Stage 18B
does not silently change the reviewed implementation. The unambiguous policy is:

- 09:00:00 London time is inside the work window; and
- 17:00:00 London time is outside it.

Existing summer/winter/DST/weekend tests, plus explicit 09:00 and 17:00 edge
vectors, remain the evidence. A future closed-interval policy would require a
new versioned decision and migration; prose alone cannot change it.

## Versioning and migration

No Stage 18A persisted payload schema or event shape changes in this checkpoint.
`OrchestrationTaskEnvelope`, scheduler events/results, normalized usage,
canonical usage snapshots, routes, and task-run replay remain version 1.
Planning adds its own version-1 contracts, distinct persisted identity
prefixes, and the additive `product-plan` member of the persistence
aggregate-type union. Generic adapters require no database-schema migration
for that discriminator. The non-persisted `AgentAdapterRequest` seam now has
optional additive attempt and accumulated-usage fields so existing adapter
callers remain source compatible. The scheduler always supplies both; the
planning testing adapter uses legacy-safe defaults when an older caller omits
them. No prior event or checkpoint reader changes.

If a later stage adds planning fields to a Stage 18A envelope, changes the
borrowed work interval, or makes production dispatch possible, it must bump the
affected schema, supply an explicit migration/compatibility reader, and prove
old journal replay. Stage 18B has no migration because it changes no prior
payload.

## Failure semantics

- Unknown, malformed, oversized, stale, reordered, cross-plan, or conflicting
  contributions fail without partial application.
- Duplicate contributions and terminal results are idempotent only when their
  canonical digest is identical; a reused identity with different content is a
  conflict.
- A failed phase records a finite classification and follows the existing
  bounded scheduler retry policy. Exhaustion writes one idempotent failed
  phase, blocks downstream graph work, and leaves the plan incomplete.
- Cancellation and deadline stop remaining phase work and never synthesize a
  partial approved specification.
- Missing independent evidence, missing dispositions, unresolved questions
  affecting executable scope, or stale approval digests fail closed.
- Provider output is never validation evidence or independent review merely
  because it came from a second call.

## Remaining dependencies and nonclaims

Stage 18 still requires the durable application/runtime composition,
PostgreSQL contract parity, production-admission wiring, and any approved
read-only usage-source adapter. Stage 19 still owns completeness evaluation,
disagreement calibration, integration gates, and final audit behavior. This ADR
does not add a daemon, API, UI, communications integration, account manager,
Linux/macOS product path, provider credential, live call, production transport,
workspace mutation, or Stage 17 admission exception.
