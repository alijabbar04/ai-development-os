import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import type { PersistenceAdapter } from "@ai-dev-os/persistence";

const mocks = vi.hoisted(() => ({
  createPostgresPersistenceAdapter: vi.fn(),
}));

vi.mock("@ai-dev-os/persistence-postgres", () => ({
  createPostgresPersistenceAdapter: mocks.createPostgresPersistenceAdapter,
}));

import {
  createPostgresProductionDisabledApplication,
} from "../src/index.js";
import { createApplicationContractClock } from "../src/testing/index.js";

const postgres = Object.freeze({
  connection: Object.freeze({
    host: "127.0.0.1",
    port: 5432,
    database: "explicit-test",
    user: "explicit-test",
    password: "task-owned-test-value",
    ssl: false as const,
  }),
  schema: "ados_application_factory_unit",
});

describe("PostgreSQL application composition seam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes only explicit options into the async persistence factory", async () => {
    const persistence = createMemoryPersistenceAdapter();
    mocks.createPostgresPersistenceAdapter.mockResolvedValueOnce(persistence);
    const clock = createApplicationContractClock();
    const application = await createPostgresProductionDisabledApplication({
      postgres,
      clock,
      usageAdapter: {
        adapterId: "adapter:postgres-factory-unit",
        schemaVersion: 3,
        readAuthorizedSnapshot: async () => null,
      },
    });
    try {
      expect(mocks.createPostgresPersistenceAdapter).toHaveBeenCalledWith({
        ...postgres,
        clock,
      });
      expect(application.productionEnabled).toBe(false);
      expect(await application.runtime.list()).toEqual([]);
    } finally {
      await application.close();
    }
  });

  it("closes newly opened persistence when downstream runtime construction fails", async () => {
    const delegate = createMemoryPersistenceAdapter();
    const close = vi.fn(() => delegate.close());
    const persistence: PersistenceAdapter = Object.freeze({
      transact: (work) => delegate.transact(work),
      migrationStatus: () => delegate.migrationStatus(),
      close,
    });
    const usageAdapter: {
      adapterId: string;
      schemaVersion: number;
      readAuthorizedSnapshot(): Promise<null>;
    } = {
      adapterId: "adapter:postgres-factory-cleanup",
      schemaVersion: 3,
      readAuthorizedSnapshot: async () => null,
    };
    mocks.createPostgresPersistenceAdapter.mockImplementationOnce(async () => {
      usageAdapter.schemaVersion = 4;
      return persistence;
    });
    await expect(
      createPostgresProductionDisabledApplication({
        postgres,
        usageAdapter: usageAdapter as never,
      }),
    ).rejects.toBeDefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["clock", "observer", "unexpected"] as const)(
    "rejects a nested %s option before invoking the persistence factory",
    async (key) => {
      await expect(createPostgresProductionDisabledApplication({
        postgres: { ...postgres, [key]: vi.fn() },
        usageAdapter: {
          adapterId: "adapter:postgres-factory-closed-options",
          schemaVersion: 3,
          readAuthorizedSnapshot: async () => null,
        },
      } as never)).rejects.toMatchObject({ code: "INVALID_COMMAND" });
      expect(mocks.createPostgresPersistenceAdapter).not.toHaveBeenCalled();
    },
  );
});
