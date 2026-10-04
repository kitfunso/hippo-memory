// The dashboard's read model: one in-memory snapshot of a tenant's live memories, grouped by origin project.
// Pure build functions plus one cache; the queries over it live in dashboard-queries.ts.

import * as fs from 'fs';
import * as path from 'path';
import { calculateStrength, confidenceFacets, netWrong, Layer as MemoryLayer, type MemoryEntry } from './memory.js';
import { isQuarantineScope } from './quarantine.js';
import { listMemoryConflicts, loadAllEntries, type MemoryConflict } from './store.js';
import { closeHippoDb, getHippoDbPath, openHippoDbReadOnly, type DatabaseSyncLike } from './db.js';
import { readEmbeddingIdsReadOnly } from './embeddings.js';
import type { Band, ChipCounts, Layer, Overview, ProjectKind, ProjectSummary, ScatterGrid, ScatterPoints } from './dashboard-types.js';

export const DAY_MS = 86_400_000;
export const LAYERS: readonly Layer[] = ['buffer', 'episodic', 'semantic', 'trace'];
// Wire order of `Band`, and the order the mockup sorts bands in.
export const BANDS: readonly Band[] = ['pinned', 'strong', 'fading', 'atRisk'];
const BAND_PINNED = 0;
const BAND_STRONG = 1;
const BAND_FADING = 2;
const BAND_AT_RISK = 3;
const CONFIDENCE_ORDER = ['verified', 'observed', 'inferred', 'stale'];
const HEAD_CHARS = 240;

/** An outside commit rebuilds the snapshot at most this often. */
export const COALESCE_MS = 10_000;
/** Projected strengths track the clock, so the snapshot is rebuilt at least this often. */
export const TTL_MS = 5 * 60_000;

/** The one predicate for "shown on the dashboard": not superseded, not archived, not quarantined. */
export function isLiveMemory(entry: Pick<MemoryEntry, 'superseded_by' | 'kind' | 'scope'>): boolean {
  return !entry.superseded_by && (entry.kind === 'raw' || entry.kind === 'distilled') && !isQuarantineScope(entry.scope);
}

/** Wire key, display name and kind of a project. */
export interface ProjectIdentity {
  key: string;
  name: string;
  kind: ProjectKind;
}

/** Wire key, display name and kind for an `origin_project` value. */
export function projectIdentity(origin: string | null | undefined): ProjectIdentity {
  if (origin === '') return { key: 'global', name: 'Global', kind: 'global' };
  if (origin === null || origin === undefined) return { key: 'unassigned', name: 'Unassigned', kind: 'unassigned' };
  return { key: `p:${origin}`, name: origin, kind: 'project' };
}

/** Index of a layer in the wire order `LAYERS`. */
export function layerIndex(layer: MemoryLayer): number {
  switch (layer) {
    case MemoryLayer.Buffer: return 0;
    case MemoryLayer.Episodic: return 1;
    case MemoryLayer.Semantic: return 2;
    case MemoryLayer.Trace: return 3;
  }
}

/** Per-memory numbers shared by the snapshot build and the single-memory detail route. */
export interface MemoryFacts {
  strength: number;
  strength7d: number;
  strength30d: number;
  band: number;
  layer: number;
  ageDays: number;
  lastRetrievedDays: number;
  confidence: string;
  agedOut: boolean;
  wrong: boolean;
}

function daysBetween(thenIso: string, nowMs: number): number {
  const days = (nowMs - Date.parse(thenIso)) / DAY_MS;
  return Number.isFinite(days) ? Math.max(0, days) : 0;
}

/** Strength now and at +7d and +30d, band, age and the confidence split for one entry at `nowMs`. */
export function memoryFacts(entry: MemoryEntry, nowMs: number): MemoryFacts {
  const now = new Date(nowMs);
  const strength = calculateStrength(entry, now);
  const strength7d = calculateStrength(entry, new Date(nowMs + 7 * DAY_MS));
  const strength30d = calculateStrength(entry, new Date(nowMs + 30 * DAY_MS));
  const facets = confidenceFacets(entry, now);
  const band = entry.pinned ? BAND_PINNED : strength30d < 0.2 ? BAND_AT_RISK : strength >= 0.5 ? BAND_STRONG : BAND_FADING;
  return {
    strength,
    strength7d,
    strength30d,
    band,
    layer: layerIndex(entry.layer),
    ageDays: daysBetween(entry.created, nowMs),
    lastRetrievedDays: daysBetween(entry.last_retrieved, nowMs),
    confidence: facets.tier,
    agedOut: facets.agedOut,
    wrong: netWrong(entry) > 0,
  };
}

