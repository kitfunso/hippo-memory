// The delete core takes the tenant it acts for, so a caller that skipped its own reach check still cannot remove
// another tenant's row.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { deleteEntryCore } from '../../src/store/delete-and-batch.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { initStore } from '../../src/store/open.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';

let root: string;
let db: ReturnType<typeof openHippoDb>;
const entry = createMemory('tenant a keeps this', { tenantId: 'tenant-a' });

beforeEach(() => {
  root = makeRoot('delete-tenant');
  initStore(root);
  writeEntry(root, entry);
  db = openHippoDb(root);
});

afterEach(() => {
  closeHippoDb(db);
});

// SAFETY: COUNT(*) AS n always returns one row with a numeric n.
const held = (): number => Number((db.prepare('SELECT COUNT(*) AS n FROM memories WHERE id = ?').get(entry.id) as { n: number }).n);

it("leaves another tenant's row and answers as missing", () => {
  expect(deleteEntryCore(db, entry.id, 'tenant-b', { actor: 'test' })).toBeNull();
  expect(held()).toBe(1);
});

it("removes the row for its own tenant", () => {
  expect(deleteEntryCore(db, entry.id, 'tenant-a', { actor: 'test' })).toEqual({ tenantId: 'tenant-a', dagParentId: null });
  expect(held()).toBe(0);
});
