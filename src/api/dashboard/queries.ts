// One page of a project's memories and the cross-project search, each one bounded store read at the stamp's instant.
import { round1 } from '../../base/util/format.js';
import type { DashboardReads, DashboardSortKey, ListedRow } from '../../store/port/dashboard-reads.js';
import { BANDS, LAYERS, originOfKey, projectIdentity, round3, type Chip } from './live.js';
import type { Stamp } from './snapshot-clock.js';
import type { MemoryPage, MemoryRow, SearchResult } from './types.js';

export const SORT_KEYS = [
  'content',
  'layer',
  'strength',
  'retrievals',
  'last',
  'age',
  'confidence',
  'scope',
] as const satisfies readonly DashboardSortKey[];
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

const NAME_MATCHES = 3;

function toRow(row: ListedRow): MemoryRow {
  const f = row.facts;
  return {
    id: row.id,
    content: row.head,
    truncated: row.truncated,
    layer: LAYERS[f.layer],
    band: BANDS[f.band],
    strength: round3(f.strength),
    retrievals: row.retrievals,
    lastRetrievedDays: round1(f.lastRetrievedDays),
    ageDays: round1(f.ageDays),
    confidence: f.confidence,
    scope: row.scope,
    pinned: row.pinned,
    wrong: f.wrong,
    inConflict: row.inConflict,
  };
}

/** One page of a project's memories under the query's sort and filters, or null when the key is unknown. */
export async function buildMemoryPage(
  reads: Pick<DashboardReads, 'memoryPage'>,
  stamp: Stamp,
  key: string,
  query: MemoryQuery,
): Promise<MemoryPage | null> {
  const origin = originOfKey(key);
  if (origin === undefined) return null;
  const { brush } = query;
  const read = await reads.memoryPage(
    stamp.tenantId,
    {
      origin,
      layers: query.layers,
      minAgeDays: brush.amin,
      maxAgeDays: brush.amax,
      minStrength: brush.smin,
      maxStrength: brush.smax,
      text: query.q,
      sort: query.sort,
      descending: query.dir === 'desc',
      chip: query.chip,
      offset: query.offset,
      limit: query.limit,
    },
    stamp.nowMs,
  );
  if (read === null) return null;
  const { counts, decay } = read.tally;
  return {
    snapshotId: stamp.id,
    total: counts[query.chip],
    offset: query.offset,
    limit: query.limit,
    counts,
    decay,
    rows: read.rows.map(toRow),
  };
}

/** Substring search over content and tags across every project; it reads the store and never touches recall. */
export async function buildSearch(
  reads: Pick<DashboardReads, 'search'>,
  stamp: Stamp,
  text: string,
): Promise<SearchResult> {
  const needle = text.toLowerCase();
  const projects = (await reads.search(stamp.tenantId, needle)).map((t) => ({ ...t, ...projectIdentity(t.origin) }));
  const hits: Record<string, number> = {};
  for (const p of projects) if (p.hits > 0) hits[p.key] = p.hits;
  const nameMatches = projects
    .filter((p) => p.name.toLowerCase().includes(needle))
    .sort((a, b) => b.live - a.live)
    .slice(0, NAME_MATCHES)
    .map((p) => ({ key: p.key, name: p.name, live: p.live }));
  const total = projects.reduce((sum, p) => sum + p.hits, 0);
  return { snapshotId: stamp.id, q: text, total, hits, nameMatches };
}
