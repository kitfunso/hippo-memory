// The embedder port: domain hands texts to the provider a root gives it; src/infra/embedding-provider.ts builds the
// real ones.
import type { EmbeddingsConfig } from '../config/config.js';

export type EmbeddingProviderKind = 'local' | 'openai' | 'voyage' | 'cohere';

/** `query` is search input, `passage` is a document being indexed; no role means no prefix on any model. */
export type EmbeddingRole = 'query' | 'passage';

export interface EmbedCallOptions {
  /** Ends the whole call when it aborts, every batch and retry included. The local provider stops waiting only on a
   * model download, since nothing stops a load from disk or an in-process inference. */
  signal?: AbortSignal;
}

export interface EmbeddingProvider {
  readonly kind: EmbeddingProviderKind;
  readonly model: string;
  /**
   * Identity recorded in DB meta to drive reindex-on-change: bare model string for local, `${kind}:${model}` for api.
   */
  readonly id: string;
  /** Known fixed output dimension, if any (undefined for local / unknown). */
  readonly dimensions?: number;
  /** Env var holding this provider's API key (undefined for the local provider). */
  readonly keyEnv?: string;
  /** local -> dependency installed; api -> key present. NEVER throws. */
  isAvailable(): boolean;
  /** Batch-embed: one row per input in order, `[]` when that item could not be embedded.
   * MAY throw on a hard transport/auth failure so a reindex aborts before saving a partial index. */
  embed(texts: string[], role?: EmbeddingRole, call?: EmbedCallOptions): Promise<number[][]>;
}

export interface EmbedderOptions {
  /** Wins over the config's model, as `hippo embed --model` does. */
  readonly model?: string;
}

/** The embedding provider `embeddings` names; a root passes the real resolver, a test may pass its own. */
export type EmbedderFor = (embeddings: EmbeddingsConfig, opts?: EmbedderOptions) => EmbeddingProvider;
