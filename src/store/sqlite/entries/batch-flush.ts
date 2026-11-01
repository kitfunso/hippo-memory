// The batch flush sleep runs: writes, deletes and dormant moves in transactions that close at the
// first component boundary after their hold.
import { DEFAULT_TENANT_ID } from '../../../base/util/tenant.js';
import type { MemoryEntry } from '../../../base/memory/entry.js';
import { withWriteScope, type DatabaseSyncLike } from '../../../db/index.js';
import type { RejectedValueRow } from '../../../base/records/rejections.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';
import { insertDormantRow } from '../dormant/dormant-rows.js';
import { log } from '../../../base/util/log.js';
import { replaceFtsRows } from './entry-row.js';
import { purgeMirrorBestEffort, writeMarkdownMirrors } from '../folder-files/mirrors.js';
import type { StoreFiles } from '../runtime/open.js';
import { clock, type WriteBudget } from '../../../base/util/write-budget.js';
import { noteFailedUnit } from '../../../base/errors/failed-unit.js';
import { chunked, ID_CHUNK } from '../../../base/util/chunked.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { AUTOMATIC_DELETE } from './delete-entries.js';
import {
  applyPlannedWrites,
  planWindow,
  type ChunkLog,
  type DirtyParents,
  type PlannedWindow,
  type PlannedWrite,
} from './batch-window.js';
import type {
  FlushComponent,
  LoadedRows,
  DormantMove,
} from '../../../base/records/consolidation.js';

export interface BatchWriteAndDeleteOptions {
  readonly files: StoreFiles;
  readonly toWrite: MemoryEntry[];
  readonly toDeleteIds: string[];
  readonly opts?: { snapshot?: ReadonlyMap<string, MemoryEntry>; dormant?: DormantMove[] };
}

/** Writes, deletes and dormant moves in one transaction. With `snapshot`, a write keeps only the
 * fields the caller changed and never resurrects a gone row. Dormant moves (sqlite/dormant/dormant.ts)
 * leave `memories` like a delete; both skip rows no longer auto-deletable. Returns ids that left
 * `memories`. */
export function batchWriteAndDelete(
  db: DatabaseSyncLike,
  { files, toWrite, toDeleteIds, opts }: BatchWriteAndDeleteOptions,
): string[] {
  // One component, so every op keeps the statement order this call has always had.
  const all: FlushComponent = {
    refreshes: [],
    writes: toWrite,
    deletes: toDeleteIds,
    dormant: opts?.dormant ?? [],
  };
  return batchWriteAndDeleteOn(db, {
    files,
    components: [all],
    from: 0,
    opts: { snapshot: opts?.snapshot, holdMs: Infinity },
  }).removedIds;
}

/** Tags a flush error with the ids of the component it stopped at, for the partial sleep audit
 * row. */
function noteFailedComponent(err: Error, component: FlushComponent | undefined): void {
  if (!component) return;
  noteFailedUnit(err, [
    ...component.refreshes.map((r) => r.id),
    ...component.writes.map((e) => e.id),
    ...component.deletes,
    ...component.dormant.map((m) => m.entry.id),
  ]);
}

interface BatchWriteAndDeleteOnOptions {
  readonly files: StoreFiles;
  readonly components: readonly FlushComponent[];
  readonly from: number;
  readonly opts: { snapshot?: LoadedRows; holdMs: number; clock?: () => number };
}

/** batchWriteAndDelete on the caller's open store from component `from`, each component whole,
 * closing the transaction at the first component boundary after `holdMs`. Returns the next
 * component's index and the ids that left `memories`.
 */
