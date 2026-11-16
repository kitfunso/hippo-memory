// What a delete does for the rows that named the deleted row as their replacement.
import { REPLACED_BY_PREFIX } from '../../../base/memory/stale-mark.js';
import type { DatabaseSyncLike } from '../../../db/index.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { parseJsonArray } from '../runtime/rows.js';
import { syncFtsRow } from './entry-row.js';

/** A deleted row `id` and the row `keptId` that takes its place. */
export interface Repoint {
  readonly id: string;
  readonly keptId: string;
}

interface TaggedRow {
  id: string;
  content: string;
  tags_json: string;
}

/** Points each row that was superseded by a deleted row, or tagged replaced-by it, at its `keptId`
 * instead, in the caller's transaction: one scan of each column for the whole batch. */
export function repointSuccessors(db: DatabaseSyncLike, moves: readonly Repoint[]): void {
  if (moves.length === 0) return;
  const keptOf = new Map(moves.map((move) => [move.id, move.keptId]));
  cachedStatement(
    db,
    `WITH v AS (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS kept ` +
      `FROM json_each(?)) UPDATE memories SET superseded_by = v.kept FROM v ` +
      `WHERE memories.superseded_by = v.id`,
  ).run(JSON.stringify([...keptOf]));
  // SAFETY: the SELECT names the three TaggedRow columns.
  const tagged = cachedStatement(
    db,
    `SELECT id, content, tags_json FROM memories WHERE tags_json LIKE ?`,
  ).all(`%${REPLACED_BY_PREFIX}%`) as TaggedRow[];
  for (const row of tagged) {
    const tags = parseJsonArray(row.tags_json);
    const moved = tags.map((tag) => {
      const kept = tag.startsWith(REPLACED_BY_PREFIX)
        ? keptOf.get(tag.slice(REPLACED_BY_PREFIX.length))
        : undefined;
      return kept === undefined ? tag : `${REPLACED_BY_PREFIX}${kept}`;
    });
    if (moved.every((tag, i) => tag === tags[i])) continue;
    cachedStatement(db, `UPDATE memories SET tags_json = ?, updated_at = datetime('now') WHERE id = ?`).run(
      JSON.stringify(moved),
      row.id,
    );
    syncFtsRow(db, { id: row.id, content: row.content, tags: moved });
  }
}
