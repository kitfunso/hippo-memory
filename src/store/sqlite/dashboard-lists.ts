// The dashboard's memory lists. One scan sorts a project's kept ids into a TEMP table on the held reader, so the next
// page of the same stamp reads its rows by position and the project is not scanned again until a commit.
import type { DatabaseSyncLike, SqlValue } from '../../db/index.js';
import { withReadSnapshot } from '../../db/busy.js';
import { pragmaDataVersion } from '../../db/meta.js';
import { cachedStatement } from '../../db/statement-cache.js';
import type { LossAversion } from '../../base/memory/memory.js';
import { BAND_AT_RISK, CONFIDENCE_ORDER, LAYER_ORDER, listHead, memoryFacts } from '../../base/memory/memory-facts.js';
import { DAY_MS } from '../../base/util/time.js';
import type { DashboardPageQuery, DashboardSortKey, FilterTally, ListedRow } from '../port/dashboard-reads.js';
import {
  FACT_COLUMNS,
  factInputs,
  FILTER_SLOTS,
  HOLDS_TEXT,
  holdsTextBinds,
  tallyOf,
  type FactRow,
} from './dashboard-functions.js';
import { IN_PROJECT, OPEN_PAIRS } from './dashboard-sql.js';

// One past the list's cut, so the cut and its truncated flag come out as they would on the whole text.
const HEAD_READ = 241;
// Each list is a row per kept id in SQLite's temp store, never in JavaScript; the least recently read goes first.
const LISTS_KEPT = 8;
const LISTS = 'temp.dashboard_lists';

const LAYER_SLOTS = LAYER_ORDER.map((_, i) => `:layer${i}`).join(', ');

const rankBy = (column: string, order: readonly string[]): string =>
  `CASE ${column} ${order.map((v, i) => `WHEN '${v}' THEN ${i}`).join(' ')} ELSE ${order.length} END`;

// Each key orders as the old in-memory sort did: text keys as UTF-16 bytes, so as JavaScript's `<` compares them.
const SORT_SQL = {
  content: 'hippo_head_key(head)',
  layer: rankBy('layer', LAYER_ORDER),
  strength: 'strength',
  retrievals: 'COALESCE(retrieval_count, 0)',
  last: 'hippo_days(last_retrieved, :now)',
  age: 'age',
  confidence: rankBy(`COALESCE(confidence, 'observed')`, CONFIDENCE_ORDER),
  scope: `hippo_text_key(COALESCE(scope, ''))`,
} satisfies Record<DashboardSortKey, string>;

const CHIP_SQL =
  `(:chip = 'all' OR (:chip = 'risk' AND hippo_band(${FACT_COLUMNS}, :now) = ${BAND_AT_RISK}) ` +
  `OR (:chip = 'pinned' AND pinned) OR (:chip = 'conflict' AND in_conflict))`;

const FACT_OF_M = FACT_COLUMNS.split(', ')
  .map((c) => `m.${c}`)
  .join(', ');

// toISOString writes YYYY-MM-DDTHH:MM:SS.sssZ for every instant from the first to the last of these, and text in that
// form sorts as its instant does.
const PLAIN_FIRST_MS = Date.parse('0000-01-01T00:00:00.000Z');
const PLAIN_LAST_MS = Date.parse('9999-12-31T23:59:59.999Z');
// Bounds no plain created text reaches: one below every digit, one above.
const BEFORE_ALL = '';
const AFTER_ALL = '~';
// strftime keeps an hour of 24 as written, where Date.parse moves it to the next day.
const PLAIN_CREATED = `strftime('%Y-%m-%dT%H:%M:%fZ', created) = created AND substr(created, 12, 2) < '24'`;

// The brush's age test as daysBetween makes it: as text on a plain created, by hippo_days on any other.
const AGE_KEPT =
  `CASE WHEN :anyAge THEN 1 WHEN ${PLAIN_CREATED} THEN created >= :createdFrom AND created <= :createdTo ` +
  `ELSE hippo_days(created, :now) BETWEEN :minAgeDays AND :maxAgeDays END`;

