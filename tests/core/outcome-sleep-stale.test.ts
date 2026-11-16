// A good outcome clears the stale mark sleep put on a row (conflict-loser or replaced-by:), but not one a person or a
// decision set (invalidated, superseded).
import { describe, expect, it } from 'vitest';
import type { ConfidenceLevel } from '../../src/base/memory/entry.js';
import { entryAfterOutcome } from '../../src/base/memory/keep-rules.js';
import { PRODUCTION_STRENGTH } from '../../src/base/memory/strength.js';
import { createMemory } from '../../src/entry/memory.js';
import { evalNow } from '../../src/infra/eval-switches.js';

const after = (good: boolean, tags: string[], confidence: ConfidenceLevel = 'stale') =>
  entryAfterOutcome(
    createMemory('the rota is on tuesdays', { tags, confidence }),
    good,
    evalNow(),
    PRODUCTION_STRENGTH,
  );

describe('entryAfterOutcome on a stale-marked row', () => {
  it.each([['conflict-loser'], ['replaced-by:mem_newer']])('a good outcome clears %s and the stale tier', (mark) => {
    const row = after(true, ['rota', mark]);
    expect(row.confidence).toBe('observed');
    expect(row.tags).toEqual(['rota']);
  });

  it('keeps invalidated and superseded, and the stale tier they set, while it drops the sleep mark', () => {
    const row = after(true, ['invalidated', 'superseded', 'conflict-loser']);
    expect(row.confidence).toBe('stale');
    expect(row.tags).toEqual(['invalidated', 'superseded']);
    expect(after(true, ['superseded']).tags).toEqual(['superseded']);
  });

  it('a bad outcome keeps the mark and the tier', () => {
    const row = after(false, ['replaced-by:mem_newer']);
    expect(row.confidence).toBe('stale');
    expect(row.tags).toEqual(['replaced-by:mem_newer']);
  });

  it('leaves a row that is not stale alone', () => {
    expect(after(true, ['conflict-loser'], 'observed').tags).toEqual(['conflict-loser']);
  });
});
