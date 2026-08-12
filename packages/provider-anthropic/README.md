# `@ai-dev-os/provider-anthropic`

Stage 18B's direct Anthropic inference boundary. It implements the shared
`InferenceProvider` contract over an exact injected Messages API HTTP seam. It
is separate from `@ai-dev-os/provider-claude-code`: no executable, workspace,
consumer session, account UI, or subscription route exists here.

The public provider is compiled production-disabled. Construction performs no
I/O and `start()` refuses before policy, secret, or transport access. The
`./testing` entry point contains the injected deterministic provider ports plus
one separately explicit live-canary harness. Normal tests use only the
deterministic transport. The canary requires its exact opt-in sentinel, fixed
policy/catalog/authorization preflight, and one scoped `SecretRef`; it is not
reachable from the production package entry point.

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
retention documentation reviewed again on 2026-08-12. The fixed canary uses
`POST /v1/messages`, `anthropic-version: 2023-06-01`, and the pinned model
`claude-haiku-4-5-20251001`; standard commercial API inputs/outputs carry the
documented 30-day deletion period unless a separately contracted zero-data-
retention arrangement applies. Primary references:

- <https://platform.claude.com/docs/en/api/messages/create>
- <https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions>
- <https://platform.claude.com/docs/en/api/errors>
- <https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data>
- <https://privacy.claude.com/en/articles/8956058-i-have-a-zero-data-retention-agreement-with-anthropic-what-products-does-it-apply-to>

The official SDK is not a dependency: this checkpoint has no production
transport, and the injected HTTP contract is sufficient for deterministic
compatibility evidence.

```powershell
npm run typecheck --workspace @ai-dev-os/provider-anthropic
npm test --workspace @ai-dev-os/provider-anthropic
npm run test:coverage --workspace @ai-dev-os/provider-anthropic
npm run build --workspace @ai-dev-os/provider-anthropic
```

The reviewed canary harness is supplied under `./testing`; no live provider call
was run for this checkpoint because no supported owned secret reference was
provided, and `ANT-02` therefore remains incomplete.
