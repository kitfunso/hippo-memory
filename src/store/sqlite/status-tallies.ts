// hippo.db's status and source tallies: aggregates over a tenant's rows, no row loaded.
import type { StoreModel } from './open.js';
import { ERROR_TAG, Layer } from '../../base/memory/entry.js';
import {
  FALLBACK_HALF_LIFE_DAYS,
  calculateStrength,
  confidenceFacets,
  type ConfidenceInputs,
  type StrengthInputs,
} from '../../base/memory/strength.js';
import { strengthSql } from './rule-sql.js';
import { type DatabaseSyncLike, withReadSnapshot } from '../../db/index.js';
import { cachedStatement } from '../../db/statement-cache.js';
import type { MemoryRow } from './rows.js';
import type { TenantId } from '../../base/util/tenant.js';
import { tenantAnd } from './tenant.js';
import type { SourceTally } from '../../base/ports/store/sharing.js';
import type { StatusCounts, StrengthTallies } from '../../base/ports/store/reports.js';
import { jsonList } from './candidates.js';
// The status tally: each row scored by calculateStrength and confidenceFacets, summed in the order
// given so the average rounds the same on every run.

/** What one row's status reads: its strength and confidence inputs and its layer. */
type StatusInputs = StrengthInputs & ConfidenceInputs & { readonly layer: Layer };

