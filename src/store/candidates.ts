import { type MemoryEntry, type ConfidenceLevel, FALLBACK_HALF_LIFE_DAYS, Layer, calculateStrength, facetsOf, schemaFitFrom } from '../core/memory.js';
import { strengthSql } from './rule-sql.js';
import { withReadSnapshot } from '../db/index.js';
import { scopeAdmitSql, type SqlFragment } from './recall-scope.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry, parseJsonArray } from './rows.js';
import { onHandle, openStore } from './open.js';
import { originInSql } from '../core/project-identity.js';
import { pickRarestFtsQuery, loadRecallSearchEntriesFromDb } from './search-rows.js';

export interface AmbientRecallRequest {
  terms: string[];
  limit: number;
  ownScope?: string;
}

export interface AmbientLoadResult {
  entries: MemoryEntry[];
  recall?: MemoryEntry[];
}

const AMBIENT_SCOPED = 'superseded_by IS NULL AND tenant_id = ?';
/** idx_memories_pinned (migration v51) serves it. */
const AMBIENT_PINNED_WHERE = `pinned = 1 AND ${AMBIENT_SCOPED} ORDER BY created ASC, id ASC`;
/** idx_memories_created_drift (migration v51) serves it. */
const AMBIENT_DRIFT_SQL =
  `SELECT 1 FROM memories WHERE ${AMBIENT_SCOPED} AND (length(created) <> 24 OR created NOT LIKE '%Z') LIMIT 1`;

/** The origins a caller's recent rows may carry: its project names, and user-global ('') rows when `userGlobal`. */
export interface RecentOrigins {
  readonly names: readonly string[];
  readonly userGlobal: boolean;
}

type RunSql = (where: string, params: Array<string | number>) => MemoryEntry[];

function inOrigins(e: MemoryEntry, origins: RecentOrigins): boolean {
  const origin = e.origin_project ?? null;
  return origin === '' ? origins.userGlobal : origin !== null && origins.names.includes(origin);
}

interface RecentRowsOptions {
  readonly needed: number;
  readonly admit: (e: MemoryEntry) => boolean;
  readonly origins?: RecentOrigins;
}

// `id DESC` mirrors getContext's comparator, not loadFreshRawMemories'
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
  const originSql = origins && (origins.userGlobal ? `(origin_project = '' OR ${originInSql(origins.names)})` : originInSql(origins.names));
  const own: OwnRows = { where: originSql ? `${AMBIENT_SCOPED} AND ${originSql}` : AMBIENT_SCOPED, params: [tenantId, ...(origins?.names ?? [])] };
  // Text order is chronological only for standard UTC ISO (memory.ts), so a drifted store is read whole and re-sorted downstream.
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

// A window of refused rows can hide older ones, so read on in keyset pages, each four times the last, until enough are kept.
function keptPastWindow(run: RunSql, own: OwnRows, read: readonly MemoryEntry[], wanted: number, keep: (e: MemoryEntry) => boolean): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  let last = read[read.length - 1];
  for (let size = read.length * 4; out.length < wanted; size *= 4) {
    const page = run(`${own.where} AND created <= ? AND (created < ? OR id < ?) ${NEWEST} LIMIT ?`, [...own.params, last.created, last.created, last.id, size]);
    out.push(...page.filter(keep));
    if (page.length < size) break;
    last = page[page.length - 1];
  }
  return out;
}

// The pins plus the `recentNeeded` newest rows that pass `admit`, for ambient injection. One connection;
// `recall` piggybacks the prompt-recall FTS query on it too. `origins` narrows the recent rows past the first window.
export function loadAmbientCandidates(
  hippoRoot: string,
  tenantId: string,
  recentNeeded: number,
  admit: (e: MemoryEntry) => boolean,
  recall?: AmbientRecallRequest,
  origins?: RecentOrigins,
): AmbientLoadResult {
  // A SQL LIMIT takes an integer; the Array.slice this replaced truncated one,
  // and include_recent is any non-negative finite number at the HTTP edge.
  const needed = Math.trunc(recentNeeded);
  return onHandle(hippoRoot, (db) => {
    // SAFETY: every `where` below starts from MEMORY_SELECT_COLUMNS' table.
    const run: RunSql = (where, params) =>
      (db.prepare(
        `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${where}`,
      ).all(...params) as MemoryRow[]).map(rowToEntry);

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
    if (!recall) return { entries };
    const ftsQuery = pickRarestFtsQuery(db, recall.terms);
    const recallEntries = ftsQuery
      ? loadRecallSearchEntriesFromDb(db, ftsQuery, { limit: recall.limit, tenantId, includeSuperseded: false, ownScope: recall.ownScope })
      : [];
    return { entries, recall: recallEntries };
  }, openStore);
}

