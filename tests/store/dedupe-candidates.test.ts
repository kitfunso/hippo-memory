// hippo dedupe reads only the rows that can be a copy, and pairs them as a read of every row does.
import { beforeEach, describe, expect, it } from 'vitest';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import { deduplicateStore } from '../../src/domain/consolidate/dedupe.js';
import { sqliteConsolidation } from '../../src/store/sqlite/consolidation.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeStore } from '../_helpers/make-root.js';
import { handlesOf } from '../../src/store/sqlite/handles.js';
import { loadEveryTenantEntries, writeEntriesTogether } from '../_helpers/root-forms.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';

const BASE = Date.parse('2026-05-01T00:00:00.000Z');

function row(content: string, minute: number, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const at = new Date(BASE + minute * 60_000).toISOString();
  return { ...createMemory(content, { tenantId: 'default' }), created: at, validFrom: at, lastRetrieved: at, ...extra };
}

describe('the spacing the candidates read takes out', () => {
  it('is every code point JavaScript reads as \\s, so each copy apart from spacing is found', () => {
    const root = makeStore('dedupe-spaces').root;
    const spaces: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) if (/\s/.test(String.fromCharCode(cp))) spaces.push(String.fromCharCode(cp));
    writeEntriesTogether(
      root,
      spaces.flatMap((space, i) => [row(`copy${i} a${space}b`, 2 * i), row(`copy${i} a b`, 2 * i + 1)]),
    );
    const { pairs } = deduplicateStore(sqliteConsolidation(handlesOf(root)), { dryRun: true });
    expect(pairs).toHaveLength(spaces.length);
    expect(spaces).toHaveLength(25);
  });
});

describe('deduplicateStore over the duplicate candidates', () => {
  let root: string;

  beforeEach(() => {
    root = makeStore('dedupe-candidates').root;
    writeEntriesTogether(root, [
      // Tenant acme first appears with a row that has no copy, so its pairs still come first.
      row('acme unique opener', 0, { tenantId: 'acme' }),
      row('shared  text here', 1),
      row('shared text here', 2, { strength: 0.9 }),
      row(' shared　text here ', 3),
      row('acme copy', 4, { tenantId: 'acme' }),
      row('acme\ncopy', 5, { tenantId: 'acme' }),
      // Equal with the spacing gone, but not apart from spacing: grouped by SQL, never paired.
      row('ab cd', 6),
      row('abcd', 7),
      row('private copy', 8, { scope: 'slack:private:c1' }),
      row('private copy', 9),
      row('raw copy', 10, { kind: 'raw' }),
      row('raw copy', 11),
      row('unique tail', 12),
    ]);
  });

  const store = () => sqliteConsolidation(handlesOf(root));

  it('finds the pairs, in the order, that a read of every row finds', () => {
    const candidates = deduplicateStore(store(), { dryRun: true });
    const everyRow = deduplicateStore(store(), { dryRun: true, pages: [loadEveryTenantEntries(root)] });
    expect(candidates).toEqual(everyRow);
    expect(candidates.pairs.map((p) => p.removedContent.includes('acme'))).toEqual([true, false, false]);
  });

  it('reads the same rows when the store holds five times more rows without a copy', () => {
    const before = recordStatements(() => deduplicateStore(store(), { dryRun: true }));
    writeEntriesTogether(
      root,
      Array.from({ length: 65 }, (_, i) => row(`filler without a copy ${i}`, 100 + i)),
    );
    const after = recordStatements(() => deduplicateStore(store(), { dryRun: true }));
    expect(after.rowsRead).toBe(before.rowsRead);
    expect(after.statements.length).toBe(before.statements.length);
    expect(after.result).toEqual(before.result);
  });

  it('deletes the copies in one transaction with a forget row for each', () => {
    const { result, statements } = recordStatements(() => deduplicateStore(store(), { actor: 'cli' }));
    expect(result.removed).toBe(3);
    expect(countMatching(statements, /^BEGIN IMMEDIATE/)).toBe(1);
    expect(countMatching(statements, /INSERT INTO audit_log/)).toBe(3);
    expect(deduplicateStore(store(), { dryRun: true }).pairs).toEqual([]);
  });
});
