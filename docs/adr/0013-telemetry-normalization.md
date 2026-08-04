# ADR 0013: Ledger-local cache-write accounting; no new redaction contract

Status: Accepted for Stage 13.

## Context

OpenAI, Codex, and Claude can expose cache-write/cache-creation counts through provider-specific public observations, while the shared Stage 2 `TokenUsage` contract has four disjoint categories and some generic adapters expose only that lower-resolution view. Stage 11 also asked whether a disclosure boolean should become an explicit applied-transformation list.

## Decision

Stage 13 keeps `TokenUsage` backward compatible and introduces a ledger-local normalized split: uncached input, cache-write input, cached-read input, visible output, reasoning, unknown/combined, and tool calls, plus category completeness. Exact provider observations use the richer split. Generic `ProviderUsage` remains a valid four-category observation. Explicit source identity/fingerprint deduplicates two views of the same upstream fact; cache writes are never counted in both uncached and cache-write totals.

The shared policy package already carries `transformationsApplied` in its runtime-validated policy request. The ledger stores no prompt/response body and runs no content transformation. It therefore records content absence by schema and does not invent an “applied redaction” claim or widen another shared contract. No second independent content-bearing consumer needs a new vocabulary in this stage.

## Consequences

- No Stage 2 parser, budget, persistence consumer, provider fixture, or canonical fingerprint migrates.
- OpenAI/Codex/Claude exact evidence is preserved when their public surface exposes it; a generic result is labeled lower resolution rather than guessed apart.
- Later budget settlement can explicitly project cache writes into ordinary input only at the existing Stage 2 boundary.
- A future shared-contract change requires at least two concrete consumers and a migration across all providers; this ADR does not pre-approve it.
- Telemetry events cannot claim transformations that never ran, and no content or credential material is added to the ledger.
