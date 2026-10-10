/**
 * T3 test: docs/plans/2026-08-15-hardening-at1-followups.md
 *
 * Defect (perf hygiene, not correctness): consolidate.ts opened the shared
 * consolidateDb handle unconditionally on every non-dry-run sleep, even one
 * with zero auto-promote candidates and zero merge clusters. Fix: memoized
 * lazy getter, opened on first real use, closed in the finally only if it
 * was actually opened.
 *
 * Behavioral pin per the plan: no direct "db never opened" assertion (no
 * test-only counter exists to make that cheap, and the plan says not to
 * build observation machinery for a perf-hygiene rider) — instead, confirm
 * a no-op sleep still completes clean, and that a real merge-tombstone
 * scenario (the AT1 guard this handle exists for) still behaves identically
 * under the lazy getter.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { consolidate } from '../src/consolidate/sleep.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { insertRejectedValue, normalizeValueForRejection, rejectionDigest } from '../src/store/rejection.js';

function tmpHome(prefix: string = 'hippo-consolidate-lazy-db-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('consolidateDb lazy open', () => {
  it('a no-op sleep (no entries, no promotable sessions, no merge clusters) completes clean', async () => {
    const home = tmpHome();
    try {
      initStore(home);
      const result = await consolidate(home, { dryRun: false, now: new Date() });
      expect(result.merged).toBe(0);
      expect(result.semanticCreated).toBe(0);
      expect(result.promotedTraces).toBe(0);
      expect(loadAllEntries(home)).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a real merge cluster still opens the handle and the AT1 tombstone check still fires under the lazy getter', async () => {
    const home = tmpHome();
    try {
      initStore(home);
      writeFileSync(join(home, 'config.json'), JSON.stringify({ replay: { count: 0 } }), 'utf8');

      const shortText = 'renew the expiring vpn certificate before the weekend';
      const longText = 'renew the expiring vpn certificate before the weekend and alert the network team';
      const e1 = { ...createMemory(shortText, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic }), created: new Date(Date.now() - 60_000).toISOString() };
      const e2 = createMemory(longText, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic });
      writeEntry(home, e1);
      writeEntry(home, e2);

      const mergedContent = `[Consolidated from 2 related memories, newest first]\n\n- ${longText}\n- ${shortText}`;
      const mergedDigest = rejectionDigest(mergedContent);
      const db = openHippoDb(home);
      try {
        insertRejectedValue(db, {
          tenantId: 'default',
          digest: mergedDigest,
          reason: 'pre-rejected merge rollup (lazy-open regression pin)',
          rejectedBy: 'test',
          rejectedAt: new Date().toISOString(),
          normalizedChars: normalizeValueForRejection(mergedContent).length,
        });
      } finally {
        closeHippoDb(db);
      }

      const errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const result = await consolidate(home, { dryRun: false });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipped 1 merge(s) whose content matches a rejected value'),
      );
      errorSpy.mockRestore();

      expect(result.semanticCreated).toBe(0);
      const allAfter = loadAllEntries(home);
      expect(allAfter.some((e) => rejectionDigest(e.content) === mergedDigest)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('dry-run never opens the handle: no-op even when a merge cluster exists', async () => {
    const home = tmpHome();
    try {
      initStore(home);
      writeFileSync(join(home, 'config.json'), JSON.stringify({ replay: { count: 0 } }), 'utf8');

      const shortText = 'back up the primary database before the migration';
      const longText = 'back up the primary database before the migration and verify checksums';
      const e1 = createMemory(shortText, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic });
      const e2 = createMemory(longText, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic });
      writeEntry(home, e1);
      writeEntry(home, e2);

      const result = await consolidate(home, { dryRun: true });
      // Dry-run previews the merge without writing (lazyTombstoneChecks
      // answers null under a dry run before it ever calls openHippoDb).
      expect(result.dryRun).toBe(true);
      expect(loadAllEntries(home)).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
