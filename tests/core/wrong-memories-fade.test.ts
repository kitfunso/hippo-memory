// A memory marked wrong more often than right fades, whatever shields it: pinning, error tags, heavy recall.
import { describe, expect, it } from 'vitest';
import { applyOutcome, calculateStrength, netWrong, type MemoryEntry } from '../../src/base/memory/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { markRetrieved } from '../../src/base/memory/memory.js';

const now = new Date('2026-09-25T00:00:00Z');

function fresh(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const e = createMemory('ENTSO-E power was removed from the daily refresh');
  return { ...e, created: now.toISOString(), lastRetrieved: now.toISOString(), ...overrides };
}

function marked(e: MemoryEntry, bad: number, good = 0): MemoryEntry {
  let out = e;
  for (let i = 0; i < bad; i++) out = applyOutcome(out, false);
  for (let i = 0; i < good; i++) out = applyOutcome(out, true);
  return out;
}

describe('wrong memories fade', () => {
  it('netWrong counts bad marks past good ones, never below zero', () => {
    expect(netWrong(marked(fresh(), 3, 1))).toBe(2);
    expect(netWrong(marked(fresh(), 1, 4))).toBe(0);
  });

  it('halves strength per net bad mark, capped at three', () => {
    expect(calculateStrength(marked(fresh(), 1), now)).toBeCloseTo(0.5);
    expect(calculateStrength(marked(fresh(), 2), now)).toBeCloseTo(0.25);
    expect(calculateStrength(marked(fresh(), 9), now)).toBeCloseTo(0.125);
  });

  it('a good mark cancels a bad one', () => {
    expect(calculateStrength(marked(fresh(), 1, 1), now)).toBeCloseTo(1.0);
  });

  it('pinning does not shield a memory marked wrong', () => {
    expect(calculateStrength(fresh({ pinned: true }), now)).toBe(1.0);
    expect(calculateStrength(marked(fresh({ pinned: true }), 2), now)).toBeCloseTo(0.25);
  });

  it('an error-tagged lesson keeps its boost until it is marked wrong', () => {
    const lesson = fresh({ emotionalValence: 'negative', tags: ['error'] });
    expect(calculateStrength(lesson, now)).toBe(1.0);
    expect(calculateStrength(marked(lesson, 1), now)).toBeCloseTo(0.5);
  });

  it('heavy recall does not shield a memory marked wrong', () => {
    const e = marked(fresh({ retrievalCount: 633 }), 3);
    expect(calculateStrength(e, now)).toBeCloseTo(0.125);
  });

  it('recall stops growing the half-life of a memory marked wrong', () => {
    const right = fresh();
    const wrong = marked(fresh(), 1);
    const [r] = markRetrieved([right], now);
    const [w] = markRetrieved([wrong], now);
    expect(r.halfLifeDays).toBe(right.halfLifeDays + 2);
    expect(w.halfLifeDays).toBe(wrong.halfLifeDays);
    expect(w.retrievalCount).toBe(wrong.retrievalCount + 1);
  });

  it('recall does not reset the decay clock of an aged memory marked wrong', () => {
    const monthAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const wrong = marked(fresh({ halfLifeDays: 30, lastRetrieved: monthAgo }), 1);
    const before = calculateStrength(wrong, now);
    const [w] = markRetrieved([wrong], now);
    expect(w.lastRetrieved).toBe(monthAgo);
    expect(calculateStrength(w, now)).toBeCloseTo(before);
    expect(before).toBeLessThan(0.3);
  });
});
