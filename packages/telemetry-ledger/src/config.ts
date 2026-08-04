import { validation } from "@ai-dev-os/domain";
import { canonicalTelemetryValue, telemetrySnapshotFingerprint } from "./fingerprint.js";
import {
  TELEMETRY_CONFIGURATION_SCHEMA_VERSION,
  type CostComponent,
  type TelemetryLedgerConfiguration,
} from "./types.js";

const { ensureArray, ensureEnum, ensureExactKeys, ensureRecord, ensureSafeInteger, ensureString } = validation;
const COST_CLASSES = [
  "provider-billed",
  "locally-computed-estimate",
  "subscription-equivalent-estimate",
  "verified-zero",
  "unknown",
] as const satisfies readonly CostComponent["semanticClass"][];

export const DEFAULT_TELEMETRY_LEDGER_CONFIGURATION: TelemetryLedgerConfiguration = canonicalTelemetryValue({
  schemaVersion: TELEMETRY_CONFIGURATION_SCHEMA_VERSION,
  partitionDurationMs: 86_400_000,
  maximumPartitionCount: 366,
  maximumObservationsPerPartition: 1_000,
  maximumIdempotencyRecordsPerPartition: 1_000,
  eventPageSize: 100,
  queryPageSize: 100,
  retentionDays: 365,
  tombstoneRetentionDays: 2_555,
  compaction: "checkpoint-only",
  stalenessMs: {
    usage: 86_400_000,
    cost: 86_400_000,
    health: 60_000,
    quota: 300_000,
    capacity: 60_000,
  },
  forecast: {
    minimumSamples: 2,
    maximumSamples: 32,
    lookbackMs: 604_800_000,
    horizonMs: 604_800_000,
  },
  concurrency: { maximumRetries: 4 },
  acceptedCurrencies: ["USD", "EUR", "GBP"],
  acceptedCostSemantics: COST_CLASSES,
  enabledBridges: ["generic", "ollama", "claude-code", "codex", "openai", "gateway"],
  auditFailure: "deny",
});

function integer(record: Record<string, unknown>, key: string, min: number, max: number, path: string): number {
  return ensureSafeInteger(record[key], `${path}.${key}`, min, max);
}

