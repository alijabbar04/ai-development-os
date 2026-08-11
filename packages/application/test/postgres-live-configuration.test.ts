import { describe, expect, it } from "vitest";
import { parseApplicationLivePostgresConfiguration } from "./postgres-live-configuration.js";

const fields = Object.freeze({
  AI_DEV_OS_TEST_POSTGRES_HOST: "127.0.0.1",
  AI_DEV_OS_TEST_POSTGRES_PORT: "5432",
  AI_DEV_OS_TEST_POSTGRES_DATABASE: "testdb",
  AI_DEV_OS_TEST_POSTGRES_USER: "testuser",
  AI_DEV_OS_TEST_POSTGRES_PASSWORD: "task-owned-test-value",
});

describe("application live PostgreSQL configuration", () => {
  it("requires the exact sentinel and numeric loopback before returning a connection", () => {
    expect(parseApplicationLivePostgresConfiguration(fields)).toEqual({
      required: false,
      connection: null,
    });
    for (const host of ["localhost", "192.0.2.1", "db.internal"]) {
      expect(parseApplicationLivePostgresConfiguration({
        ...fields,
        AI_DEV_OS_REQUIRE_POSTGRES_TESTS: "1",
        AI_DEV_OS_TEST_POSTGRES_HOST: host,
      })).toEqual({ required: true, connection: null });
    }
  });

  it("accepts only a complete opted-in numeric-loopback connection", () => {
    expect(parseApplicationLivePostgresConfiguration({
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
    expect(parseApplicationLivePostgresConfiguration({
      AI_DEV_OS_REQUIRE_POSTGRES_TESTS: "1",
      AI_DEV_OS_TEST_POSTGRES_HOST: "127.0.0.1",
    })).toEqual({ required: true, connection: null });
  });
});
