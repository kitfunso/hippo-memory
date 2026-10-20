// Root-keyed forms tests call; production code goes through the store port or the At forms.

import { CLI_ACTOR } from '../../src/base/scope/actor.js';
import type { Card, CardComment, CardRun } from '../../src/base/records/card.js';
import type { HandoffOutcome, SessionHandoff } from '../../src/base/session/handoff.js';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import { recordAuditEventsRowByRowAt, type FailedAuditEvent } from '../../src/store/sqlite/audit.js';
import {
  githubEventRecordAt,
  markGitHubEventSeenAt,
  type GitHubEventLogEntry,
} from '../../src/store/sqlite/connectors/github.js';
import { markSlackEventSeenAt, slackEventRecordAt } from '../../src/store/sqlite/connectors/slack.js';
import { promote } from '../../src/api/memories/promote.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { resolveTenantId } from '../../src/surface/server/boot.js';
import { apiCtx } from './api-ctx.js';
import type { WriteBudget } from '../../src/base/util/write-budget.js';
import type { PhysicsParticle } from '../../src/base/rank/physics.js';
import { assertTenantId } from '../../src/base/scope/tenant-id.js';
import { getMeta } from '../../src/db/index.js';
import {
  EMBEDDING_MODEL_META_KEY,
  openVectorStaging,
  replaceVectorsWithStaged,
  stageVectors,
  upsertVectors,
} from '../../src/db/vector-store.js';
import {
  loadAmbientCandidatesAt,
  loadContextCandidatesAt,
  loadTextsHoldingWordsAt,
  tallySourcesAt,
} from '../../src/store/sqlite/candidates.js';
import { replaceDetectedConflictsAt } from '../../src/store/sqlite/conflicts.js';
import {
  commitInChunksAt,
  deleteEntriesOneByOneAt,
  memoriesBackingObjectsAt,
} from '../../src/store/sqlite/delete-and-batch.js';
import type { DormantMemory, ListDormantOpts } from '../../src/store/port/dormant.js';
import { EVERY_SCOPE, listDormantRows } from '../../src/store/sqlite/dormant-rows.js';
import {
  countSessionRawMemoriesAt,
  loadEntriesByIdsAt,
  loadEntryTextKeysPageAt,
  loadFreshRawMemoriesAt,
  loadSessionRawMemoriesAt,
  iterateEveryTenantEntriesAt,
  readEntryAt,
} from '../../src/store/sqlite/entry-reads.js';
import { writeEntriesTogetherAt, writePromotedEntryAt } from '../../src/store/sqlite/entry-writes.js';
import type { CompleteGoalOpts, PushGoalOpts } from '../../src/store/port/goals.js';
import { activeGoalsWithPoliciesAt } from '../../src/store/sqlite/goals.js';
import {
  loadPendingExtractionTenantsAt,
  markGraphDirtyAt,
  markPendingProcessedUpToAt,
} from '../../src/store/sqlite/graph-queue.js';
import type { Entity, Relation } from '../../src/store/port/graph-reads.js';
import type {
  HandoffFilter,
  SessionEndHandoffRequest,
  SessionEvent,
  TaskSnapshot,
  WorkingMemoryItem,
} from '../../src/store/port/sessions.js';
import {
  loadHandoffByIdAt,
  loadLatestHandoffAt,
  stampHandoffOutcomeAt,
  writeSessionEndHandoffAt,
} from '../../src/store/sqlite/handoffs.js';
import {
  appendConsolidationRunAt,
  loadSessionDecayContextAt,
  saveIndexAt,
  updateStatsUnlessBusyAt,
  updateStatsAt,
} from '../../src/store/sqlite/index-and-stats.js';
import { readLastRecall } from '../../src/store/sqlite/mirrors.js';
import { waitingOpener, type StoreFiles } from '../../src/store/sqlite/open.js';
import { handlesOf, onHandle, openStore } from '../../src/store/sqlite/handles.js';
import type { RepairProtection } from '../../src/base/memory/memory-audit.js';
import type { QualityRepairResult } from '../../src/store/port/audit-maintenance.js';

