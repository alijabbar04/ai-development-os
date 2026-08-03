# OpenAI-compatible provider adapter

This package implements a bounded Chat Completions subset for three fixed profiles: Groq, Cerebras, and OpenRouter. It does not reuse or imitate the Stage 11 Responses wire protocol.

Callers select one configured provider instance and one catalog model explicitly. They cannot set origins, paths, redirects, authorization headers, or arbitrary transport headers. OpenRouter requests pin a concrete model and send `allow_fallbacks: false`, `require_parameters: true`, and `data_collection: "deny"`; the automatic `openrouter/free` model router is unsupported.

Request capability checks occur before policy, secret resolution, and HTTP. `createPolicyAwareProviderAccess` then evaluates an exact cloud-execution decision and uses the Stage 6 policy-aware secret resolver with the instance's own `SecretRef`. API-key material is available only inside the callback that starts the HTTP request.

Serialized requests are capped at 8 MiB. Both JSON and fragmented SSE responses are byte-bounded and runtime-validated. The request timeout covers connection, headers, and complete body consumption; an earlier caller deadline bounds the same interval and remains distinguishable from caller cancellation. Redirects, model/role/choice substitution, unknown terminal finish reasons, duplicate or incomplete tool calls, oversized or malformed arguments, invalid UTF-8/JSON, missing model/usage/finish evidence, truncated streams, and continuation after a terminal finish or `[DONE]` fail with typed provider errors. The adapter never retries or falls back.

`@ai-dev-os/provider-openai-compatible/testing` exports the reusable finite-profile contract suite used against Groq, Cerebras, and OpenRouter.

Live canaries are excluded from ordinary tests and skip unless both a provider-specific switch and key exist:

- `AI_DEV_OS_LIVE_GROQ=1` plus `GROQ_API_KEY`, then `npm run test:live:groq`
- `AI_DEV_OS_LIVE_CEREBRAS=1` plus `CEREBRAS_API_KEY`, then `npm run test:live:cerebras`
- `AI_DEV_OS_LIVE_OPENROUTER=1` plus `OPENROUTER_API_KEY`, then `npm run test:live:openrouter`

Each canary makes one explicit-model request with a 24-token cap. Keys and bodies are never printed.

Only the providers' documented API-key flows are supported. Browser cookies, consumer sessions, unofficial OAuth, keyless transports, account cycling, proxy/TLS impersonation, and quota-evasion integrations are deliberately excluded. Runtime headers are observations for a gateway quota port; Stage 13 owns normalized historical usage and forecasting, while automatic routing belongs to a later stage.
