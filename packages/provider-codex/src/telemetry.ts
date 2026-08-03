import type { CodexClock } from "./ports.js";

export const CODEX_ACCOUNT_KINDS = Object.freeze(["signed-out", "api-key", "chatgpt", "amazon-bedrock", "other"] as const);
export type CodexAccountKind = (typeof CODEX_ACCOUNT_KINDS)[number];
export interface CodexAccountState {
  readonly kind: CodexAccountKind;
  readonly planType: string | null;
  readonly requiresOpenaiAuth: boolean | null;
  readonly observedAt: string;
}
export interface CodexRateWindow {
  readonly limitId: string | null;
  readonly limitName: string | null;
  readonly window: "primary" | "secondary";
  readonly usedPercent: number;
  readonly durationMinutes: number | null;
  readonly resetsAt: string | null;
  readonly planType: string | null;
  readonly credits: { readonly hasCredits: boolean; readonly unlimited: boolean; readonly balance: string | null } | null;
  readonly observedAt: string;
  readonly stale: boolean;
  readonly source: "account/rateLimits/read" | "account/rateLimits/updated";
}
export interface CodexRateLimitSnapshot {
  readonly status: "reported" | "unsupported" | "unknown";
  readonly windows: readonly CodexRateWindow[];
  readonly resetCreditsAvailable: number | null;
  readonly observedAt: string;
}
export interface CodexAccountUsageSnapshot {
  readonly status: "reported" | "unsupported" | "unknown";
  readonly summary: {
    readonly lifetimeTokens: number | null;
    readonly peakDailyTokens: number | null;
    readonly longestRunningTurnSeconds: number | null;
    readonly currentStreakDays: number | null;
    readonly longestStreakDays: number | null;
  } | null;
  readonly dailyBuckets: readonly { readonly startDate: string; readonly tokens: number }[] | null;
  readonly observedAt: string;
}

function record(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown, max = 128): string | null { return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null; }
function count(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }

export function mapCodexAccountState(value: unknown, clock: CodexClock): CodexAccountState {
  const root = record(value); const account = record(root?.["account"]);
  const type = text(account?.["type"]);
  const kind: CodexAccountKind = account === null ? "signed-out" : type === "apiKey" ? "api-key" : type === "chatgpt" ? "chatgpt" : type === "amazonBedrock" ? "amazon-bedrock" : "other";
  return Object.freeze({
    kind,
    planType: text(account?.["planType"]),
    requiresOpenaiAuth: typeof root?.["requiresOpenaiAuth"] === "boolean" ? root["requiresOpenaiAuth"] : null,
    observedAt: clock.now().toISOString(),
  });
}

function credits(value: unknown): CodexRateWindow["credits"] {
  const item = record(value); if (item === null || typeof item["hasCredits"] !== "boolean" || typeof item["unlimited"] !== "boolean") return null;
  const balance = item["balance"] === null ? null : text(item["balance"], 64); if (item["balance"] !== null && balance === null) return null;
  return Object.freeze({ hasCredits: item["hasCredits"], unlimited: item["unlimited"], balance });
}

export function mapCodexRateLimits(value: unknown, input: { readonly clock: CodexClock; readonly stalenessMs: number; readonly source: CodexRateWindow["source"] }): CodexRateLimitSnapshot {
  const root = record(value); const observed = input.clock.now();
  if (root === null) return Object.freeze({ status: "unknown", windows: Object.freeze([]), resetCreditsAvailable: null, observedAt: observed.toISOString() });
  const multi = record(root["rateLimitsByLimitId"]);
  const buckets: Array<[string | null, Record<string, unknown>]> = [];
  if (multi !== null) for (const [key, raw] of Object.entries(multi)) { const bucket = record(raw); if (bucket !== null) buckets.push([key, bucket]); }
  if (buckets.length === 0) { const single = record(root["rateLimits"]); if (single !== null) buckets.push([null, single]); }
  const windows: CodexRateWindow[] = [];
  for (const [fallbackId, bucket] of buckets.slice(0, 64)) {
    for (const windowName of ["primary", "secondary"] as const) {
      const raw = record(bucket[windowName]); if (raw === null) continue;
      const usedPercent = typeof raw["usedPercent"] === "number" && Number.isFinite(raw["usedPercent"]) && raw["usedPercent"] >= 0 && raw["usedPercent"] <= 100 ? raw["usedPercent"] : null;
      if (usedPercent === null) continue;
      const resetsSeconds = count(raw["resetsAt"]);
      const resetsAt = resetsSeconds === null ? null : new Date(resetsSeconds * 1_000).toISOString();
      windows.push(Object.freeze({
        limitId: text(bucket["limitId"]) ?? fallbackId,
        limitName: bucket["limitName"] === null ? null : text(bucket["limitName"]),
        window: windowName,
        usedPercent,
        durationMinutes: raw["windowDurationMins"] === null ? null : count(raw["windowDurationMins"]),
        resetsAt,
        planType: bucket["planType"] === null ? null : text(bucket["planType"]),
        credits: credits(bucket["credits"]),
        observedAt: observed.toISOString(),
        stale: resetsAt !== null && observed.valueOf() - new Date(resetsAt).valueOf() > input.stalenessMs,
        source: input.source,
      }));
    }
  }
  const reset = record(root["rateLimitResetCredits"]);
  return Object.freeze({ status: windows.length > 0 ? "reported" : "unknown", windows: Object.freeze(windows), resetCreditsAvailable: count(reset?.["availableCount"]), observedAt: observed.toISOString() });
}

export function mapCodexAccountUsage(value: unknown, clock: CodexClock, auth: CodexAccountKind): CodexAccountUsageSnapshot {
  const observedAt = clock.now().toISOString();
  if (auth === "api-key" || auth === "amazon-bedrock") return Object.freeze({ status: "unsupported", summary: null, dailyBuckets: null, observedAt });
  const root = record(value); const summary = record(root?.["summary"]);
  if (root === null || summary === null) return Object.freeze({ status: "unknown", summary: null, dailyBuckets: null, observedAt });
  const mappedSummary = Object.freeze({ lifetimeTokens: count(summary["lifetimeTokens"]), peakDailyTokens: count(summary["peakDailyTokens"]), longestRunningTurnSeconds: count(summary["longestRunningTurnSec"]), currentStreakDays: count(summary["currentStreakDays"]), longestStreakDays: count(summary["longestStreakDays"]) });
  const daily = Array.isArray(root["dailyUsageBuckets"]) ? Object.freeze(root["dailyUsageBuckets"].slice(0, 366).flatMap((entry) => { const bucket = record(entry); const startDate = text(bucket?.["startDate"], 10); const tokens = count(bucket?.["tokens"]); return startDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(startDate) && tokens !== null ? [Object.freeze({ startDate, tokens })] : []; })) : null;
  return Object.freeze({ status: "reported", summary: mappedSummary, dailyBuckets: daily, observedAt });
}