export {
  appendSessionEvent,
  batchWriteAndDelete,
  loadAmbientTallies,
  loadEmbeddingIndex,
  loadEntities,
  loadRelations,
  loadTenantEntries as loadAllEntries,
  saveActiveTaskSnapshot,
  saveSessionHandoff,
  strengthenRetrieved,
  writeEntry,
} from '../../src/store/sqlite/folder-forms.js';
import { computePredictionBaserateAt } from '../../src/store/sqlite/predictions.js';
import type { HippoIndex } from '../../src/store/sqlite/rows.js';
import type { MemoryConflict } from '../../src/store/port/conflicts.js';
import type { SqlFragment } from '../../src/store/sqlite/rule-sql.js';
import {
  loadRecallEntriesAt,
  loadSearchEntriesAt,
  loadVectorCandidateEntriesAt,
} from '../../src/store/sqlite/search-rows.js';
import { listApiKeyRows } from '../../src/store/sqlite/auth.js';
import type { ApiKeyListItem, ListApiKeysOpts } from '../../src/store/port/key-writes.js';
import { findPromotableSessionsAt, listSessionEventsAt } from '../../src/store/sqlite/sessions.js';
import { loadActiveTaskSnapshotAt } from '../../src/store/sqlite/task-snapshots.js';
import { freshActiveSnapshot } from '../../src/base/session/session-snapshot.js';
import type { ApiCall } from '../../src/base/session/transcript-calls.js';
import { recordRereadsAt } from '../../src/store/sqlite/token-ledger.js';
import {
  loadStoredParticlesAt,
  loadStoredVectorsAt,
  resetStoredParticlesAt,
  seedStoredParticleAt,
  storedVectorSummaryAt,
} from '../../src/store/sqlite/vector-index.js';
import type { KeysetPosition } from '../../src/base/util/keyset.js';
import { MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT } from '../../src/base/util/limits.js';
import type {
  AppendAuditOpts,
  HeldText,
  ActiveGoals,
  GetActiveGoalsOpts,
  Goal,
  PredictionBaserate,
  ContinuityKey,
  JsonObject,
} from '../../src/store/port/types.js';
import type { ConnectorEventRecord } from '../../src/store/port/connectors.js';
import type {
  AmbientLoadResult,
  AmbientRecallRequest,
  ContextCandidateFilter,
  RecentOrigins,
} from '../../src/store/port/context-reads.js';
import type { SourceTally, EntryTextKey, RecallSearchEntriesOptions } from '../../src/store/local/sharing.js';
import type {
  DetectedConflict,
  FlushComponent,
  LoadedRows,
  SessionDecayContext,
  RebuildPatch,
} from '../../src/store/local/consolidation.js';
import type { Prediction, PredictionClose } from '../../src/store/port/predictions.js';
import type { ClosureState } from '../../src/base/records/prediction.js';
import type { VectorCandidateSpec } from '../../src/store/port/vector-reads.js';
import type { StoredVectorSummary } from '../../src/store/local/embedding-index.js';
import { ALL_TENANTS, type TenantId } from '../../src/base/util/tenant.js';
import type { EntryCursor } from '../../src/store/port/types.js';

export function loadAmbientCandidates(
  hippoRoot: string,
  tenantId: string,
  recentNeeded: number,
  admit: (e: MemoryEntry) => boolean,
  recall?: AmbientRecallRequest,
  origins?: RecentOrigins,
): AmbientLoadResult {
  const judge = (e: MemoryEntry) => (admit(e) ? null : ('admission' as const));
  return onHandle(
    hippoRoot,
    (db) => loadAmbientCandidatesAt(db, tenantId, { recentNeeded, judge, recall, origins }),
    openStore,
  );
}

export function loadContextCandidates(
  hippoRoot: string,
  tenantId: string,
  filter: ContextCandidateFilter,
): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => loadContextCandidatesAt(db, tenantId, filter), openStore);
}

