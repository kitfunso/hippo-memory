/**
 * Hippo public API  - re-exports for programmatic use.
 */

import { createMemory as createStoreMemory, DEFAULT_HALF_LIFE_DAYS, type CreateMemoryOptions, type MemoryEntry } from './core/memory.js';
export { MemoryEntry, Layer, EmotionalValence, ConfidenceLevel, DecayOptions, calculateStrength, resolveConfidence, confidenceFacets, type ConfidenceFacets, applyOutcome, generateId, computeSchemaFit } from './core/memory.js';

/** Published signature, so `baseHalfLifeDays` stays optional here; hippo's own writers use the strict one in memory.ts. */
export function createMemory(content: string, options: Partial<CreateMemoryOptions> = {}): MemoryEntry {
  return createStoreMemory(content, { ...options, baseHalfLifeDays: options.baseHalfLifeDays ?? DEFAULT_HALF_LIFE_DAYS });
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
export { loadSearchEntries, loadRecallSearchEntries } from './store/search-rows.js';
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
export { Card, CardStatus, CardRun, CardComment, CardTransitions, isCardStatus, CARD_TRANSITIONS, CARD_LEASE_MS } from './core/card.js';
export { consolidate } from './consolidate/sleep.js';
export { ConsolidationResult } from './consolidate/run.js';
export { sleep, type SleepOpts, type SleepResult } from './api/sleep.js';
// Announced public in CHANGELOG 1.26.3 but never re-exported; the rest of dedupe.js stays internal.
export { strengthBucket } from './consolidate/dedupe.js';

// Feature 1: Embedding search
export { isEmbeddingAvailable, getEmbedding } from './store/embeddings/local.js';
export {
  cosineSimilarity,
  embedMemory,
  embedAll,
} from './store/embeddings/index.js';
export { loadEmbeddingIndex, saveEmbeddingIndex } from './store/vector-index.js';

// Feature 2: Auto-learn from errors
export {
  captureError,
  extractLessons,
  partitionLessons,
  deduplicateLesson,
  runWatched,
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
export { openHippoDb, openHippoDbReadOnly, closeHippoDb, type DatabaseSyncLike } from './db/index.js';
