import { describe, it, expect } from 'vitest';
import {
  NotImplementedError,
  ssoLogin,
  scimProvisionUser,
  scimDeprovisionUser,
} from '../src/sso.js';

describe('SSO/SCIM hook stubs', () => {
  it('ssoLogin throws NotImplementedError mentioning v2', () => {
    expect(() => ssoLogin({ provider: 'oidc', token: 'tok' })).toThrow(NotImplementedError);
    try {
      ssoLogin({ provider: 'saml', token: 'tok' });
    } catch (err) {
      expect(err).toBeInstanceOf(NotImplementedError);
      expect((err as Error).message).toContain('v2');
      expect((err as Error).message).toContain('SSO login');
    }
  });

  it('scimProvisionUser throws NotImplementedError mentioning v2', () => {
    expect(() =>
      scimProvisionUser({ externalId: 'ext-1', email: 'a@example.com' }),
    ).toThrow(NotImplementedError);
    try {
      scimProvisionUser({ externalId: 'ext-1', email: 'a@example.com' });
    } catch (err) {
      expect(err).toBeInstanceOf(NotImplementedError);
      expect((err as Error).message).toContain('v2');
      expect((err as Error).message).toContain('SCIM user provisioning');
    }
  });

  it('scimDeprovisionUser throws NotImplementedError mentioning v2', () => {
    expect(() => scimDeprovisionUser('ext-1')).toThrow(NotImplementedError);
    try {
      scimDeprovisionUser('ext-1');
    } catch (err) {
      expect(err).toBeInstanceOf(NotImplementedError);
      expect((err as Error).message).toContain('v2');
      expect((err as Error).message).toContain('SCIM user deprovisioning');
    }
  });

  it('NotImplementedError has correct name and is an Error subclass', () => {
    const err = new NotImplementedError('test feature');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NotImplementedError');
    expect(err.message).toContain('test feature');
    expect(err.message).toContain('v2');
    expect(err.message).toContain('not implemented');
  });
});