export function loadTextsHoldingWords(
  hippoRoot: string,
  tenantId: TenantId = ALL_TENANTS,
  words: readonly string[],
  project?: readonly string[],
  admit?: SqlFragment,
): HeldText[] {
  return onHandle(hippoRoot, (db) => loadTextsHoldingWordsAt(db, tenantId, words, project, admit), openStore);
}

export function tallySources(hippoRoot: string, tenantId: TenantId = ALL_TENANTS): SourceTally[] {
  return onHandle(hippoRoot, (db) => tallySourcesAt(db, tenantId), openStore);
}

export function createCard(
  hippoRoot: string,
  tenantId: string,
  input: { title: string; repo?: string; contract?: string; budget?: number; dependsOn?: string[] },
): Card {
  return sqliteSyncStore(hippoRoot).cards.create(tenantId, input);
}

export function loadCard(hippoRoot: string, tenantId: string, id: string): Card | null {
  return sqliteSyncStore(hippoRoot).cards.load(tenantId, id);
}

export function loadCardRuns(hippoRoot: string, tenantId: string, id: string): CardRun[] {
  assertTenantId('loadCardRuns', tenantId);
  return sqliteSyncStore(hippoRoot).cards.runs(tenantId, id);
}

export function claimCard(
  hippoRoot: string,
  tenantId: string,
  id: string,
  runtime: string,
  sessionId?: string,
): (Card & { runId: number }) | null {
  return sqliteSyncStore(hippoRoot).cards.claim(tenantId, id, runtime, sessionId);
}

export function heartbeatCard(hippoRoot: string, tenantId: string, id: string, runId: number): Card | null {
  return sqliteSyncStore(hippoRoot).cards.heartbeat(tenantId, id, runId);
}

export function blockCard(
  hippoRoot: string,
  tenantId: string,
  id: string,
  reason: string,
  runId?: number,
): Card | null {
  return sqliteSyncStore(hippoRoot).cards.block(tenantId, id, reason, runId);
}

export function reviewCard(hippoRoot: string, tenantId: string, id: string, runId?: number): Card | null {
  return sqliteSyncStore(hippoRoot).cards.review(tenantId, id, runId);
}

export function completeCard(
  hippoRoot: string,
  tenantId: string,
  id: string,
  outcome: HandoffOutcome,
  runId?: number,
): { card: Card; promotedChildren: string[] } | null {
  return sqliteSyncStore(hippoRoot).cards.complete(tenantId, id, outcome, runId);
}

export function reclaimExpiredCards(hippoRoot: string, tenantId: string): string[] {
  return sqliteSyncStore(hippoRoot).cards.reclaimExpired(tenantId);
}

export function addCardComment(
  hippoRoot: string,
  tenantId: string,
  cardId: string,
  author: string,
  body: string,
): CardComment {
  return sqliteSyncStore(hippoRoot).cards.comment(tenantId, cardId, author, body);
}

export function replaceDetectedConflicts(
  hippoRoot: string,
  detected: Array<DetectedConflict>,
  detectedAt?: string,
): void {
  onHandle(hippoRoot, (db) => replaceDetectedConflictsAt(db, { hippoRoot }, detected, detectedAt), openStore);
}

/** Every conflict with `status` (no tenant: every tenant's), read through the store port a page at a time. */
export function listMemoryConflicts(
  hippoRoot: string,
  status: string = 'open',
  tenantId: TenantId = ALL_TENANTS,
): MemoryConflict[] {
  const { conflicts } = sqliteSyncStore(hippoRoot);
  const out: MemoryConflict[] = [];
  let after: KeysetPosition | undefined;
  do {
    const page = conflicts.list({ tenantId, status, limit: MAX_LIST_LIMIT, after });
    out.push(...page.rows.map((row) => row.conflict));
    after = page.next ?? undefined;
  } while (after);
  return out;
}

/** Keeps `keepId` and weakens the other member through the store port, as a plain `hippo resolve` does; for a
 * fixture that needs a resolved conflict and no api checks. */
