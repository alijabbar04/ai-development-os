import DatabaseConstructor from "better-sqlite3";

/**
 * Structural view of the better-sqlite3 surface this adapter uses. The raw
 * connection never escapes this package: the public API exposes only the
 * provider-neutral persistence contract.
 */
export interface SqliteStatement {
  run(...params: ReadonlyArray<string | number | null>): { readonly changes: number };
  get(...params: ReadonlyArray<string | number | null>): unknown;
  all(...params: ReadonlyArray<string | number | null>): unknown[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(directive: string, options?: { readonly simple?: boolean }): unknown;
  close(): void;
  readonly open: boolean;
  readonly inTransaction: boolean;
}

export function openSqliteDatabase(location: string): SqliteDatabase {
  return new DatabaseConstructor(location) as SqliteDatabase;
}
