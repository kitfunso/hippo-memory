import type { EmbeddingsConfig } from '../config/config.js';

export type EmbeddingProviderKind = 'local' | 'openai' | 'voyage' | 'cohere';

/** `query` is search input, `passage` is a document being indexed; no role means no prefix on
 * any model. */
export type EmbeddingRole = 'query' | 'passage';

export interface EmbedCallOptions {
  /** Ends the whole call when it aborts, every batch and retry included. The local provider
   * stops waiting only on a model download, since nothing stops a load from disk or an
   * in-process inference. */
  signal?: AbortSignal;
}

export interface EmbeddingProvider {
  readonly kind: EmbeddingProviderKind;
  readonly model: string;
  readonly id: string;
  readonly dimensions?: number;
  readonly keyEnv?: string;
  isAvailable(): boolean;
  embed(texts: string[], role?: EmbeddingRole, call?: EmbedCallOptions): Promise<number[][]>;
}

export interface EmbedderOptions {
  readonly model?: string;
}

/** The embedding provider `embeddings` names; a root passes the real resolver, a test may pass
 * its own. */
export type EmbedderFor = (
  embeddings: EmbeddingsConfig,
  opts?: EmbedderOptions,
) => EmbeddingProvider;
