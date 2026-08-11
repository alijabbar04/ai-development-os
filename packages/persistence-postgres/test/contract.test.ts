import {
  createManualClock,
  runPersistenceContractSuite,
  type ContractHarness,
} from "@ai-dev-os/persistence/testing";
import type { OperationRecord } from "@ai-dev-os/persistence";
import { createPostgresPersistenceAdapterForTesting } from "../src/testing.js";
import { createFakePoolFactory, FakePostgresDatabase } from "./fake-pool.js";

runPersistenceContractSuite("persistence-postgres (deterministic driver seam)", async (): Promise<ContractHarness> => {
  const database = new FakePostgresDatabase();
  const clock = createManualClock();
  const observed: OperationRecord[] = [];
  const poolFactory = createFakePoolFactory(database);
  const open = () => createPostgresPersistenceAdapterForTesting({
    connection: {
      host: "127.0.0.1",
      port: 5432,
      database: "testdb",
      user: "testuser",
      password: "test-password",
      ssl: false,
    },
    schema: "contract_test",
    clock,
    observer: (record) => observed.push(record),
  }, { poolFactory });
  return {
    adapter: await open(),
    clock,
    observed,
    reopen: open,
    supportsMigrations: true,
  };
});
