import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { createApiKey, DEFAULT_KEY_TTL_DAYS, readApiKeyRecord } from '../src/store/auth.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hippo-key-defaults-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

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
