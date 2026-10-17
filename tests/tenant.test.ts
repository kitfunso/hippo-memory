import { describe, it, expect } from 'vitest';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { createApiKey } from '../src/store/auth.js';
import { resolveTenantId } from '../src/store/tenant.js';
import { makeRoot } from './_helpers/make-root.js';

describe('resolveTenantId', () => {
  it('returns "default" with no env, no api key', () => {
    delete process.env.HIPPO_TENANT;
    expect(resolveTenantId({})).toBe('default');
  });

  it.each([
    ['acme', 'acme'],
    ['', 'default'],
    ['   ', 'default'],
    ['  acme  ', 'acme'],
  ])('HIPPO_TENANT=%j resolves to %s', (env, expected) => {
    process.env.HIPPO_TENANT = env;
    try {
      expect(resolveTenantId({})).toBe(expected);
    } finally {
      delete process.env.HIPPO_TENANT;
    }
  });

  it('api key tenant beats env', () => {
    const home = makeRoot('tenant');
    const db = openHippoDb(home);
    process.env.HIPPO_TENANT = 'env_tenant';
    try {
      const { plaintext } = createApiKey(db, { tenantId: 'key_tenant' });
      expect(resolveTenantId({ db, apiKey: plaintext })).toBe('key_tenant');
    } finally {
      delete process.env.HIPPO_TENANT;
      closeHippoDb(db);
    }
  });

  it('invalid api key throws', () => {
    const home = makeRoot('tenant');
    const db = openHippoDb(home);
    try {
      expect(() => resolveTenantId({ db, apiKey: 'hk_bogus.x' })).toThrow(/invalid api key/i);
    } finally {
      closeHippoDb(db);
    }
  });
});
