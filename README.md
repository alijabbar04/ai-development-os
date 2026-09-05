# AI Development OS

AI Development OS is a local-first orchestration engine for software engineering. It coordinates remote reasoning models, Claude Code, and local Ollama models through a durable task graph, policy-controlled routing, isolated repository workspaces, persistent project memory, and a planned auditable Windows desktop control surface.

This repository is being delivered in tested modules. Stages 0 through 16 are complete: the task-graph kernel, domain vocabulary, persistence, content-addressed artifact storage, provider contracts, configuration/secrets/policy, Ollama and cloud inference adapters, workspace/process isolation, Claude Code and Codex coding-agent adapters, the strict OpenAI Responses adapter, the explicit multi-provider catalog/gateway, a durable provider-neutral quota/cost/health/usage/capacity evidence ledger, deterministic fixed-revision repository indexing, provenance-aware scoped memory, deterministic context packing, deterministic policy-bound prompt compilation, replaceable authority-free inference planning, repository-aware task profiling, evidence-bound token estimation, and hard-constrained quota-aware routing.

Stage 15 keeps every retrieved context body in the untrusted user layer, compiles a byte-reproducible no-tools inference request only after exact policy/disclosure authorization, invokes one explicitly configured planning alias with no fallback, and accepts only a bounded structured proposal marked `authority: "none"`. It does not execute, approve, schedule, route, edit, or mutate a task graph.

Stage 16 turns declared, measured, inferred, and optional classifier facts into an immutable task profile, binds exact or conservative token estimates to an opaque provider/profile/model/catalog identity, and selects only among candidates that pass every policy, capability, context, freshness, quota, capacity, circuit, security, cost, budget, latency, and deadline constraint. Scoring cannot revive an excluded candidate. Route, fallback, circuit, reservation, and reconciliation outputs are deterministic plans with no invocation or durable-mutation authority.

Stage 17W is the Windows-only continuation of the active gated Stage 17
checkpoint, not a released stage. The process
broker now treats backend descriptors as advisory, requires opaque measured
registration plus a single-use pre-spawn receipt in production, validates
request/grant/policy/lease monotonicity, and fails closed on unconfirmed
termination or cleanup. Windows is the initial production-release target, but
no native Windows enforcement backend or controlled provider-egress relay has
been proven, so production autonomous execution remains refused and no Stage 17
release tag exists. Linux/macOS production integration is deferred to Stage 25
and remains unavailable/unverified rather than passing.

Exact two-parent candidate `e06db598bc14238156b8d7b378320e35b2e064cf`
integrates L-03, strengthened L-01, and the lockfile-only `nanoid@3.3.18`
repair. Its independent Claude Opus 4.8/max review passed with no findings, its
audit total is zero, and hosted run `31275835049` passed Ubuntu check, Windows
check, coverage, and dependency audit. Those facts do not establish production
availability or merge the candidate to `main`.

## Status

