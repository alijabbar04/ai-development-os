import { rm } from "node:fs/promises";

interface ListenerFixtureHandle {
  close(): Promise<void>;
}

/** Shared by the actual listener hook and its deterministic ownership controls. */
export async function cleanupListenerFixtures(
  handles: ListenerFixtureHandle[],
  roots: string[],
  removeRoot: (value: string) => Promise<void> = async (value) => {
    await rm(value, { recursive: true, force: true });
  },
): Promise<void> {
  // Claim both resource lists before a late close can overlap the next fixture.
  const ownedHandles = handles.splice(0).reverse();
  const ownedRoots = roots.splice(0);
  for (const handle of ownedHandles) {
    try { await handle.close(); } catch { /* assertions cover owned cleanup failures */ }
  }
  for (const value of ownedRoots) await removeRoot(value);
}