export function resolveConflictKeeping(
  hippoRoot: string,
  tenantId: string,
  conflictId: number,
  keepId: string,
): boolean {
  const conflicts = sqliteSyncStore(hippoRoot).conflicts;
  const row = conflicts.get(tenantId, conflictId);
  if (!row) return false;
  const a = { id: row.conflict.memory_a_id, scope: row.a?.scope ?? null };
  const b = { id: row.conflict.memory_b_id, scope: row.b?.scope ?? null };
  const [keep, loser] = keepId === a.id ? [a, b] : [b, a];
  return conflicts.resolve(tenantId, {
    conflictId,
    keep,
    loser,
    fate: { kind: 'weaken' },
    actor: CLI_ACTOR,
    reason: '',
  });
}

export function memoriesBackingObjects(hippoRoot: string): Set<string> {
  return onHandle(hippoRoot, (db) => memoriesBackingObjectsAt(db));
}

export function deleteEntry(
  hippoRoot: string,
  id: string,
  opts?: { actor?: string; reason?: string; automatic?: boolean },
): boolean {
  const targets = [{ id, reason: opts?.reason ?? '' }];
  return onHandle(
    hippoRoot,
    (db) => deleteEntriesOneByOneAt(db, { hippoRoot }, targets, opts ?? {})[0] ?? false,
    openStore,
  );
}

export function loadDormantMemories(
  hippoRoot: string,
  tenantId: string,
  opts: ListDormantOpts = {},
  admit?: SqlFragment,
): DormantMemory[] {
  return onHandle(hippoRoot, (db) => listDormantRows(db, tenantId, opts, admit ?? EVERY_SCOPE));
}

export function loadEntriesByIds(
  hippoRoot: string,
  ids: readonly string[],
  tenantId: TenantId = ALL_TENANTS,
): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => loadEntriesByIdsAt(db, ids, tenantId), openStore);
}

export function loadSessionRawMemories(
  hippoRoot: string,
  sessionId: string,
  tenantId: TenantId = ALL_TENANTS,
  cap?: number,
  origins?: readonly string[],
): MemoryEntry[] {
  return onHandle(
    hippoRoot,
    (db) => loadSessionRawMemoriesAt(db, { sessionId, tenantId, cap: cap ?? 0, origins }),
    openStore,
  );
}

export function countSessionRawMemories(
  hippoRoot: string,
  sessionId: string,
  tenantId: TenantId = ALL_TENANTS,
  scope?: string,
  ownScope?: string,
  origins?: readonly string[],
): number {
  return onHandle(
    hippoRoot,
    (db) => countSessionRawMemoriesAt(db, { sessionId, tenantId, scope, ownScope, origins }),
    openStore,
  );
}

export function loadFreshRawMemories(
  hippoRoot: string,
  count: number,
  tenantId: TenantId = ALL_TENANTS,
  sessionId?: string,
  origins?: readonly string[],
): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => loadFreshRawMemoriesAt(db, count, tenantId, sessionId, origins), openStore);
}

/** The row with `id` in `tenantId`, or in any tenant when a test leaves it out. */
export function readEntry(hippoRoot: string, id: string, tenantId: TenantId = ALL_TENANTS): MemoryEntry | null {
  return onHandle(hippoRoot, (db) => readEntryAt(db, id, tenantId), openStore);
}

export function loadEveryTenantEntries(hippoRoot: string): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => [...iterateEveryTenantEntriesAt(db)], openStore);
}

/** Every page of loadEntryTextKeysPageAt, `pageRows` at a time. */
export function loadEntryTextKeys(hippoRoot: string, tenantId: TenantId = ALL_TENANTS, pageRows = 500): EntryTextKey[] {
  return onHandle(
    hippoRoot,
    (db) => {
      const keys: EntryTextKey[] = [];
      for (let after: EntryCursor | null | undefined; after !== null;) {
        const page = loadEntryTextKeysPageAt(db, tenantId, { limit: pageRows, after });
        keys.push(...page.keys);
        after = page.next;
      }
      return keys;
    },
    openStore,
  );
}