/** One live memory as the snapshot holds it: numbers and short strings only, never the full entry. */
export interface Fact {
  id: string;
  head: string;
  truncated: boolean;
  lower: string;
  tagsLower: string;
  layer: number;
  band: number;
  strength: number;
  strength7d: number;
  strength30d: number;
  retrievals: number;
  lastRetrievedDays: number;
  ageDays: number;
  confidence: string;
  confidenceRank: number;
  scope: string | null;
  pinned: boolean;
  wrong: boolean;
  inConflict: boolean;
  embedded: boolean;
  project: number;
  createdMs: number;
}

export interface ProjectAgg {
  summary: ProjectSummary;
  /** Indices into `Snapshot.facts`, in snapshot order. */
  members: Int32Array;
  firstCreatedMs: number;
}

export type Chip = 'all' | 'risk' | 'pinned' | 'conflict';

/** A filtered memory set over one project: indices in sort order, chip counts, decay buckets, and per-chip lists built on demand. */
export interface FilteredSet {
  idx: Int32Array;
  counts: ChipCounts;
  decay: { now: [number, number, number]; in7d: [number, number, number]; in30d: [number, number, number]; pinned: number };
  byChip: Map<Chip, Int32Array>;
}

/** Small least-recently-used map; the oldest entry leaves when it is full. */
export class Lru<V> {
  private readonly entries = new Map<string, V>();
  constructor(private readonly capacity: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }
}

/** Per-snapshot memo of query results; it dies with the snapshot, so no key needs a snapshot id. */
export interface SnapshotMemo {
  sorted: Lru<Int32Array>;
  filtered: Lru<FilteredSet>;
  scatter: Map<string, ScatterPoints | ScatterGrid>;
  overview: Overview | null;
}

export interface Snapshot {
  id: number;
  tenantId: string;
  nowMs: number;
  facts: Fact[];
  projects: ProjectAgg[];
  byKey: Map<string, ProjectAgg>;
  excluded: { superseded: number; archived: number; quarantined: number };
  /** Embedded share of live memories, or null when embeddings.json could not be read. */
  embeddingCoverage: number | null;
  /** Open conflicts with both members live, each counted once. */
  openConflicts: number;
  memo: SnapshotMemo;
}

export interface SnapshotInput {
  id: number;
  tenantId: string;
  nowMs: number;
  entries: readonly MemoryEntry[];
  openConflicts: readonly Pick<MemoryConflict, 'memory_a_id' | 'memory_b_id'>[];
  embeddedIds: ReadonlySet<string> | null;
}

interface CutHead {
  head: string;
  truncated: boolean;
}

