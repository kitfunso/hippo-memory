/**
 * Sleep must never try to delete a raw receipt.
 *
 * kind='raw' rows (Slack / GitHub connector messages, `hippo import --vault`
 * notes) are append-only: a BEFORE DELETE trigger aborts any DELETE, and
 * archiveRawMemory is the only sanctioned removal path. Two sleep phases used
 * to issue a plain DELETE for them, which aborted the whole sleep and every
 * later one:
 *   - the consolidate decay pass, once a receipt faded below the threshold
 *     (about 30 days unrecalled at the default 7-day half-life);
 *   - the quality audit, for any receipt shorter than 10 characters ("lgtm"),
 *     which sleep-never-deletes-raw-or-pinned.test.ts pins through api.sleep.
 * Real SQLite throughout, no mocks.
 */
import { describe, it, expect } from 'vitest';
import { writeEntry } from '../../src/store/entry-writes.js';
import { loadAllEntries } from '../../src/store/entry-reads.js';
import { deleteEntry } from '../../src/store/delete-and-batch.js';
import { RawAppendOnlyError } from '../../src/core/raw-append-only.js';
import { consolidate } from '../../src/index.js';
import { Layer, type MemoryEntry } from '../../src/core/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';

/** Sleep and decay here run on the pre-1.46 7-day base, so memories fade within the test's horizon. */
const createMemory7 = (content: string, options: Parameters<typeof createMemory>[1] = {}) => createMemory(content, { baseHalfLifeDays: 7, ...options });

const DAY_MS = 24 * 60 * 60 * 1000;

// Replay off keeps the decay assertions deterministic (replay re-strengthens a random sample of survivors).
// Dormant off: these tests pin the delete path (tests/store/dormant-memories.test.ts covers the dormant default).
const RAW_CONFIG = { replay: { count: 0 }, dormant: { enabled: false } };

function aged(entry: MemoryEntry, days: number): MemoryEntry {
  const then = new Date(Date.now() - days * DAY_MS).toISOString();
  return { ...entry, created: then, last_retrieved: then };
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
    const receipt = aged(createMemory7('slack receipt: prod deploy failed on the stale cache', { layer: Layer.Episodic, kind: 'raw' }), 90);
    const faded = aged(createMemory7('an ordinary observation about the build cache nobody recalled', { layer: Layer.Episodic }), 90);
    writeEntry(home, receipt);
    writeEntry(home, faded);

    const result = await consolidate(home, { now: new Date() });

    const ids = loadAllEntries(home, 'default').map((e) => e.id);
    expect(ids).toContain(receipt.id);
    // The ordinary faded memory is still removed: the batch committed.
    expect(ids).not.toContain(faded.id);
    expect(result.removed).toBe(1);
  });

  it('a faded raw receipt no longer aborts consolidate with the learned memory-value rescue on', async () => {
    const home = makeRoot('raw-decay-mv', { config: { replay: { count: 0 }, memoryValue: { enabled: true } } });
    const receipt = aged(createMemory7('github receipt: issue about the flaky integration suite', { layer: Layer.Episodic, kind: 'raw' }), 90);
    writeEntry(home, receipt);
    for (let i = 0; i < 12; i++) {
      writeEntry(home, aged(createMemory7(`faded observation number ${i} about module ${i} internals`, { layer: Layer.Episodic }), 90));
    }

    await consolidate(home, { now: new Date() });

    expect(loadAllEntries(home, 'default').map((e) => e.id)).toContain(receipt.id);
  });

});
