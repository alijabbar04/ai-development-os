# Provider gateway

The Stage 12 gateway is an explicit registry and invocation composition layer. A caller must supply both `instanceId` and the matching provider-contract `modelId`. The snapshot also exposes the exact catalog/upstream model ID, profile, provenance, expiry, catalog fingerprints, adapter reference, and a non-secret `SecretRef` fingerprint.

The gateway performs no ranking, recommendation, automatic model selection, task allocation, cost optimization, fallback, retry, speculative fan-out, quota evasion, or cross-provider credential substitution. One `invoke` call reaches exactly one registered `InferenceProvider`; any retry disposition in a returned error is descriptive only.

Registrations reject duplicate instances, ambiguous catalog bindings, unavailable models, model/descriptor mismatches, token-limit or capability overclaims, profile mismatches, wrong secret kinds, cross-instance `SecretRef` reuse, and every `SecretRef` not bound to that exact provider instance. Instance snapshots, including their nested catalog references, are immutable. Configuration fingerprints exclude runtime health and quota observations, which are retrieved through separate typed ports. User preference and free-tier eligibility are independent fields. `verified-free-only` invocation fails closed when catalog verification expires.

Runtime health and quota values remain timestamped observations. Stage 13 owns normalized usage accounting, forecasting, and reset estimation; intelligent ranking and routing remain later-stage work.
