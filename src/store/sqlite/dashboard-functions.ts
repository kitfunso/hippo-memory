// The dashboard's rules as SQL functions on one connection. Each calls src/base's own rule, so a count SQLite makes
// and a row the dashboard lists judge one memory the same way. Aggregate state is a fixed Float64Array, never a
// row list.
import type { DatabaseSyncLike, SqlValue } from '../../db/index.js';
import {
  calculateStrength,
  FALLBACK_HALF_LIFE_DAYS,
  type ConfidenceInputs,
  type Layer,
  type LossAversion,
  type MemoryEntry,
  type StrengthInputs,
} from '../../base/memory/memory.js';
import {
  BAND_AT_RISK,
  bandAt,
  daysBetween,
  layerIndex,
  listHead,
  memoryFacts,
  SERIES_DAYS,
  seriesDay,
  strengthBucket,
} from '../../base/memory/memory-facts.js';
import { AT_RISK_BELOW } from '../../base/memory/strength-bands.js';
import { SCATTER_COLS, SCATTER_ROWS } from '../port/dashboard-reads.js';
import { type MemoryRow, parseJsonArray } from './rows.js';

/** The columns each fact function reads first, in this order. */
export const FACT_COLUMNS =
  'pinned, created, last_retrieved, half_life_days, retrieval_count, emotional_valence, outcome_positive, ' +
  'outcome_negative, confidence, layer';
const FACT_ARGS = 10;

export type FactRow = Pick<
  MemoryRow,
  | 'pinned'
  | 'created'
  | 'last_retrieved'
  | 'half_life_days'
  | 'retrieval_count'
  | 'emotional_valence'
  | 'outcome_positive'
  | 'outcome_negative'
  | 'confidence'
  | 'layer'
>;

export type FactInputs = StrengthInputs & ConfidenceInputs & Pick<MemoryEntry, 'layer'>;

// The defaults are rowToEntry's, so a row scores here as it would through the full mapper.
export function factInputs(row: FactRow): FactInputs {
  // SAFETY: layer is a column the write path only fills from the Layer union.
  const layer = row.layer as Layer;
  return {
    pinned: Boolean(row.pinned),
    created: row.created,
    lastRetrieved: row.last_retrieved,
    halfLifeDays: Number(row.half_life_days ?? FALLBACK_HALF_LIFE_DAYS),
    retrievalCount: Number(row.retrieval_count ?? 0),
    emotionalValence: row.emotional_valence ?? 'neutral',
    outcomePositive: Number(row.outcome_positive ?? 0),
    outcomeNegative: Number(row.outcome_negative ?? 0),
    confidence: row.confidence ?? 'observed',
    layer,
  };
}

function factsOf(v: readonly SqlValue[]): FactInputs {
  // SAFETY: every call site passes FACT_COLUMNS first, in order, and each column holds its MemoryRow type.
  const row = {
    pinned: v[0],
    created: v[1],
    last_retrieved: v[2],
    half_life_days: v[3],
    retrieval_count: v[4],
    emotional_valence: v[5],
    outcome_positive: v[6],
    outcome_negative: v[7],
    confidence: v[8],
    layer: v[9],
  } as FactRow;
  return factInputs(row);
}

function isSqlText(v: SqlValue): v is string {
  return typeof v === 'string';
}

const text = (v: SqlValue): string => (isSqlText(v) ? v : '');

/** Content or tags hold `needle` once lower-cased, as JavaScript folds case, past ASCII too. */
function holdsText(id: SqlValue, content: SqlValue, tagsJson: SqlValue, needle: SqlValue): number {
  const want = text(needle);
  if (text(content).toLowerCase().includes(want)) return 1;
  const site = { table: 'memories', id: text(id), column: 'tags_json' };
  const tags = parseJsonArray(isSqlText(tagsJson) ? tagsJson : null, site);
  return tags.length > 0 && tags.join('\n').toLowerCase().includes(want) ? 1 : 0;
}

/** UTF-16 big-endian bytes, so SQLite's byte order sorts text as JavaScript's `<` does. */
function utf16Key(value: SqlValue): Uint8Array {
  const bytes = Buffer.from(text(value), 'utf16le');
  return bytes.swap16();
}

// Project tally slots: live, 4 bands, 4 layers, pinned, embedded, weak now, fewest days since retrieval, most days of
// age, first created time, then a count per series day.
const P_LIVE = 0;
const P_BANDS = 1;
const P_LAYERS = 5;
const P_PINNED = 9;
const P_EMBEDDED = 10;
const P_WEAK = 11;
const P_LAST = 12;
const P_MAX_AGE = 13;
const P_FIRST = 14;
const P_DAYS = 15;
const P_SIZE = P_DAYS + SERIES_DAYS + 1;

function newProjectTally(): Float64Array {
  const t = new Float64Array(P_SIZE);
  t[P_LAST] = Number.POSITIVE_INFINITY;
  t[P_FIRST] = Number.POSITIVE_INFINITY;
  return t;
}

