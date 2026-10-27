// hippo.db's schema fit: computeSchemaFit against a tenant's newest rows.
import { schemaFitFrom } from '../../base/memory/entry.js';
import { type DatabaseSyncLike, withReadSnapshot } from '../../db/index.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { parseJsonArray } from './rows.js';
import { SCHEMA_FIT_WINDOW_ROWS } from '../rules/windows.js';
function* contentsOf(rows: Iterable<{ content: string }>): Generator<string> {
  for (const row of rows) yield row.content;
}

/** computeSchemaFit against a tenant's newest SCHEMA_FIT_WINDOW_ROWS rows: tag counts come from
 * one aggregate and texts stream one column, so no row is loaded. */
export function schemaFit(
  db: DatabaseSyncLike,
  tenantId: string,
  content: string,
  tags: readonly string[],
): number {
  const newest =
    'SELECT tags_json, content FROM memories WHERE tenant_id = ? ORDER BY created DESC, id DESC LIMIT ?';
  // One read transaction, so the row count and the texts come from the same snapshot.
  return withReadSnapshot(db, () => {
    const groups = cachedStatement(
      db,
      `SELECT tags_json, COUNT(*) AS n FROM (${newest}) GROUP BY tags_json`,
    ).all(tenantId, SCHEMA_FIT_WINDOW_ROWS) as Array<{ tags_json: string | null; n: number }>;
    let rows = 0;
    const tagCounts = new Map<string, number>();
    for (const group of groups) {
      rows += group.n;
      for (const tag of parseJsonArray(group.tags_json)) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + group.n);
      }
    }
    // SHORTCUT: only the newest SCHEMA_FIT_WINDOW_ROWS rows count, so older tags drop out; a stored
    // per-tenant tag and token tally is the upgrade.
    const texts = cachedStatement(db, `SELECT content FROM (${newest})`).iterate(
      tenantId,
      SCHEMA_FIT_WINDOW_ROWS,
    ) as Iterable<{
      content: string;
    }>;
    return schemaFitFrom(content, tags, { rows, tagCounts, contents: contentsOf(texts) });
  });
}
