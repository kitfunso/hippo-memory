/**
 * J2 availability/recency-bias detector — pure module unit tests.
 *
 * Covers:
 * - detectAvailabilityBias FIRES on a recency-dominated top-K drawn from an
 *   older pool with enough older candidates passed over
 * - the four independent gates each suppress (topK too small, pool too small,
 *   recentFraction at/below threshold, pool NOT older than topK, too few older
 *   candidates passed over)
 * - a success-criterion scenario (planted queries: fires on the biased case,
 *   stays silent on a genuine-recency control) demonstrating the >70%-precision
 *   intent
 * - malformed `created` rows are dropped (no NaN poisoning of medians)
 *
 * Pure module, no DB, no global state. Determinism via the `now` opt + fixed
 * ISO strings (no reliance on wall-clock Date.now()).
 *
 * Mirrors tests/recall-history.test.ts (the J1 pure-detector suite).
 */

import { describe, it, expect } from 'vitest';
import {
  detectAvailabilityBias,
  type AgeRef,
  DEFAULT_RECENCY_WINDOW_MS,
} from '../src/availability.js';

// Fixed reference "now" so every fixture age is deterministic.
const NOW = Date.parse('2026-05-28T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Build an AgeRef whose `created` is `ageDays` before NOW. */
function ref(id: string, ageDays: number): AgeRef {
  return { id, created: new Date(NOW - ageDays * DAY_MS).toISOString() };
}

/** Build n refs spread across [minAgeDays, maxAgeDays] with sequential ids. */
function spread(prefix: string, n: number, minAgeDays: number, maxAgeDays: number): AgeRef[] {
  const out: AgeRef[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? minAgeDays : minAgeDays + ((maxAgeDays - minAgeDays) * i) / (n - 1);
    out.push(ref(`${prefix}${i}`, t));
  }
  return out;
}

describe('detectAvailabilityBias — FIRES', () => {
  it('fires on a recent-dominated top-K drawn from an older pool', () => {
    // 4 recent returned (all < 24h) + 1 older returned -> recentFraction 0.8 > 0.7.
    const recent = [ref('r0', 0.1), ref('r1', 0.2), ref('r2', 0.3), ref('r3', 0.5)];
    const olderReturned = ref('o0', 40);
    const topK: AgeRef[] = [...recent, olderReturned];
    // Pool: the 5 returned + an old cluster of 10 (30-120d) that was passed over.
    const oldCluster = spread('p', 10, 30, 120);
    const pool: AgeRef[] = [...topK, ...oldCluster];

    const hint = detectAvailabilityBias({ topK, pool, now: NOW });
    expect(hint).not.toBeNull();
    expect(hint!.recentCount).toBe(4);
    expect(hint!.returnedCount).toBe(5);
    expect(hint!.recentFraction).toBeCloseTo(0.8, 5);
    expect(hint!.source).toBe('j2-recency');
    // pool genuinely older than the returned slice.
    expect(hint!.poolMedianAgeDays).toBeGreaterThan(hint!.topKMedianAgeDays);
    // The old cluster (10 entries, all older than the topK median) was passed over.
    expect(hint!.olderCandidatesPassedOver).toBeGreaterThanOrEqual(3);
    expect(hint!.summary).toContain('Availability bias risk');
  });

  it('fires with an all-recent top-K (recentFraction 1.0)', () => {
    const topK = spread('r', 4, 0.05, 0.6); // all < 24h
    const oldCluster = spread('p', 12, 50, 200);
    const pool: AgeRef[] = [...topK, ...oldCluster];

    const hint = detectAvailabilityBias({ topK, pool, now: NOW });
    expect(hint).not.toBeNull();
    expect(hint!.recentFraction).toBe(1);
    expect(hint!.recentCount).toBe(4);
    expect(hint!.olderCandidatesPassedOver).toBe(12);
  });
});

describe('detectAvailabilityBias — DOES NOT FIRE (each gate independently)', () => {
  // Shared older pool used to isolate one failing gate at a time.
  const oldCluster = spread('p', 12, 30, 120);

  it('returns null when topK is below minReturned (< 3)', () => {
    const topK = [ref('r0', 0.1), ref('r1', 0.2)]; // length 2
    const pool: AgeRef[] = [...topK, ...oldCluster];
    expect(detectAvailabilityBias({ topK, pool, now: NOW })).toBeNull();
  });

  it('returns null when pool is below minPool (< 10)', () => {
    const topK = spread('r', 4, 0.05, 0.6);
    const pool: AgeRef[] = [...topK, ...spread('p', 4, 30, 90)]; // total 8 < 10
    expect(detectAvailabilityBias({ topK, pool, now: NOW })).toBeNull();
  });

  it('returns null when recentFraction is at/below threshold (<= 0.7)', () => {
    // 2 recent of 4 returned -> 0.5, below the 0.7 bar.
    const topK = [ref('r0', 0.1), ref('r1', 0.3), ref('o0', 40), ref('o1', 60)];
    const pool: AgeRef[] = [...topK, ...oldCluster];
    expect(detectAvailabilityBias({ topK, pool, now: NOW })).toBeNull();
  });

  it('returns null when the pool is NOT older than the top-K (all recent)', () => {
    // Genuine recency: the pool is no older than the returned slice, so gate-3
    // (poolMedian > topKMedian, strict) fails. Pool's non-returned entries are
    // pinned at the youngest age so neither gate-3 nor gate-4 can fire.
    const topK = spread('r', 4, 0.05, 0.6);
    const poolRecent = spread('p', 12, 0.01, 0.05); // strictly younger than topK
    const pool: AgeRef[] = [...topK, ...poolRecent];
    expect(detectAvailabilityBias({ topK, pool, now: NOW })).toBeNull();
  });

  it('returns null when fewer than minOlderPassedOver (< 3) older candidates exist', () => {
    // Recent-dominated top-K (3 of 4 recent), pool older on median, but only 2
    // non-returned entries (p0, p1) are older than the topK median -> below the
    // minOlderPassedOver=3 gate. topK median = median(0.1,0.2,0.3,200) = 0.25d,
    // so the 6 padding entries (all 0.01d) sit BELOW it and are NOT counted.
    const topK = [ref('r0', 0.1), ref('r1', 0.2), ref('r2', 0.3), ref('o0', 200)];
    const pool: AgeRef[] = [
      ...topK,
      ref('p0', 150),
      ref('p1', 160),
      // pad the pool to >= 10 with entries strictly younger than the topK
      // median so the pool-size gate passes but older-passed-over stays at 2.
      ...spread('q', 6, 0.01, 0.01),
    ];
    const hint = detectAvailabilityBias({ topK, pool, now: NOW });
    expect(hint).toBeNull();
  });
});

describe('detectAvailabilityBias — success criterion (planted queries)', () => {
  // Demonstrates the >70%-precision intent: the correct (oldest-relevant) answer
  // predates the returned median on the biased query, and the detector fires;
  // a control where recency is genuine produces no false positive.
  it('fires on the biased query whose best answer is older than the returned slice', () => {
    // The authoritative answer is `gold` (90d old) but the returned slice is
    // dominated by fresh near-duplicates that buried it.
    const fresh = spread('fresh', 4, 0.1, 0.7); // 4 recent returned
    const topK: AgeRef[] = [...fresh]; // gold NOT returned
    const gold = ref('gold', 90);
    const olderRelevant = spread('rel', 6, 40, 150); // older matched cluster
    const pool: AgeRef[] = [...fresh, gold, ...olderRelevant];

    const hint = detectAvailabilityBias({ topK, pool, now: NOW });
    expect(hint).not.toBeNull();
    expect(hint!.recentFraction).toBeGreaterThan(0.7);
    // `gold` and the older cluster were all passed over.
    expect(hint!.olderCandidatesPassedOver).toBeGreaterThanOrEqual(3);
  });

  it('stays silent on a control where recency is genuine (no older pool)', () => {
    // The corpus is genuinely young: the returned recent slice IS the relevant
    // set, and there is no older pool being passed over. The non-returned pool
    // entries are pinned strictly younger than every returned entry, so neither
    // gate-3 (poolMedian > topKMedian) nor gate-4 (older-passed-over) fires.
    // No false positive -> demonstrates the precision side of the >70% intent.
    const fresh = spread('fresh', 4, 0.1, 0.7);
    const poolYoung = spread('pool', 10, 0.01, 0.05); // strictly younger, none old
    const pool: AgeRef[] = [...fresh, ...poolYoung];
    expect(detectAvailabilityBias({ topK: fresh, pool, now: NOW })).toBeNull();
  });
});

describe('detectAvailabilityBias — edge cases', () => {
  it('drops entries with malformed `created` (no NaN poisoning)', () => {
    // Two malformed rows in BOTH topK and pool. They must be filtered before
    // the medians are computed; the surviving rows still trip the detector.
    const recent = [ref('r0', 0.1), ref('r1', 0.2), ref('r2', 0.3)];
    const badTop: AgeRef = { id: 'bad_top', created: 'not-a-date' };
    const topK: AgeRef[] = [...recent, badTop];
    const oldCluster = spread('p', 10, 40, 120);
    const badPool: AgeRef = { id: 'bad_pool', created: '' };
    const pool: AgeRef[] = [...recent, badPool, ...oldCluster];

    const hint = detectAvailabilityBias({ topK, pool, now: NOW });
    expect(hint).not.toBeNull();
    // bad_top dropped -> only 3 valid returned, all recent.
    expect(hint!.returnedCount).toBe(3);
    expect(hint!.recentCount).toBe(3);
    expect(Number.isFinite(hint!.topKMedianAgeDays)).toBe(true);
    expect(Number.isFinite(hint!.poolMedianAgeDays)).toBe(true);
    // bad_pool must not count as an older-passed-over candidate.
    expect(hint!.olderCandidatesPassedOver).toBe(10);
  });

  it('respects a custom recencyWindowMs via opts', () => {
    // Widen the window to 7d: entries up to 7d old now count as recent.
    const topK = [ref('r0', 1), ref('r1', 2), ref('r2', 3), ref('r3', 6)];
    const oldCluster = spread('p', 10, 30, 120);
    const pool: AgeRef[] = [...topK, ...oldCluster];

    // With the default 24h window, none of the 1-6d entries are "recent".
    expect(detectAvailabilityBias({ topK, pool, now: NOW })).toBeNull();
    // With a 7d window they all are.
    const hint = detectAvailabilityBias({
      topK,
      pool,
      now: NOW,
      recencyWindowMs: 7 * DAY_MS,
    });
    expect(hint).not.toBeNull();
    expect(hint!.recentCount).toBe(4);
    // Sanity: the default constant is 24h.
    expect(DEFAULT_RECENCY_WINDOW_MS).toBe(DAY_MS);
  });
});

describe('detectAvailabilityBias — exact boundaries', () => {
  it('does NOT fire at exactly recentFraction 0.7 (strict > threshold)', () => {
    // 7 recent of 10 returned = exactly 0.7 -> the `<= 0.7` gate returns null.
    // Pool is older with plenty passed over, so ONLY the threshold gate suppresses.
    const recent = spread('r', 7, 0.05, 0.6);
    const older = [ref('o0', 40), ref('o1', 50), ref('o2', 60)];
    const topK: AgeRef[] = [...recent, ...older]; // 10 returned, 7 recent
    const pool: AgeRef[] = [...topK, ...spread('p', 8, 30, 120)];
    expect(detectAvailabilityBias({ topK, pool, now: NOW })).toBeNull();
  });

  it('fires just above the threshold at recentFraction 0.8', () => {
    const recent = spread('r', 8, 0.05, 0.6);
    const older = [ref('o0', 40), ref('o1', 50)];
    const topK: AgeRef[] = [...recent, ...older]; // 10 returned, 8 recent = 0.8
    const pool: AgeRef[] = [...topK, ...spread('p', 8, 30, 120)];
    const hint = detectAvailabilityBias({ topK, pool, now: NOW });
    expect(hint).not.toBeNull();
    expect(hint!.recentFraction).toBeCloseTo(0.8, 5);
  });

  it('fires at exactly olderCandidatesPassedOver === 3 (min boundary)', () => {
    // minPool overridden to 6 so a 7-entry pool with EXACTLY 3 older-than-median
    // non-returned entries isolates the olderCandidatesPassedOver >= 3 boundary.
    const topK = [ref('r0', 0.1), ref('r1', 0.2), ref('r2', 0.3), ref('r3', 0.4)];
    const pool: AgeRef[] = [...topK, ref('o0', 40), ref('o1', 50), ref('o2', 60)];
    const hint = detectAvailabilityBias({ topK, pool, now: NOW, minPool: 6 });
    expect(hint).not.toBeNull();
    expect(hint!.olderCandidatesPassedOver).toBe(3);
  });

  it('computes an even-length pool median as the mean of the two middle ages', () => {
    // pool of 8: four recent (age 0) + four old (age 40) -> median = (0 + 40)/2 = 20.
    const topK = spread('r', 4, 0, 0);
    const pool: AgeRef[] = [...topK, ref('o0', 40), ref('o1', 40), ref('o2', 40), ref('o3', 40)];
    const hint = detectAvailabilityBias({ topK, pool, now: NOW, minPool: 6 });
    expect(hint).not.toBeNull();
    expect(hint!.poolMedianAgeDays).toBeCloseTo(20, 5);
    expect(hint!.topKMedianAgeDays).toBeCloseTo(0, 5);
  });

  it('computes an odd-length pool median as the single middle age', () => {
    // pool of 9: four recent (age 0) + five old (age 40) -> median = 40 (the 5th of 9).
    const topK = spread('r', 4, 0, 0);
    const pool: AgeRef[] = [...topK, ...spread('o', 5, 40, 40)];
    const hint = detectAvailabilityBias({ topK, pool, now: NOW, minPool: 6 });
    expect(hint).not.toBeNull();
    expect(hint!.poolMedianAgeDays).toBeCloseTo(40, 5);
  });
});
