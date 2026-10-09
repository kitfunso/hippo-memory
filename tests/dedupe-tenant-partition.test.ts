/**
 * Tenant partition for `deduplicateStore`
 * (docs/plans/2026-08-15-dedupe-tenant-partition.md).
 *
 * Pins that a duplicate pair can never form across tenants. Before this fix
 * `deduplicateStore` loaded all entries host-wide and ran one global sort +
 * pair loop, so a stronger tenant-A row could absorb a byte-identical
 * tenant-B row and delete it: cross-tenant data loss. The fix groups entries
 * by tenantId (Map insertion order) before the sort, mirroring
 * consolidate.ts's mergeCandidatesByTenant and dag.ts's unparentedByTenant,
 * then runs the existing v1.26.3 survivor total order within each group.
 *
 * tests/dedupe-survivor-determinism.test.ts stays the single-tenant pin for
 * the total order itself; this file is the tenant-partition regression
 * suite, kept separate so the total-order pin file does not grow multi-
 * tenant setup it does not otherwise need.
 *
 * Real-DB per project convention: each test isolates a fresh hippoRoot via
 * mkdtempSync + initStore, following the tmpHome idiom in
 * tests/dedupe-survivor-determinism.test.ts and tests/api-sleep.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { remember, type HippoDbContext } from '../src/api/index.js';
import { deduplicateStore, type DedupPair } from '../src/consolidate/dedupe.js';

function tmpHome(prefix: string) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  initStore(home);
  return {
    home,
    restore: () => rmSync(home, { recursive: true, force: true }),
  };
}

function ctxFor(home: string, tenantId: string): HippoDbContext {
  return { hippoRoot: home, tenantId, actor: { subject: 'test', role: 'admin' } };
}

function setStrength(home: string, id: string, strength: number): void {
  const db = openHippoDb(home);
  try {
    db.prepare(`UPDATE memories SET strength = ? WHERE id = ?`).run(strength, id);
  } finally {
    closeHippoDb(db);
  }
}

// Same probe pair as tests/dedupe-survivor-determinism.test.ts: one sentence,
// B with a double space, so the two differ in bytes but match apart from spacing.
const CONTENT_A =
  'The quarterly finance report shows revenue grew steadily across all four regions this year';
const CONTENT_B = CONTENT_A.replace(' this year', '  this year');

// Byte-identical content used across two tenants for the zero-removal case.
const SHARED_CONTENT =
  'This exact sentence is shared by two different tenants in the store on purpose';

describe('deduplicateStore tenant partition', () => {
  it('(a) byte-identical content in tenant-a and tenant-b removes nothing; both rows survive', () => {
    const { home, restore } = tmpHome('hippo-dedupe-tenant-a-');
    try {
      const a = remember(ctxFor(home, 'tenant-a'), { content: SHARED_CONTENT });
      const b = remember(ctxFor(home, 'tenant-b'), { content: SHARED_CONTENT });

      const result = deduplicateStore(home);

      expect(result.removed).toBe(0);
      expect(result.pairs).toEqual([]);

      const all = loadAllEntries(home);
      expect(all.length).toBe(2);
      const tenantAEntries = loadAllEntries(home, 'tenant-a');
      const tenantBEntries = loadAllEntries(home, 'tenant-b');
      expect(tenantAEntries.map((e) => e.id)).toEqual([a.id]);
      expect(tenantBEntries.map((e) => e.id)).toEqual([b.id]);
    } finally {
      restore();
    }
  });

  it('(b) duplicates within EACH of two tenants: exactly one removal per tenant, survivor per the total order in each', () => {
    const { home, restore } = tmpHome('hippo-dedupe-tenant-b-');
    try {
      // tenant-a: CONTENT_A weak, CONTENT_B strong -> CONTENT_B survives.
      const aWeak = remember(ctxFor(home, 'tenant-a'), { content: CONTENT_A });
      const aStrong = remember(ctxFor(home, 'tenant-a'), { content: CONTENT_B });
      setStrength(home, aWeak.id, 0.5);
      setStrength(home, aStrong.id, 1.0);

      // tenant-b: CONTENT_B weak, CONTENT_A strong -> CONTENT_A survives.
      // Deliberately the mirror image of tenant-a's pair, so a leaked
      // cross-tenant comparison (all four rows are pairwise duplicates)
      // would produce a different removal count and different survivors
      // than the per-tenant-correct result asserted below.
      const bWeak = remember(ctxFor(home, 'tenant-b'), { content: CONTENT_B });
      const bStrong = remember(ctxFor(home, 'tenant-b'), { content: CONTENT_A });
      setStrength(home, bWeak.id, 0.5);
      setStrength(home, bStrong.id, 1.0);

      const result = deduplicateStore(home);

      expect(result.removed).toBe(2);
      expect(result.pairs.length).toBe(2);

      const tenantAPair = result.pairs.find((p) => p.removed === aWeak.id);
      expect(tenantAPair).toBeDefined();
      expect(tenantAPair?.kept).toBe(aStrong.id);
      expect(tenantAPair?.keptContent).toBe(CONTENT_B);

      const tenantBPair = result.pairs.find((p) => p.removed === bWeak.id);
      expect(tenantBPair).toBeDefined();
      expect(tenantBPair?.kept).toBe(bStrong.id);
      expect(tenantBPair?.keptContent).toBe(CONTENT_A);

      const tenantAEntries = loadAllEntries(home, 'tenant-a');
      expect(tenantAEntries.map((e) => e.id)).toEqual([aStrong.id]);
      const tenantBEntries = loadAllEntries(home, 'tenant-b');
      expect(tenantBEntries.map((e) => e.id)).toEqual([bStrong.id]);
    } finally {
      restore();
    }
  });

  it('(c) dryRun parity: two-tenant dryRun pairs equal what a subsequent real run deletes', () => {
    const { home, restore } = tmpHome('hippo-dedupe-tenant-c-');
    try {
      const aWeak = remember(ctxFor(home, 'tenant-a'), { content: CONTENT_A });
      const aStrong = remember(ctxFor(home, 'tenant-a'), { content: CONTENT_B });
      setStrength(home, aWeak.id, 0.5);
      setStrength(home, aStrong.id, 1.0);

      const bWeak = remember(ctxFor(home, 'tenant-b'), { content: CONTENT_B });
      const bStrong = remember(ctxFor(home, 'tenant-b'), { content: CONTENT_A });
      setStrength(home, bWeak.id, 0.5);
      setStrength(home, bStrong.id, 1.0);

      const dry = deduplicateStore(home, { dryRun: true });
      const real = deduplicateStore(home, { dryRun: false });

      expect(dry.removed).toBe(2);
      expect(real.removed).toBe(2);

      const sortByRemoved = (p: DedupPair[]) =>
        [...p].sort((x, y) => x.removed.localeCompare(y.removed));
      expect(sortByRemoved(dry.pairs).map((p) => p.removed)).toEqual(
        sortByRemoved(real.pairs).map((p) => p.removed),
      );
      expect(sortByRemoved(dry.pairs).map((p) => p.removedContent)).toEqual(
        sortByRemoved(real.pairs).map((p) => p.removedContent),
      );
      expect(sortByRemoved(dry.pairs).map((p) => p.keptContent)).toEqual(
        sortByRemoved(real.pairs).map((p) => p.keptContent),
      );

      const tenantAEntries = loadAllEntries(home, 'tenant-a');
      expect(tenantAEntries.map((e) => e.id)).toEqual([aStrong.id]);
      const tenantBEntries = loadAllEntries(home, 'tenant-b');
      expect(tenantBEntries.map((e) => e.id)).toEqual([bStrong.id]);
    } finally {
      restore();
    }
  });
});
