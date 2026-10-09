import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authCreate, sqliteStore, StoreBusyError, type HippoDbContext, type HippoStore } from '../src/server.js';
import { validateApiKey } from '../src/store/auth.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { recordStatements } from './_helpers/count-statements.js';

// hippo-enterprise's `key create --store` mints through this subpath export.
describe('hippo-memory/server exports authCreate', () => {
  it('mints a key into the named store for the given tenant and role', () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-server-auth-create-'));
    try {
      const ctx: HippoDbContext = { hippoRoot: root, tenantId: 'acme', actor: { subject: 'addon:install', role: 'admin', hostAdmin: true } };
      const minted = authCreate(ctx, { label: 'first-admin', role: 'admin' });
      expect(minted.tenantId).toBe('acme');
      expect(minted.role).toBe('admin');
      const db = openHippoDb(root);
      try {
        expect(validateApiKey(db, minted.plaintext)).toMatchObject({ valid: true, tenantId: 'acme', role: 'admin' });
      } finally {
        closeHippoDb(db);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds a sqlite store for no folder without opening a database, which is how the add-on probes for keyWrites', () => {
    const built = recordStatements((): HippoStore => sqliteStore(''));
    expect(built.result.keyWrites?.createApiKey).toBeTypeOf('function');
    expect(built.statements).toEqual([]);
  });

  it('builds a StoreBusyError from no message and a cause, which is how the add-on wraps a driver error', () => {
    const cause = new Error('lock timeout');
    const busy = new StoreBusyError(undefined, { cause });
    expect(busy.cause).toBe(cause);
    expect(busy.message).toMatch(/^store busy/);
  });
});
