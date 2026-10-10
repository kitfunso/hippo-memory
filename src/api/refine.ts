// The write half of `hippo refine`: the model call stays with the caller, the rewritten row is stored here.

import type { MemoryEntry } from '../core/memory.js';
import { writeEntry } from '../store/entry-writes.js';
import type { Context } from './types.js';

/** Marks a merged memory a model has rewritten, so a later pass skips it. */
export const REFINED_TAG = 'llm-refined';

/** Store a model's rewrite of a merged memory: the new text replaces the old one, and the row gains the refined tag once. */
export function storeRefinement(ctx: Context, entry: MemoryEntry, refined: string): void {
  const tags = entry.tags.includes(REFINED_TAG) ? entry.tags : [...entry.tags, REFINED_TAG];
  writeEntry(ctx.hippoRoot, { ...entry, content: refined, tags }, { actor: ctx.actor.subject });
}
