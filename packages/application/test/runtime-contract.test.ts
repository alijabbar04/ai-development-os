import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
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
  it("rejects unknown, null, and extra-field commands with finite application errors", async () => {
    const application = createProductionDisabledApplication({
      persistence: createMemoryPersistenceAdapter(),
      usageAdapter: {
        adapterId: "adapter:empty",
        schemaVersion: 2,
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
        schemaVersion: 2,
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
      schemaVersion: 2 as const,
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
  });
});
