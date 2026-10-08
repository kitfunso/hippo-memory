// Opaque cursors for the /v1 list routes: base64url JSON of the last returned row's sort key and id.
import type { ServerResponse } from 'node:http';
import { HttpError } from '../http-util.js';
import type { KeysetPosition } from '../keyset.js';
import { isJsonNumber } from './validation.js';
import { type JsonValue, isJsonString } from '../json.js';

type CursorPart = 'string' | 'integer';

/** Bare-array routes cannot grow a body field without breaking clients, so their next cursor rides this header. */
export const NEXT_CURSOR_HEADER = 'X-Next-Cursor';

const MAX_CURSOR_CHARS = 1024;
const CURSOR_RE = /^[A-Za-z0-9_-]+$/;

export function encodeCursor(pos: KeysetPosition): string {
  return Buffer.from(JSON.stringify([pos.key, pos.id])).toString('base64url');
}

function decodeJson(raw: string): JsonValue | undefined {
  try {
    const parsed: JsonValue = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return parsed;
  } catch (e) {
    if (e instanceof SyntaxError) return undefined;
    throw e;
  }
}

function isPart(value: JsonValue | undefined, part: CursorPart): value is string | number {
  if (part === 'string') return isJsonString(value) && value.length > 0;
  return isJsonNumber(value) && Number.isInteger(value);
}

function toPosition(parsed: JsonValue | undefined, keyPart: CursorPart, idPart: CursorPart): KeysetPosition | undefined {
  if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
  const [key, id] = parsed;
  return isPart(key, keyPart) && isPart(id, idPart) ? { key, id } : undefined;
}

/** The position a `?cursor=` names, or undefined when the param is absent; anything this server did not mint is a 400. */
export function parseCursor(raw: string | null, keyPart: CursorPart, idPart: CursorPart): KeysetPosition | undefined {
  if (raw === null) return undefined;
  const parsed = raw.length <= MAX_CURSOR_CHARS && CURSOR_RE.test(raw) ? decodeJson(raw) : undefined;
  const pos = toPosition(parsed, keyPart, idPart);
  if (!pos) throw new HttpError(400, 'cursor is malformed; pass next_cursor from the previous page unchanged');
  return pos;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Drops the one-row lookahead the query fetched past `limit` and names the next page's cursor, null on the last page. */
export function pageOf<T>(rows: readonly T[], limit: number, positionOf: (row: T) => KeysetPosition): Page<T> {
  if (rows.length <= limit) return { items: [...rows], nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: encodeCursor(positionOf(items[items.length - 1]!)) };
}

/** Rows ordered by (created_at DESC, id DESC): the decision, incident, process, policy, skill, brief, note and prediction tables. */
export function byCreatedAt(row: { createdAt: string; id: number }): KeysetPosition {
  return { key: row.createdAt, id: row.id };
}

/** Sets the next-page header on a bare-array response; absent means this was the last page. */
export function setNextCursorHeader(res: ServerResponse, nextCursor: string | null): void {
  if (nextCursor !== null) res.setHeader(NEXT_CURSOR_HEADER, nextCursor);
}
