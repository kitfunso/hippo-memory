/**
 * Hippo public API  - re-exports for programmatic use.
 */

import {
  createMemory as createStoreMemory,
  DEFAULT_HALF_LIFE_DAYS,
  type CreateMemoryOptions,
  type MemoryEntry,
} from './core/memory.js';
import { sleep as sleepOnStore, type SleepOpts, type SleepResult } from './api/sleep/sleep.js';
import type { Context } from './api/types.js';
import { withStoreGroups } from './store/sqlite/store.js';
export {
  MemoryEntry,
  Layer,
  EmotionalValence,
  ConfidenceLevel,
  DecayOptions,
  calculateStrength,
  resolveConfidence,
  confidenceFacets,
  type ConfidenceFacets,
  applyOutcome,
  generateId,
  computeSchemaFit
} from './core/memory.js';

/** Core's camelCase options, plus the snake_case spellings 2.0 published; the camelCase key wins when both are set. */
type PublicCreateMemoryOptions = CreateMemoryOptions & {
  /** @deprecated Use emotionalValence; removed in 3.0. */
  emotional_valence?: CreateMemoryOptions['emotionalValence'];
  /** @deprecated Use schemaFit; removed in 3.0. */
  schema_fit?: CreateMemoryOptions['schemaFit'];
  /** @deprecated Use traceOutcome; removed in 3.0. */
  trace_outcome?: CreateMemoryOptions['traceOutcome'];
  /** @deprecated Use sourceSessionId; removed in 3.0. */
  source_session_id?: CreateMemoryOptions['sourceSessionId'];
  /** @deprecated Use validFrom; removed in 3.0. */
  valid_from?: CreateMemoryOptions['validFrom'];
  /** @deprecated Use extractedFrom; removed in 3.0. */
  extracted_from?: CreateMemoryOptions['extractedFrom'];
  /** @deprecated Use dagLevel; removed in 3.0. */
  dag_level?: CreateMemoryOptions['dagLevel'];
  /** @deprecated Use dagParentId; removed in 3.0. */
  dag_parent_id?: CreateMemoryOptions['dagParentId'];
  /** @deprecated Use artifactRef; removed in 3.0. */
  artifact_ref?: CreateMemoryOptions['artifactRef'];
};

/** Published signature, so `baseHalfLifeDays` stays optional
 * here; hippo's own writers use the strict one in memory.ts. */
export function createMemory(content: string, options: Partial<PublicCreateMemoryOptions> = {}): MemoryEntry {
  return createStoreMemory(content, {
    ...options,
    emotionalValence: options.emotionalValence ?? options.emotional_valence,
    schemaFit: options.schemaFit ?? options.schema_fit,
    traceOutcome: options.traceOutcome ?? options.trace_outcome,
    sourceSessionId: options.sourceSessionId ?? options.source_session_id,
    validFrom: options.validFrom ?? options.valid_from,
    extractedFrom: options.extractedFrom ?? options.extracted_from,
    dagLevel: options.dagLevel ?? options.dag_level,
    dagParentId: options.dagParentId ?? options.dag_parent_id,
    artifactRef: options.artifactRef ?? options.artifact_ref,
    baseHalfLifeDays: options.baseHalfLifeDays ?? DEFAULT_HALF_LIFE_DAYS,
  });
}
export { search } from './search/bm25-search.js';
export { hybridSearch } from './search/hybrid.js';
export { physicsSearch } from './search/physics-search.js';
export { explainMatch, MatchExplanation } from './search/explain.js';
export { detectTemporalDirection, temporalBoost, computeTemporalRange } from './search/temporal.js';
export { SearchResult } from './core/search-types.js';
export { estimateTokens } from './util/token-text.js';
export { tokenize, textOverlap } from './util/tokenize.js';
export { markRetrieved } from './core/memory.js';
export { multihopSearch } from './search/multihop.js';
export { graphExpandRecall, MAX_HOPS, DEFAULT_MAX_NEIGHBORS, type GraphExpandOpts } from './graph/recall.js';
export { initStore } from './store/open.js';
export { writeEntry } from './store/entry-writes.js';
export { loadAllEntries, readEntry } from './store/entry-reads.js';
export { deleteEntry } from './store/delete-and-batch.js';
export { loadSearchEntries, loadRecallEntries, type RecallSearchEntriesOptions } from './store/search-rows.js';
export { loadIndex, rebuildIndex, loadSessionDecayContext, SessionDecayContext } from './store/index-and-stats.js';
export {
  saveActiveTaskSnapshot,
  loadActiveTaskSnapshot,
  loadFreshActiveTaskSnapshot,
  SNAPSHOT_AMBIENT_MAX_AGE_MS,
  closeTaskSnapshotsForSession,
  clearActiveTaskSnapshot,
  appendSessionEvent,
  listSessionEvents,
  type ContinuityKey,
} from './store/sessions.js';
export { listMemoryConflicts, replaceDetectedConflicts, resolveConflict } from './store/conflicts.js';
export {
  saveSessionHandoff,
  loadLatestHandoff,
  loadHandoffById,
  stampHandoffOutcome,
  writeSessionEndHandoff,
} from './store/handoffs.js';
export {
  createCard,
  loadCard,
  listCards,
  loadCardDeps,
  loadCardRuns,
  loadCardComments,
  claimCard,
  heartbeatCard,
  blockCard,
  reviewCard,
  completeCard,
  reclaimExpiredCards,
  addCardComment,
  loadLatestHandoffForCard,
} from './store/cards.js';

