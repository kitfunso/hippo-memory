import { describe, it, expect } from 'vitest';
import { sampleForReplay, replayPriority } from '../src/replay.js';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';

function fakeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  // Pad short content to satisfy createMemory's min-3-char check.
  const rawContent = overrides.content ?? 'test memory';
  const padded = rawContent.length < 3 ? `${rawContent}-test-memory` : rawContent;
  const base = createMemory(padded, {
    layer: Layer.Episodic,
    tags: [],
    emotional_valence: 'neutral',
  });
  return { ...base, ...overrides, content: padded };
}

describe('sampleForReplay', () => {
  it('returns empty when count is zero', () => {
    const entries = [fakeEntry({ content: 'a' }), fakeEntry({ content: 'b' })];
    const sample = sampleForReplay(entries, 0, new Date(), 42);
    expect(sample).toHaveLength(0);
  });

  it('returns empty when survivors are empty', () => {
    const sample = sampleForReplay([], 5, new Date(), 42);
    expect(sample).toHaveLength(0);
  });

  it('caps sample size at survivors.length', () => {
    const entries = [fakeEntry({ content: 'a' }), fakeEntry({ content: 'b' })];
    const sample = sampleForReplay(entries, 10, new Date(), 42);
    expect(sample).toHaveLength(2);
  });

  it('is deterministic for a given seed', () => {
    const entries = [
      fakeEntry({ content: 'a' }),
      fakeEntry({ content: 'b' }),
      fakeEntry({ content: 'c' }),
      fakeEntry({ content: 'd' }),
    ];
    const s1 = sampleForReplay(entries, 2, new Date(), 42);
    const s2 = sampleForReplay(entries, 2, new Date(), 42);
    expect(s1.map(e => e.id)).toEqual(s2.map(e => e.id));
  });

  it('prefers high-reward memories over neutral peers', () => {
    const entries: MemoryEntry[] = [];
    // 10 neutral memories
    for (let i = 0; i < 10; i++) {
      entries.push(fakeEntry({ content: `neutral-${i}` }));
    }
    // 1 high-reward memory
    const hero = fakeEntry({
      content: 'high-reward',
      outcome_positive: 20,
      outcome_negative: 0,
    });
    entries.push(hero);

    // Over many seeds, hero should be sampled more often than any neutral peer.
    const counts = new Map<string, number>();
    for (let seed = 0; seed < 100; seed++) {
      const sample = sampleForReplay(entries, 1, new Date(), seed);
      for (const s of sample) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
    }
    const heroHits = counts.get(hero.id) ?? 0;
    // Most common neutral memory's count
    const peerHits = Math.max(
      0,
      ...[...counts.entries()].filter(([id]) => id !== hero.id).map(([, c]) => c)
    );
    expect(heroHits).toBeGreaterThan(peerHits);
  });

  it('prefers critical-valence memories over neutral peers (expected rate check)', () => {
    const entries: MemoryEntry[] = [];
    for (let i = 0; i < 10; i++) entries.push(fakeEntry({ content: `neutral-${i}` }));
    const critical = fakeEntry({ content: 'critical', emotional_valence: 'critical' });
    entries.push(critical);

    const TRIALS = 500;
    const counts = new Map<string, number>();
    for (let seed = 0; seed < TRIALS; seed++) {
      const sample = sampleForReplay(entries, 1, new Date(), seed);
      for (const s of sample) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
    }
    const criticalHits = counts.get(critical.id) ?? 0;
    // Neutral = weight 1.0, critical = weight 2.0. Expected critical rate = 2/(10+2) = 1/6.
    // Expected neutral mean rate = 1/12. Require critical to exceed the average neutral.
    const peerHits = [...counts.entries()].filter(([id]) => id !== critical.id).map(([, c]) => c);
    const peerAvg = peerHits.reduce((a, b) => a + b, 0) / Math.max(1, peerHits.length);
    expect(criticalHits).toBeGreaterThan(peerAvg);
  });

  it('prefers under-retrieved memories over heavily retrieved peers', () => {
    const entries: MemoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(fakeEntry({ content: `busy-${i}`, retrieval_count: 50 }));
    }
    const fresh = fakeEntry({ content: 'fresh', retrieval_count: 0 });
    entries.push(fresh);

    const counts = new Map<string, number>();
    for (let seed = 0; seed < 100; seed++) {
      const sample = sampleForReplay(entries, 1, new Date(), seed);
      for (const s of sample) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
    }
    const freshHits = counts.get(fresh.id) ?? 0;
    const peerMax = Math.max(
      0,
      ...[...counts.entries()].filter(([id]) => id !== fresh.id).map(([, c]) => c)
    );
    expect(freshHits).toBeGreaterThan(peerMax);
  });

  it('does not sample the same memory twice within one call', () => {
    const entries = [
      fakeEntry({ content: 'a' }),
      fakeEntry({ content: 'b' }),
      fakeEntry({ content: 'c' }),
    ];
    const sample = sampleForReplay(entries, 3, new Date(), 42);
    const ids = sample.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('replayPriority', () => {
  it('returns a positive finite number for a plain entry', () => {
    const e = fakeEntry({ content: 'x' });
    const p = replayPriority(e, new Date());
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThan(0);
  });

  it('critical valence > neutral valence', () => {
    const now = new Date();
    const neutral = fakeEntry({ content: 'n' });
    const critical = fakeEntry({ content: 'c', emotional_valence: 'critical' });
    expect(replayPriority(critical, now)).toBeGreaterThan(replayPriority(neutral, now));
  });

  it('more positive outcomes > fewer', () => {
    const now = new Date();
    const low = fakeEntry({ content: 'l', outcome_positive: 0, outcome_negative: 0 });
    const high = fakeEntry({ content: 'h', outcome_positive: 5, outcome_negative: 0 });
    expect(replayPriority(high, now)).toBeGreaterThan(replayPriority(low, now));
  });

  it('under-retrieved > heavily retrieved', () => {
    const now = new Date();
    const fresh = fakeEntry({ content: 'f', retrieval_count: 0 });
    const busy = fakeEntry({ content: 'b', retrieval_count: 50 });
    expect(replayPriority(fresh, now)).toBeGreaterThan(replayPriority(busy, now));
  });
});
