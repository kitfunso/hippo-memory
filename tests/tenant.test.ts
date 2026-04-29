import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
import { resolveTenantId } from '../src/tenant.js';

describe('resolveTenantId', () => {
  it('returns "default" with no env, no api key', () => {
    delete process.env.HIPPO_TENANT;
    expect(resolveTenantId({})).toBe('default');
  });

  it('returns env value when set', () => {
    process.env.HIPPO_TENANT = 'acme';
    try {
      expect(resolveTenantId({})).toBe('acme');
    } finally {
      delete process.env.HIPPO_TENANT;
    }
  });

  it('api key tenant beats env', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-tenant-'));
    const db = openHippoDb(home);
    process.env.HIPPO_TENANT = 'env_tenant';
    try {
      const { plaintext } = createApiKey(db, { tenantId: 'key_tenant' });
      expect(resolveTenantId({ db, apiKey: plaintext })).toBe('key_tenant');
    } finally {
      delete process.env.HIPPO_TENANT;
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('invalid api key throws', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-tenant-'));
    const db = openHippoDb(home);
    try {
      expect(() => resolveTenantId({ db, apiKey: 'hk_bogus.x' })).toThrow(/invalid api key/i);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
