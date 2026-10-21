/**
 * Hippo public API  - re-exports for programmatic use.
 */

import {
  createMemory as createStoreMemory,
  DEFAULT_HALF_LIFE_DAYS,
  type CreateMemoryOptions,
  type MemoryEntry,
} from './base/memory/memory.js';
import { defaultStore, withSharedStoreHandles } from './surface/open-store.js';
import type { SleepStore } from './store/port.js';
import { runConsolidation, type ConsolidateOptions } from './domain/consolidate/sleep.js';
import { anthropicLlmFromEnv } from './infra/ports.js';
import { loadConfig } from './base/config/config.js';
import { DEFAULT_TENANT_ID } from './base/util/tenant.js';
import type { ConsolidationResult } from './domain/consolidate/run.js';
import { sleep as sleepStore, type SleepOpts, type SleepResult } from './api/sleep/sleep.js';
import type { SleepContext } from './api/types.js';
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
} from './base/memory/memory.js';

/**
 * Published signature, so `baseHalfLifeDays` stays optional here; hippo's own writers use the strict one in memory.ts.
 */
export function createMemory(content: string, options: Partial<CreateMemoryOptions> = {}): MemoryEntry {
  return createStoreMemory(content, {
    ...options,
    baseHalfLifeDays: options.baseHalfLifeDays ?? DEFAULT_HALF_LIFE_DAYS,
  });
}
export { search } from './domain/search/bm25-search.js';
export { hybridSearch } from './entry/folder-search.js';
export { explainMatch, MatchExplanation } from './domain/search/explain.js';
export { detectTemporalDirection, temporalBoost, computeTemporalRange } from './domain/search/temporal.js';
export { SearchResult } from './base/rank/search-types.js';
export { estimateTokens } from './base/util/token-text.js';
export { tokenize, textOverlap } from './base/util/tokenize.js';
export { markRetrieved } from './base/memory/memory.js';
export { multihopSearch } from './domain/search/multihop.js';
export { graphExpandRecall, MAX_HOPS, DEFAULT_MAX_NEIGHBORS, type GraphExpandOpts } from './domain/graph/recall.js';

// Session handoff
export { SessionHandoff, HandoffOutcome, HandoffEvidence, isHandoffOutcome } from './base/session/handoff.js';
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
} from './base/records/card.js';
export { ConsolidationResult } from './domain/consolidate/run.js';
export type { SleepOpts, SleepResult } from './api/sleep/sleep.js';
// Named in the signatures of sleep and consolidate, so a caller needs them to type its own variable.
export type { SleepContext, SleepStore };
/** Sleeps the whole store under `ctx`, whose store sets the groups a sleep pass works on. */
export async function sleep(ctx: SleepContext, opts?: SleepOpts): Promise<SleepResult> {
  // One handle per store, as `hippo sleep` has: a pass that opened its own would make each close hippo.db's last, which
  // checkpoints and deletes the WAL.
  return withSharedStoreHandles(() => sleepStore(ctx, opts));
}
/** consolidate's options as published: the LLM phases call the model ANTHROPIC_API_KEY opens, over `fetcher`. */
type PublishedConsolidateOptions = Omit<ConsolidateOptions, 'llm'> & { fetcher?: typeof fetch };

/** Run a full consolidation pass on `store`, or on the hippo.db under a folder. With no `options.config`, a folder
 * reads its config.json and a store the defaults. */
export async function consolidate(
  target: string | SleepStore,
  options: PublishedConsolidateOptions = {},
): Promise<ConsolidationResult> {
  const [store, root] = isFolder(target) ? [defaultStore(target), target] : [target, ''];
  const { fetcher, ...rest } = options;
  const config = options.config ?? loadConfig(root);
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  const llm = anthropicLlmFromEnv(fetcher);
  // One handle per store, for the reason `sleep` gives.
  return withSharedStoreHandles(() => runConsolidation(store, { ...rest, config, tenantId, llm }));
}
function isFolder(target: string | SleepStore): target is string {
  return typeof target === 'string';
}
// The one dedupe.js export that is public; the rest of dedupe.js stays internal.
export { strengthTieKey as strengthBucket } from './domain/consolidate/dedupe.js';

// Embedding search
export { isEmbeddingAvailable } from './base/embeddings/local.js';
export { getEmbedding } from './infra/local-embedder.js';

// Auto-learn from errors
export { captureError, extractLessons, partitionLessons } from './domain/learn/autolearn.js';

// Cross-agent shared memory
export { getGlobalRoot } from './domain/sharing/global-store.js';
export { transferScore } from './domain/sharing/share.js';

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
export { ImportResult, ImportOptions } from './surface/importers/core.js';

// Eval suite
export {
  runFeatureEval,
  formatResult,
  resultToBaseline,
  detectRegressions,
  buildSyntheticCorpus,
} from './domain/eval/eval-suite.js';

// Salience gate
export { computeSalience, SalienceDecision, SalienceResult, SalienceOptions } from './base/memory/salience.js';

// Ambient state vector
export { computeAmbientState, renderAmbientSummary, formatAmbientVector, AmbientState } from './base/memory/ambient.js';
