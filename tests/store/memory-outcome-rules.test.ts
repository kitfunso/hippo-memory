// memoryStore scores an outcome with the rules it was built with, as hippo.db does.
import { describe, expect, it } from 'vitest';
import { entryAfterOutcome } from '../../src/base/memory/memory.js';
import { memoryStore } from '../../src/entry/store-kit.js';
import { emptyTables } from '../../src/store/memory/tables.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';

const OLD = new Date(Date.now() - 3 * 86_400_000).toISOString();
const aged = () =>
  createMemory('the vendor invoice was wrong', {
    tenantId: 'acme',
    emotionalValence: 'negative',
    baseHalfLifeDays: 2,
  });
const stale = () => ({ ...aged(), createdAt: OLD, lastRetrieved: OLD });

async function strengthAfterOutcome(rules: { lossAversionRatio?: number }): Promise<number> {
  const entry = stale();
  const tables = emptyTables();
  tables.entries.set(entry.id, entry);
  const store = memoryStore(tables, rules);
  await store.entryWrites.applyOutcome({
    tenantId: 'acme',
    actor: 'cli',
    ownScope: null,
    role: 'admin',
    ids: [entry.id],
    good: false,
  });
  return tables.entries.get(entry.id)?.strength ?? Number.NaN;
}

describe('memoryStore applyOutcome', () => {
  it('applies the loss-aversion ratio the store was built with', async () => {
    const entry = stale();
    const rules = { lossAversionRatio: 2 };
    const expected = entryAfterOutcome(entry, false, rules).strength;
    expect(expected).not.toBe(entryAfterOutcome(entry, false).strength);
    expect(await strengthAfterOutcome(rules)).toBeCloseTo(expected, 2);
  });
});
