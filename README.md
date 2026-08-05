# AI Development OS

AI Development OS is a local-first orchestration engine for software engineering. It coordinates remote reasoning models, Claude Code, and local Ollama models through a durable task graph, policy-controlled routing, isolated repository workspaces, persistent project memory, and an auditable desktop control surface.

This repository is being delivered in tested modules. Stages 0 through 16 are complete: the task-graph kernel, domain vocabulary, persistence, content-addressed artifact storage, provider contracts, configuration/secrets/policy, Ollama and cloud inference adapters, workspace/process isolation, Claude Code and Codex coding-agent adapters, the strict OpenAI Responses adapter, the explicit multi-provider catalog/gateway, a durable provider-neutral quota/cost/health/usage/capacity evidence ledger, deterministic fixed-revision repository indexing, provenance-aware scoped memory, deterministic context packing, deterministic policy-bound prompt compilation, replaceable authority-free inference planning, repository-aware task profiling, evidence-bound token estimation, and hard-constrained quota-aware routing.

Stage 15 keeps every retrieved context body in the untrusted user layer, compiles a byte-reproducible no-tools inference request only after exact policy/disclosure authorization, invokes one explicitly configured planning alias with no fallback, and accepts only a bounded structured proposal marked `authority: "none"`. It does not execute, approve, schedule, route, edit, or mutate a task graph.

Stage 16 turns declared, measured, inferred, and optional classifier facts into an immutable task profile, binds exact or conservative token estimates to an opaque provider/profile/model/catalog identity, and selects only among candidates that pass every policy, capability, context, freshness, quota, capacity, circuit, security, cost, budget, latency, and deadline constraint. Scoring cannot revive an excluded candidate. Route, fallback, circuit, reservation, and reconciliation outputs are deterministic plans with no invocation or durable-mutation authority.

Stage 17 is an active gated checkpoint, not a released stage. The process
broker now treats backend descriptors as advisory, requires opaque measured
registration plus a single-use pre-spawn receipt in production, validates
request/grant/policy/lease monotonicity, and fails closed on unconfirmed
termination or cleanup. No native Windows, Linux, or macOS enforcement backend
or controlled provider-egress relay has been proven, so production autonomous
execution remains refused and no Stage 17 release tag exists.

## Documents

- [Technical design](docs/technical-design.md)
- [Implementation roadmap](docs/implementation-roadmap.md)
- [Stage 8 completion report](docs/stage-8-completion.md)

## Requirements

- Node.js 22 or newer
- npm 10 or newer

## Commands

```powershell
npm install
npm run check
```

## Workspace layout

```text
apps/                  Deployable daemon and desktop applications
packages/              Domain, application, and adapter modules
docs/                  Architecture, decisions, and delivery roadmap
```

## Stage 15 packages

- [`@ai-dev-os/prompt-compiler`](packages/prompt-compiler/README.md) compiles one exact Stage 14 context pack and trusted authority ceiling into a deterministic three-message, strict-structured-output inference request after deny-by-default policy authorization. It selects or invokes no provider.
- [`@ai-dev-os/thinker`](packages/thinker/README.md) resolves the default or explicit Stage 6 planning alias, invokes exactly one guarded inference target, discards raw response bodies, and seals a validated zero-authority proposal plus safe receipt metadata.

## Stage 16 packages

- [`@ai-dev-os/profiler`](packages/profiler/README.md) creates a provenance-separated deterministic task profile from trusted declarations, repository/context/prompt/proposal measurements, conservative rules, and an optional schema-validated untrusted classifier hint. Its estimator registry requires an exact provider, transport profile, contract model, and catalog fingerprint binding.
- [`@ai-dev-os/router`](packages/router/README.md) applies finite hard rejection codes before bounded integer scoring, then emits deterministic primary/fallback/no-route decisions, pure circuit transitions, and version-bound budget reservation/reconciliation plans. It invokes no provider and performs no durable mutation.

Provider/model IDs remain opaque configuration. The router can choose any configured eligible GPT or Claude inference target without name heuristics or a built-in commercial preference. Claude Code and Codex adapters implement the separate coding-agent contract and cannot be used as inference thinkers. A concrete Claude model requires a supported inference-provider registration; this repository does not currently ship a direct first-party Anthropic inference adapter. Usage/reset facts come only from normalized authorized observations, never guessed provider policy.

The project is pre-1.0. Live provider calls are explicit opt-in operations with policy and scoped-secret boundaries. Autonomous repository execution remains disabled in production until a genuinely enforcing isolation backend exists.

## Autonomous execution is currently refused by design

Stage 8 delivers the isolation contracts, the capability grants, and the
production gate — but no built-in sandbox backend is classified as genuinely
enforcing. The Windows, Linux, and macOS backends are honest probe seams that
report which platform primitive is missing and refuse to start a process, and
the one backend that does run commands is named
`unsafe-development-current-user` because it runs them as the invoking user
with that user's full filesystem, network, and credential access.

Production mode therefore refuses to execute autonomously. That is the
intended behaviour: running an agent against a hostile repository on a machine
with no sandbox is the specific outcome this stage exists to prevent. Enabling
it requires implementing and actually testing a real enforcing backend for
each advertised platform. The current Stage 17 checkpoint strengthens this
refusal against forged descriptors, IDs, summaries, mock sessions, widened
grants, and cleanup races; it does not convert probes or mocks into platform
proof.
