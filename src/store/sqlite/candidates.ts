import { type MemoryEntry } from '../../base/memory/entry.js';
import { PRODUCTION_STRENGTH, type StrengthModel } from '../../base/memory/strength.js';
import { originInSql, rewardFactorSql, scopeAdmitSql } from './rule-sql.js';
import {
  DECAY_KEY_HALF_LIVES,
  DECAY_KEY_SLACK_DAYS,
  DECAY_KEY_SQL,
  DECAY_KEY_WHERE,
} from '../../db/decay-key.js';
import { type DatabaseSyncLike } from '../../db/index.js';
import { sortableStamp } from '../../base/memory/created-stamp.js';
import { cachedStatement } from '../../db/statement-cache.js';
import type { SqlFragment } from '../../db/sql.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry } from './rows.js';
import { pickRarestFtsQuery, listRecallEntries } from './search-rows.js';
import type { HeldText, EntryCursor } from '../../base/ports/store/types.js';
import type { TenantId } from '../../base/util/tenant.js';
import { oldestFirst } from '../rules/order.js';
import { rowsHoldingTexts } from './copy-rows.js';
import { READ_PAGE_ROWS, rowsInPages } from '../../base/util/pages.js';
import { ENTRY_PAGE_ORDER, entryPage } from './keyset.js';
import type { AmbientRefusalReason } from '../../base/scope/read-admission.js';
import type {
  AmbientCandidateRequest,
  AmbientCandidates,
  AmbientRefusal,
  ContextCandidateFilter,
  RecentOrigins,
} from '../../base/ports/store/context-reads.js';
const AMBIENT_SCOPED = 'superseded_by IS NULL AND tenant_id = ?';
const AMBIENT_PINNED = 'pinned = 1 AND superseded_by IS NULL';
/** A stamp whose text does not sort by time; idx_memories_created_drift (migration v51) holds
 * the live ones. */
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

// `id DESC` mirrors contextGet's comparator, not listFreshRawMemories' cross-ingest-stable order:
// that would change what the hook injects.
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

const afterParams = (after: Position | undefined): string[] =>
  after ? [after.at, after.at, after.id] : [];

/** Reads in `created` text order, which is time order while every live row of the tenant holds
 * toISOString text. */
function readByText(run: RunSql): ReadNewest {
  return (own, limit, after) =>
    run(`${own.sql} ${after ? AFTER : ''}${NEWEST} LIMIT ?`, [
      ...own.params,
      ...afterParams(after),
      limit,
    ]);
}

/** Every live drifted row `own` admits, newest first; the drift index holds only these, so it is
 * no tenant scan. */
function newestDrifted(run: RunSql, own: SqlFragment): MemoryEntry[] {
  return run(`${own.sql} AND ${CREATED_DRIFTED}`, [...own.params])
    .map((entry) => ({ entry, at: positionOf(entry) }))
    .sort((a, b) => newestFirst(a.at, b.at))
    .map(({ entry }) => entry);
}

/** The text-ordered rows merged with the drifted ones by instant: the rows and order a store
 * whose stamps were all written in toISOString form would read. */
function readByInstant(run: RunSql, drifted: Map<string, MemoryEntry[]>): ReadNewest {
  return (own, limit, after) => {
    let odd = drifted.get(own.sql);
    if (!odd) drifted.set(own.sql, (odd = newestDrifted(run, own)));
    const text = run(
      `${own.sql} AND NOT ${CREATED_DRIFTED} ${after ? AFTER : ''}${NEWEST} LIMIT ?`,
      [...own.params, ...afterParams(after), limit],
    );
    const older = after ? odd.filter((e) => newestFirst(positionOf(e), after) > 0) : odd;
    return [...text, ...older]
      .map((entry) => ({ entry, at: positionOf(entry) }))
      .sort((a, b) => newestFirst(a.at, b.at))
      .slice(0, limit)
      .map(({ entry }) => entry);
  };
}

