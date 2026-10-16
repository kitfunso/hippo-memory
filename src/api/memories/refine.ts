// The write half of `hippo refine`: the model call stays with the caller, the rewritten row is stored here.

import type { MemoryEntry } from '../../core/memory.js';
import type { ContextWith } from '../types.js';

/** Marks a merged memory a model has rewritten, so a later pass skips it. */
export const REFINED_TAG = 'llm-refined';

/**
 * Store a model's rewrite of a merged memory: the new text replaces the old one, and the row gains the refined tag
 * once.
 */
export async function storeRefinement(
  ctx: ContextWith<'entryWrites'>,
  entry: MemoryEntry,
  refined: string,
): Promise<void> {
  const tags = entry.tags.includes(REFINED_TAG) ? entry.tags : [...entry.tags, REFINED_TAG];
  await ctx.store.entryWrites.writeEntry({ entry: { ...entry, content: refined, tags }, actor: ctx.actor.subject });
}
