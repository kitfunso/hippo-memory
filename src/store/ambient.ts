import { closeHippoDb } from '../db/index.js';
import { strengthSql } from './rule-sql.js';
import { scopeAdmitSql } from './recall-scope.js';
import { SECRET_TAGS } from '../util/secret-detect.js';
import { openStore } from './open.js';
import { jsonList } from './candidates.js';
import { originInSql } from '../core/project-identity.js';
import { isErrorTagged, type AmbientTallies } from '../core/ambient.js';
import { DAY_MS } from '../util/time.js';

/** The rows an ambient summary describes: a context read's envelope, origin partition and tag secret veto. */
export interface AmbientStoreFilter {
  exactScope?: string;
  /** The reader's personal scope, which the default deny admits. */
  ownScope?: string;
  /** Rows carrying one of these project names, and user-global rows, pass; absent admits every origin. */
  project?: readonly string[];
  /** The reader's project names: a secret-tagged row counts only inside its own non-empty origin project. */
  currentProject: readonly string[];
  now: Date;
}

// SHORTCUT: mirrors loadContextCandidates' WHERE (request-path snapshots pin the match); share it once store.ts is split.
function contextRowsWhere(tenantId: string, filter: AmbientStoreFilter) {
  const where = ['tenant_id = ?', `COALESCE(superseded_by, '') = ''`, `COALESCE(kind, '') != 'archived'`];
  const params: string[] = [tenantId];
  if (filter.exactScope) {
    where.push('scope = ?');
    params.push(filter.exactScope);
  } else {
    const admit = scopeAdmitSql('', filter.ownScope);
    where.push(admit.sql);
    params.push(...admit.params);
  }
  if (filter.project !== undefined) {
    where.push(`(origin_project = '' OR ${originInSql(filter.project)})`);
    params.push(...filter.project);
  }
  return { where, params };
}

/** A secret tag's row, the half of detectSecret SQL can check; the LIKEs only skip json_each on rows that cannot match. */
function secretTaggedSql() {
  const tags = [...SECRET_TAGS];
  return {
    sql: `((${tags.map(() => 'tags_json LIKE ?').join(' OR ')})
      AND EXISTS (SELECT 1 FROM json_each(${jsonList('tags_json')}) WHERE lower(value) IN (${tags.map(() => '?').join(', ')})))`,
    params: [...tags.map((t) => `%"${t}"%`), ...tags],
  };
}

/** Whole-store ambient tallies in one aggregate pass, no row loaded. Content-pattern secrets and session-local
 *  rows (own compaction items, a printed handoff's digest) still count: only injection drops them. */
export function loadAmbientTallies(hippoRoot: string, tenantId: string, filter: AmbientStoreFilter): AmbientTallies {
  const { where, params } = contextRowsWhere(tenantId, filter);
  const secret = secretTaggedSql();
  const sevenDaysAgo = new Date(filter.now.getTime() - 7 * DAY_MS).toISOString();
  const db = openStore(hippoRoot);
  try {
    // SAFETY: one aggregate row whose columns are the aliases named below. Tag lists come back as one JSON array of
    // arrays and are counted in JS, which maps items through String() as parseJsonArray does.
    const row = db.prepare(`SELECT
      COUNT(*) AS total,
      COALESCE(SUM(${strengthSql(filter.now)}), 0) AS strengthSum,
      COALESCE(SUM(julianday(created) > julianday(?)), 0) AS fresh,
      COALESCE(SUM(emotional_valence IN ('negative', 'critical')), 0) AS negative,
      COALESCE(SUM(COALESCE(schema_fit, 0.5) > 0.7), 0) AS highSchemaFit,
      COALESCE(SUM(layer = 'semantic'), 0) AS semantic,
      COALESCE(SUM(layer = 'episodic'), 0) AS episodic,
      COALESCE(SUM(json_array_length(${jsonList('conflicts_with_json')})), 0) AS conflicts,
      COALESCE(SUM(COALESCE(extracted_from, '') != ''), 0) AS extracted,
      MAX(0, COALESCE(MAX(COALESCE(dag_level, 0)), 0)) AS maxDagLevel,
      '[' || COALESCE(group_concat(${jsonList('tags_json')}, ','), '') || ']' AS tagLists
      FROM memories
      WHERE ${where.join(' AND ')}
        AND ((${originInSql(filter.currentProject)} AND origin_project != '') OR NOT ${secret.sql})`,
    ).get(sevenDaysAgo, ...params, ...filter.currentProject, ...secret.params) as Record<Exclude<keyof AmbientTallies, 'tagCounts' | 'errors'>, number | bigint> & { tagLists: string };
    const tagCounts = new Map<string, number>();
    let errors = 0;
    const lists = /* SAFETY: jsonList yields an array per row, joined into one array */ JSON.parse(row.tagLists) as unknown[][];
    for (const raw of lists) {
      const tags = raw.map((item) => String(item));
      for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      if (isErrorTagged(tags)) errors++;
    }
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
  } finally {
    closeHippoDb(db);
  }
}
