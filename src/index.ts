/**
 * Hippo public API  - re-exports for programmatic use.
 */

export { MemoryEntry, Layer, EmotionalValence, calculateStrength, createMemory, applyOutcome, generateId } from './memory.js';
export { search, markRetrieved, estimateTokens, textOverlap, SearchResult } from './search.js';
export { initStore, loadAllEntries, writeEntry, readEntry, deleteEntry, loadIndex, rebuildIndex } from './store.js';
export { consolidate, ConsolidationResult } from './consolidate.js';