function cutHead(content: string): CutHead {
  if (content.length <= HEAD_CHARS) return { head: content, truncated: false };
  let end = HEAD_CHARS;
  const last = content.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { head: content.slice(0, end), truncated: true };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

interface ProjectDraft {
  summary: ProjectSummary;
  members: number[];
  firstCreatedMs: number;
  lastDays: number;
}

function newDraft(identity: { key: string; name: string; kind: ProjectKind }): ProjectDraft {
  return {
    summary: {
      ...identity, live: 0, atRisk: 0, share: 0, pinned: 0, embedded: 0, openConflicts: 0, lastRetrievedDays: null,
      bands: { pinned: 0, strong: 0, fading: 0, atRisk: 0 },
      layers: { buffer: 0, episodic: 0, semantic: 0, trace: 0 },
    },
    members: [],
    firstCreatedMs: Number.POSITIVE_INFINITY,
    lastDays: Number.POSITIVE_INFINITY,
  };
}

/** Builds the snapshot from already-loaded rows; it touches no store, so tests can feed it directly. */
export function buildSnapshot(input: SnapshotInput): Snapshot {
  const { entries, embeddedIds, nowMs } = input;
  const excluded = { superseded: 0, archived: 0, quarantined: 0 };
  const facts: Fact[] = [];
  const projectIndex = new Map<string, number>();
  const drafts: ProjectDraft[] = [];

  for (const entry of entries) {
    if (!isLiveMemory(entry)) {
      if (isQuarantineScope(entry.scope)) excluded.quarantined++;
      else if (entry.superseded_by || entry.kind === 'superseded') excluded.superseded++;
      else if (entry.kind === 'archived') excluded.archived++;
      continue;
    }
    const identity = projectIdentity(entry.origin_project);
    let p = projectIndex.get(identity.key);
    if (p === undefined) {
      p = drafts.length;
      projectIndex.set(identity.key, p);
      drafts.push(newDraft(identity));
    }
    const f = memoryFacts(entry, nowMs);
    const embedded = embeddedIds !== null && embeddedIds.has(entry.id);
    const { head, truncated } = cutHead(entry.content);
    const tier = CONFIDENCE_ORDER.indexOf(f.confidence);
    const parsedCreated = Date.parse(entry.created);
    const draft = drafts[p];
    draft.members.push(facts.length);
    draft.summary.live++;
    draft.summary.bands[BANDS[f.band]]++;
    draft.summary.layers[LAYERS[f.layer]]++;
    if (entry.pinned) draft.summary.pinned++;
    if (embedded) draft.summary.embedded++;
    if (Number.isFinite(parsedCreated) && parsedCreated < draft.firstCreatedMs) draft.firstCreatedMs = parsedCreated;
    if (f.lastRetrievedDays < draft.lastDays) draft.lastDays = f.lastRetrievedDays;
    facts.push({
      id: entry.id,
      head,
      truncated,
      lower: entry.content.toLowerCase(),
      tagsLower: entry.tags.length > 0 ? entry.tags.join('\n').toLowerCase() : '',
      layer: f.layer,
      band: f.band,
      strength: f.strength,
      strength7d: f.strength7d,
      strength30d: f.strength30d,
      retrievals: entry.retrieval_count,
      lastRetrievedDays: f.lastRetrievedDays,
      ageDays: f.ageDays,
      confidence: f.confidence,
      confidenceRank: tier === -1 ? CONFIDENCE_ORDER.length : tier,
      scope: entry.scope,
      pinned: entry.pinned,
      wrong: f.wrong,
      inConflict: false,
      embedded,
      project: p,
      createdMs: Number.isFinite(parsedCreated) ? parsedCreated : nowMs,
    });
  }

  const openConflicts = countOpenConflicts(facts, drafts.map((d) => d.summary), input.openConflicts);

  const projects: ProjectAgg[] = drafts.map((d) => {
    d.summary.atRisk = d.summary.bands.atRisk;
    d.summary.share = d.summary.live > 0 ? d.summary.atRisk / d.summary.live : 0;
    d.summary.lastRetrievedDays = d.summary.live > 0 ? round1(d.lastDays) : null;
    return { summary: d.summary, members: Int32Array.from(d.members), firstCreatedMs: d.firstCreatedMs };
  });
  const embeddedTotal = projects.reduce((sum, p) => sum + p.summary.embedded, 0);

  return {
    id: input.id,
    tenantId: input.tenantId,
    nowMs,
    facts,
    projects,
    byKey: new Map(projects.map((p) => [p.summary.key, p])),
    excluded,
    embeddingCoverage: embeddedIds === null ? null : facts.length > 0 ? embeddedTotal / facts.length : 0,
    openConflicts,
    memo: { sorted: new Lru(8), filtered: new Lru(8), scatter: new Map(), overview: null },
  };
}

// A conflict counts once in each project it touches, and once in the total.
function countOpenConflicts(
  facts: Fact[],
  summaries: ProjectSummary[],
  conflicts: SnapshotInput['openConflicts'],
): number {
  if (conflicts.length === 0) return 0;
  const byId = new Map<string, number>();
  facts.forEach((f, i) => byId.set(f.id, i));
  let total = 0;
  for (const c of conflicts) {
    const a = byId.get(c.memory_a_id);
    const b = byId.get(c.memory_b_id);
    if (a === undefined || b === undefined) continue;
    total++;
    facts[a].inConflict = true;
    facts[b].inConflict = true;
    for (const p of new Set([facts[a].project, facts[b].project])) summaries[p].openConflicts++;
  }
  return total;
}

interface CachedSnapshot {
  snapshot: Snapshot;
  dataVersion: number | null;
  embeddingsKey: string;
  builtAtMs: number;
}

export interface SnapshotService {
  /** The cached snapshot, or a new build when the cache key changed, the coalescing window allows it, or `fresh` is set. */
  get(tenantId: string, fresh?: boolean): Snapshot;
  /** Drops the cache after a dashboard write commits, so the next read rebuilds. */
  invalidate(): void;
  /** Id of the most recent build, which is what a client holding the last response still has. */
  currentId(): number;
  /** Ids with a vector as of the last build (a direct read before any build), so a detail read never re-parses embeddings.json. */
  embeddedIds(): ReadonlySet<string> | null;
  close(): void;
}

function embeddingsKey(hippoRoot: string): string {
  try {
    const stat = fs.statSync(path.join(hippoRoot, 'embeddings.json'));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'ENOENT' ? 'none' : 'unreadable';
  }
}

// Keeps ids rising between two services created in the same millisecond of one process.
let highestIssuedId = 0;

/** Holds one read-only connection for its commit signal (`PRAGMA data_version`) and the snapshot cache; `now` is the clock seam. */
export function createSnapshotService(hippoRoot: string, now: () => number): SnapshotService {
  let db: DatabaseSyncLike | null = null;
  let cached: CachedSnapshot | null = null;
  // Wall clock, not `now`, so ids keep rising across server restarts and a client holding an old tab never sees a lower one.
  let lastId = Math.max(Date.now(), highestIssuedId);
  let lastEmbeddedIds: ReadonlySet<string> | null | undefined;

  const dataVersion = (): number | null => {
    if (db === null) {
      if (!fs.existsSync(getHippoDbPath(hippoRoot))) return null;
      db = openHippoDbReadOnly(hippoRoot);
    }
    // SAFETY: PRAGMA data_version returns one row with that single integer column.
    const row = db.prepare('PRAGMA data_version').get() as { data_version: number };
    return row.data_version;
  };

  const build = (tenantId: string, dv: number | null, nowMs: number): Snapshot => {
    const entries = dv === null ? [] : loadAllEntries(hippoRoot, tenantId);
    const openConflicts = dv === null ? [] : listMemoryConflicts(hippoRoot, 'open', tenantId);
    lastId += 1;
    highestIssuedId = Math.max(highestIssuedId, lastId);
    lastEmbeddedIds = readEmbeddingIdsReadOnly(hippoRoot);
    return buildSnapshot({ id: lastId, tenantId, nowMs, entries, openConflicts, embeddedIds: lastEmbeddedIds });
  };

  return {
    get(tenantId, fresh = false) {
      const nowMs = now();
      // Read before the build, so a commit that lands during it shows on the next read.
      const dv = dataVersion();
      const emb = embeddingsKey(hippoRoot);
      const hit = cached;
      if (hit !== null && !fresh) {
        const age = nowMs - hit.builtAtMs;
        // An embeddings.json rewrite rides the same coalescing window as a commit: every remember rewrites it.
        const reusable = hit.snapshot.tenantId === tenantId
          && (hit.dataVersion !== null || dv === null)
          && age < TTL_MS
          && ((hit.dataVersion === dv && hit.embeddingsKey === emb) || age < COALESCE_MS);
        if (reusable) return hit.snapshot;
      }
      const snapshot = build(tenantId, dv, nowMs);
      cached = { snapshot, dataVersion: dv, embeddingsKey: emb, builtAtMs: nowMs };
      return snapshot;
    },
    invalidate() {
      cached = null;
    },
    currentId() {
      return lastId;
    },
    embeddedIds() {
      return lastEmbeddedIds === undefined ? readEmbeddingIdsReadOnly(hippoRoot) : lastEmbeddedIds;
    },
    close() {
      if (db !== null) closeHippoDb(db);
      db = null;
      cached = null;
      lastEmbeddedIds = undefined;
    },
  };
}
