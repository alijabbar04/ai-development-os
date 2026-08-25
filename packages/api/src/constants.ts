export const API_SCHEMA_VERSION = 1 as const;
export const API_PRODUCTION_ENABLED = false as const;

export const API_LIMITS = Object.freeze({
  maxSequence: Number.MAX_SAFE_INTEGER,
  maxIdentifierLength: 128,
  maxRuleIds: 32,
  maxProjectionDepth: 10,
  maxProjectionFields: 64,
  maxProjectionArrayItems: 100,
  maxProjectionNodes: 2_048,
  maxProjectionStringLength: 256,
});

export const PROJECTION_CONFIDENCE = Object.freeze(["current", "stale"] as const);
export type ProjectionConfidence = (typeof PROJECTION_CONFIDENCE)[number];

export const PROJECTION_STALE_REASONS = Object.freeze([
  "sequence-lag",
  "source-freshness-expired",
  "source-unavailable",
  "service-read-only",
  "recovery-in-progress",
] as const);
export type ProjectionStaleReason = (typeof PROJECTION_STALE_REASONS)[number];
