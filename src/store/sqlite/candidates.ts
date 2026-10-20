import {
  type MemoryEntry,
  FALLBACK_HALF_LIFE_DAYS,
  Layer,
  calculateStrength,
  confidenceFacets,
  schemaFitFrom,
  type LossAversion,
} from '../../core/memory.js';
import { strengthSql } from './rule-sql.js';
import { isOutcomeSlowAblated } from '../../core/ablation.js';
import { DECAY_KEY_HALF_LIVES, DECAY_KEY_SLACK_DAYS, DECAY_KEY_SQL, DECAY_KEY_WHERE } from '../../db/decay-key.js';
import { type DatabaseSyncLike, withReadSnapshot } from '../../db/index.js';
import { rewardFactorSql, scopeAdmitSql, type SqlFragment } from './rule-sql.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry, parseJsonArray } from './rows.js';
import { originInSql } from '../../core/project-identity.js';
import { pickRarestFtsQuery, loadRecallEntriesAt } from './search-rows.js';
import type { HeldText } from '../port/types.js';
import type { TenantId } from '../../util/tenant.js';
import { tenantAnd } from './tenant.js';
import { chunked } from '../../util/chunked.js';
import type { AmbientRefusalReason } from '../../core/read-admission.js';
import type {
  AmbientCandidateRequest,
  AmbientCandidates,
  AmbientRefusal,
  ContextCandidateFilter,
  RecentOrigins,
} from '../port/context-reads.js';
import type { SourceTally } from '../local/sharing.js';
import type { StatusCounts, StrengthTallies } from '../port/reports.js';

const AMBIENT_SCOPED = 'superseded_by IS NULL AND tenant_id = ?';
/** idx_memories_pinned (migration v51) serves it. */
const AMBIENT_PINNED_WHERE = `pinned = 1 AND ${AMBIENT_SCOPED} ORDER BY created ASC, id ASC`;
const CREATED_DRIFTED = "(length(created) <> 24 OR created NOT LIKE '%Z')";
/** idx_memories_created_drift (migration v51) serves it. */
const AMBIENT_DRIFT_SQL = `SELECT 1 FROM memories WHERE ${AMBIENT_SCOPED} AND ${CREATED_DRIFTED} LIMIT 1`;

type RunSql = (where: string, params: Array<string | number>) => MemoryEntry[];

function inOrigins(e: MemoryEntry, origins: RecentOrigins): boolean {
  const origin = e.originProject ?? null;
  return origin === '' ? origins.userGlobal : origin !== null && origins.names.includes(origin);
}

interface RecentRowsOptions {
  readonly needed: number;
  readonly admit: (e: MemoryEntry) => boolean;
  readonly origins?: RecentOrigins;
}

// `id DESC` mirrors contextGet's comparator, not loadFreshRawMemories'
// cross-ingest-stable order: that would change what the hook injects.
const NEWEST = 'ORDER BY created DESC, id DESC';

interface OwnRows {
  readonly where: string;
  readonly params: ReadonlyArray<string | number>;
}

// The newest rows `admit` keeps, newest first. The first window stays unfiltered so admit still sees, and the
// delivery ledger still counts, the other-project rows it refuses; past it, the reads narrow to the caller's origins.
function loadRecentRows(run: RunSql, drifted: boolean, tenantId: string, options: RecentRowsOptions): MemoryEntry[] {
  const { needed, admit, origins } = options;
  const keep = origins ? (e: MemoryEntry): boolean => admit(e) && inOrigins(e, origins) : admit;
  const window = Math.max(needed * 4, 32);
  const originSql =
    origins &&
    (origins.userGlobal ? `(origin_project = '' OR ${originInSql(origins.names)})` : originInSql(origins.names));
  const own: OwnRows = {
    where: originSql ? `${AMBIENT_SCOPED} AND ${originSql}` : AMBIENT_SCOPED,
    params: [tenantId, ...(origins?.names ?? [])],
  };
  // Text order is chronological only for standard UTC ISO (memory.ts), so a drifted store is read whole and re-sorted
  // downstream.
  if (drifted) return run(`${own.where} ${NEWEST}`, [...own.params]).filter(keep);
  let read = run(`${AMBIENT_SCOPED} ${NEWEST} LIMIT ?`, [tenantId, window]);
  let kept = read.filter(keep);
  if (kept.length >= needed || read.length < window) return kept;
  if (origins) {
    read = run(`${own.where} ${NEWEST} LIMIT ?`, [...own.params, window]);
    kept = read.filter(keep);
    if (kept.length >= needed || read.length < window) return kept;
  }
  return [...kept, ...keptPastWindow(run, own, read, needed - kept.length, keep)];
}

