import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey, validateApiKey, revokeApiKey, listApiKeys } from '../src/auth.js';

describe('auth', () => {
  it('createApiKey returns plaintext exactly once and stores hash', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-auth-'));
    const db = openHippoDb(home);
    try {
      const { keyId, plaintext } = createApiKey(db, { tenantId: 'default', label: 'cli' });
      expect(keyId).toMatch(/^hk_[a-z2-7]{24}$/);
      expect(plaintext).toMatch(/^hk_[a-z2-7]{24}\.[a-z2-7]+$/);
      // Stored row exists, hash != plaintext
      const row = db.prepare(`SELECT key_hash FROM api_keys WHERE key_id=?`).get(keyId) as { key_hash: string };
      expect(row.key_hash).not.toBe(plaintext);
      expect(row.key_hash.length).toBeGreaterThan(20);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('validateApiKey: positive returns tenant context', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-auth-'));
    const db = openHippoDb(home);
    try {
      const { plaintext } = createApiKey(db, { tenantId: 'default', label: 'test' });
      const ctx = validateApiKey(db, plaintext);
      expect(ctx).toEqual({ valid: true, tenantId: 'default', keyId: expect.stringMatching(/^hk_/) });
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('validateApiKey: rejects unknown plaintext', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-auth-'));
    const db = openHippoDb(home);
    try {
      const ctx = validateApiKey(db, 'hk_aaaaaaaaaaaaaaaaaaaaaaaa.deadbeef');
      expect(ctx.valid).toBe(false);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('revokeApiKey: revoked keys fail validation', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-auth-'));
    const db = openHippoDb(home);
    try {
      const { keyId, plaintext } = createApiKey(db, { tenantId: 'default' });
      revokeApiKey(db, keyId);
      const ctx = validateApiKey(db, plaintext);
      expect(ctx.valid).toBe(false);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('listApiKeys excludes revoked when active=true', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-auth-'));
    const db = openHippoDb(home);
    try {
      const a = createApiKey(db, { tenantId: 'default', label: 'a' });
      const b = createApiKey(db, { tenantId: 'default', label: 'b' });
      revokeApiKey(db, b.keyId);
      const active = listApiKeys(db, { active: true });
      expect(active.map(k => k.keyId)).toEqual([a.keyId]);
      const all = listApiKeys(db, { active: false });
      expect(all.length).toBe(2);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
