/**
 * Hippo public API  - re-exports for programmatic use.
 */

import {
  createMemory as createStoreMemory,
  DEFAULT_HALF_LIFE_DAYS,
  type CreateMemoryOptions,
  type MemoryEntry,
} from './core/memory.js';
import { sqliteStore } from './store/sqlite/store.js';
import type { LocalStore } from './store/local/index.js';
import { runConsolidation, type ConsolidateOptions } from './consolidate/sleep.js';
import { loadConfig } from './core/config.js';
import { DEFAULT_TENANT_ID } from './util/tenant.js';
import type { ConsolidationResult } from './consolidate/run.js';
import { sleep as sleepStore, type SleepOpts, type SleepResult } from './api/sleep/sleep.js';
import type { LocalContext } from './api/types.js';
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
  computeSchemaFit,
} from './core/memory.js';

/**
 * Published signature, so `baseHalfLifeDays` stays optional here; hippo's own writers use the strict one in memory.ts.
 */
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

// Session handoff
export { SessionHandoff, HandoffOutcome, HandoffEvidence, isHandoffOutcome } from './core/handoff.js';
// Work-queue cards
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
// Named in the signatures of sleep and consolidate, so a caller needs them to type its own variable.
export type { LocalContext, LocalStore };
/** Sleeps the whole store under `ctx`, whose store carries the local files a sleep pass works on. */
export async function sleep(ctx: LocalContext, opts?: SleepOpts): Promise<SleepResult> {
  return sleepStore(ctx, opts);
}
/** Run a full consolidation pass on `store`, or on the hippo.db under a folder. With no `options.config`, a folder
 * reads its config.json and a store the defaults. */
export async function consolidate(
  target: string | LocalStore,
  options: ConsolidateOptions = {},
): Promise<ConsolidationResult> {
  const [store, root] = isFolder(target) ? [sqliteStore(target), target] : [target, ''];
  const config = options.config ?? loadConfig(root);
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  return runConsolidation(store.localFiles, { ...options, config, tenantId });
}
function isFolder(target: string | LocalStore): target is string {
  return typeof target === 'string';
}
// The one dedupe.js export that is public; the rest of dedupe.js stays internal.
export { strengthBucket } from './consolidate/dedupe.js';

// Embedding search
export { isEmbeddingAvailable, getEmbedding } from './embeddings/local.js';

// Auto-learn from errors
export { captureError, extractLessons, partitionLessons } from './learn/autolearn.js';

// Cross-agent shared memory
export { getGlobalRoot } from './sharing/global-store.js';
export { transferScore } from './sharing/share.js';

// Memory importers
export {
  importChatGPT,
  importClaude,
  importCursor,
  importGenericFile,
  importMarkdown,
  importVault,
  importEntries,
} from './entry/importers.js';
export { ImportResult, ImportOptions } from './importers/core.js';

// Eval suite
export {
  runFeatureEval,
  formatResult,
  resultToBaseline,
  detectRegressions,
  buildSyntheticCorpus,
} from './eval/eval-suite.js';

// Salience gate
export { computeSalience, SalienceDecision, SalienceResult, SalienceOptions } from './core/salience.js';

// Ambient state vector
export { computeAmbientState, renderAmbientSummary, formatAmbientVector, AmbientState } from './core/ambient.js';
