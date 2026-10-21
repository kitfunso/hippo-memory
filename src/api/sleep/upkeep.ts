// A consolidation or dedupe pass on one store outside a sleep's Context: the stdio host's auto-sleep and `hippo dedup`.
import type { HippoConfig } from '../../base/config/config.js';
import { deduplicateStore, type DedupResult } from '../../domain/consolidate/dedupe.js';
import type { ConsolidationResult, ConsolidationStore } from '../../domain/consolidate/run.js';
import { runConsolidation } from '../../domain/consolidate/sleep.js';
import type { StoreWith } from '../../store/port.js';

export type { DedupResult };

/** A full consolidation pass on `store`, its trace rows written as `tenantId`. */
export function consolidateStore(
  store: ConsolidationStore,
  opts: { readonly config: HippoConfig; readonly tenantId: string },
): Promise<ConsolidationResult> {
  return runConsolidation(store, opts);
}

/** Removes the store's duplicates (the same text apart from spacing), or only lists them on a dry run. */
export function dedupeStore(store: StoreWith<'consolidation'>, dryRun: boolean): Promise<DedupResult> {
  return deduplicateStore(store, { dryRun });
}
