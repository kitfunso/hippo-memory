// A consolidation or dedupe pass on one store outside a sleep's Context: the stdio host's auto-sleep and `hippo dedup`.
import type { HippoConfig } from '../../base/config/config.js';
import type { Llm } from '../../base/ports/llm.js';
import { deduplicateStore, type DedupResult } from '../../domain/consolidate/dedupe.js';
import type { ConsolidationResult, ConsolidationStore } from '../../domain/consolidate/run.js';
import { runConsolidation } from '../../domain/consolidate/sleep.js';
import type { StoreWith } from '../../store/port.js';

export type { DedupResult };
export { logPhaseFailures } from '../../domain/consolidate/run.js';

/** A full consolidation pass on `store`, its trace rows written as `tenantId`; its LLM phases call `llm` when set. */
export function consolidateStore(
  store: ConsolidationStore,
  opts: { readonly config: HippoConfig; readonly tenantId: string; readonly llm?: Llm },
): Promise<ConsolidationResult> {
  return runConsolidation(store, opts);
}

/** Removes the store's duplicates (the same text apart from spacing), or only lists them on a dry run. */
export function dedupeStore(store: StoreWith<'consolidation'>, dryRun: boolean): Promise<DedupResult> {
  return deduplicateStore(store, { dryRun });
}
