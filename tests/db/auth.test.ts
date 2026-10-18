import { describe, it, expect } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createApiKey, validateApiKey, revokeApiKey } from '../../src/store/sqlite/auth.js';
import { listApiKeys } from '../_helpers/root-forms.js';
import { makeRoot } from '../_helpers/make-root.js';

describe('auth', () => {
  it('createApiKey returns plaintext exactly once and stores hash', () => {
    const home = makeRoot('auth');
    const db = openHippoDb(home);
    try {
      const { keyId, plaintext } = createApiKey(db, { tenantId: 'default', label: 'cli' });
      expect(keyId).toMatch(/^hk_[a-z2-7]{24}$/);
      expect(plaintext).toMatch(/^hk_[a-z2-7]{24}\.[a-z2-7]+$/);
      // Stored row exists, hash != plaintext
      // SAFETY: db.prepare().get() is typed `unknown` (node:sqlite has no
      // generic overload); this SELECT names exactly one column (key_hash)
      // against the row created by createApiKey above, so the row shape is
      // guaranteed.
      const row = db.prepare(`SELECT key_hash FROM api_keys WHERE key_id=?`).get(keyId) as { key_hash: string };
      expect(row.key_hash).not.toBe(plaintext);
      expect(row.key_hash.length).toBeGreaterThan(20);
    } finally {
      closeHippoDb(db);
    }
  });

  it('validateApiKey: rejects unknown plaintext', () => {
    const home = makeRoot('auth');
    const db = openHippoDb(home);
    try {
      const ctx = validateApiKey(db, 'hk_aaaaaaaaaaaaaaaaaaaaaaaa.deadbeef');
      expect(ctx.valid).toBe(false);
    } finally {
      closeHippoDb(db);
    }
  });

  it('revokeApiKey: revoked keys fail validation', () => {
    const home = makeRoot('auth');
    const db = openHippoDb(home);
    try {
      const { keyId, plaintext } = createApiKey(db, { tenantId: 'default' });
      revokeApiKey(db, keyId);
      const ctx = validateApiKey(db, plaintext);
      expect(ctx.valid).toBe(false);
    } finally {
      closeHippoDb(db);
    }
  });

  it('listApiKeys excludes revoked when active=true', () => {
    const home = makeRoot('auth');
    const db = openHippoDb(home);
    try {
      const a = createApiKey(db, { tenantId: 'default', label: 'a' });
      const b = createApiKey(db, { tenantId: 'default', label: 'b' });
      revokeApiKey(db, b.keyId);
      const active = listApiKeys(home, { active: true });
      expect(active.map((k) => k.keyId)).toEqual([a.keyId]);
      const all = listApiKeys(home, { active: false });
      expect(all.length).toBe(2);
    } finally {
      closeHippoDb(db);
    }
  });
});
