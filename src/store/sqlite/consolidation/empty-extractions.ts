// A source's empty extraction mark, one `meta` row per source: {"digest": hash of its text, "at": ISO}.
// When a mark stands is decided in src/domain/consolidate/retry-holds.ts.
import { type DatabaseSyncLike, withWriteScope } from '../../../db/index.js';
import { notSupersededIn } from '../../../db/sql-predicates.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import type { Consolidation } from '../../../base/ports/store/consolidation.js';

const MARK_KEY = 'empty_extraction:';
// The first key past every mark key, as ';' follows ':'.
const MARK_END = 'empty_extraction;';
// substr is 1-based, so this is the first character of the id.
const ID_FROM = MARK_KEY.length + 1;

type Page = Awaited<ReturnType<NonNullable<Consolidation['emptyExtractions']>>>;
type Note = Parameters<NonNullable<Consolidation['noteEmptyExtractions']>>[0];

// A value that is not JSON with text digest and at reads as no mark; CASE keeps json_type off bad
// JSON, which AND would not.
const PAGE_SQL = `SELECT substr(key, ${ID_FROM}) AS id,
       json_extract(value, '$.digest') AS digest, json_extract(value, '$.at') AS at
  FROM meta
 WHERE key > ? AND key < '${MARK_END}'
   AND CASE WHEN json_valid(value)
            THEN json_type(value, '$.digest') = 'text' AND json_type(value, '$.at') = 'text'
            ELSE 0 END
 ORDER BY key
 LIMIT ?`;

/** One page of marks by source id, after the id `after`; a row that is not a mark is skipped. */
export function emptyExtractions(
  db: DatabaseSyncLike,
  page: { readonly limit: number; readonly after?: string },
): Page {
  // SAFETY: the SQL names id, digest and at, and its WHERE keeps digest and at text.
  const rows = cachedStatement(db, PAGE_SQL).all(
    `${MARK_KEY}${page.after ?? ''}`,
    page.limit + 1,
  ) as Array<{ id: string; digest: string; at: string }>;
  const marks = rows.slice(0, page.limit);
  return { marks, next: rows.length > page.limit ? (marks.at(-1)?.id ?? null) : null };
}

// Writes only for a source row that is live, as the sleep that offers it reads it.
const MARK_SQL = `INSERT INTO meta(key, value)
  SELECT ?, ?
   WHERE EXISTS (SELECT 1 FROM memories
                  WHERE id = ? AND kind != 'archived' AND ${notSupersededIn()})
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

// A mark left for a source that is gone, archived or superseded would never be read again.
const SWEEP_SQL = `DELETE FROM meta
  WHERE key > '${MARK_KEY}' AND key < '${MARK_END}'
    AND NOT EXISTS (SELECT 1 FROM memories m
                     WHERE m.id = substr(meta.key, ${ID_FROM})
                       AND m.kind != 'archived' AND ${notSupersededIn('m.')})`;

/** Stores the marks and drops the cleared ones in one write, then drops the marks of sources that
 * are no longer live. */
export function noteEmptyExtractions(db: DatabaseSyncLike, { mark, clear }: Note): void {
  if (mark.length === 0 && clear.length === 0) return;
  withWriteScope(db, 'empty_extraction', () => {
    const put = cachedStatement(db, MARK_SQL);
    for (const { id, digest, at } of mark) {
      put.run(`${MARK_KEY}${id}`, JSON.stringify({ digest, at }), id);
    }
    const drop = cachedStatement(db, 'DELETE FROM meta WHERE key = ?');
    for (const id of clear) drop.run(`${MARK_KEY}${id}`);
    cachedStatement(db, SWEEP_SQL).run();
  });
}
