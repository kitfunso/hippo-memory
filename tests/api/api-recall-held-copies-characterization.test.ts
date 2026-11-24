import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { retrieve } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { removeDir } from '../_helpers/remove-dir.js';

function ctxFor(root: string): FullContext {
  return apiCtx(root, 'default', { subject: 'test:held', role: 'admin' });
}

function raw(text: string, leadIn?: string): MemoryEntry {
  return createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw',
    tenantId: 'default',
    leadIn,
  });
}

describe('recall held-copy drop', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('held-copies');
  });
  afterEach(() => removeDir(root));

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
    const result = await retrieve(ctxFor(root), {
      query: 'quokka',
      window: { limit: 10 },
      filter: { keepHeldCopies: true },
    });
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
    expect(result.tokens).toBe(11);
  });
});

describe('recall of rows that share content and differ in lead-in', () => {
  const LEAD_A = 'user: does the canaryline roll out region by region?';
  const LEAD_B = 'user: does the canaryline wait for a manual approval?';
  const LEAD_C = 'user: is the ingress config frozen this week?';
  let root: string;
  beforeEach(() => {
    root = makeRoot('held-copies-lead-in');
  });
  afterEach(() => removeDir(root));

  it('returns both "Yes." rows, each with its own lead-in', async () => {
    const a = raw('Yes.', LEAD_A);
    const b = raw('Yes.', LEAD_B);
    writeEntry(root, a);
    writeEntry(root, b);
    const result = await retrieve(ctxFor(root), { query: 'canaryline', window: { limit: 10 } });
    expect(result.results.map((r) => [r.id, r.leadIn]).sort()).toEqual(
      [
        [a.id, LEAD_A],
        [b.id, LEAD_B],
      ].sort(),
    );
    expect(result.suppressionSummary).toMatchObject({ droppedPreRank: 0 });
  });

  it('fresh tail keeps every "Yes." row under its own lead-in beside the one the base band shows', async () => {
    const rows = [raw('Yes.', LEAD_A), raw('Yes.', LEAD_B), raw('Yes.', LEAD_C)];
    for (const row of rows) writeEntry(root, row);
    const result = await retrieve(ctxFor(root), { query: 'canaryline', window: { limit: 1, freshTailCount: 5 } });
    expect(result.results.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(new Set(result.results.map((r) => r.leadIn))).toEqual(new Set([LEAD_A, LEAD_B, LEAD_C]));
  });
});
