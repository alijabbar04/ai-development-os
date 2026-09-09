# @ai-dev-os/thinker

`@ai-dev-os/thinker` is the Stage 15 provider-neutral planning component. It compiles one policy-authorized Stage 14 context pack, invokes exactly one explicitly selected inference target, validates the guarded operation, and returns a bounded proposal whose authority is always `"none"`.

The package does not execute a proposal. It cannot mutate a task graph, allocate scheduler IDs, consume approvals, grant capabilities, run tools or commands, edit a repository, reserve budget, inspect quota or health, retry, route, or fall back. Later stages must normalize, profile, policy-evaluate, admit, and schedule every proposed task independently.

## Dependency and provider boundary

The production dependency direction is deliberately narrow:

```text
thinker -> domain + providers + provider-gateway + prompt-compiler + config
```

There is no dependency on a concrete adapter, coding-agent provider, telemetry ledger, task graph, scheduler, workspace, application, filesystem, network client, or process broker. `createProviderGatewayThinkerPort` exposes only immutable instance lookup, preflight, and explicit invocation from the Stage 12 gateway. The thinker never calls gateway health, quota, status, catalog ranking, or fallback behavior.

`CodingAgentProvider` is a different contract from `InferenceProvider`. The Claude Code coding-agent and Codex surfaces expose verified workspace/artifact outcomes and remain rejected when configured as thinker aliases. The Windows development-planning helper supplies a separate bounded Claude planning `InferenceProvider` through a host-owned port and the normal compiler/Thinker validation. Its shipped live route remains blocked pending managed-policy qualification; synthetic controls establish no live connection. This does not change the coding-agent type boundary or the production execution gate.

## Selection is a preference, not routing

Stage 6 configuration supplies exact opaque identities:

```text
planning aliases: [primary-thinker, alternate-thinker]
default: primary-thinker
request override: alternate-thinker
```

Absent an override, `resolveThinkerTarget` selects the first alias in the `planning` preference. A request-level alias overrides it. Resolution rejects an absent alias, disabled provider, coding-agent kind, unavailable model, instance/model/configuration mismatch, unsupported strict structured output, and a compilation target mismatch. It never tries a second alias.

An alias can point to any eligible configured inference model. Provider and model IDs are opaque; spelling never controls capability, effort, family, price, locality, or fallback. Trusted provider-specific effort settings can travel only through the bounded validated provider-extension array already sealed into the prompt fingerprint.

## Invocation and lifecycle

`createThinker` performs no provider, network, process, filesystem, or clock work at construction. For each accepted request it:

1. parses the Stage 6 configuration and exact prompt-compilation request;
2. compiles through the supplied `PromptAuthorizer` (deny-all by default);
3. resolves the exact configured planning alias and verifies its gateway snapshot against the compiled target;
4. runs gateway preflight;
5. invokes that one instance/model once;
6. wraps the operation with `guardProviderOperation`, drains the entire event stream while awaiting the result, and verifies terminal/result agreement;
7. requires `finishReason: "stop"` and the exact structured-output field;
8. validates and seals the proposal.

The inference request always has `tools: []`, `toolChoice: { mode: "none" }`, and the fixed strict output schema. JSON in prose or code fences is never scraped. Refusal, length, content filtering, tool-call output, missing/malformed structured output, request/model/operation substitution, event disagreement, or a provider failure returns a finite body-free failure with no proposal.

Caller abort is passed to the provider operation. `close()` is idempotent, closes the owned prompt compiler, and cancels active thinker operations; it does not close the injected gateway, whose lifecycle remains caller-owned. A close racing with provider start is detected after invocation and the new operation is cancelled and drained before a terminal thinker result is returned.

## Output trust and authority

Model output is untrusted data. `parseThinkerProposal` accepts exact keys and finite variants only, rejects exotic/prototype-pollution objects, applies global structural bounds, normalizes graph-order fields with explicit non-locale ordering, and deeply freezes the result.

`validateThinkerPlan` intersects runtime limits with the trusted prompt authority envelope and rejects the whole proposal when any invariant fails:

- unique local proposal IDs and edges, existing dependencies, no self-edge, and an acyclic DAG;
- task/dependency/criteria/evidence/text bounds;
- evidence identity plus digest present in the exact context pack;
- task kind and requested capabilities within the trusted ceiling;
- edit scope and reasoning no wider than the ceiling;
- risk no lower than the effective trusted minimum;
- classification no lower than the effective trusted classification.

