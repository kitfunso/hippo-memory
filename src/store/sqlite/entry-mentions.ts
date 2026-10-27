// The memories that mention a word or tag: FTS first, then a LIKE scan, with the non-ASCII case fold.

import { isFtsAvailable, isFtsInSync, type DatabaseSyncLike } from '../../db/index.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow } from './rows.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { escapeLike } from '../../base/util/escape.js';
import type { SqlFragment } from '../../db/sql.js';
import { oldestFirst } from '../rules/order.js';
import { type TenantId } from '../../base/util/tenant.js';
import { entriesPage, ENTRY_PAGE_ORDER, type EntryPageRequest, type EntryRows } from './keyset.js';
import type { EntryPage } from '../../base/ports/store/types.js';

// The only code points whose JS toLowerCase yields ASCII, which SQLite's ASCII-only LIKE folding
// cannot see.
const FOLDS_TO_ASCII = ['İ', 'K'];

// Chars or bytes differ only when a non-ASCII char is present; the check never decodes the value.
const hasNonAscii = (column: string): string =>
  `length(${column}) != length(CAST(${column} AS BLOB))`;

/** The FTS5 phrase for `text`: its ASCII alphanumeric runs in order, which is how unicode61
 * splits it; null when it holds none (the phrase would be empty) or any non-ASCII char. */
function ftsPhrase(text: string): string | null {
  if (!/^[ -~]*$/.test(text)) return null;
  const pieces = text.match(/[A-Za-z0-9]+/g);
  return pieces === null ? null : `"${pieces.join(' ')}"`;
}

/** MATCH expression whose hits include every row the LIKE path would keep, or null when some
 * token or the tag has no FTS form. Rows with non-ASCII text are added by the caller: JS
 * tokenizers drop those chars, unicode61 keeps them. */
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
  // A tag needing JSON escapes or case folding past ASCII is not found by a substring of tags_json,
  // so every tagged row stays in.
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

/** The LIKE and instr terms that keep every row a mention may match, for a store whose FTS
 * cannot answer. */
function likeMentionFilter(tokens: readonly string[], tag: string, plainTag: boolean): SqlFragment {
  const likes = [...new Set(tokens)].map((t) => `%${escapeLike(t)}%`);
  const clauses = likes.map(() => `content LIKE ? ESCAPE '\\'`);
  const params: string[] = [...likes];
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

// The plus keeps SQLite on the tenant's created index: on the id key it would fetch and sort every
// hit for each page.
const FTS_HITS = '+id IN (SELECT id FROM memories_fts WHERE memories_fts MATCH ?)';

const NON_ASCII_ROWS = `(${hasNonAscii('content')} OR ${hasNonAscii('tags_json')})`;

// Two reads, not one OR, so only the non-ASCII read decodes each row's text, and with a full page
// of hits it stops at the last hit, past which no row can make the page.
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
