# `@ai-dev-os/telemetry-ledger`

Durable, provider-neutral evidence for quota, cost, health, usage, and capacity. The ledger records what released adapters already observed; it never polls a provider, reads credentials or auth files, scrapes a CLI, selects a model, initiates a retry, reserves budget, or allocates work.

## Architecture and dependency direction

```text
@ai-dev-os/domain       @ai-dev-os/providers and public provider snapshots
         \                         /
          @ai-dev-os/telemetry-ledger
                       |
            @ai-dev-os/persistence port
                       |
       persistence-memory or persistence-sqlite
```

The core imports only public package exports and the Stage 3 persistence port. `./providers` contains pure bridges whose inputs are already-obtained public results, events, observations, or snapshots. Provider packages never depend on the ledger. The package has no gateway, router, scheduler, application, API, desktop, or UI dependency.

## Observation boundary and identity

Every persisted observation is schema version 1 and algorithm version 1. The finite vocabulary covers operation estimates, cumulative usage, terminal reconciliation, cost, provider health, quota windows, local/subscription capacity, corrections/tombstones, derived state, forecasts, and read-only account usage.

An envelope binds the logical ledger and deterministic time partition; stable observation and idempotency IDs; the exact organization/user/project/workspace/task/run scope actually known; trace, operation, and parent-operation lineage; provider/model/configured-instance/adapter/catalog identity; authentication and billing classifications; source identity and fingerprint; separate observation, ingestion, effective, reset, stale, and terminal times; confidence, provenance, linkage, and bounded detail codes. Canonical SHA-256 payload fingerprints cover all of that persisted evidence. A separate idempotency fingerprint excludes only the store-assigned ingestion timestamp, so retrying the same caller fact under a live clock remains a duplicate while the stored receipt time remains integrity-covered.

No schema field can contain prompts, responses, reasoning, tool arguments, command output, source bodies, paths, request/response bodies, headers, credentials, cookies, raw `SecretRef` values, or free-form error text. Runtime parsing is exact-key, deeply frozen, and bounded. Authentication class is a finite non-secret category, not credential material.

Partitions are derived from `(ledgerId, observedAt, partitionDurationMs)`. Their IDs include a bounded ledger prefix, UTC boundary, and collision-resistant identity digest. A partition checkpoint has explicit observation/idempotency bounds. The append-only event journal remains the history; the checkpoint is a bounded replay index.

Each store is constructed for exactly one `ledgerId`. Ingest rejects a draft for another ledger, and reads, exports, verification, idempotency, correction lookup, partition bounds, and authorization requests are all scoped to that binding. Multiple logical ledgers may share one persistence adapter without merging evidence, but adapter close is shared lifecycle state and must be coordinated by the composition owner.

## Usage reconciliation and cache writes

Normalized token categories are disjoint:

- uncached input;
- cache-write input;
- cached-read input;
- visible output;
- reasoning output;
- unknown/combined tokens;
- tool calls.

`categoryCompleteness` states whether a source supplied the exact ledger split, the generic four-category provider contract, or only a partial view. The shared Stage 2 `TokenUsage` contract is unchanged. OpenAI and Codex/Claude public exact observations map cache writes or cache creation into the ledger-specific category; generic results remain valid lower-resolution evidence. A cache-write token is never also added as uncached input.

Per operation, estimates remain separate. Stream `usage-update` records are cumulative snapshots: later sequence/category values replace earlier current state and may never regress. A terminal cumulative value reconciles against the last stream snapshot and is not added to it. Missing terminal usage retains partial actual consumption. Failed and cancelled operations retain reported usage and outcome quality.

Observation/idempotency ID reuse with different content conflicts across every partition of the logical ledger. Explicit provider-scoped source identity plus source fingerprint deduplicates generic and provider-specific views; an exact view wins over a lower-resolution view of the same source. A source ID with a different upstream fingerprint conflicts. Retries/resumptions are separate operation IDs linked by `parentOperationId`. Corrections append linked evidence and affect current aggregate state without rewriting journal history. Aggregate queries load applicable corrections independently of the requested observation interval, so a later tombstone retracts an earlier-period total. Raw history and bounded exports deliberately remain append-only evidence views: consumers must use the typed summaries rather than recompute corrected totals from a raw export. Replay uses stable ordering and reproduces the checkpoint fingerprint.

