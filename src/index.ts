/**
 * Hippo public API  - re-exports for programmatic use.
 */

export { MemoryEntry, Layer, EmotionalValence, ConfidenceLevel, calculateStrength, resolveConfidence, createMemory, applyOutcome, generateId, computeSchemaFit } from './memory.js';
export { search, hybridSearch, markRetrieved, estimateTokens, textOverlap, SearchResult } from './search.js';
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
} from './store.js';
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
