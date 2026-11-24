import type { Machine } from '../util/agent-homes.js';
import type { EmbedderFor } from './embedder.js';
import type { Llm } from './llm.js';
import type { RerankerLookup } from './reranker.js';
import type { ReadApiCalls } from '../session/transcript-calls.js';
import type { EvalSwitches } from '../memory/eval-switches.js';
import type { StrengthModel } from '../memory/strength.js';
import type { FailureNotices } from '../util/failure-notices.js';

export interface InfraPorts {
  readonly machine: Machine;
  readonly llm?: Llm;
  readonly embedderFor: EmbedderFor;
  readonly reranker?: RerankerLookup;
  readonly transcriptCalls?: ReadApiCalls;
  readonly evalSwitches?: EvalSwitches;
  readonly clock: Clock;
  readonly failureNotices: FailureNotices;
}

/** The current time as a root defines it; code below a root takes one, never the wall clock. */
export type Clock = () => Date;

/** What a root opens a store with, as plain values so they cross to a worker thread: the
 * strength model it scores by (production when absent) at HIPPO_LOSS_AVERSION_RATIO, and
 * HIPPO_FAKE_NOW as epoch milliseconds, else the wall clock. */
export interface StoreRules {
  readonly strength?: StrengthModel;
  readonly lossAversionRatio?: number;
  readonly fakeNowMs?: number | null;
}
