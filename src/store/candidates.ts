import type { MemoryEntry, StrengthInputs } from '../memory.js';
import { closeHippoDb } from '../db.js';
import { scopeAdmitSql, type SqlFragment } from '../recall-scope.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry, parseJsonArray } from './rows.js';
import { openStore } from './open.js';
import { originInSql } from '../project-identity.js';
import { schemaFitFrom } from '../schema-fit.js';
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
/** Exported so the plan test runs the exact SQL; idx_memories_pinned (db.ts v51) serves it. */
export const AMBIENT_PINNED_WHERE = `pinned = 1 AND ${AMBIENT_SCOPED} ORDER BY created ASC, id ASC`;
/** Exported so the plan test runs the exact SQL; idx_memories_created_drift (db.ts v51) serves it. */
export const AMBIENT_DRIFT_SQL =
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

// The newest rows `admit` keeps, newest first. The first window stays unfiltered so admit still sees, and the
// delivery ledger still counts, the other-project rows it refuses; past it, the reads narrow to the caller's origins.
function loadRecentRows(run: RunSql, drifted: boolean, tenantId: string, needed: number, admit: (e: MemoryEntry) => boolean, origins?: RecentOrigins): MemoryEntry[] {
  const keep = origins ? (e: MemoryEntry): boolean => admit(e) && inOrigins(e, origins) : admit;
  // `id DESC` mirrors getContext's comparator, not loadFreshRawMemories'
  // cross-ingest-stable order: that would change what the hook injects.
  const newest = 'ORDER BY created DESC, id DESC';
  const window = Math.max(needed * 4, 32);
  const originSql = origins && (origins.userGlobal ? `(origin_project = '' OR ${originInSql(origins.names)})` : originInSql(origins.names));
  const ownWhere = originSql ? `${AMBIENT_SCOPED} AND ${originSql}` : AMBIENT_SCOPED;
  const ownParams = [tenantId, ...(origins?.names ?? [])];
  if (!drifted) {
    const windowed = run(`${AMBIENT_SCOPED} ${newest} LIMIT ?`, [tenantId, window]);
    const kept = windowed.filter(keep);
    if (kept.length >= needed || windowed.length < window) return kept;
    if (origins) {
      const ownWindow = run(`${ownWhere} ${newest} LIMIT ?`, [...ownParams, window]);
      const ownKept = ownWindow.filter(keep);
      if (ownKept.length >= needed || ownWindow.length < window) return ownKept;
    }
  }
  // Text order is chronological only for standard UTC ISO (memory.ts), and a window of junk can hide older rows.
  return run(`${ownWhere} ${newest}`, ownParams).filter(keep);
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
  const db = openStore(hippoRoot);
  try {
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
      for (const e of loadRecentRows(run, drifted, tenantId, needed, admit, origins)) byId.set(e.id, e);
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
      ? loadRecallSearchEntriesFromDb(db, ftsQuery, recall.limit, tenantId, undefined, 'exact', false, undefined, recall.ownScope)
      : [];
    return { entries, recall: recallEntries };
  } finally {
    closeHippoDb(db);
  }
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
  const db = openStore(hippoRoot);
  try {
    // SAFETY: the outer SELECT names exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set; the rank sort carries ids only.
    const rows = db.prepare(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (
        SELECT id FROM memories WHERE ${where.join(' AND ')} ORDER BY ${DECAY_RANK_SQL} LIMIT ?
      ) ORDER BY created ASC, id ASC`,
    ).all(...params, filter.now.toISOString(), Math.max(0, Math.trunc(filter.cap))) as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

/** A row's strength inputs and tags, without its text or the JSON lists a full row parses. */
export type StrengthRow = StrengthInputs & Pick<MemoryEntry, 'tags'>;

/** Every tenant row as a StrengthRow, for whole-store health numbers; defaults match rowToEntry's. */
export function loadStrengthRows(hippoRoot: string, tenantId: string): StrengthRow[] {
  const db = openStore(hippoRoot);
  try {
    // SAFETY: rows' shape matches the columns named in the SELECT below.
    const rows = db.prepare(
      `SELECT pinned, created, last_retrieved, half_life_days, retrieval_count, emotional_valence, outcome_positive, outcome_negative, tags_json
       FROM memories WHERE tenant_id = ?`,
    ).all(tenantId) as Array<Pick<MemoryRow, 'pinned' | 'created' | 'last_retrieved' | 'half_life_days' | 'retrieval_count' | 'emotional_valence' | 'outcome_positive' | 'outcome_negative' | 'tags_json'>>;
    return rows.map((row) => ({
      pinned: Boolean(row.pinned),
      created: row.created,
      last_retrieved: row.last_retrieved,
      half_life_days: Number(row.half_life_days ?? 7),
      retrieval_count: Number(row.retrieval_count ?? 0),
      emotional_valence: row.emotional_valence ?? 'neutral',
      outcome_positive: Number(row.outcome_positive ?? 0),
      outcome_negative: Number(row.outcome_negative ?? 0),
      tags: parseJsonArray(row.tags_json),
    }));
  } finally {
    closeHippoDb(db);
  }
}

export type HeldText = Pick<MemoryEntry, 'content' | 'source' | 'origin_project'>;

// No owner: for session capture, a personal or connector-private row must never stop a team copy being written.
const TEAM_VISIBLE = scopeAdmitSql('');

/** Admits every scope, for a reader that sees the whole store, such as the CLI on its own machine. */
export const EVERY_SCOPE: SqlFragment = Object.freeze({ sql: '1', params: [] });

/** Text, source and origin of tenant rows holding any of `words` that `admit` passes, by default the team-visible ones; a row equal to a text apart from spacing holds its every word.
 *  With `project`, only rows carrying one of those names and user-global rows, as loadContextCandidates' filter. No `tenantId` reads every tenant. */
export function loadTextsHoldingWords(
  hippoRoot: string, tenantId: string | undefined, words: readonly string[], project?: readonly string[], admit: SqlFragment = TEAM_VISIBLE,
): HeldText[] {
  const unique = [...new Set(words)];
  const out: HeldText[] = [];
  const tenantWhere = tenantId === undefined ? '1' : 'tenant_id = ?';
  const tenantParams = tenantId === undefined ? [] : [tenantId];
  const originWhere = project === undefined ? '' : ` AND (origin_project = '' OR ${originInSql(project)})`;
  const db = openStore(hippoRoot);
  try {
    // Chunked so one statement stays far under SQLite's bound-parameter limit.
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      // SAFETY: rows' shape matches the three columns named in the SELECT below.
      const rows = db.prepare(
        `SELECT content, source, origin_project FROM memories WHERE ${tenantWhere}${originWhere} AND ${admit.sql} AND (${chunk.map(() => 'instr(content, ?) > 0').join(' OR ')})`,
      ).all(...tenantParams, ...(project ?? []), ...admit.params, ...chunk) as Array<{ content: string; source: string | null; origin_project: string | null }>;
      for (const row of rows) out.push({ content: row.content, source: row.source ?? 'cli', origin_project: row.origin_project });
    }
    return out;
  } finally {
    closeHippoDb(db);
  }
}

/** A tenant's `limit` newest rows, oldest first: the tail of loadAllEntries' order, without reading the rows before it. */
export function loadNewestEntries(hippoRoot: string, tenantId: string, limit: number): MemoryEntry[] {
  const db = openStore(hippoRoot);
  try {
    // SAFETY: the SELECT names exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
    const rows = db.prepare(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE tenant_id = ? ORDER BY created DESC, id DESC LIMIT ?`,
    ).all(tenantId, limit) as MemoryRow[];
    return rows.reverse().map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

function* contentsOf(rows: Iterable<{ content: string }>): Generator<string> {
  for (const row of rows) yield row.content;
}

/** computeSchemaFit against every row of a tenant: tag counts come from one aggregate and texts stream one column, so no row is loaded. */
export function schemaFitInStore(hippoRoot: string, tenantId: string, content: string, tags: readonly string[]): number {
  const db = openStore(hippoRoot);
  try {
    // One read transaction, so the row count and the texts come from the same snapshot.
    db.exec('BEGIN');
    try {
      // SAFETY: rows' shape matches the two columns named in the SELECT.
      const groups = db.prepare(
        'SELECT tags_json, COUNT(*) AS n FROM memories WHERE tenant_id = ? GROUP BY tags_json',
      ).all(tenantId) as Array<{ tags_json: string | null; n: number }>;
      let rows = 0;
      const tagCounts = new Map<string, number>();
      for (const group of groups) {
        rows += group.n;
        for (const tag of parseJsonArray(group.tags_json)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + group.n);
      }
      // SHORTCUT: the text walk visits rows until a tenth of the tenant matches; a stored token count per tenant is the upgrade.
      // SAFETY: the SELECT names exactly the one column read.
      const texts = db.prepare('SELECT content FROM memories WHERE tenant_id = ?').iterate(tenantId) as Iterable<{ content: string }>;
      return schemaFitFrom(content, tags, { rows, tagCounts, contents: contentsOf(texts) });
    } finally {
      db.exec('COMMIT');
    }
  } finally {
    closeHippoDb(db);
  }
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
  const db = openStore(hippoRoot);
  try {
    const where = tenantId !== undefined ? 'WHERE tenant_id = ?' : '';
    // SAFETY: rows' shape matches the four aliased columns in the SELECT below.
    return db.prepare(
      `SELECT COALESCE(source, 'cli') AS source, COUNT(*) AS count, MAX(created) AS latest, MIN(created || char(31) || id) AS first
       FROM memories ${where} GROUP BY COALESCE(source, 'cli')`,
    ).all(...(tenantId !== undefined ? [tenantId] : [])) as SourceTally[];
  } finally {
    closeHippoDb(db);
  }
}
