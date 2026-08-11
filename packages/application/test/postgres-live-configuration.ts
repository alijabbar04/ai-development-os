import type { PostgresConnectionOptions } from "@ai-dev-os/persistence-postgres";

export interface ApplicationLivePostgresConfiguration {
  readonly required: boolean;
  readonly connection: PostgresConnectionOptions | null;
}

function value(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const candidate = environment[name];
  return candidate === undefined || candidate.length === 0 ? undefined : candidate;
}

export function parseApplicationLivePostgresConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): ApplicationLivePostgresConfiguration {
  const required = value(environment, "AI_DEV_OS_REQUIRE_POSTGRES_TESTS") === "1";
  if (!required) {
    return Object.freeze({ required: false, connection: null });
  }
  const host = value(environment, "AI_DEV_OS_TEST_POSTGRES_HOST");
  const portText = value(environment, "AI_DEV_OS_TEST_POSTGRES_PORT");
  const database = value(environment, "AI_DEV_OS_TEST_POSTGRES_DATABASE");
  const user = value(environment, "AI_DEV_OS_TEST_POSTGRES_USER");
  const password = value(environment, "AI_DEV_OS_TEST_POSTGRES_PASSWORD");
  const port = Number(portText);
  if (
    host !== "127.0.0.1" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    database === undefined ||
    user === undefined ||
    password === undefined
  ) {
    return Object.freeze({ required: true, connection: null });
  }
  return Object.freeze({
    required: true,
    connection: Object.freeze({
      host,
      port,
      database,
      user,
      password,
      ssl: false as const,
    }),
  });
}
