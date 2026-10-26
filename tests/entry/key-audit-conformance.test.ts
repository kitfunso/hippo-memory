// KeyWrites' revoke answers: the same values, the same errors and the same audit rows.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import {
  FIXTURE_REVOKED_AT,
  runOnFixture,
  seedTwoTenants,
  TENANT_A,
  type GroupCall,
  type SideResult,
  type TwoTenantFixture,
} from '../_helpers/store-conformance.js';
import { auditHighId } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const NOW = '2026-03-01T12:00:05.000Z';
const AT = '2026-03-01T12:00:00.000Z';

/** Every value a call below resolves to: a revoked_at, or a key's revoked_at read back. */
type KeyAuditValue = string | null | undefined;
type Call = GroupCall<'keyWrites', KeyAuditValue>;
type Side = SideResult<KeyAuditValue>;

let fixture: TwoTenantFixture;
let baseline: Side;

/** Runs the calls on a copy of the fixture and returns their outcomes and audit rows. */
async function conforms(calls: readonly Call[]): Promise<Side> {
  return runOnFixture(fixture, 'keyWrites', calls);
}

const revoke =
  (tenantId: string, keyId: string): Call =>
  (g) =>
    g.changeApiKey('revoke', { tenantId, keyId, actor: 'api_key:caller', at: AT });
const revokedAtOf =
  (keyId: string): Call =>
  async (_g, store) =>
    (await store.findApiKey(keyId))?.revokedAt;
/** The audit id the next row gets: one past the fixture's high-water id, which a pruned newest row sits under. */
const nextAuditId = (root: string): number => auditHighId(root) + 1;

beforeAll(async () => {
  fixture = seedTwoTenants();
  baseline = await conforms([]);
});

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('KeyWrites.changeApiKey revoke', () => {
  it('rejects an unknown key with NotFoundError and writes nothing', async () => {
    const side = await conforms([revoke(TENANT_A, 'hk_missing')]);
    expect(side.outcomes).toEqual([{ error: 'NotFoundError: Unknown key_id: hk_missing' }]);
    expect(side.audit).toEqual(baseline.audit);
  });

  it("answers another tenant's key as unknown and leaves it live", async () => {
    const { memberB } = fixture.keys;
    const side = await conforms([revoke(TENANT_A, memberB), revokedAtOf(memberB)]);
    expect(side.outcomes).toEqual([
      { error: `NotFoundError: Unknown key_id: ${memberB}` },
      { value: null },
    ]);
    expect(side.audit).toEqual(baseline.audit);
  });

  it('keeps the first revoked_at of a key already revoked and writes no row', async () => {
    const side = await conforms([revoke(TENANT_A, fixture.keys.revokedA)]);
    expect(side.outcomes).toEqual([{ value: FIXTURE_REVOKED_AT }]);
    expect(side.audit).toEqual(baseline.audit);
  });

  it('revokes at the given time and appends one auth_revoke row under the next id', async () => {
    const { memberA } = fixture.keys;
    const next = nextAuditId(fixture.dir);
    const side = await conforms([
      revoke(TENANT_A, memberA),
      revokedAtOf(memberA),
      revoke(TENANT_A, memberA),
    ]);
    expect(side.outcomes).toEqual([{ value: AT }, { value: AT }, { value: AT }]);
    expect(side.audit).toEqual([
      ...baseline.audit,
      {
        id: next,
        ts: NOW,
        tenantId: TENANT_A,
        actor: 'api_key:caller',
        op: 'auth_revoke',
        targetId: memberA,
        metadata: {},
      },
    ]);
  });
});