/** The counts over `rows`; the caller adds the conflict and vector counts. */
function tallyStatus(
  rows: Iterable<StatusInputs>,
  now: Date,
  atRiskBelow: number,
  rules: StoreModel,
): Omit<StatusCounts, 'openConflicts' | 'embedded'> {
  const byLayer = { [Layer.Buffer]: 0, [Layer.Episodic]: 0, [Layer.Semantic]: 0, [Layer.Trace]: 0 };
  const byConfidence = { verified: 0, observed: 0, inferred: 0, stale: 0 };
  const sums = { total: 0, strength: 0, pinned: 0, atRisk: 0, agedOut: 0 };
  for (const row of rows) {
    const strength = calculateStrength(row, now, rules.strength);
    const facets = confidenceFacets(row, now);
    sums.total++;
    sums.strength += strength;
    byLayer[row.layer] = (byLayer[row.layer] ?? 0) + 1;
    byConfidence[facets.tier] = (byConfidence[facets.tier] ?? 0) + 1;
    if (row.pinned) sums.pinned++;
    if (strength < atRiskBelow) sums.atRisk++;
    if (facets.agedOut) sums.agedOut++;
  }
  const { total, pinned, atRisk, agedOut } = sums;
  return {
    total,
    byLayer,
    byConfidence,
    pinned,
    atRisk,
    agedOut,
    avgStrength: total > 0 ? sums.strength / total : 0,
  };
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
type SourceTallyDbRow = SourceTally;

/** Row count and newest `created` per source, for peer listings that need no row. */
export function tallySources(db: DatabaseSyncLike, tenantId: TenantId): SourceTally[] {
  const tenant = tenantAnd(tenantId);
  return cachedStatement(
    db,
    `SELECT COALESCE(source, 'cli') AS source, COUNT(*) AS count, MAX(created) AS latest, MIN(created || ` +
      `char(31) || id) AS first
     FROM memories WHERE 1${tenant.sql} GROUP BY COALESCE(source, 'cli')`,
  ).all(...tenant.params) as SourceTallyDbRow[];
}

export interface StrengthTalliesOptions {
  readonly rules: StoreModel;
  readonly tenantId: string;
  readonly now: Date;
  readonly atRiskBelow: number;
}

/** calculateStrength over every row of a tenant in one aggregate pass, no row loaded, on a
 * handle the caller holds so it can share a snapshot with other reads. */
export function strengthTallies(
  db: DatabaseSyncLike,
  { rules, tenantId, now, atRiskBelow }: StrengthTalliesOptions,
): StrengthTallies {
  // An unparseable date scores NULL in SQL and 0 in calculateStrength.
  const bound = strengthSql(now, rules.strength);
  const strength = `COALESCE(${bound.sql}, 0)`;
  const params = [ERROR_TAG, ...bound.params, ...bound.params, atRiskBelow, tenantId];
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  const row = cachedStatement(
    db,
    `SELECT
      COUNT(*) AS total,
      COALESCE(SUM(pinned != 0), 0) AS pinned,
      COALESCE(SUM(EXISTS (SELECT 1 FROM json_each(${jsonList('tags_json')}) WHERE value = ?)), 0) AS errors,
      COALESCE(SUM(${strength}), 0) AS strengthSum,
      COALESCE(SUM(COALESCE(pinned, 0) = 0 AND ${strength} < ?), 0) AS atRisk
      FROM memories WHERE tenant_id = ?`,
  ).get(...params) as Record<keyof StrengthTallies, number | bigint>;
  return {
    total: Number(row.total),
    pinned: Number(row.pinned),
    errors: Number(row.errors),
    strengthSum: Number(row.strengthSum),
    atRisk: Number(row.atRisk),
  };
}

type StatusColumn =
  | 'layer'
  | 'confidence'
  | 'pinned'
  | 'created'
  | 'last_retrieved'
  | 'half_life_days'
  | 'retrieval_count'
  | 'emotional_valence'
  | 'outcome_positive'
  | 'outcome_negative';
// SAFETY: every read cast to this row selects STATUS_ROW_COLUMNS; scripts/check-row-casts.mjs
// proves it. The store writes `layer` only from the Layer enum.
type StatusRow = Omit<Pick<MemoryRow, StatusColumn>, 'layer'> & { layer: Layer };
// What calculateStrength and confidenceFacets read, plus the layer: no text and no JSON column.
const STATUS_ROW_COLUMNS: readonly StatusColumn[] = [
  'layer',
  'confidence',
  'pinned',
  'created',
  'last_retrieved',
  'half_life_days',
  'retrieval_count',
  'emotional_valence',
  'outcome_positive',
  'outcome_negative',
];

// Scored in JavaScript, not with strengthSql: SQLite reads fewer date shapes than Date does, so its
// counts would differ. rowToEntry's defaults for these columns, so a row scores as its loaded entry
// would.
function* statusInputs(rows: Iterable<StatusRow>): Iterable<StatusInputs> {
  for (const row of rows) {
    yield {
      layer: row.layer,
      pinned: Boolean(row.pinned),
      confidence: row.confidence ?? 'observed',
      created: row.created,
      lastRetrieved: row.last_retrieved,
      halfLifeDays: Number(row.half_life_days ?? FALLBACK_HALF_LIFE_DAYS),
      retrievalCount: Number(row.retrieval_count ?? 0),
      emotionalValence: row.emotional_valence ?? 'neutral',
      outcomePositive: Number(row.outcome_positive ?? 0),
      outcomeNegative: Number(row.outcome_negative ?? 0),
    };
  }
}

/**
 * The counts `hippo status` prints, from one pass over ten narrow columns: no text is read and no
 * row array is built.
 */
export function statusCounts(
  db: DatabaseSyncLike,
  rules: StoreModel,
  now: Date,
  atRiskBelow: number,
): StatusCounts {
  // One read transaction, so the row tallies and the two counts describe the same store.
  return withReadSnapshot(db, () => {
    // loadAllEntries' order, so the strengths add up in the order they did and the average rounds
    // the same.
    const rows = cachedStatement(
      db,
      `SELECT ${STATUS_ROW_COLUMNS.join(', ')} FROM memories ORDER BY created ASC, id ASC`,
    ).iterate() as Iterable<StatusRow>;
    const tallies = tallyStatus(statusInputs(rows), now, atRiskBelow, rules);
    // SAFETY: scalar subqueries with no FROM always answer one row.
    const counts = cachedStatement(
      db,
      `SELECT
      (SELECT COUNT(*) FROM memory_conflicts WHERE status = 'open') AS openConflicts,
      (SELECT COUNT(*) FROM memory_vectors WHERE memory_id IN (SELECT id FROM memories)) AS embedded`,
    ).get() as Record<'openConflicts' | 'embedded', number | bigint>;
    return {
      ...tallies,
      openConflicts: Number(counts.openConflicts),
      embedded: Number(counts.embedded),
    };
  });
}
