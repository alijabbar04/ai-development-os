import { describe, expect, it } from "vitest";
import { parseLivePostgresConfiguration } from "./live-harness.js";

const fields = Object.freeze({
  AI_DEV_OS_TEST_POSTGRES_HOST: "127.0.0.1",
  AI_DEV_OS_TEST_POSTGRES_PORT: "5432",
  AI_DEV_OS_TEST_POSTGRES_DATABASE: "testdb",
  AI_DEV_OS_TEST_POSTGRES_USER: "testuser",
  AI_DEV_OS_TEST_POSTGRES_PASSWORD: "task-owned-test-value",
});

describe("live PostgreSQL opt-in parser", () => {
  it("refuses complete connection fields unless the sentinel is exactly one", () => {
    expect(parseLivePostgresConfiguration(fields)).toBeNull();
    expect(parseLivePostgresConfiguration({
      ...fields,
      AI_DEV_OS_REQUIRE_POSTGRES_TESTS: "true",
    })).toBeNull();
  });

  it("fails required missing or malformed configuration before any pool exists", () => {
    expect(parseLivePostgresConfiguration({
      AI_DEV_OS_REQUIRE_POSTGRES_TESTS: "1",
    })).toMatchObject({ required: true, connection: null });
    expect(parseLivePostgresConfiguration({
      ...fields,
      AI_DEV_OS_REQUIRE_POSTGRES_TESTS: "1",
      AI_DEV_OS_TEST_POSTGRES_PORT: "0",
    })).toMatchObject({ required: true, connection: null });
    for (const host of ["localhost", "192.0.2.1", "db.internal"]) {
      expect(parseLivePostgresConfiguration({
        ...fields,
        AI_DEV_OS_REQUIRE_POSTGRES_TESTS: "1",
        AI_DEV_OS_TEST_POSTGRES_HOST: host,
      })).toMatchObject({ required: true, connection: null });
    }
  });

  it("accepts only the explicit complete opted-in local configuration", () => {
    expect(parseLivePostgresConfiguration({
      ...fields,
      AI_DEV_OS_REQUIRE_POSTGRES_TESTS: "1",
    })).toEqual({
      required: true,
      connection: {
        host: "127.0.0.1",
        port: 5432,
        database: "testdb",
        user: "testuser",
        password: "task-owned-test-value",
        ssl: false,
      },
    });
  });
});
