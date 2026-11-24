import { HOUR_MS } from '../../base/util/time.js';
import { mulberry32 } from '../../base/util/prng.js';
import {
  PRODUCTION_STRENGTH,
  resolveConfidence,
  type StrengthModel,
} from '../../base/memory/strength.js';
import type { MemoryEntry, EmotionalValence } from '../../base/memory/entry.js';

const VALENCE_WEIGHT = {
  neutral: 1.0,
  positive: 1.3,
  negative: 1.5,
  critical: 2.0,
} satisfies Record<EmotionalValence, number>;

const REWARD_FLOOR = 0.1;
const REWARD_POSITIVE_GAIN = 0.5;
const REWARD_NET_GAIN = 0.25;
const IDLE_BOOST_GAIN = 0.1;
const STRENGTH_FLOOR = 0.1;

/**
 * Priority score for ranking survivors for replay (higher = more likely sampled); pure in the entry
 * and current time.
 */
export function replayPriority(entry: MemoryEntry, now: Date, outcomeAblated: boolean): number {
  const pos = entry.outcomePositive ?? 0;
  const neg = entry.outcomeNegative ?? 0;
  const rewardSignal = outcomeAblated
    ? 1.0
    : Math.max(REWARD_FLOOR, 1 + pos * REWARD_POSITIVE_GAIN + (pos - neg) * REWARD_NET_GAIN);

  const valence = VALENCE_WEIGHT[entry.emotionalValence] ?? 1.0;

  const underRehearsed = 1 / (1 + (entry.retrievalCount ?? 0));

  const lastRetrieved = new Date(entry.lastRetrieved);
  const deltaMs = now.getTime() - lastRetrieved.getTime();
  const ageHours = Number.isFinite(deltaMs) ? Math.max(0, deltaMs / HOUR_MS) : 0;
  const idleBoost = 1 + Math.log1p(ageHours) * IDLE_BOOST_GAIN;

  const rawStrength = Number.isFinite(entry.strength) ? entry.strength : 0;
  const strengthFloor = Math.max(STRENGTH_FLOOR, rawStrength);

  return rewardSignal * valence * underRehearsed * idleBoost * strengthFloor;
}

export interface SampleForReplayOptions {
  readonly survivors: Iterable<MemoryEntry> | AsyncIterable<MemoryEntry>;
  readonly count: number;
  readonly now: Date;
  readonly seed?: number;
  readonly model?: StrengthModel;
}

/** The ids of `count` memories picked for replay in pick order, weighted by `replayPriority`,
 * without replacement; deterministic for a seed. Weighted, not greedy: always taking the top-N
 * overfits. Holds ids, not rows. */
export async function sampleForReplay({
  survivors,
  count,
  now,
  seed = Date.now() >>> 0,
  model = PRODUCTION_STRENGTH,
}: SampleForReplayOptions): Promise<string[]> {
  if (count <= 0) return [];
  const outcomeAblated = model.rewardSlope === 0;
  const ids: string[] = [];
  const weights: number[] = [];
  for await (const entry of survivors) {
    if (resolveConfidence(entry, now) === 'stale') continue;
    ids.push(entry.id);
    weights.push(replayPriority(entry, now, outcomeAblated));
  }
  return drawWeighted(weights, count, seed).map((i) => ids[i]);
}

function drawWeighted(weights: readonly number[], count: number, seed: number): number[] {
  if (weights.length === 0) return [];
  if (count <= 0 || weights.length === 0) return [];
  const rng = mulberry32(seed);
  const want = Math.min(count, weights.length);
  const chosen: number[] = [];
  const taken = new Set<number>();

  for (let k = 0; k < want; k++) {
    let totalW = 0;
    for (const [idx, weight] of weights.entries()) if (!taken.has(idx)) totalW += weight;
    if (totalW <= 0) break;
    let r = rng() * totalW;
    for (const [idx, weight] of weights.entries()) {
      if (taken.has(idx)) continue;
      r -= weight;
      if (r <= 0) {
        chosen.push(idx);
        taken.add(idx);
        break;
      }
    }
  }
  return chosen;
}
