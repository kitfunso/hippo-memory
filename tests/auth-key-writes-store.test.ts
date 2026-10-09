// authCreate, authCreateSelf and authList with a store go through its keyWrites group and never open hippo.db, and
// POST and GET /v1/auth/keys run under another store only when that store has the group.
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authCreate, authCreateSelf, authList, authListRows,
  type AuthCreateResult, type AuthCreateSelfResult,
} from '../src/api.js';
import { verifyApiKeyCached, type ApiKeyListItem, type ApiKeyListRow } from '../src/auth.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { StoreNotPortedError } from '../src/util/sqlite-blocked.js';
import { STORE_NOT_PORTED_MESSAGE } from '../src/http-util.js';
import { OTHER_STORE_MARKER, serve, sqliteStore, type Actor, type Context, type HippoDbContext, type HippoStore, type ServerHandle } from '../src/server.js';
import { inMemoryKeyWritesStore, OWNER, seedOwnedKeys, type OwnedKeys } from './_helpers/in-memory-key-writes-store.js';
import { portOnlyStoreWithoutVectorReads } from './_helpers/port-only-store.js';
import { seedTwoTenants, TENANT_A, type TwoTenantFixture } from './_helpers/store-conformance.js';

let fixture: TwoTenantFixture;
let owned: OwnedKeys;
let home: string;
let n = 0;

function copyOf(): string {
  const root = join(home, `copy-${++n}`);
  cpSync(fixture.dir, root, { recursive: true });
  return root;
}

/** A folder whose marker names another store, so a hippo.db open in it throws and creates nothing. */
function markedFolder(): string {
  const root = join(home, `marked-${++n}`);
  mkdirSync(root);
  writeFileSync(join(root, OTHER_STORE_MARKER), 'in-memory\n');
  return root;
}

interface HippoDbState {
  readonly keyIds: readonly string[];
  readonly auditIds: readonly number[];
}

function hippoDbState(root: string): HippoDbState {
  const db = openHippoDb(root);
  try {
    // SAFETY: each SELECT names exactly the one column of the row type it is read as.
    const keys = db.prepare('SELECT key_id FROM api_keys ORDER BY id').all() as { key_id: string }[];
    // SAFETY: as above.
    const ids = db.prepare('SELECT id FROM audit_log ORDER BY id').all() as { id: number }[];
    return { keyIds: keys.map((r) => r.key_id), auditIds: ids.map((r) => r.id) };
  } finally {
    closeHippoDb(db);
  }
}

function breakAuditLog(root: string): void {
  const db = openHippoDb(root);
  try {
    db.exec(`CREATE TRIGGER audit_broken BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit table unwritable'); END`);
  } finally {
    closeHippoDb(db);
  }
}

const admin: Actor = { subject: 'cli', role: 'admin' };
const resolverMember: Actor = { subject: OWNER, role: 'member', viaAuthResolver: true };