export function writeEntriesTogether(hippoRoot: string, entries: readonly MemoryEntry[]): number {
  if (entries.length === 0) return 0;
  return onHandle(hippoRoot, (db) => writeEntriesTogetherAt(db, { hippoRoot }, entries), openStore);
}

export function pushGoal(hippoRoot: string, opts: PushGoalOpts): Goal {
  return sqliteSyncStore(hippoRoot).goals.push(opts.tenantId, opts);
}

export function activeGoalsWithPolicies(hippoRoot: string, opts: GetActiveGoalsOpts): ActiveGoals {
  return onHandle(hippoRoot, (db) => activeGoalsWithPoliciesAt(db, opts));
}

export function completeGoal(hippoRoot: string, goalId: string, opts: CompleteGoalOpts): void {
  return sqliteSyncStore(hippoRoot).goals.complete(resolveTenantId({}), goalId, opts);
}

export function suspendGoal(hippoRoot: string, goalId: string): void {
  return sqliteSyncStore(hippoRoot).goals.suspend(resolveTenantId({}), goalId);
}

export function resumeGoal(hippoRoot: string, goalId: string): void {
  return sqliteSyncStore(hippoRoot).goals.resume(resolveTenantId({}), goalId);
}

export function markPendingProcessedUpTo(hippoRoot: string, tenantId: string, maxId: number): number {
  return onHandle(hippoRoot, (db) => markPendingProcessedUpToAt(db, tenantId, maxId));
}

export function loadPendingExtractionTenants(hippoRoot: string): { tenantId: string; maxPendingId: number }[] {
  return onHandle(hippoRoot, (db) => loadPendingExtractionTenantsAt(db));
}

export function loadEntitiesByMemoryId(hippoRoot: string, tenantId: string, memoryIds: readonly string[]): Entity[] {
  return sqliteSyncStore(hippoRoot).graphReads.entitiesForMemories(tenantId, memoryIds);
}

export function loadLatestHandoff(
  hippoRoot: string,
  tenantId: string,
  sessionId?: string,
  opts: HandoffFilter = {},
  key?: ContinuityKey,
): SessionHandoff | null {
  return onHandle(hippoRoot, (db) => loadLatestHandoffAt(db, tenantId, sessionId, opts, key), openStore);
}

export function loadHandoffById(hippoRoot: string, tenantId: string, id: number): SessionHandoff | null {
  return onHandle(hippoRoot, (db) => loadHandoffByIdAt(db, tenantId, id), openStore);
}

export function stampHandoffOutcome(
  hippoRoot: string,
  tenantId: string,
  sessionId: string,
  outcome: HandoffOutcome,
): number {
  return onHandle(hippoRoot, (db) => stampHandoffOutcomeAt(db, tenantId, sessionId, outcome), openStore);
}

export function writeSessionEndHandoff(hippoRoot: string, request: SessionEndHandoffRequest): SessionHandoff | null {
  return onHandle(hippoRoot, (db) => writeSessionEndHandoffAt(db, { hippoRoot }, request.tenantId, request), openStore);
}

export function loadLastRecall(hippoRoot: string): Pick<HippoIndex, 'last_retrieval_ids' | 'last_trace_id'> {
  return onHandle(hippoRoot, (db) => readLastRecall(db), openStore);
}

export function saveIndex(hippoRoot: string, index: Pick<HippoIndex, 'last_retrieval_ids' | 'last_trace_id'>): void {
  return onHandle(hippoRoot, (db) => saveIndexAt(db, index), openStore);
}

export function updateStatsUnlessBusy(
  hippoRoot: string,
  delta: Parameters<typeof updateStatsUnlessBusyAt>[2],
  committed: string,
): void {
  onHandle(hippoRoot, (db) => updateStatsUnlessBusyAt(db, { hippoRoot }, delta, committed), openStore);
}

