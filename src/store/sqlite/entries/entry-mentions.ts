import { isFtsAvailable, isFtsInSync, type DatabaseSyncLike } from '../../../db/index.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow } from '../runtime/rows.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { escapeLike } from '../../../base/util/escape.js';
import type { SqlFragment } from '../../../db/sql.js';
import { oldestFirst } from '../../rules/order.js';
import { type TenantId } from '../../../base/util/tenant.js';
import {
  entriesPage,
  ENTRY_PAGE_ORDER,
  type EntryPageRequest,
  type EntryRows,
} from '../runtime/keyset.js';
import type { EntryPage } from '../../../base/ports/store/types.js';

const FOLDS_TO_ASCII = ['İ', 'K'];

const hasNonAscii = (column: string): string =>
  `length(${column}) != length(CAST(${column} AS BLOB))`;

function ftsPhrase(text: string): string | null {
  if (!/^[ -~]*$/.test(text)) return null;
  const pieces = text.match(/[A-Za-z0-9]+/g);
  return pieces === null ? null : `"${pieces.join(' ')}"`;
}

function ftsMentionQuery(tokens: readonly string[], tag: string | null): string | null {
  const parts: string[] = [];
  for (const t of new Set(tokens)) {
    const phrase = ftsPhrase(t);
    if (phrase === null) return null;
    parts.push(phrase);
  }
  if (tag !== null) {
    const phrase = ftsPhrase(tag);
    if (phrase === null) return null;
    parts.push(`tags : ${phrase}`);
  }
  return parts.length === 0 ? null : parts.join(' OR ');
}

/** A page of a superset, in loadAllEntries' order, of the rows whose lowercased content holds
 * any of `tokens` or whose lowercased tags hold `tag`; `next` is where the following page
 * starts. The caller re-checks each row exactly; this only spares decoding rows that cannot
 * match. */
export function listEntriesMentioning(
  db: DatabaseSyncLike,
  tokens: readonly string[],
  tag: string,
  tenantId: TenantId,
  page: EntryPageRequest,
): EntryPage {
  const plainTag = /^[ -~]*$/.test(tag) && !/["\\]/.test(tag);
  const ftsQuery =
    plainTag && isFtsAvailable(db) && isFtsInSync(db) ? ftsMentionQuery(tokens, tag) : null;
  if (ftsQuery !== null) {
    return entriesPage(tenantId, page, (within, limit) =>
      ftsMentionRows(db, ftsQuery, within, limit),
    );
  }
  const like = likeMentionFilter(tokens, tag, plainTag);
  return entriesPage(
    tenantId,
    page,
    (within, limit) =>
      cachedStatement(
        db,
        `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${within.match(like.sql)} ${ENTRY_PAGE_ORDER}`,
      ).all(...like.params, ...within.params, limit) as MemoryRow[],
  );
}

function likeMentionFilter(tokens: readonly string[], tag: string, plainTag: boolean): SqlFragment {
  const likes = [...new Set(tokens)].map((t) => `%${escapeLike(t)}%`);
  const clauses = [
    ...likes.map(() => `content LIKE ? ESCAPE '\\'`),
    ...likes.map(() => `lead_in LIKE ? ESCAPE '\\'`),
  ];
  const params: string[] = [...likes, ...likes];
  if (plainTag) {
    clauses.push(`tags_json LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(tag)}%`);
  } else clauses.push(`COALESCE(tags_json, '[]') != '[]'`);
  for (const ch of FOLDS_TO_ASCII) {
    clauses.push('instr(content, ?) > 0', 'instr(tags_json, ?) > 0');
    params.push(ch, ch);
  }
  return { sql: clauses.join(' OR '), params };
}

const FTS_HITS = '+id IN (SELECT id FROM memories_fts WHERE memories_fts MATCH ?)';

const NON_ASCII_ROWS = `(${hasNonAscii('content')} OR ${hasNonAscii('tags_json')})`;

function ftsMentionRows(
  db: DatabaseSyncLike,
  ftsQuery: string,
  within: EntryRows,
  limit: number,
): MemoryRow[] {
  const hits = cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${within.match(FTS_HITS)} ${ENTRY_PAGE_ORDER}`,
  ).all(ftsQuery, ...within.params, limit) as MemoryRow[];
  const last = hits.length === limit ? hits[limit - 1] : undefined;
  const upTo =
    last === undefined
      ? { sql: '', params: [] }
      : { sql: ' AND created <= ?', params: [last.created] };
  const nonAscii = within.match(NON_ASCII_ROWS + upTo.sql);
  const others = cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${nonAscii} ${ENTRY_PAGE_ORDER}`,
  ).all(...upTo.params, ...within.params, limit) as MemoryRow[];
  const ids = new Set(hits.map((row) => row.id));
  return [...hits, ...others.filter((row) => !ids.has(row.id))].sort(oldestFirst).slice(0, limit);
}
