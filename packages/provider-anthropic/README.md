# `@ai-dev-os/provider-anthropic`

Stage 18B's direct Anthropic inference boundary. It implements the shared
`InferenceProvider` contract over an exact injected Messages API HTTP seam. It
is separate from `@ai-dev-os/provider-claude-code`: no executable, workspace,
consumer session, account UI, or subscription route exists here.

The public provider is compiled production-disabled. Construction performs no
I/O and `start()` refuses before policy, secret, or transport access. The
`./testing` entry point accepts only injected deterministic ports and exists to
exercise request/wire mapping, provider contracts, failure handling, and race
semantics without a credential or network call.

The fixed profile is `POST https://api.anthropic.com/v1/messages` with
`anthropic-version: 2023-06-01`. Deployments configure one explicit model alias
and one exact expected response-model identity. Unknown aliases and model
substitution fail closed; no discovery or fallback occurs.

Policy authorization precedes scoped `SecretRef` resolution, which precedes
opening the injected transport. Secret material is callback-scoped and never
enters configuration, events, errors, results, or observations. Standard API
retention and separately contracted zero-data-retention are explicit profile
modes. A no-retention disclosure cannot use a standard-retention profile.

Policy and credential preflight are covered by caller cancellation, provider
close, wall-time, and deadline from the moment policy work starts. Streaming is
bounded by event, byte, output, tool-argument, wall-time, and deadline ceilings.
The adapter validates Anthropic event ordering, contiguous single-open content
blocks, exactly one terminal `message_delta`, structured JSON against a
preflight-validated bounded caller-schema subset, bounded initial and streamed
tool JSON, cumulative usage, stop reason, and exactly one terminal. It maps only
finite redacted provider errors and
never serializes raw headers or provider/request bodies.

Caller schema depth, nodes, collections, enum values, and evaluation work are
finite. Malformed supported keywords are rejected before effects. The
JavaScript `pattern` and floating-point `multipleOf` keywords are intentionally
unsupported to prevent caller-controlled regular-expression work from
bypassing wall-time bounds and fail-open approximate divisibility checks.
This stage also rejects configured price catalogs, advertises pricing as
unavailable, and reports cost as unknown.

The implementation follows the official Anthropic Messages, streaming,
structured-output, tool-use, errors, versioning, model-identity, and commercial
retention documentation reviewed on 2026-08-09. The official SDK is not a
dependency: this checkpoint has no production transport, and the injected HTTP
contract is sufficient for deterministic compatibility evidence.

```powershell
npm run typecheck --workspace @ai-dev-os/provider-anthropic
npm test --workspace @ai-dev-os/provider-anthropic
npm run test:coverage --workspace @ai-dev-os/provider-anthropic
npm run build --workspace @ai-dev-os/provider-anthropic
```

No live canary is supplied or run in Stage 18B.
