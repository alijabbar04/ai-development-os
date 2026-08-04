# AI Development OS

AI Development OS is a local-first orchestration engine for software engineering. It coordinates remote reasoning models, Claude Code, and local Ollama models through a durable task graph, policy-controlled routing, isolated repository workspaces, persistent project memory, and an auditable desktop control surface.

This repository is being delivered in tested modules. Stages 0 through 13 are complete: the task-graph kernel, domain vocabulary, persistence, content-addressed artifact storage, provider contracts, configuration/secrets/policy, Ollama and cloud inference adapters, workspace/process isolation, Claude Code and Codex coding-agent adapters, the strict OpenAI Responses adapter, the explicit multi-provider catalog/gateway, and a durable provider-neutral quota/cost/health/usage/capacity evidence ledger. Stage 13 reconciles cumulative and terminal usage without double counting, keeps billed/subscription-equivalent/unknown cost distinct, and provides scoped current-state and deterministic forecast evidence without taking over routing or scheduling.

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
