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
 *   - the quality audit, for any receipt shorter than 10 characters ("lgtm").
 * Real SQLite throughout, no mocks.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { consolidate } from '../src/consolidate/sleep.js';
import { Layer, type MemoryEntry } from '../src/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { auditMemory } from '../src/store/audit.js';
import * as api from '../src/api.js';

/** Sleep and decay here run on the pre-1.46 7-day base, so memories fade within the test's horizon. */
const createMemory7 = (content: string, options: Parameters<typeof createMemory>[1] = {}) => createMemory(content, { baseHalfLifeDays: 7, ...options });

const DAY_MS = 24 * 60 * 60 * 1000;

function tmpHome(prefix: string, config?: string) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  initStore(home);
  // Replay off keeps the decay assertions deterministic (replay re-strengthens
  // a random sample of survivors). Dormant off: these tests pin the delete
  // path (tests/dormant-memories.test.ts covers the dormant default).
  writeFileSync(join(home, 'config.json'), config ?? JSON.stringify({ replay: { count: 0 }, dormant: { enabled: false } }), 'utf8');
  return { home, restore: () => rmSync(home, { recursive: true, force: true }) };
}

function aged(entry: MemoryEntry, days: number): MemoryEntry {
  const then = new Date(Date.now() - days * DAY_MS).toISOString();
  return { ...entry, created: then, last_retrieved: then };
}

function ctxFor(home: string): api.Context {
  return { hippoRoot: home, tenantId: 'default', actor: { subject: 'test', role: 'admin' } };
}

describe('sleep keeps raw receipts instead of aborting on the append-only trigger', () => {
  it('a faded raw receipt no longer aborts consolidate, and the rest of the cycle still commits', async () => {
    const { home, restore } = tmpHome('hippo-raw-decay-');
    try {
      const receipt = aged(createMemory7('slack receipt: prod deploy failed on the stale cache', { layer: Layer.Episodic, kind: 'raw' }), 90);
      const faded = aged(createMemory7('an ordinary observation about the build cache nobody recalled', { layer: Layer.Episodic }), 90);
      writeEntry(home, receipt);
      writeEntry(home, faded);

      const result = await consolidate(home, { now: new Date() });

      const ids = loadAllEntries(home).map((e) => e.id);
      expect(ids).toContain(receipt.id);
      // The ordinary faded memory is still removed: the batch committed.
      expect(ids).not.toContain(faded.id);
      expect(result.removed).toBe(1);
    } finally {
      restore();
    }
  });

  it('a faded raw receipt no longer aborts consolidate with the learned memory-value rescue on', async () => {
    const { home, restore } = tmpHome(
      'hippo-raw-decay-mv-',
      JSON.stringify({ replay: { count: 0 }, memoryValue: { enabled: true } }),
    );
    try {
      const receipt = aged(createMemory7('github receipt: issue about the flaky integration suite', { layer: Layer.Episodic, kind: 'raw' }), 90);
      writeEntry(home, receipt);
      for (let i = 0; i < 12; i++) {
        writeEntry(home, aged(createMemory7(`faded observation number ${i} about module ${i} internals`, { layer: Layer.Episodic }), 90));
      }

      await consolidate(home, { now: new Date() });

      expect(loadAllEntries(home).map((e) => e.id)).toContain(receipt.id);
    } finally {
      restore();
    }
  });

  it('a short raw receipt no longer aborts api.sleep at the quality audit', async () => {
    const { home, restore } = tmpHome('hippo-raw-audit-');
    try {
      const receipt = createMemory7('lgtm', { layer: Layer.Episodic, kind: 'raw' });
      const junk = createMemory7('wip fix', { layer: Layer.Episodic });
      writeEntry(home, receipt);
      writeEntry(home, junk);

      const result = await api.sleep(ctxFor(home), { noShare: true });

      const ids = loadAllEntries(home).map((e) => e.id);
      expect(ids).toContain(receipt.id);
      // Ordinary junk is still cleaned up; only the receipt is exempt.
      expect(ids).not.toContain(junk.id);
      expect(result.audit?.errorsRemoved).toBe(1);
    } finally {
      restore();
    }
  });

  it('the quality audit never marks a raw receipt for removal, so `hippo audit --fix` cannot hit the trigger either', () => {
    const receipt = createMemory7('lgtm', { layer: Layer.Episodic, kind: 'raw' });
    const junk = createMemory7('wip fix', { layer: Layer.Episodic });
    expect(auditMemory(receipt)?.severity).not.toBe('error');
    expect(auditMemory(junk)?.severity).toBe('error');
  });
});