beforeAll(() => {
  fixture = seedTwoTenants();
  owned = seedOwnedKeys(fixture);
  home = mkdtempSync(join(tmpdir(), 'hippo-key-writes-store-'));
});

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('authCreate and authCreateSelf with ctx.store', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mints through keyWrites, creates no hippo.db in hippoRoot, and stores only the hash', async () => {
    const hippoRoot = markedFolder();
    const memory = inMemoryKeyWritesStore(copyOf());
    const ctx = { hippoRoot, tenantId: TENANT_A, actor: admin, store: memory.store };
    const minted = await authCreate(ctx, { label: 'ci', role: 'member' });
    expect(minted).toMatchObject({ tenantId: TENANT_A, role: 'member' });
    expect(readdirSync(hippoRoot)).toEqual([OTHER_STORE_MARKER]);
    expect(await verifyApiKeyCached(hippoRoot, minted.plaintext, memory.store)).toMatchObject({ keyId: minted.keyId, tenantId: TENANT_A, role: 'member' });
    expect(memory.auditRows().at(-1)).toMatchObject({ tenantId: TENANT_A, actor: 'cli', op: 'auth_create', targetId: minted.keyId, metadata: { label: 'ci', role: 'member' } });
    const secret = minted.plaintext.slice(minted.keyId.length + 1);
    const stored = JSON.stringify([await memory.store.findApiKey(minted.keyId), await authList(ctx, { active: false }), memory.auditRows()]);
    expect(stored).toContain(minted.keyId);
    expect(stored).not.toContain(secret);
  });

  it('self-mints through keyWrites, and a key it replaces is refused at once despite the verified-key cache', async () => {
    const hippoRoot = markedFolder();
    const memory = inMemoryKeyWritesStore(copyOf());
    const ctx = { hippoRoot, tenantId: TENANT_A, actor: resolverMember, store: memory.store };
    const first = await authCreateSelf(ctx, { label: 'laptop', ttlDays: 30, perSubject: 3 });
    expect(first).toMatchObject({ tenantId: TENANT_A, role: 'member', expiresAt: expect.any(String) });
    expect(await verifyApiKeyCached(hippoRoot, first.plaintext, memory.store)).toMatchObject({ keyId: first.keyId, ownerSubject: OWNER });
    const second = await authCreateSelf(ctx, { label: 'desk', ttlDays: 30, perSubject: 1 });
    expect(await verifyApiKeyCached(hippoRoot, first.plaintext, memory.store)).toBeNull();
    expect(await verifyApiKeyCached(hippoRoot, second.plaintext, memory.store)).toMatchObject({ keyId: second.keyId });
    const revokes = memory.auditRows().filter((e) => e.op === 'auth_revoke').map((e) => [e.targetId, e.metadata]);
    expect(revokes).toEqual(expect.arrayContaining([[first.keyId, { replacedBy: second.keyId }], [owned.liveOld, { replacedBy: second.keyId }]]));
    expect(readdirSync(hippoRoot)).toEqual([OTHER_STORE_MARKER]);
  });

  it('rejects with StoreNotPortedError on a store without keyWrites, and touches neither hippo.db', async () => {
    const storeRoot = copyOf();
    const before = hippoDbState(storeRoot);
    const ctx = { hippoRoot: markedFolder(), tenantId: TENANT_A, actor: admin, store: portOnlyStoreWithoutVectorReads(storeRoot) };
    const calls: (() => Promise<AuthCreateResult | AuthCreateSelfResult | ApiKeyListItem[] | ApiKeyListRow[]>)[] = [
      () => authCreate(ctx, { label: 'x' }),
      () => authCreateSelf({ ...ctx, actor: resolverMember }, { ttlDays: 1, perSubject: 1 }),
      () => authList(ctx, { active: true }),
      () => authListRows(ctx, { active: false, limit: 5 }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toThrow(StoreNotPortedError);
      await expect(call()).rejects.toThrow("the 'port-only' store has no 'keyWrites' group");
    }
    expect(readdirSync(ctx.hippoRoot)).toEqual([OTHER_STORE_MARKER]);
    expect(hippoDbState(storeRoot)).toEqual(before);
  });

  it("an API-key admin's mint leaves no key when its audit row fails, on hippo.db's own store and with no store", async () => {
    const root = copyOf();
    breakAuditLog(root);
    const before = hippoDbState(root);
    const actor: Actor = { subject: `api_key:${fixture.keys.adminA}`, role: 'admin' };
    await expect(authCreate({ hippoRoot: root, tenantId: TENANT_A, actor, store: sqliteStore(root) }, { label: 'x' })).rejects.toThrow(/audit table unwritable/);
    expect(() => authCreate({ hippoRoot: root, tenantId: TENANT_A, actor }, { label: 'y' })).toThrow(/audit table unwritable/);
    expect(hippoDbState(root)).toEqual(before);
  });

  it('keeps the plain result for a ctx with no store, and the promise for one with a store', () => {
    const minted = authCreate({ hippoRoot: copyOf(), tenantId: TENANT_A, actor: admin }, {});
    expect(minted).not.toBeInstanceOf(Promise);
    expectTypeOf(minted).toEqualTypeOf<AuthCreateResult>();
    type WithStore = Context & { store: HippoStore };
    type NoStore = HippoDbContext;
    expectTypeOf(authCreate<WithStore>).returns.toEqualTypeOf<Promise<AuthCreateResult>>();
    expectTypeOf(authCreate<NoStore>).returns.toEqualTypeOf<AuthCreateResult>();
    expectTypeOf(authCreate<Context>).returns.toEqualTypeOf<AuthCreateResult | Promise<AuthCreateResult>>();
    expectTypeOf(authCreateSelf<WithStore>).returns.toEqualTypeOf<Promise<AuthCreateSelfResult>>();
    expectTypeOf(authCreateSelf<NoStore>).returns.toEqualTypeOf<AuthCreateSelfResult>();
    expectTypeOf(authList<WithStore>).returns.toEqualTypeOf<Promise<ApiKeyListItem[]>>();
    expectTypeOf(authList<NoStore>).returns.toEqualTypeOf<ApiKeyListItem[]>();
    expectTypeOf(authListRows<WithStore>).returns.toEqualTypeOf<Promise<ApiKeyListRow[]>>();
    expectTypeOf(authListRows<Context>).returns.toEqualTypeOf<ApiKeyListRow[] | Promise<ApiKeyListRow[]>>();
  });
});

