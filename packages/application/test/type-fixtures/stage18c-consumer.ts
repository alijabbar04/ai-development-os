import type { ProductionDisabledApplication } from "../../src/index.js";

export const stage18cConsumerShape: ProductionDisabledApplication = {
  productionEnabled: false,
  runtime: null as never,
  execute: async () => null,
  tick: async () => Object.freeze([]),
  assertProductionEffectDisabled: () => {
    throw new Error("production-disabled");
  },
  close: async () => undefined,
};
