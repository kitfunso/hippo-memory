// The dashboard drawer's detail of one memory, read through the api and stamped with the snapshot the client holds.
import type { MemoryEntry } from '../../core/memory.js';
import { memoryGet } from '../memories/memories.js';
import type { LocalContext } from '../types.js';
import { buildMemoryDetail } from './queries.js';
import { isLiveMemory, type SnapshotService } from './snapshot.js';
import type { MemoryDetail } from './types.js';

/** The detail of a live memory of the Context's tenant, or null when the tenant holds no live row with that id. */
export async function dashboardMemoryDetail(
  ctx: LocalContext,
  snapshots: SnapshotService,
  id: string,
  at: { readonly fresh: boolean; readonly nowMs: number },
): Promise<MemoryDetail | null> {
  const entry = await memoryGet(ctx, id);
  if (entry === null || !isLiveMemory(entry)) return null;
  const snapshotId = snapshots.get(ctx.tenantId, at.fresh).id;
  const embedded = snapshots.isEmbedded(entry.id);
  const lossAversion = { lossAversionRatio: ctx.config.runtime?.lossAversionRatio };
  return buildMemoryDetail(ctx.store, ctx.tenantId, entry, { snapshotId, nowMs: at.nowMs, embedded, lossAversion });
}

/** What a dashboard write reports: whether it committed, and the live entry it acted on, if any. */
export interface DashboardWrite {
  readonly changed: boolean;
  readonly entry?: MemoryEntry;
}

/** Drops the snapshot after a committed write, then the detail of the entry it acted on, stamped with the last build so
 * the reply waits on no rebuild; null when the write names no entry. */
export async function dashboardDetailAfterWrite(
  ctx: LocalContext,
  snapshots: SnapshotService,
  write: DashboardWrite,
  nowMs: number,
): Promise<MemoryDetail | null> {
  if (write.changed) snapshots.invalidate();
  if (write.entry === undefined) return null;
  const embedded = snapshots.isEmbedded(write.entry.id);
  const options = {
    snapshotId: snapshots.currentId(),
    nowMs,
    embedded,
    lossAversion: { lossAversionRatio: ctx.config.runtime?.lossAversionRatio },
  };
  return buildMemoryDetail(ctx.store, ctx.tenantId, write.entry, options);
}
