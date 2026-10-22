// Recall strengthening updates the live row's four retrieval columns, never a stale copy, in one statement.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, writeEntriesTogether, strengthenRetrieved, readEntry } from '../_helpers/root-forms.js';
import { recordStatements } from '../_helpers/count-statements.js';
import { calculateStrength } from '../../src/base/memory/memory.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const roots: string[] = [];

function newRoot(): string {
  const root = makeRoot('strengthen');
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) removeAfterRequest(r);
});

describe('strengthenRetrieved', () => {
  it('keeps an edit made after the read and reports only the ids it found', () => {
    const root = newRoot();
    const e = createMemory('the deploy runs on fridays after the freeze');
    writeEntry(root, e);
    const returned = readEntry(root, e.id)!;
    writeEntry(root, { ...returned, tags: ['edited-meanwhile'] });

    const found = strengthenRetrieved(
      root,
      [e.id, 'no-such-id'],
      { tenantId: 'default', recallBoostAblated: false },
      {},
    );

    expect([...found]).toEqual([e.id]);
    const after = readEntry(root, e.id)!;
    expect(after.tags).toEqual(['edited-meanwhile']);
    expect(after.retrievalCount).toBe(returned.retrievalCount + 1);
    expect(after.halfLifeDays).toBe(returned.halfLifeDays + 2);
  });

  it('writes every row as markRetrieved scored it, through one statement text whatever the count', () => {
    const root = newRoot();
    const entries = Array.from({ length: 150 }, (_, i) => ({
      ...createMemory(`the queue drains batch ${i} before the deploy`),
      halfLifeDays: 1 + i / 7,
      lastRetrieved: new Date(Date.now() - i * 3_600_000 * 7).toISOString(),
    }));
    writeEntriesTogether(root, entries);
    const opts = { tenantId: 'default', recallBoostAblated: false };

    const runs = [entries.slice(0, 1), entries].map((batch) =>
      recordStatements(() =>
        strengthenRetrieved(
          root,
          batch.map((e) => e.id),
          opts,
          {},
        ),
      ),
    );

    const writes = runs.flatMap((r) => r.statements.filter((sql) => /UPDATE memories SET retrieval_count/.test(sql)));
    expect(writes).toHaveLength(2);
    expect(new Set(writes).size).toBe(1);
    expect(runs[1]!.result.size).toBe(150);
    for (const [i, e] of entries.entries()) {
      const after = readEntry(root, e.id)!;
      expect(after.retrievalCount).toBe(i === 0 ? 2 : 1);
      expect(after.halfLifeDays).toBe(e.halfLifeDays + (i === 0 ? 4 : 2));
      expect(after.strength).toBe(calculateStrength(after, new Date(after.lastRetrieved)));
    }
  });

  it('leaves a row in another tenant alone', () => {
    const root = newRoot();
    const e = createMemory('the staging cluster restarts every sunday');
    writeEntry(root, e);

    expect(
      strengthenRetrieved(root, [e.id], { tenantId: 'some-other-tenant', recallBoostAblated: false }, {}).size,
    ).toBe(0);
    expect(readEntry(root, e.id)!.retrievalCount).toBe(0);
  });

  it('changes nothing when the caller passes the recall-boost ablation switch', () => {
    const root = newRoot();
    const e = createMemory('the release train leaves on tuesdays');
    writeEntry(root, e);

    expect(strengthenRetrieved(root, [e.id], { tenantId: 'default', recallBoostAblated: true }, {}).size).toBe(0);
    expect(readEntry(root, e.id)!.retrievalCount).toBe(0);
  });

  it('logs one line and never throws when the store cannot be opened', () => {
    const notAStore = join(newRoot(), 'not-a-store');
    writeFileSync(notAStore, 'a plain file where the store should be');
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(
      strengthenRetrieved(notAStore, ['any-id'], { tenantId: 'default', recallBoostAblated: false }, {}).size,
    ).toBe(0);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]![0])).toMatch(/^\[hippo\] warn: retrieval stats not saved \(/);
  });
});
