import { createControlArtifactStore, type ControlArtifactStore } from "../src/artifacts.js";
import { startControlServiceInternal, type ControlServiceHandle } from "../src/listener.js";
import type { RandomBytesPort } from "../src/identity.js";
import type { ProcessLivenessPort } from "../src/single-instance.js";

export interface ControlServiceTestingOptions {
  readonly storageRoot: string;
  readonly clock: () => string;
  readonly random?: RandomBytesPort;
  readonly processId?: number;
  readonly liveness?: ProcessLivenessPort;
  readonly port?: number;
  readonly store?: ControlArtifactStore;
  readonly beforeSessionRead?: (signal: AbortSignal) => Promise<void>;
}

export async function startControlServiceForTest(options: ControlServiceTestingOptions): Promise<ControlServiceHandle> {
  return await startControlServiceInternal({
    store: options.store ?? createControlArtifactStore({ root: options.storageRoot }),
    clock: options.clock,
    ...(options.random === undefined ? {} : { random: options.random }),
    processId: options.processId ?? process.pid,
    liveness: options.liveness ?? Object.freeze({ inspect: async () => "live" as const }),
    testingPort: options.port ?? 0,
    ...(options.beforeSessionRead === undefined ? {} : { beforeSessionRead: options.beforeSessionRead }),
  });
}
