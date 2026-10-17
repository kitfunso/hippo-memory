import { describe, it, expect, vi, afterEach } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createApiKey } from '../../src/store/auth.js';
import { resolveTenantId } from '../../src/store/tenant.js';
import { makeRoot } from '../_helpers/make-root.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveTenantId', () => {
  it('returns "default" with no env, no api key', () => {
    vi.stubEnv('HIPPO_TENANT', undefined);
    expect(resolveTenantId({})).toBe('default');
  });

  it.each([
    ['acme', 'acme'],
    ['', 'default'],
    ['   ', 'default'],
    ['  acme  ', 'acme'],
  ])('HIPPO_TENANT=%j resolves to %s', (env, expected) => {
    vi.stubEnv('HIPPO_TENANT', env);
    try {
      expect(resolveTenantId({})).toBe(expected);
    } finally {
      vi.stubEnv('HIPPO_TENANT', undefined);
    }
  });

  it('api key tenant beats env', () => {
    const home = makeRoot('tenant');
    const db = openHippoDb(home);
    vi.stubEnv('HIPPO_TENANT', 'env_tenant');
    try {
      const { plaintext } = createApiKey(db, { tenantId: 'key_tenant' });
      expect(resolveTenantId({ db, apiKey: plaintext })).toBe('key_tenant');
    } finally {
      vi.stubEnv('HIPPO_TENANT', undefined);
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
