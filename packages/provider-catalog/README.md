# Provider catalog

This package contains the Stage 12 curated provider/model catalog. It is data and validation logic, not a network updater or a model router.

The bundled snapshot was verified on 2026-08-03 and expires its free-tier claims on 2026-08-10. After that boundary, `selectCatalogModel(..., { requireVerifiedFreeTier: true })` fails closed until an operator supplies a newly verified snapshot. A zero price is not treated as a permanent entitlement.

The catalog records exact HTTPS origins and allowed path templates, official provenance, authentication class, data-practice claims, quota semantics, capability evidence, restrictions, and deterministic SHA-256 fingerprints. Parsers reject unknown schemas and fields, ambiguous or non-normalized identities, unsafe or encoded paths, unsupported capability claims without evidence, invalid verification windows, and fingerprint mismatches. Remote envelopes require a signature and caller-supplied verification implementation. No network download behavior exists here.

Deterministic overlays replace whole provider entries by stable ID and then revalidate and fingerprint the complete snapshot. They cannot inject arbitrary transport configuration outside the schema.

Built-in profiles and models:

- Google Gemini API / `gemini-3.5-flash`
- GroqCloud / `openai/gpt-oss-120b`
- Cerebras Inference / `gpt-oss-120b`
- OpenRouter / `openai/gpt-oss-20b:free`

`openrouter/free` is deliberately absent because it is an automatic model router rather than a deterministic model identity.

The dated Cerebras entry records a 131,072-token context and 40,960-token maximum completion. Its “free” state means a payment-method-gated $5 trial whose credits expire after 30 days, not recurring production capacity. Groq and Cerebras quotas are organization-scoped; OpenRouter free access remains account/rate/upstream constrained.
