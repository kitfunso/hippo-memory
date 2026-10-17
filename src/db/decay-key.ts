import { REWARD_SLOPE } from '../core/memory.js';

export const DECAY_KEY_INDEX = 'idx_memories_decay_key';

const POS = 'COALESCE(outcome_positive, 0)';
const NEG = 'COALESCE(outcome_negative, 0)';

/** Unablated, in the db layer so the index and rule-sql's rewardFactorSql share one slope. */
export const REWARD_FACTOR_SQL =
  `(CASE WHEN ${POS} = 0 AND ${NEG} = 0 THEN 1.0 ELSE 1.0 + ${REWARD_SLOPE} * (${POS} - ${NEG}) / (${POS} + ` +
  `${NEG} + 1.0) END)`;

/** Half-lives of decay the index key measures to: a narrower window reads fewer rows of a large tenant, and a tenant
 * with fewer rows inside it than the cap is small enough to scan. */
export const DECAY_KEY_HALF_LIVES = 2;

/** Far above julianday's rounding (5e-10 day), so a row the key leaves out has decayed past DECAY_KEY_HALF_LIVES. */
export const DECAY_KEY_SLACK_DAYS = 1e-3;

/** True of every row (pinned is 0 or 1); only a query that repeats it can pick the index, so no other read, such as the
 * ambient drift probe, changes plan. */
export const DECAY_KEY_WHERE = 'pinned >= 0';

/** The day a row reaches DECAY_KEY_HALF_LIVES of decay, reward factor included, so `key >= julianday(now)` is exactly
 * `decay exponent <= DECAY_KEY_HALF_LIVES`; migration v60 and the context read must share this one text. */
export const DECAY_KEY_SQL =
  `julianday(last_retrieved) + ${DECAY_KEY_HALF_LIVES.toFixed(1)} * half_life_days * ${REWARD_FACTOR_SQL}`;