## Cost semantics

Currency is an ISO-style three-letter code and every amount is a safe integer number of micro-units. Floating point money and foreign-exchange conversion are unrepresentable.

Cost components preserve:

- provider-reported billed charges;
- locally computed estimates with dated price provenance;
- subscription/API-equivalent estimates that are not bills;
- evidence-backed zero for one observation;
- unknown.

Provider-billed and locally computed figures are retained as separate answers and never summed into one charge. `costVariance` exposes their same-currency difference. Summaries group by currency and semantic class. Any unknown component makes the relevant aggregate partial; known plus unknown is never reported complete. Local Ollama execution maps to unknown unless an operator supplies dated local-cost evidence—local is not synonymous with a zero financial or hardware cost.

## Quota, capacity, health, resets, and forecasts

Quota/capacity observations preserve absolute counts separately from fixed-point basis-point percentages. Percentages are never converted to tokens or requests without a denominator. Missing is not infinity or zero; stale, unsupported, unknown, limited, exhausted, and unavailable remain distinct. Primary/secondary, five-hour/seven-day, daily, rolling, fixed, and provider-defined windows do not merge.

`currentEffectiveObservation` resolves only an exact instance/model/window identity, preferring current over stale evidence, then documented source authority, recency, and stable ID. It never averages incomparable windows.

`forecastCapacity` is deterministic algorithm version 1. Callers select one comparable signal with provider-instance/model plus `dimension`, `window`, and `providerWindowId` query filters. The algorithm selects one reset segment under an injected clock, bounds the lookback/sample count/horizon, calculates burn with integer/fixed-point arithmetic, and reports sample range/count and low/medium/high confidence. Absolute-count signals use remaining units; subscription percentage signals use remaining basis points and remain dimension-labelled. Fewer than two comparable samples, a reset/identity change, non-positive burn, below-resolution burn, or an out-of-horizon exhaustion produces a typed unavailable reason. Forecasts are evidence only: they cannot rank, reserve, authorize spend, retry, or promise availability.

## Durable persistence, replay, and corruption

`createPersistenceTelemetryStore` uses `PersistenceAdapter.transact` to atomically update the `telemetry-ledger` aggregate checkpoint and append its journal event. Aggregate versions enforce optimistic concurrency with a bounded retry count. Event and aggregate reads verify Stage 3 checksums. Stable keyset pagination backs bounded queries.

If a checkpoint is missing, malformed, or stale while its verified journal is readable, the next write deterministically rebuilds it from events. An unknown newer schema is rejected rather than downgraded. A checksum-corrupt record is refused by the persistence boundary; it is never trusted or silently overwritten. `verifyTelemetryLedger` replays every bounded partition and compares fingerprints. Memory and SQLite run the same reusable contract; SQLite reopen tests use disposable databases.

The only current compaction mode is `checkpoint-only`: canonical replay rebuilds the bounded index but never deletes journal facts or changes financial totals. Retention/tombstone durations are explicit configuration for later authorized physical maintenance. The Stage 3 port intentionally has no delete primitive, so this release performs no silent physical event deletion. Corrections and tombstones remain durable.

## Authorization, privacy, and audit

Composition must inject a `TelemetryAuthorizer`; the exported default authorizer denies everything. `createExactScopeTelemetryAuthorizer` is a minimal local composition helper requiring exact user/organization/project/workspace identity. Every authorization request also names the store's logical ledger. Reads are authorized before disclosure and filtered again per observation. Cross-user, organization, project, workspace, ledger, and configured-instance evidence cannot widen policy, grants, budgets, or routing eligibility.

A required audit sink receives only bounded structural metadata: action, outcome, purpose/classification, scope-presence flags, time, and a detail code. It never receives IDs or payloads; use a deliberate no-op only in tests or an explicitly unaudited local composition. Authorizer exceptions deny. Denials are audited without short-circuiting, and audit failure denies the operation deterministically. Production code performs no console logging.

## Provider bridges and limits

`@ai-dev-os/telemetry-ledger/providers` maps:

