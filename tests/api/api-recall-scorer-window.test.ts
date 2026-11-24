import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { retrieve } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, apiCtx } = sessionPerTest();

function ctxFor(root: string, tenantId: string = 'default'): FullContext {
  return apiCtx(root, tenantId, { subject: 'test:f3', role: 'admin' });
}
function makeRaw(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  return createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw',
    tenantId: opts.tenantId ?? 'default',
  });
}

describe('RecallOptions.scorerWindow', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('f3');
  });

  it('scorerWindow can widen the candidate pool above limit (proves widening)', async () => {
    writeEntriesTogether(
      root,
      Array.from({ length: 30 }, (_, i) => makeRaw(`zeta ${i}`)),
    );
    const result = await retrieve(ctxFor(root), {
      query: 'zeta',
      window: { limit: 5, scorerWindow: 25 },
    });
    expect(result.windowSize).toBe(25);
    expect(result.total).toBeGreaterThan(5);
    expect(result.total).toBe(25);
  });

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'scorerWindow=%s throws RecallContractError with code invalid_scorer_window (testing specialist #1)',
    async (bad) => {
      writeEntry(root, makeRaw('alpha'));
      let thrown = null;
      try {
        await retrieve(ctxFor(root), { query: 'alpha', window: { scorerWindow: bad } });
      } catch (err) {
        thrown = err;
      }
      // SAFETY: recall() with an invalid scorerWindow always throws
      // RecallContractError; this it.each case exists to prove that per bad
      // value below.
      expect((thrown as { name?: string })?.name).toBe('RecallContractError');
      // SAFETY: see above — RecallContractError is the only error type this
      // call path can throw.
      expect((thrown as { code?: string })?.code).toBe('invalid_scorer_window');
      // SAFETY: see above — RecallContractError is the only error type this
      // call path can throw.
      expect(String((thrown as { message?: string })?.message)).toMatch(/scorerWindow must be a positive integer/);
    },
  );

  it('limit semantics unchanged: caps base BM25 hits, fresh-tail/summary can expand', async () => {
    for (let i = 0; i < 10; i++) writeEntry(root, makeRaw(`omega ${i}`));
    const result = await retrieve(ctxFor(root), {
      query: 'omega',
      window: { limit: 3, freshTailCount: 5 },
    });
    expect(result.results.length).toBeGreaterThanOrEqual(5);
    expect(result.results.length).toBeLessThanOrEqual(8);
    const freshOnes = result.results.filter((r) => r.isFreshTail);
    expect(freshOnes).toHaveLength(5);
  });

  it('scorerWindow=1 (smallest legal value) is accepted and honoured', async () => {
    for (let i = 0; i < 5; i++) writeEntry(root, makeRaw(`tau ${i}`));
    const result = await retrieve(ctxFor(root), {
      query: 'tau',
      window: { limit: 5, scorerWindow: 1 },
    });
    expect(result.windowSize).toBe(1);
    expect(result.total).toBe(1);
  });
});
