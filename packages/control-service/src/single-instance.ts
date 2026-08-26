import type { ConnectionDescriptor, InstanceLock } from "./contracts.js";
import type { ArtifactLease, ControlArtifactStore } from "./artifacts.js";
import { ControlServiceError, controlFail } from "./errors.js";

export const PROCESS_LIVENESS = Object.freeze(["live", "dead", "ambiguous"] as const);
export type ProcessLiveness = (typeof PROCESS_LIVENESS)[number];

export interface ProcessLivenessPort {
  inspect(processId: number): Promise<ProcessLiveness>;
}

export type SingleInstanceDisposition =
  | Readonly<{ kind: "acquired"; lockLease: ArtifactLease }>
  | Readonly<{ kind: "adopt"; descriptor: ConnectionDescriptor }>;

function matching(lock: InstanceLock, descriptor: ConnectionDescriptor): boolean {
  return lock.processId === descriptor.processId &&
    lock.startNonce === descriptor.startNonce &&
    lock.serviceVersion === descriptor.serviceVersion &&
    lock.issuedAt === descriptor.issuedAt;
}

export async function establishSingleInstance(options: Readonly<{
  store: ControlArtifactStore;
  requestedLock: InstanceLock;
  liveness: ProcessLivenessPort;
}>): Promise<SingleInstanceDisposition> {
  try {
    const lockLease = await options.store.writeLock(options.requestedLock);
    return Object.freeze({ kind: "acquired", lockLease });
  } catch (error) {
    if (!(error instanceof ControlServiceError) || error.code !== "ARTIFACT_CONFLICT") throw error;
  }

  const existingLock = await options.store.readLock();
  const status = await options.liveness.inspect(existingLock.value.processId);
  if (!PROCESS_LIVENESS.includes(status)) controlFail("LIVENESS_AMBIGUOUS");
  if (status === "ambiguous") controlFail("LIVENESS_AMBIGUOUS");

  let descriptor;
  try {
    descriptor = await options.store.readDescriptor();
  } catch (error) {
    if (error instanceof ControlServiceError && error.code === "ARTIFACT_MISSING") {
      controlFail(status === "live" ? "ARTIFACT_FOREIGN" : "ARTIFACT_INVALID");
    }
    throw error;
  }
  if (!matching(existingLock.value, descriptor.value)) controlFail("ARTIFACT_FOREIGN");

  if (status === "live") {
    return Object.freeze({ kind: "adopt", descriptor: descriptor.value });
  }

  // A dead-PID verdict is necessary but not sufficient. Both exact artifacts
  // must still parse, agree on PID/nonce/service version, remain contained, and
  // retain the file identities captured by the exact-name reads.
  await options.store.removeOwned(descriptor.lease);
  await options.store.removeOwned(existingLock.lease);
  const lockLease = await options.store.writeLock(options.requestedLock);
  return Object.freeze({ kind: "acquired", lockLease });
}