/** The first instant from PLAIN_FIRST_MS on where `holds` is true, given it stays true; past PLAIN_LAST_MS if none. */
function firstHolding(holds: (ms: number) => boolean): number {
  let lo = PLAIN_FIRST_MS;
  let hi = PLAIN_LAST_MS + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (holds(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** AGE_KEPT's parameters: a plain created is kept from createdFrom to createdTo, the instants where daysBetween's
 * arithmetic, done here on each candidate instant, turns the brush's two tests. */
function ageBinds(min: number, max: number, nowMs: number) {
  const age = (ms: number): number => Math.max(0, (nowMs - ms) / DAY_MS);
  const from = firstHolding((ms) => age(ms) <= max);
  const to = firstHolding((ms) => !(age(ms) >= min)) - 1;
  return {
    anyAge: min <= 0 && max === Number.POSITIVE_INFINITY ? 1 : 0,
    createdFrom: from > PLAIN_LAST_MS ? AFTER_ALL : new Date(from).toISOString(),
    createdTo: to < PLAIN_FIRST_MS ? BEFORE_ALL : new Date(to).toISOString(),
    minAgeDays: min,
    maxAgeDays: max,
  };
}

interface ListScan {
  readonly sql: string;
  readonly binds: Record<string, SqlValue>;
}

// Strength is a JavaScript function, so a row pays for it only under a strength brush or sort; LIMIT -1 makes `listed`
// a co-routine, so each function runs once per row.
function scanSql(sort: DashboardSortKey, descending: boolean, byStrength: boolean): string {
  const extra = [
    sort === 'content' ? `substr(content, 1, ${HEAD_READ}) AS head, ` : '',
    sort === 'age' ? 'hippo_days(created, :now) AS age, ' : '',
    sort === 'strength' || byStrength ? `hippo_strength(${FACT_COLUMNS}, :now) AS strength, ` : '',
  ].join('');
  const kept = byStrength ? ' WHERE strength >= :minStrength AND strength <= :maxStrength' : '';
  return (
    `WITH ${OPEN_PAIRS}, listed AS (SELECT id, ${FACT_COLUMNS}, scope, ${extra}` +
    `id IN (SELECT a FROM open_pairs UNION ALL SELECT b FROM open_pairs) AS in_conflict FROM memories ` +
    `WHERE ${IN_PROJECT} AND layer IN (${LAYER_SLOTS}) AND ${AGE_KEPT} AND ${HOLDS_TEXT} ORDER BY created, id ` +
    `LIMIT -1), kept AS MATERIALIZED (SELECT * FROM listed${kept}) ` +
    `INSERT INTO ${LISTS} (list, pos, id, in_conflict, tally) ` +
    `SELECT :list, 0, NULL, 0, hippo_filter_tally(${FACT_COLUMNS}, in_conflict, :now) FROM kept UNION ALL ` +
    `SELECT :list, ROW_NUMBER() OVER (ORDER BY ${SORT_SQL[sort]} ${descending ? 'DESC' : 'ASC'}, id ASC), id, ` +
    `in_conflict, NULL FROM kept WHERE ${CHIP_SQL}`
  );
}

/** The scan that writes list `list`: the filter's tally at position 0, then from 1 each kept id the chip keeps, in sort
 * order; a layer the query leaves out binds NULL, which no row's layer equals. */
function listScan(tenantId: string, query: DashboardPageQuery, nowMs: number, list: number): ListScan {
  const byStrength = query.minStrength !== Number.NEGATIVE_INFINITY || query.maxStrength !== Number.POSITIVE_INFINITY;
  const layers = LAYER_ORDER.map((layer, i) => [`layer${i}`, query.layers.includes(i) ? layer : null]);
  const binds = {
    tenant: tenantId,
    origin: query.origin,
    now: nowMs,
    ...Object.fromEntries(layers),
    ...ageBinds(query.minAgeDays, query.maxAgeDays, nowMs),
    ...holdsTextBinds(query.text),
    chip: query.chip,
    list,
  } satisfies Record<string, SqlValue>;
  const { minStrength, maxStrength } = query;
  return {
    sql: scanSql(query.sort, query.descending, byStrength),
    binds: byStrength ? { ...binds, minStrength, maxStrength } : binds,
  };
}

const PAGE_ROWS =
  `SELECT m.id AS id, substr(m.content, 1, ${HEAD_READ}) AS head, ${FACT_OF_M}, m.scope AS scope, ` +
  `l.in_conflict AS in_conflict FROM ${LISTS} l JOIN memories m ON m.id = l.id ` +
  `WHERE l.list = :list AND l.pos BETWEEN :first AND :last ORDER BY l.pos`;

type PageRow = FactRow & { id: string; head: string; scope: string | null; in_conflict: number };

function filterTally(tally: SqlValue): FilterTally {
  const t = tallyOf(tally);
  const s = FILTER_SLOTS;
  const three = (at: number): [number, number, number] => [t[at], t[at + 1], t[at + 2]];
  return {
    counts: {
      all: t[s.all],
      risk: t[s.risk],
      pinned: t[s.pinned],
      conflict: t[s.conflict],
    },
    decay: {
      now: three(s.now),
      in7d: three(s.in7d),
      in30d: three(s.in30d),
      pinned: t[s.pinned],
    },
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

/** A list's id in the temp table and the filter tally its scan wrote. */
interface SortedList {
  readonly id: number;
  readonly tally: FilterTally;
}

// Everything but the page window: a stamp holds one nowMs for every read it dates, so its pages share a list.
function listKey(tenantId: string, query: DashboardPageQuery, nowMs: number): string {
  const { origin, layers, text, sort, descending, chip } = query;
  const bounds = [query.minAgeDays, query.maxAgeDays, query.minStrength, query.maxStrength, nowMs];
  return `${JSON.stringify([tenantId, origin, layers, text, sort, descending, chip])} ${bounds.join(' ')}`;
}

/** The sorted lists one held reader keeps, scored by `rules`; a commit to the store drops them all. */
export class MemoryLists {
  readonly #db: DatabaseSyncLike;
  readonly #rules: LossAversion;
  readonly #lists = new Map<string, SortedList>();
  #version: number | null = null;
  #next = 1;

  constructor(db: DatabaseSyncLike, rules: LossAversion) {
    this.#db = db;
    this.#rules = rules;
    db.exec(
      `CREATE TEMP TABLE IF NOT EXISTS dashboard_lists (list INTEGER NOT NULL, pos INTEGER NOT NULL, id TEXT, ` +
        `in_conflict INTEGER NOT NULL, tally BLOB, PRIMARY KEY (list, pos)) WITHOUT ROWID`,
    );
  }

  /** The tally of `query`'s filter and its page, from one read snapshot; null when the project holds no live row. */
  page(tenantId: string, query: DashboardPageQuery, nowMs: number): { tally: FilterTally; rows: ListedRow[] } | null {
    return withReadSnapshot(this.#db, () => {
      this.#follow(pragmaDataVersion(this.#db));
      const key = listKey(tenantId, query, nowMs);
      const list = this.#take(key) ?? this.#sort(key, tenantId, query, nowMs);
      if (list === null) return null;
      // SAFETY: each column is named in the SELECT, from the memories row the list's id names.
      const rows = cachedStatement(this.#db, PAGE_ROWS).all({
        list: list.id,
        first: query.offset + 1,
        last: query.offset + query.limit,
      }) as PageRow[];
      return { tally: list.tally, rows: rows.map((row) => listedRow(row, nowMs, this.#rules)) };
    });
  }

  // data_version moves on every other connection's commit, and this reader never commits to the store.
  #follow(version: number): void {
    if (version === this.#version) return;
    if (this.#lists.size > 0) cachedStatement(this.#db, `DELETE FROM ${LISTS}`).run();
    this.#lists.clear();
    this.#version = version;
  }

  #take(key: string): SortedList | undefined {
    const list = this.#lists.get(key);
    if (list === undefined) return undefined;
    this.#lists.delete(key);
    this.#lists.set(key, list);
    return list;
  }

  #sort(key: string, tenantId: string, query: DashboardPageQuery, nowMs: number): SortedList | null {
    const db = this.#db;
    const any = cachedStatement(db, `SELECT 1 AS hit FROM memories WHERE ${IN_PROJECT} LIMIT 1`).get({
      tenant: tenantId,
      origin: query.origin,
    });
    if (any === undefined) return null;
    const id = this.#next++;
    const scan = listScan(tenantId, query, nowMs, id);
    cachedStatement(db, scan.sql).run(scan.binds);
    // SAFETY: the scan's aggregate arm writes position 0 on every run, with the tally as a BLOB.
    const head = cachedStatement(db, `SELECT tally FROM ${LISTS} WHERE list = ? AND pos = 0`).get(id) as {
      tally: SqlValue;
    };
    const list = { id, tally: filterTally(head.tally) };
    this.#lists.set(key, list);
    if (this.#lists.size > LISTS_KEPT) this.#drop(this.#lists.keys().next().value!);
    return list;
  }

  #drop(key: string): void {
    const list = this.#lists.get(key);
    if (list === undefined) return;
    cachedStatement(this.#db, `DELETE FROM ${LISTS} WHERE list = ?`).run(list.id);
    this.#lists.delete(key);
  }
}
