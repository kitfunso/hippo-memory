import {
  type MemoryEntry,
  FALLBACK_HALF_LIFE_DAYS,
  Layer,
  calculateStrength,
  confidenceFacets,
  schemaFitFrom,
  type LossAversion,
} from '../../base/memory/memory.js';
import { strengthSql } from './rule-sql.js';
import { isOutcomeSlowAblated } from '../../base/memory/ablation.js';
import { DECAY_KEY_HALF_LIVES, DECAY_KEY_SLACK_DAYS, DECAY_KEY_SQL, DECAY_KEY_WHERE } from '../../db/decay-key.js';
import { type DatabaseSyncLike, isFtsAvailable, isFtsInSync, withReadSnapshot } from '../../db/index.js';
import { sortableStamp } from '../../base/memory/created-stamp.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { originInSql, rewardFactorSql, scopeAdmitSql } from './rule-sql.js';
import type { SqlFragment } from '../../db/sql.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry, parseJsonArray } from './rows.js';
import { pickRarestFtsQuery, loadRecallEntries } from './search-rows.js';
import type { HeldText } from '../port/types.js';
import type { TenantId } from '../../base/util/tenant.js';
import { tenantAnd } from './tenant.js';
import { holdingPhrase, IN_PHRASE_HITS, TENANT_IS } from './entry-reads.js';
import { chunked } from '../../base/util/chunked.js';
import { READ_PAGE_ROWS, rowsInPages } from '../../base/util/pages.js';
import { ENTRY_PAGE_ORDER, entryPage } from './keyset.js';
import type { EntryCursor } from '../port/types.js';
import type { AmbientRefusalReason } from '../../base/scope/read-admission.js';
import type {
  AmbientCandidateRequest,
  AmbientCandidates,
  AmbientRefusal,
  ContextCandidateFilter,
  RecentOrigins,
} from '../port/context-reads.js';
import type { SourceTally } from '../port/sharing.js';
import type { StatusCounts, StrengthTallies } from '../port/reports.js';

const AMBIENT_SCOPED = 'superseded_by IS NULL AND tenant_id = ?';
const AMBIENT_PINNED = 'pinned = 1 AND superseded_by IS NULL';
/** A stamp whose text does not sort by time; idx_memories_created_drift (migration v51) holds the live ones. */
const CREATED_DRIFTED = "(length(created) <> 24 OR created NOT LIKE '%Z')";

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

// `id DESC` mirrors contextGet's comparator, not loadFreshRawMemories' cross-ingest-stable order: that would change
// what the hook injects.
const NEWEST = 'ORDER BY created DESC, id DESC';
const AFTER = 'AND created <= ? AND (created < ? OR id < ?) ';

/** Where a row sorts in a recent read: the instant its `created` names, then its id. */
interface Position {
  readonly at: string;
  readonly id: string;
}

/** Up to `limit` live rows `own` admits, newest first, after `after`. */
type ReadNewest = (own: SqlFragment, limit: number, after?: Position) => MemoryEntry[];

// As contextGet sorts a row: a drifted stamp at the instant Date reads in it.
const positionOf = (e: MemoryEntry): Position => ({ at: sortableStamp(e.created), id: e.id });

const newestFirst = (a: Position, b: Position): number =>
  a.at !== b.at ? (a.at < b.at ? 1 : -1) : a.id === b.id ? 0 : a.id < b.id ? 1 : -1;

const afterParams = (after: Position | undefined): string[] => (after ? [after.at, after.at, after.id] : []);

/** Reads in `created` text order, which is time order while every live row of the tenant holds toISOString text. */
function readByText(run: RunSql): ReadNewest {
  return (own, limit, after) =>
    run(`${own.sql} ${after ? AFTER : ''}${NEWEST} LIMIT ?`, [...own.params, ...afterParams(after), limit]);
}

/** Every live drifted row `own` admits, newest first; the drift index holds only these, so it is no tenant scan. */
function newestDrifted(run: RunSql, own: SqlFragment): MemoryEntry[] {
  return run(`${own.sql} AND ${CREATED_DRIFTED}`, [...own.params])
    .map((entry) => ({ entry, at: positionOf(entry) }))
    .sort((a, b) => newestFirst(a.at, b.at))
    .map(({ entry }) => entry);
}

