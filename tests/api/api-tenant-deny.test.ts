import { describe, it, expect, beforeEach } from 'vitest';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { remember, forget, rawArchive } from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';

function selectRow<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T | undefined {
  // SAFETY: T is pinned by each call site to the exact column list of the
  // SQL SELECT text passed in; the driver's .get() (src/db/index.ts
  // DatabaseSyncLike, backed by node:sqlite) returns `unknown` and
  // `undefined` when no row matches, so this is the single place that
  // establishes the row contract for every caller in this file.
  return db.prepare(sql).get(...params) as T | undefined;
}

describe('api tenant deny - rawArchive and forget', () => {
  let home: string;

  beforeEach(() => {
    home = makeRoot('tenant-deny');
  });

  it('rawArchive refuses to archive a row that belongs to another tenant', async () => {
    const created = await remember(apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' }), {
      content: 'raw-row-from-alpha tenant-deny canary',
      kind: 'raw',
    });

    await expect(
      rawArchive(
        apiCtx(home, 'bravo', { subject: 'api_key:bravo-key', role: 'admin' }),
        created.id,
        'cross-tenant probe',
      ),
    ).rejects.toThrow(/memory not found/i);

    const db = openHippoDb(home);
    try {
      const row = selectRow<{ tenant_id: string; kind: string }>(
        db,
        `SELECT tenant_id, kind FROM memories WHERE id = ?`,
        created.id,
      );
      expect(row!.tenant_id).toBe('alpha');
      expect(row!.kind).toBe('raw');
    } finally {
      closeHippoDb(db);
    }
  });

  it('forget refuses to delete a row that belongs to another tenant', async () => {
    const created = await remember(apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' }), {
      content: 'distilled-row-from-alpha tenant-deny canary',
      kind: 'distilled',
    });

    await expect(
      forget(apiCtx(home, 'bravo', { subject: 'api_key:bravo-key', role: 'admin' }), created.id),
    ).rejects.toThrow(/memory not found/i);

    const db = openHippoDb(home);
    try {
      const row = selectRow<{ tenant_id: string }>(db, `SELECT tenant_id FROM memories WHERE id = ?`, created.id);
      expect(row!.tenant_id).toBe('alpha');
    } finally {
      closeHippoDb(db);
    }
  });

  it('forget still works for the owning tenant', async () => {
    const created = await remember(apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' }), {
      content: 'owning-tenant forget happy-path',
    });
    const result = await forget(apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' }), created.id);
    expect(result.ok).toBe(true);

    const db = openHippoDb(home);
    try {
      const row = selectRow<{ id?: string }>(db, `SELECT id FROM memories WHERE id = ?`, created.id);
      expect(row).toBeUndefined();
    } finally {
      closeHippoDb(db);
    }
  });
});