// Feature 5: Session handoff
export { SessionHandoff, HandoffOutcome, HandoffEvidence, isHandoffOutcome } from './core/handoff.js';
// W2a: work-queue cards
export {
  Card,
  CardStatus,
  CardRun,
  CardComment,
  CardTransitions,
  isCardStatus,
  CARD_TRANSITIONS,
  CARD_LEASE_MS,
} from './core/card.js';
export { consolidate } from './consolidate/sleep.js';
export { ConsolidationResult } from './consolidate/run.js';
export type { SleepOpts, SleepResult } from './api/sleep/sleep.js';
/** Published signature, so the Context may carry no store: it then runs on hippo.db under its root. */
export async function sleep(ctx: Context, opts?: SleepOpts): Promise<SleepResult> {
  return sleepOnStore(withStoreGroups(ctx, 'localFiles'), opts);
}
// Announced public in CHANGELOG 1.26.3 but never re-exported; the rest of dedupe.js stays internal.
export { strengthBucket } from './consolidate/dedupe.js';

// Feature 1: Embedding search
export { isEmbeddingAvailable, getEmbedding } from './embeddings/local.js';
export { cosineSimilarity } from './store/embeddings/index.js';
export { embedMemory, embedAll } from './search/embed-memories.js';
export { loadEmbeddingIndex, saveEmbeddingIndex } from './store/vector-index.js';

// Feature 2: Auto-learn from errors
export {
  captureError,
  extractLessons,
  partitionLessons,
  deduplicateLesson,
  runWatched,
  runWatchedLine,
  type RunWatchedOptions,
  fetchGitLog,
} from './learn/autolearn.js';

// Feature 3: Cross-agent shared memory
export { getGlobalRoot, initGlobal, promoteToGlobal } from './sharing/global-store.js';
export { searchBoth, searchBothHybrid, HybridSearchOptions } from './sharing/search-both.js';
export { syncGlobalToLocal } from './sharing/global-sync.js';
export { transferScore, shareMemory, listPeers, autoShare } from './sharing/share.js';

// Feature 5: Working memory
export {
  wmPush,
  wmRead,
  wmClear,
  wmFlush,
  WorkingMemoryItem,
  WM_MAX_ENTRIES,
} from './store/working-memory.js';

// Feature 4: Memory importers
export {
  importChatGPT,
  importClaude,
  importCursor,
  importGenericFile,
} from './importers/sources.js';
export { importMarkdown } from './importers/markdown.js';
export { importVault } from './importers/vault.js';
export { importEntries, ImportResult, ImportOptions } from './importers/core.js';

// Feature eval suite
export {
  runFeatureEval,
  formatResult,
  resultToBaseline,
  detectRegressions,
  buildSyntheticCorpus,
} from './eval/eval-suite.js';

// Pineal gland: salience gate
export {
  computeSalience,
  SalienceDecision,
  SalienceResult,
  SalienceOptions,
} from './core/salience.js';

// Pineal gland: ambient state vector
export {
  computeAmbientState,
  renderAmbientSummary,
  formatAmbientVector,
  AmbientState,
} from './core/ambient.js';
export {
  appendAuditEvent,
  queryAuditEvents,
  listAuditEventsAfter,
  AUDIT_OPS,
  type AuditEvent,
  type AuditOp,
  type QueryAuditOpts,
  type ListAuditAfterOpts,
} from './store/audit.js';
export * from './entry/sqlite-handles.js';
