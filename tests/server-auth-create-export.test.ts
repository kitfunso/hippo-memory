import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authCreate, type HippoDbContext } from '../src/server.js';
import { validateApiKey } from '../src/auth.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

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
});
