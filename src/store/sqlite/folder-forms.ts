// Folder-keyed forms for code that holds a folder and no store: the eval kit hippo-memory/testing publishes, the
// scripts and benchmarks that import dist/ by path, and a recall's best-effort write to the global store.

import type { AmbientTallies } from '../../base/memory/ambient.js';
import type { SessionHandoff } from '../../base/session/handoff.js';
import type { LossAversion, MemoryEntry } from '../../base/memory/memory.js';
import { closeHippoDb, type DatabaseSyncLike, openHippoDb } from '../../db/index.js';
import { rethrowIfStoreBlocked } from '../../base/util/store-blocked.js';
import * as ambient from './ambient.js';
import * as batches from './delete-and-batch.js';
import * as entryReads from './entry-reads.js';
import { strengthenRetrievedInOwnTx, warnStrengthenFailed, type WriteEntryOptions } from './entry-writes.js';
import * as entryWrites from './entry-writes.js';
import * as graphReads from './graph-reads.js';
import * as handoffs from './handoffs.js';
import type { DormantMove } from '../port/consolidation.js';
import type { AmbientStoreFilter } from '../port/context-reads.js';
import type { RecallSearchEntriesOptions } from '../port/sharing.js';
import type { Entity, EntityType, Relation } from '../port/graph.js';
import type { StrengthenOptions } from '../port/recall-writes.js';
import type { SessionEvent, SessionEventInput, SnapshotInput, TaskSnapshot } from '../port/sessions.js';
import type { ContinuityKey, EntryCursor } from '../port/types.js';
import * as sessions from './sessions.js';
import * as taskSnapshots from './task-snapshots.js';
import * as vectorIndex from './vector-index.js';
import { loadRecallEntries } from './search-rows.js';
import { onHandle, openStore } from './handles.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';

/** Write an entry to SQLite and refresh mirrors. `opts.actor` defaults to 'cli'. */
export function writeEntry(hippoRoot: string, entry: MemoryEntry, opts?: WriteEntryOptions): void {
  onHandle(hippoRoot, (db) => entryWrites.writeEntry(db, { hippoRoot }, entry, opts), openStore);
}

/** Every tenant's entries, oldest first: an eval reads the whole folder it seeded. */
export function loadAllEntries(hippoRoot: string): MemoryEntry[] {
  return onHandle(hippoRoot, everyTenantEntries, openStore);
}

/** Rows per read while an eval loads the whole folder, so no one statement returns every row. */
const EVAL_PAGE_ROWS = 500;

function everyTenantEntries(db: DatabaseSyncLike): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  let after: EntryCursor | null = null;
  do {
    const page = entryReads.loadEntriesPage(db, ALL_TENANTS, { limit: EVAL_PAGE_ROWS, after: after ?? undefined });
    entries.push(...page.entries);
    after = page.next;
  } while (after !== null);
  return entries;
}

/** One tenant's entries, oldest first. */
export function loadTenantEntries(hippoRoot: string, tenantId: string): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => entryReads.loadAllEntries(db, tenantId), openStore);
}

/** The row with `id` in any tenant, or null: the eval kit reads back what it wrote, as loadAllEntries does. */
export function readEntry(hippoRoot: string, id: string): MemoryEntry | null {
  return onHandle(hippoRoot, (db) => entryReads.readEntry(db, id, ALL_TENANTS), openStore);
}

/** Every stored vector keyed by memory id; `{}` when none. */
export function loadEmbeddingIndex(hippoRoot: string): Record<string, number[]> {
  return onHandle(hippoRoot, (db) => vectorIndex.loadEmbeddingIndex(db));
}

/** The folder form of `loadRecallEntries`; the eval kit's positional `loadRecallSearchEntries` serves the frozen
 * q3b-ranker-floor benchmark through it. */
export function loadRecallSearchEntries(
  hippoRoot: string,
  query: string,
  options: RecallSearchEntriesOptions,
): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => loadRecallEntries(db, query, options), openStore);
}

export function loadAmbientTallies(hippoRoot: string, tenantId: string, filter: AmbientStoreFilter): AmbientTallies {
  return onHandle(hippoRoot, (db) => ambient.loadAmbientTallies(db, {}, tenantId, filter), openStore);
}

export function loadEntities(
  hippoRoot: string,
  tenantId: string,
  opts: { entityType?: EntityType; limit?: number } = {},
): Entity[] {
  return onHandle(hippoRoot, (db) => graphReads.loadEntities(db, tenantId, opts));
}

export function loadRelations(
  hippoRoot: string,
  tenantId: string,
  opts: { fromEntityId?: number; limit?: number } = {},
): Relation[] {
  return onHandle(hippoRoot, (db) => graphReads.loadRelations(db, tenantId, opts));
}

export function saveActiveTaskSnapshot(
  hippoRoot: string,
  tenantId: string,
  snapshot: SnapshotInput,
  key?: ContinuityKey,
): TaskSnapshot {
  return onHandle(
    hippoRoot,
    (db) => taskSnapshots.saveActiveTaskSnapshot(db, { hippoRoot }, tenantId, snapshot, key),
    openStore,
  );
}

export function appendSessionEvent(hippoRoot: string, tenantId: string, event: SessionEventInput): SessionEvent {
  return onHandle(hippoRoot, (db) => sessions.appendSessionEvent(db, { hippoRoot }, tenantId, event), openStore);
}

export function saveSessionHandoff(
  hippoRoot: string,
  tenantId: string,
  handoff: Omit<SessionHandoff, 'updatedAt'>,
  key?: ContinuityKey,
): SessionHandoff {
  return onHandle(hippoRoot, (db) => handoffs.saveSessionHandoff(db, tenantId, handoff, key), openStore);
}

/** `batchWriteAndDelete` on a handle of its own; an empty batch opens no store. */
export function batchWriteAndDelete(
  hippoRoot: string,
  toWrite: MemoryEntry[],
  toDeleteIds: string[],
  opts?: { snapshot?: ReadonlyMap<string, MemoryEntry>; dormant?: DormantMove[] },
): string[] {
  if (toWrite.length === 0 && toDeleteIds.length === 0 && (opts?.dormant ?? []).length === 0) return [];
  return onHandle(
    hippoRoot,
    (db) => batches.batchWriteAndDelete(db, { hippoRoot }, toWrite, toDeleteIds, opts),
    openStore,
  );
}

/** Strengthen what a read returned: update only the four retrieval columns on the live row, never a stale copy.
 *  Best effort: a failure logs and never fails the read. Returns the ids found in this store. */
export function strengthenRetrieved(
  hippoRoot: string,
  ids: readonly string[],
  opts: StrengthenOptions,
  rules: LossAversion,
): Set<string> {
  if (ids.length === 0 || opts.recallBoostAblated) return new Set();
  let db: DatabaseSyncLike;
  try {
    db = openHippoDb(hippoRoot);
  } catch (error) {
    rethrowIfStoreBlocked(error);
    warnStrengthenFailed(error);
    return new Set();
  }
  try {
    return strengthenRetrievedInOwnTx(db, ids, opts, rules);
  } finally {
    closeHippoDb(db);
  }
}
