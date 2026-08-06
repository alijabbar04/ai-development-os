# ADR 0016: Bounded product-completeness planning assembly

Status: Accepted for planned Stages 18 and 19
Date: 2026-08-06

## Decision

Material product work will not rely on one general-purpose model response to
discover, plan, implement, and judge the result. The application coordinator
will run a bounded, durable planning assembly with separately routed operation
classes for product discovery, specialist gap analysis, engineering
feasibility, specification synthesis, and final completeness audit.

The coordinator remains deterministic software. Every model output is an
immutable, untrusted contribution with `authority: "none"`. Model capability,
not a commercial product name, determines route eligibility. Deployment
configuration may prefer different aliases for expansive discovery, balanced
synthesis, coding feasibility, private local work, and independent review.

The assembly will produce a versioned approved product specification and a
coverage matrix connecting every accepted requirement to tasks, acceptance
criteria, implementation artifacts, validation evidence, and any explicit
waiver. A run cannot normally complete while a required or expected-quality
requirement lacks valid evidence or an authorized waiver.

## Context

The Stage 15 thinker deliberately invokes one selected inference target and
returns one bounded zero-authority task proposal. This is the correct trust
boundary for a planning call, but a single call is not sufficient evidence that
a material greenfield product has captured all important user journeys,
expected product behaviors, failure states, security needs, accessibility,
data lifecycle, testing, operations, maintainability, and delivery concerns.

Assigning one frontier model as a permanent central intelligence would also
create a single point of provider, cost, availability, prompt-injection, and
quality failure. Asking several models to vote would not solve that problem:
correlated agreement is not evidence, and consensus cannot authorize scope or
validate an implementation.

The required property is therefore not "one smartest model." It is traceable
coverage across purpose-specific passes, with deterministic preservation of
the user's intent and every material contribution.

## Planning phases

### 1. Frame product intent

The coordinator creates a `ProductIntent` separating:

- explicit user outcomes, audiences, constraints, and non-goals;
- repository and project facts with provenance;
- inferred assumptions and candidate opportunities;
- unresolved questions whose answers could materially change scope; and
- the exact policy, classification, budget, and approval ceiling.

Framing cannot turn an assumption or opportunity into authorized scope.

### 2. Product discovery

A `product-discovery` route proposes a broad but bounded inventory of user
journeys, functional requirements, expected-quality behaviors, edge cases, and
optional delight candidates. Its output is a `PlanningContribution`, not a
task graph mutation.

### 3. Specialist gap analysis

Configured specialist passes independently inspect the framed intent and prior
contributions. The finite default concern set covers security, privacy, data
lifecycle, accessibility, failure and recovery, testing, performance,
operations, maintainability, and documentation. Projects may select a bounded
subset or add versioned domain-specific concerns through approved extension
points.

Specialists identify gaps and conflicts. They do not approve features, execute
tools, or mark another contribution correct.

### 4. Engineering feasibility

An `engineering-feasibility` route receives the fixed repository snapshot and
provenance-aware context. It relates proposed requirements to existing code,
dependencies, platform constraints, likely task boundaries, validation needs,
risk, and cost. It cannot silently remove a difficult requirement; it records
the objection and an alternative or user decision when available.

### 5. Specification synthesis and scope decision

A `plan-synthesis` route emits a cited candidate specification. Deterministic
validation requires one disposition for every candidate requirement:

- `accepted`;
- `deferred`;
- `rejected`;
- `duplicate-of`; or
- `needs-user-decision`.

Every disposition preserves its source contribution and a bounded reason.
Silent omission is invalid. An inferred material feature remains non-executable
until it is covered by the original explicit request or an exact user scope
decision. Accepted requirements receive stable identities and are compiled into
tasks, typed outputs, acceptance criteria, and validation plans.

### 6. Final completeness audit

