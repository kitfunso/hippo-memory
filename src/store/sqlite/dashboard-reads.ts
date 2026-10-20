// hippo.db's dashboard reads: aggregates, one sorted page and a capped scatter, scored by the dashboard's SQL
// functions, so the rows a read hands to JavaScript never grow with the tenant. The commit signal uses one held
// connection.
import * as fs from 'fs';
import {
  closeHippoDb,
  type DatabaseSyncLike,
  getHippoDbPath,
  openHippoDbReadOnly,
  type SqlValue,
} from '../../db/index.js';
import { withReadSnapshot } from '../../db/busy.js';
import { pragmaDataVersion } from '../../db/meta.js';
import { tableExists } from '../../db/tables.js';
import type { Layer, LossAversion } from '../../base/memory/memory.js';
import {
  BAND_AT_RISK,
  CONFIDENCE_ORDER,
  LAYER_ORDER,
  layerIndex,
  listHead,
  memoryFacts,
} from '../../base/memory/memory-facts.js';
import {
  SCATTER_POINTS_MAX,
  type DashboardPageQuery,
  type DashboardReads,
  type DashboardSortKey,
  type DashboardTotals,
  type ExcludedCounts,
  type FilterTally,
  type ListedRow,
  type Origin,
  type ProjectTally,
  type Quad,
  type ScatterRows,
  type SearchTally,
} from '../port/dashboard-reads.js';
import { openConflictsNamingAt } from './conflicts.js';
import {
  FACT_COLUMNS,
  factInputs,
  FILTER_SLOTS,
  GRID_CELLS,
  PROJECT_SLOTS,
  tallyOf,
  useDashboardFunctions,
  type FactRow,
} from './dashboard-functions.js';
import { QUARANTINE_SCOPE_PREFIX } from './quarantine.js';
import type { StoreFiles } from './open.js';
import { handlesOf, openStore } from './handles.js';
import { bound, boundWithFiles } from './bound.js';
import { served } from './served.js';

// One past the list's cut, so the cut and its truncated flag come out as they would on the whole text.
const HEAD_READ = 241;

// SQL twins of isQuarantineScope and of the two halves of isLiveMemory, for columns under prefix `t`; substr compares
// bytes, as startsWith does, where LIKE would fold case.
const quarantinedIn = (t: string): string =>
  `(${t}scope IS NOT NULL AND substr(${t}scope, 1, ${QUARANTINE_SCOPE_PREFIX.length}) = '${QUARANTINE_SCOPE_PREFIX}')`;
const supersededIn = (t: string): string => `(${t}superseded_by IS NOT NULL AND ${t}superseded_by <> '')`;
const kindIn = (t: string): string => `COALESCE(${t}kind, 'distilled')`;
const liveIn = (t: string): string =>
  `NOT ${supersededIn(t)} AND ${kindIn(t)} IN ('raw', 'distilled') AND NOT ${quarantinedIn(t)}`;
const LIVE = liveIn('');

const EMBEDDED = 'EXISTS (SELECT 1 FROM memory_vectors v WHERE v.memory_id = memories.id)';
// First-seen order: the project whose first live row comes first by created, then id.
const SEEN = `MIN(created || char(1) || id) AS seen`;
const IN_PROJECT = `tenant_id = ?1 AND origin_project IS ?2 AND ${LIVE}`;

// The tenant's open conflicts whose members are both live; ?1 is the tenant.
const OPEN_PAIRS =
  `open_pairs AS (SELECT mc.id AS id, mc.memory_a_id AS a, mc.memory_b_id AS b, ma.origin_project AS pa, ` +
  `mb.origin_project AS pb FROM memory_conflicts mc JOIN memories ma ON ma.id = mc.memory_a_id ` +
  `JOIN memories mb ON mb.id = mc.memory_b_id WHERE mc.status = 'open' AND ma.tenant_id = ?1 AND mb.tenant_id = ?1 ` +
  `AND ${liveIn('ma.')} AND ${liveIn('mb.')})`;

