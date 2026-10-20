// A store other than hippo.db for the Reports reads status and auto-sleep make, built on the in-memory entry-writes store:
// it copies the counters, sleep runs, conflict states and vector ids out of hippo.db once and reads rows from memory.
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { calculateStrength, confidenceFacets, Layer } from '../../src/index.js';
import type { HippoStore, LegacyStats, MemoryEntry, StatusCounts } from '../../src/entry/store-kit.js';
import { inMemoryEntryWritesStore } from './in-memory-entry-writes-store.js';
import type { StoreSide } from './store-conformance.js';
import type { CorrectionLink, RawProvenance } from '../../src/store/port/reports.js';

type Counter = 'total_remembered' | 'total_recalled' | 'total_forgotten';

interface SleepRun {
  readonly timestamp: string;
  readonly decayed: number;
  readonly merged: number;
  readonly removed: number;
}

interface CopiedState {
  readonly counters: Readonly<Record<Counter, number>>;
  /** Every run, oldest first by timestamp then id. */
  readonly runs: readonly SleepRun[];
  readonly conflictStatuses: readonly string[];
  readonly vectorIds: ReadonlySet<string>;
}

const RUNS_KEPT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

function copyState(hippoRoot: string): CopiedState {
  const db = openHippoDb(hippoRoot);
  try {
    const meta = (key: Counter): number =>
      Number(
        (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? '0',
      );
    // SAFETY: the SELECT names SleepRun's four fields.
    const runs = db
      .prepare('SELECT timestamp, decayed, merged, removed FROM consolidation_runs ORDER BY timestamp, id')
      .all() as SleepRun[];
    // SAFETY: one column per row, aliased to the field read below.
    const statuses = db.prepare('SELECT status FROM memory_conflicts').all() as { status: string }[];
    // SAFETY: one column per row, aliased to the field read below.
    const vectors = db.prepare('SELECT memory_id AS id FROM memory_vectors').all() as { id: string }[];
    return {
      counters: {
        total_remembered: meta('total_remembered'),
        total_recalled: meta('total_recalled'),
        total_forgotten: meta('total_forgotten'),
      },
      runs: runs.map((r) => ({ ...r })),
      conflictStatuses: statuses.map((s) => s.status),
      vectorIds: new Set(vectors.map((v) => v.id)),
    };
  } finally {
    closeHippoDb(db);
  }
}

const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
const superseded = (e: MemoryEntry): boolean => e.supersededBy != null && e.supersededBy !== '';

function statusCountsOf(
  rows: readonly MemoryEntry[],
  state: CopiedState,
  now: Date,
  atRiskBelow: number,
): StatusCounts {
  const byLayer = { [Layer.Buffer]: 0, [Layer.Episodic]: 0, [Layer.Semantic]: 0, [Layer.Trace]: 0 };
  const byConfidence = { verified: 0, observed: 0, inferred: 0, stale: 0 };
  let strengthSum = 0;
  for (const e of rows) {
    const strength = calculateStrength(e, now);
    strengthSum += strength;
    byLayer[e.layer] += 1;
    byConfidence[confidenceFacets(e, now).tier] += 1;
  }
  const ids = new Set(rows.map((e) => e.id));
  return {
    total: rows.length,
    byLayer,
    byConfidence,
    pinned: rows.filter((e) => e.pinned).length,
    atRisk: rows.filter((e) => calculateStrength(e, now) < atRiskBelow).length,
    agedOut: rows.filter((e) => confidenceFacets(e, now).agedOut).length,
    avgStrength: rows.length > 0 ? strengthSum / rows.length : 0,
    openConflicts: state.conflictStatuses.filter((s) => s === 'open').length,
    embedded: [...state.vectorIds].filter((id) => ids.has(id)).length,
  };
}

/** The correction-latency join over `rows`, in their order: each superseded row whose successor is among them. */
export function correctionLinksOf(rows: readonly MemoryEntry[]): CorrectionLink[] {
  const byId = new Map(rows.map((e) => [e.id, e]));
  return rows.filter(superseded).flatMap((old) => {
    const next = byId.get(old.supersededBy!);
    if (!next) return [];
    const source = next.extractedFrom ? byId.get(next.extractedFrom) : undefined;
    return [{ oldId: old.id, newId: next.id, correctedAt: next.created, sourceCreated: source?.created ?? null }];
  });
}

/** The raw count and the raw rows missing an owner or an artifact ref, in `rows` order. */
export function rawProvenanceOf(rows: readonly MemoryEntry[]): RawProvenance {
  const raw = rows.filter((e) => e.kind === 'raw');
  const gaps = raw.filter((e) => !e.owner || !e.artifactRef);
  return {
    total: raw.length,
    gaps: gaps.map((e) => ({ id: e.id, owner: e.owner ?? null, artifactRef: e.artifactRef ?? null })),
  };
}

export function inMemoryReportsStore(hippoRoot: string): StoreSide {
  const base = inMemoryEntryWritesStore(hippoRoot);
  const state = copyState(hippoRoot);
  // hippo.db's report order, so a float sum adds up in the same order.
  const sorted = (): MemoryEntry[] => base.allRows().sort((a, b) => cmp(a.created, b.created) || cmp(a.id, b.id));
  const reports: HippoStore['reports'] = {
    ...base.store.reports,
    async stats(): Promise<LegacyStats> {
      return { ...state.counters, consolidation_runs: state.runs.slice(-RUNS_KEPT).map((r) => ({ ...r })) };
    },
    async statusCounts(now, atRiskBelow) {
      return statusCountsOf(sorted(), state, now, atRiskBelow);
    },
    async correctionLinks() {
      return correctionLinksOf(sorted());
    },
    async rawProvenance() {
      return rawProvenanceOf(sorted());
    },
    async createdSinceLastSleep(tenantId, now) {
      const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
      const lastRun = state.runs.reduce((last, r) => (r.timestamp > last ? r.timestamp : last), '');
      const floor = lastRun > dayAgo ? lastRun : dayAgo;
      return base.allRows().filter((e) => e.tenantId === tenantId && e.created > floor).length;
    },
  };
  return { store: { ...base.store, reports }, auditRows: base.auditRows };
}
