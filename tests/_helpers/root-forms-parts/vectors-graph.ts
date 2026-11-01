// Root-keyed vectors and graph forms tests call; production code goes through the port or the handle-first forms.

import type { MemoryEntry } from '../../../src/base/memory/entry.js';
import { READ_PAGE_ROWS } from '../../../src/base/util/pages.js';
import type { EntryCursor } from '../../../src/base/ports/store/types.js';
import type { PhysicsParticle } from '../../../src/base/rank/physics.js';
import { getMeta } from '../../../src/db/index.js';
import {
  EMBEDDING_MODEL_META_KEY,
  loadVectors,
  openVectorStaging,
  replaceVectorsWithStaged,
  stageVectors,
  upsertVectors,
} from '../../../src/db/vector-store.js';
import * as graphQueueSql from '../../../src/store/sqlite/graph/graph-queue.js';
import {
  ENTITY_COLS,
  RELATION_COLS,
  rowToEntity,
  rowToRelation,
  type EntityRow,
  type RelationRow,
} from '../../../src/store/sqlite/graph/graph-rows.js';
import { DEFAULT_LIST_LIMIT } from '../../../src/base/util/limits.js';
import type { Entity, EntityType, Relation } from '../../../src/base/ports/store/graph.js';
import { openStore } from '../../../src/store/sqlite/runtime/handles.js';
import * as searchRowsSql from '../../../src/store/sqlite/recall/search-rows.js';
import type { ApiCall } from '../../../src/base/session/transcript-calls.js';
import * as tokenLedgerSql from '../../../src/store/sqlite/ledger/token-ledger.js';
import { particleStats } from '../../../src/store/sqlite/vectors/vector-index.js';
import * as vectorIndexSql from '../../../src/store/sqlite/vectors/vector-index.js';
import { applyRebuild, type RebuildPatch } from '../../../src/domain/consolidate/summary-settle.js';
import { loadEveryTenantEntries } from './entries.js';
import type { VectorCandidateSpec, StoredVectorSummary } from '../../../src/base/ports/store/vectors.js';
import { evalNow, evalSwitches } from '../../../src/infra/eval-switches.js';
import { handlesOf, onHandle, sqliteStore } from '../test-session.js';

/** The tenant's newest entities, `entityType` only when named. */
export function loadEntities(
  hippoRoot: string,
  tenantId: string,
  opts: { entityType?: EntityType; limit?: number } = {},
): Entity[] {
  const type = opts.entityType === undefined ? [] : [opts.entityType];
  const sql =
    `SELECT ${ENTITY_COLS} FROM entities WHERE tenant_id = ?${type.length ? ' AND entity_type = ?' : ''} ` +
    `ORDER BY created_at DESC, id DESC LIMIT ?`;
  return onHandle(hippoRoot, (db) =>
    (db.prepare(sql).all(tenantId, ...type, opts.limit ?? DEFAULT_LIST_LIMIT) as EntityRow[]).map(rowToEntity),
  );
}

/** The tenant's newest relations, from one entity only when `fromEntityId` is set. */
export function loadRelations(
  hippoRoot: string,
  tenantId: string,
  opts: { fromEntityId?: number; limit?: number } = {},
): Relation[] {
  const from = opts.fromEntityId === undefined ? [] : [opts.fromEntityId];
  const sql =
    `SELECT ${RELATION_COLS} FROM relations WHERE tenant_id = ?${from.length ? ' AND from_entity_id = ?' : ''} ` +
    `ORDER BY created_at DESC, id DESC LIMIT ?`;
  return onHandle(hippoRoot, (db) =>
    (db.prepare(sql).all(tenantId, ...from, opts.limit ?? DEFAULT_LIST_LIMIT) as RelationRow[]).map(rowToRelation),
  );
}

export function markPendingProcessedUpTo(hippoRoot: string, tenantId: string, maxId: number): number {
  return onHandle(hippoRoot, (db) => graphQueueSql.markPendingProcessedUpTo(db, tenantId, maxId));
}

export function loadPendingExtractionTenants(hippoRoot: string): { tenantId: string; maxPendingId: number }[] {
  return onHandle(hippoRoot, (db) => graphQueueSql.listPendingExtractionTenants(db));
}

