// The outside services a composition root hands the api in its Context; src/infra/ports.ts builds the real ones.
import type { Machine } from '../util/agent-homes.js';
import type { EmbedderFor } from './embedder.js';
import type { Llm } from './llm.js';

export interface InfraPorts {
  /** The disk the agent-memory and project-repair reads look at, with its git. */
  readonly machine: Machine;
  /** The model the LLM phases call; absent when none is configured, so they are skipped. */
  readonly llm?: Llm;
  /** Builds the provider that embeds a recall's query from a store's embeddings config. */
  readonly embedderFor: EmbedderFor;
}
