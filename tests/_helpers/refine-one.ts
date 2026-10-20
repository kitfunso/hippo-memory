import { refineStore } from '../../src/surface/cli/refine-llm.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { createMemory } from './default-half-life-memory.js';
import { makeRoot } from './make-root.js';
import { readEntry, writeEntry } from './root-forms.js';

/** Runs `hippo refine`'s path on a fresh store holding one consolidated entry with `merged` as its text and
 *  `sources` as its parents; returns the refined text stored, or null when the refinement failed. */
export async function refineOne(
  merged: string,
  sources: readonly MemoryEntry[],
  opts: { apiKey: string; fetcher: typeof fetch },
): Promise<string | null> {
  // The label keeps "refine" out of the path, since tests filter stderr on that word.
  const root = makeRoot('consolidated');
  const entry = {
    ...createMemory(`[Consolidated from ${sources.length} related memories]\n\n${merged}`, { layer: Layer.Semantic }),
    parents: sources.map((s) => s.id),
  };
  for (const source of sources) writeEntry(root, source);
  writeEntry(root, entry);
  const result = await refineStore(root, opts);
  return result.refined === 1 ? (readEntry(root, entry.id)?.content ?? null) : null;
}