const noneExcluded = (): ExcludedCounts => ({ superseded: 0, archived: 0, quarantined: 0 });

function excludedAt(db: DatabaseSyncLike, tenantId: string): ExcludedCounts {
  // SAFETY: `why` is one of the three CASE arms or NULL.
  const counts = db
    .prepare(
      `SELECT CASE WHEN ${quarantinedIn('')} THEN 'quarantined' ` +
        `WHEN ${supersededIn('')} OR ${kindIn('')} = 'superseded' THEN 'superseded' ` +
        `WHEN ${kindIn('')} = 'archived' THEN 'archived' END AS why, COUNT(*) AS n ` +
        `FROM memories WHERE tenant_id = ? AND NOT (${LIVE}) GROUP BY why`,
    )
    .all(tenantId) as Array<{ why: keyof ExcludedCounts | null; n: number }>;
  const excluded = noneExcluded();
  for (const { why, n } of counts) if (why !== null) excluded[why] = Number(n);
  return excluded;
}

function projectTally(origin: Origin, tally: SqlValue, openConflicts: number): ProjectTally {
  const t = tallyOf(tally);
  const s = PROJECT_SLOTS;
  const quad = (at: number): Quad => [t[at], t[at + 1], t[at + 2], t[at + 3]];
  return {
    origin,
    live: t[s.live],
    bands: quad(s.bands),
    layers: quad(s.layers),
    pinned: t[s.pinned],
    embedded: t[s.embedded],
    weakNow: t[s.weak],
    openConflicts,
    lastRetrievedDays: t[s.last],
    maxAgeDays: t[s.maxAge],
    firstCreatedMs: Number.isFinite(t[s.first]) ? t[s.first] : null,
    createdDays: Array.from(t.subarray(s.days, s.daysEnd)),
  };
}

type TallyRow = { origin: Origin; tally: SqlValue };

function totalsAt(db: DatabaseSyncLike, _files: StoreFiles, tenantId: string, nowMs: number): DashboardTotals {
  return withReadSnapshot(db, () => {
    // SAFETY: one row per origin_project, its tally a BLOB from hippo_project_tally.
    const rows = db
      .prepare(
        `SELECT origin_project AS origin, ${SEEN}, hippo_project_tally(${FACT_COLUMNS}, ${EMBEDDED}, ?2) AS tally ` +
          `FROM memories WHERE tenant_id = ?1 AND ${LIVE} GROUP BY origin_project ORDER BY seen`,
      )
      .all(tenantId, nowMs) as Array<TallyRow & { seen: string }>;
    // SAFETY: one row per origin a conflict touches, each conflict once per origin.
    const touched = db
      .prepare(
        `WITH ${OPEN_PAIRS} SELECT origin, COUNT(*) AS n FROM ` +
          `(SELECT id, pa AS origin FROM open_pairs UNION SELECT id, pb FROM open_pairs) GROUP BY origin`,
      )
      .all(tenantId) as Array<{ origin: Origin; n: number }>;
    const conflictsOf = new Map(touched.map((row) => [row.origin, Number(row.n)]));
    // SAFETY: an aggregate with no GROUP BY always answers one row.
    const all = db.prepare(`WITH ${OPEN_PAIRS} SELECT COUNT(*) AS n FROM open_pairs`).get(tenantId) as { n: number };
    return {
      projects: rows.map((row) => projectTally(row.origin, row.tally, conflictsOf.get(row.origin) ?? 0)),
      excluded: excludedAt(db, tenantId),
      openConflicts: Number(all.n),
    };
  });
}