- generic inference/coding-agent cumulative events, terminal results, provider costs, health, and bounded rate-limit facts (also used by Gemini, Groq, Cerebras, and OpenRouter);
- Ollama operation/health/admission and local concurrency/memory snapshots, with cost unknown;
- Claude exact cache-creation/read counts when `ClaudeUsageCounts` is available, lower-resolution terminal observations otherwise, billed versus subscription-equivalent cost, and separate five-hour/seven-day host-supplied windows;
- Codex primary/secondary rate windows, stale/unsupported states, and overlap-safe lifetime/daily account snapshots without inventing balances;
- OpenAI exact cache-write splits, local price provenance, request quota evidence, and terminal/background source identities supplied by the caller;
- gateway health, exact instance/catalog provenance, and typed runtime quota observations.

Bridges are pure. They do not call endpoints, use environment variables, resolve secrets, read files, scrape status lines, redeem credits, cycle accounts, pool keys, fall back, or substitute providers. Catalog free-tier claims are not converted into quota or zero-cost facts.

## Public API

Core exports include:

- `createTelemetryLedger` / `createPersistenceTelemetryStore`;
- `parseTelemetryLedgerConfiguration`, `parseTelemetryLedgerExtension`, and `telemetryLedgerConfigurationFingerprint`;
- `parseTelemetryObservation`, `createTelemetryObservation`, and `deterministicPartition`;
- `reconcileOperationTelemetry`, `queryUsageSummary`, `queryCostSummary`, and `costVariance`;
- `currentEffectiveObservation`, `forecastCapacity`, `telemetrySnapshotFingerprint`, and `observationIdempotencyFingerprint`;
- `parseTelemetryCheckpoint`, `replayTelemetryPartition`, and `verifyTelemetryLedger` through the store;
- deny-by-default/exact-scope authorizers;
- reusable `./testing` persistence contracts and pure `./providers` bridges.

Raw observation queries and exports are bounded pages. Summary, reconciliation, capacity, and forecast APIs scan the complete authorized interval through stable store pages; authorization-filtered evidence makes summaries partial and makes reconciliation/forecast fail closed. Queries accept configured-instance, contract/upstream-model, operation, observation, dimension, window, and provider-window selectors. Summary/snapshot results state their interval, filters, completeness, stale/unknown counts, source fingerprints, and result fingerprint. Exports contain normalized content-free observations only.

## Setup

```ts
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import {
  DEFAULT_TELEMETRY_LEDGER_CONFIGURATION,
  createExactScopeTelemetryAuthorizer,
  createTelemetryLedger,
} from "@ai-dev-os/telemetry-ledger";

const ledger = createTelemetryLedger({
  ledgerId: "local-development",
  adapter: createMemoryPersistenceAdapter(),
  configuration: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION,
  clock: { now: () => new Date() },
  authorizer: createExactScopeTelemetryAuthorizer(),
  audit: async () => { /* replace with a content-free durable sink */ },
});
```

Use `createSqlitePersistenceAdapter` for durable local storage. SQLite paths remain the adapter owner's configuration; telemetry observations never contain them. `ledger.close()` closes the injected adapter, so dedicate an adapter to one ledger store or coordinate shutdown when several logical stores intentionally share it.

## Deliberately deferred

This package does not rank or route providers, initiate fallback/retry, mutate Stage 2 budget accounts, admit tasks, reserve quota, schedule work, poll providers, administer organizations, or provide a UI. Physical journal deletion awaits an authorized retention API in the persistence layer; until then checkpoint-only compaction is intentionally lossless. Cross-partition idempotency and correction integrity currently require a bounded full-ledger verification scan on writes, and complete aggregate reads page through the authorized event set rather than promising a transactionally frozen multi-page snapshot. Raw exports retain superseded facts by design. `burnUnitsPerMillionMs` is interpreted in the result's dimension (basis points for `usage-percentage`, absolute units otherwise). Forecasts do not model provider-side policy changes or guarantee availability. Live canaries are unnecessary because every normal ledger path is offline and observation-driven.

See [`docs/adr/0013-telemetry-normalization.md`](../../docs/adr/0013-telemetry-normalization.md) for the cache-write and applied-redaction decisions.
