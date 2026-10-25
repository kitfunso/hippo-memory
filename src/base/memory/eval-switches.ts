// The EVAL-ONLY switches (HIPPO_ABLATE_*, HIPPO_EVAL_RECENCY_DAYS, HIPPO_FAKE_NOW) as plain values. ablation.ts reads
// them from the environment; ranking takes them as input, so production code paths never read an env var to rank.

/** The three switches strength scoring honours. */
export interface StrengthAblation {
  readonly decay: boolean;
  readonly recallBoost: boolean;
  readonly outcomeSlow: boolean;
}

/** Production scoring: nothing ablated. */
export const NO_STRENGTH_ABLATION: StrengthAblation = Object.freeze({
  decay: false,
  recallBoost: false,
  outcomeSlow: false,
});

/** The switches recall's rank boosts honour. */
export interface RankAblation {
  readonly recency: boolean;
  /** HIPPO_EVAL_RECENCY_DAYS when it is a positive number, else null (the 30-day scale stays). */
  readonly recencyDays: number | null;
  readonly outcomeFast: boolean;
}

/** Production ranking: every rank boost on, at the 30-day recency scale. */
export const NO_RANK_ABLATION: RankAblation = Object.freeze({ recency: false, recencyDays: null, outcomeFast: false });

/** Every switch a ranking runs under, and the clock it reads. */
export interface EvalSwitches {
  readonly strength: StrengthAblation;
  readonly rank: RankAblation;
  /** HIPPO_FAKE_NOW as epoch milliseconds, or null for the real clock. */
  readonly fakeNowMs: number | null;
}

/** The ranking's clock: an explicit `now` wins, then the fake clock, then the real one. */
export function switchedNow(now: Date | undefined, switches: EvalSwitches | undefined): Date {
  if (now !== undefined) return now;
  const fake = switches?.fakeNowMs ?? null;
  return fake === null ? new Date() : new Date(fake);
}
