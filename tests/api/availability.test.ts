import { describe, it, expect } from 'vitest';
import { detectAvailabilityBias, type AgeRef } from '../../src/api/availability.js';
import { DAY_MS } from '../../src/base/util/time.js';

const NOW = Date.parse('2026-05-28T00:00:00.000Z');

function ref(id: string, ageDays: number): AgeRef {
  return { id, created: new Date(NOW - ageDays * DAY_MS).toISOString() };
}

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
    const recent = [ref('r0', 0.1), ref('r1', 0.2), ref('r2', 0.3), ref('r3', 0.5)];
    const olderReturned = ref('o0', 40);
    const topK: AgeRef[] = [...recent, olderReturned];
    const oldCluster = spread('p', 10, 30, 120);
    const pool: AgeRef[] = [...topK, ...oldCluster];

    const hint = detectAvailabilityBias({ topK, pool, now: NOW });
    expect(hint).not.toBeNull();
    expect(hint!.recentCount).toBe(4);
    expect(hint!.returnedCount).toBe(5);
    expect(hint!.recentFraction).toBeCloseTo(0.8, 5);
    expect(hint!.source).toBe('j2-recency');
    expect(hint!.poolMedianAgeDays).toBeGreaterThan(hint!.topKMedianAgeDays);
    expect(hint!.olderCandidatesPassedOver).toBeGreaterThanOrEqual(3);
    expect(hint!.summary).toContain('Availability bias risk');
  });

  it('fires with an all-recent top-K (recentFraction 1.0)', () => {
    const topK = spread('r', 4, 0.05, 0.6);
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
  const oldCluster = spread('p', 12, 30, 120);

  it('returns null when topK is below minReturned (< 3)', () => {
    const topK = [ref('r0', 0.1), ref('r1', 0.2)];
    const pool: AgeRef[] = [...topK, ...oldCluster];
    expect(detectAvailabilityBias({ topK, pool, now: NOW })).toBeNull();
  });

  it('returns null when pool is below minPool (< 10)', () => {
    const topK = spread('r', 4, 0.05, 0.6);
    const pool: AgeRef[] = [...topK, ...spread('p', 4, 30, 90)];
    expect(detectAvailabilityBias({ topK, pool, now: NOW })).toBeNull();
  });

  it('returns null when recentFraction is at/below threshold (<= 0.7)', () => {
    const topK = [ref('r0', 0.1), ref('r1', 0.3), ref('o0', 40), ref('o1', 60)];
    const pool: AgeRef[] = [...topK, ...oldCluster];
    expect(detectAvailabilityBias({ topK, pool, now: NOW })).toBeNull();
  });

  it('returns null when the pool is NOT older than the top-K (all recent)', () => {
    const topK = spread('r', 4, 0.05, 0.6);
    const poolRecent = spread('p', 12, 0.01, 0.05);
    const pool: AgeRef[] = [...topK, ...poolRecent];
    expect(detectAvailabilityBias({ topK, pool, now: NOW })).toBeNull();
  });

  it('returns null when fewer than minOlderPassedOver (< 3) older candidates exist', () => {
    const topK = [ref('r0', 0.1), ref('r1', 0.2), ref('r2', 0.3), ref('o0', 200)];
    const pool: AgeRef[] = [
      ...topK,
      ref('p0', 150),
      ref('p1', 160),
      ...spread('q', 6, 0.01, 0.01),
    ];
    const hint = detectAvailabilityBias({ topK, pool, now: NOW });
    expect(hint).toBeNull();
  });
});

describe('detectAvailabilityBias — success criterion (planted queries)', () => {
  it('fires on the biased query whose best answer is older than the returned slice', () => {
    const fresh = spread('fresh', 4, 0.1, 0.7);
    const topK: AgeRef[] = [...fresh];
    const gold = ref('gold', 90);
    const olderRelevant = spread('rel', 6, 40, 150);
    const pool: AgeRef[] = [...fresh, gold, ...olderRelevant];

    const hint = detectAvailabilityBias({ topK, pool, now: NOW });
    expect(hint).not.toBeNull();
    expect(hint!.recentFraction).toBeGreaterThan(0.7);
    expect(hint!.olderCandidatesPassedOver).toBeGreaterThanOrEqual(3);
  });

  it('stays silent on a control where recency is genuine (no older pool)', () => {
    const fresh = spread('fresh', 4, 0.1, 0.7);
    const poolYoung = spread('pool', 10, 0.01, 0.05);
    const pool: AgeRef[] = [...fresh, ...poolYoung];
    expect(detectAvailabilityBias({ topK: fresh, pool, now: NOW })).toBeNull();
  });
});

