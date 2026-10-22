// The dashboard drawer's detail of one memory, read fresh through the api and stamped with the id the client holds.
import { calculateStrength, type LossAversion, type MemoryEntry } from '../../base/memory/memory.js';
import { memoryFacts } from '../../base/memory/memory-facts.js';
import { chunked } from '../../base/util/chunked.js';
import { round1 } from '../../base/util/format.js';
import type { HippoStore } from '../../store/port.js';
import type { MemoryConflict } from '../../store/port/conflicts.js';
import type { DashboardReads } from '../../store/port/dashboard-reads.js';
import { memoryGet } from '../memories/memories.js';
import type { Context } from '../types.js';
import { BANDS, isLiveMemory, LAYERS, projectIdentity, round3 } from './live.js';
import type { SnapshotClock } from './snapshot-clock.js';
import type { MemoryConflictDetail, MemoryDetail } from './types.js';

/** The reads a detail takes beyond the memory's own row. */
export type DetailReads = Pick<DashboardReads, 'openConflictsOf' | 'hasVector'>;

async function openConflictsOf(
  store: Pick<HippoStore, 'entriesByIds'>,
  reads: DetailReads,
  tenantId: string,
  entry: MemoryEntry,
  at: { readonly nowMs: number; readonly lossAversion: LossAversion },
): Promise<MemoryConflictDetail[]> {
  const conflicts = (await reads.openConflictsOf(tenantId, entry.id)).map((row) => row.conflict);
  const otherId = (c: MemoryConflict): string => (c.memoryAId === entry.id ? c.memoryBId : c.memoryAId);
  const others = new Map<string, MemoryEntry>();
  for (const ids of chunked([...new Set(conflicts.map(otherId))])) {
    for (const other of await store.entriesByIds(ids, tenantId)) others.set(other.id, other);
  }
  const out: MemoryConflictDetail[] = [];
  for (const c of conflicts) {
    const other = others.get(otherId(c));
    if (!other || !isLiveMemory(other)) continue;
    const strength = round3(calculateStrength(other, new Date(at.nowMs), at.lossAversion));
    out.push({
      id: c.id,
      reason: c.reason,
      score: c.score,
      other: { id: other.id, content: other.content, strength, retrievals: other.retrievalCount },
    });
  }
  return out;
}

interface MemoryDetailOptions {
  readonly snapshotId: number;
  readonly nowMs: number;
  readonly lossAversion: LossAversion;
}

/** Full detail read fresh from the store, so the drawer is current inside the coalescing window. */
async function buildMemoryDetail(
  store: Pick<HippoStore, 'entriesByIds'>,
  reads: DetailReads,
  tenantId: string,
  entry: MemoryEntry,
  options: MemoryDetailOptions,
): Promise<MemoryDetail> {
  const { snapshotId, nowMs, lossAversion } = options;
  const f = memoryFacts(entry, nowMs, lossAversion);
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
    embedded: await reads.hasVector(entry.id),
    conflicts: await openConflictsOf(store, reads, tenantId, entry, { nowMs, lossAversion }),
  };
}

const lossAversionOf = (ctx: Context): LossAversion => ({ lossAversionRatio: ctx.config.runtime?.lossAversionRatio });

/** The detail of a live memory of the Context's tenant, or null when the tenant holds no live row with that id. */
export async function dashboardMemoryDetail(
  ctx: Context,
  view: { readonly reads: DetailReads; readonly clock: SnapshotClock },
  id: string,
  at: { readonly fresh: boolean; readonly nowMs: number },
): Promise<MemoryDetail | null> {
  const entry = await memoryGet(ctx, id);
  if (entry === null || !isLiveMemory(entry)) return null;
  const { id: snapshotId } = await view.clock.at(ctx.tenantId, at.fresh);
  const options = { snapshotId, nowMs: at.nowMs, lossAversion: lossAversionOf(ctx) };
  return buildMemoryDetail(ctx.store, view.reads, ctx.tenantId, entry, options);
}

/** What a dashboard write reports: whether it committed, and the live entry it acted on, if any. */
export interface DashboardWrite {
  readonly changed: boolean;
  readonly entry?: MemoryEntry;
}

/** Drops the held stamp after a committed write, then the detail of the entry it acted on, stamped with the last id so
 * the panels refetch on the next read; null when the write names no entry. */
export async function dashboardDetailAfterWrite(
  ctx: Context,
  view: { readonly reads: DetailReads; readonly clock: SnapshotClock },
  write: DashboardWrite,
  nowMs: number,
): Promise<MemoryDetail | null> {
  if (write.changed) view.clock.invalidate();
  if (write.entry === undefined) return null;
  const options = { snapshotId: view.clock.currentId(), nowMs, lossAversion: lossAversionOf(ctx) };
  return buildMemoryDetail(ctx.store, view.reads, ctx.tenantId, write.entry, options);
}
