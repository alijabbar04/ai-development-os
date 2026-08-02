import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createManualClock,
  runPersistenceContractSuite,
  type ContractHarness,
} from "@ai-dev-os/persistence/testing";
import type { OperationRecord } from "@ai-dev-os/persistence";
import { createSqlitePersistenceAdapter } from "../src/index.js";
import { openSqliteDatabase } from "../src/driver.js";

runPersistenceContractSuite("persistence-sqlite (memory mode)", async (): Promise<ContractHarness> => {
  const clock = createManualClock();
  const observed: OperationRecord[] = [];
  const adapter = createSqlitePersistenceAdapter({
    memory: true,
    clock,
    observer: (record) => {
      observed.push(record);
    },
  });
  return {
    adapter,
    clock,
    observed,
    supportsMigrations: true,
  };
});

runPersistenceContractSuite("persistence-sqlite (file mode)", async (): Promise<ContractHarness> => {
  const directory = mkdtempSync(join(tmpdir(), "aidevos-sqlite-"));
  const file = join(directory, "stage3.db");
  const clock = createManualClock();
  const observed: OperationRecord[] = [];
  const openAdapter = () =>
    createSqlitePersistenceAdapter({
      file,
      clock,
      observer: (record) => {
        observed.push(record);
      },
    });

  const corrupt = (sql: string, ...params: ReadonlyArray<string>) => {
    const raw = openSqliteDatabase(file);
    try {
      raw.prepare(sql).run(...params);
    } finally {
      raw.close();
    }
  };

  return {
    adapter: openAdapter(),
    clock,
    observed,
    reopen: async () => openAdapter(),
    corruptAggregatePayload: async (aggregateType, aggregateId) => {
      corrupt(
        "UPDATE aggregates SET payload = payload || ' ' WHERE aggregate_type = ? AND aggregate_id = ?",
        aggregateType,
        aggregateId,
      );
    },
    corruptEventPayload: async (eventId) => {
      corrupt("UPDATE events SET payload = payload || ' ' WHERE event_id = ?", eventId);
    },
    supportsMigrations: true,
    dispose: async () => {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
    },
  };
});