function scatterAt(db: DatabaseSyncLike, tenantId: string, origin: Origin, nowMs: number, tally: ProjectTally) {
  const maxAgeDays = Math.max(1, Math.ceil(tally.maxAgeDays));
  if (tally.live <= SCATTER_POINTS_MAX) {
    // SAFETY: each column is named in the SELECT; layer holds a Layer value.
    const rows = db
      .prepare(
        `SELECT id, layer, hippo_days(created, ?3) AS age, hippo_strength(${FACT_COLUMNS}, ?3) AS strength, ` +
          `hippo_band(${FACT_COLUMNS}, ?3) AS band FROM memories WHERE ${IN_PROJECT} ORDER BY created, id LIMIT ?4`,
      )
      .all(tenantId, origin, nowMs, SCATTER_POINTS_MAX) as Array<{
      id: string;
      layer: Layer;
      age: number;
      strength: number;
      band: number;
    }>;
    const points = rows.map((r) => ({
      id: r.id,
      ageDays: r.age,
      strength: r.strength,
      layer: layerIndex(r.layer),
      band: r.band,
    }));
    return { mode: 'points', maxAgeDays, points } satisfies ScatterRows;
  }
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  const row = db
    .prepare(`SELECT hippo_scatter_grid(${FACT_COLUMNS}, ?3, ?4) AS cells FROM memories WHERE ${IN_PROJECT}`)
    .get(tenantId, origin, nowMs, Math.log10(maxAgeDays + 1)) as { cells: SqlValue };
  const t = tallyOf(row.cells);
  const cells = LAYER_ORDER.map((_, l) => Array.from(t.subarray(l * GRID_CELLS, (l + 1) * GRID_CELLS)));
  return { mode: 'grid', maxAgeDays, cells } satisfies ScatterRows;
}

