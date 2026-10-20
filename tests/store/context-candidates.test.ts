import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { calculateStrength, type MemoryEntry } from '../../src/base/memory/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { withSharedStoreHandles } from '../../src/db/index.js';
import { strengthAblation } from '../../src/base/memory/ablation.js';
import { ID_CHUNK } from '../../src/base/util/chunked.js';
import { makeStore } from '../_helpers/make-root.js';
import { loadContextCandidates, tallySources, loadTextsHoldingWords, writeEntry } from '../_helpers/root-forms.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const NOW = new Date('2026-06-01T00:00:00.000Z');
const DAY = 86400000;

function row(id: string, ageDays: number, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const at = new Date(NOW.getTime() - ageDays * DAY).toISOString();
  return {
    ...createMemory(`row ${id} body`, { tenantId: 'default' }),
    id,
    created: at,
    validFrom: at,
    lastRetrieved: at,
    halfLifeDays: 10,
    originProject: 'proj',
    ...extra,
  };
}

describe('loadContextCandidates over the cap', () => {
  let root: string;

  beforeEach(async () => {
    root = makeStore('ctx-candidates').root;
    await withSharedStoreHandles(() => {
      for (const e of [
        row('a-old-pin', 90, { pinned: true }),
        row('b-fresh', 1),
        row('c-stale', 60),
        row('d-rewarded', 25, { outcomePositive: 8 }),
        row('e-mid', 20),
        row('f-private', 0, { scope: 'slack:private:c1' }),
        row('g-other', 0, { originProject: 'other' }),
        row('h-global', 2, { originProject: '' }),
        row('i-superseded', 0, { supersededBy: 'b-fresh' }),
        row('j-acme', 0, { tenantId: 'acme' }),
        row('k-team', 0, { scope: 'team:x' }),
      ]) {
        writeEntry(root, e);
      }
    });
  });

  afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

  it('keeps pins, then the rows decay has worn least, and returns them oldest first', () => {
    const got = loadContextCandidates(root, 'default', { project: ['proj'], cap: 5, now: NOW });
    // Past the pin: k-team, b-fresh, h-global, then d-rewarded, whose reward outlasts e-mid's shorter age.
    expect(got.map((e) => e.id)).toEqual(['a-old-pin', 'd-rewarded', 'h-global', 'b-fresh', 'k-team']);
    const strengths = got.filter((e) => !e.pinned).map((e) => calculateStrength(e, NOW));
    expect(Math.min(...strengths)).toBeGreaterThan(calculateStrength(row('e-mid', 20), NOW));
  });

  it('applies scope, origin, tenant and supersession in SQL', () => {
    const all = (filter: Parameters<typeof loadContextCandidates>[2]): string[] =>
      loadContextCandidates(root, 'default', filter)
        .map((e) => e.id)
        .sort();
    expect(all({ project: ['proj'], cap: 100, now: NOW })).toEqual([
      'a-old-pin',
      'b-fresh',
      'c-stale',
      'd-rewarded',
      'e-mid',
      'h-global',
      'k-team',
    ]);
    expect(all({ cap: 100, now: NOW })).toContain('g-other');
    expect(all({ exactScope: 'team:x', cap: 100, now: NOW })).toEqual(['k-team']);
    expect(all({ project: ['proj'], cap: 100, now: NOW })).not.toContain('f-private');
    expect(all({ exactScope: 'slack:private:c1', project: ['proj'], cap: 100, now: NOW })).toEqual(['f-private']);
  });

  it('tallies sources and finds rows by a word they hold', () => {
    expect(tallySources(root, 'default').map((t) => [t.source, t.count])).toEqual([['cli', 10]]);
    expect(tallySources(root).reduce((n, t) => n + t.count, 0)).toBe(11);
    expect(loadTextsHoldingWords(root, 'default', ['e-mid', 'nothing']).map((r) => r.content)).toEqual([
      'row e-mid body',
    ]);
    const scoped = loadTextsHoldingWords(root, 'default', ['e-mid', 'g-other', 'h-global', 'j-acme'], ['proj']);
    expect(scoped.map((r) => [r.content, r.originProject]).sort()).toEqual([
      ['row e-mid body', 'proj'],
      ['row h-global body', ''],
    ]);
  });

  it('finds a row whose word falls on either side of a chunk boundary and in the last chunk', () => {
    const filler = (n: number): string[] => Array.from({ length: n }, (_, i) => `absent-${i}`);
    const words = [...filler(ID_CHUNK - 1), 'e-mid', 'g-other', ...filler(ID_CHUNK), 'h-global'];
    expect(words.length).toBeGreaterThan(2 * ID_CHUNK);
    expect(
      loadTextsHoldingWords(root, 'default', words)
        .map((r) => r.content)
        .sort(),
    ).toEqual(['row e-mid body', 'row g-other body', 'row h-global body']);
  });
});

describe('loadContextCandidates reward factor', () => {
  let root: string;

  beforeEach(() => {
    root = makeStore('ctx-reward').root;
  });

  afterEach(() => {
    vi.stubEnv('HIPPO_ABLATE_OUTCOME_SLOW', undefined);
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  // One row survives a cap of 1; the pair is chosen so a slope other than REWARD_SLOPE flips the winner.
  async function survivor(rows: MemoryEntry[]): Promise<{ id: string; strongest: string }> {
    await withSharedStoreHandles(() => {
      for (const e of rows) writeEntry(root, e);
    });
    const got = loadContextCandidates(root, 'default', { cap: 1, now: NOW });
    const options = { ablation: strengthAblation() };
    const strongest = [...rows].sort(
      (a, b) => calculateStrength(b, NOW, options) - calculateStrength(a, NOW, options),
    )[0].id;
    return { id: got[0].id, strongest };
  }

  it('ranks asymmetric outcomes the way calculateStrength does', async () => {
    // 20 days old: rewarded x8 at slope 0.5 is 13.75 days against plain y's 14.5; a slope of 0.7 would give 15.25 and flip them.
    const { id, strongest } = await survivor([
      row('x-rewarded', 20, { outcomePositive: 3 }),
      row('y-plain', 20, { halfLifeDays: 14.5 }),
    ]);
    expect(strongest).toBe('y-plain');
    expect(id).toBe(strongest);
  });

  it('drops the reward factor from the rank when outcome-slow is ablated', async () => {
    vi.stubEnv('HIPPO_ABLATE_OUTCOME_SLOW', '1');
    const { id, strongest } = await survivor([
      row('x-rewarded', 20, { outcomePositive: 3 }),
      row('z-plain', 20, { halfLifeDays: 12 }),
    ]);
    expect(strongest).toBe('z-plain');
    expect(id).toBe(strongest);
  });
});
