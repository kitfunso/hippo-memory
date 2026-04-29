/**
 * Hippo public API  - re-exports for programmatic use.
 */

export { MemoryEntry, Layer, EmotionalValence, ConfidenceLevel, DecayOptions, calculateStrength, resolveConfidence, createMemory, applyOutcome, generateId, computeSchemaFit } from './memory.js';
export { search, hybridSearch, physicsSearch, markRetrieved, estimateTokens, textOverlap, tokenize, explainMatch, detectTemporalDirection, temporalBoost, computeTemporalRange, SearchResult, MatchExplanation } from './search.js';
export { multihopSearch } from './multihop.js';
export {
  initStore,
  loadAllEntries,
  loadSearchEntries,
  writeEntry,
  readEntry,
  deleteEntry,
  loadIndex,
  rebuildIndex,
  saveActiveTaskSnapshot,
  loadActiveTaskSnapshot,
  clearActiveTaskSnapshot,
  appendSessionEvent,
  listSessionEvents,
  listMemoryConflicts,
  replaceDetectedConflicts,
  resolveConflict,
  saveSessionHandoff,
  loadLatestHandoff,
  loadHandoffById,
  loadSessionDecayContext,
  SessionDecayContext,
} from './store.js';

// Feature 5: Session handoff
export { SessionHandoff } from './handoff.js';
export { consolidate, ConsolidationResult } from './consolidate.js';

// Feature 1: Embedding search
export {
  isEmbeddingAvailable,
  getEmbedding,
  cosineSimilarity,
  loadEmbeddingIndex,
  saveEmbeddingIndex,
  embedMemory,
  embedAll,
} from './embeddings.js';

// Feature 2: Auto-learn from errors
export {
  captureError,
  extractLessons,
  deduplicateLesson,
  runWatched,
  fetchGitLog,
} from './autolearn.js';

// Feature 3: Cross-agent shared memory
export {
  getGlobalRoot,
  initGlobal,
  promoteToGlobal,
  searchBoth,
  searchBothHybrid,
  syncGlobalToLocal,
  HybridSearchOptions,
  transferScore,
  shareMemory,
  listPeers,
  autoShare,
} from './shared.js';

// Feature 5: Working memory
export {
  wmPush,
  wmRead,
  wmClear,
  wmFlush,
  WorkingMemoryItem,
  WM_MAX_ENTRIES,
} from './working-memory.js';

// Feature 4: Memory importers
export {
  importChatGPT,
  importClaude,
  importCursor,
  importGenericFile,
  importMarkdown,
  importEntries,
  ImportResult,
  ImportOptions,
} from './importers.js';

// Feature eval suite
export {
  runFeatureEval,
  formatResult,
  resultToBaseline,
  detectRegressions,
  buildSyntheticCorpus,
} from './eval-suite.js';

// Pineal gland: salience gate
export {
  computeSalience,
  SalienceDecision,
  SalienceResult,
  SalienceOptions,
} from './salience.js';

// Pineal gland: ambient state vector
export {
  computeAmbientState,
  renderAmbientSummary,
  formatAmbientVector,
  AmbientState,
} from './ambient.js';
