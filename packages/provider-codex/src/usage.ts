import { parseTokenUsage } from "@ai-dev-os/domain";
import type { ProviderUsage } from "@ai-dev-os/providers";

export interface CodexTokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}
export const ZERO_CODEX_USAGE: CodexTokenUsage = Object.freeze({ inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });

function count(record: Record<string, unknown>, name: string): number | null {
  const value = record[name];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000 ? value : null;
}

export function parseCodexTokenUsage(value: unknown): CodexTokenUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const inputTokens = count(record, "inputTokens");
  const cachedInputTokens = count(record, "cachedInputTokens");
  const cacheWriteInputTokens = count(record, "cacheWriteInputTokens");
  const outputTokens = count(record, "outputTokens");
  const reasoningOutputTokens = count(record, "reasoningOutputTokens");
  if ([inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens].some((entry) => entry === null)) return null;
  return Object.freeze({ inputTokens: inputTokens!, cachedInputTokens: cachedInputTokens!, cacheWriteInputTokens: cacheWriteInputTokens!, outputTokens: outputTokens!, reasoningOutputTokens: reasoningOutputTokens! });
}

export function reconcileCodexUsage(previous: CodexTokenUsage, next: CodexTokenUsage): CodexTokenUsage | null {
  for (const key of Object.keys(previous) as Array<keyof CodexTokenUsage>) if (next[key] < previous[key]) return null;
  return next;
}

export function toProviderCodexUsage(usage: CodexTokenUsage, toolCalls: number): ProviderUsage {
  return Object.freeze({
    tokens: parseTokenUsage({
      inputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens) + usage.cacheWriteInputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: Math.max(0, usage.outputTokens - usage.reasoningOutputTokens),
      reasoningTokens: usage.reasoningOutputTokens,
    }),
    toolCalls,
  });
}
