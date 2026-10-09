// KeyWrites answers alike on hippo.db and on a store held in memory: the same values, the same errors and the same audit rows.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { mintApiKey } from '../src/store/auth.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { auditHighIdAt } from '../src/store/key-audit.js';
import type { ApiKeyListRow, ApiKeyRecord, AuditEvent, KeyListQuery, NewApiKey } from '../src/server.js';
import { inMemoryKeyWritesStore, OWNED_SCOPE, OWNER, seedOwnedKeys, type OwnedKeys } from './_helpers/in-memory-key-writes-store.js';
import {
  FIXTURE_REVOKED_AT, onBothStores, seedTwoTenants, TENANT_A, TENANT_B, type GroupCall, type SideResult, type TwoTenantFixture,
} from './_helpers/store-conformance.js';

const NOW = '2026-03-01T12:00:05.000Z';
const EXPIRES = '2026-04-01T12:00:05.000Z';

/** Every value a call below resolves to: nothing, revoked ids, listed rows, a key record or revoked_at read back, or whether a write was refused. */
type KeyWritesValue = void | string[] | ApiKeyListRow[] | ApiKeyRecord | string | null | undefined;
type Call = GroupCall<'keyWrites', KeyWritesValue>;
type Side = SideResult<KeyWritesValue>;

let fixture: TwoTenantFixture;
let owned: OwnedKeys;
let baseline: Side;
let nextAuditId: number;

async function conforms(calls: readonly Call[]): Promise<Side> {
  const sides = await onBothStores(fixture, 'keyWrites', inMemoryKeyWritesStore, calls);
  expect(sides.other).toEqual(sides.sqlite);
  return sides.sqlite;
}

function newKey(fields: Partial<NewApiKey> = {}): NewApiKey {
  const { keyId, keyHash } = mintApiKey();
  return { keyId, keyHash, tenantId: TENANT_A, label: 'new', role: 'member', createdAt: NOW, ownerSubject: null, expiresAt: null, ...fields };
}

const selfKey = (tenantId = TENANT_A): NewApiKey & { ownerSubject: string; expiresAt: string } => ({ ...newKey({ tenantId }), ownerSubject: OWNER, expiresAt: EXPIRES });
const SELF_META = { label: 'new', role: 'member', self: true, expiresAt: EXPIRES };

const create = (key: NewApiKey): Call => (g) => g.createApiKey({ key, actor: 'api_key:caller', metadata: { label: key.label, role: key.role } });
const createSelf = (key: NewApiKey & { ownerSubject: string; expiresAt: string }, perSubject: number): Call =>
  (g) => g.createSelfApiKey({ key, actor: OWNER, metadata: SELF_META, perSubject });
type ListQuery = Omit<KeyListQuery, 'tenantId'> & { tenantId?: string };
const list = (query: ListQuery): Call => (g) => g.listApiKeys({ tenantId: TENANT_A, ...query });
const listIds = (query: ListQuery): Call => async (g) => (await g.listApiKeys({ tenantId: TENANT_A, ...query })).map((r) => r.key.keyId);
const find = (keyId: string): Call => (_g, store) => store.findApiKey(keyId);
const revokedAtOf = (keyId: string): Call => async (_g, store) => (await store.findApiKey(keyId))?.revokedAt;
/** Stores word a refused write differently, so only whether it was refused is compared. */
const settled = (call: Call): Call => (g, store) => call(g, store).then(() => 'stored', () => 'refused');

const valueOf = (side: Side, i: number): KeyWritesValue => {
  const outcome = side.outcomes[i];
  return outcome !== undefined && 'value' in outcome ? outcome.value : undefined;
};

