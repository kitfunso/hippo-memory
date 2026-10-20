// `hippo invalidate` marks a memory wrong by storing confidence 'stale'.
// Reading it put the tier back to 'observed', so one recall undid the
// invalidation while the 'invalidated' tag stayed on the row.

import { describe, it, expect, beforeEach } from 'vitest';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { markRetrieved } from '../../src/base/memory/memory.js';
import { invalidateMatching } from '../../src/domain/learn/invalidation.js';
import { remember, contextGet } from '../../src/api/index.js';
import { apiCtx, cwdProject } from '../_helpers/api-ctx.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, readEntry } from '../_helpers/root-forms.js';

let home: string;

function ctx() {
  return apiCtx(home, 'default', { subject: 'test', role: 'admin' as const });
}

beforeEach(() => {
  home = makeRoot('invalidation-recall');
});

describe('a deliberate stale tier survives being read', () => {
  it('a recall through contextGet leaves an invalidated memory invalidated', async () => {
    const { id } = await remember(ctx(), { content: 'deploys go through the legacy pipeline' });

    const result = await invalidateMatching(
      sqliteStore(home),
      {
        from: 'legacy pipeline',
        to: null,
        type: 'deprecation',
      },
      'default',
    );
    expect(result.invalidated).toBe(1);

    const invalidated = readEntry(home, id)!;
    expect(invalidated.confidence).toBe('stale');
    expect(invalidated.tags).toContain('invalidated');

    await contextGet(ctx(), { currentProject: cwdProject(), q: 'legacy pipeline deploys', budget: 2000 });

    const afterRead = readEntry(home, id)!;
    expect(afterRead.retrievalCount).toBeGreaterThan(invalidated.retrievalCount);
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

    expect(updated.retrievalCount).toBe(entry.retrievalCount + 1);
    expect(updated.halfLifeDays).toBe(entry.halfLifeDays + 2);
    expect(new Date(updated.lastRetrieved).getTime()).toBeGreaterThan(new Date(entry.lastRetrieved).getTime() - 1);
  });

  it('leaves every other tier untouched, so the fix is not a blanket freeze', () => {
    for (const tier of ['verified', 'observed', 'inferred'] as const) {
      const entry = createMemory(`a ${tier} fact`, { confidence: tier });
      const [updated] = markRetrieved([entry]);
      expect(updated.confidence).toBe(tier);
    }
  });
});
