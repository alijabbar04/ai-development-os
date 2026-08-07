# AI Development OS

AI Development OS is a local-first orchestration engine for software engineering. It coordinates remote reasoning models, Claude Code, and local Ollama models through a durable task graph, policy-controlled routing, isolated repository workspaces, persistent project memory, and an auditable desktop control surface.

This repository is being delivered in tested modules. Stages 0 through 16 are complete: the task-graph kernel, domain vocabulary, persistence, content-addressed artifact storage, provider contracts, configuration/secrets/policy, Ollama and cloud inference adapters, workspace/process isolation, Claude Code and Codex coding-agent adapters, the strict OpenAI Responses adapter, the explicit multi-provider catalog/gateway, a durable provider-neutral quota/cost/health/usage/capacity evidence ledger, deterministic fixed-revision repository indexing, provenance-aware scoped memory, deterministic context packing, deterministic policy-bound prompt compilation, replaceable authority-free inference planning, repository-aware task profiling, evidence-bound token estimation, and hard-constrained quota-aware routing.

Stage 15 keeps every retrieved context body in the untrusted user layer, compiles a byte-reproducible no-tools inference request only after exact policy/disclosure authorization, invokes one explicitly configured planning alias with no fallback, and accepts only a bounded structured proposal marked `authority: "none"`. It does not execute, approve, schedule, route, edit, or mutate a task graph.

Stage 16 turns declared, measured, inferred, and optional classifier facts into an immutable task profile, binds exact or conservative token estimates to an opaque provider/profile/model/catalog identity, and selects only among candidates that pass every policy, capability, context, freshness, quota, capacity, circuit, security, cost, budget, latency, and deadline constraint. Scoring cannot revive an excluded candidate. Route, fallback, circuit, reservation, and reconciliation outputs are deterministic plans with no invocation or durable-mutation authority.

## Status

[![CI](https://github.com/alijabbar04/ai-development-os/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/alijabbar04/ai-development-os/actions/workflows/ci.yml)

| Fact | State |
| --- | --- |
| Latest completed release | **`v0.16.0-quota-aware-routing`** |
| Stages 0 – 16 | **Complete**, one tag per stage |
| Stage 17 (secure execution backends) | **Gated and unmerged**, on `feat/stage-17-secure-execution-backends` |
| Stage 18 | **Blocked** on Stage 17 |
| Production autonomous execution | **Refuses** |
| Maturity | Pre-1.0. Nothing is published to any registry. |

**This is not production software and does not claim to be.** The version tags
mark completed development stages for provenance; they are not maintained
releases and receive no backports.

Three things are stated plainly because they are easy to assume the other way:

- **Autonomous execution refuses in production, by design.** No built-in sandbox
  backend is classified as genuinely enforcing. See the last section of this file.
- **Stage 17 is a gated checkpoint, not a released stage.** No native Windows,
  Linux, or macOS enforcement backend has been proven, the Stage 17 native
  marshalling layer has never executed, the Windows escape corpus is unrun, and no
  `v0.17` tag exists. **Windows containment is not claimed.**
- **Stage 18 has not started.** It is blocked on Stage 17 evidence that does not
  yet exist.

## Documents

- [Technical design](docs/technical-design.md) — architecture and boundaries
- [Implementation roadmap](docs/implementation-roadmap.md) — what is delivered, in
  progress, and deliberately not started
- [Architecture decision records](docs/adr/) — why each boundary is where it is,
  and what each decision does **not** authorize
- [Stage 8 completion report](docs/stage-8-completion.md)
- [Contributing](CONTRIBUTING.md) — including the testing standards, which are
  stricter than most projects' and are explained
- [GitHub workflow policy](docs/development/github-workflow.md)
- [Security policy](SECURITY.md) · [Support](SUPPORT.md) ·
  [Code of conduct](CODE_OF_CONDUCT.md)

Stage-17 release evidence lives on the Stage 17 branch under
`docs/release-evidence/`, not here, because this branch deliberately carries no
Stage 17 code.

## Requirements

- Node.js 22 or newer (CI runs Node 24)
- npm 10 or newer

## Commands

Every command below was run against this repository.

```powershell
npm ci             # lockfile-exact install
npm run check      # typecheck, then tests, then build, across all 32 packages
```

`npm run check` takes roughly 20 to 45 minutes depending on machine load. The individual gates:

```powershell
npm run typecheck
npm test
npm run build
npm run test:coverage     # per-package coverage; floors are enforced
npm audit --audit-level=high
```

Scoped to one package:

```powershell
npm test --workspace @ai-dev-os/router
npm run test:coverage --workspace @ai-dev-os/process-broker
```

Use plain `npm ci`. Exactly one dependency lifecycle script runs on install —
`better-sqlite3`'s `install` hook, which fetches a prebuilt native binding and is
required by `@ai-dev-os/persistence-sqlite`. No first-party package declares an
install hook. `npm ci --ignore-scripts` works for anything that does not need that
binding, including typecheck, build, and `npm audit`, and CI uses it for the audit
job. [CONTRIBUTING.md](CONTRIBUTING.md) records the full audit.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on pushes to
maintained branches and on pull requests targeting `main`:

| Job | Platform | Runs |
| --- | --- | --- |
| `check` | Ubuntu **and** Windows | `npm ci`, `npm run check` |
| `dependency audit` | Ubuntu | `npm ci --ignore-scripts`, `npm audit --audit-level=high` |
| `coverage` | Ubuntu | `npm run test:coverage`, uploads reports |

Every action is pinned to a full commit SHA, because a tag is a mutable pointer.
Top-level permissions are `contents: read`, and pull-request code never runs with
a writable token.

CI deliberately performs no elevation, no writes to protected locations, no
AppContainer or Job object creation, no proof-mode native build or execution, no
live provider calls, and no publication, and it configures no secrets. The native
components are built and self-tested only by the local packaging script under
explicit human operation.

## Repository layout

```text
packages/              32 domain, application, and adapter modules
docs/adr/              Architecture decision records
docs/development/      Contributor and GitHub workflow policy
.github/workflows/     CI
```

`packages/` is a single npm workspace. Internal dependencies are declared
explicitly with no dependency cycle. Nothing is published to a registry.

## Provider-neutral model configuration

Provider and model identifiers are **opaque configuration**, not names the code
reasons about. The router can select any configured eligible inference target
without name heuristics and with no built-in commercial preference, and usage and
reset facts come only from normalized authorized observations rather than guessed
provider policy.

Credentials are never stored in this repository. They are resolved at runtime by
reference through the scoped-secret broker in `packages/secrets`. Live provider
calls are explicit opt-in operations behind policy and scoped-secret boundaries,
and are skipped by default in tests.

## Security

Report vulnerabilities **privately** — see [SECURITY.md](SECURITY.md). Do not open
a public issue for a vulnerability.

Before reporting, note that this project records its own limitations in detail. A
report that a documented, gated limitation exists is not a vulnerability report. A
report that one of the **gates does not actually hold** is exactly what would be
most valuable.

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
it requires implementing a real enforcing backend for each advertised platform.