/** The text-ordered rows merged with the drifted ones by instant: the rows and order a store whose stamps were all
 * written in toISOString form would read. */
function readByInstant(run: RunSql, drifted: Map<string, MemoryEntry[]>): ReadNewest {
  return (own, limit, after) => {
    let odd = drifted.get(own.sql);
    if (!odd) drifted.set(own.sql, (odd = newestDrifted(run, own)));
    const text = run(`${own.sql} AND NOT ${CREATED_DRIFTED} ${after ? AFTER : ''}${NEWEST} LIMIT ?`, [
      ...own.params,
      ...afterParams(after),
      limit,
    ]);
    const older = after ? odd.filter((e) => newestFirst(positionOf(e), after) > 0) : odd;
    return [...text, ...older]
      .map((entry) => ({ entry, at: positionOf(entry) }))
      .sort((a, b) => newestFirst(a.at, b.at))
      .slice(0, limit)
      .map(({ entry }) => entry);
  };
}

// The newest rows `admit` keeps, newest first. The first window stays unfiltered so admit still sees, and the delivery
// ledger still counts, the other-project rows it refuses; past it, the reads narrow to the caller's origins.
function loadRecentRows(read: ReadNewest, tenantId: string, options: RecentRowsOptions): MemoryEntry[] {
  const { needed, admit, origins } = options;
  const keep = origins ? (e: MemoryEntry): boolean => admit(e) && inOrigins(e, origins) : admit;
  const window = Math.max(needed * 4, 32);
  const originSql =
    origins &&
    (origins.userGlobal ? `(origin_project = '' OR ${originInSql(origins.names)})` : originInSql(origins.names));
  const own: SqlFragment = {
    sql: originSql ? `${AMBIENT_SCOPED} AND ${originSql}` : AMBIENT_SCOPED,
    params: [tenantId, ...(origins?.names ?? [])],
  };
  let rows = read({ sql: AMBIENT_SCOPED, params: [tenantId] }, window);
  let kept = rows.filter(keep);
  if (kept.length >= needed || rows.length < window) return kept;
  if (origins) {
    rows = read(own, window);
    kept = rows.filter(keep);
    if (kept.length >= needed || rows.length < window) return kept;
  }
  return [...kept, ...keptPastWindow(read, own, rows, needed - kept.length, keep)];
}

