# AI Development OS

AI Development OS is a local-first orchestration engine for software engineering. It coordinates remote reasoning models, Claude Code, and local Ollama models through a durable task graph, policy-controlled routing, isolated repository workspaces, persistent project memory, and an auditable desktop control surface.

This repository is being delivered in tested modules. The first completed module is the provider-neutral task-graph domain kernel.

## Documents

- [Technical design](docs/technical-design.md)
- [Implementation roadmap](docs/implementation-roadmap.md)

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

The project is pre-1.0. Provider calls and autonomous repository execution are intentionally not enabled until their policy, isolation, and audit modules are in place.