describe('detectAvailabilityBias — edge cases', () => {
  it('drops entries with malformed `created` (no NaN poisoning)', () => {
    const recent = [ref('r0', 0.1), ref('r1', 0.2), ref('r2', 0.3)];
    const badTop: AgeRef = { id: 'bad_top', created: 'not-a-date' };
    const topK: AgeRef[] = [...recent, badTop];
    const oldCluster = spread('p', 10, 40, 120);
    const badPool: AgeRef = { id: 'bad_pool', created: '' };
    const pool: AgeRef[] = [...recent, badPool, ...oldCluster];

    const hint = detectAvailabilityBias({ topK, pool, now: NOW });
    expect(hint).not.toBeNull();
    expect(hint!.returnedCount).toBe(3);
    expect(hint!.recentCount).toBe(3);
    expect(Number.isFinite(hint!.topKMedianAgeDays)).toBe(true);
    expect(Number.isFinite(hint!.poolMedianAgeDays)).toBe(true);
    expect(hint!.olderCandidatesPassedOver).toBe(10);
  });

  it('respects a custom recencyWindowMs via opts', () => {
    const topK = [ref('r0', 1), ref('r1', 2), ref('r2', 3), ref('r3', 6)];
    const oldCluster = spread('p', 10, 30, 120);
    const pool: AgeRef[] = [...topK, ...oldCluster];

    expect(detectAvailabilityBias({ topK, pool, now: NOW })).toBeNull();
    const hint = detectAvailabilityBias({
      topK,
      pool,
      now: NOW,
      recencyWindowMs: 7 * DAY_MS,
    });
    expect(hint).not.toBeNull();
    expect(hint!.recentCount).toBe(4);
    const agedBy = (ms: number) =>
      [0, 1, 2, 3].map((i) => ({ id: `e${i}`, created: new Date(NOW - ms).toISOString() }));
    const atAge = (ms: number) =>
      detectAvailabilityBias({ topK: agedBy(ms), pool: [...agedBy(ms), ...oldCluster], now: NOW });
    expect(atAge(DAY_MS)?.recentCount).toBe(4);
    expect(atAge(DAY_MS + 1)).toBeNull();
  });
});

describe('detectAvailabilityBias — exact boundaries', () => {
  it('does NOT fire at exactly recentFraction 0.7 (strict > threshold)', () => {
    const recent = spread('r', 7, 0.05, 0.6);
    const older = [ref('o0', 40), ref('o1', 50), ref('o2', 60)];
    const topK: AgeRef[] = [...recent, ...older];
    const pool: AgeRef[] = [...topK, ...spread('p', 8, 30, 120)];
    expect(detectAvailabilityBias({ topK, pool, now: NOW })).toBeNull();
  });

  it('fires just above the threshold at recentFraction 0.8', () => {
    const recent = spread('r', 8, 0.05, 0.6);
    const older = [ref('o0', 40), ref('o1', 50)];
    const topK: AgeRef[] = [...recent, ...older];
    const pool: AgeRef[] = [...topK, ...spread('p', 8, 30, 120)];
    const hint = detectAvailabilityBias({ topK, pool, now: NOW });
    expect(hint).not.toBeNull();
    expect(hint!.recentFraction).toBeCloseTo(0.8, 5);
  });

  it('fires at exactly olderCandidatesPassedOver === 3 (min boundary)', () => {
    const topK = [ref('r0', 0.1), ref('r1', 0.2), ref('r2', 0.3), ref('r3', 0.4)];
    const pool: AgeRef[] = [...topK, ref('o0', 40), ref('o1', 50), ref('o2', 60)];
    const hint = detectAvailabilityBias({ topK, pool, now: NOW, minPool: 6 });
    expect(hint).not.toBeNull();
    expect(hint!.olderCandidatesPassedOver).toBe(3);
  });

  it('computes an even-length pool median as the mean of the two middle ages', () => {
    const topK = spread('r', 4, 0, 0);
    const pool: AgeRef[] = [...topK, ref('o0', 40), ref('o1', 40), ref('o2', 40), ref('o3', 40)];
    const hint = detectAvailabilityBias({ topK, pool, now: NOW, minPool: 6 });
    expect(hint).not.toBeNull();
    expect(hint!.poolMedianAgeDays).toBeCloseTo(20, 5);
    expect(hint!.topKMedianAgeDays).toBeCloseTo(0, 5);
  });

  it('computes an odd-length pool median as the single middle age', () => {
    const topK = spread('r', 4, 0, 0);
    const pool: AgeRef[] = [...topK, ...spread('o', 5, 40, 40)];
    const hint = detectAvailabilityBias({ topK, pool, now: NOW, minPool: 6 });
    expect(hint).not.toBeNull();
    expect(hint!.poolMedianAgeDays).toBeCloseTo(40, 5);
  });
});
