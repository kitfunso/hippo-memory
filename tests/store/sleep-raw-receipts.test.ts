import { describe, it, expect } from 'vitest';
import { RawAppendOnlyError } from '../../src/base/errors/raw-append-only.js';
import { consolidate } from '../../src/index.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { deleteEntry, writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { FIXED_NOW, pinClock } from '../_helpers/fixed-clock.js';
import { DAY_MS } from '../../src/base/util/time.js';

pinClock();

const createMemory7 = (content: string, options: Parameters<typeof createMemory>[1] = {}) =>
  createMemory(content, { baseHalfLifeDays: 7, ...options });

const RAW_CONFIG = { replay: { count: 0 }, dormant: { enabled: false } };

function aged(entry: MemoryEntry, days: number): MemoryEntry {
  const then = new Date(Date.now() - days * DAY_MS).toISOString();
  return { ...entry, created: then, lastRetrieved: then };
}

describe('deleting a raw row', () => {
  it('throws RawAppendOnlyError carrying the SQLite abort as its cause', () => {
    const home = makeRoot('raw-delete', { config: RAW_CONFIG });
    const receipt = createMemory7('slack receipt: deploy log', { layer: Layer.Episodic, kind: 'raw' });
    writeEntry(home, receipt);
    let caught: unknown;
    try {
      deleteEntry(home, receipt.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RawAppendOnlyError);
    expect(caught).toMatchObject({ message: 'raw is append-only', cause: expect.any(Error) });
    expect(String(caught)).toBe('Error: raw is append-only');
  });
});

describe('sleep keeps raw receipts instead of aborting on the append-only trigger', () => {
  it('a faded raw receipt no longer aborts consolidate, and the rest of the cycle still commits', async () => {
    const home = makeRoot('raw-decay', { config: RAW_CONFIG });
    const receipt = aged(
      createMemory7('slack receipt: prod deploy failed on the stale cache', { layer: Layer.Episodic, kind: 'raw' }),
      90,
    );
    const faded = aged(
      createMemory7('an ordinary observation about the build cache nobody recalled', { layer: Layer.Episodic }),
      90,
    );
    writeEntry(home, receipt);
    writeEntry(home, faded);

    const result = await consolidate(home, { now: FIXED_NOW });

    const ids = loadAllEntries(home, 'default').map((e) => e.id);
    expect(ids).toContain(receipt.id);
    expect(ids).not.toContain(faded.id);
    expect(result.removed).toBe(1);
  });

  it('a faded raw receipt no longer aborts consolidate with the learned memory-value rescue on', async () => {
    const home = makeRoot('raw-decay-mv', { config: { replay: { count: 0 }, memoryValue: { enabled: true } } });
    const receipt = aged(
      createMemory7('github receipt: issue about the flaky integration suite', { layer: Layer.Episodic, kind: 'raw' }),
      90,
    );
    writeEntry(home, receipt);
    for (let i = 0; i < 12; i++) {
      writeEntry(
        home,
        aged(createMemory7(`faded observation number ${i} about module ${i} internals`, { layer: Layer.Episodic }), 90),
      );
    }

    await consolidate(home, { now: FIXED_NOW });

    expect(loadAllEntries(home, 'default').map((e) => e.id)).toContain(receipt.id);
  });
});