export function parseTelemetryLedgerConfiguration(
  value: unknown,
  path = "telemetryLedgerConfiguration",
): TelemetryLedgerConfiguration {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "schemaVersion", "partitionDurationMs", "maximumPartitionCount", "maximumObservationsPerPartition",
    "maximumIdempotencyRecordsPerPartition", "eventPageSize", "queryPageSize", "retentionDays",
    "tombstoneRetentionDays", "compaction", "stalenessMs", "forecast", "concurrency",
    "acceptedCurrencies", "acceptedCostSemantics", "enabledBridges", "auditFailure",
  ], path);
  if (input["schemaVersion"] !== TELEMETRY_CONFIGURATION_SCHEMA_VERSION) {
    validation.fail(`${path}.schemaVersion`, "unsupported_schema", "must be the released telemetry configuration schema.");
  }
  const staleness = ensureRecord(input["stalenessMs"], `${path}.stalenessMs`);
  ensureExactKeys(staleness, ["usage", "cost", "health", "quota", "capacity"], `${path}.stalenessMs`);
  const forecast = ensureRecord(input["forecast"], `${path}.forecast`);
  ensureExactKeys(forecast, ["minimumSamples", "maximumSamples", "lookbackMs", "horizonMs"], `${path}.forecast`);
  const concurrency = ensureRecord(input["concurrency"], `${path}.concurrency`);
  ensureExactKeys(concurrency, ["maximumRetries"], `${path}.concurrency`);
  const minimumSamples = integer(forecast, "minimumSamples", 2, 1_000, `${path}.forecast`);
  const maximumSamples = integer(forecast, "maximumSamples", minimumSamples, 1_000, `${path}.forecast`);
  const maximumObservations = integer(input, "maximumObservationsPerPartition", 1, 100_000, path);
  const maximumIdempotency = integer(input, "maximumIdempotencyRecordsPerPartition", maximumObservations, 100_000, path);
  const currencies = ensureArray(input["acceptedCurrencies"], `${path}.acceptedCurrencies`, 32).map((item, index) =>
    ensureString(item, `${path}.acceptedCurrencies[${index}]`, { maxLength: 3, pattern: /^[A-Z]{3}$/u, patternName: "currency code" }),
  );
  const semantics = ensureArray(input["acceptedCostSemantics"], `${path}.acceptedCostSemantics`, COST_CLASSES.length).map((item, index) =>
    ensureEnum(item, `${path}.acceptedCostSemantics[${index}]`, COST_CLASSES),
  );
  const bridges = ensureArray(input["enabledBridges"], `${path}.enabledBridges`, 64).map((item, index) =>
    ensureString(item, `${path}.enabledBridges[${index}]`, { maxLength: 64, pattern: /^[a-z][a-z0-9._-]{0,63}$/u, patternName: "bridge id" }),
  );
  if (new Set(currencies).size !== currencies.length || new Set(semantics).size !== semantics.length || new Set(bridges).size !== bridges.length) {
    validation.fail(path, "duplicate_configuration_value", "configuration lists must not contain duplicates.");
  }
  return canonicalTelemetryValue({
    schemaVersion: TELEMETRY_CONFIGURATION_SCHEMA_VERSION,
    partitionDurationMs: integer(input, "partitionDurationMs", 60_000, 31_536_000_000, path),
    maximumPartitionCount: integer(input, "maximumPartitionCount", 1, 10_000, path),
    maximumObservationsPerPartition: maximumObservations,
    maximumIdempotencyRecordsPerPartition: maximumIdempotency,
    eventPageSize: integer(input, "eventPageSize", 1, 100, path),
    queryPageSize: integer(input, "queryPageSize", 1, 100, path),
    retentionDays: integer(input, "retentionDays", 1, 36_500, path),
    tombstoneRetentionDays: integer(input, "tombstoneRetentionDays", 1, 36_500, path),
    compaction: ensureEnum(input["compaction"], `${path}.compaction`, ["disabled", "checkpoint-only"] as const),
    stalenessMs: {
      usage: integer(staleness, "usage", 1_000, 31_536_000_000, `${path}.stalenessMs`),
      cost: integer(staleness, "cost", 1_000, 31_536_000_000, `${path}.stalenessMs`),
      health: integer(staleness, "health", 1_000, 31_536_000_000, `${path}.stalenessMs`),
      quota: integer(staleness, "quota", 1_000, 31_536_000_000, `${path}.stalenessMs`),
      capacity: integer(staleness, "capacity", 1_000, 31_536_000_000, `${path}.stalenessMs`),
    },
    forecast: {
      minimumSamples,
      maximumSamples,
      lookbackMs: integer(forecast, "lookbackMs", 1_000, 31_536_000_000, `${path}.forecast`),
      horizonMs: integer(forecast, "horizonMs", 1_000, 31_536_000_000, `${path}.forecast`),
    },
    concurrency: { maximumRetries: integer(concurrency, "maximumRetries", 0, 32, `${path}.concurrency`) },
    acceptedCurrencies: currencies.sort(),
    acceptedCostSemantics: semantics.sort(),
    enabledBridges: bridges.sort(),
    auditFailure: ensureEnum(input["auditFailure"], `${path}.auditFailure`, ["deny"] as const),
  });
}

export function parseTelemetryLedgerExtension(value: unknown): TelemetryLedgerConfiguration {
  const extension = ensureRecord(value, "telemetryLedgerExtension");
  ensureExactKeys(extension, ["namespace", "schemaVersion", "value"], "telemetryLedgerExtension");
  if (extension["namespace"] !== "telemetry-ledger" || extension["schemaVersion"] !== TELEMETRY_CONFIGURATION_SCHEMA_VERSION) {
    validation.fail("telemetryLedgerExtension", "wrong_extension", "must be the telemetry-ledger extension schema.");
  }
  return parseTelemetryLedgerConfiguration(extension["value"], "telemetryLedgerExtension.value");
}

export function telemetryLedgerConfigurationFingerprint(configuration: TelemetryLedgerConfiguration): string {
  return telemetrySnapshotFingerprint(parseTelemetryLedgerConfiguration(configuration));
}
