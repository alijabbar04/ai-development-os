/**
 * Usage and cost mapping.
 *
 * Only values Claude actually reports are mapped. Nothing is inferred: an
 * absent token category is zero because Claude reported no tokens in it, and
 * an absent cost is unknown rather than estimated.
 *
 * Partial-stream usage and the terminal result are reconciled rather than
 * summed. Claude's `usage` block is a cumulative snapshot of the session, so
 * treating the terminal record as a delta on top of streamed snapshots would
 * double count every token.
 */

import { parseTokenUsage, type Money, type TokenUsage } from "@ai-dev-os/domain";
import { UNKNOWN_COST, type ProviderCost, type ProviderUsage } from "@ai-dev-os/providers";
import type { ClaudeAuthenticationMode } from "./config.js";
import type { ClaudePerModelUsage, ClaudeUsageCounts } from "./wire.js";

/**
 * Maps Claude's token categories onto the Stage 2 disjoint categories.
 *
 * Claude's `input_tokens` already excludes cached reads, which matches the
 * domain contract exactly. Cache-creation tokens are billed and counted as
 * ordinary input, so they are added to `inputTokens`; cache reads map to
 * `cachedInputTokens`. Claude does not report a separate reasoning-token count
 * in this surface, so `reasoningTokens` stays zero rather than being guessed
 * out of the output total.
 */
export function toProviderUsage(counts: ClaudeUsageCounts | null, toolCalls: number): ProviderUsage {
  const tokens: TokenUsage = parseTokenUsage({
    inputTokens: (counts?.inputTokens ?? 0) + (counts?.cacheCreationInputTokens ?? 0),
    outputTokens: counts?.outputTokens ?? 0,
    cachedInputTokens: counts?.cacheReadInputTokens ?? 0,
    reasoningTokens: 0,
  });
  return Object.freeze({ tokens, toolCalls });
}

export const ZERO_CLAUDE_USAGE: ClaudeUsageCounts = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

/** Scalar used to prove a cumulative snapshot never went backwards. */
export function usageTotal(counts: ClaudeUsageCounts): number {
  return (
    counts.inputTokens + counts.outputTokens + counts.cacheCreationInputTokens + counts.cacheReadInputTokens
  );
}

export type UsageReconciliation =
  | { readonly ok: true; readonly counts: ClaudeUsageCounts }
  | { readonly ok: false; readonly reason: "non-monotonic" | "negative" };

/**
 * Accepts a new cumulative snapshot only when it is at least as large as the
 * previous one in every category. A category that shrinks means the snapshots
 * are not what the protocol says they are, and the operation fails rather than
 * reporting a total the adapter cannot justify.
 */
export function reconcileUsage(
  previous: ClaudeUsageCounts,
  next: ClaudeUsageCounts,
): UsageReconciliation {
  for (const value of [
    next.inputTokens,
    next.outputTokens,
    next.cacheCreationInputTokens,
    next.cacheReadInputTokens,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return Object.freeze({ ok: false, reason: "negative" });
    }
  }
  if (
    next.inputTokens < previous.inputTokens ||
    next.outputTokens < previous.outputTokens ||
    next.cacheCreationInputTokens < previous.cacheCreationInputTokens ||
    next.cacheReadInputTokens < previous.cacheReadInputTokens
  ) {
    return Object.freeze({ ok: false, reason: "non-monotonic" });
  }
  return Object.freeze({ ok: true, counts: next });
}

/** Sums per-model usage into one cumulative snapshot. */
export function sumModelUsage(entries: readonly ClaudePerModelUsage[]): ClaudeUsageCounts {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  for (const entry of entries) {
    input += entry.inputTokens;
    output += entry.outputTokens;
    cacheRead += entry.cacheReadInputTokens;
    cacheCreate += entry.cacheCreationInputTokens;
  }
  return Object.freeze({
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreate,
  });
}

export const CLAUDE_COST_SEMANTICS = Object.freeze([
  "billed-api-cost",
  "subscription-equivalent-estimate",
  "unknown",
] as const);
export type ClaudeCostSemantics = (typeof CLAUDE_COST_SEMANTICS)[number];

/**
 * Decides what Claude's `total_cost_usd` actually means for this deployment.
 *
 * Under API-key or cloud-provider billing the reported figure corresponds to a
 * real charge and maps to `providerReported`. Under a personal subscription
 * login it is an API-equivalent estimate for work that was not billed that way,
 * so presenting it as a charge would be false. The provider-neutral cost
 * contract has no field for "estimate for something billed differently", so the
 * cost is reported unknown and the figure travels only as a provider-specific
 * observation.
 */
export function costSemanticsFor(mode: ClaudeAuthenticationMode): ClaudeCostSemantics {
  switch (mode) {
    case "api-key-secret-ref":
    case "cloud-provider-credential":
    case "enterprise-gateway":
      return "billed-api-cost";
    case "personal-local-cli-login":
      return "subscription-equivalent-estimate";
  }
}

export interface ClaudeCostMapping {
  readonly cost: ProviderCost;
  readonly semantics: ClaudeCostSemantics;
  /** The provider-reported figure in integer micro-dollars, for observations. */
  readonly reportedMicros: number | null;
}

export function mapCost(input: {
  readonly reportedMicros: number | null;
  readonly authenticationMode: ClaudeAuthenticationMode;
}): ClaudeCostMapping {
  const semantics = input.reportedMicros === null ? "unknown" : costSemanticsFor(input.authenticationMode);
  if (semantics !== "billed-api-cost" || input.reportedMicros === null) {
    return Object.freeze({
      cost: UNKNOWN_COST,
      semantics,
      reportedMicros: input.reportedMicros,
    });
  }
  const money: Money = Object.freeze({
    currency: "USD" as Money["currency"],
    amountMicros: input.reportedMicros,
  });
  return Object.freeze({
    cost: Object.freeze({ providerReported: money, locallyComputed: null }),
    semantics,
    reportedMicros: input.reportedMicros,
  });
}