/** The rows a non-pinned context read may admit; each predicate is one getContext's admission applies again in JS. */
export interface ContextCandidateFilter {
  /** Envelope scope asked for by name; absent applies recall's default deny. */
  exactScope?: string;
  /** The caller's personal scope, which the default deny admits. */
  ownScope?: string;
  /** Rows carrying one of these project names, and user-global rows, pass; absent admits every origin. */
  project?: readonly string[];
  /** Most rows returned; past it, the rows decay has worn least win. */
  cap: number;
  now: Date;
}

// calculateStrength's decay exponent with its reward factor, pins first: the strongest rows, without scoring each one in JS.
const DECAY_RANK_SQL = `pinned DESC,
  CASE WHEN half_life_days > 0 THEN (julianday(?) - julianday(last_retrieved))
    / (half_life_days * (1.0 + 0.5 * (COALESCE(outcome_positive, 0) - COALESCE(outcome_negative, 0))
      / (COALESCE(outcome_positive, 0) + COALESCE(outcome_negative, 0) + 1.0))) END ASC NULLS LAST,
  id ASC`;

/** Live tenant rows passing `filter`, at most `filter.cap`, in loadAllEntries' order; below the cap, every such row. */
export function loadContextCandidates(hippoRoot: string, tenantId: string, filter: ContextCandidateFilter): MemoryEntry[] {
  const where = ['tenant_id = ?', `COALESCE(superseded_by, '') = ''`];
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
  return onHandle(hippoRoot, (db) => {
    // SAFETY: the outer SELECT names exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set; the rank sort carries ids only.
    const rows = db.prepare(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (
        SELECT id FROM memories WHERE ${where.join(' AND ')} ORDER BY ${DECAY_RANK_SQL} LIMIT ?
      ) ORDER BY created ASC, id ASC`,
    ).all(...params, filter.now.toISOString(), Math.max(0, Math.trunc(filter.cap))) as MemoryRow[];
    return rows.map(rowToEntry);
  }, openStore);
}

export type HeldText = Pick<MemoryEntry, 'content' | 'source' | 'origin_project'>;

// No owner: for session capture, a personal or connector-private row must never stop a team copy being written.
const TEAM_VISIBLE = scopeAdmitSql('');

/** Admits every scope, for a reader that sees the whole store, such as the CLI on its own machine. */
export const EVERY_SCOPE: SqlFragment = Object.freeze({ sql: '1', params: [] });

/** Tenant rows holding any of `words` that `admit` passes (default: team-visible); a row equal to a text apart from spacing holds its every word.
 * With `project`, only rows carrying one of those names plus user-global rows, as loadContextCandidates' filter. No `tenantId` reads every tenant. */
export function loadTextsHoldingWords(
  hippoRoot: string, tenantId: string | undefined, words: readonly string[], project?: readonly string[], admit: SqlFragment = TEAM_VISIBLE,
): HeldText[] {
  const unique = [...new Set(words)];
  const out: HeldText[] = [];
  const tenantWhere = tenantId === undefined ? '1' : 'tenant_id = ?';
  const tenantParams = tenantId === undefined ? [] : [tenantId];
  const originWhere = project === undefined ? '' : ` AND (origin_project = '' OR ${originInSql(project)})`;
  return onHandle(hippoRoot, (db) => {
    // Chunked so one statement stays far under SQLite's bound-parameter limit.
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      // SAFETY: rows' shape matches the three columns named in the SELECT below.
      const rows = db.prepare(
        `SELECT content, source, origin_project FROM memories WHERE ${tenantWhere}${originWhere} AND ${admit.sql} AND (${chunk.map(() => 'instr(content, ?) ' +
          '> 0').join(' OR ')})`,
      ).all(...tenantParams, ...(project ?? []), ...admit.params, ...chunk) as Array<{ content: string; source: string | null; origin_project: string | null }>;
      for (const row of rows) out.push({ content: row.content, source: row.source ?? 'cli', origin_project: row.origin_project });
    }
    return out;
  }, openStore);
}

/** A tenant's `limit` newest rows, oldest first: the tail of loadAllEntries' order, without reading the rows before it. */
export function loadNewestEntries(hippoRoot: string, tenantId: string, limit: number): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => {
    // SAFETY: the SELECT names exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
    const rows = db.prepare(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE tenant_id = ? ORDER BY created DESC, id DESC LIMIT ?`,
    ).all(tenantId, limit) as MemoryRow[];
    return rows.reverse().map(rowToEntry);
  }, openStore);
}