export async function loadEntitiesByMemoryId(
  hippoRoot: string,
  tenantId: string,
  memoryIds: readonly string[],
): Promise<Entity[]> {
  return (await sqliteStore(hippoRoot).graphReads.graphRows(tenantId, { by: 'memory', ids: memoryIds })).entities;
}

export async function loadAllL2Summaries(hippoRoot: string): Promise<MemoryEntry[]> {
  const { consolidation } = sqliteStore(hippoRoot);
  const out: MemoryEntry[] = [];
  let after: EntryCursor | undefined;
  do {
    const page = await consolidation.unprofiledTopicSummaries({ limit: READ_PAGE_ROWS, after });
    out.push(...page.entries);
    after = page.next ?? undefined;
  } while (after !== undefined);
  return out;
}

export async function loadAllDirtySummaries(hippoRoot: string, limit?: number): Promise<MemoryEntry[]> {
  const dirty = await sqliteStore(hippoRoot).consolidation.dirtySummaries(limit ?? Number.MAX_SAFE_INTEGER);
  return dirty.summaries.map((s) => s.summary);
}

/** The summary's live children by created then id, read as a filter over every row so it checks the store's read. */
export async function loadChildrenOfSummary(
  hippoRoot: string,
  summaryId: string,
  tenantId: string,
): Promise<MemoryEntry[]> {
  return loadEveryTenantEntries(hippoRoot)
    .filter((e) => e.dagParentId === summaryId && e.tenantId === tenantId && e.kind !== 'archived' && !e.supersededBy)
    .sort((a, b) => a.created.localeCompare(b.created) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export async function applyRebuildResult(hippoRoot: string, summary: MemoryEntry, patch: RebuildPatch) {
  return await applyRebuild(sqliteStore(hippoRoot), summary, patch);
}

export function recordRereads(
  hippoRoot: string,
  tenantId: string,
  sessionId: string,
  calls: readonly ApiCall[],
): number {
  return onHandle(hippoRoot, (db) => tokenLedgerSql.recordRereads(db, tenantId, sessionId, calls));
}

export function storedVectorSummary(hippoRoot: string): StoredVectorSummary {
  return onHandle(hippoRoot, (db) => vectorIndexSql.storedVectorSummary(db));
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
  return onHandle(hippoRoot, (db) => particleStats(db, Infinity).particles ?? []);
}

export function resetStoredParticles(hippoRoot: string): number {
  return onHandle(hippoRoot, (db) =>
    vectorIndexSql.resetStoredParticles(db, { strength: evalSwitches().strength, clock: evalNow }),
  );
}

export function seedStoredParticle(hippoRoot: string, entry: MemoryEntry, vector: number[]): void {
  return onHandle(hippoRoot, (db) =>
    vectorIndexSql.seedStoredParticle(db, { strength: evalSwitches().strength, clock: evalNow }, entry, vector),
  );
}

export function markGraphDirty(hippoRoot: string, tenantId: string, memoryId: string | null): void {
  onHandle(hippoRoot, (db) => graphQueueSql.markGraphDirty(db, tenantId, memoryId));
}

export async function loadEntitiesByIds(
  hippoRoot: string,
  tenantId: string,
  ids: readonly number[],
): Promise<Entity[]> {
  return (await sqliteStore(hippoRoot).graphReads.graphRows(tenantId, { by: 'entity', ids })).entities;
}

export async function loadNeighborRelations(
  hippoRoot: string,
  tenantId: string,
  entityIds: readonly number[],
  opts: { limit?: number } = {},
): Promise<Relation[]> {
  const query = { by: 'neighbor', ids: entityIds, limit: opts.limit ?? 1000 } as const;
  return (await sqliteStore(hippoRoot).graphReads.graphRows(tenantId, query)).relations;
}

export function loadVectorCandidateEntries(
  hippoRoot: string,
  queryVector: readonly number[],
  spec: VectorCandidateSpec,
): Promise<MemoryEntry[]> {
  return handlesOf(hippoRoot).onAsync(
    (db) => searchRowsSql.listVectorCandidateEntries(db, queryVector, spec),
    openStore,
  );
}

export function loadStoredVectors(hippoRoot: string, ids: readonly string[]): Map<string, number[]> {
  return ids.length === 0 ? new Map() : onHandle(hippoRoot, (db) => loadVectors(db, ids));
}
