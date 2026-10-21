// Root-keyed vectors and graph forms tests call; production code goes through the store port or the At forms.

import type { MemoryEntry } from '../../../src/base/memory/memory.js';
import { READ_PAGE_ROWS, rowsInPages } from '../../../src/base/util/pages.js';
import type { EntryCursor } from '../../../src/store/port/types.js';
import { sqliteSyncStore } from '../../../src/store/sqlite/store.js';
import type { PhysicsParticle } from '../../../src/base/rank/physics.js';
import { getMeta } from '../../../src/db/index.js';
import {
  EMBEDDING_MODEL_META_KEY,
  openVectorStaging,
  replaceVectorsWithStaged,
  stageVectors,
  upsertVectors,
} from '../../../src/db/vector-store.js';
import {
  loadPendingExtractionTenantsAt,
  markGraphDirtyAt,
  markPendingProcessedUpToAt,
} from '../../../src/store/sqlite/graph-queue.js';
import type { Entity, Relation } from '../../../src/store/port/graph-reads.js';
import { handlesOf, onHandle, openStore } from '../../../src/store/sqlite/handles.js';
import { loadVectorCandidateEntriesAt } from '../../../src/store/sqlite/search-rows.js';
import type { ApiCall } from '../../../src/base/session/transcript-calls.js';
import { recordRereadsAt } from '../../../src/store/sqlite/token-ledger.js';
import {
  particleStatsAt,
  loadStoredVectorsAt,
  resetStoredParticlesAt,
  seedStoredParticleAt,
  storedVectorSummaryAt,
} from '../../../src/store/sqlite/vector-index.js';
import type { RebuildPatch } from '../../../src/store/port/consolidation.js';
import type { VectorCandidateSpec } from '../../../src/store/port/vector-reads.js';
import type { StoredVectorSummary } from '../../../src/store/port/embedding-index.js';

export function markPendingProcessedUpTo(hippoRoot: string, tenantId: string, maxId: number): number {
  return onHandle(hippoRoot, (db) => markPendingProcessedUpToAt(db, tenantId, maxId));
}

export function loadPendingExtractionTenants(hippoRoot: string): { tenantId: string; maxPendingId: number }[] {
  return onHandle(hippoRoot, (db) => loadPendingExtractionTenantsAt(db));
}

export function loadEntitiesByMemoryId(hippoRoot: string, tenantId: string, memoryIds: readonly string[]): Entity[] {
  return sqliteSyncStore(handlesOf(hippoRoot)).graphReads.entitiesForMemories(tenantId, memoryIds);
}

export function loadAllL2Summaries(hippoRoot: string): MemoryEntry[] {
  const { consolidation } = sqliteSyncStore(handlesOf(hippoRoot));
  return Array.from(
    rowsInPages((after?: EntryCursor) => consolidation.unprofiledTopicSummaries({ limit: READ_PAGE_ROWS, after })),
  );
}

export function loadAllDirtySummaries(hippoRoot: string, limit?: number): MemoryEntry[] {
  return sqliteSyncStore(handlesOf(hippoRoot)).consolidation.dirtySummaries(limit ?? Number.MAX_SAFE_INTEGER);
}

export function loadChildrenOfSummary(hippoRoot: string, summaryId: string, tenantId: string): MemoryEntry[] {
  return sqliteSyncStore(handlesOf(hippoRoot)).consolidation.childrenOfSummary(summaryId, tenantId);
}

export function applyRebuildResult(hippoRoot: string, summary: MemoryEntry, patch: RebuildPatch) {
  return sqliteSyncStore(handlesOf(hippoRoot)).consolidation.applyRebuild(summary, patch);
}

export function recordRereads(
  hippoRoot: string,
  tenantId: string,
  sessionId: string,
  calls: readonly ApiCall[],
): number {
  return onHandle(hippoRoot, (db) => recordRereadsAt(db, tenantId, sessionId, calls));
}

export function storedVectorSummary(hippoRoot: string): StoredVectorSummary {
  return onHandle(hippoRoot, (db) => storedVectorSummaryAt(db));
}

export function saveEmbeddingIndex(hippoRoot: string, index: Record<string, number[]>, model?: string): void {
  return onHandle(hippoRoot, (db) => {
    openVectorStaging(db);
    stageVectors(db, Object.entries(index));
    replaceVectorsWithStaged(db, model ?? getMeta(db, EMBEDDING_MODEL_META_KEY, ''));
  });
}

export function saveStoredVectors(
  hippoRoot: string,
  rows: Iterable<readonly [string, readonly number[]]>,
  model: string,
): number {
  return onHandle(hippoRoot, (db) => upsertVectors(db, rows, model));
}

export function loadStoredParticles(hippoRoot: string): PhysicsParticle[] {
  return onHandle(hippoRoot, (db) => particleStatsAt(db, Infinity).particles ?? []);
}

export function resetStoredParticles(hippoRoot: string): number {
  return onHandle(hippoRoot, (db) => resetStoredParticlesAt(db, {}));
}

export function seedStoredParticle(hippoRoot: string, entry: MemoryEntry, vector: number[]): void {
  return onHandle(hippoRoot, (db) => seedStoredParticleAt(db, {}, entry, vector));
}

export function markGraphDirty(hippoRoot: string, tenantId: string, memoryId: string | null): void {
  onHandle(hippoRoot, (db) => markGraphDirtyAt(db, tenantId, memoryId));
}

export function loadEntitiesByIds(hippoRoot: string, tenantId: string, ids: readonly number[]): Entity[] {
  return sqliteSyncStore(handlesOf(hippoRoot)).graphReads.entitiesByIds(tenantId, ids);
}

export function loadNeighborRelations(
  hippoRoot: string,
  tenantId: string,
  entityIds: readonly number[],
  opts: { limit?: number } = {},
): Relation[] {
  return sqliteSyncStore(handlesOf(hippoRoot)).graphReads.neighborRelations(tenantId, entityIds, {
    limit: opts.limit ?? 1000,
  });
}

export function loadVectorCandidateEntries(
  hippoRoot: string,
  queryVector: readonly number[],
  spec: VectorCandidateSpec,
): Promise<MemoryEntry[]> {
  return handlesOf(hippoRoot).onAsync((db) => loadVectorCandidateEntriesAt(db, queryVector, spec), openStore);
}

export function loadStoredVectors(hippoRoot: string, ids: readonly string[]): Map<string, number[]> {
  return onHandle(hippoRoot, (db) => loadStoredVectorsAt(db, ids));
}