describe('authList with ctx.store', () => {
  const callers: readonly [string, () => Actor, boolean][] = [
    ['an admin', () => admin, true],
    ['a member signed in through the resolver', () => resolverMember, true],
    ['a member key with an owner', () => ({ subject: `api_key:${owned.liveNew}`, role: 'member' }), true],
    ['a member key with no owner', () => ({ subject: `api_key:${fixture.keys.memberA}`, role: 'member' }), true],
    ['a member that is not a key', () => ({ subject: 'user:nobody', role: 'member' }), false],
  ];

  it.each(callers)('lists what hippo.db lists for %s', async (_name, actorOf, listsAny) => {
    const root = copyOf();
    const memory = inMemoryKeyWritesStore(root);
    const actor = actorOf();
    for (const active of [true, false]) {
      const onHippoDb = authList({ hippoRoot: root, tenantId: TENANT_A, actor }, { active });
      expect(onHippoDb.length > 0).toBe(listsAny);
      expect(await authList({ hippoRoot: markedFolder(), tenantId: TENANT_A, actor, store: memory.store }, { active })).toEqual(onHippoDb);
    }
  });
});

describe('POST and GET /v1/auth/keys under another store', () => {
  let handle: ServerHandle | undefined;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const mintVia = (url: string, token: string): Promise<Response> =>
    fetch(`${url}/v1/auth/keys`, { method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' }, body: JSON.stringify({ label: 'http', role: 'member' }) });
  const listVia = (url: string, token: string): Promise<Response> => fetch(`${url}/v1/auth/keys?active=false`, { headers: bearer(token) });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    vi.unstubAllEnvs();
  });

  it('answers 501 before the handler on a store without keyWrites, writes nothing, and a bad key is still a 401', async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    const root = copyOf();
    const before = hippoDbState(root);
    handle = await serve({ hippoRoot: root, port: 0, store: portOnlyStoreWithoutVectorReads(root) });
    for (const send of [mintVia, listVia]) {
      const res = await send(handle.url, fixture.tokens.adminA);
      expect({ status: res.status, body: await res.json() }).toEqual({ status: 501, body: { error: STORE_NOT_PORTED_MESSAGE } });
      expect((await send(handle.url, `${fixture.keys.adminA}.wrong`)).status).toBe(401);
    }
    expect(hippoDbState(root)).toEqual(before);
  });

  it('mints and lists through the store that has keyWrites, and the new key works at once', async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    const root = copyOf();
    const before = hippoDbState(root);
    const memory = inMemoryKeyWritesStore(root);
    handle = await serve({ hippoRoot: root, port: 0, store: memory.store });
    const res = await mintVia(handle.url, fixture.tokens.adminA);
    expect(res.status).toBe(200);
    // SAFETY: POST /v1/auth/keys answers 200 with an AuthCreateResult.
    const minted = (await res.json()) as AuthCreateResult;
    expect(minted).toMatchObject({ tenantId: TENANT_A, role: 'member' });
    const listed = await listVia(handle.url, minted.plaintext);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([expect.objectContaining({ keyId: minted.keyId, label: 'http' })]);
    // SAFETY: GET /v1/auth/keys answers 200 with a bare array of ApiKeyListItem.
    const all = (await (await listVia(handle.url, fixture.tokens.adminA)).json()) as ApiKeyListItem[];
    expect(all[0]).toMatchObject({ keyId: minted.keyId });
    expect(memory.auditRows().at(-1)).toMatchObject({ actor: `api_key:${fixture.keys.adminA}`, op: 'auth_create', targetId: minted.keyId });
    expect(hippoDbState(root)).toEqual(before);
  });
});
