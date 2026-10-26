// The outside services a composition root hands the api in its Context; src/infra/ports.ts builds the real ones.
import type { Machine } from '../util/agent-homes.js';
import type { EmbedderFor } from './embedder.js';
import type { Llm } from './llm.js';
import type { RerankerLookup } from './reranker.js';
import type { ReadApiCalls } from '../session/transcript-calls.js';
import type { EvalSwitches } from '../memory/eval-switches.js';
import type { StrengthModel } from '../memory/strength.js';

export interface InfraPorts {
  /** The disk the agent-memory and project-repair reads look at, with its git. */
  readonly machine: Machine;
  /** The model the LLM phases call; absent when none is configured, so they are skipped. */
  readonly llm?: Llm;
  /** Builds the provider that embeds a recall's query from a store's embeddings config. */
  readonly embedderFor: EmbedderFor;
  /** The rerankers a recall names, built once per root so the cross-encoder loads once; absent, no name resolves. */
  readonly reranker?: RerankerLookup;
  /** Reads the model calls of a session's transcript for its re-read count; absent, the count is skipped. */
  readonly transcriptCalls?: ReadApiCalls;
  /** The strength model and rank switches the root read from its environment; absent, production ranking. */
  readonly evalSwitches?: EvalSwitches;
  /** The time every api and domain step reads: the root's wall clock, or the fixed instant an eval set. */
  readonly clock: Clock;
}

/** The current time as a root defines it; code below a root takes one, never the wall clock. */
export type Clock = () => Date;

/** What a root opens a store with, as plain values so they cross to a worker thread: the strength model it scores by
 * (production when absent) at HIPPO_LOSS_AVERSION_RATIO, and HIPPO_FAKE_NOW as epoch milliseconds, else the wall
 * clock. */
export interface StoreRules {
  readonly strength?: StrengthModel;
  readonly lossAversionRatio?: number;
  readonly fakeNowMs?: number | null;
}
