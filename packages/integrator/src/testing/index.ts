import type { CreateIntegrationServiceOptions, ProductionDisabledIntegrationService } from "../index.js";
import { createIntegrationService } from "../store.js";

/** Test-only composition. It is intentionally absent from the package root. */
export function createIntegrationServiceForTesting(
  options: Omit<CreateIntegrationServiceOptions, "effectsEnabledForTesting">,
): ProductionDisabledIntegrationService {
  return createIntegrationService({ ...options, effectsEnabledForTesting: true });
}

export * from "./real-git-port.js";
