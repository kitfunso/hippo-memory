// Pins how recallFrom drops same-text copies across its bands and counts them in the suppression summary.

import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../../src/store/entry-writes.js';
import { createMemory, Layer, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { retrieve } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';

function ctxFor(root: string): FullContext {
  return apiCtx(root, 'default', { subject: 'test:held', role: 'admin' });
}

function raw(text: string): MemoryEntry {
  return createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw',
    tenantId: 'default',
  });
}

describe('recall held-copy drop', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('held-copies'); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('returns one row per text and counts the hidden copy as dropped before ranking', async () => {
    writeEntry(root, raw('quokka habitat notes'));
    writeEntry(root, raw('quokka habitat notes'));
    writeEntry(root, raw('quokka diet notes'));
    const result = await retrieve(ctxFor(root), { query: 'quokka', window: { limit: 10 } });
    expect(result.results.map((r) => r.content).sort()).toEqual(['quokka diet notes', 'quokka habitat notes']);
    expect(result.total).toBe(3);
    expect(result.suppressionSummary).toMatchObject({ totalCandidates: 3, droppedPreRank: 1, droppedByBudget: 0 });
  });

  it('keepHeldCopies returns every copy and drops nothing', async () => {
    writeEntry(root, raw('quokka habitat notes'));
    writeEntry(root, raw('quokka habitat notes'));
    const result = await retrieve(ctxFor(root), { query: 'quokka', window: { limit: 10 }, filter: { keepHeldCopies: true } });
    expect(result.results).toHaveLength(2);
    expect(result.suppressionSummary).toMatchObject({ droppedPreRank: 0 });
  });

  it('fresh tail skips a recent row whose text the base band already shows', async () => {
    writeEntry(root, raw('quokka habitat notes'));
    writeEntry(root, raw('unrelated wombat line'));
    const result = await retrieve(ctxFor(root), { query: 'quokka', window: { limit: 1, freshTailCount: 5 } });
    const contents = result.results.map((r) => r.content);
    expect(contents.filter((c) => c === 'quokka habitat notes')).toHaveLength(1);
    expect(result.results.every((r) => r.isFreshTail === true)).toBe(true);
    expect(result.suppressionSummary?.freshTailAdded).toBe(result.results.length - 1);
    // ceil(chars / 4) of each row: 20 characters cost 5 and 21 cost 6.
    expect(result.tokens).toBe(11);
  });
});
