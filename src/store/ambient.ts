import type { DatabaseSyncLike } from '../db/index.js';
import { strengthSql } from './rule-sql.js';
import { SECRET_TAGS } from '../util/secret-detect.js';
import { onHandle, openStore } from './open.js';
import { originInSql } from '../core/project-identity.js';
import { contextRowsWhere, jsonList } from './candidates.js';
import { AMBIENT_FRESH_WINDOW_MS, isErrorTagged, type AmbientTallies } from '../core/ambient.js';
import { HIGH_SCHEMA_FIT } from '../core/memory.js';
import { placeholders } from '../util/sql.js';
import type { AmbientStoreFilter } from './port/context-reads.js';

/** A secret tag's row, the half of detectSecret SQL can check; the LIKEs only skip json_each on rows that cannot
 * match. */
function secretTaggedSql() {
  const tags = [...SECRET_TAGS];
  return {
    sql: `((${tags.map(() => 'tags_json LIKE ?').join(' OR ')})
      AND EXISTS (SELECT 1 FROM json_each(${jsonList('tags_json')}) WHERE lower(value) IN
      (${placeholders(tags.length)})))`,
    params: [...tags.map((t) => `%"${t}"%`), ...tags],
  };
}

interface TagTally {
  readonly tagCounts: Map<string, number>;
  readonly errors: number;
}

function countTags(tagLists: string): TagTally {
  const tagCounts = new Map<string, number>();
  let errors = 0;
  // SAFETY: jsonList yields an array per row, joined into one array.
  const lists = JSON.parse(tagLists) as unknown[][];
  for (const raw of lists) {
    const tags = raw.map((item) => String(item));
    for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    if (isErrorTagged(tags)) errors++;
  }
  return { tagCounts, errors };
}

/** Whole-store ambient tallies in one aggregate pass, no row loaded. Content-pattern secrets and session-local
 *  rows (own compaction items, a printed handoff's digest) still count: only injection drops them. */
export function loadAmbientTalliesAt(
  db: DatabaseSyncLike,
  tenantId: string,
  filter: AmbientStoreFilter,
): AmbientTallies {
  const { where, params } = contextRowsWhere(tenantId, filter, [`COALESCE(kind, '') != 'archived'`]);
  const secret = secretTaggedSql();
  const freshAfter = new Date(filter.now.getTime() - AMBIENT_FRESH_WINDOW_MS).toISOString();
  // SAFETY: one aggregate row whose columns are the aliases named below. Tag lists come back as one JSON array of
  // arrays and are counted in JS, which maps items through String() as parseJsonArray does.
  const row = db.prepare(`SELECT
    COUNT(*) AS total,
    COALESCE(SUM(${strengthSql(filter.now)}), 0) AS strengthSum,
    COALESCE(SUM(julianday(created) > julianday(?)), 0) AS fresh,
    COALESCE(SUM(emotional_valence IN ('negative', 'critical')), 0) AS negative,
    COALESCE(SUM(COALESCE(schema_fit, 0.5) > ?), 0) AS highSchemaFit,
    COALESCE(SUM(layer = 'semantic'), 0) AS semantic,
    COALESCE(SUM(layer = 'episodic'), 0) AS episodic,
    COALESCE(SUM(json_array_length(${jsonList('conflicts_with_json')})), 0) AS conflicts,
    COALESCE(SUM(COALESCE(extracted_from, '') != ''), 0) AS extracted,
    MAX(0, COALESCE(MAX(COALESCE(dag_level, 0)), 0)) AS maxDagLevel,
    '[' || COALESCE(group_concat(${jsonList('tags_json')}, ','), '') || ']' AS tagLists
    FROM memories
    WHERE ${where.join(' AND ')}
      AND ((${originInSql(filter.currentProject)} AND origin_project != '') OR NOT ${secret.sql})`,
  ).get(freshAfter, HIGH_SCHEMA_FIT, ...params, ...filter.currentProject, ...secret.params) as
    Record<Exclude<keyof AmbientTallies, 'tagCounts' | 'errors'>, number | bigint> & { tagLists: string };
  const { tagCounts, errors } = countTags(row.tagLists);
  return {
    total: Number(row.total),
    strengthSum: Number(row.strengthSum),
    fresh: Number(row.fresh),
    negative: Number(row.negative),
    highSchemaFit: Number(row.highSchemaFit),
    errors,
    semantic: Number(row.semantic),
    episodic: Number(row.episodic),
    conflicts: Number(row.conflicts),
    extracted: Number(row.extracted),
    maxDagLevel: Number(row.maxDagLevel),
    tagCounts,
  };
}

export function loadAmbientTallies(hippoRoot: string, tenantId: string, filter: AmbientStoreFilter): AmbientTallies {
  return onHandle(hippoRoot, (db) => loadAmbientTalliesAt(db, tenantId, filter), openStore);
}
