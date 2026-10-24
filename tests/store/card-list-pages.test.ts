// The card list reads one keyset page per statement: pages join up to the old whole-list read, ties on updated_at
// break on id across a page edge, and no page hands back more than its limit plus the one-row lookahead.
import { describe, expect, it } from 'vitest';
import { keysetPages } from '../../src/api/pages.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { countMatching, peakRowsRead, recordStatementsAsync } from '../_helpers/count-statements.js';
import { makeStore } from '../_helpers/make-root.js';

const TENANT = 'default';
const PAGE_READ = /FROM cards WHERE .*LIMIT \?$/;

/** `n` cards, three to an updated_at, so most page edges fall inside a tie; one card of another tenant. */
function seed(root: string, n: number): string[] {
  const db = openHippoDb(root);
  try {
    db.prepare(
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
       INSERT INTO cards (id, title, status, created_at, updated_at, tenant_id)
       SELECT printf('card_%05d', i), 'card ' || i, CASE i % 2 WHEN 0 THEN 'ready' ELSE 'backlog' END,
         '2026-10-01T00:00:00.000Z', printf('2026-10-01T00:%02d:00.000Z', (i / 3) % 60), ? FROM k`,
    ).run(n, TENANT);
    db.prepare(
      `INSERT INTO cards (id, title, status, created_at, updated_at, tenant_id)
       VALUES ('card_other', 'other', 'ready', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 'acme')`,
    ).run();
    // SAFETY: the SELECT names one column, id.
    const rows = db
      .prepare(`SELECT id FROM cards WHERE tenant_id = ? ORDER BY updated_at DESC, id DESC`)
      .all(TENANT) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } finally {
    closeHippoDb(db);
  }
}

async function walk(root: string, limit: number, status?: 'ready') {
  const cards = sqliteStore(root).cards;
  return recordStatementsAsync(async () => {
    const ids: string[] = [];
    for await (const page of keysetPages((after) => cards.list(TENANT, { status, limit, after }))) {
      ids.push(...page.cards.map((c) => c.id));
    }
    return ids;
  });
}

describe('card list pages', () => {
  it.each([10, 1200])('walks %i cards in pages that join up to the whole list', async (n) => {
    const root = makeStore('card-pages').root;
    const whole = seed(root, n);
    const limit = 7;
    const { result, statements, reads } = await walk(root, limit);
    expect(result).toEqual(whole);
    expect(countMatching(statements, PAGE_READ)).toBe(Math.ceil(n / limit));
    expect(peakRowsRead(reads, PAGE_READ)).toBe(limit + 1);
  });

  it('pages one status in the same order the whole list keeps', async () => {
    const root = makeStore('card-pages-status').root;
    const whole = seed(root, 50);
    const sqlite = sqliteStore(root).cards;
    const ready = (await sqlite.list(TENANT, { status: 'ready', limit: 1000 })).cards.map((c) => c.id);
    expect((await walk(root, 4, 'ready')).result).toEqual(ready);
    expect(ready).toEqual(whole.filter((id) => Number(id.slice(5)) % 2 === 0));
  });

  it('reads one page of a 1,200-card board in one statement of limit plus one rows', async () => {
    const root = makeStore('card-pages-one').root;
    seed(root, 1200);
    const cards = sqliteStore(root).cards;
    const { result, statements, reads } = await recordStatementsAsync(() => cards.list(TENANT, { limit: 100 }));
    expect(result.cards).toHaveLength(100);
    expect(result.next).toEqual({ key: result.cards[99]!.updatedAt, id: result.cards[99]!.id });
    expect(countMatching(statements, PAGE_READ)).toBe(1);
    expect(peakRowsRead(reads, PAGE_READ)).toBe(101);
  });
});
