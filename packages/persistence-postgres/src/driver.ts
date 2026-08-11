import PgClient from "pg/lib/client.js";
import PgPool from "pg-pool";
import type { PoolClient, PoolConfig } from "pg";

export interface DatabaseQueryResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number;
}

export interface DatabaseClient {
  query(text: string, values?: readonly unknown[]): Promise<DatabaseQueryResult>;
  release(destroy?: boolean): void;
}

export interface DatabasePool {
  connect(): Promise<DatabaseClient>;
  end(): Promise<void>;
  onError(handler: () => void): void;
}

export interface DatabasePoolConfiguration {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: false | Readonly<{ readonly rejectUnauthorized: true; readonly ca?: string }>;
  readonly maximumPoolSize: number;
  readonly connectionTimeoutMs: number;
  readonly idlePoolTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly idleTransactionTimeoutMs: number;
}

class DatabaseQueryTimeoutError extends Error {
  readonly code = "57014";

  constructor() {
    super("The PostgreSQL client query exceeded its configured time bound.");
    this.name = "DatabaseQueryTimeoutError";
  }
}

class DatabaseConnectionFailedError extends Error {
  readonly code = "08006";

  constructor() {
    super("The checked-out PostgreSQL client connection failed.");
    this.name = "DatabaseConnectionFailedError";
  }
}

function isPgClientQueryTimeout(error: unknown): boolean {
  return error instanceof Error && error["message"] === "Query read timeout";
}

function wrapClient(client: PoolClient): DatabaseClient {
  let connectionFailed = false;
  let released = false;
  const onClientError = (): void => {
    connectionFailed = true;
  };
  client.on("error", onClientError);
  return Object.freeze({
    async query(text: string, values: readonly unknown[] = []): Promise<DatabaseQueryResult> {
      if (connectionFailed) {
        throw new DatabaseConnectionFailedError();
      }
      let result;
      try {
        result = await client.query(text, [...values]);
      } catch (error) {
        if (connectionFailed) {
          throw new DatabaseConnectionFailedError();
        }
        if (isPgClientQueryTimeout(error)) {
          throw new DatabaseQueryTimeoutError();
        }
        throw error;
      }
      if (Array.isArray(result)) {
        return Object.freeze({ rows: Object.freeze([]), rowCount: 0 });
      }
      return Object.freeze({
        rows: Object.freeze(result.rows as Readonly<Record<string, unknown>>[]),
        rowCount: result.rowCount ?? 0,
      });
    },
    release(destroy = false): void {
      if (released) return;
      released = true;
      client.removeListener("error", onClientError);
      client.release(destroy || connectionFailed);
    },
  });
}

/** The only production driver construction path. Every connection field is explicit. */
export function createDatabasePool(configuration: DatabasePoolConfiguration): DatabasePool {
  const poolConfiguration: PoolConfig & {
    readonly binary: true;
    readonly replication: "false";
    readonly sslnegotiation: "postgres";
  } = {
    host: configuration.host,
    port: configuration.port,
    database: configuration.database,
    user: configuration.user,
    password: configuration.password,
    ssl: configuration.ssl,
    max: configuration.maximumPoolSize,
    min: 0,
    connectionTimeoutMillis: configuration.connectionTimeoutMs,
    idleTimeoutMillis: configuration.idlePoolTimeoutMs,
    statement_timeout: configuration.statementTimeoutMs,
    query_timeout: configuration.queryTimeoutMs,
    lock_timeout: configuration.lockTimeoutMs,
    idle_in_transaction_session_timeout: configuration.idleTransactionTimeoutMs,
    allowExitOnIdle: false,
    application_name: "ai-dev-os-persistence-postgres",
    fallback_application_name: "ai-dev-os-persistence-postgres",
    binary: true,
    options: "-c timezone=UTC",
    client_encoding: "UTF8",
    replication: "false",
    sslnegotiation: "postgres",
  };
  const pool = new PgPool(poolConfiguration, PgClient);
  return Object.freeze({
    async connect(): Promise<DatabaseClient> {
      return wrapClient(await pool.connect());
    },
    async end(): Promise<void> {
      await pool.end();
    },
    onError(handler: () => void): void {
      pool.on("error", handler);
    },
  });
}