beforeAll(async () => {
  fixture = seedTwoTenants();
  owned = seedOwnedKeys(fixture);
  const db = openHippoDb(fixture.dir);
  try {
    nextAuditId = auditHighIdAt(db) + 1;
  } finally {
    closeHippoDb(db);
  }
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

describe('KeyWrites.createApiKey', () => {
  it('stores the hashed row and one auth_create row under the next id', async () => {
    const key = newKey({ label: 'ci', role: 'admin' });
    const side = await conforms([create(key), find(key.keyId), list({ keyId: key.keyId, active: true })]);
    expect(side.outcomes.slice(0, 2)).toEqual([
      { value: undefined },
      { value: { keyHash: key.keyHash, tenantId: TENANT_A, revokedAt: null, role: 'admin', scopes: [], expiresAt: null, ownerSubject: null } },
    ]);
    expect(valueOf(side, 2)).toEqual([{
      rowId: expect.any(Number),
      key: { keyId: key.keyId, tenantId: TENANT_A, label: 'ci', createdAt: NOW, revokedAt: null, role: 'admin', scopes: [], expiresAt: null, ownerSubject: null },
    }]);
    expect(side.audit).toEqual([
      ...baseline.audit,
      { id: nextAuditId, ts: NOW, tenantId: TENANT_A, actor: 'api_key:caller', op: 'auth_create', targetId: key.keyId, metadata: { label: 'ci', role: 'admin' } },
    ]);
  });

  it('refuses a key id already taken and writes nothing', async () => {
    const { memberA } = fixture.keys;
    const taken = newKey({ keyId: memberA });
    const side = await conforms([settled(create(taken)), find(memberA)]);
    expect(side.outcomes[0]).toEqual({ value: 'refused' });
    expect(valueOf(side, 1)).toMatchObject({ tenantId: TENANT_A, role: 'member', scopes: [OWNED_SCOPE] });
    expect(valueOf(side, 1)).not.toMatchObject({ keyHash: taken.keyHash });
    expect(side.audit).toEqual(baseline.audit);
  });

  it("refuses another tenant's key id, since findApiKey looks keys up by id alone", async () => {
    const { memberB } = fixture.keys;
    const side = await conforms([settled(create(newKey({ keyId: memberB }))), find(memberB)]);
    expect(side.outcomes[0]).toEqual({ value: 'refused' });
    expect(valueOf(side, 1)).toMatchObject({ tenantId: TENANT_B });
    expect(side.audit).toEqual(baseline.audit);
  });
});

describe('KeyWrites.createSelfApiKey', () => {
  it('revokes nothing while the owner is under the cap, counting neither expired nor revoked keys', async () => {
    const key = selfKey();
    const side = await conforms([createSelf(key, 3), revokedAtOf(owned.liveOld), revokedAtOf(owned.liveNew), find(key.keyId)]);
    expect(side.outcomes.slice(0, 3)).toEqual([{ value: [] }, { value: null }, { value: null }]);
    expect(valueOf(side, 3)).toEqual({ keyHash: key.keyHash, tenantId: TENANT_A, revokedAt: null, role: 'member', scopes: [], expiresAt: EXPIRES, ownerSubject: OWNER });
    expect(side.audit).toEqual([
      ...baseline.audit,
      { id: nextAuditId, ts: NOW, tenantId: TENANT_A, actor: OWNER, op: 'auth_create', targetId: key.keyId, metadata: SELF_META },
    ]);
  });

  it('revokes the oldest live keys over the cap, one auth_revoke row each before the auth_create row', async () => {
    const key = selfKey();
    const { liveOld, liveNew, expired, revoked, liveB } = owned;
    const side = await conforms([
      createSelf(key, 1), revokedAtOf(liveOld), revokedAtOf(liveNew), revokedAtOf(expired), revokedAtOf(revoked), revokedAtOf(liveB),
      listIds({ ownerSubject: OWNER, active: true }),
    ]);
    expect(side.outcomes).toEqual([
      { value: [liveOld, liveNew] }, { value: NOW }, { value: NOW }, { value: null }, { value: FIXTURE_REVOKED_AT }, { value: null }, { value: [key.keyId] },
    ]);
    const revokeRow = (targetId: string, id: number): AuditEvent => ({ id, ts: NOW, tenantId: TENANT_A, actor: OWNER, op: 'auth_revoke', targetId, metadata: { replacedBy: key.keyId } });
    expect(side.audit).toEqual([
      ...baseline.audit,
      revokeRow(liveOld, nextAuditId),
      revokeRow(liveNew, nextAuditId + 1),
      { id: nextAuditId + 2, ts: NOW, tenantId: TENANT_A, actor: OWNER, op: 'auth_create', targetId: key.keyId, metadata: SELF_META },
    ]);
  });

  it('leaves room for the new key: a cap of 2 revokes only the oldest', async () => {
    const side = await conforms([createSelf(selfKey(), 2), revokedAtOf(owned.liveNew)]);
    expect(side.outcomes).toEqual([{ value: [owned.liveOld] }, { value: null }]);
  });

  it("counts and revokes only the key's own tenant", async () => {
    const key = selfKey(TENANT_B);
    const side = await conforms([createSelf(key, 1), revokedAtOf(owned.liveOld), revokedAtOf(owned.liveNew), listIds({ tenantId: TENANT_B, ownerSubject: OWNER, active: true })]);
    expect(side.outcomes).toEqual([{ value: [owned.liveB] }, { value: null }, { value: null }, { value: [key.keyId] }]);
    expect(side.audit.slice(baseline.audit.length).map((e) => [e.tenantId, e.op, e.targetId])).toEqual([
      [TENANT_B, 'auth_revoke', owned.liveB], [TENANT_B, 'auth_create', key.keyId],
    ]);
  });

  it('refuses a key id already taken and revokes nothing', async () => {
    const taken = { ...selfKey(), keyId: owned.liveNew };
    const side = await conforms([settled(createSelf(taken, 1)), revokedAtOf(owned.liveOld), revokedAtOf(owned.liveNew)]);
    expect(side.outcomes).toEqual([{ value: 'refused' }, { value: null }, { value: null }]);
    expect(side.audit).toEqual(baseline.audit);
  });
});

describe('KeyWrites.listApiKeys', () => {
  it("lists one tenant's keys newest first, and only the working ones when active", async () => {
    const { adminA, memberA, revokedA, memberB } = fixture.keys;
    const { liveOld, expired, revoked, liveB, liveNew } = owned;
    const side = await conforms([
      listIds({ active: false }), listIds({ active: true }), listIds({ tenantId: TENANT_B, active: false }), listIds({ tenantId: 'nobody', active: false }),
      list({ active: false }),
    ]);
    expect(side.outcomes.slice(0, 4)).toEqual([
      { value: [liveNew, revoked, expired, liveOld, revokedA, memberA, adminA] },
      { value: [liveNew, liveOld, memberA, adminA] },
      { value: [liveB, memberB] },
      { value: [] },
    ]);
    expect(valueOf(side, 4)).toHaveLength(7);
  });

  it('filters by owner and by key id inside the tenant, and carries scope grants', async () => {
    const { memberA, memberB } = fixture.keys;
    const side = await conforms([listIds({ ownerSubject: OWNER, active: false }), list({ keyId: memberA, active: true }), list({ keyId: memberB, active: false })]);
    expect(side.outcomes[0]).toEqual({ value: [owned.liveNew, owned.revoked, owned.expired, owned.liveOld] });
    expect(valueOf(side, 1)).toEqual([expect.objectContaining({ key: expect.objectContaining({ keyId: memberA, scopes: [OWNED_SCOPE], ownerSubject: null }) })]);
    expect(valueOf(side, 2)).toEqual([]);
  });

  it('pages after a row id, and the pages join up to the whole list', async () => {
    const pages: Call = async (g) => {
      const first = await g.listApiKeys({ tenantId: TENANT_A, active: false, limit: 3 });
      const last = first.at(-1);
      const rest = last ? await g.listApiKeys({ tenantId: TENANT_A, active: false, limit: 10, after: { key: last.rowId, id: last.rowId } }) : [];
      return [...first, ...rest].map((r) => r.key.keyId);
    };
    const side = await conforms([pages, listIds({ active: false })]);
    expect(side.outcomes[0]).toEqual(side.outcomes[1]);
    expect(valueOf(side, 0)).toHaveLength(7);
  });
});