// A window of refused rows can hide older ones, so read on in keyset pages, each four times the last, until enough are
// kept.
function keptPastWindow(
  read: ReadNewest,
  own: SqlFragment,
  rows: readonly MemoryEntry[],
  wanted: number,
  keep: (e: MemoryEntry) => boolean,
): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  let last = rows[rows.length - 1];
  for (let size = rows.length * 4; out.length < wanted; size *= 4) {
    const page = read(own, size, positionOf(last));
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

// Every pin, a keyset page at a time: a cap would drop pins without notice.
function pinnedEntries(db: DatabaseSyncLike, tenantId: TenantId): Generator<MemoryEntry> {
  return rowsInPages((after?: EntryCursor) => {
    const { rows, next } = entryPage(
      tenantId,
      { limit: READ_PAGE_ROWS, after },
      (within, limit) =>
        cachedStatement(
          db,
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${within.match(AMBIENT_PINNED)} ${ENTRY_PAGE_ORDER}`,
        ).all(...within.params, limit) as MemoryRow[],
    );
    return { entries: rows.map(rowToEntry), next };
  });
}

// The pins plus the `recentNeeded` newest rows `judge` keeps, for ambient injection, with each refusal in the order the
// rows were read. One connection; `recall` piggybacks the prompt-recall FTS query on it too. `origins` narrows the
// recent rows past the first window.
export function loadAmbientCandidates(
  db: DatabaseSyncLike,
  tenantId: string,
  { recentNeeded, judge, recall, origins }: AmbientLoad,
): AmbientCandidates {
  const refused: AmbientRefusal[] = [];
  const admit = noting(judge, refused);
  // A SQL LIMIT takes an integer; the Array.slice this replaced truncated one, and include_recent is any non-negative
  // finite number at the HTTP edge.
  const needed = Math.trunc(recentNeeded);
  const run: RunSql = (where, params) =>
    (
      cachedStatement(db, `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${where}`).all(...params) as MemoryRow[]
    ).map(rowToEntry);

  const byId = new Map<string, MemoryEntry>();
  for (const e of pinnedEntries(db, tenantId)) {
    if (admit(e)) byId.set(e.id, e);
  }

  if (needed > 0) {
    const drifted = newestDrifted(run, { sql: AMBIENT_SCOPED, params: [tenantId] });
    const read = drifted.length === 0 ? readByText(run) : readByInstant(run, new Map([[AMBIENT_SCOPED, drifted]]));
    for (const e of loadRecentRows(read, tenantId, { needed, admit, origins })) byId.set(e.id, e);
  }

  // loadAllEntries' order: rankedPinned's comparator can tie and Array.sort is stable, so input order is load-bearing
  // downstream.
  const entries = [...byId.values()].sort((a, b) => {
    const byCreated = a.created.localeCompare(b.created);
    return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
  });
  if (!recall) return { entries, refused };
  const ftsQuery = pickRarestFtsQuery(db, recall.terms);
  const recallEntries = ftsQuery
    ? loadRecallEntries(db, ftsQuery, {
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

/** The shared WHERE of a context read: live tenant rows, then `extra` predicates, then the scope and origin rules. */
export function contextRowsWhere(
  tenantId: string,
  filter: Pick<ContextCandidateFilter, 'exactScope' | 'ownScope' | 'project'>,
  extra: readonly string[] = [],
): SqlFragment {
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
  return { sql: where.join(' AND '), params };
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

function decayKeySubsetRows(db: DatabaseSyncLike, rows: SqlFragment, cap: number, now: string): MemoryRow[] {
  const whereSql = rows.sql;
  const bound = [now, ...rows.params, ...rows.params, now, DECAY_KEY_SLACK_DAYS, cap, cap, DECAY_KEY_HALF_LIVES];
  return cachedStatement(db, decayKeySubsetSql(whereSql)).all(...bound) as MemoryRow[];
}

/** Live tenant rows passing `filter`, at most `filter.cap`, in loadAllEntries' order; below the cap, every such row. */
export function loadContextCandidates(
  db: DatabaseSyncLike,
  tenantId: string,
  filter: ContextCandidateFilter,
): MemoryEntry[] {
  const rowsWhere = contextRowsWhere(tenantId, filter);
  const { params } = rowsWhere;
  const cap = Math.max(0, Math.trunc(filter.cap));
  const whereSql = rowsWhere.sql;
  const now = filter.now.toISOString();
  // Stops one row past the cap, so a large tenant is not walked to be counted.
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  const matched = (
    cachedStatement(db, `SELECT COUNT(*) AS n FROM (SELECT 1 FROM memories WHERE ${whereSql} LIMIT ?)`).get(
      ...params,
      cap + 1,
    ) as { n: number }
  ).n;
  // Under the cap every match is returned, so the per-row decay math and the sort are skipped.
  const ranked = matched > cap;
  // The key holds the unablated reward factor, so an ablated rank skips it. An empty answer means the subset could not
  // prove itself, and the scan below ranks the tenant.
  const bySubset = ranked && cap > 0 && !isOutcomeSlowAblated() ? decayKeySubsetRows(db, rowsWhere, cap, now) : [];
  if (bySubset.length > 0) return bySubset.map(rowToEntry);
  const sql = ranked
    ? `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (
    SELECT id FROM memories WHERE ${whereSql} ORDER BY ${decayRankSql()} LIMIT ?
  ) ORDER BY created ASC, id ASC`
    : `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${whereSql} ORDER BY created ASC, id ASC`;
  const rows = cachedStatement(db, sql).all(...params, ...(ranked ? [now, cap] : [])) as MemoryRow[];
  return rows.map(rowToEntry);
}

// No owner: for session capture, a personal or connector-private row must never stop a team copy being written.
const TEAM_VISIBLE = scopeAdmitSql('');

interface HeldRowsFilter {
  readonly tenantId: TenantId;
  readonly project: readonly string[] | undefined;
  readonly admit: SqlFragment;
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
type HeldTextDbRow = { id: string; content: string; source: string | null; origin_project: string | null };

/** Rows holding a word of `words`; with `phrases`, only the index's hits for them, so rows without one are never
 * read. */
function heldRows(
  db: DatabaseSyncLike,
  filter: HeldRowsFilter,
  words: readonly string[],
  phrases?: readonly string[],
): HeldTextDbRow[] {
  const tenant = tenantAnd(filter.tenantId, phrases ? TENANT_IS : 'tenant_id = ?');
  const { project, admit } = filter;
  const originWhere = project === undefined ? '' : ` AND (origin_project = '' OR ${originInSql(project)})`;
  // One JSON list of words, so the text, and the statement cached for it, stay the same at every chunk length.
  const holds = 'EXISTS (SELECT 1 FROM json_each(?) WHERE instr(content, value) > 0)';
  return cachedStatement(
    db,
    `SELECT id, content, source, origin_project FROM memories WHERE ${phrases ? IN_PHRASE_HITS : '1'}${tenant.sql}` +
      `${originWhere} AND ${admit.sql} AND (${holds})`,
  ).all(
    ...(phrases ? [phrases.join(' OR ')] : []),
    ...tenant.params,
    ...(project ?? []),
    ...admit.params,
    JSON.stringify(words),
  ) as HeldTextDbRow[];
}

/** Tenant rows holding any of `words` that `admit` passes (default: team-visible); a row equal to a text apart from
 * spacing holds its every word. With `project`, only rows carrying one of those names plus user-global rows, as
 * loadContextCandidates' filter. A row holds a word it has whole between spaces as one of the index's phrase hits, so
 * when the index is in sync it answers for each word it can name. */
export function loadTextsHoldingWords(
  db: DatabaseSyncLike,
  tenantId: TenantId,
  words: readonly string[],
  project?: readonly string[],
  admit: SqlFragment = TEAM_VISIBLE,
): HeldText[] {
  const filter: HeldRowsFilter = { tenantId, project, admit };
  const indexed = isFtsAvailable(db) && isFtsInSync(db);
  const phraseOf = new Map([...new Set(words)].map((w) => [w, indexed ? holdingPhrase(w) : null]));
  const named = [...phraseOf].filter(([, phrase]) => phrase !== null).map(([w]) => w);
  const unnamed = [...phraseOf].filter(([, phrase]) => phrase === null).map(([w]) => w);
  const byId = new Map<string, HeldText>();
  const keep = (row: HeldTextDbRow) =>
    byId.set(row.id, { content: row.content, source: row.source ?? 'cli', originProject: row.origin_project });
  for (const chunk of chunked(named)) {
    heldRows(
      db,
      filter,
      chunk,
      chunk.map((w) => phraseOf.get(w)!),
    ).forEach(keep);
  }
  for (const chunk of chunked(unnamed)) heldRows(db, filter, chunk).forEach(keep);
  return [...byId.values()];
}

/**
 * A tenant's `limit` newest rows, oldest first: the tail of loadAllEntries' order, without reading the rows before it.
 */
export function newestEntries(db: DatabaseSyncLike, tenantId: string, limit: number): MemoryEntry[] {
  const rows = cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE tenant_id = ? ORDER BY created DESC, id DESC LIMIT ?`,
  ).all(tenantId, limit) as MemoryRow[];
  return rows.reverse().map(rowToEntry);
}

function* contentsOf(rows: Iterable<{ content: string }>): Generator<string> {
  for (const row of rows) yield row.content;
}

/** How many of a tenant's newest rows schemaFit reads; older rows no longer move the fit. */
const SCHEMA_FIT_WINDOW_ROWS = 2000;

/** computeSchemaFit against a tenant's newest SCHEMA_FIT_WINDOW_ROWS rows: tag counts come from one aggregate and texts
 * stream one column, so no row is loaded. */
export function schemaFit(db: DatabaseSyncLike, tenantId: string, content: string, tags: readonly string[]): number {
  const newest = 'SELECT tags_json, content FROM memories WHERE tenant_id = ? ORDER BY created DESC, id DESC LIMIT ?';
  // One read transaction, so the row count and the texts come from the same snapshot.
  return withReadSnapshot(db, () => {
    const groups = cachedStatement(db, `SELECT tags_json, COUNT(*) AS n FROM (${newest}) GROUP BY tags_json`).all(
      tenantId,
      SCHEMA_FIT_WINDOW_ROWS,
    ) as Array<{ tags_json: string | null; n: number }>;
    let rows = 0;
    const tagCounts = new Map<string, number>();
    for (const group of groups) {
      rows += group.n;
      for (const tag of parseJsonArray(group.tags_json)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + group.n);
    }
    // SHORTCUT: only the newest SCHEMA_FIT_WINDOW_ROWS rows count, so older tags drop out; a stored per-tenant tag and
    // token tally is the upgrade.
    const texts = cachedStatement(db, `SELECT content FROM (${newest})`).iterate(
      tenantId,
      SCHEMA_FIT_WINDOW_ROWS,
    ) as Iterable<{
      content: string;
    }>;
    return schemaFitFrom(content, tags, { rows, tagCounts, contents: contentsOf(texts) });
  });
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

// A malformed or non-array JSON list reads as empty, as parseJsonArray does, instead of failing json_each.
export const jsonList = (column: string): string =>
  `(CASE WHEN json_valid(${column}) AND json_type(${column}) = 'array' THEN ${column} ELSE '[]' END)`;

/** calculateStrength over every row of a tenant in one aggregate pass, no row loaded, on a handle the caller holds so
 * it can share a snapshot with other reads. */
export function strengthTallies(
  db: DatabaseSyncLike,
  rules: LossAversion,
  tenantId: string,
  now: Date,
  atRiskBelow: number,
): StrengthTallies {
  // An unparseable date scores NULL in SQL and 0 in calculateStrength.
  const bound = strengthSql(now, rules);
  const strength = `COALESCE(${bound.sql}, 0)`;
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  const row = cachedStatement(
    db,
    `SELECT
      COUNT(*) AS total,
      COALESCE(SUM(pinned != 0), 0) AS pinned,
      COALESCE(SUM(EXISTS (SELECT 1 FROM json_each(${jsonList('tags_json')}) WHERE value = 'error')), 0) AS errors,
      COALESCE(SUM(${strength}), 0) AS strengthSum,
      COALESCE(SUM(COALESCE(pinned, 0) = 0 AND ${strength} < ?), 0) AS atRisk
      FROM memories WHERE tenant_id = ?`,
  ).get(...bound.params, ...bound.params, atRiskBelow, tenantId) as Record<keyof StrengthTallies, number | bigint>;
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
// SAFETY: every read cast to this row selects STATUS_ROW_COLUMNS; scripts/check-row-casts.mjs proves it.
// The store writes `layer` only from the Layer enum.
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

/**
 * The counts `hippo status` prints, from one pass over ten narrow columns: no text is read and no row array is built.
 */
export function statusCounts(db: DatabaseSyncLike, rules: LossAversion, now: Date, atRiskBelow: number): StatusCounts {
  // One read transaction, so the row tallies and the two counts describe the same store.
  return withReadSnapshot(db, () => {
    // loadAllEntries' order, so the strengths add up in the order they did and the average rounds the same.
    const rows = cachedStatement(
      db,
      `SELECT ${STATUS_ROW_COLUMNS.join(', ')} FROM memories ORDER BY created ASC, id ASC`,
    ).iterate() as Iterable<StatusRow>;
    const tallies = tallyStatusRows(rows, now, atRiskBelow, rules);
    // SAFETY: scalar subqueries with no FROM always answer one row.
    const counts = cachedStatement(
      db,
      `SELECT
      (SELECT COUNT(*) FROM memory_conflicts WHERE status = 'open') AS openConflicts,
      (SELECT COUNT(*) FROM memory_vectors WHERE memory_id IN (SELECT id FROM memories)) AS embedded`,
    ).get() as Record<'openConflicts' | 'embedded', number | bigint>;
    return { ...tallies, openConflicts: Number(counts.openConflicts), embedded: Number(counts.embedded) };
  });
}
