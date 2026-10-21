// The embedder port: ranking embeds its query with the provider a root hands it; base/embeddings builds the real one.
import type { EmbeddingsConfig } from '../config/config.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';

/** The embedding provider `embeddings` names; a root passes the real resolver, a test may pass its own. */
export type EmbedderFor = (embeddings: EmbeddingsConfig) => EmbeddingProvider;
