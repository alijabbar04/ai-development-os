import { toCanonicalJson, validation, type JsonValue } from "@ai-dev-os/domain";
import type { ConfigExtension, ConfigLayerKind } from "@ai-dev-os/config";
import { digest } from "./shared.js";

const {
  ensureBoolean,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion
} = validation;

export const PROFILER_CONFIGURATION_SCHEMA_VERSION = 1 as const;
export const PROFILER_CONFIG_EXTENSION_NAMESPACE = "profiler" as const;
export const ESTIMATOR_ACCURACY_CLASSES = Object.freeze([
  "exact",
  "proven-upper-bound",
  "heuristic"
] as const);
export type EstimatorAccuracyClass = (typeof ESTIMATOR_ACCURACY_CLASSES)[number];

export interface ProfilerConfiguration {
  readonly schemaVersion: typeof PROFILER_CONFIGURATION_SCHEMA_VERSION;
  readonly classifierEnabled: boolean;
  readonly minimumClassifierConfidence: number;
  readonly maximumRepositoryFiles: number;
  readonly maximumContextItems: number;
  readonly maximumProposalTasks: number;
  readonly maximumEstimatorInputBytes: number;
  readonly heuristicSafetyMarginBps: number;
  readonly fingerprint: string;
}

const DEFAULT_UNSIGNED_PROFILER_CONFIGURATION = Object.freeze({
  schemaVersion: PROFILER_CONFIGURATION_SCHEMA_VERSION,
  classifierEnabled: false,
  minimumClassifierConfidence: 800,
  maximumRepositoryFiles: 1_000_000,
  maximumContextItems: 4_096,
  maximumProposalTasks: 256,
  maximumEstimatorInputBytes: 1_000_000_000,
  heuristicSafetyMarginBps: 2_500
});

export function profilerConfigurationFingerprint(
  value: Omit<ProfilerConfiguration, "fingerprint">
): string {
  return digest(value);
}

export function parseProfilerConfiguration(
  value: unknown,
  path = "profilerConfiguration"
): ProfilerConfiguration {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "classifierEnabled",
      "minimumClassifierConfidence",
      "maximumRepositoryFiles",
      "maximumContextItems",
      "maximumProposalTasks",
      "maximumEstimatorInputBytes",
      "heuristicSafetyMarginBps",
      "fingerprint"
    ],
    path
  );
  ensureSchemaVersion(
    record["schemaVersion"],
    `${path}.schemaVersion`,
    PROFILER_CONFIGURATION_SCHEMA_VERSION
  );
  const unsigned = Object.freeze({
    schemaVersion: PROFILER_CONFIGURATION_SCHEMA_VERSION,
    classifierEnabled: ensureBoolean(record["classifierEnabled"], `${path}.classifierEnabled`),
    minimumClassifierConfidence: ensureSafeInteger(
      record["minimumClassifierConfidence"],
      `${path}.minimumClassifierConfidence`,
      0,
      1_000
    ),
    maximumRepositoryFiles: ensureSafeInteger(
      record["maximumRepositoryFiles"],
      `${path}.maximumRepositoryFiles`,
      1,
      10_000_000
    ),
    maximumContextItems: ensureSafeInteger(
      record["maximumContextItems"],
      `${path}.maximumContextItems`,
      1,
      100_000
    ),
    maximumProposalTasks: ensureSafeInteger(
      record["maximumProposalTasks"],
      `${path}.maximumProposalTasks`,
      1,
      10_000
    ),
    maximumEstimatorInputBytes: ensureSafeInteger(
      record["maximumEstimatorInputBytes"],
      `${path}.maximumEstimatorInputBytes`,
      1,
      1_000_000_000_000
    ),
    heuristicSafetyMarginBps: ensureSafeInteger(
      record["heuristicSafetyMarginBps"],
      `${path}.heuristicSafetyMarginBps`,
      0,
      100_000
    )
  });
  const fingerprint = validation.ensureString(record["fingerprint"], `${path}.fingerprint`, {
    maxLength: 64,
    pattern: /^[0-9a-f]{64}$/u,
    patternName: "configuration fingerprint"
  });
  if (profilerConfigurationFingerprint(unsigned) !== fingerprint) {
    validation.fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match configuration content.");
  }
  return Object.freeze({ ...unsigned, fingerprint });
}

export const DEFAULT_PROFILER_CONFIGURATION: ProfilerConfiguration = parseProfilerConfiguration({
  ...DEFAULT_UNSIGNED_PROFILER_CONFIGURATION,
  fingerprint: profilerConfigurationFingerprint(DEFAULT_UNSIGNED_PROFILER_CONFIGURATION)
});

export function createProfilerConfiguration(
  overrides: Partial<Omit<ProfilerConfiguration, "schemaVersion" | "fingerprint">> = {}
): ProfilerConfiguration {
  const unsigned = Object.freeze({ ...DEFAULT_UNSIGNED_PROFILER_CONFIGURATION, ...overrides });
  return parseProfilerConfiguration({
    ...unsigned,
    fingerprint: profilerConfigurationFingerprint(unsigned)
  });
}

export function parseProfilerConfigurationExtension(
  extension: ConfigExtension,
  provenance: { readonly layer: ConfigLayerKind; readonly providersLocked: boolean }
): ProfilerConfiguration {
  if (
    extension.namespace !== PROFILER_CONFIG_EXTENSION_NAMESPACE ||
    extension.schemaVersion !== PROFILER_CONFIGURATION_SCHEMA_VERSION
  ) {
    validation.fail(
      "profilerExtension",
      "unsupported_extension",
      "profiler extension identity is unsupported."
    );
  }
  if (provenance.layer !== "system" || !provenance.providersLocked) {
    validation.fail(
      "profilerExtension",
      "unlocked_extension",
      "profiling semantics require a system layer with the providers field locked."
    );
  }
  return parseProfilerConfiguration(extension.value as JsonValue, "profilerExtension.value");
}

export function inspectProfilerConfiguration(configuration: ProfilerConfiguration): string {
  return toCanonicalJson({
    schemaVersion: configuration.schemaVersion,
    classifierEnabled: configuration.classifierEnabled,
    heuristicSafetyMarginBps: configuration.heuristicSafetyMarginBps,
    fingerprint: configuration.fingerprint
  });
}
