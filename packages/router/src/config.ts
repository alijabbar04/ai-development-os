import { validation, type JsonValue } from "@ai-dev-os/domain";
import type { ConfigExtension, ConfigLayerKind } from "@ai-dev-os/config";
import { HEX_64, digest } from "./shared.js";

const {
  ensureBoolean,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  fail
} = validation;

export const ROUTER_CONFIGURATION_SCHEMA_VERSION = 1 as const;
export const ROUTER_CONFIGURATION_ALGORITHM_VERSION = 1 as const;
export const ROUTER_CONFIG_EXTENSION_NAMESPACE = "router" as const;
export const ROUTER_SCORE_TERM_IDS = Object.freeze([
  "capability-margin",
  "quality-evidence",
  "cost-efficiency",
  "latency-margin",
  "locality-preference",
  "alias-priority",
  "verified-free",
  "quota-headroom",
  "protected-reserve",
  "capacity-headroom",
  "health-reliability",
  "context-headroom",
  "evidence-confidence"
] as const);
export type RouterScoreTermId = (typeof ROUTER_SCORE_TERM_IDS)[number];

export interface RouterConfiguration {
  readonly schemaVersion: typeof ROUTER_CONFIGURATION_SCHEMA_VERSION;
  readonly algorithmVersion: typeof ROUTER_CONFIGURATION_ALGORITHM_VERSION;
  readonly freshness: {
    readonly catalogMs: number;
    readonly healthMs: number;
    readonly quotaMs: number;
    readonly capacityMs: number;
  };
  readonly hardEvidence: {
    readonly requireKnownQuota: boolean;
    readonly requireKnownCapacityForLocal: boolean;
    readonly requireKnownCostWhenBudgeted: boolean;
    readonly verifiedFreeOnly: boolean;
  };
  readonly protectedReserve: {
    readonly requests: number;
    readonly tokens: number;
    readonly concurrency: number;
    readonly memoryBytes: number;
  };
  readonly scoreWeights: Readonly<Record<RouterScoreTermId, number>>;
  readonly fallbacks: { readonly enabled: boolean; readonly maximumCount: number };
  readonly confidence: { readonly minimum: number };
  readonly circuitBreaker: {
    readonly failureThreshold: number;
    readonly coolDownMs: number;
    readonly maximumRememberedEvents: number;
  };
  readonly reservation: {
    readonly tokenSafetyMarginBps: number;
    readonly costSafetyMarginBps: number;
    readonly durationSafetyMarginBps: number;
  };
  readonly bounds: {
    readonly maximumCandidates: number;
    readonly maximumRejections: number;
    readonly maximumExplanationReasons: number;
  };
  readonly fingerprint: string;
}

const DEFAULT_WEIGHTS: Readonly<Record<RouterScoreTermId, number>> = Object.freeze({
  "capability-margin": 100,
  "quality-evidence": 80,
  "cost-efficiency": 60,
  "latency-margin": 40,
  "locality-preference": 50,
  "alias-priority": 100,
  "verified-free": 40,
  "quota-headroom": 80,
  "protected-reserve": 100,
  "capacity-headroom": 60,
  "health-reliability": 100,
  "context-headroom": 70,
  "evidence-confidence": 100
});

const DEFAULT_UNSIGNED_ROUTER_CONFIGURATION = Object.freeze({
  schemaVersion: ROUTER_CONFIGURATION_SCHEMA_VERSION,
  algorithmVersion: ROUTER_CONFIGURATION_ALGORITHM_VERSION,
  freshness: Object.freeze({
    catalogMs: 86_400_000,
    healthMs: 60_000,
    quotaMs: 60_000,
    capacityMs: 30_000
  }),
  hardEvidence: Object.freeze({
    requireKnownQuota: true,
    requireKnownCapacityForLocal: true,
    requireKnownCostWhenBudgeted: true,
    verifiedFreeOnly: false
  }),
  protectedReserve: Object.freeze({
    requests: 1,
    tokens: 8_192,
    concurrency: 1,
    memoryBytes: 268_435_456
  }),
  scoreWeights: DEFAULT_WEIGHTS,
  fallbacks: Object.freeze({ enabled: true, maximumCount: 2 }),
  confidence: Object.freeze({ minimum: 500 }),
  circuitBreaker: Object.freeze({
    failureThreshold: 3,
    coolDownMs: 60_000,
    maximumRememberedEvents: 128
  }),
  reservation: Object.freeze({
    tokenSafetyMarginBps: 1_000,
    costSafetyMarginBps: 1_000,
    durationSafetyMarginBps: 1_000
  }),
  bounds: Object.freeze({
    maximumCandidates: 256,
    maximumRejections: 2_048,
    maximumExplanationReasons: 256
  })
});

