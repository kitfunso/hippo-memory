// Pages of the /v1 list routes: the rows a page keeps, its next cursor, and the header a bare-array route sends it in.
import type { ServerResponse } from 'node:http';
import { encodeCursor } from '../../api/cursor.js';
import { keysetPage, type KeysetPosition } from '../../base/util/keyset.js';

/** Bare-array routes cannot grow a body field without breaking clients, so their next cursor rides this header. */
export const NEXT_CURSOR_HEADER = 'X-Next-Cursor';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Drops the one-row lookahead the query fetched past `limit` and names the next page's cursor, null on the last page.
 */
export function pageOf<T>(rows: readonly T[], limit: number, positionOf: (row: T) => KeysetPosition): Page<T> {
  const page = keysetPage(rows, limit, positionOf);
  return { items: page.rows, nextCursor: page.next === null ? null : encodeCursor(page.next) };
}

/**
 * Rows ordered by (created_at DESC, id DESC): the decision, incident, process, policy, skill, brief, note and
 * prediction tables.
 */
export function byCreatedAt(row: { createdAt: string; id: number }): KeysetPosition {
  return { key: row.createdAt, id: row.id };
}

/** Sets the next-page header on a bare-array response; absent means this was the last page. */
export function setNextCursorHeader(res: ServerResponse, nextCursor: string | null): void {
  if (nextCursor !== null) res.setHeader(NEXT_CURSOR_HEADER, nextCursor);
}
