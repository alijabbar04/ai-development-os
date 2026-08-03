# `@ai-dev-os/provider-codex`

Stage 10's Codex coding-agent adapter implements the shared `CodingAgentProvider` contract over Codex App Server's stdio JSONL transport. It does not scrape the TUI and never invokes `thread/shellCommand` or exposes raw `command/exec`.

## Security boundary

All version probes, schema generation, account reads, and App Server sessions use an injected `CodexProcessPort`. `createBrokeredCodexProcessPort` binds that port to the Stage 8 process broker, a capability grant, an execution lease, a managed private worktree, and one trusted absolute executable descriptor. The adapter never resolves an executable through `PATH`, constructs a command string, enables a shell, or retries a production refusal through the unsafe development backend.

The Codex sandbox is defense in depth; it is not treated as proof that the outer process backend is secure. Read operations use `readOnly`, edits use `workspaceWrite`, and network access is disabled. MCP servers, web search, apps, plugins, and skills are disabled. Executable allowlists are not approximated with shell text: an allow-listed command policy is rejected as unsupported.

Configuration is versioned, exact-key validated, deeply immutable, and fingerprinted without credentials. It covers the executable identity, version range, models and efforts, token/process/cost ceilings, deadlines, JSONL bounds, persistence, sandbox/approval mappings, classifications, telemetry staleness, and a credential-free authentication classification. `.cmd` and `.bat` shims, unsafe values, unknown fields, prototype pollution, and inline option-like pinned arguments are rejected.

## Protocol behavior

Each connection performs `initialize` followed by `initialized`. The transport bounds records, stream bytes, request IDs, pending requests, writes, and event queues. It rejects malformed JSON, invalid UTF-8, unsafe numbers, prototype keys, unknown IDs, duplicate responses, early messages, and unknown state-changing methods.

Operations use an explicit `thread/start` or a verified `thread/resume`, followed by `turn/start`; cancellation uses `turn/interrupt`. Resume tokens bind thread and session IDs to the provider instance, project, managed-workspace lineage, model, effort, configuration fingerprint, policy, and expiry. Ambient or recent-thread continuation is never used. Sessions are ephemeral unless configuration, disclosure, and policy all permit retention.

Approval requests are answered only from prevalidated evidence matching the exact approval ID, thread, turn, action, risk, subject digest, and expiry. `acceptForSession` additionally requires explicit repeated-action evidence. Missing, forged, or expired evidence declines; cancellation evidence cancels.

App Server diff claims and narrative test claims are advisory. Terminal handling reconciles the actual managed worktree, including failure paths, and enforces grant prefixes, request prefixes, changed-file/byte limits, administrative paths, links, and source-repository separation. Patches, test reports, and optional private commits are produced through workspace and artifact ports.

## Public surface

The package exports:

- `createCodexProvider`
- `createCodexAdapterConfiguration` and its fingerprint
- `createBrokeredCodexProcessPort`
- `createCodexWorkspaceHandle`
- `probeCodex` and the version/schema compatibility matrix
- safe account, rate-limit, account-usage, and per-turn usage snapshots
- bounded session-token and reconciliation helpers
- injected workspace, artifact, policy, approval, process, clock, and scheduler port types

Raw JSONL and App Server wire objects remain internal.

## Telemetry semantics

`account/read`, `account/rateLimits/read`, and `account/usage/read` are read-only. Rate windows remain separate and retain used percentage, duration, reset time, observation time, staleness, credits, and source. The adapter does not invent token balances from percentages and never consumes reset credits or sends account emails. Account usage under API-key or Bedrock authentication is `unsupported`, not zero. Costs remain unknown because App Server does not provide a verified per-turn billed-cost value.

## Development and verification

```powershell
npm run typecheck --workspace @ai-dev-os/provider-codex
npm test --workspace @ai-dev-os/provider-codex
npm run test:coverage --workspace @ai-dev-os/provider-codex
npm run build --workspace @ai-dev-os/provider-codex
```

The normal suite uses a real Node child process through the real process broker. Node and the fake App Server script are a trusted executable plus pinned prefix; no shell shim is involved.

Live canaries are skipped unless both an absolute `AI_DEV_OS_CODEX_EXECUTABLE` and the specific flag are present:

- `AI_DEV_OS_CODEX_LIVE_PROBE=1`
- `AI_DEV_OS_CODEX_LIVE_ACCOUNT=1`
- `AI_DEV_OS_CODEX_LIVE_READ_ONLY=1` plus `AI_DEV_OS_CODEX_LIVE_MODEL`
- `AI_DEV_OS_CODEX_LIVE_EDIT=1` plus `AI_DEV_OS_CODEX_LIVE_MODEL`

The model canaries operate only in a disposable managed repository created by the test harness.

## Current boundary

Stage 8 has no production `secure-enforcing` backend, so autonomous production sessions correctly refuse before spawn. This package does not provide arbitrary MCP/apps/connectors, external-sandbox equivalence, account login UI, reset redemption, purchase actions, cloud tasks, or a production sandbox backend.
