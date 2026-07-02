/**
 * Runtime test for v1.12.0 A5 v2 sub-1: migration v26 adds the `role` column
 * to `api_keys` with DEFAULT 'admin'. Existing keys backfill to 'admin'
 * (single-tenant operator = admin by definition). New keys created via
 * createApiKey get explicit 'admin' on the 6-column INSERT.
 *
 * Real-DB per project convention.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, getCurrentSchemaVersion, getSchemaVersion } from '../src/db.js';
import { createApiKey, validateApiKey } from '../src/auth.js';

describe('v1.12.0 migration v26: api_keys.role', () => {
  it('CURRENT_SCHEMA_VERSION is 26', () => {
    expect(getCurrentSchemaVersion()).toBe(39);
  });

  it('fresh DB has api_keys.role column with DEFAULT admin', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-v26-fresh-'));
    const db = openHippoDb(home);
    try {
      expect(getSchemaVersion(db)).toBe(39);
      const cols = db.prepare(`PRAGMA table_info(api_keys)`).all() as Array<{ name: string; type: string; dflt_value: string | null; notnull: number }>;
      const role = cols.find((c) => c.name === 'role');
      expect(role).toBeDefined();
      expect(role!.type).toBe('TEXT');
      expect(role!.notnull).toBe(1);
      expect(role!.dflt_value).toBe("'admin'");
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('createApiKey 6-column INSERT sets role=admin by default', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-v26-create-'));
    const db = openHippoDb(home);
    try {
      const { keyId, plaintext } = createApiKey(db, { tenantId: 'default', label: 'test-admin' });
      const result = validateApiKey(db, plaintext);
      expect(result).toEqual({
        valid: true,
        tenantId: 'default',
        keyId,
        role: 'admin',
      });
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('createApiKey with role=member surfaces role=member from validateApiKey', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-v26-member-'));
    const db = openHippoDb(home);
    try {
      const { plaintext } = createApiKey(db, {
        tenantId: 'default',
        label: 'test-member',
        role: 'member',
      });
      const result = validateApiKey(db, plaintext);
      expect(result.valid).toBe(true);
      expect(result.role).toBe('member');
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('legacy keys (inserted before migration via direct SQL) backfill to admin via DEFAULT', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-v26-legacy-'));
    const db = openHippoDb(home);
    try {
      // Simulate a legacy 5-column INSERT (what v1.11.x binaries would do).
      // The migration already ran so the column exists; DEFAULT 'admin' fills it.
      db.prepare(
        `INSERT INTO api_keys (key_id, key_hash, tenant_id, label, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run('hk_legacy_test', 'fake_hash_for_test', 'default', 'legacy', new Date().toISOString());
      const row = db.prepare(`SELECT role FROM api_keys WHERE key_id = ?`).get('hk_legacy_test') as { role: string };
      expect(row.role).toBe('admin');
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
