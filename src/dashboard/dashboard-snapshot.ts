// The dashboard's read model: one in-memory snapshot of a tenant's live memories, grouped by origin project.
// Pure build functions plus one cache; the queries over it live in dashboard-queries.ts.

import {
  calculateStrength,
  confidenceFacets,
  netWrong,
  Layer as MemoryLayer,
  type ConfidenceInputs,
  type MemoryEntry,
  type StrengthInputs,
} from '../core/memory.js';
import { isQuarantineScope } from '../trust/quarantine.js';
import type {
  ConflictPair,
  DashboardReads,
  DashboardRow,
  DashboardText,
  ExcludedCounts,
} from '../store/port/dashboard-reads.js';
import type {
  Band,
  ChipCounts,
  Layer,
  Overview,
  ProjectKind,
  ProjectSummary,
  ScatterGrid,
  ScatterPoints,
} from './dashboard-types.js';
import { DAY_MS } from '../util/time.js';
import { round1 } from '../util/format.js';

export { DAY_MS };
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
const COALESCE_MS = 10_000;
/** Projected strengths track the clock, so the snapshot is rebuilt at least this often. */
const TTL_MS = 5 * 60_000;

/** The one predicate for "shown on the dashboard": not superseded, not archived, not quarantined. */
export function isLiveMemory(entry: Pick<MemoryEntry, 'superseded_by' | 'kind' | 'scope'>): boolean {
  return (
    !entry.superseded_by && (entry.kind === 'raw' || entry.kind === 'distilled') && !isQuarantineScope(entry.scope)
  );
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
    case MemoryLayer.Buffer:
      return 0;
    case MemoryLayer.Episodic:
      return 1;
    case MemoryLayer.Semantic:
      return 2;
    case MemoryLayer.Trace:
      return 3;
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
export function memoryFacts(
  entry: StrengthInputs & ConfidenceInputs & Pick<MemoryEntry, 'layer'>,
  nowMs: number,
): MemoryFacts {
  const now = new Date(nowMs);
  const strength = calculateStrength(entry, now);
  const strength7d = calculateStrength(entry, new Date(nowMs + 7 * DAY_MS));
  const strength30d = calculateStrength(entry, new Date(nowMs + 30 * DAY_MS));
  const facets = confidenceFacets(entry, now);
  const band = entry.pinned
    ? BAND_PINNED
    : strength30d < 0.2
      ? BAND_AT_RISK
      : strength >= 0.5
        ? BAND_STRONG
        : BAND_FADING;
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

/** One live memory as the snapshot holds it: numbers and short strings only, never the whole text. */
export interface Fact {
  id: string;
  head: string;
  truncated: boolean;
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
  decay: {
    now: [number, number, number];
    in7d: [number, number, number];
    in30d: [number, number, number];
    pinned: number;
  };
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
  /** Per needle, a 1 at each fact whose whole text or tags hold it. */
  text: Lru<Uint8Array>;
  scatter: Map<string, ScatterPoints | ScatterGrid>;
  overview: Overview | null;
}

/** Visits the tenant's live rows' whole text a page at a time. */
export type TextScan = (visit: (page: readonly DashboardText[]) => void) => void;

export interface Snapshot {
  id: number;
  tenantId: string;
  nowMs: number;
  facts: Fact[];
  projects: ProjectAgg[];
  byKey: Map<string, ProjectAgg>;
  excluded: ExcludedCounts;
  /** Embedded share of live memories, or null when the store has no vector table yet. */
  embeddingCoverage: number | null;
  /** Open conflicts with both members live, each counted once. */
  openConflicts: number;
  /** Index into `facts` of each live id. */
  indexOf: ReadonlyMap<string, number>;
  /** Read at query time by search and the text filter, so no snapshot holds whole contents. */
  scanText: TextScan;
  memo: SnapshotMemo;
}

export interface SnapshotInput {
  id: number;
  tenantId: string;
  nowMs: number;
  entries: readonly DashboardRow[];
  /** Rows counted out before `entries` was read; any entry here that is not live adds to them. */
  excluded?: ExcludedCounts;
  openConflicts: readonly ConflictPair[];
  scanText: TextScan;
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

interface ProjectDraft {
  summary: ProjectSummary;
  members: number[];
  firstCreatedMs: number;
  lastDays: number;
}

function newDraft(identity: { key: string; name: string; kind: ProjectKind }): ProjectDraft {
  return {
    summary: {
      ...identity,
      live: 0,
      atRisk: 0,
      share: 0,
      pinned: 0,
      embedded: 0,
      openConflicts: 0,
      lastRetrievedDays: null,
      bands: { pinned: 0, strong: 0, fading: 0, atRisk: 0 },
      layers: { buffer: 0, episodic: 0, semantic: 0, trace: 0 },
    },
    members: [],
    firstCreatedMs: Number.POSITIVE_INFINITY,
    lastDays: Number.POSITIVE_INFINITY,
  };
}

function toFact(row: DashboardRow, f: MemoryFacts, project: number, createdMs: number): Fact {
  const { head, truncated } = cutHead(row.head);
  const tier = CONFIDENCE_ORDER.indexOf(f.confidence);
  return {
    id: row.id,
    head,
    truncated,
    layer: f.layer,
    band: f.band,
    strength: f.strength,
    strength7d: f.strength7d,
    strength30d: f.strength30d,
    retrievals: row.retrieval_count,
    lastRetrievedDays: f.lastRetrievedDays,
    ageDays: f.ageDays,
    confidence: f.confidence,
    confidenceRank: tier === -1 ? CONFIDENCE_ORDER.length : tier,
    scope: row.scope,
    pinned: row.pinned,
    wrong: f.wrong,
    inConflict: false,
    embedded: row.embedded,
    project,
    createdMs,
  };
}

function tallyExcluded(entry: Pick<MemoryEntry, 'superseded_by' | 'kind' | 'scope'>, excluded: ExcludedCounts): void {
  if (isQuarantineScope(entry.scope)) excluded.quarantined++;
  else if (entry.superseded_by || entry.kind === 'superseded') excluded.superseded++;
  else if (entry.kind === 'archived') excluded.archived++;
}

function draftIndexFor(identity: ProjectIdentity, projectIndex: Map<string, number>, drafts: ProjectDraft[]): number {
  let p = projectIndex.get(identity.key);
  if (p === undefined) {
    p = drafts.length;
    projectIndex.set(identity.key, p);
    drafts.push(newDraft(identity));
  }
  return p;
}

function finishProject(d: ProjectDraft): ProjectAgg {
  d.summary.atRisk = d.summary.bands.atRisk;
  d.summary.share = d.summary.live > 0 ? d.summary.atRisk / d.summary.live : 0;
  d.summary.lastRetrievedDays = d.summary.live > 0 ? round1(d.lastDays) : null;
  return { summary: d.summary, members: Int32Array.from(d.members), firstCreatedMs: d.firstCreatedMs };
}

/** Folds rows, then open conflicts, into a snapshot one at a time, so a build holds no page past its fold. */
class SnapshotDraft {
  private readonly facts: Fact[] = [];
  private readonly indexOf = new Map<string, number>();
  private readonly projectIndex = new Map<string, number>();
  private readonly drafts: ProjectDraft[] = [];
  private openConflicts = 0;

  constructor(
    private readonly nowMs: number,
    private readonly excluded: ExcludedCounts,
  ) {}

  addRow(row: DashboardRow): void {
    if (!isLiveMemory(row)) return tallyExcluded(row, this.excluded);
    const p = draftIndexFor(projectIdentity(row.origin_project), this.projectIndex, this.drafts);
    const f = memoryFacts(row, this.nowMs);
    const parsedCreated = Date.parse(row.created);
    const draft = this.drafts[p];
    draft.members.push(this.facts.length);
    draft.summary.live++;
    draft.summary.bands[BANDS[f.band]]++;
    draft.summary.layers[LAYERS[f.layer]]++;
    if (row.pinned) draft.summary.pinned++;
    if (row.embedded) draft.summary.embedded++;
    if (Number.isFinite(parsedCreated) && parsedCreated < draft.firstCreatedMs) draft.firstCreatedMs = parsedCreated;
    if (f.lastRetrievedDays < draft.lastDays) draft.lastDays = f.lastRetrievedDays;
    this.indexOf.set(row.id, this.facts.length);
    this.facts.push(toFact(row, f, p, Number.isFinite(parsedCreated) ? parsedCreated : this.nowMs));
  }

  // A conflict counts once in each project it touches, and once in the total.
  addConflict(pair: ConflictPair): void {
    const a = this.indexOf.get(pair.memory_a_id);
    const b = this.indexOf.get(pair.memory_b_id);
    if (a === undefined || b === undefined) return;
    const { facts } = this;
    this.openConflicts++;
    facts[a].inConflict = true;
    facts[b].inConflict = true;
    for (const p of new Set([facts[a].project, facts[b].project])) this.drafts[p].summary.openConflicts++;
  }

  addExcluded(counts: ExcludedCounts): void {
    this.excluded.superseded += counts.superseded;
    this.excluded.archived += counts.archived;
    this.excluded.quarantined += counts.quarantined;
  }

  finish(id: number, tenantId: string, scanText: TextScan): Snapshot {
    const { facts, nowMs } = this;
    const projects = this.drafts.map(finishProject);
    const embeddedTotal = projects.reduce((sum, p) => sum + p.summary.embedded, 0);
    return {
      id,
      tenantId,
      nowMs,
      facts,
      projects,
      byKey: new Map(projects.map((p) => [p.summary.key, p])),
      excluded: this.excluded,
      embeddingCoverage: facts.length > 0 ? embeddedTotal / facts.length : 0,
      openConflicts: this.openConflicts,
      indexOf: this.indexOf,
      scanText,
      memo: { sorted: new Lru(8), filtered: new Lru(8), text: new Lru(8), scatter: new Map(), overview: null },
    };
  }
}

const noneExcluded = (): ExcludedCounts => ({ superseded: 0, archived: 0, quarantined: 0 });

/** Builds the snapshot from already-loaded rows; it touches no store, so tests can feed it directly. */
export function buildSnapshot(input: SnapshotInput): Snapshot {
  const draft = new SnapshotDraft(input.nowMs, { ...noneExcluded(), ...input.excluded });
  for (const row of input.entries) draft.addRow(row);
  for (const pair of input.openConflicts) draft.addConflict(pair);
  return draft.finish(input.id, input.tenantId, input.scanText);
}

interface CachedSnapshot {
  snapshot: Snapshot;
  dataVersion: number | null;
  builtAtMs: number;
}

function cacheStillServes(
  hit: CachedSnapshot,
  want: { tenantId: string; dataVersion: number | null },
  wallMs: number,
): boolean {
  const age = wallMs - hit.builtAtMs;
  return (
    hit.snapshot.tenantId === want.tenantId &&
    (hit.dataVersion !== null || want.dataVersion === null) &&
    age < TTL_MS &&
    (hit.dataVersion === want.dataVersion || age < COALESCE_MS)
  );
}

export interface SnapshotService {
  /** The cached snapshot, or a new build when the cache key changed, the coalescing window allows it, or `fresh` is set. */
  get(tenantId: string, fresh?: boolean): Snapshot;
  /** Drops the cache after a dashboard write commits, so the next read rebuilds. */
  invalidate(): void;
  /** Id of the most recent build, which is what a client holding the last response still has. */
  currentId(): number;
  /** A live row of the last build answers as of that build; any other id reads the vector table. */
  isEmbedded(id: string): boolean;
  close(): void;
}

// Keeps ids rising between two services created in the same millisecond of one process.
let highestIssuedId = 0;

class SnapshotCacheService implements SnapshotService {
  private cached: CachedSnapshot | null = null;
  // Wall clock, not `now`, so ids keep rising across server restarts and a client holding an old tab never sees a lower one.
  private lastId = Math.max(Date.now(), highestIssuedId);
  private last: Snapshot | null = null;

  constructor(
    private readonly reads: DashboardReads,
    private readonly now: () => number,
    private readonly cacheClock: () => number,
  ) {}

  private build(tenantId: string, dv: number | null, nowMs: number): Snapshot {
    const draft = new SnapshotDraft(nowMs, noneExcluded());
    if (dv !== null) {
      draft.addExcluded(
        this.reads.scan(tenantId, {
          rows: (page) => page.forEach((row) => draft.addRow(row)),
          conflicts: (page) => page.forEach((pair) => draft.addConflict(pair)),
        }),
      );
    }
    this.lastId += 1;
    highestIssuedId = Math.max(highestIssuedId, this.lastId);
    const { reads } = this;
    return draft.finish(this.lastId, tenantId, (visit) => reads.scanText(tenantId, visit));
  }

  get(tenantId: string, fresh = false): Snapshot {
    const nowMs = this.now();
    // A frozen eval clock (HIPPO_FAKE_NOW) would never age the cache, so reuse is timed on its own clock.
    const wallMs = this.cacheClock();
    // Read before the build, so a commit that lands during it shows on the next read.
    const dv = this.reads.commitCount();
    const hit = this.cached;
    if (hit !== null && !fresh) {
      if (cacheStillServes(hit, { tenantId, dataVersion: dv }, wallMs)) return hit.snapshot;
    }
    const snapshot = this.build(tenantId, dv, nowMs);
    this.cached = { snapshot, dataVersion: dv, builtAtMs: wallMs };
    this.last = snapshot;
    return snapshot;
  }

  invalidate(): void {
    this.cached = null;
  }

  currentId(): number {
    return this.lastId;
  }

  isEmbedded(id: string): boolean {
    const i = this.last?.indexOf.get(id);
    if (this.last !== null && i !== undefined) return this.last.facts[i].embedded;
    return this.reads.hasVector(id);
  }

  close(): void {
    this.reads.close();
    this.cached = null;
    this.last = null;
  }
}

/** The snapshot cache over the store's dashboard reads, whose commit signal decides reuse; `now` dates the strength
 * projections, `cacheClock` ages the cache. */
export function createSnapshotService(
  reads: DashboardReads,
  now: () => number,
  cacheClock: () => number = Date.now,
): SnapshotService {
  return new SnapshotCacheService(reads, now, cacheClock);
}