// The newest rows `admit` keeps, newest first. The first window stays unfiltered so admit still
// sees, and the delivery ledger still counts, the other-project rows it refuses; past it, the reads
// narrow to the caller's origins.
function listRecentRows(
  read: ReadNewest,
  tenantId: string,
  options: RecentRowsOptions,
): MemoryEntry[] {
  const { needed, admit, origins } = options;
  const keep = origins ? (e: MemoryEntry): boolean => admit(e) && inOrigins(e, origins) : admit;
  const window = Math.max(needed * 4, 32);
  const originSql =
    origins &&
    (origins.userGlobal
      ? `(origin_project = '' OR ${originInSql(origins.names)})`
      : originInSql(origins.names));
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
  return [...kept, ...keptPastWindow({ read, own, rows, wanted: needed - kept.length, keep })];
}

interface KeptPastWindowOptions {
  readonly read: ReadNewest;
  readonly own: SqlFragment;
  readonly rows: readonly MemoryEntry[];
  readonly wanted: number;
  readonly keep: (e: MemoryEntry) => boolean;
}

// A window of refused rows can hide older ones, so read on in keyset pages, each four times the
// last, until enough are kept.
function keptPastWindow({ read, own, rows, wanted, keep }: KeptPastWindowOptions): MemoryEntry[] {
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

// The pins plus the `recentNeeded` newest rows `judge` keeps, for ambient injection, with each
// refusal in the order the rows were read. One connection; `recall` piggybacks the prompt-recall
// FTS query on it too. `origins` narrows the recent rows past the first window.
export function listAmbientCandidates(
  db: DatabaseSyncLike,
  tenantId: string,
  { recentNeeded, judge, recall, origins }: AmbientLoad,
): AmbientCandidates {
  const refused: AmbientRefusal[] = [];
  const admit = noting(judge, refused);
  // A SQL LIMIT takes an integer; the Array.slice this replaced truncated one, and include_recent
  // is any non-negative finite number at the HTTP edge.
  const needed = Math.trunc(recentNeeded);
  const run: RunSql = (where, params) =>
    (
      cachedStatement(db, `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${where}`).all(
        ...params,
      ) as MemoryRow[]
    ).map(rowToEntry);

  const byId = new Map<string, MemoryEntry>();
  for (const e of pinnedEntries(db, tenantId)) {
    if (admit(e)) byId.set(e.id, e);
  }

  if (needed > 0) {
    const drifted = newestDrifted(run, { sql: AMBIENT_SCOPED, params: [tenantId] });
    const read =
      drifted.length === 0
        ? readByText(run)
        : readByInstant(run, new Map([[AMBIENT_SCOPED, drifted]]));
    for (const e of listRecentRows(read, tenantId, { needed, admit, origins })) byId.set(e.id, e);
  }

  // loadAllEntries' order: rankedPinned's comparator can tie and Array.sort is stable, so input
  // order is load-bearing downstream.
  const entries = [...byId.values()].sort(oldestFirst);
  if (!recall) return { entries, refused };
  return { entries, recall: promptRecallEntries(db, tenantId, recall), refused };
}

function promptRecallEntries(
  db: DatabaseSyncLike,
  tenantId: string,
  recall: NonNullable<AmbientLoad['recall']>,
): MemoryEntry[] {
  const ftsQuery = pickRarestFtsQuery(db, recall.terms);
  return ftsQuery
    ? listRecallEntries(db, ftsQuery, {
        limit: recall.limit,
        tenantId,
        includeSuperseded: false,
        ownScope: recall.ownScope,
      })
    : [];
}

// calculateStrength's decay exponent with its reward factor under `model`: the strongest rows,
// without scoring each one in JS.
const decayExponentSql = (
  model: StrengthModel,
): string => `CASE WHEN half_life_days > 0 THEN (julianday(?) -
    julianday(last_retrieved)) / (half_life_days * ${rewardFactorSql(model)}) END`;

const decayRankSql = (model: StrengthModel): string => `pinned DESC,
  ${decayExponentSql(model)} ASC NULLS LAST,
  id ASC`;

/** The shared WHERE of a context read: live tenant rows, then `extra` predicates, then the scope
 * and origin rules. */
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

const RANK_COLUMNS =
  'id, pinned, half_life_days, last_retrieved, outcome_positive, outcome_negative';

// The `cap` best of the pinned rows and the unpinned rows the v60 key puts within
// DECAY_KEY_HALF_LIVES; nothing unless every unpinned winner is within it too, since then each row
// left out has decayed further and the rank is the scan's.
function decayKeySubsetSql(whereSql: string): string {
  const arm = (extra: string): string =>
    `SELECT ${RANK_COLUMNS} FROM memories WHERE ${whereSql} AND ${extra}`;
  // pinned is 0 or 1 (entry-row.ts), so the two arms hold every pinned row and every unpinned row
  // with a key.
  return `WITH top AS MATERIALIZED (
      SELECT id, pinned, ${decayExponentSql(PRODUCTION_STRENGTH)} AS d FROM (
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

function decayKeySubsetRows(
  db: DatabaseSyncLike,
  rows: SqlFragment,
  cap: number,
  now: string,
): MemoryRow[] {
  const whereSql = rows.sql;
  const bound = [
    now,
    ...rows.params,
    ...rows.params,
    now,
    DECAY_KEY_SLACK_DAYS,
    cap,
    cap,
    DECAY_KEY_HALF_LIVES,
  ];
  return cachedStatement(db, decayKeySubsetSql(whereSql)).all(...bound) as MemoryRow[];
}

/** Live tenant rows passing `filter`, at most `filter.cap`, in loadAllEntries' order; below the
 * cap, every such row. */
export function listContextCandidates(
  db: DatabaseSyncLike,
  model: StrengthModel,
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
    cachedStatement(
      db,
      `SELECT COUNT(*) AS n FROM (SELECT 1 FROM memories WHERE ${whereSql} LIMIT ?)`,
    ).get(...params, cap + 1) as { n: number }
  ).n;
  // Under the cap every match is returned, so the per-row decay math and the sort are skipped.
  const ranked = matched > cap;
  // The key holds the production reward factor, so a rank at another slope skips it. An empty
  // answer means the subset could not prove itself, and the scan below ranks the tenant.
  const keyed = model.rewardSlope === PRODUCTION_STRENGTH.rewardSlope;
  const bySubset = ranked && cap > 0 && keyed ? decayKeySubsetRows(db, rowsWhere, cap, now) : [];
  if (bySubset.length > 0) return bySubset.map(rowToEntry);
  // No index orders rows past the key's window by decay, so this scan stays; its LIMIT keeps the
  // sort to the cap.
  const sql = ranked
    ? `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (
    SELECT id FROM memories WHERE ${whereSql} ORDER BY ${decayRankSql(model)} LIMIT ?
  ) ORDER BY created ASC, id ASC`
    : `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${whereSql} ORDER BY created ASC, id ASC`;
  const rows = cachedStatement(db, sql).all(
    ...params,
    ...(ranked ? [now, cap] : []),
  ) as MemoryRow[];
  return rows.map(rowToEntry);
}

// No owner: for session capture, a personal or connector-private row must never stop a team copy
// being written.
const TEAM_VISIBLE = scopeAdmitSql('');

export interface ListTextsHoldingOptions {
  readonly tenantId: TenantId;
  readonly texts: readonly string[];
  readonly project?: readonly string[];
  readonly admit?: SqlFragment;
}

/** Tenant rows that may hold one of `texts` and that `admit` passes (default: team-visible):
 * equal to a text apart from spacing, or a sleep-merged row holding one. With `project`, only
 * rows carrying one of those names plus user-global rows, as listContextCandidates' filter. A
 * superset the caller checks again with heldTextKeys. */
export function listTextsHolding(
  db: DatabaseSyncLike,
  { tenantId, texts, project, admit = TEAM_VISIBLE }: ListTextsHoldingOptions,
): HeldText[] {
  const origin =
    project === undefined ? '' : ` AND (origin_project = '' OR ${originInSql(project)})`;
  const filter = {
    sql: `${origin} AND ${admit.sql}`,
    params: [...(project ?? []), ...admit.params],
  };
  const byId = new Map<string, HeldText>();
  for (const row of rowsHoldingTexts(db, { tenantId, filter }, texts)) {
    byId.set(row.id, {
      content: row.content,
      source: row.source,
      originProject: row.origin_project,
    });
  }
  return [...byId.values()];
}

// A malformed or non-array JSON list reads as empty, as parseJsonArray does, instead of failing
// json_each.
export const jsonList = (column: string): string =>
  `(CASE WHEN json_valid(${column}) AND json_type(${column}) = 'array' THEN ${column} ELSE '[]' END)`;
