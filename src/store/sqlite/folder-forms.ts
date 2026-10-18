// Folder-keyed forms for code that holds a folder and no store: the eval kit hippo-memory/testing publishes, the
// scripts and benchmarks that import dist/ by path, and a recall's best-effort write to the global store.

import type { AmbientTallies } from '../../core/ambient.js';
import type { SessionHandoff } from '../../core/handoff.js';
import type { MemoryEntry } from '../../core/memory.js';
import { closeHippoDb, type DatabaseSyncLike, openHippoDb } from '../../db/index.js';
import { rethrowIfSqliteBlocked } from '../../util/sqlite-blocked.js';
import { loadAmbientTalliesAt } from '../ambient.js';
import { batchWriteAndDeleteAt } from '../delete-and-batch.js';
import { loadAllEntriesAt, loadEveryTenantEntriesAt, readEntryAt } from '../entry-reads.js';
import {
  strengthenRetrievedInOwnTx,
  warnStrengthenFailed,
  writeEntryAt,
  type WriteEntryOptions,
} from '../entry-writes.js';
import { loadEntitiesAt, loadRelationsAt } from '../graph-reads.js';
import { saveSessionHandoffAt } from '../handoffs.js';
import type { DormantMove } from '../port/consolidation.js';
import type { AmbientStoreFilter } from '../port/context-reads.js';
import type { Entity, EntityType, Relation } from '../port/graph-reads.js';
import type { StrengthenOptions } from '../port/recall-writes.js';
import type { SessionEvent, SessionEventInput, SnapshotInput, TaskSnapshot } from '../port/sessions.js';
import type { ContinuityKey } from '../port/types.js';
import { appendSessionEventAt, saveActiveTaskSnapshotAt } from '../sessions.js';
import { loadEmbeddingIndexAt } from '../vector-index.js';
import { onHandle, openStore } from './handles.js';

/** Write an entry to SQLite and refresh mirrors. `opts.actor` defaults to 'cli'. */
export function writeEntry(hippoRoot: string, entry: MemoryEntry, opts?: WriteEntryOptions): void {
  onHandle(hippoRoot, (db) => writeEntryAt(db, { hippoRoot }, entry, opts), openStore);
}

/** Every tenant's entries, oldest first: an eval reads the whole folder it seeded. */
export function loadAllEntries(hippoRoot: string): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => loadEveryTenantEntriesAt(db), openStore);
}

/** One tenant's entries, oldest first. */
export function loadTenantEntries(hippoRoot: string, tenantId: string): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => loadAllEntriesAt(db, tenantId), openStore);
}

/** The row with `id`; null when absent, or in another tenant when `tenantId` is given. */
export function readEntry(hippoRoot: string, id: string, tenantId?: string): MemoryEntry | null {
  return onHandle(hippoRoot, (db) => readEntryAt(db, id, tenantId), openStore);
}

/** Every stored vector keyed by memory id; `{}` when none. */
export function loadEmbeddingIndex(hippoRoot: string): Record<string, number[]> {
  return onHandle(hippoRoot, (db) => loadEmbeddingIndexAt(db));
}

export function loadAmbientTallies(hippoRoot: string, tenantId: string, filter: AmbientStoreFilter): AmbientTallies {
  return onHandle(hippoRoot, (db) => loadAmbientTalliesAt(db, tenantId, filter), openStore);
}

export function loadEntities(
  hippoRoot: string,
  tenantId: string,
  opts: { entityType?: EntityType; limit?: number } = {},
): Entity[] {
  return onHandle(hippoRoot, (db) => loadEntitiesAt(db, tenantId, opts));
}

export function loadRelations(
  hippoRoot: string,
  tenantId: string,
  opts: { fromEntityId?: number; limit?: number } = {},
): Relation[] {
  return onHandle(hippoRoot, (db) => loadRelationsAt(db, tenantId, opts));
}

export function saveActiveTaskSnapshot(
  hippoRoot: string,
  tenantId: string,
  snapshot: SnapshotInput,
  key?: ContinuityKey,
): TaskSnapshot {
  return onHandle(hippoRoot, (db) => saveActiveTaskSnapshotAt(db, { hippoRoot }, tenantId, snapshot, key), openStore);
}

export function appendSessionEvent(hippoRoot: string, tenantId: string, event: SessionEventInput): SessionEvent {
  return onHandle(hippoRoot, (db) => appendSessionEventAt(db, { hippoRoot }, tenantId, event), openStore);
}

export function saveSessionHandoff(
  hippoRoot: string,
  tenantId: string,
  handoff: Omit<SessionHandoff, 'updatedAt'>,
  key?: ContinuityKey,
): SessionHandoff {
  return onHandle(hippoRoot, (db) => saveSessionHandoffAt(db, tenantId, handoff, key), openStore);
}

/** `batchWriteAndDeleteAt` on a handle of its own; an empty batch opens no store. */
export function batchWriteAndDelete(
  hippoRoot: string,
  toWrite: MemoryEntry[],
  toDeleteIds: string[],
  opts?: { snapshot?: ReadonlyMap<string, MemoryEntry>; dormant?: DormantMove[] },
): string[] {
  if (toWrite.length === 0 && toDeleteIds.length === 0 && (opts?.dormant ?? []).length === 0) return [];
  return onHandle(hippoRoot, (db) => batchWriteAndDeleteAt(db, { hippoRoot }, toWrite, toDeleteIds, opts), openStore);
}

/** Strengthen what a read returned: update only the four retrieval columns on the live row, never a stale copy.
 *  Best effort: a failure logs and never fails the read. Returns the ids found in this store. */
export function strengthenRetrieved(hippoRoot: string, ids: readonly string[], opts: StrengthenOptions): Set<string> {
  if (ids.length === 0 || opts.recallBoostAblated) return new Set();
  let db: DatabaseSyncLike;
  try {
    db = openHippoDb(hippoRoot);
  } catch (error) {
    rethrowIfSqliteBlocked(error);
    warnStrengthenFailed(error);
    return new Set();
  }
  try {
    return strengthenRetrievedInOwnTx(db, ids, opts);
  } finally {
    closeHippoDb(db);
  }
}
