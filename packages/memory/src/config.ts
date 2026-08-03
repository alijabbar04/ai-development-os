/**
 * Memory configuration: schema-versioned, runtime-validated, deeply frozen,
 * with compiled defaults and explicit bounds.
 *
 * Every bound here is a refusal, not a hint. There is deliberately no switch
 * to disable secret rejection, subject normalization, or scope isolation: a
 * configuration option that can turn off a safety property is a safety
 * property that does not exist.
 */

import { createHash } from "node:crypto";
import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import { failed, memoryFailure, ok, type MemoryFailure, type MemoryResult } from "./errors.js";
import { MAX_BODY_TEXT_LENGTH } from "./record.js";

const { ensureBoolean, ensureExactKeys, ensureNullable, ensureRecord, ensureSafeInteger, ensureSchemaVersion, fail } =
  validation;

export const MEMORY_CONFIG_SCHEMA_VERSION = 1 as const;

export interface MemoryLimits {
  readonly maxRecordsPerScope: number;
  readonly maxBodyTextLength: number;
  readonly maxQueryResults: number;
  readonly maxSnapshotRecords: number;
  readonly maxEventsReturned: number;
  readonly maxSupersessionChainDepth: number;
}

export const DEFAULT_MEMORY_LIMITS: MemoryLimits = Object.freeze({
  maxRecordsPerScope: 10_000,
  maxBodyTextLength: MAX_BODY_TEXT_LENGTH,
  maxQueryResults: 200,
  maxSnapshotRecords: 1_000,
  maxEventsReturned: 1_000,
  maxSupersessionChainDepth: 64,
});

export interface MemoryConfiguration {
  readonly schemaVersion: typeof MEMORY_CONFIG_SCHEMA_VERSION;
  readonly limits: MemoryLimits;
  /**
   * Default lifetime applied to an inferred candidate that does not carry its
   * own expiry. An unconfirmed guess that never expires is a guess that
   * becomes indistinguishable from a fact.
   */
  readonly inferredCandidateTtlMs: number | null;
  /** When true, an inferred candidate without any expiry is refused outright. */
  readonly requireExpiryForInferredCandidates: boolean;
}

const LIMIT_BOUNDS: Readonly<Record<keyof MemoryLimits, readonly [number, number]>> = Object.freeze({
  maxRecordsPerScope: [1, 1_000_000],
  maxBodyTextLength: [1, MAX_BODY_TEXT_LENGTH],
  maxQueryResults: [1, 10_000],
  maxSnapshotRecords: [1, 100_000],
  maxEventsReturned: [1, 100_000],
  maxSupersessionChainDepth: [1, 1_000],
});

function parseLimits(value: unknown, path: string): MemoryLimits {
  const record = ensureRecord(value, path);
  const keys = Object.keys(LIMIT_BOUNDS) as (keyof MemoryLimits)[];
  ensureExactKeys(record, keys, path);
  const result: Record<string, number> = {};
  for (const key of keys) {
    const bounds = LIMIT_BOUNDS[key];
    result[key] = ensureSafeInteger(record[key], `${path}.${key}`, bounds[0], bounds[1]);
  }
  return Object.freeze(result) as unknown as MemoryLimits;
}

function parseStrict(value: unknown, path: string): MemoryConfiguration {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["schemaVersion", "limits", "inferredCandidateTtlMs", "requireExpiryForInferredCandidates"],
    path,
  );
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, MEMORY_CONFIG_SCHEMA_VERSION);
  const parsed = Object.freeze({
    schemaVersion: MEMORY_CONFIG_SCHEMA_VERSION,
    limits: parseLimits(record["limits"], `${path}.limits`),
    inferredCandidateTtlMs: ensureNullable(record["inferredCandidateTtlMs"], (raw) =>
      ensureSafeInteger(raw, `${path}.inferredCandidateTtlMs`, 1_000, 31_536_000_000),
    ),
    requireExpiryForInferredCandidates: ensureBoolean(
      record["requireExpiryForInferredCandidates"],
      `${path}.requireExpiryForInferredCandidates`,
    ),
  });
  if (parsed.requireExpiryForInferredCandidates && parsed.inferredCandidateTtlMs === null) {
    fail(
      `${path}.inferredCandidateTtlMs`,
      "missing_default_ttl",
      "must be set when inferred candidates are required to expire.",
    );
  }
  return parsed;
}

export const DEFAULT_MEMORY_CONFIGURATION: MemoryConfiguration = parseStrict(
  {
    schemaVersion: MEMORY_CONFIG_SCHEMA_VERSION,
    limits: DEFAULT_MEMORY_LIMITS,
    // Ninety days: long enough to be useful, short enough that an unconfirmed
    // guess cannot quietly outlive the situation that produced it.
    inferredCandidateTtlMs: 7_776_000_000,
    requireExpiryForInferredCandidates: true,
  },
  "compiledDefaults",
);

export function parseMemoryConfiguration(
  value: unknown,
  path = "memoryConfiguration",
): MemoryResult<MemoryConfiguration> {
  try {
    return ok(parseStrict(value, path));
  } catch (error) {
    return failed<MemoryConfiguration>(configurationFailure(error));
  }
}

function configurationFailure(error: unknown): MemoryFailure {
  const issues =
    error !== null && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
      ? (error.issues as readonly { readonly code?: unknown; readonly path?: unknown }[])
      : [];
  const unsupported = issues.some((issue) => issue.code === "unsupported_schema_version");
  return memoryFailure(
    unsupported ? "UNSUPPORTED_SCHEMA_VERSION" : "INVALID_CONFIGURATION",
    unsupported
      ? "The memory configuration schema version is unsupported."
      : "The memory configuration is invalid.",
    {
      issueCount: issues.length,
      issuePaths: Object.freeze(
        issues.map((issue) => (typeof issue.path === "string" ? issue.path : "?")).sort(),
      ),
    },
  );
}

export function withMemoryOverrides(
  base: MemoryConfiguration,
  overrides: {
    readonly limits?: Partial<MemoryLimits>;
    readonly inferredCandidateTtlMs?: number | null;
    readonly requireExpiryForInferredCandidates?: boolean;
  },
): MemoryResult<MemoryConfiguration> {
  return parseMemoryConfiguration({
    schemaVersion: MEMORY_CONFIG_SCHEMA_VERSION,
    limits: { ...base.limits, ...overrides.limits },
    inferredCandidateTtlMs:
      overrides.inferredCandidateTtlMs === undefined
        ? base.inferredCandidateTtlMs
        : overrides.inferredCandidateTtlMs,
    requireExpiryForInferredCandidates:
      overrides.requireExpiryForInferredCandidates ?? base.requireExpiryForInferredCandidates,
  });
}

export function memoryConfigurationFingerprint(configuration: MemoryConfiguration): string {
  return createHash("sha256").update(toCanonicalJson(configuration), "utf8").digest("hex");
}