function addProjectRow(t: Float64Array, v: readonly SqlValue[], rules: LossAversion): Float64Array {
  const row = factsOf(v);
  const nowMs = Number(v[FACT_ARGS + 1]);
  const f = memoryFacts(row, nowMs, rules);
  const created = Date.parse(row.created);
  t[P_LIVE]++;
  t[P_BANDS + f.band]++;
  t[P_LAYERS + f.layer]++;
  if (row.pinned) t[P_PINNED]++;
  if (v[FACT_ARGS]) t[P_EMBEDDED]++;
  if (f.strength < AT_RISK_BELOW) t[P_WEAK]++;
  t[P_LAST] = Math.min(t[P_LAST], f.lastRetrievedDays);
  t[P_MAX_AGE] = Math.max(t[P_MAX_AGE], f.ageDays);
  if (Number.isFinite(created)) t[P_FIRST] = Math.min(t[P_FIRST], created);
  t[P_DAYS + seriesDay(Number.isFinite(created) ? created : nowMs, nowMs)]++;
  return t;
}

// Filter tally slots: chip counts all, risk, pinned, conflict, then three buckets each for now, 7 days and 30 days.
const F_ALL = 0;
const F_RISK = 1;
const F_PINNED = 2;
const F_CONFLICT = 3;
const F_NOW = 4;
const F_7D = 7;
const F_30D = 10;
const F_SIZE = 13;

function addFilteredRow(t: Float64Array, v: readonly SqlValue[], rules: LossAversion): Float64Array {
  const row = factsOf(v);
  const f = memoryFacts(row, Number(v[FACT_ARGS + 1]), rules);
  t[F_ALL]++;
  t[F_NOW + strengthBucket(f.strength)]++;
  t[F_7D + strengthBucket(f.strength7d)]++;
  t[F_30D + strengthBucket(f.strength30d)]++;
  if (row.pinned) t[F_PINNED]++;
  if (f.band === BAND_AT_RISK) t[F_RISK]++;
  if (v[FACT_ARGS]) t[F_CONFLICT]++;
  return t;
}

const GRID_CELLS = SCATTER_COLS * SCATTER_ROWS;

function addGridRow(t: Float64Array, v: readonly SqlValue[], rules: LossAversion): Float64Array {
  const row = factsOf(v);
  const nowMs = Number(v[FACT_ARGS]);
  const maxLog = Number(v[FACT_ARGS + 1]);
  const age = daysBetween(row.created, nowMs);
  const strength = calculateStrength(row, new Date(nowMs), rules);
  const col = Math.min(SCATTER_COLS - 1, Math.floor((Math.log10(age + 1) / maxLog) * SCATTER_COLS));
  const cell = Math.min(SCATTER_ROWS - 1, Math.floor(strength * SCATTER_ROWS));
  t[layerIndex(row.layer) * GRID_CELLS + cell * SCATTER_COLS + col]++;
  return t;
}

type Step = (t: Float64Array, v: readonly SqlValue[], rules: LossAversion) => Float64Array;

function tally(db: DatabaseSyncLike, name: string, start: () => Float64Array, step: Step, rules: LossAversion): void {
  db.aggregate<Float64Array>(name, {
    start,
    step: (t, ...v) => step(t, v, rules),
    result: (t) => t,
    varargs: true,
    deterministic: true,
  });
}

/** Registers the dashboard's functions on `db`, each scoring strength by `rules`. */
export function useDashboardFunctions(db: DatabaseSyncLike, rules: LossAversion): void {
  const fixed = { deterministic: true };
  const many = { deterministic: true, varargs: true };
  db.function('hippo_strength', many, (...v) => calculateStrength(factsOf(v), new Date(Number(v[FACT_ARGS])), rules));
  db.function('hippo_band', many, (...v) => bandAt(factsOf(v), Number(v[FACT_ARGS]), rules));
  db.function('hippo_days', fixed, (iso: SqlValue, nowMs: SqlValue) => daysBetween(text(iso), Number(nowMs)));
  db.function('hippo_holds_text', fixed, holdsText);
  db.function('hippo_head_key', fixed, (content: SqlValue) => utf16Key(listHead(text(content)).head.toLowerCase()));
  db.function('hippo_text_key', fixed, utf16Key);
  tally(db, 'hippo_project_tally', newProjectTally, addProjectRow, rules);
  tally(db, 'hippo_filter_tally', () => new Float64Array(F_SIZE), addFilteredRow, rules);
  tally(db, 'hippo_scatter_grid', () => new Float64Array(GRID_CELLS * 4), addGridRow, rules);
}

/** An aggregate's Float64Array state, read back from the BLOB SQLite returns. */
export function tallyOf(value: SqlValue): Float64Array {
  if (!(value instanceof Uint8Array)) throw new Error('dashboard tally: expected a BLOB');
  return new Float64Array(Uint8Array.from(value).buffer);
}

export const PROJECT_SLOTS = {
  live: P_LIVE,
  bands: P_BANDS,
  layers: P_LAYERS,
  pinned: P_PINNED,
  embedded: P_EMBEDDED,
  weak: P_WEAK,
  last: P_LAST,
  maxAge: P_MAX_AGE,
  first: P_FIRST,
  days: P_DAYS,
  daysEnd: P_SIZE,
} as const;

export const FILTER_SLOTS = {
  all: F_ALL,
  risk: F_RISK,
  pinned: F_PINNED,
  conflict: F_CONFLICT,
  now: F_NOW,
  in7d: F_7D,
  in30d: F_30D,
} as const;

export { GRID_CELLS };
