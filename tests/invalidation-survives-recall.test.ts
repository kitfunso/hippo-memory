// `hippo invalidate` marks a memory wrong by storing confidence 'stale'.
// Reading it put the tier back to 'observed', so one recall undid the
// invalidation while the 'invalidated' tag stayed on the row.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry, readEntry } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { markRetrieved } from '../src/search.js';
import { invalidateMatching } from '../src/invalidation.js';
import { remember, getContext } from '../src/api.js';

let home: string;

function ctx() {
  return { hippoRoot: home, tenantId: 'default', actor: { subject: 'test', role: 'admin' as const } };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hippo-invalidation-recall-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('a deliberate stale tier survives being read', () => {
  it('a recall through getContext leaves an invalidated memory invalidated', async () => {
    const { id } = remember(ctx(), { content: 'deploys go through the legacy pipeline' });

    const result = invalidateMatching(home, { from: 'legacy pipeline', to: null, type: 'deprecation' });
    expect(result.invalidated).toBe(1);

    const invalidated = readEntry(home, id)!;
    expect(invalidated.confidence).toBe('stale');
    expect(invalidated.tags).toContain('invalidated');

    await getContext(ctx(), { q: 'legacy pipeline deploys', budget: 2000 });

    const afterRead = readEntry(home, id)!;
    expect(afterRead.retrieval_count).toBeGreaterThan(invalidated.retrieval_count);
    expect(afterRead.confidence).toBe('stale');
    expect(afterRead.tags).toContain('invalidated');
  });

  it('markRetrieved does not move the stored tier of a deliberately stale entry', () => {
    const entry = { ...createMemory('an invalidated fact', { confidence: 'observed' }), confidence: 'stale' as const };

    const [updated] = markRetrieved([entry]);

    expect(updated.confidence).toBe('stale');
  });

  // Supersede is the second writer of a stored 'stale' (src/cli.ts:4703) and
  // reaches the same read path, so it needs its own case.
  it('a superseded memory stays stale through a read', () => {
    const superseded = {
      ...createMemory('the old decision', { confidence: 'observed' }),
      confidence: 'stale' as const,
      tags: ['superseded'],
    };
    writeEntry(home, superseded);

    const [updated] = markRetrieved([readEntry(home, superseded.id)!]);
    writeEntry(home, updated);

    expect(readEntry(home, superseded.id)!.confidence).toBe('stale');
  });

  it('still applies the retrieval boosts a read is supposed to apply', () => {
    const entry = { ...createMemory('a stale fact', { confidence: 'observed' }), confidence: 'stale' as const };

    const [updated] = markRetrieved([entry]);

    expect(updated.retrieval_count).toBe(entry.retrieval_count + 1);
    expect(updated.half_life_days).toBe(entry.half_life_days + 2);
    expect(new Date(updated.last_retrieved).getTime()).toBeGreaterThan(new Date(entry.last_retrieved).getTime() - 1);
  });

  it('leaves every other tier untouched, so the fix is not a blanket freeze', () => {
    for (const tier of ['verified', 'observed', 'inferred'] as const) {
      const entry = createMemory(`a ${tier} fact`, { confidence: tier });
      const [updated] = markRetrieved([entry]);
      expect(updated.confidence).toBe(tier);
    }
  });
});
