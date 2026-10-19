import type { DatabaseSyncLike } from '../../db/index.js';
import { strengthSql } from './rule-sql.js';
import { SECRET_TAGS } from '../../util/secret-detect.js';
import { originInSql } from '../../core/project-identity.js';
import { contextRowsWhere, jsonList } from './candidates.js';
import { AMBIENT_FRESH_WINDOW_MS, type AmbientTallies } from '../../core/ambient.js';
import { DEFAULT_SCHEMA_FIT, HIGH_SCHEMA_FIT, type LossAversion } from '../../core/memory.js';
import { placeholders } from '../../util/sql.js';
import type { AmbientStoreFilter } from '../port/context-reads.js';
import { isJsonNumber, isJsonString, parseJson } from '../../util/json.js';

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

/** How many times each tag occurs across the rows `scope` admits, grouped in SQL and returned as one row in first-seen
 * order; an item reads as its String() form, as parseJsonArray maps it. */
function countTags(db: DatabaseSyncLike, scope: string, params: readonly (string | number)[]): Map<string, number> {
  // One row of [tag, count] pairs in first-seen order: an array, since an object would reorder integer-like keys. The
  // aggregate ORDER BY needs SQLite 3.44; Node 22.5 and later bundle 3.46.
  // SAFETY: one row whose only column is that JSON text.
  const row = db
    .prepare(`WITH kept AS (SELECT rowid AS r, tags_json FROM memories WHERE ${scope})
    SELECT json_group_array(json_array(tag, n) ORDER BY first_r, first_key) AS pairs FROM (
      SELECT CAST(j.value AS TEXT) AS tag, COUNT(*) AS n, MIN(r) AS first_r, MIN(j.key) AS first_key
      FROM kept, json_each(${jsonList('kept.tags_json')}) AS j GROUP BY tag)`)
    .get(...params) as { pairs: string | null };
  const pairs = parseJson(row.pairs ?? '[]');
  const tallies = new Map<string, number>();
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    if (Array.isArray(pair) && isJsonString(pair[0]) && isJsonNumber(pair[1])) tallies.set(pair[0], pair[1]);
  }
  return tallies;
}

/** Whole-store ambient tallies in two aggregate passes, no row loaded. Content-pattern secrets and session-local
 *  rows (own compaction items, a printed handoff's digest) still count: only injection drops them. */
export function loadAmbientTalliesAt(
  db: DatabaseSyncLike,
  tenantId: string,
  filter: AmbientStoreFilter,
  rules: LossAversion,
): AmbientTallies {
  const { where, params } = contextRowsWhere(tenantId, filter, [`COALESCE(kind, '') != 'archived'`]);
  const secret = secretTaggedSql();
  const freshAfter = new Date(filter.now.getTime() - AMBIENT_FRESH_WINDOW_MS).toISOString();
  const scope = `${where.join(' AND ')}
      AND ((${originInSql(filter.currentProject)} AND origin_project != '') OR NOT ${secret.sql})`;
  const scopeParams = [...params, ...filter.currentProject, ...secret.params];
  // SAFETY: one aggregate row whose columns are the aliases named below. A row is an error when one of its tags is
  // `error`, `critical` or starts with `error:`, as isErrorTagged says.
  const row = db
    .prepare(`SELECT
    COUNT(*) AS total,
    COALESCE(SUM(${strengthSql(filter.now, rules)}), 0) AS strengthSum,
    COALESCE(SUM(julianday(created) > julianday(?)), 0) AS fresh,
    COALESCE(SUM(emotional_valence IN ('negative', 'critical')), 0) AS negative,
    COALESCE(SUM(COALESCE(schema_fit, ${DEFAULT_SCHEMA_FIT}) > ?), 0) AS highSchemaFit,
    COALESCE(SUM(EXISTS (SELECT 1 FROM json_each(${jsonList('tags_json')})
      WHERE value IN ('error', 'critical') OR substr(value, 1, 6) = 'error:')), 0) AS errors,
    COALESCE(SUM(layer = 'semantic'), 0) AS semantic,
    COALESCE(SUM(layer = 'episodic'), 0) AS episodic,
    COALESCE(SUM(json_array_length(${jsonList('conflicts_with_json')})), 0) AS conflicts,
    COALESCE(SUM(COALESCE(extracted_from, '') != ''), 0) AS extracted,
    MAX(0, COALESCE(MAX(COALESCE(dag_level, 0)), 0)) AS maxDagLevel
    FROM memories
    WHERE ${scope}`)
    .get(freshAfter, HIGH_SCHEMA_FIT, ...scopeParams) as Record<
    Exclude<keyof AmbientTallies, 'tagCounts'>,
    number | bigint
  >;
  const tagCounts = countTags(db, scope, scopeParams);
  return {
    total: Number(row.total),
    strengthSum: Number(row.strengthSum),
    fresh: Number(row.fresh),
    negative: Number(row.negative),
    highSchemaFit: Number(row.highSchemaFit),
    errors: Number(row.errors),
    semantic: Number(row.semantic),
    episodic: Number(row.episodic),
    conflicts: Number(row.conflicts),
    extracted: Number(row.extracted),
    maxDagLevel: Number(row.maxDagLevel),
    tagCounts,
  };
}
