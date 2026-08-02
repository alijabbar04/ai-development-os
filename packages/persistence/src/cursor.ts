import { parseJsonText, toCanonicalJson, validation } from "@ai-dev-os/domain";
import { PersistenceError } from "./errors.js";

const { ensureRecord, ensureExactKeys, ensureSafeInteger, ensureString } = validation;

/**
 * Opaque keyset-pagination cursors.
 *
 * A cursor encodes the sort-key values of the last item on the previous
 * page (never a row offset), so records inserted or removed between page
 * requests can neither duplicate nor skip results. Cursors are
 * base64url-encoded canonical JSON and are fully validated on decode;
 * malformed or mismatched cursors fail with INVALID_CURSOR.
 */

export const MAX_PAGE_SIZE = 1_000;
export const DEFAULT_PAGE_SIZE = 100;

export interface Page<T> {
  readonly items: readonly T[];
  /** Present when more items may exist; pass back to continue. */
  readonly nextCursor: string | null;
}

/** Cursor for listings ordered by a unique string key (ascending). */
export interface StringKeyCursor {
  readonly kind: "string-key";
  readonly lastKey: string;
}

/** Cursor for listings ordered by a monotonic integer sequence (ascending). */
export interface SequenceCursor {
  readonly kind: "sequence";
  readonly lastSequence: number;
}

export type ListCursor = StringKeyCursor | SequenceCursor;

const MAX_CURSOR_LENGTH = 1_024;

function malformed(): PersistenceError {
  return new PersistenceError("INVALID_CURSOR", "The pagination cursor is malformed.");
}

export function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(toCanonicalJson(cursor), "utf8").toString("base64url");
}

export function decodeCursor<TKind extends ListCursor["kind"]>(
  value: unknown,
  expectedKind: TKind,
): Extract<ListCursor, { kind: TKind }> {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    throw malformed();
  }

  try {
    const parsed = parseJsonText(Buffer.from(value, "base64url").toString("utf8"), "cursor");
    const record = ensureRecord(parsed, "cursor");
    if (record["kind"] !== expectedKind) {
      throw malformed();
    }
    if (expectedKind === "string-key") {
      ensureExactKeys(record, ["kind", "lastKey"], "cursor");
      return Object.freeze({
        kind: "string-key",
        lastKey: ensureString(record["lastKey"], "cursor.lastKey", { maxLength: 256 }),
      }) as Extract<ListCursor, { kind: TKind }>;
    }
    ensureExactKeys(record, ["kind", "lastSequence"], "cursor");
    return Object.freeze({
      kind: "sequence",
      lastSequence: ensureSafeInteger(
        record["lastSequence"],
        "cursor.lastSequence",
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    }) as Extract<ListCursor, { kind: TKind }>;
  } catch {
    throw malformed();
  }
}

export function normalizePageSize(limit: unknown, path = "limit"): number {
  if (limit === undefined || limit === null) {
    return DEFAULT_PAGE_SIZE;
  }
  return ensureSafeInteger(limit, path, 1, MAX_PAGE_SIZE);
}

/**
 * Builds a page from items already filtered past the cursor position and
 * sorted in the listing's canonical order. `items` must contain at most
 * `limit + 1` entries; the extra entry, when present, only signals that a
 * further page exists.
 */
export function buildPage<T>(
  items: readonly T[],
  limit: number,
  cursorOf: (item: T) => ListCursor,
): Page<T> {
  if (items.length <= limit) {
    return Object.freeze({ items: Object.freeze([...items]), nextCursor: null });
  }
  const pageItems = items.slice(0, limit);
  const lastItem = pageItems[pageItems.length - 1] as T;
  return Object.freeze({
    items: Object.freeze(pageItems),
    nextCursor: encodeCursor(cursorOf(lastItem)),
  });
}
