# AI Development OS

AI Development OS is a local-first orchestration engine for software engineering. It coordinates remote reasoning models, Claude Code, and local Ollama models through a durable task graph, policy-controlled routing, isolated repository workspaces, persistent project memory, and an auditable desktop control surface.

This repository is being delivered in tested modules. Stages 0 through 15 are complete: the task-graph kernel, domain vocabulary, persistence, content-addressed artifact storage, provider contracts, configuration/secrets/policy, Ollama and cloud inference adapters, workspace/process isolation, Claude Code and Codex coding-agent adapters, the strict OpenAI Responses adapter, the explicit multi-provider catalog/gateway, a durable provider-neutral quota/cost/health/usage/capacity evidence ledger, deterministic fixed-revision repository indexing, provenance-aware scoped memory, deterministic context packing, deterministic policy-bound prompt compilation, and replaceable authority-free inference planning.

Stage 15 keeps every retrieved context body in the untrusted user layer, compiles a byte-reproducible no-tools inference request only after exact policy/disclosure authorization, invokes one explicitly configured planning alias with no fallback, and accepts only a bounded structured proposal marked `authority: "none"`. It does not execute, approve, schedule, route, edit, or mutate a task graph.

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

Provider/model IDs remain opaque configuration. Claude Code and Codex adapters implement the separate coding-agent contract and cannot be used as inference thinkers. A concrete Claude model requires a supported inference-provider registration; this repository does not currently ship a direct first-party Anthropic inference adapter.

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