function projectAt(
  db: DatabaseSyncLike,
  _files: StoreFiles,
  tenantId: string,
  origin: Origin,
  nowMs: number,
): { tally: ProjectTally; scatter: ScatterRows } | null {
  return withReadSnapshot(db, () => {
    // SAFETY: an aggregate with no GROUP BY always answers one row.
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n, hippo_project_tally(${FACT_COLUMNS}, ${EMBEDDED}, ?3) AS tally ` +
          `FROM memories WHERE ${IN_PROJECT}`,
      )
      .get(tenantId, origin, nowMs) as { n: number; tally: SqlValue };
    if (Number(row.n) === 0) return null;
    // SAFETY: an aggregate with no GROUP BY always answers one row.
    const conflicts = db
      .prepare(`WITH ${OPEN_PAIRS} SELECT COUNT(*) AS n FROM open_pairs WHERE pa IS ?2 OR pb IS ?2`)
      .get(tenantId, origin) as { n: number };
    const tally = projectTally(origin, row.tally, Number(conflicts.n));
    return { tally, scatter: scatterAt(db, tenantId, origin, nowMs, tally) };
  });
}

// ?1 tenant, ?2 origin, ?3 now, ?4-?7 layers, ?8 text, ?9-?12 brush. LIMIT -1 makes `listed` a co-routine, so each
// function runs once per row.
function keptRows(withHead: boolean): string {
  const head = withHead ? `substr(content, 1, ${HEAD_READ}) AS head, ` : '';
  return (
    `WITH ${OPEN_PAIRS}, listed AS (SELECT id, ${FACT_COLUMNS}, scope, ${head}hippo_days(created, ?3) AS age, ` +
    `hippo_strength(${FACT_COLUMNS}, ?3) AS strength, ` +
    `id IN (SELECT a FROM open_pairs UNION ALL SELECT b FROM open_pairs) AS in_conflict FROM memories ` +
    `WHERE ${IN_PROJECT} AND layer IN (?4, ?5, ?6, ?7) ` +
    `AND (?8 IS NULL OR hippo_holds_text(id, content, tags_json, ?8)) ORDER BY created, id LIMIT -1), ` +
    `kept AS (SELECT * FROM listed WHERE age >= ?9 AND age <= ?10 AND strength >= ?11 AND strength <= ?12)`
  );
}

const rankBy = (column: string, order: readonly string[]): string =>
  `CASE ${column} ${order.map((v, i) => `WHEN '${v}' THEN ${i}`).join(' ')} ELSE ${order.length} END`;

// Each key orders as the old in-memory sort did: text keys as UTF-16 bytes, so as JavaScript's `<` compares them.
const SORT_SQL = {
  content: 'hippo_head_key(head)',
  layer: rankBy('layer', LAYER_ORDER),
  strength: 'strength',
  retrievals: 'COALESCE(retrieval_count, 0)',
  last: 'hippo_days(last_retrieved, ?3)',
  age: 'age',
  confidence: rankBy(`COALESCE(confidence, 'observed')`, CONFIDENCE_ORDER),
  scope: `hippo_text_key(COALESCE(scope, ''))`,
} satisfies Record<DashboardSortKey, string>;

const CHIP_SQL =
  `(?13 = 'all' OR (?13 = 'risk' AND hippo_band(${FACT_COLUMNS}, ?3) = ${BAND_AT_RISK}) ` +
  `OR (?13 = 'pinned' AND pinned) OR (?13 = 'conflict' AND in_conflict))`;

const FACT_OF_M = FACT_COLUMNS.split(', ')
  .map((c) => `m.${c}`)
  .join(', ');

// Keys only go through the sort, so a deep offset sorts ids, never heads; the page then reads its rows by id.
function pageSql(sort: DashboardSortKey, descending: boolean): string {
  const dir = descending ? 'DESC' : 'ASC';
  return (
    `${keptRows(sort === 'content')}, page AS (SELECT id, in_conflict, ${SORT_SQL[sort]} AS sort_key FROM kept ` +
    `WHERE ${CHIP_SQL} ORDER BY sort_key ${dir}, id ASC LIMIT ?14 OFFSET ?15) ` +
    `SELECT m.id AS id, substr(m.content, 1, ${HEAD_READ}) AS head, ${FACT_OF_M}, m.scope AS scope, ` +
    `p.in_conflict AS in_conflict FROM page p JOIN memories m ON m.id = p.id ORDER BY p.sort_key ${dir}, p.id ASC`
  );
}

type PageRow = FactRow & { id: string; head: string; scope: string | null; in_conflict: number };

function filterTally(tally: SqlValue): FilterTally {
  const t = tallyOf(tally);
  const s = FILTER_SLOTS;
  const three = (at: number): [number, number, number] => [t[at], t[at + 1], t[at + 2]];
  return {
    counts: { all: t[s.all], risk: t[s.risk], pinned: t[s.pinned], conflict: t[s.conflict] },
    decay: { now: three(s.now), in7d: three(s.in7d), in30d: three(s.in30d), pinned: t[s.pinned] },
  };
}

function listedRow(row: PageRow, nowMs: number, rules: LossAversion): ListedRow {
  const inputs = factInputs(row);
  const { head, truncated } = listHead(row.head);
  return {
    id: row.id,
    head,
    truncated,
    retrievals: inputs.retrievalCount,
    scope: row.scope ?? null,
    pinned: inputs.pinned,
    inConflict: Boolean(row.in_conflict),
    facts: memoryFacts(inputs, nowMs, rules),
  };
}

function memoryPageAt(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  query: DashboardPageQuery,
  nowMs: number,
): { tally: FilterTally; rows: ListedRow[] } | null {
  const { origin } = query;
  return withReadSnapshot(db, () => {
    const any = db.prepare(`SELECT 1 AS hit FROM memories WHERE ${IN_PROJECT} LIMIT 1`).get(tenantId, origin);
    if (any === undefined) return null;
    const layers = LAYER_ORDER.map((layer, i) => (query.layers.includes(i) ? layer : null));
    const brush = [query.minAgeDays, query.maxAgeDays, query.minStrength, query.maxStrength];
    const filter = [tenantId, origin, nowMs, ...layers, query.text, ...brush];
    // SAFETY: an aggregate with no GROUP BY always answers one row.
    const total = db
      .prepare(`${keptRows(false)} SELECT hippo_filter_tally(${FACT_COLUMNS}, in_conflict, ?3) AS tally FROM kept`)
      .get(...filter) as { tally: SqlValue };
    // SAFETY: pageSql names every PageRow column.
    const rows = db
      .prepare(pageSql(query.sort, query.descending))
      .all(...filter, query.chip, query.limit, query.offset) as PageRow[];
    return { tally: filterTally(total.tally), rows: rows.map((row) => listedRow(row, nowMs, files)) };
  });
}

function searchAt(db: DatabaseSyncLike, _files: StoreFiles, tenantId: string, needle: string): SearchTally[] {
  // SAFETY: one row per origin_project, each a count and a sum.
  const rows = db
    .prepare(
      `SELECT origin_project AS origin, COUNT(*) AS live, ` +
        `SUM(hippo_holds_text(id, content, tags_json, ?2)) AS hits, ${SEEN} ` +
        `FROM memories WHERE tenant_id = ?1 AND ${LIVE} GROUP BY origin_project ORDER BY seen`,
    )
    .all(tenantId, needle) as Array<{ origin: Origin; live: number; hits: number; seen: string }>;
  return rows.map((row) => ({ origin: row.origin, live: Number(row.live), hits: Number(row.hits) }));
}

/** Whether `id` has a stored vector; false on a store that has never held one. */
function hasVectorAt(db: DatabaseSyncLike, id: string): boolean {
  if (!tableExists(db, 'memory_vectors')) return false;
  return db.prepare('SELECT 1 FROM memory_vectors WHERE memory_id = ?').get(id) !== undefined;
}

/** Reads run on a fresh writable open, which runs any pending migration and legacy import first and carries the
 * dashboard's functions scored by `rules`; while no hippo.db exists they answer empty and create none. */
export function sqliteDashboardReads(hippoRoot: string, rules: LossAversion = {}): DashboardReads {
  const { on } = handlesOf(hippoRoot, rules);
  const open = (root: string): DatabaseSyncLike => {
    const db = openStore(root);
    useDashboardFunctions(db, rules);
    return db;
  };
  type Scans = Pick<DashboardReads, 'totals' | 'project' | 'memoryPage' | 'search'>;
  const scans = boundWithFiles<Scans>(
    on,
    { totals: totalsAt, project: projectAt, memoryPage: memoryPageAt, search: searchAt },
    open,
  );
  const points = bound<Pick<DashboardReads, 'openConflictsOf'>>(on, { openConflictsOf: openConflictsNamingAt }, open);
  const stored = (): boolean => fs.existsSync(getHippoDbPath(hippoRoot));
  let held: DatabaseSyncLike | null = null;
  const reader = (): DatabaseSyncLike | null => {
    if (held === null && stored()) held = openHippoDbReadOnly(hippoRoot);
    return held;
  };
  return served<DashboardReads>({
    commitCount() {
      const db = reader();
      return db === null ? null : pragmaDataVersion(db);
    },
    totals: (tenantId, nowMs) =>
      stored() ? scans.totals(tenantId, nowMs) : { projects: [], excluded: noneExcluded(), openConflicts: 0 },
    project: (tenantId, origin, nowMs) => (stored() ? scans.project(tenantId, origin, nowMs) : null),
    memoryPage: (tenantId, query, nowMs) => (stored() ? scans.memoryPage(tenantId, query, nowMs) : null),
    search: (tenantId, needle) => (stored() ? scans.search(tenantId, needle) : []),
    openConflictsOf: points.openConflictsOf,
    hasVector(id) {
      const db = reader();
      return db !== null && hasVectorAt(db, id);
    },
    close() {
      if (held !== null) closeHippoDb(held);
      held = null;
    },
  });
}
