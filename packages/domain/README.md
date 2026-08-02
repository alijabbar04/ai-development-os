# @ai-dev-os/domain

Provider-neutral core value objects for AI Development OS: branded
identifiers, task vocabulary, exact budget and usage accounting, data
classification and handling policy, model capability contracts, and the
structured domain error model.

This package is the Stage 2 domain kernel from the implementation roadmap.
It has **zero runtime dependencies**, performs **no I/O**, and never imports
Electron, provider SDKs, databases, or HTTP frameworks. Every value it
produces is deeply frozen, JSON-serializable, and safe to persist or send
over IPC.

## Responsibilities

| Area | Module concepts |
| --- | --- |
| Identifiers | `ProjectId`, `RunId`, `TaskId`, `TaskRunId` (the design's "Attempt"), `LeaseId`, `ApprovalId`, `EventId`, `AgentId`, `ProviderId`, `ModelId`, `ArtifactId`, `WorkspaceId`, `TraceId` |
| Task vocabulary | `TaskKind`, `TaskPriority`, `TaskComplexity`, `TaskRisk`, `TaskRequirements`, `ExecutionConstraints`, `RetryPolicy`, `TimeoutPolicy` |
| Budgets | `Money`, `TokenUsage`, `TokenBudget`, `MonetaryBudget`, `TimeBudget`, `AggregateBudget`, `UsageRecord`, `BudgetAccountState`, `BudgetReservation`, `BudgetDecision` |
| Data governance | `DataClassification`, `DataHandlingPolicy`, `DisclosureTarget`, `PolicyDecision`, `ProviderEligibility` |
| Model capabilities | `ModelCapabilities`, `ModelRequirements`, `ModelCostMetadata`, `estimateModelCost` |
| Errors | `DomainError`, `ValidationError`, `InvariantViolationError`, `SerializationError`, `BudgetExceededError`, `PolicyViolationError`, `UnsupportedCapabilityError`, `ConcurrencyConflictError` |
| Serialization | `toCanonicalJson`, `parseJsonText`, `canonicalizeJson`, `jsonEquals` |
| Validation toolkit | `validation.*` guard functions shared by sibling domain packages |

## Design rules

- **Runtime validation at every untrusted boundary.** Every `parseX(value)`
  function accepts `unknown`, validates shape, ranges, and cross-field
  invariants, and returns a deeply frozen value or throws `ValidationError`.
  `createX(...)` factories are typed conveniences over the same validation.
- **Minimal internal validator, chosen deliberately.** The repository's
  established validation approach (see `@ai-dev-os/task-graph`) is a
  hand-rolled zero-dependency validator. This package follows the same
  convention instead of introducing a library such as zod: the domain layer
  must stay dependency-free (Stage 1 exit criterion), the validation
  vocabulary is small and closed, and one validation system must not compete
  with another. The toolkit is exported as the `validation` namespace so
  sibling packages (for example `@ai-dev-os/artifacts`) reuse it.
- **No secrets in errors.** Guard failures never echo the rejected value.
  Errors carry the field path, a stable issue code, and structural summaries
  (lengths, counts) only — safe for logs, telemetry, and serialized output.
- **Finite unions over arbitrary strings.** Kinds, risks, classifications,
  localities, statuses, and dimensions are closed `as const` unions.
- **Immutable value objects, no data-holder classes.** All values are frozen
  plain objects produced by factories; state transitions are pure functions
  returning new frozen states.

## Units

| Quantity | Unit |
| --- | --- |
| Money | Integer **micro-units** of the major currency unit (`1_000_000` micros = 1 GBP/USD/...), ISO-4217 uppercase currency code. Floating-point money is rejected everywhere. |
| Tokens | Integer counts. Categories are disjoint: `inputTokens` excludes `cachedInputTokens`; `outputTokens` excludes `reasoningTokens`. |
| Durations / timeouts | Integer **milliseconds**. |
| Sizes | Integer **bytes**. |
| Model pricing | Integer micro-units per **one million tokens**. |
| Timestamps | Canonical ISO-8601 UTC strings (must round-trip `new Date(v).toISOString() === v`). |

## Serialization and versioning

- `toCanonicalJson(value)` produces deterministic JSON: object keys sorted,
  `-0` normalized to `0`, `NaN`/`Infinity`, cycles, exotic objects,
  prototype-pollution keys (`__proto__`, `constructor`, `prototype`), and
  oversized payloads rejected with `SerializationError`.
- `parseJsonText(text)` safely parses untrusted JSON into frozen,
  null-prototype structures under depth/node/string limits.
- Persisted aggregates (`DataHandlingPolicy`, `UsageRecord`,
  `BudgetAccountState`, `ModelCapabilities`) carry an integer
  `schemaVersion`. Parsers accept exactly the supported version and fail
  loudly on anything else — stored data is never silently reinterpreted.
  A future version bump adds an explicit migration at the persistence
  boundary, not a lenient parser.

## Budget accounting

`BudgetAccountState` is an immutable reservation ledger driven by pure
functions:

```text
reserveBudget      : (held)      places a hold for estimated usage
commitReservation  : held -> committed   records exact actual usage
releaseReservation : held -> released    frees an unused hold
cancelReservation  : held -> cancelled   frees a hold on cancellation
cancelBudgetAccount: open -> cancelled   cancels all holds, blocks new ones
```

Guarantees:

- Hard limits deny with a thrown `BudgetExceededError` carrying the
  structured `BudgetDecision`; soft limits warn inside the decision.
- Held estimates and committed actuals both count against limits.
- Double commit with different usage, over-release, and commit of a
  released/cancelled reservation are `InvariantViolationError`s.
- Replaying the identical command is an idempotent acknowledgement that
  returns the same state object.
- Every effective mutation increments `version`; passing `expectedVersion`
  gives optimistic concurrency (`ConcurrencyConflictError` on mismatch).
- Commits are still accepted after account cancellation so in-flight work is
  accounted exactly; new reservations are not.
- Estimated and actual usage stay distinct end to end (`UsageRecord.kind`,
  `summarizeUsage`).

```ts
import {
  createBudgetAccount, createAggregateBudget, parseMonetaryBudget,
  parseBudgetScope, createMoney, createUsageAmounts,
  reserveBudget, commitReservation,
} from "@ai-dev-os/domain";

let account = createBudgetAccount({
  scope: parseBudgetScope({ scopeType: "run", scopeId: "run-42" }),
  budget: createAggregateBudget({
    money: parseMonetaryBudget({
      limit: createMoney("GBP", 5_000_000),      // £5.00
      softLimit: createMoney("GBP", 4_000_000),  // £4.00
    }),
  }),
});

account = reserveBudget(account, {
  reservationId: "task-1-attempt-1",
  estimate: createUsageAmounts({ cost: createMoney("GBP", 1_200_000) }),
  requestedAt: "2026-08-02T10:00:00.000Z",
});

account = commitReservation(account, {
  reservationId: "task-1-attempt-1",
  actual: createUsageAmounts({ cost: createMoney("GBP", 950_000) }),
  settledAt: "2026-08-02T10:03:21.000Z",
});
```

## Data classification and policy evaluation

Classifications, least to most sensitive: `public`, `internal`,
`proprietary-source`, `personal`, `secret`. Parsing a `DataHandlingPolicy`
enforces classification floors (for example, `secret` content can never
allow cloud providers), so a stored policy cannot weaken below its
classification. `defaultDataHandlingPolicy(classification)` provides
conservative defaults.

Policy evaluation is deterministic and provider-neutral — targets are
described by behavior (`locality`, `retainsData`, capability flags), never
by vendor name:

```ts
import { defaultDataHandlingPolicy, evaluateDisclosure } from "@ai-dev-os/domain";

const decision = evaluateDisclosure(
  defaultDataHandlingPolicy("personal"),
  { locality: "cloud", retainsData: true, capabilities: ["model-training"] },
  { evaluatedAt: "2026-08-02T12:00:00.000Z" },
);
// decision.allowed                -> false
// decision.reasons                -> [{ code: "CLOUD_DISCLOSURE_FORBIDDEN", ... }, ...]
// decision.requiredTransformations-> ["personal-data", "secrets"]
// decision.requiredApprovals      -> ["human-review"]
// decision.audit.ruleCodes        -> every rule that fired, in order
```

Question helpers answer routing checks directly: `mayUseCloudProvider`,
`requiresLocalModel`, `requiredRedactions`, `mayRetainLogs`,
`mayPersistArtifacts`, `requiresHumanApproval`,
`disallowedProviderCapabilities`. `assertDisclosureAllowed` throws
`PolicyViolationError` with the denial reason codes.

## Model capabilities

`ModelCapabilities` describes any model — local or cloud — by behavior:
context window, output limit, tool-use/structured-output/vision support,
locality, latency class, 1–5 coding/reasoning ratings, and exact pricing
metadata. `findUnmetRequirements` / `assertModelSupports` match a model
against `ModelRequirements`; `estimateModelCost` computes exact
integer-micro costs with BigInt arithmetic and per-category ceiling
rounding.

## Security considerations

- All inputs are treated as hostile: prototype pollution, exotic objects,
  symbol keys, sparse arrays, oversized strings, non-finite numbers,
  negative and fractional integers, and malformed timestamps are rejected.
- Error messages and serialized error details never contain raw input
  values, so credential-bearing input cannot leak through error channels.
- Monetary arithmetic is exact and overflow-checked; cross-currency
  operations throw instead of coercing.
- Policy evaluation results include audit metadata (classification, policy
  schema version, evaluation time, fired rule codes) for attribution.

## Verification

```
npm run typecheck -w @ai-dev-os/domain
npm run test -w @ai-dev-os/domain
npm run test:coverage -w @ai-dev-os/domain
npm run build -w @ai-dev-os/domain
```

Coverage thresholds match the repository standard (statements 90, branches
80, functions 98, lines 90).