export function routerConfigurationFingerprint(
  value: Omit<RouterConfiguration, "fingerprint">
): string {
  return digest(value);
}

function parseFreshness(value: unknown, path: string): RouterConfiguration["freshness"] {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["catalogMs", "healthMs", "quotaMs", "capacityMs"], path);
  return Object.freeze({
    catalogMs: ensureSafeInteger(record["catalogMs"], `${path}.catalogMs`, 0, 31_536_000_000),
    healthMs: ensureSafeInteger(record["healthMs"], `${path}.healthMs`, 0, 31_536_000_000),
    quotaMs: ensureSafeInteger(record["quotaMs"], `${path}.quotaMs`, 0, 31_536_000_000),
    capacityMs: ensureSafeInteger(record["capacityMs"], `${path}.capacityMs`, 0, 31_536_000_000)
  });
}

function parseHardEvidence(value: unknown, path: string): RouterConfiguration["hardEvidence"] {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "requireKnownQuota",
      "requireKnownCapacityForLocal",
      "requireKnownCostWhenBudgeted",
      "verifiedFreeOnly"
    ],
    path
  );
  return Object.freeze({
    requireKnownQuota: ensureBoolean(record["requireKnownQuota"], `${path}.requireKnownQuota`),
    requireKnownCapacityForLocal: ensureBoolean(
      record["requireKnownCapacityForLocal"],
      `${path}.requireKnownCapacityForLocal`
    ),
    requireKnownCostWhenBudgeted: ensureBoolean(
      record["requireKnownCostWhenBudgeted"],
      `${path}.requireKnownCostWhenBudgeted`
    ),
    verifiedFreeOnly: ensureBoolean(record["verifiedFreeOnly"], `${path}.verifiedFreeOnly`)
  });
}

function parseProtectedReserve(
  value: unknown,
  path: string
): RouterConfiguration["protectedReserve"] {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["requests", "tokens", "concurrency", "memoryBytes"], path);
  return Object.freeze({
    requests: ensureSafeInteger(record["requests"], `${path}.requests`, 0, 1_000_000_000),
    tokens: ensureSafeInteger(record["tokens"], `${path}.tokens`, 0, 1_000_000_000_000),
    concurrency: ensureSafeInteger(record["concurrency"], `${path}.concurrency`, 0, 1_000_000),
    memoryBytes: ensureSafeInteger(record["memoryBytes"], `${path}.memoryBytes`, 0, 1_000_000_000_000)
  });
}

function parseScoreWeights(value: unknown, path: string): Readonly<Record<RouterScoreTermId, number>> {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ROUTER_SCORE_TERM_IDS, path);
  const result = Object.fromEntries(
    ROUTER_SCORE_TERM_IDS.map((term) => [
      term,
      ensureSafeInteger(record[term], `${path}.${term}`, 0, 1_000)
    ])
  ) as unknown as Record<RouterScoreTermId, number>;
  return Object.freeze(result);
}

