/**
 * Finite execution quotas and the honesty rule that governs them.
 *
 * A quota that a backend cannot actually enforce is never reported as
 * enforced. The broker itself can enforce only wall-clock duration and output
 * bytes, because those are the two dimensions it observes directly. Every
 * other dimension belongs to the operating-system backend, which must report
 * `unsupported` when the platform primitive is missing.
 */

import { validation } from "@ai-dev-os/domain";
import { invalidRequest } from "./errors.js";

const { ensureExactKeys, ensureEnum, ensureRecord, ensureSafeInteger } = validation;

export const QUOTA_DIMENSIONS = Object.freeze([
  "wall-clock",
  "cpu-time",
  "memory",
  "process-count",
  "output-bytes",
  "disk-bytes",
  "file-count",
  "network",
] as const);

export type QuotaDimension = (typeof QUOTA_DIMENSIONS)[number];

/**
 * How a backend treats one dimension.
 *
 * - `enforced`: the platform stops the workload at the limit.
 * - `observed`: the value is measured and reported but not enforced.
 * - `estimated`: an approximation is reported; it may be wrong.
 * - `unsupported`: no measurement and no enforcement.
 *
 * Production admission accepts only `enforced`.
 */
export const QUOTA_SUPPORT_LEVELS = Object.freeze([
  "enforced",
  "observed",
  "estimated",
  "unsupported",
] as const);

export type QuotaSupportLevel = (typeof QUOTA_SUPPORT_LEVELS)[number];

export type QuotaSupportMatrix = Readonly<Record<QuotaDimension, QuotaSupportLevel>>;

export const NETWORK_MODES = Object.freeze(["denied", "loopback-only", "allowlist"] as const);
export type NetworkMode = (typeof NETWORK_MODES)[number];

export const MAX_WALL_CLOCK_MS = 86_400_000;
export const MAX_CPU_TIME_MS = 86_400_000;
export const MAX_MEMORY_BYTES = 1_099_511_627_776;
export const MAX_PROCESS_COUNT = 4_096;
export const MAX_OUTPUT_BYTES = 1_073_741_824;
export const MAX_DISK_BYTES = 1_099_511_627_776;
export const MAX_FILE_COUNT = 1_000_000;

export interface ProcessQuotas {
  readonly wallClockMs: number;
  readonly cpuTimeMs: number | null;
  readonly memoryBytes: number | null;
  readonly processCount: number | null;
  readonly outputBytes: number;
  readonly diskBytes: number | null;
  readonly fileCount: number | null;
}

const QUOTA_KEYS = [
  "wallClockMs",
  "cpuTimeMs",
  "memoryBytes",
  "processCount",
  "outputBytes",
  "diskBytes",
  "fileCount",
] as const;

function optionalInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return ensureSafeInteger(value, path, minimum, maximum);
}

export function parseProcessQuotas(value: unknown, path = "quotas"): ProcessQuotas {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, QUOTA_KEYS, path);
  return Object.freeze({
    wallClockMs: ensureSafeInteger(record["wallClockMs"], `${path}.wallClockMs`, 1, MAX_WALL_CLOCK_MS),
    cpuTimeMs: optionalInteger(record["cpuTimeMs"], `${path}.cpuTimeMs`, 1, MAX_CPU_TIME_MS),
    memoryBytes: optionalInteger(record["memoryBytes"], `${path}.memoryBytes`, 1, MAX_MEMORY_BYTES),
    processCount: optionalInteger(record["processCount"], `${path}.processCount`, 1, MAX_PROCESS_COUNT),
    outputBytes: ensureSafeInteger(record["outputBytes"], `${path}.outputBytes`, 1, MAX_OUTPUT_BYTES),
    diskBytes: optionalInteger(record["diskBytes"], `${path}.diskBytes`, 1, MAX_DISK_BYTES),
    fileCount: optionalInteger(record["fileCount"], `${path}.fileCount`, 1, MAX_FILE_COUNT),
  });
}

export function createProcessQuotas(input: {
  readonly wallClockMs: number;
  readonly outputBytes: number;
  readonly cpuTimeMs?: number | null;
  readonly memoryBytes?: number | null;
  readonly processCount?: number | null;
  readonly diskBytes?: number | null;
  readonly fileCount?: number | null;
}): ProcessQuotas {
  return parseProcessQuotas({
    wallClockMs: input.wallClockMs,
    outputBytes: input.outputBytes,
    cpuTimeMs: input.cpuTimeMs ?? null,
    memoryBytes: input.memoryBytes ?? null,
    processCount: input.processCount ?? null,
    diskBytes: input.diskBytes ?? null,
    fileCount: input.fileCount ?? null,
  });
}

export interface NetworkPolicy {
  readonly mode: NetworkMode;
  /** Lowercase host names. Only meaningful when `mode` is `allowlist`. */
  readonly egressDomains: readonly string[];
}

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MAX_EGRESS_DOMAINS = 64;

export function parseNetworkPolicy(value: unknown, path = "network"): NetworkPolicy {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["mode", "egressDomains"], path);
  const mode = ensureEnum(record["mode"], `${path}.mode`, NETWORK_MODES);
  const rawDomains = validation.ensureArray(
    record["egressDomains"],
    `${path}.egressDomains`,
    MAX_EGRESS_DOMAINS,
  );
  const domains: string[] = [];
  for (const [index, entry] of rawDomains.entries()) {
    const domain = validation.ensureString(entry, `${path}.egressDomains[${index}]`, {
      maxLength: 253,
    });
    if (!DOMAIN_PATTERN.test(domain)) {
      throw invalidRequest("An egress domain is not a plain lowercase host name.", {
        index,
      });
    }
    domains.push(domain);
  }
  if (mode !== "allowlist" && domains.length > 0) {
    throw invalidRequest("Egress domains are only meaningful for the allowlist mode.", { mode });
  }
  if (mode === "allowlist" && domains.length === 0) {
    throw invalidRequest("The allowlist network mode requires at least one egress domain.");
  }
  const unique = [...new Set(domains)].sort();
  if (unique.length !== domains.length) {
    throw invalidRequest("Egress domains contain duplicates.");
  }
  return Object.freeze({ mode, egressDomains: Object.freeze(unique) });
}

export const DENY_ALL_NETWORK: NetworkPolicy = Object.freeze({
  mode: "denied" as const,
  egressDomains: Object.freeze([] as readonly string[]),
});

/**
 * The dimensions a request actually constrains. A dimension appears here only
 * when the request sets a finite limit for it, so admission compares like for
 * like: an unset CPU quota does not demand CPU enforcement.
 */
export function requiredQuotaDimensions(
  quotas: ProcessQuotas,
  network: NetworkPolicy,
): readonly QuotaDimension[] {
  const dimensions: QuotaDimension[] = ["wall-clock", "output-bytes"];
  if (quotas.cpuTimeMs !== null) {
    dimensions.push("cpu-time");
  }
  if (quotas.memoryBytes !== null) {
    dimensions.push("memory");
  }
  if (quotas.processCount !== null) {
    dimensions.push("process-count");
  }
  if (quotas.diskBytes !== null) {
    dimensions.push("disk-bytes");
  }
  if (quotas.fileCount !== null) {
    dimensions.push("file-count");
  }
  if (network.mode !== "allowlist" || network.egressDomains.length > 0) {
    dimensions.push("network");
  }
  return Object.freeze([...new Set(dimensions)].sort());
}