export function appendConsolidationRun(
  hippoRoot: string,
  run: { timestamp: string; decayed: number; merged: number; removed: number },
): void {
  onHandle(hippoRoot, (db) => appendConsolidationRunAt(db, { hippoRoot }, run), openStore);
}

export function loadSessionDecayContext(hippoRoot: string): SessionDecayContext {
  return onHandle(hippoRoot, (db) => loadSessionDecayContextAt(db), openStore);
}

export function closePrediction(
  hippoRoot: string,
  tenantId: string,
  id: number,
  close: PredictionClose,
  actor: string = CLI_ACTOR,
): Prediction {
  return sqliteSyncStore(hippoRoot).predictions.closePrediction(tenantId, id, close, actor);
}

export function loadPredictionById(hippoRoot: string, tenantId: string, id: number): Prediction | null {
  return sqliteSyncStore(hippoRoot).predictions.predictionById(tenantId, id);
}

export function loadPredictionsByClass(
  hippoRoot: string,
  tenantId: string,
  classTag: string,
  opts: { closureState?: ClosureState; limit?: number; after?: KeysetPosition } = {},
): Prediction[] {
  const { closureState, after } = opts;
  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  return sqliteSyncStore(hippoRoot).predictions.listPredictions(
    tenantId,
    closureState === undefined ? { classTag, limit, after } : { classTag, closureState, limit, after },
  );
}

export function loadAllPredictions(
  hippoRoot: string,
  tenantId: string,
  opts: { limit?: number; after?: KeysetPosition } = {},
): Prediction[] {
  return sqliteSyncStore(hippoRoot).predictions.listPredictions(tenantId, {
    limit: opts.limit ?? DEFAULT_LIST_LIMIT,
    after: opts.after,
  });
}

export function computePredictionBaserate(
  hippoRoot: string,
  tenantId: string,
  classTag: string,
  actor: string = CLI_ACTOR,
  emitAudit: boolean = true,
): PredictionBaserate {
  return onHandle(hippoRoot, (db) => computePredictionBaserateAt(db, tenantId, classTag, actor, emitAudit));
}

export function loadOpenPredictions(
  hippoRoot: string,
  tenantId: string,
  opts: { classTag?: string; limit?: number; after?: KeysetPosition } = {},
): Prediction[] {
  const { classTag, after } = opts;
  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  return sqliteSyncStore(hippoRoot).predictions.listPredictions(tenantId, {
    classTag,
    closureState: 'open',
    limit,
    after,
  });
}

export function loadRecallEntries(
  hippoRoot: string,
  query: string,
  options: Partial<RecallSearchEntriesOptions> = {},
): MemoryEntry[] {
  return onHandle(
    hippoRoot,
    (db) => loadRecallEntriesAt(db, query, { ...options, tenantId: options.tenantId ?? ALL_TENANTS }),
    openStore,
  );
}

export function loadActiveTaskSnapshot(hippoRoot: string, tenantId: string, key?: ContinuityKey): TaskSnapshot | null {
  return onHandle(hippoRoot, (db) => loadActiveTaskSnapshotAt(db, { hippoRoot }, tenantId, key), openStore);
}

export function loadFreshActiveTaskSnapshot(
  hippoRoot: string,
  tenantId: string,
  opts: { maxAgeMs?: number; sessionId?: string | null } = {},
  key?: ContinuityKey,
): TaskSnapshot | null {
  return freshActiveSnapshot(loadActiveTaskSnapshot(hippoRoot, tenantId, key), opts);
}

export function clearActiveTaskSnapshot(
  hippoRoot: string,
  tenantId: string,
  clearedStatus: string = 'cleared',
): boolean {
  return sqliteSyncStore(hippoRoot).sessions.clearSnapshot(tenantId, clearedStatus);
}

export function closeTaskSnapshotsForSession(
  hippoRoot: string,
  tenantId: string,
  sessionId: string,
  status: string = 'session-ended',
  key?: ContinuityKey,
): number {
  return sqliteSyncStore(hippoRoot).sessions.closeSessionSnapshots(tenantId, sessionId, status, key ?? null);
}

