/**
 * Capacity observations for later routing stages.
 *
 * Claude Code exposes five-hour and seven-day rate-limit utilization to a
 * status-line script through a documented JSON document on stdin. That is the
 * only sanctioned machine-readable source, and this module can ingest such a
 * snapshot if a host collector supplies one.
 *
 * What this module will not do: scrape terminal output, read or edit the
 * user's global Claude settings, install a status-line collector on its own,
 * treat an absent percentage as zero, or report a reset time that was never
 * observed. Absent data is `unknown`, and an observation older than the
 * configured staleness window reports `stale` rather than pretending to be
 * current. Refreshing a quota figure never costs model usage, because reading
 * a snapshot the host already has starts no session.
 */

import { validation } from "@ai-dev-os/domain";
import { invalidRequestError } from "./errors.js";

const { ensureRecord } = validation;

export const CLAUDE_CAPACITY_STATUSES = Object.freeze([
  "known",
  "stale",
  "unknown",
  "unsupported",
] as const);
export type ClaudeCapacityStatus = (typeof CLAUDE_CAPACITY_STATUSES)[number];

export const CLAUDE_CAPACITY_SOURCES = Object.freeze([
  "host-supplied-status-snapshot",
  "none",
] as const);
export type ClaudeCapacitySource = (typeof CLAUDE_CAPACITY_SOURCES)[number];

export const CLAUDE_CAPACITY_CONFIDENCE = Object.freeze(["reported", "derived", "none"] as const);
export type ClaudeCapacityConfidence = (typeof CLAUDE_CAPACITY_CONFIDENCE)[number];

export interface ClaudeCapacityWindow {
  /** 0 to 100 inclusive, exactly as reported. Null when not reported. */
  readonly usedPercentage: number | null;
  /** Canonical ISO-8601 instant. Null when no reset time was observed. */
  readonly resetsAt: string | null;
}

export interface ClaudeCapacitySnapshot {
  readonly status: ClaudeCapacityStatus;
  readonly source: ClaudeCapacitySource;
  readonly confidence: ClaudeCapacityConfidence;
  readonly fiveHour: ClaudeCapacityWindow;
  readonly sevenDay: ClaudeCapacityWindow;
  readonly observedAt: string | null;
  /** The instant after which this observation stops counting as current. */
  readonly staleAt: string | null;
  readonly model: string | null;
  readonly effort: string | null;
}

const EMPTY_WINDOW: ClaudeCapacityWindow = Object.freeze({ usedPercentage: null, resetsAt: null });

export const UNKNOWN_CAPACITY: ClaudeCapacitySnapshot = Object.freeze({
  status: "unknown",
  source: "none",
  confidence: "none",
  fiveHour: EMPTY_WINDOW,
  sevenDay: EMPTY_WINDOW,
  observedAt: null,
  staleAt: null,
  model: null,
  effort: null,
});

export const UNSUPPORTED_CAPACITY: ClaudeCapacitySnapshot = Object.freeze({
  ...UNKNOWN_CAPACITY,
  status: "unsupported",
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePercentage(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    return null;
  }
  // One decimal place is the reported resolution; more is not meaningful.
  return Math.round(value * 10) / 10;
}

/** Unix epoch seconds, as the documented status-line document reports them. */
function parseResetInstant(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const millis = Math.trunc(value) * 1_000;
  if (!Number.isSafeInteger(millis)) {
    return null;
  }
  const instant = new Date(millis);
  const iso = instant.toISOString();
  return Number.isNaN(instant.valueOf()) ? null : iso;
}

function parseWindow(value: unknown): ClaudeCapacityWindow {
  if (!isPlainObject(value)) {
    return EMPTY_WINDOW;
  }
  return Object.freeze({
    usedPercentage: parsePercentage(value["used_percentage"]),
    resetsAt: parseResetInstant(value["resets_at"]),
  });
}

function boundedName(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return null;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ? value : null;
}

export const MAX_STATUS_SNAPSHOT_BYTES = 65_536;

/**
 * Ingests a host-supplied Claude status document. The document is bounded and
 * parsed defensively; anything unparseable yields `unknown` rather than a
 * partial snapshot, and no field is invented when the document omits it.
 */
export function ingestStatusSnapshot(input: {
  readonly document: string;
  readonly observedAt: string;
  readonly stalenessMs: number;
}): ClaudeCapacitySnapshot {
  if (typeof input.document !== "string" || Buffer.byteLength(input.document, "utf8") > MAX_STATUS_SNAPSHOT_BYTES) {
    throw invalidRequestError("configuration-invalid", {
      field: "statusSnapshot",
      maxBytes: MAX_STATUS_SNAPSHOT_BYTES,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.document) as unknown;
  } catch {
    return UNKNOWN_CAPACITY;
  }
  if (!isPlainObject(parsed)) {
    return UNKNOWN_CAPACITY;
  }
  let record: Record<string, unknown>;
  try {
    record = ensureRecord(parsed, "statusSnapshot");
  } catch {
    return UNKNOWN_CAPACITY;
  }

  const limits = record["rate_limits"];
  if (!isPlainObject(limits)) {
    return UNKNOWN_CAPACITY;
  }
  const fiveHour = parseWindow(limits["five_hour"]);
  const sevenDay = parseWindow(limits["seven_day"]);
  if (fiveHour.usedPercentage === null && sevenDay.usedPercentage === null) {
    return UNKNOWN_CAPACITY;
  }

  const observed = Date.parse(input.observedAt);
  if (!Number.isFinite(observed)) {
    return UNKNOWN_CAPACITY;
  }
  const model = isPlainObject(record["model"]) ? boundedName(record["model"]["id"], 128) : null;
  const effort = isPlainObject(record["effort"]) ? boundedName(record["effort"]["level"], 16) : null;

  return Object.freeze({
    status: "known" as const,
    source: "host-supplied-status-snapshot" as const,
    confidence: "reported" as const,
    fiveHour,
    sevenDay,
    observedAt: new Date(observed).toISOString(),
    staleAt: new Date(observed + Math.max(1_000, input.stalenessMs)).toISOString(),
    model,
    effort,
  });
}

/**
 * Re-evaluates a snapshot against the current instant. A known observation
 * past its staleness window becomes `stale`; its values are retained so a
 * router can decide whether an old number is still useful, but the status
 * never keeps claiming to be current.
 */
export function ageCapacitySnapshot(
  snapshot: ClaudeCapacitySnapshot,
  now: Date,
): ClaudeCapacitySnapshot {
  if (snapshot.status !== "known" || snapshot.staleAt === null) {
    return snapshot;
  }
  const stale = Date.parse(snapshot.staleAt);
  if (!Number.isFinite(stale) || now.valueOf() < stale) {
    return snapshot;
  }
  return Object.freeze({ ...snapshot, status: "stale" as const });
}
