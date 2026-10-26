// Self-service keys OWNER minted in both tenants, live, expired and revoked, added to the two-tenant fixture.
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createApiKey, grantScope, revokeApiKey } from '../../src/store/sqlite/auth.js';
import { FIXTURE_REVOKED_AT, TENANT_A, TENANT_B, type TwoTenantFixture } from './store-conformance.js';

export const OWNER = 'sso:ann';
export const OWNED_SCOPE = 'private:payroll';

/** Keys OWNER minted for itself, as ids. */
export interface OwnedKeys {
  readonly liveOld: string;
  readonly expired: string;
  readonly revoked: string;
  readonly liveB: string;
  readonly liveNew: string;
}

/** Adds OWNER's keys in both tenants, live, expired and revoked, and an OWNED_SCOPE grant on memberA, to the fixture's template. */
export function seedOwnedKeys(fixture: TwoTenantFixture): OwnedKeys {
  const db = openHippoDb(fixture.dir);
  try {
    const mint = (tenantId: string, label: string, expiresAt: string): string =>
      createApiKey(db, { tenantId, label, role: 'member', ownerSubject: OWNER, expiresAt }).keyId;
    const owned: OwnedKeys = {
      liveOld: mint(TENANT_A, 'old', '2099-01-01T00:00:00.000Z'),
      expired: mint(TENANT_A, 'expired', '2026-02-01T00:00:00.000Z'),
      revoked: mint(TENANT_A, 'revoked', '2099-01-01T00:00:00.000Z'),
      liveB: mint(TENANT_B, 'other-tenant', '2099-01-01T00:00:00.000Z'),
      liveNew: mint(TENANT_A, 'new', '2099-01-01T00:00:00.000Z'),
    };
    revokeApiKey(db, owned.revoked, FIXTURE_REVOKED_AT);
    grantScope(db, fixture.keys.memberA, OWNED_SCOPE);
    return owned;
  } finally {
    closeHippoDb(db);
  }
}
