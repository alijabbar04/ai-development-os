export function createSyntheticDevelopmentDataset(now: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    health: Object.freeze({
      runningSessions: 0,
      providerHealth: Object.freeze([]),
      probes: Object.freeze([]),
      computedAt: now,
      confidence: "current",
      staleReason: null,
    }),
    usageProfiles: Object.freeze([]),
    routingDecisions: Object.freeze([]),
  });
}
