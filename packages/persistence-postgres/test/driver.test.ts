import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const mocks = vi.hoisted(() => {
  const query = vi.fn(async () => ({ rows: [{ ok: true }], rowCount: 1 }));
  const release = vi.fn();
  const clientErrorHandlers = new Set<() => void>();
  const clientOn = vi.fn((_event: string, handler: () => void) => {
    clientErrorHandlers.add(handler);
  });
  const clientRemoveListener = vi.fn((_event: string, handler: () => void) => {
    clientErrorHandlers.delete(handler);
  });
  const connect = vi.fn(async () => ({
    query,
    release,
    on: clientOn,
    removeListener: clientRemoveListener,
  }));
  const end = vi.fn(async () => undefined);
  const on = vi.fn();
  const Pool = vi.fn(function FakePool(this: unknown) {
    return { connect, end, on };
  });
  return {
    query,
    release,
    connect,
    end,
    on,
    clientOn,
    clientRemoveListener,
    emitClientError: () => {
      for (const handler of clientErrorHandlers) handler();
    },
    Pool,
  };
});

vi.mock("pg-pool", () => ({ default: mocks.Pool }));
vi.mock("pg/lib/client.js", () => ({ default: function FakePgClient() {} }));

import { createDatabasePool } from "../src/driver.js";

describe("node-postgres driver boundary", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it("constructs an explicit no-ambient pool and wraps one checked-out client", async () => {
    vi.stubEnv("PGBINARY", "ambient-binary-canary");
    vi.stubEnv("PGOPTIONS", "-c application_name=ambient-options-canary");
    vi.stubEnv("PGCLIENTENCODING", "LATIN1");
    vi.stubEnv("PGREPLICATION", "database");
    vi.stubEnv("PGSSLNEGOTIATION", "direct");
    const pool = createDatabasePool({
      host: "127.0.0.1",
      port: 5432,
      database: "db",
      user: "user",
      password: "secret",
      ssl: false,
      maximumPoolSize: 2,
      connectionTimeoutMs: 10,
      idlePoolTimeoutMs: 20,
      statementTimeoutMs: 30,
      queryTimeoutMs: 40,
      lockTimeoutMs: 50,
      idleTransactionTimeoutMs: 60,
    });
    const handler = vi.fn();
    pool.onError(handler);
    expect(mocks.on).toHaveBeenCalledWith("error", handler);
    expect(mocks.Pool).toHaveBeenCalledWith(expect.objectContaining({
      host: "127.0.0.1",
      port: 5432,
      database: "db",
      user: "user",
      password: "secret",
      ssl: false,
      application_name: "ai-dev-os-persistence-postgres",
      fallback_application_name: "ai-dev-os-persistence-postgres",
      binary: true,
      options: "-c timezone=UTC",
      client_encoding: "UTF8",
      replication: "false",
      sslnegotiation: "postgres",
      allowExitOnIdle: false,
    }), expect.any(Function));
    const client = await pool.connect();
    expect(mocks.clientOn).toHaveBeenCalledWith("error", expect.any(Function));
    expect(await client.query("SELECT $1", [1])).toEqual({ rows: [{ ok: true }], rowCount: 1 });
    expect(mocks.query).toHaveBeenCalledWith("SELECT $1", [1]);
    client.release(true);
    expect(mocks.release).toHaveBeenCalledWith(true);
    expect(mocks.clientRemoveListener).toHaveBeenCalledWith("error", expect.any(Function));
    await pool.end();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("contains a checked-out client error and destroys the failed connection", async () => {
    const pool = createDatabasePool({
      host: "127.0.0.1", port: 5432, database: "db", user: "user", password: "secret",
      ssl: false, maximumPoolSize: 1, connectionTimeoutMs: 10, idlePoolTimeoutMs: 20,
      statementTimeoutMs: 30, queryTimeoutMs: 40, lockTimeoutMs: 50,
      idleTransactionTimeoutMs: 60,
    });
    const client = await pool.connect();
    mocks.emitClientError();
    await expect(client.query("SELECT 1")).rejects.toMatchObject({
      name: "DatabaseConnectionFailedError",
      code: "08006",
    });
    expect(mocks.query).not.toHaveBeenCalled();
    client.release();
    expect(mocks.release).toHaveBeenCalledWith(true);
    await pool.end();
  });

  it("replaces an active-query socket failure with the finite connection classification", async () => {
    mocks.query.mockImplementationOnce(async () => {
      mocks.emitClientError();
      throw new Error("secret active-query transport failure");
    });
    const pool = createDatabasePool({
      host: "127.0.0.1", port: 5432, database: "db", user: "user", password: "secret",
      ssl: false, maximumPoolSize: 1, connectionTimeoutMs: 10, idlePoolTimeoutMs: 20,
      statementTimeoutMs: 30, queryTimeoutMs: 40, lockTimeoutMs: 50,
      idleTransactionTimeoutMs: 60,
    });
    const client = await pool.connect();
    const failure = await client.query("SELECT pg_sleep(1)").catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "DatabaseConnectionFailedError", code: "08006" });
    expect(JSON.stringify(failure)).not.toContain("secret active-query transport failure");
    client.release();
    expect(mocks.release).toHaveBeenCalledWith(true);
    await pool.end();
  });

  it("accepts the driver's multi-statement migration result without exposing driver rows", async () => {
    mocks.query.mockResolvedValueOnce([
      { rows: [], rowCount: null },
      { rows: [], rowCount: null },
    ] as never);
    const pool = createDatabasePool({
      host: "127.0.0.1", port: 5432, database: "db", user: "user", password: "secret",
      ssl: false, maximumPoolSize: 1, connectionTimeoutMs: 10, idlePoolTimeoutMs: 20,
      statementTimeoutMs: 30, queryTimeoutMs: 40, lockTimeoutMs: 50,
      idleTransactionTimeoutMs: 60,
    });
    const client = await pool.connect();
    expect(await client.query("SELECT 1; SELECT 2")).toEqual({ rows: [], rowCount: 0 });
    client.release();
    await pool.end();
  });

  it("normalizes the pinned pg client-side timeout without retaining its raw error", async () => {
    mocks.query.mockRejectedValueOnce(new Error("Query read timeout"));
    const pool = createDatabasePool({
      host: "127.0.0.1", port: 5432, database: "db", user: "user", password: "secret",
      ssl: false, maximumPoolSize: 1, connectionTimeoutMs: 10, idlePoolTimeoutMs: 20,
      statementTimeoutMs: 30, queryTimeoutMs: 40, lockTimeoutMs: 50,
      idleTransactionTimeoutMs: 60,
    });
    const client = await pool.connect();
    await expect(client.query("SELECT pg_sleep(1)")).rejects.toMatchObject({
      name: "DatabaseQueryTimeoutError",
      code: "57014",
    });
    client.release(true);
    await pool.end();
  });

  it("imports the production package through the pure-JavaScript path even when native forcing is ambient", () => {
    const output = execFileSync(process.execPath, [
      resolve(import.meta.dirname, "fixtures", "import-with-force-native.mjs"),
    ], {
      encoding: "utf8",
      env: { ...process.env, NODE_PG_FORCE_NATIVE: "1" },
    });
    expect(output).toBe("pure-js-import-ok");
  });
});
