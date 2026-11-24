import { describe, it, expect } from 'vitest';
import { sampleForReplay, replayPriority } from '../../src/domain/consolidate/replay.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';

function fakeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  const rawContent = overrides.content ?? 'test memory';
  const padded = rawContent.length < 3 ? `${rawContent}-test-memory` : rawContent;
  const base = createMemory(padded, {
    layer: Layer.Episodic,
    tags: [],
    emotionalValence: 'neutral',
  });
  return { ...base, ...overrides, content: padded };
}

describe('sampleForReplay', () => {
  it('returns empty when count is zero', async () => {
    const entries = [fakeEntry({ content: 'a' }), fakeEntry({ content: 'b' })];
    const sample = await sampleForReplay({ survivors: entries, count: 0, now: new Date(), seed: 42 });
    expect(sample).toHaveLength(0);
  });

  it('returns empty when survivors are empty', async () => {
    const sample = await sampleForReplay({ survivors: [], count: 5, now: new Date(), seed: 42 });
    expect(sample).toHaveLength(0);
  });

  it('caps sample size at survivors.length', async () => {
    const entries = [fakeEntry({ content: 'a' }), fakeEntry({ content: 'b' })];
    const sample = await sampleForReplay({ survivors: entries, count: 10, now: new Date(), seed: 42 });
    expect(sample).toHaveLength(2);
  });

  it('is deterministic for a given seed', async () => {
    const entries = [
      fakeEntry({ content: 'a' }),
      fakeEntry({ content: 'b' }),
      fakeEntry({ content: 'c' }),
      fakeEntry({ content: 'd' }),
    ];
    const s1 = await sampleForReplay({ survivors: entries, count: 2, now: new Date(), seed: 42 });
    const s2 = await sampleForReplay({ survivors: entries, count: 2, now: new Date(), seed: 42 });
    expect(s1).toEqual(s2);
  });

  it('prefers high-reward memories over neutral peers', async () => {
    const entries: MemoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(fakeEntry({ content: `neutral-${i}` }));
    }
    const hero = fakeEntry({
      content: 'high-reward',
      outcomePositive: 20,
      outcomeNegative: 0,
    });
    entries.push(hero);

    const counts = new Map<string, number>();
    for (let seed = 0; seed < 100; seed++) {
      const sample = await sampleForReplay({ survivors: entries, count: 1, now: new Date(), seed });
      for (const id of sample) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const heroHits = counts.get(hero.id) ?? 0;
    const peerHits = Math.max(0, ...[...counts.entries()].filter(([id]) => id !== hero.id).map(([, c]) => c));
    expect(heroHits).toBeGreaterThan(peerHits);
  });

  it('prefers critical-valence memories over neutral peers (expected rate check)', async () => {
    const entries: MemoryEntry[] = [];
    for (let i = 0; i < 10; i++) entries.push(fakeEntry({ content: `neutral-${i}` }));
    const critical = fakeEntry({ content: 'critical', emotionalValence: 'critical' });
    entries.push(critical);

    const TRIALS = 500;
    const counts = new Map<string, number>();
    for (let seed = 0; seed < TRIALS; seed++) {
      const sample = await sampleForReplay({ survivors: entries, count: 1, now: new Date(), seed });
      for (const id of sample) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const criticalHits = counts.get(critical.id) ?? 0;
    const peerHits = [...counts.entries()].filter(([id]) => id !== critical.id).map(([, c]) => c);
    const peerAvg = peerHits.reduce((a, b) => a + b, 0) / Math.max(1, peerHits.length);
    expect(criticalHits).toBeGreaterThan(peerAvg);
  });

  it('prefers under-retrieved memories over heavily retrieved peers', async () => {
    const entries: MemoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(fakeEntry({ content: `busy-${i}`, retrievalCount: 50 }));
    }
    const fresh = fakeEntry({ content: 'fresh', retrievalCount: 0 });
    entries.push(fresh);

    const counts = new Map<string, number>();
    for (let seed = 0; seed < 100; seed++) {
      const sample = await sampleForReplay({ survivors: entries, count: 1, now: new Date(), seed });
      for (const id of sample) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const freshHits = counts.get(fresh.id) ?? 0;
    const peerMax = Math.max(0, ...[...counts.entries()].filter(([id]) => id !== fresh.id).map(([, c]) => c));
    expect(freshHits).toBeGreaterThan(peerMax);
  });

  it('does not sample the same memory twice within one call', async () => {
    const entries = [fakeEntry({ content: 'a' }), fakeEntry({ content: 'b' }), fakeEntry({ content: 'c' })];
    const sample = await sampleForReplay({ survivors: entries, count: 3, now: new Date(), seed: 42 });
    expect(new Set(sample).size).toBe(sample.length);
  });
});

describe('replayPriority', () => {
  it('returns a positive finite number for a plain entry', () => {
    const e = fakeEntry({ content: 'x', strength: 1 });
    const p = replayPriority(e, new Date(e.lastRetrieved), false);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBe(1);
  });

  it('critical valence > neutral valence', () => {
    const now = new Date();
    const neutral = fakeEntry({ content: 'n' });
    const critical = fakeEntry({ content: 'c', emotionalValence: 'critical' });
    expect(replayPriority(critical, now, false)).toBeGreaterThan(replayPriority(neutral, now, false));
  });

  it('more positive outcomes > fewer', () => {
    const now = new Date();
    const low = fakeEntry({ content: 'l', outcomePositive: 0, outcomeNegative: 0 });
    const high = fakeEntry({ content: 'h', outcomePositive: 5, outcomeNegative: 0 });
    expect(replayPriority(high, now, false)).toBeGreaterThan(replayPriority(low, now, false));
  });

  it('under-retrieved > heavily retrieved', () => {
    const now = new Date();
    const fresh = fakeEntry({ content: 'f', retrievalCount: 0 });
    const busy = fakeEntry({ content: 'b', retrievalCount: 50 });
    expect(replayPriority(fresh, now, false)).toBeGreaterThan(replayPriority(busy, now, false));
  });

  it('stays positive even when negative outcomes dominate', () => {
    const now = new Date();
    const doomed = fakeEntry({ content: 'doom', outcomePositive: 0, outcomeNegative: 100, strength: 1 });
    expect(replayPriority(doomed, now, false)).toBe(0.1);
  });

  it('is finite when last_retrieved is malformed', () => {
    const now = new Date();
    const bad = fakeEntry({ content: 'bad', strength: 1 });
    const mutated = { ...bad, lastRetrieved: 'not-a-date' };
    const p = replayPriority(mutated, now, false);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBe(1);
  });
});