function batchWriteAndDeleteOn(
  db: DatabaseSyncLike,
  { files, components, from, opts }: BatchWriteAndDeleteOnOptions,
): FlushChunk {
  const now = opts.clock ?? clock;
  const out: ChunkLog = {
    written: [],
    removedIds: [],
    rejectedSkips: 0,
    fts: { rows: [], staleIds: [] },
    dirty: { parents: new Set(), tenantById: new Map() },
  };
  // IMMEDIATE: the tombstone probes read before the first write, and under a deferred BEGIN a
  // concurrent `hippo reject` fails the lock upgrade with SQLITE_BUSY and rolls back the batch.
  const next = withWriteScope(db, 'flush_chunk', () => {
    const reached = applyUntilHold(db, {
      files,
      components,
      opts: { ...opts, from, clock: now },
      out,
    });
    const removed = new Set(out.removedIds);
    replaceFtsRows(
      db,
      out.fts.rows.filter((row) => !removed.has(row.id)),
      [...out.fts.staleIds, ...out.removedIds],
    );
    // Fire dirty-mark for every collected parent INSIDE the BEGIN, so the dirty flag commits
    // atomically with the writes and deletes.
    for (const parentId of out.dirty.parents) {
      markSummaryDirtyInTx(db, {
        summaryId: parentId,
        tenantId: out.dirty.tenantById.get(parentId) ?? DEFAULT_TENANT_ID,
        actor: 'batch',
      });
    }
    return reached;
  });
  reportChunk(files.hippoRoot, out);
  return { next, removedIds: out.removedIds };
}

// A transaction's first window is this many ops and each next one doubles, so it reads the rows of
// at most twice the ops it applies, plus this many, however early its hold closes it.
const FIRST_WINDOW_OPS = 16;

interface ApplyUntilHoldOptions {
  readonly files: StoreFiles;
  readonly components: readonly FlushComponent[];
  readonly opts: { from: number; snapshot?: LoadedRows; holdMs: number; clock: () => number };
  readonly out: ChunkLog;
}

/** Applies components from `from` until the hold runs out, each window of them planned on one
 * read; the next index. */
function applyUntilHold(
  db: DatabaseSyncLike,
  { files, components, opts, out }: ApplyUntilHoldOptions,
): number {
  const begunAt = opts.clock();
  let next = opts.from;
  let window: PlannedWindow | undefined;
  let windowOps = FIRST_WINDOW_OPS;
  do {
    const at = next++;
    try {
      if (window === undefined || at >= window.until) {
        window = planWindow(db, files, components, {
          from: at,
          maxOps: windowOps,
          snapshot: opts.snapshot,
        });
        windowOps = Math.min(windowOps * 2, ID_CHUNK);
      }
      applyComponent(db, {
        component: components[at]!,
        writes: window.writes[at - window.from]!,
        refused: window.refused,
        out,
      });
    } catch (err) {
      if (err instanceof Error) noteFailedComponent(err, components[at]);
      throw err;
    }
  } while (next < components.length && opts.clock() - begunAt < opts.holdMs);
  return next;
}

/** Where the next transaction starts, and the ids this one removed from `memories`. */
interface FlushChunk {
  next: number;
  removedIds: string[];
}

interface ApplyComponentOptions {
  readonly component: FlushComponent;
  readonly writes: readonly PlannedWrite[];
  readonly refused: ReadonlyMap<string, RejectedValueRow>;
  readonly out: ChunkLog;
}

/** One component in the open transaction, in the order a single batch always ran: pin-checked
 * deletes, writes, dormant moves, row deletes. */
function applyComponent(
  db: DatabaseSyncLike,
  { component, writes, refused, out }: ApplyComponentOptions,
): void {
  // Snapshot every doomed row's dag_parent_id before the deletes: consolidation flushes through
  // here every cycle, so without it parents would never be marked dirty for decay, merge or
  // garbage-collect.
  const deletableIds: string[] = [];
  if (component.deletes.length > 0) {
    // A row pinned after the caller decided to delete it survives.
    for (const row of readAutoDeletableRows(db, component.deletes, out.dirty)) {
      deletableIds.push(row.id);
    }
  }
  applyPlannedWrites(db, writes, refused, out);
  moveDormantAndDelete(db, component.dormant, deletableIds, out);
}

