import type { PersistenceAdapter } from "@ai-dev-os/persistence";
import { createDurableSchedulerForTesting, type DurableScheduler } from "../scheduler.js";
import type { DeterministicFakeAgentAdapter } from "../provider.js";
import type { SchedulerAuditRecord, SchedulerClock, SchedulerConfiguration } from "../types.js";
import type { StoreFaultPoint } from "../store.js";

export { createFakeAgentHarness, type FakeAgentHarness, type FakeAgentObservation, type FakeAgentScript, type FakeAgentTurn } from "./fake-agent.js";

export function createTestingScheduler(options: {
  readonly persistence: PersistenceAdapter;
  readonly adapter: DeterministicFakeAgentAdapter;
  readonly clock?: SchedulerClock;
  readonly configuration?: SchedulerConfiguration;
  readonly audit?: (record: SchedulerAuditRecord) => void;
  readonly fault?: (point: StoreFaultPoint) => Promise<void> | void;
}): DurableScheduler {
  return createDurableSchedulerForTesting({
    persistence: options.persistence,
    fakeAdapter: options.adapter,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.fault === undefined ? {} : { fault: options.fault }),
  });
}
