import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnedServiceController, type OwnedServiceController } from "../src/service/controller.js";

const roots: string[] = [];
const controllers: OwnedServiceController[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(async (controller) => await controller.stop().catch(() => undefined)));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("TEST_WAIT_TIMEOUT");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

describe("owned child service", () => {
  it("refuses recovery and read-only actions when no verified observation exists", async () => {
    const parent = await mkdtemp(join(tmpdir(), "desktop-service-unavailable-test-")); roots.push(parent);
    const controller = createOwnedServiceController({
      childPath: join(parent, "not-started.js"),
      storageParent: join(parent, "runtime"),
      dataRoot: join(parent, "saved-data"),
      execPath: process.execPath,
      initialMode: "normal",
      serviceReadyDeadlineMs: 100,
      shutdownDeadlineMs: 100,
    });
    controllers.push(controller);
    await expect(controller.retry()).rejects.toThrow("ACTION_UNAVAILABLE");
    expect(() => controller.openReadOnly()).toThrow("ACTION_UNAVAILABLE");
    expect(controller.snapshot().observation).toBeNull();
  });

  it("keeps a failed first start non-recoverable before its readiness deadline", async () => {
    const parent = await mkdtemp(join(tmpdir(), "desktop-service-failed-start-test-")); roots.push(parent);
    const controller = createOwnedServiceController({
      childPath: join(parent, "missing-child.js"),
      storageParent: join(parent, "runtime"),
      dataRoot: join(parent, "saved-data"),
      execPath: process.execPath,
      initialMode: "normal",
      serviceReadyDeadlineMs: 5_000,
      shutdownDeadlineMs: 100,
    });
    controllers.push(controller);
    await expect(controller.start()).rejects.toThrow();
    expect(controller.snapshot()).toMatchObject({
      phase: "failed-start",
      recoveryAvailable: false,
      observation: null,
      failureCode: "SERVICE_START_FAILED",
    });
    await expect(controller.retry()).rejects.toThrow("ACTION_UNAVAILABLE");
    expect(() => controller.openReadOnly()).toThrow("ACTION_UNAVAILABLE");
  });

  it("verifies, observes loss, safely retries, and removes only its owned roots", async () => {
    const testDirectory = dirname(fileURLToPath(import.meta.url));
    const appRoot = join(testDirectory, "..");
    const parent = await mkdtemp(join(tmpdir(), "desktop-service-controller-test-")); roots.push(parent);
    const controller = createOwnedServiceController({
      childPath: join(appRoot, "dist", "service", "child.js"),
      storageParent: join(parent, "runtime"),
      dataRoot: join(parent, "saved-data"),
      execPath: process.execPath,
      initialMode: "normal",
      serviceReadyDeadlineMs: 5_000,
      shutdownDeadlineMs: 2_000,
    });
    controllers.push(controller);
    await controller.start();
    const first = controller.snapshot();
    const firstPid = controller.ownedProcessIdForTest();
    const firstRoot = controller.ownedRuntimeRootForTest();
    expect(first.phase).toBe("ready");
    expect(first.observation).toMatchObject({ freshness: "live", runningSessions: 0, authority: "none", verification: "identity-verified-connection-closed" });
    expect(firstPid).toBeTypeOf("number");
    expect(firstRoot).toContain("owned-service-");

    await controller.terminateOwnedChildForTest();
    await waitFor(() => controller.snapshot().phase === "service-lost");
    expect(controller.snapshot().observation?.freshness).toBe("stale");
    await controller.retry();
    const secondPid = controller.ownedProcessIdForTest();
    const secondRoot = controller.ownedRuntimeRootForTest();
    expect(controller.snapshot().phase).toBe("ready");
    expect(secondPid).not.toBe(firstPid);
    expect(secondRoot).not.toBe(firstRoot);
    if (firstRoot !== null) await expect(access(firstRoot)).rejects.toMatchObject({ code: "ENOENT" });

    await controller.stop();
    expect(controller.ownedProcessIdForTest()).toBeNull();
    if (secondRoot !== null) await expect(access(secondRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
