import { createPostgresProductionDisabledApplication } from "../../dist/index.js";

const [schema, commandId, workerId] = process.argv.slice(2);
const port = Number(process.env.AI_DEV_OS_TEST_POSTGRES_PORT);
const connection = {
  host: process.env.AI_DEV_OS_TEST_POSTGRES_HOST,
  port,
  database: process.env.AI_DEV_OS_TEST_POSTGRES_DATABASE,
  user: process.env.AI_DEV_OS_TEST_POSTGRES_USER,
  password: process.env.AI_DEV_OS_TEST_POSTGRES_PASSWORD,
  ssl: false,
};

if (
  typeof schema !== "string" || typeof commandId !== "string" ||
  typeof workerId !== "string" || typeof connection.host !== "string" ||
  !Number.isSafeInteger(port) || typeof connection.database !== "string" ||
  typeof connection.user !== "string" || typeof connection.password !== "string"
) {
  process.exitCode = 2;
} else {
  const application = await createPostgresProductionDisabledApplication({
    postgres: { connection, schema },
    usageAdapter: {
      adapterId: "adapter:postgres-process-claims",
      schemaVersion: 2,
      readAuthorizedSnapshot: async () => null,
    },
    clock: { now: () => new Date("2026-08-10T10:00:00.000Z") },
  });
  try {
    const result = await application.execute({
      type: "claim-work",
      commandId,
      workerId,
      allowedCapacityPools: ["default"],
    });
    if (result === null || "outcome" in result || result.lease === null) {
      process.exitCode = 3;
    } else {
      process.stdout.write(JSON.stringify({
        idempotencyKey: result.definition.task.idempotencyKey,
        workerId: result.lease.workerId,
      }));
    }
  } finally {
    await application.close();
  }
}
