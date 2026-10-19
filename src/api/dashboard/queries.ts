// Read models over a snapshot: overview, project, memory page, search, and the fresh single-memory detail.

import { calculateStrength, type MemoryEntry } from '../../core/memory.js';
import type { HippoStore, StoreGroups } from '../../store/port.js';
import type { ConflictPair, DashboardText } from '../../store/port/dashboard-reads.js';
import {
  BANDS,
  DAY_MS,
  LAYERS,
  isLiveMemory,
  memoryFacts,
  projectIdentity,
  type Chip,
  type Fact,
  type FilteredSet,
  type ProjectAgg,
  type Snapshot,
} from './snapshot.js';
import { AT_RISK_BELOW, STRONG_FROM } from '../../core/strength-bands.js';
import { chunked } from '../../util/chunked.js';
import { pct, plural, round1 } from '../../util/format.js';
import type {
  ChipCounts,
  DecayOutlook,
  Kpi,
  MemoryConflictDetail,
  MemoryDetail,
  MemoryPage,
  MemoryRow,
  Overview,
  ProjectDetail,
  ScatterGrid,
  ScatterPoints,
  SearchResult,
} from './types.js';

export const SORT_KEYS = ['content', 'layer', 'strength', 'retrievals', 'last', 'age', 'confidence', 'scope'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

interface Brush {
  amin: number;
  amax: number;
  smin: number;
  smax: number;
}

/** A parsed memory page query; the dashboard's params parser builds it from the URL. */
export interface MemoryQuery {
  offset: number;
  limit: number;
  sort: SortKey;
  dir: SortDir;
  chip: Chip;
  /** Layer indices in wire order, ascending, no duplicates. */
  layers: number[];
  brush: Brush;
  /** Lowercased search text, or null when none or shorter than the minimum. */
  q: string | null;
}

const SERIES_DAYS = 90;
/** The server words each delta for this range; the client re-slices the series for 7d and 90d. */
const DELTA_DAYS = 30;
const POINTS_MAX = 4_000;
const GRID_COLS = 64;
const GRID_ROWS = 32;
const NAME_MATCHES = 3;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Cumulative counts at 91 daily points, oldest first: point 0 is the base at the window start, point 90 is now. */
function cumulativeSeries(times: Iterable<number>, nowMs: number): number[] {
  const days = Array.from({ length: SERIES_DAYS + 1 }, () => 0);
  let base = 0;
  for (const t of times) {
    const ago = Math.floor((nowMs - t) / DAY_MS);
    if (ago >= SERIES_DAYS) base++;
    else days[SERIES_DAYS - Math.max(0, ago)]++;
  }
  let running = base;
  return days.map((n) => (running += n));
}

function addedWithin(series: number[]): number {
  return series[SERIES_DAYS] - series[SERIES_DAYS - DELTA_DAYS];
}

/** Named projects by size, then Global, then Unassigned, as the treemap orders them. */
function orderedProjects(snap: Snapshot): ProjectAgg[] {
  const rank = (p: ProjectAgg): number => (p.summary.kind === 'project' ? 0 : p.summary.kind === 'global' ? 1 : 2);
  return [...snap.projects].sort(
    (a, b) => rank(a) - rank(b) || b.summary.live - a.summary.live || (a.summary.name < b.summary.name ? -1 : 1),
  );
}

function healthKpis(snap: Snapshot, total: number, withConflicts: number): Kpi[] {
  const embedded = snap.embeddingCoverage === null ? 0 : Math.round(snap.embeddingCoverage * total);
  return [
    {
      id: 'openConflicts',
      label: 'Open conflicts',
      value: snap.openConflicts,
      series: null,
      delta: `in ${plural(withConflicts, 'project')}`,
    },
    {
      id: 'embeddingCoverage',
      label: 'Embedding coverage',
      value: snap.embeddingCoverage ?? 0,
      series: null,
      delta: snap.embeddingCoverage === null ? 'no vector table yet' : `${total - embedded} not embedded`,
    },
  ];
}

function buildKpis(snap: Snapshot, projects: ProjectAgg[]): Kpi[] {
  const total = snap.facts.length;
  const named = projects.filter((p) => p.summary.kind === 'project');
  const totalSeries = cumulativeSeries(
    snap.facts.map((f) => f.createdMs),
    snap.nowMs,
  );
  const projectSeries = cumulativeSeries(
    named.map((p) => p.firstCreatedMs),
    snap.nowMs,
  );
  const atRisk = projects.reduce((sum, p) => sum + p.summary.atRisk, 0);
  const weakNow = snap.facts.reduce((sum, f) => sum + (f.strength < AT_RISK_BELOW ? 1 : 0), 0);
  const withConflicts = projects.filter((p) => p.summary.openConflicts > 0).length;
  return [
    {
      id: 'total',
      label: 'Total memories',
      value: total,
      series: totalSeries,
      delta: `+${addedWithin(totalSeries)} created in the last ${DELTA_DAYS}d`,
    },
    {
      id: 'projects',
      label: 'Projects',
      value: named.length,
      series: projectSeries,
      delta: `+${addedWithin(projectSeries)} new in ${DELTA_DAYS}d`,
    },
    {
      id: 'atRiskShare',
      label: 'At-risk share, 30d',
      value: total > 0 ? atRisk / total : 0,
      series: null,
      delta: `${pct(total > 0 ? weakNow / total : 0)} now at strength under ${AT_RISK_BELOW}`,
    },
    ...healthKpis(snap, total, withConflicts),
  ];
}

function topKeys(projects: ProjectAgg[], count: number, score: (p: ProjectAgg) => number): string[] {
  return projects
    .filter((p) => score(p) > 0)
    .sort((a, b) => score(b) - score(a) || b.summary.live - a.summary.live || (a.summary.key < b.summary.key ? -1 : 1))
    .slice(0, count)
    .map((p) => p.summary.key);
}

/** The overview of one snapshot, built once and reused until the snapshot is replaced. */
export function buildOverview(snap: Snapshot): Overview {
  if (snap.memo.overview !== null) return snap.memo.overview;
  const ordered = orderedProjects(snap);
  const overview: Overview = {
    snapshotId: snap.id,
    generatedAt: new Date(snap.nowMs).toISOString(),
    total: snap.facts.length,
    excluded: snap.excluded,
    embeddingCoverage: snap.embeddingCoverage,
    kpis: buildKpis(snap, ordered),
    projects: ordered.map((p) => p.summary),
    mostAtRisk: topKeys(ordered, 5, (p) => p.summary.atRisk),
    mostConflicts: topKeys(ordered, 4, (p) => p.summary.openConflicts),
  };
  snap.memo.overview = overview;
  return overview;
}

function buildScatter(snap: Snapshot, project: ProjectAgg): ScatterPoints | ScatterGrid {
  const cached = snap.memo.scatter.get(project.summary.key);
  if (cached) return cached;
  let maxAge = 0;
  for (const i of project.members) maxAge = Math.max(maxAge, snap.facts[i].ageDays);
  const maxAgeDays = Math.max(1, Math.ceil(maxAge));
  let scatter: ScatterPoints | ScatterGrid;
  if (project.members.length <= POINTS_MAX) {
    const points: ScatterPoints['points'] = [];
    const ids: string[] = [];
    for (const i of project.members) {
      const f = snap.facts[i];
      points.push([round1(f.ageDays), round3(f.strength), f.layer, f.band]);
      ids.push(f.id);
    }
    scatter = { mode: 'points', maxAgeDays, points, ids };
  } else {
    const cells: ScatterGrid['cells'] = [[], [], [], []];
    for (const layer of cells) for (let k = 0; k < GRID_COLS * GRID_ROWS; k++) layer.push(0);
    const maxLog = Math.log10(maxAgeDays + 1);
    for (const i of project.members) {
      const f = snap.facts[i];
      const col = Math.min(GRID_COLS - 1, Math.floor((Math.log10(f.ageDays + 1) / maxLog) * GRID_COLS));
      const row = Math.min(GRID_ROWS - 1, Math.floor(f.strength * GRID_ROWS));
      cells[f.layer][row * GRID_COLS + col]++;
    }
    scatter = { mode: 'grid', maxAgeDays, cols: GRID_COLS, rows: GRID_ROWS, cells };
  }
  snap.memo.scatter.set(project.summary.key, scatter);
  return scatter;
}

/** Summary and scatter for one project key, or null when the key is unknown. */
export function buildProjectDetail(snap: Snapshot, key: string): ProjectDetail | null {
  const project = snap.byKey.get(key);
  if (!project) return null;
  return { snapshotId: snap.id, summary: project.summary, scatter: buildScatter(snap, project) };
}

function numericSort(sort: SortKey): ((f: Fact) => number) | null {
  switch (sort) {
    case 'layer':
      return (f) => f.layer;
    case 'strength':
      return (f) => f.strength;
    case 'retrievals':
      return (f) => f.retrievals;
    case 'last':
      return (f) => f.lastRetrievedDays;
    case 'age':
      return (f) => f.ageDays;
    case 'confidence':
      return (f) => f.confidenceRank;
    case 'content':
    case 'scope':
      return null;
  }
}

/** Each member's head in lower case, keyed by fact index; the content sort orders on the head the list shows. */
function lowerHeads(facts: Fact[], members: Int32Array): (i: number) => string {
  const lower = new Map<number, string>();
  for (const i of members) lower.set(i, facts[i].head.toLowerCase());
  return (i) => lower.get(i) ?? '';
}

function comparator(facts: Fact[], members: Int32Array, sort: SortKey, dir: SortDir): (a: number, b: number) => number {
  const sign = dir === 'asc' ? 1 : -1;
  const tie = (a: number, b: number): number => (facts[a].id < facts[b].id ? -1 : facts[a].id > facts[b].id ? 1 : 0);
  const num = numericSort(sort);
  if (num) return (a, b) => (num(facts[a]) - num(facts[b])) * sign || tie(a, b);
  // Content and scope compare precomputed strings with `<`; localeCompare per pair is far slower at 50k rows.
  const text = sort === 'content' ? lowerHeads(facts, members) : (i: number) => facts[i].scope ?? '';
  return (a, b) => {
    const x = text(a);
    const y = text(b);
    return (x < y ? -sign : x > y ? sign : 0) || tie(a, b);
  };
}

function sortedMembers(snap: Snapshot, project: ProjectAgg, sort: SortKey, dir: SortDir): Int32Array {
  const key = `${project.summary.key}|${sort}|${dir}`;
  const hit = snap.memo.sorted.get(key);
  if (hit) return hit;
  const sorted = Int32Array.from(project.members).sort(comparator(snap.facts, project.members, sort, dir));
  snap.memo.sorted.set(key, sorted);
  return sorted;
}

function bucket(value: number): 0 | 1 | 2 {
  return value >= STRONG_FROM ? 0 : value >= AT_RISK_BELOW ? 1 : 2;
}

function holdsText(row: DashboardText, needle: string): boolean {
  return (
    row.content.toLowerCase().includes(needle) ||
    (row.tags.length > 0 && row.tags.join('\n').toLowerCase().includes(needle))
  );
}

/** A 1 at each fact whose whole text or tags hold `needle`, from one paged read of the tenant's text per needle. */
function textMatches(snap: Snapshot, needle: string): Uint8Array {
  const hit = snap.memo.text.get(needle);
  if (hit) return hit;
  const mask = new Uint8Array(snap.facts.length);
  snap.scanText((page) => {
    for (const row of page) {
      const i = snap.indexOf.get(row.id);
      if (i !== undefined && holdsText(row, needle)) mask[i] = 1;
    }
  });
  snap.memo.text.set(needle, mask);
  return mask;
}

function filterMembers(snap: Snapshot, sorted: Int32Array, query: MemoryQuery): FilteredSet {
  const layerOn = [false, false, false, false];
  for (const l of query.layers) layerOn[l] = true;
  const { brush, q } = query;
  const matches = q === null ? null : textMatches(snap, q);
  const kept = new Int32Array(sorted.length);
  let n = 0;
  const counts: ChipCounts = { all: 0, risk: 0, pinned: 0, conflict: 0 };
  const decay: FilteredSet['decay'] = { now: [0, 0, 0], in7d: [0, 0, 0], in30d: [0, 0, 0], pinned: 0 };
  for (const i of sorted) {
    const f = snap.facts[i];
    if (!layerOn[f.layer]) continue;
    if (f.ageDays < brush.amin || f.ageDays > brush.amax || f.strength < brush.smin || f.strength > brush.smax) {
      continue;
    }
    if (matches !== null && matches[i] === 0) continue;
    kept[n++] = i;
    decay.now[bucket(f.strength)]++;
    decay.in7d[bucket(f.strength7d)]++;
    decay.in30d[bucket(f.strength30d)]++;
    if (f.pinned) {
      decay.pinned++;
      counts.pinned++;
    }
    if (f.band === 3) counts.risk++;
    if (f.inConflict) counts.conflict++;
    counts.all++;
  }
  return { idx: kept.subarray(0, n), counts, decay, byChip: new Map() };
}

function filteredSet(snap: Snapshot, project: ProjectAgg, query: MemoryQuery): FilteredSet {
  const { brush } = query;
  const key = [
    project.summary.key,
    query.sort,
    query.dir,
    query.layers.join(''),
    brush.amin,
    brush.amax,
    brush.smin,
    brush.smax,
    query.q ?? '',
  ].join('|');
  const hit = snap.memo.filtered.get(key);
  if (hit) return hit;
  const set = filterMembers(snap, sortedMembers(snap, project, query.sort, query.dir), query);
  snap.memo.filtered.set(key, set);
  return set;
}

function chipMembers(snap: Snapshot, set: FilteredSet, chip: Chip): Int32Array {
  if (chip === 'all') return set.idx;
  const hit = set.byChip.get(chip);
  if (hit) return hit;
  const pick = (f: Fact): boolean => (chip === 'risk' ? f.band === 3 : chip === 'pinned' ? f.pinned : f.inConflict);
  const out = set.idx.filter((i) => pick(snap.facts[i]));
  set.byChip.set(chip, out);
  return out;
}

function toRow(f: Fact): MemoryRow {
  return {
    id: f.id,
    content: f.head,
    truncated: f.truncated,
    layer: LAYERS[f.layer],
    band: BANDS[f.band],
    strength: round3(f.strength),
    retrievals: f.retrievals,
    lastRetrievedDays: round1(f.lastRetrievedDays),
    ageDays: round1(f.ageDays),
    confidence: f.confidence,
    scope: f.scope,
    pinned: f.pinned,
    wrong: f.wrong,
    inConflict: f.inConflict,
  };
}

/** One page of a project's memories under the query's sort and filters, or null when the key is unknown. */
export function buildMemoryPage(snap: Snapshot, key: string, query: MemoryQuery): MemoryPage | null {
  const project = snap.byKey.get(key);
  if (!project) return null;
  const set = filteredSet(snap, project, query);
  const shown = chipMembers(snap, set, query.chip);
  const rows: MemoryRow[] = [];
  for (let k = query.offset; k < Math.min(shown.length, query.offset + query.limit); k++) {
    rows.push(toRow(snap.facts[shown[k]]));
  }
  const decay: DecayOutlook = set.decay;
  return {
    snapshotId: snap.id,
    total: shown.length,
    offset: query.offset,
    limit: query.limit,
    counts: set.counts,
    decay,
    rows,
  };
}

/** Substring search over content and tags across every project; it reads the snapshot and never touches recall. */
export function buildSearch(snap: Snapshot, text: string): SearchResult {
  const needle = text.toLowerCase();
  const perProject = Array.from({ length: snap.projects.length }, () => 0);
  const matches = textMatches(snap, needle);
  let total = 0;
  snap.facts.forEach((f, i) => {
    if (matches[i] === 0) return;
    perProject[f.project]++;
    total++;
  });
  const hits: Record<string, number> = {};
  snap.projects.forEach((p, i) => {
    if (perProject[i] > 0) hits[p.summary.key] = perProject[i];
  });
  const nameMatches = snap.projects
    .filter((p) => p.summary.name.toLowerCase().includes(needle))
    .sort((a, b) => b.summary.live - a.summary.live)
    .slice(0, NAME_MATCHES)
    .map((p) => ({ key: p.summary.key, name: p.summary.name, live: p.summary.live }));
  return { snapshotId: snap.id, q: text, total, hits, nameMatches };
}

/** The store the detail reads: its rows by id, and the dashboard's conflict read. */
export type DetailStore = Pick<HippoStore, 'entriesByIds'> & Pick<StoreGroups, 'localFiles'>;

async function openConflictsOf(
  store: DetailStore,
  tenantId: string,
  entry: MemoryEntry,
  nowMs: number,
): Promise<MemoryConflictDetail[]> {
  const conflicts = store.localFiles.dashboard.openConflictsOf(tenantId, entry.id).map((row) => row.conflict);
  const otherId = (c: ConflictPair): string => (c.memory_a_id === entry.id ? c.memory_b_id : c.memory_a_id);
  const others = new Map<string, MemoryEntry>();
  for (const ids of chunked([...new Set(conflicts.map(otherId))])) {
    for (const other of await store.entriesByIds(ids, tenantId)) others.set(other.id, other);
  }
  const out: MemoryConflictDetail[] = [];
  for (const c of conflicts) {
    const other = others.get(otherId(c));
    if (!other || !isLiveMemory(other)) continue;
    const strength = round3(calculateStrength(other, new Date(nowMs)));
    out.push({
      id: c.id,
      reason: c.reason,
      score: c.score,
      other: { id: other.id, content: other.content, strength, retrievals: other.retrievalCount },
    });
  }
  return out;
}

export interface MemoryDetailOptions {
  readonly snapshotId: number;
  readonly nowMs: number;
  readonly embedded: boolean;
}

/** Full detail read fresh from the store, never from the snapshot, so the drawer is current inside the coalescing
 * window. */
export async function buildMemoryDetail(
  store: DetailStore,
  tenantId: string,
  entry: MemoryEntry,
  options: MemoryDetailOptions,
): Promise<MemoryDetail> {
  const { snapshotId, nowMs, embedded } = options;
  const f = memoryFacts(entry, nowMs);
  const project = projectIdentity(entry.originProject);
  return {
    snapshotId,
    id: entry.id,
    content: entry.content,
    layer: LAYERS[f.layer],
    band: BANDS[f.band],
    tags: entry.tags,
    strength: round3(f.strength),
    strength7d: round3(f.strength7d),
    strength30d: round3(f.strength30d),
    halfLifeDays: entry.halfLifeDays,
    retrievals: entry.retrievalCount,
    lastRetrieved: entry.lastRetrieved,
    created: entry.created,
    ageDays: round1(f.ageDays),
    schemaFit: entry.schemaFit,
    valence: entry.emotionalValence,
    confidence: f.confidence,
    agedOut: f.agedOut,
    pinned: entry.pinned,
    wrong: f.wrong,
    projectKey: project.key,
    projectName: project.name,
    scope: entry.scope,
    tenant: entry.tenantId,
    kind: entry.kind,
    embedded,
    conflicts: await openConflictsOf(store, tenantId, entry, nowMs),
  };
}