export function listSessionEvents(
  hippoRoot: string,
  tenantId: string,
  options: { session_id?: string; task?: string; limit?: number } = {},
): SessionEvent[] {
  return onHandle(hippoRoot, (db) => listSessionEventsAt(db, tenantId, options), openStore);
}

export function findPromotableSessions(
  hippoRoot: string,
  tenantId: string,
  sinceMs: number,
): Array<{ session_id: string }> {
  return onHandle(hippoRoot, (db) => findPromotableSessionsAt(db, tenantId, sinceMs), openStore);
}

export function loadAllL2Summaries(hippoRoot: string): MemoryEntry[] {
  return sqliteSyncStore(hippoRoot).localFiles.consolidation.unprofiledTopicSummaries();
}

export function loadAllDirtySummaries(hippoRoot: string, limit?: number): MemoryEntry[] {
  return sqliteSyncStore(hippoRoot).localFiles.consolidation.dirtySummaries(limit ?? Number.MAX_SAFE_INTEGER);
}

export function loadChildrenOfSummary(hippoRoot: string, summaryId: string, tenantId: string): MemoryEntry[] {
  return sqliteSyncStore(hippoRoot).localFiles.consolidation.childrenOfSummary(summaryId, tenantId);
}

export function applyRebuildResult(hippoRoot: string, summary: MemoryEntry, patch: RebuildPatch) {
  return sqliteSyncStore(hippoRoot).localFiles.consolidation.applyRebuild(summary, patch);
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

/** Replaces every stored vector with `index`, as a rebuild's commit does; `model` defaults to the stored identity. */
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
  return onHandle(hippoRoot, (db) => loadStoredParticlesAt(db));
}

export function resetStoredParticles(hippoRoot: string): number {
  return onHandle(hippoRoot, (db) => resetStoredParticlesAt(db, {}));
}

export function seedStoredParticle(hippoRoot: string, entry: MemoryEntry, vector: number[]): void {
  return onHandle(hippoRoot, (db) => seedStoredParticleAt(db, {}, entry, vector));
}

export function wmPush(
  hippoRoot: string,
  opts: {
    scope: string;
    content: string;
    importance?: number;
    sessionId?: string;
    taskId?: string;
    metadata?: JsonObject;
    tenantId?: string;
  },
): number {
  return sqliteSyncStore(hippoRoot).sessions.pushWorkingMemory(opts.tenantId ?? resolveTenantId({}), opts);
}

export function wmRead(
  hippoRoot: string,
  opts?: {
    scope?: string;
    sessionId?: string;
    limit?: number;
    tenantId?: string;
  },
): WorkingMemoryItem[] {
  return sqliteSyncStore(hippoRoot).sessions.readWorkingMemory(opts?.tenantId ?? resolveTenantId({}), opts ?? {});
}

export function wmClear(
  hippoRoot: string,
  opts?: {
    scope?: string;
    sessionId?: string;
    tenantId?: string;
  },
): number {
  return sqliteSyncStore(hippoRoot).sessions.clearWorkingMemory(opts?.tenantId ?? resolveTenantId({}), opts ?? {});
}

export function auditHighId(hippoRoot: string): number {
  return sqliteSyncStore(hippoRoot).keyAudit.auditHighId();
}

export function recordAuditEventsRowByRow(hippoRoot: string, events: readonly AppendAuditOpts[]): FailedAuditEvent[] {
  return onHandle(hippoRoot, (db) => recordAuditEventsRowByRowAt(db, events));
}

export function githubEventRecord(hippoRoot: string, idempotencyKey: string): ConnectorEventRecord {
  return onHandle(hippoRoot, (db) => githubEventRecordAt(db, idempotencyKey));
}

export function markGitHubEventSeen(hippoRoot: string, entry: GitHubEventLogEntry): void {
  onHandle(hippoRoot, (db) => {
    markGitHubEventSeenAt(db, entry);
  });
}

export function slackEventRecord(hippoRoot: string, eventId: string): ConnectorEventRecord {
  return onHandle(hippoRoot, (db) => slackEventRecordAt(db, eventId));
}

