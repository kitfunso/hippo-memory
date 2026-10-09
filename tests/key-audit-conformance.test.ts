// KeyAudit answers alike on hippo.db and on a store held in memory: the same values, the same errors and the same audit rows.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { AuditEvent } from '../src/server.js';
import { inMemoryKeyAuditStore } from './_helpers/in-memory-key-audit-store.js';
import {
  FIXTURE_REVOKED_AT, onBothStores, seedTwoTenants, TENANT_A, TENANT_B, type GroupCall, type SideResult, type TwoTenantFixture,
} from './_helpers/store-conformance.js';

const NOW = '2026-03-01T12:00:05.000Z';
const AT = '2026-03-01T12:00:00.000Z';

/** Every value a call below resolves to: a revoked_at, an audit id, audit rows, or a key's revoked_at read back. */
type KeyAuditValue = string | number | AuditEvent[] | null | undefined;
type Call = GroupCall<'keyAudit', KeyAuditValue>;
type Side = SideResult<KeyAuditValue>;

let fixture: TwoTenantFixture;
let baseline: Side;

/** Runs the calls on both stores, asserts they agree, and returns hippo.db's side. */
async function conforms(calls: readonly Call[]): Promise<Side> {
  const sides = await onBothStores(fixture, 'keyAudit', inMemoryKeyAuditStore, calls);
  expect(sides.other).toEqual(sides.sqlite);
  return sides.sqlite;
}

const revoke = (tenantId: string, keyId: string): Call => (g) => g.revokeApiKey({ tenantId, keyId, actor: 'api_key:caller', at: AT });
const revokedAtOf = (keyId: string): Call => async (_g, store) => (await store.findApiKey(keyId))?.revokedAt;
const after = (afterId: number, limit?: number, tenantId?: string): Call => (g) => g.auditEventsAfter({ afterId, limit, tenantId });
const highId: Call = (g) => g.auditHighId();

beforeAll(async () => {
  fixture = seedTwoTenants();
  baseline = await conforms([highId]);
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

describe('KeyAudit.revokeApiKey', () => {
  it('rejects an unknown key with NotFoundError and writes nothing', async () => {
    const side = await conforms([revoke(TENANT_A, 'hk_missing'), highId]);
    expect(side.outcomes).toEqual([{ error: 'NotFoundError: Unknown key_id: hk_missing' }, baseline.outcomes[0]]);
    expect(side.audit).toEqual(baseline.audit);
  });

  it("answers another tenant's key as unknown and leaves it live", async () => {
    const { memberB } = fixture.keys;
    const side = await conforms([revoke(TENANT_A, memberB), revokedAtOf(memberB)]);
    expect(side.outcomes).toEqual([{ error: `NotFoundError: Unknown key_id: ${memberB}` }, { value: null }]);
    expect(side.audit).toEqual(baseline.audit);
  });

  it('keeps the first revoked_at of a key already revoked and writes no row', async () => {
    const side = await conforms([revoke(TENANT_A, fixture.keys.revokedA)]);
    expect(side.outcomes).toEqual([{ value: FIXTURE_REVOKED_AT }]);
    expect(side.audit).toEqual(baseline.audit);
  });

  it('revokes at the given time and appends one auth_revoke row under the next id', async () => {
    const { memberA } = fixture.keys;
    const side = await conforms([revoke(TENANT_A, memberA), revokedAtOf(memberA), highId, revoke(TENANT_A, memberA)]);
    // SAFETY: the baseline's one call is auditHighId, which resolves to a number.
    const next = (baseline.outcomes[0] as { value: number }).value + 1;
    expect(side.outcomes).toEqual([{ value: AT }, { value: AT }, { value: next }, { value: AT }]);
    expect(side.audit).toEqual([
      ...baseline.audit,
      { id: next, ts: NOW, tenantId: TENANT_A, actor: 'api_key:caller', op: 'auth_revoke', targetId: memberA, metadata: {} },
    ]);
  });
});

describe('KeyAudit audit reads', () => {
  it('pages in ascending id order, and the pages join up to every row', async () => {
    const side = await conforms([after(0, 3), after(4, 3), after(0), after(0, 10_000)]);
    const all = baseline.audit;
    expect(all.length).toBeGreaterThan(6);
    expect(side.outcomes.slice(2)).toEqual([{ value: all }, { value: all }]);
    expect(side.outcomes[0]).toEqual({ value: all.slice(0, 3) });
    expect(side.outcomes[1]).toEqual({ value: all.filter((e) => e.id > 4).slice(0, 3) });
  });

  it('reads one tenant only when asked', async () => {
    const side = await conforms([after(0, undefined, TENANT_B), after(0, undefined, 'nobody')]);
    const globex = baseline.audit.filter((e) => e.tenantId === TENANT_B);
    expect(globex.length).toBeGreaterThan(1);
    expect(side.outcomes).toEqual([{ value: globex }, { value: [] }]);
  });

  it('clamps the limit and refuses a bad cursor or limit with the same RangeErrors', async () => {
    const side = await conforms([after(0, 0), after(0, 20_000), after(-1), after(1.5), after(0, 2.5)]);
    expect(side.outcomes).toEqual([
      { value: baseline.audit.slice(0, 1) },
      { value: baseline.audit },
      { error: 'RangeError: afterId must be a non-negative integer' },
      { error: 'RangeError: afterId must be a non-negative integer' },
      { error: 'RangeError: limit must be an integer' },
    ]);
  });

  it('reports the high-water id above a pruned newest row', () => {
    const top = baseline.audit.at(-1)?.id ?? 0;
    expect(baseline.outcomes[0]).toEqual({ value: top + 1 });
  });
});