export function parseRouterConfiguration(
  value: unknown,
  path = "routerConfiguration"
): RouterConfiguration {
  const record = ensureRecord(value, path);
  const keys = [
    "schemaVersion", "algorithmVersion", "freshness", "hardEvidence", "protectedReserve",
    "scoreWeights", "fallbacks", "confidence", "circuitBreaker", "reservation", "bounds",
    "fingerprint"
  ] as const;
  ensureExactKeys(record, keys, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, ROUTER_CONFIGURATION_SCHEMA_VERSION);
  ensureSchemaVersion(
    record["algorithmVersion"],
    `${path}.algorithmVersion`,
    ROUTER_CONFIGURATION_ALGORITHM_VERSION
  );
  const fallbacks = ensureRecord(record["fallbacks"], `${path}.fallbacks`);
  ensureExactKeys(fallbacks, ["enabled", "maximumCount"], `${path}.fallbacks`);
  const confidence = ensureRecord(record["confidence"], `${path}.confidence`);
  ensureExactKeys(confidence, ["minimum"], `${path}.confidence`);
  const circuit = ensureRecord(record["circuitBreaker"], `${path}.circuitBreaker`);
  ensureExactKeys(
    circuit,
    ["failureThreshold", "coolDownMs", "maximumRememberedEvents"],
    `${path}.circuitBreaker`
  );
  const reservation = ensureRecord(record["reservation"], `${path}.reservation`);
  ensureExactKeys(
    reservation,
    ["tokenSafetyMarginBps", "costSafetyMarginBps", "durationSafetyMarginBps"],
    `${path}.reservation`
  );
  const bounds = ensureRecord(record["bounds"], `${path}.bounds`);
  ensureExactKeys(
    bounds,
    ["maximumCandidates", "maximumRejections", "maximumExplanationReasons"],
    `${path}.bounds`
  );
  const unsigned = Object.freeze({
    schemaVersion: ROUTER_CONFIGURATION_SCHEMA_VERSION,
    algorithmVersion: ROUTER_CONFIGURATION_ALGORITHM_VERSION,
    freshness: parseFreshness(record["freshness"], `${path}.freshness`),
    hardEvidence: parseHardEvidence(record["hardEvidence"], `${path}.hardEvidence`),
    protectedReserve: parseProtectedReserve(record["protectedReserve"], `${path}.protectedReserve`),
    scoreWeights: parseScoreWeights(record["scoreWeights"], `${path}.scoreWeights`),
    fallbacks: Object.freeze({
      enabled: ensureBoolean(fallbacks["enabled"], `${path}.fallbacks.enabled`),
      maximumCount: ensureSafeInteger(
        fallbacks["maximumCount"],
        `${path}.fallbacks.maximumCount`,
        0,
        16
      )
    }),
    confidence: Object.freeze({
      minimum: ensureSafeInteger(confidence["minimum"], `${path}.confidence.minimum`, 0, 1_000)
    }),
    circuitBreaker: Object.freeze({
      failureThreshold: ensureSafeInteger(
        circuit["failureThreshold"],
        `${path}.circuitBreaker.failureThreshold`,
        1,
        1_000
      ),
      coolDownMs: ensureSafeInteger(
        circuit["coolDownMs"],
        `${path}.circuitBreaker.coolDownMs`,
        1,
        31_536_000_000
      ),
      maximumRememberedEvents: ensureSafeInteger(
        circuit["maximumRememberedEvents"],
        `${path}.circuitBreaker.maximumRememberedEvents`,
        1,
        10_000
      )
    }),
    reservation: Object.freeze({
      tokenSafetyMarginBps: ensureSafeInteger(
        reservation["tokenSafetyMarginBps"],
        `${path}.reservation.tokenSafetyMarginBps`,
        0,
        100_000
      ),
      costSafetyMarginBps: ensureSafeInteger(
        reservation["costSafetyMarginBps"],
        `${path}.reservation.costSafetyMarginBps`,
        0,
        100_000
      ),
      durationSafetyMarginBps: ensureSafeInteger(
        reservation["durationSafetyMarginBps"],
        `${path}.reservation.durationSafetyMarginBps`,
        0,
        100_000
      )
    }),
    bounds: Object.freeze({
      maximumCandidates: ensureSafeInteger(
        bounds["maximumCandidates"],
        `${path}.bounds.maximumCandidates`,
        1,
        10_000
      ),
      maximumRejections: ensureSafeInteger(
        bounds["maximumRejections"],
        `${path}.bounds.maximumRejections`,
        1,
        100_000
      ),
      maximumExplanationReasons: ensureSafeInteger(
        bounds["maximumExplanationReasons"],
        `${path}.bounds.maximumExplanationReasons`,
        1,
        10_000
      )
    })
  });
  const fingerprint = ensureString(record["fingerprint"], `${path}.fingerprint`, {
    minLength: 64,
    maxLength: 64,
    pattern: HEX_64,
    patternName: "router configuration fingerprint"
  });
  if (routerConfigurationFingerprint(unsigned) !== fingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match router configuration.");
  }
  return Object.freeze({ ...unsigned, fingerprint });
}

export const DEFAULT_ROUTER_CONFIGURATION: RouterConfiguration = parseRouterConfiguration({
  ...DEFAULT_UNSIGNED_ROUTER_CONFIGURATION,
  fingerprint: routerConfigurationFingerprint(DEFAULT_UNSIGNED_ROUTER_CONFIGURATION)
});

export function createRouterConfiguration(
  overrides: Partial<Omit<RouterConfiguration, "schemaVersion" | "algorithmVersion" | "fingerprint">> = {}
): RouterConfiguration {
  const unsigned = Object.freeze({
    ...DEFAULT_UNSIGNED_ROUTER_CONFIGURATION,
    ...overrides
  });
  return parseRouterConfiguration({
    ...unsigned,
    fingerprint: routerConfigurationFingerprint(unsigned)
  });
}

export function parseRouterConfigurationExtension(
  extension: ConfigExtension,
  provenance: { readonly layer: ConfigLayerKind; readonly providersLocked: boolean }
): RouterConfiguration {
  if (
    extension.namespace !== ROUTER_CONFIG_EXTENSION_NAMESPACE ||
    extension.schemaVersion !== ROUTER_CONFIGURATION_SCHEMA_VERSION
  ) {
    fail("routerExtension", "unsupported_extension", "router extension identity is unsupported.");
  }
  if (provenance.layer !== "system" || !provenance.providersLocked) {
    fail(
      "routerExtension",
      "unlocked_extension",
      "routing semantics require a system layer with the providers field locked."
    );
  }
  return parseRouterConfiguration(extension.value as JsonValue, "routerExtension.value");
}