After integration, a separately routed `completeness-audit` operation compares
the approved specification and coverage matrix with repository state and
deterministic evidence. It may identify gaps or propose corrective work. It
cannot authorize that work, waive a requirement, mark a test passed, approve a
merge, or declare completion.

## Coverage and completion semantics

Candidate requirements use four priority classes:

- `required`: necessary for the explicit product outcome;
- `expected-quality`: necessary for the product to be credible, safe, usable,
  supportable, or maintainable;
- `delight`: optional differentiation or polish;
- `deferred-candidate`: worthwhile but outside the approved current scope.

Every accepted requirement has a coverage entry linking it to user journeys,
tasks, acceptance criteria, validation commands or review rubrics,
implementation artifacts, final evidence, and any waiver. Required and
expected-quality entries block normal completion when incomplete. Delight and
deferred candidates stay visible but do not execute or block completion unless
an authorized scope decision promotes them.

An AI narrative, confidence score, or model agreement is never completion
evidence. Deterministic validators, inspected repository state, policy results,
and explicit authorized decisions remain authoritative.

## Routing, independence, and bounds

The existing router remains responsible for hard policy and feasibility
filters, quota/capacity evidence, cost, latency, health, locality, context, and
fallback decisions. Planning operation classes give configuration a stable way
to prefer different model aliases without model-name heuristics.

For material or high-risk work, policy can require that discovery, synthesis,
implementation, review, or completeness auditing use independent routes. The
evidence records provider instance, contract model, route, input, contribution,
and configuration fingerprints. If an eligible independent route is
unavailable, the coordinator records the limitation and applies the configured
approval or conservative-failure behavior; it never relabels self-review as
independent.

The assembly has hard limits for phase count, specialist count, candidate
requirements, synthesis rounds, provider calls, tokens, money, wall time,
output bytes, graph nodes, depth, and fan-out. Routine bounded work may use the
existing single-pass/rules path. Recursive brainstorming is not allowed.

## Stage allocation

- Stage 18 first adds a direct `@ai-dev-os/provider-anthropic` inference adapter
  so deployments may assign eligible Anthropic inference aliases to planning
  phases without confusing them with Claude Code. It then adds
  `@ai-dev-os/product-planning`, durable phase orchestration, scope decisions,
  requirement-to-task compilation, restart recovery, and bounded scheduling.
- Stage 19 adds requirement-coverage evaluation, final completeness auditing,
  disagreement handling, and integration gates.
- Stage 20 exposes read-only planning and coverage projections plus exact,
  idempotent scope-decision commands.
- Stage 21 presents the product blueprint, dispositions, unresolved questions,
  coverage, waivers, and remaining gaps.
- Stage 24 calibrates the pipeline against versioned product-discovery,
  irrelevant-feature-control, gap-recovery, synthesis-preservation, and
  completeness fixtures.

Stage 17 is unchanged and remains a prerequisite for production autonomous
coding-agent execution. This decision creates no exception to the current
production refusal.

## Consequences

The system spends more planning time and model budget on material product work,
but the expense is explicit, bounded, configurable, and visible before
implementation. The product gains durable traceability from the user's request
through discovery, scope, tasks, validation, and final completion.

The design also avoids tying product quality to one vendor. A deployment can
change its preferred discovery, synthesis, engineering, or review models as
capability evidence and economics change without altering domain semantics.

## Rejected alternatives

- **One permanent central model:** concentrates blind spots, outage, cost, and
  trust while providing no coverage proof.
- **Use the most capable model for every phase:** wastes budget and preserves
  correlated blind spots between author, implementer, and reviewer.
- **Unstructured multi-model brainstorming:** loses provenance, duplicates
  scope, and cannot prove that synthesis retained dissent or requirements.
- **Majority vote or model confidence:** neither authorizes scope nor proves
  correctness.
- **Automatically implement every suggested feature:** converts brainstorming
  into unauthorized scope expansion and product bloat.
- **Let the synthesis model silently trim the list:** makes omissions
  unauditable and defeats the completeness objective.
