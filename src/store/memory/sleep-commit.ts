// A sleep's flush and dormant expiry over plain tables: each component staged whole, under the rules hippo.db's batch
// applies (a write keeps what others changed since the load, a tombstone or a newly kept row stops its op).
import { canAutoDelete, type MemoryEntry } from '../../base/memory/memory.js';
import { rejectionDigest } from '../../base/records/rejection-digest.js';
import { noteFailedUnit } from '../../base/errors/failed-unit.js';
import { log } from '../../base/util/log.js';
import type {
  FlushComponent,
  LoadedRows,
  SleepCommit,
  SleepCommitted,
  StrengthRefresh,
} from '../port/consolidation.js';
import { refusalAudit } from '../rules/audit-rows.js';
import { byBytes } from '../rules/order.js';
import { backedAmong } from './audit-maintenance.js';
import { setAside } from './dormant.js';
import { tenantKey } from './rows.js';
import { markParentDirty, stage, type Tx } from './staged.js';
import { asStored } from './stored-entry.js';
import type { MemoryTables } from './tables.js';

// The child fields a level-2/3 summary is built from, so a change to one marks its parent dirty.
const SUMMARY_INPUTS = ['content', 'created', 'dagParentId', 'kind'] as const;

function mergeOwnChanges(base: MemoryEntry, ours: MemoryEntry, live: MemoryEntry): MemoryEntry {
  const row: MemoryEntry = { ...live };
  const loaded = new Map(Object.entries(base));
  for (const [key, value] of Object.entries(ours)) {
    if (JSON.stringify(value) !== JSON.stringify(loaded.get(key))) Object.assign(row, { [key]: value });
  }
  return row;
}

/** A refresh sets its strength on the live row (none when it is gone); a write keeps what others changed since the
 * load. */
function batchRow(op: MemoryEntry | StrengthRefresh, base?: MemoryEntry, live?: MemoryEntry): MemoryEntry | undefined {
  if (!('content' in op)) return live && { ...live, strength: op.strength };
  return base && live ? mergeOwnChanges(base, op, live) : op;
}

/** The rows among `ids` an automatic delete may still take, each one's parent noted to mark dirty. */
function stillDeletable(t: MemoryTables, tx: Tx, ids: readonly string[], parents: Map<string, string>): string[] {
  const backed = backedAmong(t, ids);
  return ids.filter((id) => {
    const row = tx.rows.get(id);
    if (!row || !canAutoDelete(row) || backed.has(id)) return false;
    if (row.dagParentId) parents.set(row.dagParentId, row.tenantId);
    return true;
  });
}

/** A refresh first, a later write of the same row in its place; each op keeps its first position. */
function componentOps(component: FlushComponent): Array<MemoryEntry | StrengthRefresh> {
  const ops = new Map<string, MemoryEntry | StrengthRefresh>(component.refreshes.map((r) => [r.id, r]));
  for (const entry of component.writes) ops.set(entry.id, entry);
  return [...ops.values()];
}

/** Lands each op's row unless a tombstone refuses it or its row is gone since the load; returns the refusals. */
function applyWrites(t: MemoryTables, tx: Tx, ops: ReturnType<typeof componentOps>, at: Applying): number {
  let refused = 0;
  for (const op of ops) {
    const base = at.snapshot.get(op.id);
    const live = tx.rows.get(op.id);
    const row = batchRow(op, base, live);
    if (!row) continue;
    const digest = rejectionDigest(row.content);
    const tombstone = t.rejected.get(tenantKey(row.tenantId, digest));
    const introduces = !live || live.tenantId !== row.tenantId || rejectionDigest(live.content) !== digest;
    if (tombstone && introduces) {
      tx.audit.push(refusalAudit(tombstone.tenantId, 'sleep-batch', row.id, tombstone));
      refused++;
      continue;
    }
    if (base && !live) continue;
    tx.rows.set(row.id, asStored(structuredClone(row), live));
    if (row.dagParentId && (!live || SUMMARY_INPUTS.some((k) => row[k] !== live[k]))) {
      at.parents.set(row.dagParentId, row.tenantId);
    }
  }
  return refused;
}

interface Applying {
  readonly snapshot: LoadedRows;
  readonly parents: Map<string, string>;
}

/** One component in one staged write, in the order a hippo.db batch runs it; returns the ids that left. */
function commitComponent(t: MemoryTables, component: FlushComponent, snapshot: LoadedRows): string[] {
  const at: Applying = { snapshot, parents: new Map() };
  const { removed, moved, refused } = stage(t, 'sleep', (tx) => {
    const deletable = stillDeletable(t, tx, component.deletes, at.parents);
    const skips = applyWrites(t, tx, componentOps(component), at);
    const movable = new Set(
      stillDeletable(
        t,
        tx,
        component.dormant.map((m) => m.entry.id),
        at.parents,
      ),
    );
    const gone = [...deletable, ...movable];
    for (const id of gone) tx.rows.delete(id);
    for (const [parentId, tenantId] of at.parents) markParentDirty(tx, parentId, tenantId, 'batch');
    return { removed: gone, moved: component.dormant.filter((m) => movable.has(m.entry.id)), refused: skips };
  });
  for (const move of moved) setAside(t, move);
  if (refused > 0) {
    log.warn(
      `batchWriteAndDelete: skipped ${refused} write(s) whose content matches a rejected value (tombstone ` +
        `hit during the batch transaction)`,
    );
  }
  return removed;
}

function componentIds(component: FlushComponent): string[] {
  const { refreshes, writes, deletes, dormant } = component;
  return [...refreshes.map((r) => r.id), ...writes.map((e) => e.id), ...deletes, ...dormant.map((m) => m.entry.id)];
}

function flushIn(t: MemoryTables, flush: NonNullable<SleepCommit['flush']>): string[] {
  const removed: string[] = [];
  for (const component of flush.components) {
    try {
      removed.push(...commitComponent(t, component, flush.snapshot));
    } catch (err) {
      if (err instanceof Error) noteFailedUnit(err, componentIds(component));
      throw err;
    }
  }
  return removed;
}

function expireIn(t: MemoryTables, cutoffIso: string, dryRun: boolean): number {
  const expired = [...t.dormant].filter(([, snapshot]) => byBytes(snapshot.dormantAt, cutoffIso) < 0);
  if (!dryRun) for (const [key] of expired) t.dormant.delete(key);
  return expired.length;
}

/** The flush, then the dormant expiry; a component that throws is tagged with its ids for the partial audit row. */
export function commitIn(t: MemoryTables, commit: SleepCommit): SleepCommitted {
  const removedIds = commit.flush ? flushIn(t, commit.flush) : [];
  const expired = commit.expireBefore === null ? 0 : expireIn(t, commit.expireBefore, commit.dryRun);
  return { removedIds, expired };
}