// A window of refused rows can hide older ones, so read on in keyset pages, each four times the last, until enough are
// kept.
function keptPastWindow(
  run: RunSql,
  own: OwnRows,
  read: readonly MemoryEntry[],
  wanted: number,
  keep: (e: MemoryEntry) => boolean,
): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  let last = read[read.length - 1];
  for (let size = read.length * 4; out.length < wanted; size *= 4) {
    const page = run(`${own.where} AND created <= ? AND (created < ? OR id < ?) ${NEWEST} LIMIT ?`, [
      ...own.params,
      last.created,
      last.created,
      last.id,
      size,
    ]);
    out.push(...page.filter(keep));
    if (page.length < size) break;
    last = page[page.length - 1];
  }
  return out;
}

/** Judges one row an ambient load reads: null keeps it, a reason leaves it out. */
export type AmbientJudge = (e: MemoryEntry) => AmbientRefusalReason | null;

function noting(judge: AmbientJudge, refused: AmbientRefusal[]): (e: MemoryEntry) => boolean {
  return (e) => {
    const reason = judge(e);
    if (reason !== null) refused.push({ id: e.id, reason });
    return reason === null;
  };
}

/** The port's ambient request with the row test already built from its admission settings. */
export interface AmbientLoad extends Omit<AmbientCandidateRequest, 'admit'> {
  readonly judge: AmbientJudge;
}

