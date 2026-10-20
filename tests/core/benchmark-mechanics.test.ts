// Mechanical behaviour over the benchmark corpus: decay, strengthening, error priority, outcome feedback and the token budget.
import { describe, it, expect } from 'vitest';
import { calculateStrength, applyOutcome, type MemoryEntry } from '../../src/base/memory/memory.js';
import { search } from '../../src/domain/search/bm25-search.js';
import { markRetrieved } from '../../src/base/memory/memory.js';
import { writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { createMemory7, tmpDir, daysAgo, useBenchmarkCorpus } from '../_helpers/benchmark-corpus.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

useBenchmarkCorpus();

// ---------------------------------------------------------------------------
// Mechanical behaviour tests
// ---------------------------------------------------------------------------

describe('Decay mechanics', () => {
  it('strength drops below 0.25 after 14 days without retrieval (default half-life=7d)', () => {
    initTestStore(tmpDir); // already init, no-op if exists
    const entry = createMemory7('temporary note');
    const fourteenDaysAgo = daysAgo(14);
    const aged: MemoryEntry = { ...entry, lastRetrieved: fourteenDaysAgo };

    const s = calculateStrength(aged, new Date());
    // At 14 days = 2 half-lives: decay = 0.5^2 = 0.25; retrieval_boost=1; emotional=1.0 -> s ≈ 0.25
    expect(s).toBeLessThanOrEqual(0.25);
  });

  it('error-tagged memory stays stronger than neutral after 7 days', () => {
    const now = new Date();
    const sevenDaysAgo = daysAgo(7);

    const errorMem = createMemory7('cache failure lesson', { tags: ['error'] });
    const neutralMem = createMemory7('cache failure lesson', { tags: [] });

    const agedError: MemoryEntry = { ...errorMem, lastRetrieved: sevenDaysAgo };
    const agedNeutral: MemoryEntry = { ...neutralMem, lastRetrieved: sevenDaysAgo };

    const sError = calculateStrength(agedError, now);
    const sNeutral = calculateStrength(agedNeutral, now);

    // Error gets: longer half_life + negative emotional_multiplier (2.0x as of
    // v1.13.5 / J5; was 1.5x in v1.13.4 and earlier).
    expect(sError).toBeGreaterThan(sNeutral);
  });
});

describe('Retrieval strengthening', () => {
  it('recalled memory has higher half_life and strength than an unrecalled peer', () => {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    let recalled = createMemory7('recalled memory about deployment');
    // Write to store so markRetrieved can use
    recalled = { ...recalled, lastRetrieved: sevenDaysAgo.toISOString() };
    const originalHalfLife = recalled.halfLifeDays;

    // Simulate 5 retrievals
    const retrieved = markRetrieved(
      markRetrieved(markRetrieved(markRetrieved(markRetrieved([recalled], now), now), now), now),
      now,
    );
    const finalEntry = retrieved[0];

    // 5 retrievals = +2 days each = +10 days to half_life
    expect(finalEntry.halfLifeDays).toBe(originalHalfLife + 10);

    // Compare strength against a same-age unrecalled peer
    const unrecalled: MemoryEntry = {
      ...recalled,
      retrievalCount: 0,
      halfLifeDays: originalHalfLife,
    };
    expect(calculateStrength(finalEntry, now)).toBeGreaterThan(calculateStrength(unrecalled, now));
  });
});

describe('Error priority', () => {
  it('error-tagged memory has 2x the half_life of identical neutral memory', () => {
    const errorMem = createMemory7('same content here', { tags: ['error'] });
    const neutralMem = createMemory7('same content here', { tags: [] });
    // error tag -> half_life * 2
    expect(errorMem.halfLifeDays).toBe(neutralMem.halfLifeDays * 2);
  });

  it('after 7 days, error-tagged strength > neutral strength', () => {
    const sevenDaysAgo = daysAgo(7);
    const now = new Date();

    const errorMem = createMemory7('rule violation', { tags: ['error'] });
    const neutralMem = createMemory7('rule violation', { tags: [] });

    const agedE: MemoryEntry = { ...errorMem, lastRetrieved: sevenDaysAgo };
    const agedN: MemoryEntry = { ...neutralMem, lastRetrieved: sevenDaysAgo };

    // error: half_life=14d, multiplier=1.5 -> decay=0.5^(7/14)=0.707, s=0.707*1.5=1.06 -> clamped to 1
    // neutral: half_life=7d, multiplier=1.0 -> decay=0.5^(7/7)=0.5, s=0.5
    expect(calculateStrength(agedE, now)).toBeGreaterThanOrEqual(2 * calculateStrength(agedN, now));
  });
});

describe('Outcome feedback', () => {
  it('--good increments outcome_positive counter', () => {
    const entry = createMemory7('some lesson');
    const updated = applyOutcome(entry, true);
    expect(updated.outcomePositive).toBe(1);
    expect(updated.outcomeNegative).toBe(0);
    expect(updated.outcomeScore).toBe(1);
    expect(updated.halfLifeDays).toBe(entry.halfLifeDays);
  });

  it('--bad increments outcome_negative counter', () => {
    const entry = createMemory7('some lesson');
    const updated = applyOutcome(entry, false);
    expect(updated.outcomePositive).toBe(0);
    expect(updated.outcomeNegative).toBe(1);
    expect(updated.outcomeScore).toBe(-1);
    expect(updated.halfLifeDays).toBe(entry.halfLifeDays);
  });
});

describe('Token budget', () => {
  it('total returned tokens respect budget of 100', () => {
    const entries = loadAllEntries(tmpDir, 'default');
    const results = search('production deployment rules', entries, { budget: 100 });

    const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(100);
  });

  it('returns at least some results even with tight budget', () => {
    // With budget=50 we should still get at least 1 result (short memories)
    const shortEntry = createMemory7('Use ; not && in PowerShell.');
    writeEntry(tmpDir, shortEntry);

    const entries = loadAllEntries(tmpDir, 'default');
    const results = search('PowerShell', entries, { budget: 50 });
    // The first result is always included even if it exceeds budget
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Second and beyond should not push total far past budget
    if (results.length > 1) {
      const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
      expect(totalTokens).toBeLessThanOrEqual(100); // generous cap for first-result override
    }
  });

  it('minResults guarantees at least N results regardless of budget', () => {
    const entries = loadAllEntries(tmpDir, 'default');
    const withMin = search('production deployment rules', entries, {
      budget: 100,
      minResults: 5,
    });
    const withoutMin = search('production deployment rules', entries, {
      budget: 100,
    });
    expect(withMin.length).toBeGreaterThanOrEqual(Math.min(5, entries.length));
    expect(withMin.length).toBeGreaterThanOrEqual(withoutMin.length);
  });
});
