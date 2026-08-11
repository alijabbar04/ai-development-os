import { Pool } from "pg";
import type { PostgresAdapterOptions, PostgresConnectionOptions } from "../src/index.js";

export interface LivePostgresConfiguration {
  readonly connection: PostgresConnectionOptions;
  readonly required: boolean;
}

function env(environment: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = environment[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

export function parseLivePostgresConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): LivePostgresConfiguration | null {
  const required = env(environment, "AI_DEV_OS_REQUIRE_POSTGRES_TESTS") === "1";
  if (!required) {
    return null;
  }
  const host = env(environment, "AI_DEV_OS_TEST_POSTGRES_HOST");
  const portText = env(environment, "AI_DEV_OS_TEST_POSTGRES_PORT");
  const database = env(environment, "AI_DEV_OS_TEST_POSTGRES_DATABASE");
  const user = env(environment, "AI_DEV_OS_TEST_POSTGRES_USER");
  const password = env(environment, "AI_DEV_OS_TEST_POSTGRES_PASSWORD");
  if ([host, portText, database, user, password].some((value) => value === undefined)) {
    return required
      ? Object.freeze({
          required,
          connection: null as unknown as PostgresConnectionOptions,
        })
      : null;
  }
  if (host !== "127.0.0.1") {
    return Object.freeze({ required, connection: null as unknown as PostgresConnectionOptions });
  }
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return required
      ? Object.freeze({ required, connection: null as unknown as PostgresConnectionOptions })
      : null;
  }
  return Object.freeze({
    required,
    connection: Object.freeze({
      host: host as string,
      port,
      database: database as string,
      user: user as string,
      password: password as string,
      ssl: false as const,
    }),
  });
}

export function readLivePostgresConfiguration(): LivePostgresConfiguration | null {
  return parseLivePostgresConfiguration(process.env);
}

let schemaSequence = 0;

export function uniqueLiveSchema(label: string): string {
  schemaSequence += 1;
  const normalized = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `ados_${normalized}_${process.pid}_${schemaSequence}`.slice(0, 63);
}

export function adapterOptions(
  configuration: LivePostgresConfiguration,
  schema: string,
  overrides: Partial<PostgresAdapterOptions> = {},
): PostgresAdapterOptions {
  return {
    connection: configuration.connection,
    schema,
    lockTimeoutMs: 500,
    statementTimeoutMs: 10_000,
    queryTimeoutMs: 12_000,
    transactionTimeoutMs: 15_000,
    ...overrides,
  };
}

export async function withRawPool<T>(
  configuration: LivePostgresConfiguration,
  work: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = new Pool({
    ...configuration.connection,
    max: 2,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
    application_name: "ai-dev-os-postgres-live-test",
  });
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}

export async function dropLiveSchema(
  configuration: LivePostgresConfiguration,
  schema: string,
): Promise<void> {
  if (!/^ados_[a-z0-9_]{1,58}$/.test(schema)) {
    throw new Error("Refusing to drop a schema outside the task-owned live-test namespace.");
  }
  await withRawPool(configuration, async (pool) => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });
}