// The pins plus the `recentNeeded` newest rows `judge` keeps, for ambient injection, with each refusal in the order the
// rows were read. One connection; `recall` piggybacks the prompt-recall FTS query on it too. `origins` narrows the
// recent rows past the first window.
export function loadAmbientCandidatesAt(
  db: DatabaseSyncLike,
  tenantId: string,
  { recentNeeded, judge, recall, origins }: AmbientLoad,
): AmbientCandidates {
  const refused: AmbientRefusal[] = [];
  const admit = noting(judge, refused);
  // A SQL LIMIT takes an integer; the Array.slice this replaced truncated one,
  // and include_recent is any non-negative finite number at the HTTP edge.
  const needed = Math.trunc(recentNeeded);
  // SAFETY: every `where` below starts from MEMORY_SELECT_COLUMNS' table.
  const run: RunSql = (where, params) =>
    (db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${where}`).all(...params) as MemoryRow[]).map(
      rowToEntry,
    );

  const byId = new Map<string, MemoryEntry>();
  for (const e of run(AMBIENT_PINNED_WHERE, [tenantId])) {
    if (admit(e)) byId.set(e.id, e);
  }

  if (needed > 0) {
    const drifted = db.prepare(AMBIENT_DRIFT_SQL).get(tenantId) !== undefined;
    for (const e of loadRecentRows(run, drifted, tenantId, { needed, admit, origins })) byId.set(e.id, e);
  }

  // loadAllEntries' order: rankedPinned's comparator can tie and Array.sort
  // is stable, so input order is load-bearing downstream.
  const entries = [...byId.values()].sort((a, b) => {
    const byCreated = a.created.localeCompare(b.created);
    return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
  });
  if (!recall) return { entries, refused };
  const ftsQuery = pickRarestFtsQuery(db, recall.terms);
  const recallEntries = ftsQuery
    ? loadRecallEntriesAt(db, ftsQuery, {
        limit: recall.limit,
        tenantId,
        includeSuperseded: false,
        ownScope: recall.ownScope,
      })
    : [];
  return { entries, recall: recallEntries, refused };
}

// calculateStrength's decay exponent with its reward factor: the strongest rows, without scoring each one in JS. A
// function, not a constant, so the outcome-slow ablation is read per query as strengthSql reads it.
const decayExponentSql = (): string => `CASE WHEN half_life_days > 0 THEN (julianday(?) - julianday(last_retrieved))
    / (half_life_days * ${rewardFactorSql()}) END`;

const decayRankSql = (): string => `pinned DESC,
  ${decayExponentSql()} ASC NULLS LAST,
  id ASC`;

export interface ContextRowsWhere {
  where: string[];
  params: Array<string | number>;
}

/** The shared WHERE of a context read: live tenant rows, then `extra` predicates, then the scope and origin rules. */
export function contextRowsWhere(
  tenantId: string,
  filter: Pick<ContextCandidateFilter, 'exactScope' | 'ownScope' | 'project'>,
  extra: readonly string[] = [],
): ContextRowsWhere {
  const where = ['tenant_id = ?', `COALESCE(superseded_by, '') = ''`, ...extra];
  const params: Array<string | number> = [tenantId];
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

const RANK_COLUMNS = 'id, pinned, half_life_days, last_retrieved, outcome_positive, outcome_negative';

// The `cap` best of the pinned rows and the unpinned rows the v60 key puts within DECAY_KEY_HALF_LIVES; nothing unless
// every unpinned winner is within it too, since then each row left out has decayed further and the rank is the scan's.
function decayKeySubsetSql(whereSql: string): string {
  const arm = (extra: string): string => `SELECT ${RANK_COLUMNS} FROM memories WHERE ${whereSql} AND ${extra}`;
  // pinned is 0 or 1 (entry-row.ts), so the two arms hold every pinned row and every unpinned row with a key.
  return `WITH top AS MATERIALIZED (
      SELECT id, pinned, ${decayExponentSql()} AS d FROM (
        ${arm(`pinned = 1 AND ${DECAY_KEY_WHERE}`)}
        UNION ALL
        ${arm(`pinned = 0 AND half_life_days > 0 AND ${DECAY_KEY_WHERE} AND ${DECAY_KEY_SQL} >= julianday(?) - ?`)}
      ) ORDER BY pinned DESC, d ASC NULLS LAST, id ASC LIMIT ?
    )
    SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (SELECT id FROM top)
      AND (SELECT COUNT(*) FROM top) = ?
      AND NOT EXISTS (SELECT 1 FROM top WHERE pinned = 0 AND (d IS NULL OR d > ?))
    ORDER BY created ASC, id ASC`;
}

function decayKeySubsetRows(db: DatabaseSyncLike, rows: ContextRowsWhere, cap: number, now: string): MemoryRow[] {
  const whereSql = rows.where.join(' AND ');
  const bound = [now, ...rows.params, ...rows.params, now, DECAY_KEY_SLACK_DAYS, cap, cap, DECAY_KEY_HALF_LIVES];
  // SAFETY: the SELECT names exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  return db.prepare(decayKeySubsetSql(whereSql)).all(...bound) as MemoryRow[];
}

/** Live tenant rows passing `filter`, at most `filter.cap`, in loadAllEntries' order; below the cap, every such row. */
export function loadContextCandidatesAt(
  db: DatabaseSyncLike,
  tenantId: string,
  filter: ContextCandidateFilter,
): MemoryEntry[] {
  const rowsWhere = contextRowsWhere(tenantId, filter);
  const { params } = rowsWhere;
  const cap = Math.max(0, Math.trunc(filter.cap));
  const whereSql = rowsWhere.where.join(' AND ');
  const now = filter.now.toISOString();
  // Stops one row past the cap, so a large tenant is not walked to be counted.
  // SAFETY: the count row has the one column named.
  const matched = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM memories WHERE ${whereSql} LIMIT ?)`)
      .get(...params, cap + 1) as { n: number }
  ).n;
  // Under the cap every match is returned, so the per-row decay math and the sort are skipped.
  const ranked = matched > cap;
  // The key holds the unablated reward factor, so an ablated rank skips it. An empty answer means the subset could
  // not prove itself, and the scan below ranks the tenant.
  const bySubset = ranked && cap > 0 && !isOutcomeSlowAblated() ? decayKeySubsetRows(db, rowsWhere, cap, now) : [];
  if (bySubset.length > 0) return bySubset.map(rowToEntry);
  const sql = ranked
    ? `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (
    SELECT id FROM memories WHERE ${whereSql} ORDER BY ${decayRankSql()} LIMIT ?
  ) ORDER BY created ASC, id ASC`
    : `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${whereSql} ORDER BY created ASC, id ASC`;
  // SAFETY: both SELECTs name exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set; the rank sort carries
  // ids only.
  const rows = db.prepare(sql).all(...params, ...(ranked ? [now, cap] : [])) as MemoryRow[];
  return rows.map(rowToEntry);
}

// No owner: for session capture, a personal or connector-private row must never stop a team copy being written.
const TEAM_VISIBLE = scopeAdmitSql('');

/** Admits every scope, for a reader that sees the whole store, such as the CLI on its own machine. */
export const EVERY_SCOPE: SqlFragment = Object.freeze({ sql: '1', params: [] });

/** Tenant rows holding any of `words` that `admit` passes (default: team-visible); a row equal to a text apart from
 * spacing holds its every word. With `project`, only rows carrying one of those names plus user-global rows, as
 * loadContextCandidates' filter. */