function* contentsOf(rows: Iterable<{ content: string }>): Generator<string> {
  for (const row of rows) yield row.content;
}

/** How many of a tenant's newest rows schemaFitInStore reads; older rows no longer move the fit. */
const SCHEMA_FIT_WINDOW_ROWS = 2000;

/** computeSchemaFit against a tenant's newest SCHEMA_FIT_WINDOW_ROWS rows: tag counts come from one aggregate
 * and texts stream one column, so no row is loaded. */
export function schemaFitInStore(hippoRoot: string, tenantId: string, content: string, tags: readonly string[]): number {
  const newest = 'SELECT tags_json, content FROM memories WHERE tenant_id = ? ORDER BY created DESC, id DESC LIMIT ?';
  return onHandle(hippoRoot, (db) => {
    // One read transaction, so the row count and the texts come from the same snapshot.
    return withReadSnapshot(db, () => {
      // SAFETY: rows' shape matches the two columns named in the SELECT.
      const groups = db.prepare(
        `SELECT tags_json, COUNT(*) AS n FROM (${newest}) GROUP BY tags_json`,
      ).all(tenantId, SCHEMA_FIT_WINDOW_ROWS) as Array<{ tags_json: string | null; n: number }>;
      let rows = 0;
      const tagCounts = new Map<string, number>();
      for (const group of groups) {
        rows += group.n;
        for (const tag of parseJsonArray(group.tags_json)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + group.n);
      }
      // SHORTCUT: only the newest SCHEMA_FIT_WINDOW_ROWS rows count, so older tags drop out;
      // a stored per-tenant tag and token tally is the upgrade.
      // SAFETY: the SELECT names exactly the one column read.
      const texts = db.prepare(`SELECT content FROM (${newest})`)
        .iterate(tenantId, SCHEMA_FIT_WINDOW_ROWS) as Iterable<{ content: string }>;
      return schemaFitFrom(content, tags, { rows, tagCounts, contents: contentsOf(texts) });
    });
  }, openStore);
}

export interface SourceTally {
  source: string;
  count: number;
  latest: string;
  /** `created`, a unit separator, then `id` of the source's first row in loadAllEntries' order. */
  first: string;
}

/** Row count and newest `created` per source, for peer listings that need no row; all tenants when `tenantId` is absent. */
export function tallySources(hippoRoot: string, tenantId?: string): SourceTally[] {
  return onHandle(hippoRoot, (db) => {
    const where = tenantId !== undefined ? 'WHERE tenant_id = ?' : '';
    // SAFETY: rows' shape matches the four aliased columns in the SELECT below.
    return db.prepare(
      `SELECT COALESCE(source, 'cli') AS source, COUNT(*) AS count, MAX(created) AS latest, MIN(created || char(31) || id) AS first
       FROM memories ${where} GROUP BY COALESCE(source, 'cli')`,
    ).all(...(tenantId !== undefined ? [tenantId] : [])) as SourceTally[];
  }, openStore);
}

// A malformed or non-array JSON list reads as empty, as parseJsonArray does, instead of failing json_each.
export const jsonList = (column: string): string =>
  `(CASE WHEN json_valid(${column}) AND json_type(${column}) = 'array' THEN ${column} ELSE '[]' END)`;

/** Whole-tenant health numbers: every row counts, superseded and archived ones too. */
export interface StrengthTallies {
  total: number;
  pinned: number;
  /** Rows tagged exactly `error`. */
  errors: number;
  strengthSum: number;
  /** Unpinned rows whose strength is under `atRiskBelow`. */
  atRisk: number;
}

/** calculateStrength over every row of a tenant in one aggregate pass, no row loaded. */
export function loadStrengthTallies(hippoRoot: string, tenantId: string, now: Date, atRiskBelow: number): StrengthTallies {
  // An unparseable date scores NULL in SQL and 0 in calculateStrength.
  const strength = `COALESCE(${strengthSql(now)}, 0)`;
  return onHandle(hippoRoot, (db) => {
    // SAFETY: one aggregate row whose columns are the aliases named below.
    const row = db.prepare(`SELECT
      COUNT(*) AS total,
      COALESCE(SUM(pinned != 0), 0) AS pinned,
      COALESCE(SUM(EXISTS (SELECT 1 FROM json_each(${jsonList('tags_json')}) WHERE value = 'error')), 0) AS errors,
      COALESCE(SUM(${strength}), 0) AS strengthSum,
      COALESCE(SUM(COALESCE(pinned, 0) = 0 AND ${strength} < ?), 0) AS atRisk
      FROM memories WHERE tenant_id = ?`,
    ).get(atRiskBelow, tenantId) as Record<keyof StrengthTallies, number | bigint>;
    return {
      total: Number(row.total),
      pinned: Number(row.pinned),
      errors: Number(row.errors),
      strengthSum: Number(row.strengthSum),
      atRisk: Number(row.atRisk),
    };
  }, openStore);
}

