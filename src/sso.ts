// SSO/SCIM hook stubs.
//
// These functions exist as explicit hook points per ROADMAP A5: stub auth
// is single-tenant only; real SSO/SCIM integration is deferred to v2
// multi-tenant. Calling any of these throws NotImplementedError so callers
// fail loudly rather than silently no-op.

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented in stub auth - tracked for v2 multi-tenant`);
    this.name = 'NotImplementedError';
  }
}

export function ssoLogin(_opts: { provider: 'oidc' | 'saml'; token: string }): never {
  throw new NotImplementedError('SSO login');
}

export function scimProvisionUser(_opts: { externalId: string; email: string }): never {
  throw new NotImplementedError('SCIM user provisioning');
}

export function scimDeprovisionUser(_externalId: string): never {
  throw new NotImplementedError('SCIM user deprovisioning');
}