[![CI](https://github.com/alijabbar04/ai-development-os/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/alijabbar04/ai-development-os/actions/workflows/ci.yml)

**You are reading the Stage 17W integration lineage.** It carries Stage 17 code and evidence
that `main` deliberately does not. The badge above reports CI on `main`.

| Fact | State |
| --- | --- |
| Latest completed release | **`v0.16.0-quota-aware-routing`** |
| Stages 0 – 16 | **Complete**, one tag per stage |
| Stage 17W (Windows secure execution) | **Gated** — integrated candidate present, **not merged** to `main`, **not tagged**, production unavailable |
| Linux/macOS production platforms | **Deferred to Stage 25**, unavailable/unverified |
| Stage 18 | **Development scope accepted; production remains gated** — `AM-02` and `INT-01` remain proven. On 2026-08-25 one fresh, separately authorized Stage 18E-I Anthropic validation used the exact externally reviewed candidate, a new one-shot marker and the existing owned application-vault `SecretRef`. One provider dispatch attempt was made; there was no retry or fallback. The create-only 38-field receipt and terminal sidecar committed, and the exact named projection proved HTTP 200, the pinned model, exactly one text block containing exactly `OK`, 774 ms duration, 12 input tokens and 4 output tokens without retaining the credential or response body. `ANT-02` is therefore **proven** and `developmentAccepted=true` is derived. The earlier missing-envelope success remains `BLOCKED_EVIDENCE`. `PLN-02` remains incomplete, `productionAdmitted=false`, Stage 17W remains the production gate, and this checkpoint made Stage 20A eligible. |
| Stage 19 | **Stage 19B production-disabled integration checkpoint complete** — deterministic evaluation and serialized local-Git integration are published with exact-final-head hosted CI; production Git effects remain unavailable |
| Stage 20 | **C0-C9 implemented as production-disabled checkpoints** — the read-only control plane remains six GET routes and zero commands; C6 supplies canonical project contracts; C7 extends generic persistence; C8 adds deterministic bounded project intake; and C9 adds pure plan assembly, accepted-brief proof, review/seal predicates, exact lifecycle and injected persistence conformance. C9 exports no route, command, UI, scheduler eligibility, approval/spending authority, provider, credential, or production capability. Command-bearing Stage 20B work has not started. Production remains disabled. |
| Production autonomous execution | **Refuses** |
| Maturity | Pre-1.0. Nothing is published to any registry. |

**This is not production software and does not claim to be.** The version tags
mark completed development stages for provenance; they are not maintained
releases and receive no backports.

Three things are stated plainly because they are easy to assume the other way:

- **Autonomous execution refuses in production, by design.** No built-in sandbox
  backend is classified as genuinely enforcing. See the last section of this file.
- **Stage 17W is a gated checkpoint, not a released stage.** No native Windows
  enforcement backend has been proven. A 2026-08-14 remover-only follow-up
  reproduced the reviewed artifact but returned exit code `2`; it did not
  authorize a retry or protected-state observation, so current residue is
  unknown. The ordinary lifecycle and Windows escape corpus remain unrun, and
  no `v0.17` tag exists. **Windows containment is not claimed.**
- **Linux and macOS are deferred, not passing.** Their portable seams and
  evidence stay intact, while native enforcement, L-02, packaging, and parity
  move to Stage 25.
- **Stage 18 development acceptance does not admit production.** `AM-02` and
  `INT-01` remain proven. A fresh 2026-08-25 Stage 18E-I operation used one
  separately authorized candidate-bound packet and new marker over the existing
  owned application-vault `SecretRef`. Its create-only canonical receipt and
  terminal sidecar committed before Valid reduction; the exact named projection
  ran once and the committed validator proved the pinned request, HTTP 200,
  exact model and `OK` content, duration and usage. One provider dispatch
  attempt was made; no retry or fallback occurred.
  `ANT-02` is now proven and `developmentAccepted=true`. Earlier consumed
  attempts retain their historical classifications, including the distinct
  `BLOCKED_EVIDENCE` success whose missing fields were not reconstructed.
  `PLN-02` remains incomplete, the admission schema still has no admitted
  variant, `productionAdmitted=false`, and Stage 17W remains the production
  gate. Stage 20A C0-C5 is complete and externally reviewed. C6 adds the pure
  canonical project contract spine, C7 adds its generic persistence vocabulary,
  and C8 adds a production-disabled project-intake library. C8 candidates and
  clarification rounds remain ephemeral until explicit acceptance; its only
  durable boundary is one injected atomic `project-brief` transaction. C9 adds
  the production-disabled `@ai-dev-os/plan` contract: deterministic assembly,
  current accepted-brief proof, provenance/specification/coverage binding,
  six-condition seal evaluation, exact lifecycle, and an isolated memory/real-
  SQLite persistence conformance composition. It adds no route, command, UI,
  scheduling eligibility, approval/spending authority, provider, credential,
  task execution, or production action. Command-bearing Stage 20B work has not
  started.

## Documents

- [Technical design](docs/technical-design.md) — architecture and boundaries
- [Implementation roadmap](docs/implementation-roadmap.md) — what is delivered, in
  progress, and deliberately not started
- [Windows product direction](docs/product-direction.md) — Normal/Developer UI,
  authorized-profile routing, permission profiles, and communications
- [Architecture decision records](docs/adr/) — why each boundary is where it is,
  and what each decision does **not** authorize
- [Windows-first scope decision](docs/adr/0019-windows-first-production-scope.md)
- [Release evidence](docs/release-evidence/) — measured per-checkpoint results,
  including limitations that remain unresolved. Present on this branch.
- [Product-completeness planning decision](docs/adr/0016-product-completeness-planning-assembly.md)
- [Operator-authorized fixed-subject audit decision](docs/adr/0029-stage-18-operator-authorized-fixed-subject-audit.md)
- [Anthropic canary effect-classification decision](docs/adr/0030-stage-18-anthropic-effect-classification.md)
- [Stage 8 completion report](docs/stage-8-completion.md)
- [Contributing](CONTRIBUTING.md) — including the testing standards, which are
  stricter than most projects' and are explained
- [GitHub workflow policy](docs/development/github-workflow.md)
- [Security policy](SECURITY.md) · [Support](SUPPORT.md) ·
  [Code of conduct](CODE_OF_CONDUCT.md)

Stage 17 evidence is under `docs/release-evidence/` on this branch. It is **not**
on `main`, because `main` carries the completed release lineage and no Stage 17
code.

## Requirements

- Node.js 22.9 or newer (CI runs Node 24)
- npm 10 or newer

## Commands

Every command below was run against this repository.

```powershell
npm ci             # lockfile-exact install
npm run check      # typecheck, then tests, then build, across all 40 packages
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
| `check` | Ubuntu **and** Windows | `npm ci`, `npm run check`; Windows additionally builds the production-disabled exact-read credential addon and requires malformed-target refusal plus fresh-random-target `not-found` through availability and read |
| `dependency audit` | Ubuntu | `npm ci --ignore-scripts`, `npm audit --audit-level=high` |
| `coverage` | Windows | `npm run test:coverage`, uploads reports |
| `PostgreSQL integration` | Ubuntu hosted test infrastructure | pinned disposable PostgreSQL service, real persistence/application contracts and contention |

Every action is pinned to a full commit SHA, because a tag is a mutable pointer.
Top-level permissions are `contents: read`, and pull-request code never runs with
a writable token.

CI deliberately performs no elevation, no writes to protected locations, no
AppContainer or Job object creation, no Stage 17 proof-mode native build or
execution, no live provider calls, and no publication. It configures no
provider/operator credential secret; GitHub supplies only the normal ephemeral
read-only job token and checkout does not persist it. Stage 17 native components
remain local explicit-operator packaging only. The separate production-disabled
credential addon is built on hosted Windows and probes one fresh random target;
only exact `not-found` results support the no-credential-access claim.

## Repository layout

```text
packages/              40 domain, application, and adapter modules
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

## Stage 19 packages

- [`@ai-dev-os/evaluation`](packages/evaluation/README.md) validates exact bounded deterministic evidence against externally trusted subject-bound criterion-manifest, evidence-instance, and waiver-digest allowlists, preserves non-authoritative model disagreement, produces authority-free completeness findings, and journals command-equivalent evaluation runs through the persistence port.
- [`@ai-dev-os/integrator`](packages/integrator/README.md) binds an accepted evaluation admission to exact commits, trees, ordered parents, paths, validation and authority; journals a serialized fenced effect intent and exact receipt; refuses ambiguous retry; and exposes a real sanitized Git implementation only through its disposable-fixture testing subpath. Production Git effects remain literally disabled.

## Stage 20 packages

- [`@ai-dev-os/api`](packages/api/README.md) is the pure, framework-independent, route-free C2 envelope and allowlist-projection boundary.
- [`@ai-dev-os/control-service`](packages/control-service/README.md) is the production-disabled C3-C5 literal-loopback read host with exact lifecycle/adoption and six GET, zero-command authority.
- [`@ai-dev-os/project`](packages/project/README.md) is the pure C6 canonical project spine: strict versioned records, deterministic serialization, total state tables, and authority-free health/summary/display projections. It has no persistence, runtime capability, or command surface.
- [`@ai-dev-os/intake`](packages/intake/README.md) is the production-disabled C8 intake library: deterministic candidates with field provenance, bounded clarification, constrained injected repository observation, explicit acceptance into one C7 `project-brief` lineage, finite recovery, and authority-free Normal/Developer projections. It exposes no route or command.
- [`@ai-dev-os/plan`](packages/plan/README.md) is the production-disabled C9 planning library: strict proposal/specification/provenance parsing, deterministic C6 plan assembly, accepted-brief and six-condition seal proof, exact lifecycle and ambiguity observation, and an isolated C8/C7 memory/SQLite conformance composition. Its production root exposes no authorization issuer, adapter, route, command, or execution capability.

Provider/model IDs remain opaque configuration. The router can choose any configured eligible GPT or Claude inference target without name heuristics or a built-in commercial preference. Claude Code and Codex adapters implement the separate coding-agent contract and cannot be used as inference thinkers. The first-party Anthropic inference adapter remains production-disabled. Earlier canary attempts remain consumed at their recorded outcomes; a fresh candidate-bound attempt produced the complete sanitized receipt required to prove `ANT-02`. One provider dispatch attempt was made; no retry occurred. That development evidence grants no general provider, task, or production authority. Usage/reset facts come only from normalized authorized observations, never guessed provider policy. The exact-pinned Account Manager reader emits `claude-code` observations; this closure performed no new installed-state read.

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