export function loadTextsHoldingWordsAt(
  db: DatabaseSyncLike,
  tenantId: TenantId,
  words: readonly string[],
  project?: readonly string[],
  admit: SqlFragment = TEAM_VISIBLE,
): HeldText[] {
  const unique = [...new Set(words)];
  const out: HeldText[] = [];
  const tenant = tenantAnd(tenantId);
  const originWhere = project === undefined ? '' : ` AND (origin_project = '' OR ${originInSql(project)})`;
  // One instr() per word in an OR chain: ID_CHUNK terms stay under SQLite's 1000-level expression depth.
  for (const chunk of chunked(unique)) {
    // SAFETY: rows' shape matches the three columns named in the SELECT below.
    const rows = db
      .prepare(
        `SELECT content, source, origin_project FROM memories WHERE 1${tenant.sql}${originWhere} AND ` +
          `${admit.sql} AND (${chunk.map(() => 'instr(content, ?) ' + '> 0').join(' OR ')})`,
      )
      .all(...tenant.args, ...(project ?? []), ...admit.params, ...chunk) as Array<{
      content: string;
      source: string | null;
      origin_project: string | null;
    }>;
    for (const row of rows) {
      out.push({ content: row.content, source: row.source ?? 'cli', originProject: row.origin_project });
    }
  }
  return out;
}

/** A tenant's `limit` newest rows, oldest first: the tail of loadAllEntries' order, without reading the rows before
 * it. */
