/**
 * Replay — biologically-inspired rehearsal during consolidation.
 *
 * Hippocampal replay is internally-driven reactivation of memories during
 * slow-wave sleep: the brain picks important recent experiences and "plays
 * them back" without external input, strengthening them before they decay.
 * In McClelland's complementary-learning-systems framing, replay is also
 * how episodic memories train the neocortex (interleaved rehearsal); in
 * reward-modulated STDP, replay is gated by dopamine so rewarded
 * experiences get preferentially consolidated.
 *
 * This module implements a lightweight, deterministic analog. During each
 * `hippo sleep`, we sample N surviving memories by a priority score that
 * weighs reward feedback, emotional valence, under-rehearsal, and age —
 * then apply the same retrieval-strengthening dynamics `markRetrieved`
 * applies to real queries. The effect is that important memories stay
 * strong even when the user hasn't explicitly queried them recently.
 *
 * Distinct from the other consolidation passes:
 *   - decay: removes what's too weak
 *   - physics: moves particles in embedding space
 *   - merge: collapses near-duplicate episodics into semantics
 *   - REPLAY: picks winners and rehearses them (this file)
 */

import type { MemoryEntry, EmotionalValence } from './memory.js';

const VALENCE_WEIGHT: Record<EmotionalValence, number> = {
  neutral: 1.0,
  positive: 1.3,
  negative: 1.5,
  critical: 2.0,
};

/**
 * Priority score used to rank survivors for replay. Higher = more likely
 * to be sampled. Pure function of the entry and current time.
 */
export function replayPriority(entry: MemoryEntry, now: Date): number {
  const pos = entry.outcome_positive ?? 0;
  const neg = entry.outcome_negative ?? 0;
  // Reward signal in [0, ∞); neutral memories get 1, strongly-rewarded memories higher.
  const rewardSignal = 1 + pos * 0.5 + (pos - neg) * 0.25;

  const valence = VALENCE_WEIGHT[entry.emotional_valence] ?? 1.0;

  // Under-rehearsed memories benefit most from replay.
  const underRehearsed = 1 / (1 + (entry.retrieval_count ?? 0));

  // Idle-time boost: memories that haven't been touched recently need rehearsal more.
  const lastRetrieved = new Date(entry.last_retrieved);
  const ageHours = Math.max(0, (now.getTime() - lastRetrieved.getTime()) / 3_600_000);
  const idleBoost = 1 + Math.log1p(ageHours) * 0.1;

  // Weight by current strength so dead-and-decaying memories don't waste replay slots.
  const strengthFloor = Math.max(0.1, entry.strength);

  return rewardSignal * valence * underRehearsed * idleBoost * strengthFloor;
}

/**
 * Deterministic 32-bit RNG (Mulberry32). Same seed → same sequence.
 * Keeps replay reproducible for tests and audit runs without bringing
 * in a random-number dependency.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    let t = (s += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick `count` memories for replay, weighted by `replayPriority`, without
 * replacement. Deterministic given the same seed.
 *
 * The sampler is weighted but not greedy — picking by priority alone would
 * always pick the top-N, which overfits. Biological replay shows both
 * preferential-for-reward AND stochastic-exploration characteristics; we
 * keep the stochastic element so adjacent survivors aren't always ignored.
 */
export function sampleForReplay(
  survivors: MemoryEntry[],
  count: number,
  now: Date,
  seed: number = Date.now() >>> 0
): MemoryEntry[] {
  if (count <= 0 || survivors.length === 0) return [];
  const rng = mulberry32(seed);

  // Stale memories have been deliberately marked as untrusted; rehearsing
  // them would defeat the purpose of staleness. Skip them entirely.
  const eligible = survivors.filter((e) => e.confidence !== 'stale');
  if (eligible.length === 0) return [];

  const pool = eligible.map((entry, idx) => ({
    entry,
    idx,
    weight: replayPriority(entry, now),
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
