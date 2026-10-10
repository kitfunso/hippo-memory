/** Replay: during `hippo sleep`, sample N survivors weighted by reward, valence, under-rehearsal and age, then apply the `markRetrieved` strengthening.
 * A lightweight deterministic analog of hippocampal replay, so important memories stay strong without being queried; distinct from decay, physics and merge. */

import { isOutcomeSlowAblated } from '../core/ablation.js';
import { resolveConfidence, type MemoryEntry, type EmotionalValence } from '../core/memory.js';

const VALENCE_WEIGHT = {
  neutral: 1.0,
  positive: 1.3,
  negative: 1.5,
  critical: 2.0,
} satisfies Record<EmotionalValence, number>;

/** Priority score for ranking survivors for replay (higher = more likely sampled); pure in the entry and current time. */
export function replayPriority(entry: MemoryEntry, now: Date, outcomeAblated: boolean): number {
  const pos = entry.outcome_positive ?? 0;
  const neg = entry.outcome_negative ?? 0;
  // Reward signal: neutral = 1, strongly rewarded > 1, negative-dominated floors at 0.1 (still eligible, just unlikely).
  // The clamp is required because sampleForReplay needs all weights positive.
  const rewardSignal = outcomeAblated
    ? 1.0 // EVAL-ONLY ablation (see ablation.ts): outcome-off also silences replay's reward bias
    : Math.max(0.1, 1 + pos * 0.5 + (pos - neg) * 0.25);

  const valence = VALENCE_WEIGHT[entry.emotional_valence] ?? 1.0;

  // Under-rehearsed memories benefit most from replay.
  const underRehearsed = 1 / (1 + (entry.retrieval_count ?? 0));

  // Idle-time boost: memories that haven't been touched recently need rehearsal more.
  const lastRetrieved = new Date(entry.last_retrieved);
  const deltaMs = now.getTime() - lastRetrieved.getTime();
  const ageHours = Number.isFinite(deltaMs) ? Math.max(0, deltaMs / 3_600_000) : 0;
  const idleBoost = 1 + Math.log1p(ageHours) * 0.1;

  // Weight by current strength so dead-and-decaying memories don't waste replay slots.
  const rawStrength = Number.isFinite(entry.strength) ? entry.strength : 0;
  const strengthFloor = Math.max(0.1, rawStrength);

  return rewardSignal * valence * underRehearsed * idleBoost * strengthFloor;
}

/** Deterministic 32-bit RNG (Mulberry32): same seed, same sequence, so replay is reproducible without a random-number dependency. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    let t = (s += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick `count` memories for replay, weighted by `replayPriority`, without replacement; deterministic for a seed.
 * Weighted but not greedy: always taking the top-N overfits, so a stochastic element keeps adjacent survivors in play. */
export function sampleForReplay(
  survivors: MemoryEntry[],
  count: number,
  now: Date,
  seed: number = Date.now() >>> 0
): MemoryEntry[] {
  if (count <= 0 || survivors.length === 0) return [];
  const rng = mulberry32(seed);

  // Deliberately-marked and aged-out memories are both untrusted and rehearsing them defeats staleness, so derive rather than trust
  // the stored value (it no longer carries the age-out case).
  const eligible = survivors.filter((e) => resolveConfidence(e, now) !== 'stale');
  if (eligible.length === 0) return [];

  const outcomeAblated = isOutcomeSlowAblated();
  const pool = eligible.map((entry, idx) => ({
    entry,
    idx,
    weight: replayPriority(entry, now, outcomeAblated),
  }));

  const want = Math.min(count, pool.length);
  const chosen: MemoryEntry[] = [];
  const taken = new Set<number>();

  for (let k = 0; k < want; k++) {
    let totalW = 0;
    for (const p of pool) if (!taken.has(p.idx)) totalW += p.weight;
    if (totalW <= 0) break;
    let r = rng() * totalW;
    for (const p of pool) {
      if (taken.has(p.idx)) continue;
      r -= p.weight;
      if (r <= 0) {
        chosen.push(p.entry);
        taken.add(p.idx);
        break;
      }
    }
  }

  return chosen;
}
