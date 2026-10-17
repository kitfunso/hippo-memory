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
import { sqliteSyncStore, withStore } from './store/sqlite/store.js';
import { runConsolidation, type ConsolidateOptions } from './consolidate/sleep.js';
import { loadConfig } from './core/config.js';
import type { ConsolidationResult } from './consolidate/run.js';
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

/** Published signature, so `baseHalfLifeDays` stays optional
 * here; hippo's own writers use the strict one in memory.ts. */
export function createMemory(content: string, options: Partial<CreateMemoryOptions> = {}): MemoryEntry {
  return createStoreMemory(content, {
    ...options,
    baseHalfLifeDays: options.baseHalfLifeDays ?? DEFAULT_HALF_LIFE_DAYS,
  });
}
export { search } from './search/bm25-search.js';
export { hybridSearch } from './entry/folder-search.js';
export { explainMatch, MatchExplanation } from './search/explain.js';
export { detectTemporalDirection, temporalBoost, computeTemporalRange } from './search/temporal.js';
export { SearchResult } from './core/search-types.js';
export { estimateTokens } from './util/token-text.js';
export { tokenize, textOverlap } from './util/tokenize.js';
export { markRetrieved } from './core/memory.js';
export { multihopSearch } from './search/multihop.js';
export { graphExpandRecall, MAX_HOPS, DEFAULT_MAX_NEIGHBORS, type GraphExpandOpts } from './graph/recall.js';

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
export { ConsolidationResult } from './consolidate/run.js';
export type { SleepOpts, SleepResult } from './api/sleep/sleep.js';
/** Run a full consolidation pass on the hippo.db under `hippoRoot`. */
export async function consolidate(hippoRoot: string, options: ConsolidateOptions = {}): Promise<ConsolidationResult> {
  const config = options.config ?? loadConfig(hippoRoot);
  return runConsolidation(sqliteSyncStore(hippoRoot).localFiles, { ...options, config });
}
/** Published signature, so the Context may carry no store: it then runs on hippo.db under its root. */
export async function sleep(ctx: Context, opts?: SleepOpts): Promise<SleepResult> {
  return sleepOnStore(withStore(ctx), opts);
}
// Announced public in CHANGELOG 1.26.3 but never re-exported; the rest of dedupe.js stays internal.
export { strengthBucket } from './consolidate/dedupe.js';

// Feature 1: Embedding search
export { isEmbeddingAvailable, getEmbedding } from './embeddings/local.js';

// Feature 2: Auto-learn from errors
export { captureError, extractLessons, partitionLessons } from './learn/autolearn.js';

// Feature 3: Cross-agent shared memory
export { getGlobalRoot } from './sharing/global-store.js';
export { transferScore } from './sharing/share.js';

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