/** After COMMIT: warn about refused writes, then sync mirrors once for what landed. */
function reportChunk(hippoRoot: string, out: ChunkLog): void {
  if (out.rejectedSkips > 0) {
    log.warn(
      `batchWriteAndDelete: skipped ${out.rejectedSkips} write(s) whose content matches a rejected value (tombstone ` +
        `hit during the batch transaction)`,
    );
  }
  // A skipped write never landed, so mirroring it would resurrect the text the skip kept out of
  // the DB.
  writeMarkdownMirrors(hippoRoot, out.written);
  for (const id of out.removedIds) {
    purgeMirrorBestEffort(hippoRoot, { id, isRaw: false, logPrefix: 'batchWriteAndDelete' });
  }
}

/** Moves eligible dormant rows out, then deletes them with the doomed rows, recording every
 * removed id. */
function moveDormantAndDelete(
  db: DatabaseSyncLike,
  dormantMoves: readonly DormantMove[],
  deletableIds: string[],
  out: ChunkLog,
): void {
  // Dormant moves: same eligibility and DAG bookkeeping as deletes.
  const movable: DormantMove[] = [];
  if (dormantMoves.length > 0) {
    const byId = new Map(dormantMoves.map((m) => [m.entry.id, m]));
    for (const row of readAutoDeletableRows(db, [...byId.keys()], out.dirty)) {
      movable.push(byId.get(row.id)!);
    }
  }
  for (const move of movable) {
    insertDormantRow(db, move);
  }
  const doomed = [...deletableIds, ...movable.map((m) => m.entry.id)];
  for (const chunk of chunked(doomed)) {
    cachedStatement(db, 'DELETE FROM memories WHERE id IN (SELECT value FROM json_each(?))').run(
      JSON.stringify(chunk),
    );
  }
  for (const id of doomed) out.removedIds.push(id);
}

/** The still auto-deletable rows among `ids`, recording each one's DAG parent as dirty. */
function readAutoDeletableRows(
  db: DatabaseSyncLike,
  ids: readonly string[],
  dirty: DirtyParents,
): Array<{ id: string; dag_parent_id: string | null; tenant_id: string | null }> {
  const rows = cachedStatement(
    db,
    `SELECT id, dag_parent_id, tenant_id FROM memories WHERE id IN (SELECT value FROM json_each(?)) AND ` +
      `${AUTOMATIC_DELETE.sql}`,
  ).all(JSON.stringify(ids), ...AUTOMATIC_DELETE.params) as Array<{
    id: string;
    dag_parent_id: string | null;
    tenant_id: string | null;
  }>;
  for (const row of rows) {
    if (row.dag_parent_id) {
      dirty.parents.add(row.dag_parent_id);
      dirty.tenantById.set(row.dag_parent_id, row.tenant_id ?? DEFAULT_TENANT_ID);
    }
  }
  return rows;
}

/** Commits whole components in transactions of about `budget.holdMs`, letting other writers in
 * between; returns the ids that left `memories`. The snapshot keeps what other writers changed
 * after the caller loaded its rows. */
export async function commitInChunks(
  db: DatabaseSyncLike,
  files: StoreFiles,
  components: readonly FlushComponent[],
  opts: { snapshot: LoadedRows; budget: WriteBudget },
): Promise<string[]> {
  const { snapshot, budget } = opts;
  const removed: string[] = [];
  let next = 0;
  try {
    let committedAt = 0;
    while (next < components.length) {
      if (next > 0) await budget.pause(committedAt);
      const chunk = batchWriteAndDeleteOn(db, {
        files,
        components,
        from: next,
        opts: {
          snapshot,
          holdMs: budget.holdMs,
          clock: budget.clock,
        },
      });
      committedAt = budget.clock();
      next = chunk.next;
      for (const id of chunk.removedIds) removed.push(id);
    }
  } catch (err) {
    // A unit that threw is already tagged; a throw outside one (a pause, BEGIN or COMMIT) names the
    // chunk's first unit.
    if (err instanceof Error) noteFailedComponent(err, components[next]);
    throw err;
  }
  return removed;
}
