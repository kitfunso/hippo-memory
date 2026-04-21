import { describe, it, expect } from 'vitest';
import { calculateStrength, calculateRewardFactor, createMemory, applyOutcome, Layer } from '../src/memory.js';

describe('Strength formula', () => {
  it('returns 1.0 for a pinned memory regardless of age', () => {
    const entry = createMemory('pinned fact', { pinned: true });
    const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // 1 year ago
    // Manually age it
    const aged = { ...entry, last_retrieved: oldDate.toISOString() };
    expect(calculateStrength(aged)).toBe(1.0);
  });

  it('decays over time (no retrieval)', () => {
    const entry = createMemory('ephemeral note');
    const now = new Date();

    // Simulate 7 days passing (one full half-life for default)
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const aged = { ...entry, last_retrieved: sevenDaysAgo.toISOString() };

    const s = calculateStrength(aged, now);
    // At half-life, base decay = 0.5; with retrieval_count=0 and neutral valence:
    // retrieval_boost = 1 + 0.1*log2(1) = 1
    // emotional_mult = 1.0
    // so s ≈ 0.5
    expect(s).toBeCloseTo(0.5, 1);
  });

  it('has higher strength when recently retrieved', () => {
    const now = new Date();
    const oldDate = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000); // 2 weeks ago

    const entry1 = createMemory('memory A', { layer: Layer.Episodic });
    const e1 = { ...entry1, last_retrieved: now.toISOString(), retrieval_count: 5 };
    const e2 = { ...entry1, last_retrieved: oldDate.toISOString(), retrieval_count: 0 };

    expect(calculateStrength(e1, now)).toBeGreaterThan(calculateStrength(e2, now));
  });

  it('error-tagged memory has longer half-life', () => {
    const errorMem = createMemory('cache failure', { tags: ['error'] });
    const neutralMem = createMemory('some info');

    expect(errorMem.half_life_days).toBeGreaterThan(neutralMem.half_life_days);
  });

  it('emotional multiplier boosts strength for critical memories', () => {
    const now = new Date();
    // Age the memories by 10 days so decay < 1, giving emotional multiplier room to show
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();

    const critical = createMemory('critical failure', { emotional_valence: 'critical' });
    const neutral = createMemory('neutral note', { emotional_valence: 'neutral' });

    const crit = { ...critical, last_retrieved: tenDaysAgo };
    const neut = { ...neutral, last_retrieved: tenDaysAgo };

    // Both have same decay, but critical has 2x emotional multiplier
    expect(calculateStrength(crit, now)).toBeGreaterThan(calculateStrength(neut, now));
  });

  it('strength is clamped to [0, 1]', () => {
    const entry = createMemory('test', { emotional_valence: 'critical', pinned: false });
    const s = calculateStrength(entry);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe('applyOutcome', () => {
  it('positive outcome increments outcome_positive counter', () => {
    const entry = createMemory('some memory');
    const updated = applyOutcome(entry, true);
    expect(updated.outcome_positive).toBe(1);
    expect(updated.outcome_negative).toBe(0);
    expect(updated.outcome_score).toBe(1);
  });

  it('negative outcome increments outcome_negative counter', () => {
    const entry = createMemory('some memory');
    const updated = applyOutcome(entry, false);
    expect(updated.outcome_positive).toBe(0);
    expect(updated.outcome_negative).toBe(1);
    expect(updated.outcome_score).toBe(-1);
  });

  it('does not mutate half_life_days (reward factor is dynamic)', () => {
    const entry = createMemory('some memory');
    const before = entry.half_life_days;
    const afterGood = applyOutcome(entry, true);
    expect(afterGood.half_life_days).toBe(before);
    const afterBad = applyOutcome(entry, false);
    expect(afterBad.half_life_days).toBe(before);
  });

  it('cumulative positive outcomes increase strength via reward factor', () => {
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const entry = createMemory('useful memory');
    const aged = { ...entry, last_retrieved: tenDaysAgo };

    // Apply 5 positive outcomes
    let current = aged;
    for (let i = 0; i < 5; i++) {
      current = applyOutcome(current, true);
    }

    // Strength should be higher than without outcomes
    expect(calculateStrength(current, now)).toBeGreaterThan(calculateStrength(aged, now));
  });

  it('cumulative negative outcomes decrease strength via reward factor', () => {
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const entry = createMemory('bad memory');
    const aged = { ...entry, last_retrieved: tenDaysAgo };

    // Apply 3 negative outcomes
    let current = aged;
    for (let i = 0; i < 3; i++) {
      current = applyOutcome(current, false);
    }

    expect(calculateStrength(current, now)).toBeLessThan(calculateStrength(aged, now));
  });
});

describe('calculateRewardFactor', () => {
  it('returns 1.0 with no outcomes', () => {
    const entry = createMemory('neutral');
    expect(calculateRewardFactor(entry)).toBe(1.0);
  });

  it('returns > 1.0 with net positive outcomes', () => {
    const entry = createMemory('good');
    const updated = { ...entry, outcome_positive: 5, outcome_negative: 0 };
    const rf = calculateRewardFactor(updated);
    expect(rf).toBeGreaterThan(1.0);
    // 1 + 0.5 * (5 / 6) ≈ 1.417
    expect(rf).toBeCloseTo(1.417, 2);
  });

  it('returns < 1.0 with net negative outcomes', () => {
    const entry = createMemory('bad');
    const updated = { ...entry, outcome_positive: 0, outcome_negative: 3 };
    const rf = calculateRewardFactor(updated);
    expect(rf).toBeLessThan(1.0);
    // 1 + 0.5 * (-3 / 4) = 0.625
    expect(rf).toBeCloseTo(0.625, 2);
  });

  it('converges toward 1.0 with mixed outcomes', () => {
    const entry = createMemory('mixed');
    const updated = { ...entry, outcome_positive: 3, outcome_negative: 3 };
    const rf = calculateRewardFactor(updated);
    // 1 + 0.5 * (0 / 7) = 1.0
    expect(rf).toBe(1.0);
  });

  it('is bounded between 0.5 and 1.5', () => {
    const entry = createMemory('extreme');
    const allGood = { ...entry, outcome_positive: 1000, outcome_negative: 0 };
    const allBad = { ...entry, outcome_positive: 0, outcome_negative: 1000 };
    expect(calculateRewardFactor(allGood)).toBeLessThanOrEqual(1.5);
    expect(calculateRewardFactor(allBad)).toBeGreaterThanOrEqual(0.5);
  });
});

describe('Decay basis modes', () => {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  function makeAged() {
    const entry = createMemory('test memory');
    return { ...entry, last_retrieved: sevenDaysAgo.toISOString() };
  }

  it('clock mode: decays by wall-clock time (default)', () => {
    const entry = makeAged();
    const s = calculateStrength(entry, now, { decayBasis: 'clock' });
    // 7 days / 7 day half-life = 50% decay
    expect(s).toBeCloseTo(0.5, 1);
  });

  it('session mode: decays by estimated session count', () => {
    const entry = makeAged();
    // Agent runs every 3.5 days on average. 7 days / 3.5 = 2 sessions elapsed.
    const s = calculateStrength(entry, now, {
      decayBasis: 'session',
      avgSessionIntervalDays: 3.5,
    });
    // 2 sessions / 7 half-life = 0.5^(2/7) ≈ 0.820
    expect(s).toBeCloseTo(0.820, 2);
  });

  it('session mode: weekly agent decays slower than daily agent', () => {
    const entry = makeAged();
    const sDaily = calculateStrength(entry, now, {
      decayBasis: 'session',
      avgSessionIntervalDays: 1,
    });
    const sWeekly = calculateStrength(entry, now, {
      decayBasis: 'session',
      avgSessionIntervalDays: 7,
    });
    // Weekly agent: 7 days / 7 = 1 session. Daily: 7 days / 1 = 7 sessions.
    // Fewer sessions = less decay = higher strength.
    expect(sWeekly).toBeGreaterThan(sDaily);
  });

  it('adaptive mode: scales half-life by session interval', () => {
    const entry = makeAged();
    // Agent runs every 3 days on average
    const sAdaptive = calculateStrength(entry, now, {
      decayBasis: 'adaptive',
      avgSessionIntervalDays: 3,
    });
    // Effective half-life = 7 * 3 = 21 days. 7 days / 21 = 0.5^(1/3) ≈ 0.794
    expect(sAdaptive).toBeCloseTo(0.794, 2);
  });

  it('adaptive mode: daily agent behaves like clock mode', () => {
    const entry = makeAged();
    const sClock = calculateStrength(entry, now, { decayBasis: 'clock' });
    const sAdaptive = calculateStrength(entry, now, {
      decayBasis: 'adaptive',
      avgSessionIntervalDays: 1,
    });
    // avgInterval <= 1 day means no scaling, same as clock
    expect(sAdaptive).toBeCloseTo(sClock, 5);
  });

  it('adaptive mode: weekly agent gets 7x half-life', () => {
    const entry = makeAged();
    const sWeekly = calculateStrength(entry, now, {
      decayBasis: 'adaptive',
      avgSessionIntervalDays: 7,
    });
    // Effective half-life = 7 * 7 = 49 days. 7 days / 49 = 0.5^(1/7) ≈ 0.906
    expect(sWeekly).toBeCloseTo(0.906, 2);
  });

  it('adaptive mode: no session data falls back to clock behavior', () => {
    const entry = makeAged();
    const sClock = calculateStrength(entry, now, { decayBasis: 'clock' });
    const sAdaptive = calculateStrength(entry, now, {
      decayBasis: 'adaptive',
      avgSessionIntervalDays: 0,
    });
    expect(sAdaptive).toBeCloseTo(sClock, 5);
  });
});

describe('Layer.Trace', () => {
  it('is a distinct layer from buffer/episodic/semantic', () => {
    expect(Layer.Trace).toBe('trace');
    expect(Layer.Trace).not.toBe(Layer.Buffer);
    expect(Layer.Trace).not.toBe(Layer.Episodic);
    expect(Layer.Trace).not.toBe(Layer.Semantic);
  });
});

describe('MemoryEntry trace fields', () => {
  it('defaults trace_outcome and source_session_id to null for non-trace entries', () => {
    const m = createMemory('plain memory content', { layer: Layer.Episodic });
    expect(m.trace_outcome).toBeNull();
    expect(m.source_session_id).toBeNull();
  });

  it('accepts trace_outcome when explicitly provided', () => {
    const m = createMemory('a trace', {
      layer: Layer.Trace,
      trace_outcome: 'success',
    });
    expect(m.trace_outcome).toBe('success');
  });

  it('accepts source_session_id on auto-promoted traces', () => {
    const m = createMemory('a trace', {
      layer: Layer.Trace,
      trace_outcome: 'success',
      source_session_id: 'sess-abc-123',
    });
    expect(m.source_session_id).toBe('sess-abc-123');
  });

  it('rejects invalid trace_outcome values', () => {
    expect(() => createMemory('invalid', {
      layer: Layer.Trace,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      trace_outcome: 'not-a-real-outcome' as any,
    })).toThrow(/trace_outcome/);
  });
});
