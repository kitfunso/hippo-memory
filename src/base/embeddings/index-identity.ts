// Which model and text format built a vector index, and when a provider change means a rebuild: pure rules that every
// store and the search side apply alike.

import { DEFAULT_EMBEDDING_MODEL } from './local.js';

/** What a store's vector index was built by: the stored identity, and whether any vector exists. */
export interface EmbeddingIndexState {
  readonly storedModel: string | null;
  readonly hasVectors: boolean;
}

/** Bump when `embeddingInputText` changes existing vectors, so the text change reindexes like a model change. */
const EMBED_TEXT_FORMAT = 2;

/** The stored identity for a provider id; compare and save must both go through it or every call reindexes. */
export function embeddingIndexIdentity(providerId: string): string {
  return `${providerId}#t${EMBED_TEXT_FORMAT}`;
}

/** Content plus tags minus `path:*`, which derive from cwd and would embed one text differently per store folder. */
export function embeddingInputText(entry: { content: string; tags: string[] }): string {
  const tags = entry.tags.filter((t) => !t.startsWith('path:'));
  return `${entry.content} ${tags.join(' ')}`.trim();
}

/** The one rebuild rule every store applies to its indexed model. */
export function indexNeedsRebuild(indexed: string | null, providerId: string): boolean {
  return indexed !== null && indexed !== embeddingIndexIdentity(providerId);
}

/** The model the index was built by: the stored identity, else the default model when vectors exist. */
export function indexedModel(state: EmbeddingIndexState): string | null {
  return state.storedModel ?? (state.hasVectors ? DEFAULT_EMBEDDING_MODEL : null);
}

/** Whether a vector write under the index identity `model` first drops the stored index, which another model built. */
export function replacesIndex(state: EmbeddingIndexState, model: string): boolean {
  const indexed = indexedModel(state);
  return indexed !== null && indexed !== model;
}
