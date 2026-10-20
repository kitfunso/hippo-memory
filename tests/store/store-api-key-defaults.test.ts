import { beforeEach, describe, expect, it } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createApiKey, readApiKeyRecord } from '../../src/store/sqlite/auth.js';
import { DEFAULT_KEY_TTL_DAYS } from '../../src/base/scope/api-key.js';
import { makeRoot } from '../_helpers/make-root.js';

let home: string;
beforeEach(() => {
  home = makeRoot('key-defaults');
});

describe('store createApiKey defaults', () => {
  it('mints a member key that expires, matching the API layer', () => {
    const db = openHippoDb(home);
    try {
      const { keyId } = createApiKey(db, { tenantId: 'default' });
      const rec = readApiKeyRecord(db, keyId)!;
      expect(rec.role).toBe('member');
      const days = (Date.parse(rec.expiresAt!) - Date.now()) / 86_400_000;
      expect(Math.round(days)).toBe(DEFAULT_KEY_TTL_DAYS);
    } finally {
      closeHippoDb(db);
    }
  });

  it('still mints an admin key when asked', () => {
    const db = openHippoDb(home);
    try {
      const { keyId } = createApiKey(db, { tenantId: 'default', role: 'admin' });
      expect(readApiKeyRecord(db, keyId)!.role).toBe('admin');
    } finally {
      closeHippoDb(db);
    }
  });
});
