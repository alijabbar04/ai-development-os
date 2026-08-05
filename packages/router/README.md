# @ai-dev-os/router

`@ai-dev-os/router` is the Stage 16 deterministic quota-aware routing engine. Given one immutable task profile plus configuration, policy, gateway, catalog, estimator, health, quota, capacity, circuit, cost, and budget evidence, it removes hard-infeasible candidates, scores only the survivors, and returns a primary route with bounded fallbacks or an explained no-route result.

A route is evidence, not execution. Every decision says `authority: "none"`, `grantsAuthority: false`, `requiresExecutionTimeRevalidation: true`, `providerInvocationPerformed: false`, and `durableMutationPerformed: false`. The package cannot invoke a provider/coding agent, resolve a secret, acquire local capacity, reserve a durable budget, mutate a task graph/workspace/repository, dispatch work, retry, or persist circuit state.

## Evidence and identity

Candidates bind opaque provider instance/kind, contract model, gateway snapshot, catalog provider/model/profile fingerprints, immutable provider/model descriptors, configuration aliases, policy decision, free-tier verification, token estimator, exact-or-unknown cost, health, scoped quota/reset/correction evidence, local capacity, circuit state, secure-execution evidence, and observation/freshness instants.

Gateway credential-reference fingerprints are validated as part of the source snapshot and then removed from normalized routing evidence. Quota and capacity evidence bind exact provider-instance/model scopes plus opaque source/scope fingerprints; evidence is never transferred between candidates. Unknown means unknown—not zero or unlimited—and a missing reset remains null.

Provider/model IDs never control capability, pricing, tokenizer, locality, free eligibility, or quality. The production package has no concrete adapter import or commercial-name branch.

## Hard feasibility before scoring

For each candidate, the router first applies finite deterministic rejection codes for:

- configuration, alias, provider kind, adapter profile, identity, fingerprint, and user-enable state;
- policy outcome, classification, locality, retention, training, logging, network, and trusted handling restrictions;
- catalog enablement/freshness and verified-free-only proof;
- provider/catalog capabilities, coding/reasoning ratings, context/output proof, and estimator accuracy;
- health, exact quota scope/completeness/freshness/remaining use (including reservation safety margin), and local capacity safety reserves;
- circuit state and explicitly admitted half-open probes;
- fresh secure-enforcing coding-agent isolation evidence;
- exact cost consistency, currency, conservative budget fit, latency, deadline, and confidence.

An excluded candidate is never scored and can never become a primary or fallback. Explicit aliases are strict pins unless that request explicitly permits fallback; an infeasible strict pin returns no route. Fallbacks come only from the same hard-feasible set and remain bounded by locked configuration.

## Deterministic integer scoring

The versioned score vector has thirteen fixed term IDs covering capability margin, quality evidence, cost, latency, locality, alias order, verified-free evidence, quota headroom/reset evidence, protected reserve, capacity, health, context headroom, and evidence confidence.

Values are bounded integers in `[-1000, 1000]`; weights are bounded integers in `[0, 1000]`. BigInt intermediates protect weighted and total arithmetic. Stage 6 cost/latency/locality preferences scale only soft terms. Protected request/token reserves are intentionally a soft preference: the router preserves them when alternatives exist but can use the last feasible route rather than inventing a hard outage. Missing evidence receives documented conservative negative/zero values, never invented positive credit. Equal scores use the stable candidate fingerprint as the final total-order tie-break, and request creation canonicalizes candidate order before fingerprinting.

Decision validity is the earliest applicable declared expiry or configured maximum-age boundary. Execution must revalidate catalog, configuration, policy, estimator, health, quota, capacity, circuit, and budget evidence.

## Budget and circuit plans

`planBudgetReservation` reuses Stage 2 `BudgetAccountState`, `evaluateReservation`, exact `Money`, and `UsageAmounts`. It applies configured token/cost/duration margins and returns a version-bound reserve command only when the immutable account proves fit. Unknown cost and currency mismatch remain structured failures when money is bounded.

`reconcileBudgetReservation` uses the Stage 2 commit/release/cancel helpers to calculate an immutable preview for actual over-use, under-use, release, cancel, currency mismatch, unknown actual cost, duplicate replay, and invalid state. Preview construction does not mutate the supplied account or durable storage; Stage 18 owns the atomic write.

The circuit breaker is a pure, identity-bound, versioned closed/open/half-open state machine. It has explicit event time, thresholds, cool-down, bounded remembered event IDs, duplicate idempotence, out-of-order rejection, one admitted half-open probe, and canonical transition fingerprints. Stage 18 persists/coordinates transitions.

## Configuration and public API

Router schema, routing algorithm, circuit algorithm, candidate/evidence, and configuration versions are all `1`. `RouterConfiguration` controls catalog/health/quota/capacity/secure-execution freshness, hard known-evidence modes, minimum estimator accuracy, protected reserves, score weights, fallback bounds, confidence, circuit thresholds, reservation margins, and structural bounds.

`parseRouterConfigurationExtension` accepts the Stage 6 `router` extension only from a system layer with the providers field locked. Application preferences remain configuration data; production code contains no built-in preferred commercial model.

The main entry point exports candidate/evidence parsers and fingerprints, `parseRoutingRequest`, `createRouter`, `routeTask`, `parseRouteDecision`, summaries/explanations, budget planning/reconciliation, circuit construction/transitions, and `createManualRouterClock`.

## Golden corpus and testing entry points

- `@ai-dev-os/router/testing` exports the reusable Vitest contract suite.
- `@ai-dev-os/router/testing/fixtures` exports deterministic Vitest-free candidates, requests, the required matrix, and twenty executable golden scenarios.
- `goldens/routing-v1.json` records reviewed request/profile/configuration/decision fingerprints, selections, fallbacks, and rejections.

Golden output is never regenerated by tests. The deliberate update workflow is:

```text
npm --prefix packages/router run build
node packages/router/scripts/update-goldens.mjs --approve
git diff -- packages/router/goldens/routing-v1.json
```

The script refuses to run without `--approve` and fails if any required matrix tag is absent. Review the semantic diff before committing. The corpus covers task/repository/privacy/health/free/quota/reset/budget/context/local-capacity/preference/fallback/circuit/estimator/tie/no-route dimensions.

Property seeds are `160401`, `160402`, and `1051921`. Tests also prove hard-filter monotonicity, substitution resistance, freshness boundaries, permutation invariance, bounded scores, strict pins, free-tier expiry, heuristic rejection, observer containment, body-free serialization, and zero invocation/mutation.

## Known limitations and deferred work

Quota/account/organization/project semantics are represented by exact upstream scope fingerprints rather than decoded or guessed by the router. Reset evidence is used only when fresh and comparable; it is not a promise. Cost is exact only when bound model pricing evidence supports recomputation; no foreign-exchange conversion exists. No live paid/provider canary was run.

Stage 17 must provide real secure-enforcing process isolation before production coding-agent admission. Stage 18 performs durable reservation, current-evidence revalidation, circuit persistence, fallback/retry policy, and dispatch. Stage 19 owns evaluators and result merging.
