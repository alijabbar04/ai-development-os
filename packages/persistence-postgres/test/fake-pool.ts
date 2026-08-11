import type {
  DatabaseClient,
  DatabasePool,
  DatabasePoolConfiguration,
  DatabaseQueryResult,
} from "../src/testing.js";

type Row = Record<string, unknown>;

interface FakeState {
  migrations: Map<string, Row>;
  aggregates: Map<string, Row>;
  events: Map<string, Row>;
  outbox: Map<string, Row>;
  artifacts: Map<string, Row>;
  manifests: Map<string, Row>;
}

function emptyState(): FakeState {
  return {
    migrations: new Map(),
    aggregates: new Map(),
    events: new Map(),
    outbox: new Map(),
    artifacts: new Map(),
    manifests: new Map(),
  };
}

function cloneRow(row: Row): Row {
  return { ...row };
}

function cloneMap(input: Map<string, Row>): Map<string, Row> {
  return new Map([...input].map(([key, row]) => [key, cloneRow(row)]));
}

function cloneState(input: FakeState): FakeState {
  return {
    migrations: cloneMap(input.migrations),
    aggregates: cloneMap(input.aggregates),
    events: cloneMap(input.events),
    outbox: cloneMap(input.outbox),
    artifacts: cloneMap(input.artifacts),
    manifests: cloneMap(input.manifests),
  };
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function aggregateKey(type: unknown, id: unknown): string {
  return `${String(type)}\u0000${String(id)}`;
}

function result(rows: readonly Row[] = []): DatabaseQueryResult {
  return Object.freeze({
    rows: Object.freeze(rows.map((row) => Object.freeze(cloneRow(row)))),
    rowCount: rows.length,
  });
}

export class FakePostgresDatabase {
  state: FakeState = emptyState();
  nextEventSequence = 1;
  nextOutboxSequence = 1;
  readonly configurations: DatabasePoolConfiguration[] = [];
  connectFailure: unknown = null;
  queryFailure: { readonly tag: string; readonly error: unknown } | null = null;
  readonly queryFailures: Array<{ readonly tag: string; readonly error: unknown }> = [];
  queryHangTag: string | null = null;
  queryPause: {
    readonly tag: string;
    readonly entered: () => void;
    readonly wait: Promise<void>;
  } | null = null;
  endFailure: unknown = null;
  endHangs = false;
  destroyedReleaseCount = 0;
  poolErrorHandler: (() => void) | null = null;

  tamperMigrationChecksum(id: string): void {
    const row = this.state.migrations.get(id);
    if (row !== undefined) row["checksum_hex"] = "f".repeat(64);
  }

  addUnknownMigration(id: string): void {
    this.state.migrations.set(id, {
      id,
      checksum_algorithm: "sha-256",
      checksum_hex: "a".repeat(64),
      applied_at: "2026-08-10T22:00:00.000Z",
      ordinal: String(this.state.migrations.size + 1),
    });
  }

  tamperArtifactRecord(
    kind: "descriptor" | "manifest",
    id: string,
    changes: Readonly<Record<string, unknown>>,
  ): void {
    const target = kind === "descriptor" ? this.state.artifacts : this.state.manifests;
    const row = target.get(id);
    if (row === undefined) {
      throw new Error("The requested fake artifact row does not exist.");
    }
    target.set(id, { ...row, ...changes });
  }

  emitPoolError(): void {
    this.poolErrorHandler?.();
  }

  pauseNextQuery(tag: string): { readonly entered: Promise<void>; release(): void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.queryPause = { tag, entered: markEntered, wait };
    return { entered, release };
  }
}

class FakeClient implements DatabaseClient {
  readonly #database: FakePostgresDatabase;
  #transaction: FakeState | null = null;
  #released = false;

  constructor(database: FakePostgresDatabase) {
    this.#database = database;
  }

  #state(): FakeState {
    return this.#transaction ?? this.#database.state;
  }

  async query(text: string, values: readonly unknown[] = []): Promise<DatabaseQueryResult> {
    if (this.#released) {
      throw Object.assign(new Error("released"), { code: "08003" });
    }
    const injected = this.#database.queryFailure;
    if (injected !== null && text.includes(injected.tag)) {
      this.#database.queryFailure = null;
      throw injected.error;
    }
    const queuedIndex = this.#database.queryFailures.findIndex((failure) => text.includes(failure.tag));
    if (queuedIndex >= 0) {
      const [failure] = this.#database.queryFailures.splice(queuedIndex, 1);
      throw failure?.error;
    }
    if (this.#database.queryHangTag !== null && text.includes(this.#database.queryHangTag)) {
      await new Promise<never>(() => undefined);
    }
    const pause = this.#database.queryPause;
    if (pause !== null && text.includes(pause.tag)) {
      this.#database.queryPause = null;
      pause.entered();
      await pause.wait;
    }
    const sql = text.trim();
    if (sql === "BEGIN" || sql.startsWith("BEGIN ISOLATION")) {
      this.#transaction = cloneState(this.#database.state);
      return result();
    }
    if (sql === "COMMIT") {
      if (this.#transaction !== null) {
        this.#database.state = this.#transaction;
        this.#transaction = null;
      }
      return result();
    }
    if (sql === "ROLLBACK") {
      this.#transaction = null;
      return result();
    }
    if (
      sql.startsWith("SET LOCAL") ||
      sql.startsWith("SELECT pg_advisory_") ||
      sql.startsWith("SELECT pg_catalog.pg_advisory_") ||
      sql.includes("/*ados:transaction-probe*/") ||
      sql.startsWith("CREATE SCHEMA") ||
      sql.startsWith("CREATE TABLE IF NOT EXISTS") ||
      sql.startsWith("CREATE TABLE aggregates")
    ) {
      return result();
    }

    const state = this.#state();
    if (sql.includes(".schema_migrations") && sql.startsWith("SELECT")) {
      const maximumRows = Number(values[0]);
      return result(
        [...state.migrations.values()].sort(
          (left, right) => Number(left["ordinal"]) - Number(right["ordinal"]),
        ).slice(0, maximumRows),
      );
    }
    if (sql.startsWith("INSERT INTO") && sql.includes(".schema_migrations")) {
      const row: Row = {
        id: values[0],
        checksum_algorithm: values[1],
        checksum_hex: values[2],
        applied_at: values[3],
        ordinal: String(values[4]),
      };
      state.migrations.set(String(values[0]), row);
      return result();
    }

    if (sql.includes("/*ados:aggregate-create*/")) {
      const key = aggregateKey(values[0], values[1]);
      if (state.aggregates.has(key)) return result();
      const row: Row = {
        aggregate_type: values[0], aggregate_id: values[1], schema_version: String(values[2]),
        aggregate_version: "1", payload: values[3], checksum_algorithm: values[4],
        checksum_hex: values[5], created_at: values[6], updated_at: values[6], trace_id: values[7],
      };
      state.aggregates.set(key, row);
      return result([row]);
    }
    if (sql.includes("/*ados:aggregate-version*/")) {
      const row = state.aggregates.get(aggregateKey(values[0], values[1]));
      return result(row === undefined ? [] : [{ aggregate_version: row["aggregate_version"] }]);
    }
    if (sql.includes("/*ados:aggregate-update*/")) {
      const key = aggregateKey(values[7], values[8]);
      const row = state.aggregates.get(key);
      if (row === undefined || Number(row["aggregate_version"]) !== Number(values[9])) return result();
      const next: Row = {
        ...row, schema_version: String(values[0]), aggregate_version: String(values[1]),
        payload: values[2], checksum_algorithm: values[3], checksum_hex: values[4],
        updated_at: values[5], trace_id: values[6],
      };
      state.aggregates.set(key, next);
      return result([next]);
    }
    if (sql.includes("/*ados:aggregate-get*/")) {
      const row = state.aggregates.get(aggregateKey(values[0], values[1]));
      return result(row === undefined ? [] : [row]);
    }
    if (sql.includes("/*ados:aggregate-list*/")) {
      const [type, after, limit] = values;
      return result([...state.aggregates.values()]
        .filter((row) => row["aggregate_type"] === type && String(row["aggregate_id"]) > String(after))
        .sort((a, b) => codeUnitCompare(String(a["aggregate_id"]), String(b["aggregate_id"])))
        .slice(0, Number(limit)));
    }

    if (sql.includes("/*ados:event-append*/")) {
      const id = String(values[0]);
      if (state.events.has(id)) return result();
      const row: Row = {
        event_id: values[0], aggregate_type: values[1], aggregate_id: values[2],
        aggregate_version: String(values[3]), event_type: values[4], event_schema_version: String(values[5]),
        payload: values[6], checksum_algorithm: values[7], checksum_hex: values[8], occurred_at: values[9],
        recorded_at: values[10], global_sequence: String(this.#database.nextEventSequence++),
        trace_id: values[11], causation_id: values[12],
      };
      state.events.set(id, row);
      return result([row]);
    }
    if (sql.includes("/*ados:event-list")) {
      let rows = [...state.events.values()];
      let after: number;
      let limit: number;
      if (sql.includes("event-list-aggregate")) {
        rows = rows.filter((row) => row["aggregate_type"] === values[0] && row["aggregate_id"] === values[1]);
        after = Number(values[2]); limit = Number(values[3]);
      } else if (sql.includes("event-list-type")) {
        rows = rows.filter((row) => row["aggregate_type"] === values[0]);
        after = Number(values[1]); limit = Number(values[2]);
      } else {
        after = Number(values[0]); limit = Number(values[1]);
      }
      return result(rows.filter((row) => Number(row["global_sequence"]) > after)
        .sort((a, b) => Number(a["global_sequence"]) - Number(b["global_sequence"]))
        .slice(0, limit));
    }

    if (sql.includes("/*ados:outbox-enqueue*/")) {
      const id = String(values[0]);
      if (state.outbox.has(id) || [...state.outbox.values()].some((row) => row["idempotency_key"] === values[6])) return result();
      const row: Row = {
        message_id: values[0], topic: values[1], schema_version: String(values[2]), payload: values[3],
        checksum_algorithm: values[4], checksum_hex: values[5], idempotency_key: values[6], status: "pending",
        attempt_count: "0", created_at: values[7], available_at: values[8], lease_owner: null,
        lease_expires_at: null, acknowledged_at: null, dead_lettered_at: null,
        last_failure_category: null, sequence: String(this.#database.nextOutboxSequence++), trace_id: values[9],
      };
      state.outbox.set(id, row);
      return result([row]);
    }
    if (sql.includes("/*ados:outbox-lock*/") || sql.includes("/*ados:outbox-get*/")) {
      const row = state.outbox.get(String(values[0]));
      return result(row === undefined ? [] : [row]);
    }
    if (sql.includes("/*ados:outbox-update*/")) {
      const id = String(values[8]);
      const row = state.outbox.get(id);
      if (row === undefined) return result();
      const next: Row = {
        ...row, status: values[0], attempt_count: String(values[1]), available_at: values[2],
        lease_owner: values[3], lease_expires_at: values[4], acknowledged_at: values[5],
        dead_lettered_at: values[6], last_failure_category: values[7],
      };
      state.outbox.set(id, next);
      return result([next]);
    }
    if (sql.includes("/*ados:outbox-claim*/")) {
      const now = String(values[0]);
      return result([...state.outbox.values()]
        .filter((row) =>
          (row["status"] === "pending" && String(row["available_at"]) <= now) ||
          (row["status"] === "leased" && row["lease_expires_at"] !== null && String(row["lease_expires_at"]) <= now))
        .sort((a, b) => Number(a["sequence"]) - Number(b["sequence"]))
        .slice(0, Number(values[1])));
    }
    if (sql.includes("/*ados:outbox-list")) {
      const statusFiltered = sql.includes("outbox-list-status");
      const status = statusFiltered ? values[0] : null;
      const after = Number(values[statusFiltered ? 1 : 0]);
      const limit = Number(values[statusFiltered ? 2 : 1]);
      return result([...state.outbox.values()]
        .filter((row) => (status === null || row["status"] === status) && Number(row["sequence"]) > after)
        .sort((a, b) => Number(a["sequence"]) - Number(b["sequence"]))
        .slice(0, limit));
    }

    if (sql.includes("/*ados:artifact-put*/")) {
      const id = String(values[0]);
      if (state.artifacts.has(id)) return result();
      state.artifacts.set(id, { artifact_id: id, payload: values[1], checksum_algorithm: values[2], checksum_hex: values[3] });
      return result([{ artifact_id: id }]);
    }
    if (sql.includes("/*ados:manifest-put*/")) {
      const id = String(values[0]);
      if (state.manifests.has(id)) return result();
      state.manifests.set(id, { manifest_id: id, payload: values[1], checksum_algorithm: values[2], checksum_hex: values[3] });
      return result([{ manifest_id: id }]);
    }
    if (sql.includes("/*ados:artifact-get*/")) {
      const map = sql.includes("artifact_manifests") ? state.manifests : state.artifacts;
      const row = map.get(String(values[0]));
      return result(row === undefined ? [] : [row]);
    }
    if (sql.includes("/*ados:artifact-list*/")) {
      return result([...state.artifacts.values()]
        .filter((row) => String(row["artifact_id"]) > String(values[0]))
        .sort((a, b) => codeUnitCompare(String(a["artifact_id"]), String(b["artifact_id"])))
        .slice(0, Number(values[1])));
    }

    throw new Error(`Unsupported fake query: ${sql.slice(0, 80)}`);
  }

  release(destroy = false): void {
    if (destroy) {
      this.#database.destroyedReleaseCount += 1;
    }
    this.#released = true;
  }
}

export function createFakePoolFactory(database: FakePostgresDatabase): (
  configuration: DatabasePoolConfiguration,
) => DatabasePool {
  return (configuration) => {
    database.configurations.push(configuration);
    let closed = false;
    let errorHandler: (() => void) | null = null;
    return Object.freeze({
      async connect(): Promise<DatabaseClient> {
        if (closed) throw Object.assign(new Error("closed"), { code: "08003" });
        if (database.connectFailure !== null) {
          const failure = database.connectFailure;
          database.connectFailure = null;
          throw failure;
        }
        return new FakeClient(database);
      },
      async end(): Promise<void> {
        if (database.endHangs) {
          await new Promise<never>(() => undefined);
        }
        if (database.endFailure !== null) {
          const failure = database.endFailure;
          database.endFailure = null;
          throw failure;
        }
        closed = true;
      },
      onError(handler: () => void): void {
        errorHandler = handler;
        database.poolErrorHandler = errorHandler;
      },
    });
  };
}
