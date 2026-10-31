/** The stored vector index's identity: which model and text format built it, and when a provider change means a
 * rebuild. Picking a provider and computing vectors sit in src/search/embed-memories.ts; this module only reads and
 * writes what is stored. */

import { cosineOf } from '../../core/cosine.js';
import { EMBEDDING_MODEL_META_KEY } from '../../db/vector-store.js';
import { indexedModel, saveIndexIdentity, storedIndexState } from '../vector-index.js';
import { errorMessage, log, errorFields } from '../../util/log.js';
import { rethrowIfSqliteBlocked } from '../../util/sqlite-blocked.js';

export { EMBEDDING_MODEL_META_KEY };

/** Bump when `embeddingInputText` changes existing vectors; folded into the stored index identity
 * (`embeddingIndexIdentity`) so it reindexes like a model change. Format 2 = `path:*` tags excluded; format 1
 * (implicit, no suffix) included them. */
export const EMBED_TEXT_FORMAT = 2;

/** Stored-index identity for a provider id: folds `EMBED_TEXT_FORMAT` in so a model or text-format change invalidates
 * the index. The ONE choke point for compare (`embeddingModelRequiresReindex`) and save (`saveStoredEmbeddingModel`);
 * they MUST version identically or every call reindexes. */
export function embeddingIndexIdentity(providerId: string): string {
  return `${providerId}#t${EMBED_TEXT_FORMAT}`;
}

/** Text embedded for an entry: content plus tags, space-joined and trimmed, minus `path:*` tags.
 * `path:*` tags derive from cwd, so identical content would embed differently per store location; path relevance is
 * handled by `pathOverlapScore`. */
export function embeddingInputText(entry: { content: string; tags: string[] }): string {
  const tags = entry.tags.filter((t) => !t.startsWith('path:'));
  return `${entry.content} ${tags.join(' ')}`.trim();
}

function loadStoredEmbeddingModel(hippoRoot: string): string | null {
  try {
    return storedIndexState(hippoRoot).storedModel;
  } catch (err) {
    rethrowIfSqliteBlocked(err);
    log.debug(`stored embedding model unreadable: ${errorMessage(err)}`, errorFields(err));
    return null;
  }
}

/** Persist the stored-index identity for `model` (see `embeddingIndexIdentity`); versioning happens here, not at call
 * sites, and must stay consistent with the compare side in `embeddingModelRequiresReindex`. */
export function saveStoredEmbeddingModel(hippoRoot: string, model: string): void {
  saveIndexIdentity(hippoRoot, embeddingIndexIdentity(model));
}

/** The one rebuild rule every store applies to its indexed model. */
export function indexNeedsRebuild(indexed: string | null, providerId: string): boolean {
  return indexed !== null && indexed !== embeddingIndexIdentity(providerId);
}

export function resolveIndexedEmbeddingModel(
  hippoRoot: string,
  index?: Record<string, number[]>,
): string | null {
  const storedModel = loadStoredEmbeddingModel(hippoRoot);
  if (storedModel) return storedModel;
  return indexedModel({
    storedModel,
    hasVectors: index ? Object.keys(index).length > 0 : storedIndexState(hippoRoot).hasVectors,
  });
}

export function embeddingModelRequiresReindex(
  hippoRoot: string,
  model: string,
  index?: Record<string, number[]>,
): boolean {
  return indexNeedsRebuild(resolveIndexedEmbeddingModel(hippoRoot, index), model);
}

/** Cosine similarity; handles unnormalized vectors, returns 0 for empty or mismatched vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  return cosineOf(a, b);
}
