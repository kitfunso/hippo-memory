import type { HippoConfig } from './config.js';
import type { EmbedderFor } from '../ports/embedder.js';

/** A store with the config its root loaded and the root's embedder, so a write into it embeds
 * with the provider that config names. */
export interface ConfiguredFolder<S> {
  readonly store: S;
  readonly config: HippoConfig;
  readonly embedderFor: EmbedderFor;
}