Unknown approval, grant, secret, command, tool, lease, attempt, scheduler state, or runtime fields fail exact-key parsing. Free-text descriptions remain untrusted proposal prose and confer no execution meaning. Dangerous requests are never silently clamped into an apparently approved value.

A successful `ThinkerSuccess` contains the canonical proposal plus:

- `authority: "none"`;
- prompt, context-pack, authorization, authority, target, gateway-instance, and gateway fingerprints;
- selected alias, instance ID, and model ID;
- schema/template/fingerprint versions;
- a safe operational receipt.

`thinkerPlanFingerprint` binds only the normalized semantic proposal and its algorithm/schema versions. Provider latency, usage, cost, warnings, and event counts remain in the separate receipt, so operational variation does not silently change proposal identity.

## Non-disclosure and observations

Reasoning deltas, text deltas, assistant messages, structured-output event/result bodies, prompt messages, context bodies, tool arguments, refusals, provider transcripts, and warning strings are never returned, observed, logged, or persisted by this package. They are inspected only long enough to validate, count UTF-8 bytes, or compute a digest, then discarded. Warning evidence is preserved as count, byte count, and fingerprint. Observer callbacks receive IDs, fingerprints, counts, outcome codes, and the zero-authority marker only; observer exceptions are ignored without inspection or serialization.

Errors and discriminated failures contain finite codes and bounded scalar facts, not model or context content, policy text, approval evidence, credentials, subject identifiers, or source paths. `ThinkerError` also replaces its stack with a path-free summary.

## Public API and versions

The main entry point exports:

- `THINKER_SCHEMA_VERSION`, `THINKER_PLAN_SCHEMA_VERSION`, `THINKER_OUTPUT_JSON_SCHEMA`;
- `THINKER_FINGERPRINT_ALGORITHM_VERSION`, `THINKER_PLAN_FINGERPRINT_ALGORITHM_VERSION`;
- `parseThinkerConfiguration`, `parseThinkerRequest`, `parseThinkerProposal`;
- `validateThinkerPlan`, `thinkerPlanFingerprint`, `summarizeThinkerResult`;
- `resolveThinkerTarget`, `createProviderGatewayThinkerPort`, `createThinker`;
- `createManualThinkerClock` for deterministic lifecycle tests;
- finite error, result, receipt, proposal, observer, port, and target types.

Current semantic versions are all `1`: thinker schema, plan/output schema, prompt template, thinker/result fingerprint algorithm, and proposal fingerprint algorithm. Any change that alters accepted semantic output or a fingerprint input requires a version bump and updated deterministic evidence.

`ThinkerConfiguration` bounds output tokens, events, observed delta bytes, warnings, assistant-message metadata, graph/list/text sizes, and accepted semantic versions. Stage 6 precedence is unchanged. Package-specific provider settings belong in the existing bounded Stage 6/provider extension seams; inline secrets and inferred model facts are not accepted.

## Composition sketch

```ts
import { createThinker, createProviderGatewayThinkerPort } from "@ai-dev-os/thinker";

const thinker = createThinker({
  port: createProviderGatewayThinkerPort(gateway),
  authorizer: policyBoundPromptAuthorizer
});

const result = await thinker.think({
  schemaVersion: 1,
  requestId: compilation.requestId,
  configuration,
  selectedAlias: "alternate-thinker",
  compilation
});

if (result.ok) {
  // Proposal only. No task has been admitted, authorized, scheduled, or run.
  const authority = result.value.authority; // exactly "none"
}
```

The example IDs are configuration aliases rather than commercial model names. Tests use two differently identified fake inference targets and prove identical backend-contract behavior.

## Testing entry points

- `@ai-dev-os/thinker/testing` exports `describeThinkerBackendContract` and may load Vitest.
- `@ai-dev-os/thinker/testing/fixtures` exports deterministic fake targets, scripts, requests, proposals, configurations, and harnesses without importing Vitest.

All tests are hermetic and credential-free. The seeded property corpus records `0x15c0ffee`, `0x15da600d`, and `0x15e22025`.

## Deferred work

Stage 16 owns provider-specific exact token estimation, task profiling, quota/capacity-aware feasibility and ranking, cost scoring, fallbacks, circuit breakers, and explanations. Stage 17 owns enforcing process isolation. Stage 18 owns durable queues, leases, attempts, reservation, scheduling, and application lifecycle. Stage 19 owns evaluators, disagreement handling, merging, and Git integration. A new first-party Anthropic inference adapter is separate provider work.
