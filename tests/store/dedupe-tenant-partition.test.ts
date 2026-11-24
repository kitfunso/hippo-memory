import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { remember } from '../../src/api/index.js';
import { deduplicateStore, type DedupPair } from '../../src/domain/consolidate/dedupe.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadEveryTenantEntries, loadAllEntries } from '../_helpers/root-forms.js';

function ctxFor(home: string, tenantId: string): FullContext {
  return apiCtx(home, tenantId, { subject: 'test', role: 'admin' });
}

function setStrength(home: string, id: string, strength: number): void {
  const db = openHippoDb(home);
  try {
    db.prepare(`UPDATE memories SET strength = ? WHERE id = ?`).run(strength, id);
  } finally {
    closeHippoDb(db);
  }
}

const CONTENT_A = 'The quarterly finance report shows revenue grew steadily across all four regions this year';
const CONTENT_B = CONTENT_A.replace(' this year', '  this year');

const SHARED_CONTENT = 'This exact sentence is shared by two different tenants in the store on purpose';

describe('deduplicateStore tenant partition', () => {
  it('(a) byte-identical content in tenant-a and tenant-b removes nothing; both rows survive', async () => {
    const home = makeRoot('dedupe-tenant-a');
    const a = await remember(ctxFor(home, 'tenant-a'), { content: SHARED_CONTENT });
    const b = await remember(ctxFor(home, 'tenant-b'), { content: SHARED_CONTENT });

    const result = await deduplicateStore(sqliteStore(home));

    expect(result.removed).toBe(0);
    expect(result.pairs).toEqual([]);

    const all = loadEveryTenantEntries(home);
    expect(all.length).toBe(2);
    const tenantAEntries = loadAllEntries(home, 'tenant-a');
    const tenantBEntries = loadAllEntries(home, 'tenant-b');
    expect(tenantAEntries.map((e) => e.id)).toEqual([a.id]);
    expect(tenantBEntries.map((e) => e.id)).toEqual([b.id]);
  });

  it('(b) duplicates within EACH of two tenants: exactly one removal per tenant, survivor per the total order in each', async () => {
    const home = makeRoot('dedupe-tenant-b');
    const aWeak = await remember(ctxFor(home, 'tenant-a'), { content: CONTENT_A });
    const aStrong = await remember(ctxFor(home, 'tenant-a'), { content: CONTENT_B });
    setStrength(home, aWeak.id, 0.5);
    setStrength(home, aStrong.id, 1.0);

    const bWeak = await remember(ctxFor(home, 'tenant-b'), { content: CONTENT_B });
    const bStrong = await remember(ctxFor(home, 'tenant-b'), { content: CONTENT_A });
    setStrength(home, bWeak.id, 0.5);
    setStrength(home, bStrong.id, 1.0);

    const result = await deduplicateStore(sqliteStore(home));

    expect(result.removed).toBe(2);
    expect(result.pairs.length).toBe(2);

    const tenantAPair = result.pairs.find((p) => p.removed === aWeak.id);
    expect(tenantAPair?.kept).toBe(aStrong.id);
    expect(tenantAPair?.keptContent).toBe(CONTENT_B);

    const tenantBPair = result.pairs.find((p) => p.removed === bWeak.id);
    expect(tenantBPair?.kept).toBe(bStrong.id);
    expect(tenantBPair?.keptContent).toBe(CONTENT_A);

    const tenantAEntries = loadAllEntries(home, 'tenant-a');
    expect(tenantAEntries.map((e) => e.id)).toEqual([aStrong.id]);
    const tenantBEntries = loadAllEntries(home, 'tenant-b');
    expect(tenantBEntries.map((e) => e.id)).toEqual([bStrong.id]);
  });

  it('(c) dryRun parity: two-tenant dryRun pairs equal what a subsequent real run deletes', async () => {
    const home = makeRoot('dedupe-tenant-c');
    const aWeak = await remember(ctxFor(home, 'tenant-a'), { content: CONTENT_A });
    const aStrong = await remember(ctxFor(home, 'tenant-a'), { content: CONTENT_B });
    setStrength(home, aWeak.id, 0.5);
    setStrength(home, aStrong.id, 1.0);

    const bWeak = await remember(ctxFor(home, 'tenant-b'), { content: CONTENT_B });
    const bStrong = await remember(ctxFor(home, 'tenant-b'), { content: CONTENT_A });
    setStrength(home, bWeak.id, 0.5);
    setStrength(home, bStrong.id, 1.0);

    const dry = await deduplicateStore(sqliteStore(home), { dryRun: true });
    const real = await deduplicateStore(sqliteStore(home), { dryRun: false });

    expect(dry.removed).toBe(2);
    expect(real.removed).toBe(2);

    const sortByRemoved = (p: DedupPair[]) => [...p].sort((x, y) => x.removed.localeCompare(y.removed));
    expect(sortByRemoved(dry.pairs).map((p) => p.removed)).toEqual(sortByRemoved(real.pairs).map((p) => p.removed));
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
  });
});