/** What `hippo status` prints about the whole store: every tenant and superseded rows too. */
export interface StatusCounts {
  total: number;
  byLayer: Record<Layer, number>;
  byConfidence: Record<ConfidenceLevel, number>;
  pinned: number;
  /** Rows whose strength is under the caller's line; unlike StrengthTallies, pinned rows count. */
  atRisk: number;
  agedOut: number;
  avgStrength: number;
  /** Open conflicts of every tenant, the rows listMemoryConflicts returns when given no tenant. */
  openConflicts: number;
  /** Rows that have a stored vector. */
  embedded: number;
}

type StatusColumn = 'layer' | 'confidence' | 'pinned' | 'created' | 'last_retrieved' | 'half_life_days' | 'retrieval_count'
  | 'emotional_valence' | 'outcome_positive' | 'outcome_negative';
type StatusRow = Omit<Pick<MemoryRow, StatusColumn>, 'layer'> & { layer: Layer };
// What calculateStrength and facetsOf read, plus the layer: no text and no JSON column.
const STATUS_ROW_COLUMNS: readonly StatusColumn[] = [
  'layer', 'confidence', 'pinned', 'created', 'last_retrieved', 'half_life_days', 'retrieval_count',
  'emotional_valence', 'outcome_positive', 'outcome_negative',
];

// Scored in JavaScript, not with strengthSql: SQLite reads fewer date shapes than Date does, so its counts would differ.
function tallyStatusRows(rows: Iterable<StatusRow>, now: Date, atRiskBelow: number): Omit<StatusCounts, 'openConflicts' | 'embedded'> {
  const byLayer = { [Layer.Buffer]: 0, [Layer.Episodic]: 0, [Layer.Semantic]: 0, [Layer.Trace]: 0 };
  const byConfidence = { verified: 0, observed: 0, inferred: 0, stale: 0 };
  const sums = { total: 0, strength: 0, pinned: 0, atRisk: 0, agedOut: 0 };
  for (const row of rows) {
    // rowToEntry's defaults for these columns, so a row scores as its loaded entry would.
    const entry = {
      pinned: Boolean(row.pinned),
      confidence: row.confidence ?? 'observed',
      created: row.created,
      last_retrieved: row.last_retrieved,
      half_life_days: Number(row.half_life_days ?? FALLBACK_HALF_LIFE_DAYS),
      retrieval_count: Number(row.retrieval_count ?? 0),
      emotional_valence: row.emotional_valence ?? 'neutral',
      outcome_positive: Number(row.outcome_positive ?? 0),
      outcome_negative: Number(row.outcome_negative ?? 0),
    };
    const strength = calculateStrength(entry, now);
    const facets = facetsOf(entry, now);
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

/** The counts `hippo status` prints, from one pass over ten narrow columns: no text is read and no row array is built. */
export function loadStatusCounts(hippoRoot: string, now: Date, atRiskBelow: number): StatusCounts {
  return onHandle(hippoRoot, (db) => {
    // One read transaction, so the row tallies and the two counts describe the same store.
    return withReadSnapshot(db, () => {
      // loadAllEntries' order, so the strengths add up in the order they did and the average rounds the same.
      // SAFETY: the SELECT names exactly StatusRow's columns, and the store writes `layer` only from the Layer enum.
      const rows = db.prepare(
        `SELECT ${STATUS_ROW_COLUMNS.join(', ')} FROM memories ORDER BY created ASC, id ASC`,
      ).iterate() as Iterable<StatusRow>;
      const tallies = tallyStatusRows(rows, now, atRiskBelow);
      // SAFETY: one row whose columns are the two aliases named below.
      const counts = db.prepare(`SELECT
        (SELECT COUNT(*) FROM memory_conflicts WHERE status = 'open') AS openConflicts,
        (SELECT COUNT(*) FROM memory_vectors WHERE memory_id IN (SELECT id FROM memories)) AS embedded`,
      ).get() as Record<'openConflicts' | 'embedded', number | bigint>;
      return { ...tallies, openConflicts: Number(counts.openConflicts), embedded: Number(counts.embedded) };
    });
  }, openStore);
}
