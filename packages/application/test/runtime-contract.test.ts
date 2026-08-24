import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { PersistenceError, type PersistenceAdapter } from "@ai-dev-os/persistence";
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";
import { DEFAULT_WORKER_RUNTIME_CONFIGURATION } from "@ai-dev-os/scheduler";
import {
  ACCOUNT_MANAGER_LIVE_ACCESS_ENABLED,
  ApplicationError,
  STAGE_18C_APPLICATION_PRODUCTION_ENABLED,
  createProductionDisabledApplication,
  createWindowsLocalProductionDisabledApplication,
  isApplicationError,
} from "../src/index.js";
import {
  createApplicationContractDefinition,
  createApplicationContractClock,
  runApplicationPersistenceContractSuite,
  type ApplicationContractClock,
} from "../src/testing/index.js";

runApplicationPersistenceContractSuite("memory", (clock) => ({
  persistence: createMemoryPersistenceAdapter({ clock }),
}));

runApplicationPersistenceContractSuite("SQLite reopen", (clock: ApplicationContractClock) => {
  const directory = mkdtempSync(join(tmpdir(), "ai-dev-os-application-contract-"));
  const file = join(directory, "application.db");
  return {
    persistence: createSqlitePersistenceAdapter({ file, journalMode: "delete", clock }),
    reopen: async () => createSqlitePersistenceAdapter({ file, journalMode: "delete", clock }),
    dispose: async () => {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}, { supportsReopen: true });

describe("production-disabled application surface", () => {
  it("retries only the effect-free claim command under a finite concurrency policy", async () => {
    const delegate = createMemoryPersistenceAdapter();
    let conflicts = 0;
    let remainingConflicts = 0;
    const persistence: PersistenceAdapter = Object.freeze({
      async transact<T>(work: Parameters<PersistenceAdapter["transact"]>[0]): Promise<T> {
        if (remainingConflicts > 0) {
          remainingConflicts -= 1;
          conflicts += 1;
          throw new PersistenceError("CONCURRENCY_CONFLICT", "synthetic claim contention");
        }
        return delegate.transact(work) as Promise<T>;
      },
      migrationStatus: () => delegate.migrationStatus(),
      close: () => delegate.close(),
    });
    const application = createProductionDisabledApplication({
      persistence,
      clock: createApplicationContractClock(),
      usageAdapter: {
        adapterId: "adapter:claim-retry",
        schemaVersion: 3,
        readAuthorizedSnapshot: async () => null,
      },
    });
    try {
      await application.execute({
        type: "enqueue-work",
        commandId: "command:claim-retry:enqueue",
        definition: createApplicationContractDefinition(),
      });
      remainingConflicts = 2;
      const claimed = await application.execute({
        type: "claim-work",
        commandId: "command:claim-retry:claim",
        workerId: "worker:claim-retry",
        allowedCapacityPools: ["default"],
      });
      expect(claimed).toMatchObject({ status: "leased", lease: { workerId: "worker:claim-retry" } });
      expect(conflicts).toBe(2);
    } finally {
      await application.close();
    }
  });

  it("rejects unknown, null, and extra-field commands with finite application errors", async () => {
    const application = createProductionDisabledApplication({
      persistence: createMemoryPersistenceAdapter(),
      usageAdapter: {
        adapterId: "adapter:empty",
        schemaVersion: 3,
        readAuthorizedSnapshot: async () => null,
      },
    });
    for (const command of [
      null,
      { type: "unknown" },
      {
        type: "cancel-work",
        commandId: "command:invalid-extra",
        idempotencyKey: "idempotency:invalid-extra:0001",
        code: "operator-cancelled",
        extra: true,
      },
    ]) {
      await expect(application.execute(command)).rejects.toMatchObject({
        code: "INVALID_COMMAND",
        message: "The application command is invalid.",
      });
    }
    await application.close();
  });

  it("has no live Account Manager or production-effect path", async () => {
    const application = createProductionDisabledApplication({
      persistence: createMemoryPersistenceAdapter(),
      usageAdapter: {
        adapterId: "adapter:empty",
        schemaVersion: 3,
        readAuthorizedSnapshot: async () => null,
      },
    });
    expect(STAGE_18C_APPLICATION_PRODUCTION_ENABLED).toBe(false);
    expect(ACCOUNT_MANAGER_LIVE_ACCESS_ENABLED).toBe(false);
    expect(isApplicationError(new ApplicationError("INVALID_COMMAND", "finite"))).toBe(true);
    expect(isApplicationError(new Error("not-application"))).toBe(false);
    for (const effect of [
      "provider",
      "workspace",
      "git",
      "network",
      "native",
      "credential",
      "production-registration",
    ] as const) {
      expect(() => application.assertProductionEffectDisabled(effect)).toThrowError(
        expect.objectContaining({ code: "PRODUCTION_DISABLED" }),
      );
    }
    await application.close();
  });

  it("constructs only an explicit absolute Windows-local SQLite path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-dev-os-windows-application-"));
    const file = join(directory, "windows-local.db");
    const usageAdapter = {
      adapterId: "adapter:empty",
      schemaVersion: 3 as const,
      readAuthorizedSnapshot: async () => null,
    };
    try {
      expect(() => createWindowsLocalProductionDisabledApplication({
        databasePath: "relative.db",
        usageAdapter,
      })).toThrow();
      expect(() =>
        createWindowsLocalProductionDisabledApplication({
          databasePath: file,
          usageAdapter,
          configuration: {
            ...DEFAULT_WORKER_RUNTIME_CONFIGURATION,
            usageReadTimeoutMs: 0,
          },
        }),
      ).toThrow();
      const application = createWindowsLocalProductionDisabledApplication({
        databasePath: file,
        usageAdapter,
      });
      expect(await application.runtime.list()).toEqual([]);
      await application.close();
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 15_000);
});