export function newestEntriesAt(db: DatabaseSyncLike, tenantId: string, limit: number): MemoryEntry[] {
  // SAFETY: the SELECT names exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = db
    .prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE tenant_id = ? ORDER BY created DESC, id DESC LIMIT ?`)
    .all(tenantId, limit) as MemoryRow[];
  return rows.reverse().map(rowToEntry);
}

function* contentsOf(rows: Iterable<{ content: string }>): Generator<string> {
  for (const row of rows) yield row.content;
}

/** How many of a tenant's newest rows schemaFitAt reads; older rows no longer move the fit. */
const SCHEMA_FIT_WINDOW_ROWS = 2000;

/** computeSchemaFit against a tenant's newest SCHEMA_FIT_WINDOW_ROWS rows: tag counts come from one aggregate
 * and texts stream one column, so no row is loaded. */
export function schemaFitAt(db: DatabaseSyncLike, tenantId: string, content: string, tags: readonly string[]): number {
  const newest = 'SELECT tags_json, content FROM memories WHERE tenant_id = ? ORDER BY created DESC, id DESC LIMIT ?';
  // One read transaction, so the row count and the texts come from the same snapshot.
  return withReadSnapshot(db, () => {
    // SAFETY: rows' shape matches the two columns named in the SELECT.
    const groups = db
      .prepare(`SELECT tags_json, COUNT(*) AS n FROM (${newest}) GROUP BY tags_json`)
      .all(tenantId, SCHEMA_FIT_WINDOW_ROWS) as Array<{ tags_json: string | null; n: number }>;
    let rows = 0;
    const tagCounts = new Map<string, number>();
    for (const group of groups) {
      rows += group.n;
      for (const tag of parseJsonArray(group.tags_json)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + group.n);
    }
    // SHORTCUT: only the newest SCHEMA_FIT_WINDOW_ROWS rows count, so older tags drop out;
    // a stored per-tenant tag and token tally is the upgrade.
    // SAFETY: the SELECT names exactly the one column read.
    const texts = db.prepare(`SELECT content FROM (${newest})`).iterate(tenantId, SCHEMA_FIT_WINDOW_ROWS) as Iterable<{
      content: string;
    }>;
    return schemaFitFrom(content, tags, { rows, tagCounts, contents: contentsOf(texts) });
  });
}

/** Row count and newest `created` per source, for peer listings that need no row. */
export function tallySourcesAt(db: DatabaseSyncLike, tenantId: TenantId): SourceTally[] {
  const tenant = tenantAnd(tenantId);
  // SAFETY: rows' shape matches the four aliased columns in the SELECT below.
  return db
    .prepare(
      `SELECT COALESCE(source, 'cli') AS source, COUNT(*) AS count, MAX(created) AS latest, MIN(created || ` +
        `char(31) || id) AS first
     FROM memories WHERE 1${tenant.sql} GROUP BY COALESCE(source, 'cli')`,
    )
    .all(...tenant.args) as SourceTally[];
}

// A malformed or non-array JSON list reads as empty, as parseJsonArray does, instead of failing json_each.
export const jsonList = (column: string): string =>
  `(CASE WHEN json_valid(${column}) AND json_type(${column}) = 'array' THEN ${column} ELSE '[]' END)`;

/** calculateStrength over every row of a tenant in one aggregate pass, no row loaded, on a handle the caller holds so
 * it can share a snapshot with other reads. */
export function strengthTalliesAt(
  db: DatabaseSyncLike,
  rules: LossAversion,
  tenantId: string,
  now: Date,
  atRiskBelow: number,
): StrengthTallies {
  // An unparseable date scores NULL in SQL and 0 in calculateStrength.
  const strength = `COALESCE(${strengthSql(now, rules)}, 0)`;
  // SAFETY: one aggregate row whose columns are the aliases named below.
  const row = db
    .prepare(
      `SELECT
      COUNT(*) AS total,
      COALESCE(SUM(pinned != 0), 0) AS pinned,
      COALESCE(SUM(EXISTS (SELECT 1 FROM json_each(${jsonList('tags_json')}) WHERE value = 'error')), 0) AS errors,
      COALESCE(SUM(${strength}), 0) AS strengthSum,
      COALESCE(SUM(COALESCE(pinned, 0) = 0 AND ${strength} < ?), 0) AS atRisk
      FROM memories WHERE tenant_id = ?`,
    )
    .get(atRiskBelow, tenantId) as Record<keyof StrengthTallies, number | bigint>;
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

// Scored in JavaScript, not with strengthSql: SQLite reads fewer date shapes than Date does, so its counts would
// differ.
function tallyStatusRows(
  rows: Iterable<StatusRow>,
  now: Date,
  atRiskBelow: number,
  rules: LossAversion,
): Omit<StatusCounts, 'openConflicts' | 'embedded'> {
  const byLayer = { [Layer.Buffer]: 0, [Layer.Episodic]: 0, [Layer.Semantic]: 0, [Layer.Trace]: 0 };
  const byConfidence = { verified: 0, observed: 0, inferred: 0, stale: 0 };
  const sums = { total: 0, strength: 0, pinned: 0, atRisk: 0, agedOut: 0 };
  for (const row of rows) {
    // rowToEntry's defaults for these columns, so a row scores as its loaded entry would.
    const entry = {
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
    const strength = calculateStrength(entry, now, rules);
    const facets = confidenceFacets(entry, now);
    sums.total++;
    sums.strength += strength;
    byLayer[row.layer] = (byLayer[row.layer] ?? 0) + 1;
    byConfidence[facets.tier] = (byConfidence[facets.tier] ?? 0) + 1;
    if (entry.pinned) sums.pinned++;
    if (strength < atRiskBelow) sums.atRisk++;
    if (facets.agedOut) sums.agedOut++;
  }
  const { total, pinned, atRisk, agedOut } = sums;
  return { total, byLayer, byConfidence, pinned, atRisk, agedOut, avgStrength: total > 0 ? sums.strength / total : 0 };
}

/** The counts `hippo status` prints, from one pass over ten narrow columns: no text is read and no row array is
 * built. */
export function statusCountsAt(
  db: DatabaseSyncLike,
  rules: LossAversion,
  now: Date,
  atRiskBelow: number,
): StatusCounts {
  // One read transaction, so the row tallies and the two counts describe the same store.
  return withReadSnapshot(db, () => {
    // loadAllEntries' order, so the strengths add up in the order they did and the average rounds the same.
    // SAFETY: the SELECT names exactly StatusRow's columns, and the store writes `layer` only from the Layer enum.
    const rows = db
      .prepare(`SELECT ${STATUS_ROW_COLUMNS.join(', ')} FROM memories ORDER BY created ASC, id ASC`)
      .iterate() as Iterable<StatusRow>;
    const tallies = tallyStatusRows(rows, now, atRiskBelow, rules);
    // SAFETY: one row whose columns are the two aliases named below.
    const counts = db
      .prepare(`SELECT
      (SELECT COUNT(*) FROM memory_conflicts WHERE status = 'open') AS openConflicts,
      (SELECT COUNT(*) FROM memory_vectors WHERE memory_id IN (SELECT id FROM memories)) AS embedded`)
      .get() as Record<'openConflicts' | 'embedded', number | bigint>;
    return { ...tallies, openConflicts: Number(counts.openConflicts), embedded: Number(counts.embedded) };
  });
}