export function markSlackEventSeen(hippoRoot: string, eventId: string, memoryId: string | null): void {
  onHandle(hippoRoot, (db) => {
    markSlackEventSeenAt(db, eventId, memoryId);
  });
}

export function commitInChunks(
  hippoRoot: string,
  components: readonly FlushComponent[],
  opts: { snapshot: LoadedRows; budget: WriteBudget; busyWaitMs: number },
): Promise<string[]> {
  return handlesOf(hippoRoot).onAsync(
    (db, files) => commitInChunksAt(db, files, components, opts),
    waitingOpener(opts.busyWaitMs, openStore),
  );
}

export function markGraphDirty(hippoRoot: string, tenantId: string, memoryId: string | null): void {
  onHandle(hippoRoot, (db) => markGraphDirtyAt(db, tenantId, memoryId));
}

export function loadEntitiesByIds(hippoRoot: string, tenantId: string, ids: readonly number[]): Entity[] {
  return sqliteSyncStore(hippoRoot).graphReads.entitiesByIds(tenantId, ids);
}

export function loadNeighborRelations(
  hippoRoot: string,
  tenantId: string,
  entityIds: readonly number[],
  opts: { limit?: number } = {},
): Relation[] {
  return sqliteSyncStore(hippoRoot).graphReads.neighborRelations(tenantId, entityIds, { limit: opts.limit ?? 1000 });
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

/** Keys of every tenant under `hippoRoot` unless `opts.tenantId` names one. */
export function listApiKeys(hippoRoot: string, opts: ListApiKeysOpts): ApiKeyListItem[] {
  return onHandle(hippoRoot, (db) => listApiKeyRows(db, opts).map((r) => r.key));
}

export function loadSearchEntries(
  hippoRoot: string,
  query: string,
  limit?: number,
  tenantId: TenantId = ALL_TENANTS,
): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => loadSearchEntriesAt(db, query, limit, tenantId), openStore);
}

/** Promotes `id` through the api, vetoes included, into the global store under HIPPO_HOME and returns the copy;
 * `owner` lets the caller reach its own personal rows. */
export async function copyToGlobal(
  hippoRoot: string,
  id: string,
  opts: { tenantId?: string; owner?: string } = {},
): Promise<MemoryEntry> {
  const ctx = apiCtx(hippoRoot, opts.tenantId ?? 'default', { subject: CLI_ACTOR, role: 'admin', owner: opts.owner });
  const { globalId } = await promote(ctx, id);
  const copy = ctx.reach?.globalTarget?.store.localFiles.learning.readEntry(globalId, ctx.tenantId);
  if (!copy) throw new Error(`the promoted copy ${globalId} is not in the global store`);
  return copy;
}

export function writePromotedEntry(
  hippoRoot: string,
  entry: MemoryEntry,
  opts: Parameters<typeof writePromotedEntryAt>[3],
): void {
  onHandle(hippoRoot, (db) => writePromotedEntryAt(db, { hippoRoot }, entry, opts), openStore);
}

export function updateStats(hippoRoot: string, delta: Parameters<typeof updateStatsAt>[2]): void {
  onHandle(hippoRoot, (db) => updateStatsAt(db, { hippoRoot }, delta), openStore);
}

/** Opens the store unmigrated, read-only for a preview, as the store's own quality repair does. */
export function repairAutomaticMemories(
  files: StoreFiles,
  opts: { tenantId: string; protect: RepairProtection; apply?: boolean },
): QualityRepairResult {
  return sqliteSyncStore(files.hippoRoot).auditMaintenance.repairQuality(
    opts.tenantId,
    opts.apply ?? false,
    opts.protect,
  );
}

export function repairQualityOnce(
  files: StoreFiles,
  tenantId: string,
  protect: RepairProtection,
): QualityRepairResult | null {
  return sqliteSyncStore(files.hippoRoot).auditMaintenance.repairQualityOnce(tenantId, protect);
}
