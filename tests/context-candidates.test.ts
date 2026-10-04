import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadContextCandidates, tallySources, loadTextsHoldingWords } from '../src/store/candidates.js';
import { calculateStrength, type MemoryEntry } from '../src/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { withSharedStoreHandles } from '../src/db.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const DAY = 86400000;

function row(id: string, ageDays: number, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const at = new Date(NOW.getTime() - ageDays * DAY).toISOString();
  return {
    ...createMemory(`row ${id} body`, { tenantId: 'default' }),
    id,
    created: at,
    valid_from: at,
    last_retrieved: at,
    half_life_days: 10,
    origin_project: 'proj',
    ...extra,
  };
}

describe('loadContextCandidates over the cap', () => {
  let root: string;

  beforeEach(async () => {
    root = join(mkdtempSync(join(tmpdir(), 'hippo-ctx-candidates-')), '.hippo');
    initStore(root);
    await withSharedStoreHandles(() => {
      for (const e of [
        row('a-old-pin', 90, { pinned: true }),
        row('b-fresh', 1),
        row('c-stale', 60),
        row('d-rewarded', 25, { outcome_positive: 8 }),
        row('e-mid', 20),
        row('f-private', 0, { scope: 'slack:private:c1' }),
        row('g-other', 0, { origin_project: 'other' }),
        row('h-global', 2, { origin_project: '' }),
        row('i-superseded', 0, { superseded_by: 'b-fresh' }),
        row('j-acme', 0, { tenantId: 'acme' }),
        row('k-team', 0, { scope: 'team:x' }),
      ]) writeEntry(root, e);
    });
  });

  afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

  it('keeps pins, then the rows decay has worn least, and returns them oldest first', () => {
    const got = loadContextCandidates(root, 'default', { project: 'proj', cap: 5, now: NOW });
    // Past the pin: k-team, b-fresh, h-global, then d-rewarded, whose reward outlasts e-mid's shorter age.
    expect(got.map((e) => e.id)).toEqual(['a-old-pin', 'd-rewarded', 'h-global', 'b-fresh', 'k-team']);
    const strengths = got.filter((e) => !e.pinned).map((e) => calculateStrength(e, NOW));
    expect(Math.min(...strengths)).toBeGreaterThan(calculateStrength(row('e-mid', 20), NOW));
  });

  it('applies scope, origin, tenant and supersession in SQL', () => {
    const all = (filter: Parameters<typeof loadContextCandidates>[2]): string[] =>
      loadContextCandidates(root, 'default', filter).map((e) => e.id).sort();
    expect(all({ project: 'proj', cap: 100, now: NOW })).toEqual(['a-old-pin', 'b-fresh', 'c-stale', 'd-rewarded', 'e-mid', 'h-global', 'k-team']);
    expect(all({ cap: 100, now: NOW })).toContain('g-other');
    expect(all({ exactScope: 'team:x', cap: 100, now: NOW })).toEqual(['k-team']);
    expect(all({ project: 'proj', cap: 100, now: NOW })).not.toContain('f-private');
    expect(all({ exactScope: 'slack:private:c1', project: 'proj', cap: 100, now: NOW })).toEqual(['f-private']);
  });

  it('tallies sources and finds rows by a word they hold', () => {
    expect(tallySources(root, 'default').map((t) => [t.source, t.count])).toEqual([['cli', 10]]);
    expect(tallySources(root).reduce((n, t) => n + t.count, 0)).toBe(11);
    expect(loadTextsHoldingWords(root, 'default', ['e-mid', 'nothing']).map((r) => r.content)).toEqual(['row e-mid body']);
  });
});
