// What a ranking runs under as plain values: the strength model and the rank switches. An eval root
// reads them (src/infra/eval-switches.ts) and hands them down, so no code path reads an env var to
// rank.
import type { RuntimeSettings } from '../config/config.js';
import { PRODUCTION_STRENGTH, withLossAversion, type StrengthModel } from './strength.js';

/** The switches recall's rank boosts honour. */
export interface RankAblation {
  readonly recency: boolean;
  /** HIPPO_EVAL_RECENCY_DAYS when it is a positive number, else null (RECENCY_SCALE_DAYS stays). */
  readonly recencyDays: number | null;
  readonly outcomeFast: boolean;
}

/** Production ranking: every rank boost on, at the RECENCY_SCALE_DAYS recency scale. */
export const NO_RANK_ABLATION: RankAblation = Object.freeze({
  recency: false,
  recencyDays: null,
  outcomeFast: false,
});

/** The strength model and rank switches a ranking runs under. */
export interface EvalSwitches {
  readonly strength: StrengthModel;
  readonly rank: RankAblation;
}

/** The model a ranking scores strength by: the switches' model with the root's
 * HIPPO_LOSS_AVERSION_RATIO. */
export function strengthModelFor(
  switches: EvalSwitches | undefined,
  runtime: Pick<RuntimeSettings, 'lossAversionRatio'> | undefined,
): StrengthModel {
  return withLossAversion(switches?.strength ?? PRODUCTION_STRENGTH, runtime?.lossAversionRatio);
}
