// hippo dedupe reads only the rows that can be a copy, and pairs them as a read of every row does.
import { beforeEach, describe, expect, it } from 'vitest';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { deduplicateStore } from '../../src/domain/consolidate/dedupe.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeStore } from '../_helpers/make-root.js';
import { loadEveryTenantEntries, writeEntriesTogether } from '../_helpers/root-forms.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { duplicateKey } from '../../src/base/util/same-text.js';
import { countMatching, recordStatementsAsync } from '../_helpers/count-statements.js';

const BASE = Date.parse('2026-05-01T00:00:00.000Z');

function row(content: string, minute: number, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const at = new Date(BASE + minute * 60_000).toISOString();
  return { ...createMemory(content, { tenantId: 'default' }), created: at, validFrom: at, lastRetrieved: at, ...extra };
}

describe('the spacing the candidates read takes out', () => {
  it('is every code point JavaScript reads as \\s, so each copy apart from spacing is found', async () => {
    const root = makeStore('dedupe-spaces').root;
    const spaces: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) if (/\s/.test(String.fromCharCode(cp))) spaces.push(String.fromCharCode(cp));
    writeEntriesTogether(
      root,
      spaces.flatMap((space, i) => [row(`copy${i} a${space}b`, 2 * i), row(`copy${i} a b`, 2 * i + 1)]),
    );
    const { pairs } = await deduplicateStore(sqliteStore(root), { dryRun: true });
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

  const store = () => sqliteStore(root);

  it('finds the pairs, in the order, that a read of every row finds', async () => {
    const candidates = await deduplicateStore(store(), { dryRun: true });
    const everyRow = await deduplicateStore(store(), { dryRun: true, pages: [loadEveryTenantEntries(root)] });
    expect(candidates).toEqual(everyRow);
    expect(candidates.pairs.map((p) => p.removedContent.includes('acme'))).toEqual([true, false, false]);
  });

  it('reads the same rows when the store holds five times more rows without a copy', async () => {
    const before = await recordStatementsAsync(() => deduplicateStore(store(), { dryRun: true }));
    writeEntriesTogether(
      root,
      Array.from({ length: 65 }, (_, i) => row(`filler without a copy ${i}`, 100 + i)),
    );
    const after = await recordStatementsAsync(() => deduplicateStore(store(), { dryRun: true }));
    expect(after.rowsRead).toBe(before.rowsRead);
    expect(after.statements.length).toBe(before.statements.length);
    expect(after.result).toEqual(before.result);
  });

  it('deletes the copies in one transaction with a forget row for each', async () => {
    const { result, statements } = await recordStatementsAsync(() => deduplicateStore(store(), { actor: 'cli' }));
    expect(result.removed).toBe(3);
    expect(countMatching(statements, /^BEGIN IMMEDIATE/)).toBe(1);
    expect(countMatching(statements, /INSERT INTO audit_log/)).toBe(3);
    expect((await deduplicateStore(store(), { dryRun: true })).pairs).toEqual([]);
  });
});

describe('deduplicateStore over rows with a lead-in', () => {
  const L1 = 'user: Is the flight booked?';
  const L2 = 'user: Did Mel get the job?';
  let root: string;

  beforeEach(() => {
    root = makeStore('dedupe-lead-in').root;
  });

  const pairsOf = async () => (await deduplicateStore(sqliteStore(root), { dryRun: true })).pairs;

  it('keeps two rows with the same text and different lead-ins, and the bare row beside them', async () => {
    writeEntriesTogether(root, [row('Yes.', 0, { leadIn: L1 }), row('Yes.', 1, { leadIn: L2 }), row('Yes.', 2)]);
    expect(await pairsOf()).toEqual([]);
    expect((await deduplicateStore(sqliteStore(root), { actor: 'cli' })).removed).toBe(0);
    expect(loadEveryTenantEntries(root)).toHaveLength(3);
  });

  it('folds two rows with equal text and equal lead-in, spacing apart, into one', async () => {
    writeEntriesTogether(root, [
      row('Yes.', 0, { leadIn: L1 }),
      row('Yes.\n', 1, { leadIn: `  ${L1.replace(/ /g, '   ')} ` }),
      row('Yes.', 2, { leadIn: L2 }),
    ]);
    expect(await pairsOf()).toHaveLength(1);
    expect((await deduplicateStore(sqliteStore(root), { actor: 'cli' })).removed).toBe(1);
    const left = loadEveryTenantEntries(root).map((e) => duplicateKey(e.leadIn ?? ''));
    expect(left.sort()).toEqual([L2, L1]);
  });

  it('groups rows an older binary left with no stored hash by the same identity', async () => {
    writeEntriesTogether(root, [
      row('Yes.', 0, { leadIn: L1 }),
      row('Yes.', 1, { leadIn: L2 }),
      row('Yes.', 2, { leadIn: L1 }),
    ]);
    const db = openHippoDb(root);
    try {
      db.exec('UPDATE memories SET duplicate_hash = NULL');
    } finally {
      closeHippoDb(db);
    }
    const pairs = await pairsOf();
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.kept).not.toBe(pairs[0]!.removed);
  });
});
