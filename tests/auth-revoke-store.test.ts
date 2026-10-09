// authRevoke with a store revokes through its keyAudit group and never opens hippo.db, and DELETE /v1/auth/keys/:keyId
// runs under another store only when that store has the group.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { StoreNotPortedError } from '../src/util/sqlite-blocked.js';
import { STORE_NOT_PORTED_MESSAGE } from '../src/http-util.js';
import {
  authRevoke, ForbiddenError, NotFoundError, OTHER_STORE_MARKER, serve, type Actor, type AuthRevokeResult, type Context, type HippoStore, type ServerHandle,
} from '../src/server.js';
import { inMemoryKeyAuditStore } from './_helpers/in-memory-key-audit-store.js';
import { portOnlyStoreWithoutVectorReads } from './_helpers/port-only-store.js';
import { seedTwoTenants, TENANT_A, type TwoTenantFixture } from './_helpers/store-conformance.js';

const NOW = '2026-03-01T12:00:00.000Z';
let fixture: TwoTenantFixture;
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
  readonly revokedAt: string | null;
  readonly auditIds: readonly number[];
}

function hippoDbState(root: string, keyId: string): HippoDbState {
  const db = openHippoDb(root);
  try {
    // SAFETY: each SELECT names exactly the columns of the row type it is read as, and the fixture minted keyId.
    const key = db.prepare('SELECT revoked_at FROM api_keys WHERE key_id = ?').get(keyId) as { revoked_at: string | null };
    // SAFETY: as above.
    const ids = db.prepare('SELECT id FROM audit_log ORDER BY id').all() as { id: number }[];
    return { revokedAt: key.revoked_at, auditIds: ids.map((r) => r.id) };
  } finally {
    closeHippoDb(db);
  }
}

const admin: Actor = { subject: 'cli', role: 'admin' };

beforeAll(() => {
  fixture = seedTwoTenants();
  home = mkdtempSync(join(tmpdir(), 'hippo-revoke-store-'));
});

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('authRevoke with ctx.store', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('revokes through keyAudit and creates no hippo.db in hippoRoot', async () => {
    const hippoRoot = markedFolder();
    const memory = inMemoryKeyAuditStore(copyOf());
    const { memberA } = fixture.keys;
    expect(await authRevoke({ hippoRoot, tenantId: TENANT_A, actor: admin, store: memory.store }, memberA)).toEqual({ ok: true, revokedAt: NOW });
    expect(readdirSync(hippoRoot)).toEqual([OTHER_STORE_MARKER]);
    expect((await memory.store.findApiKey(memberA))?.revokedAt).toBe(NOW);
    expect(memory.auditRows().at(-1)).toMatchObject({ tenantId: TENANT_A, actor: 'cli', op: 'auth_revoke', targetId: memberA });
  });

  it('rejects with StoreNotPortedError on a store without keyAudit, and touches neither hippo.db', async () => {
    const hippoRoot = markedFolder();
    const storeRoot = copyOf();
    const before = hippoDbState(storeRoot, fixture.keys.memberA);
    const store: HippoStore = portOnlyStoreWithoutVectorReads(storeRoot);
    const revoking = authRevoke({ hippoRoot, tenantId: TENANT_A, actor: admin, store }, fixture.keys.memberA);
    await expect(revoking).rejects.toThrow(StoreNotPortedError);
    await expect(revoking).rejects.toThrow("the 'port-only' store has no 'keyAudit' group");
    expect(readdirSync(hippoRoot)).toEqual([OTHER_STORE_MARKER]);
    expect(hippoDbState(storeRoot, fixture.keys.memberA)).toEqual(before);
  });

  it("keeps hippo.db's checks: a member key revokes only itself, a foreign key is unknown", async () => {
    const memory = inMemoryKeyAuditStore(copyOf());
    const { adminA, memberA, memberB } = fixture.keys;
    const member = { hippoRoot: markedFolder(), tenantId: TENANT_A, actor: { subject: `api_key:${memberA}`, role: 'member' as const }, store: memory.store };
    await expect(authRevoke(member, adminA)).rejects.toThrow(ForbiddenError);
    await expect(authRevoke({ ...member, actor: admin }, memberB)).rejects.toThrow(NotFoundError);
    expect(await authRevoke(member, memberA)).toEqual({ ok: true, revokedAt: NOW });
  });

  it('stays synchronous for a ctx with no store, so an injected `typeof authRevoke` still compiles', () => {
    const revoke: typeof authRevoke = (ctx, keyId) => authRevoke(ctx, keyId);
    const ctx = { hippoRoot: copyOf(), tenantId: TENANT_A, actor: { subject: 'system:scim:u1', role: 'admin' as const, viaAuthResolver: true as const } };
    const result = revoke(ctx, fixture.keys.memberA);
    expectTypeOf(result).toEqualTypeOf<AuthRevokeResult>();
    expect(result).toEqual({ ok: true, revokedAt: NOW });
    expectTypeOf(authRevoke<Context & { store: HippoStore }>).returns.toEqualTypeOf<Promise<AuthRevokeResult>>();
    expectTypeOf(authRevoke<Context>).returns.toEqualTypeOf<AuthRevokeResult | Promise<AuthRevokeResult>>();
  });
});

describe('DELETE /v1/auth/keys/:keyId under another store', () => {
  let handle: ServerHandle | undefined;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const revokeVia = (url: string, keyId: string, token: string): Promise<Response> => fetch(`${url}/v1/auth/keys/${keyId}`, { method: 'DELETE', headers: bearer(token) });

  beforeEach(() => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    vi.unstubAllEnvs();
  });

  it('answers 501 before the handler on a store without keyAudit: no audit row, no key change, and a bad key is still a 401', async () => {
    const root = copyOf();
    const before = hippoDbState(root, fixture.keys.memberA);
    handle = await serve({ hippoRoot: root, port: 0, store: portOnlyStoreWithoutVectorReads(root) });
    const res = await revokeVia(handle.url, fixture.keys.memberA, fixture.tokens.adminA);
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 501, body: { error: STORE_NOT_PORTED_MESSAGE } });
    expect((await revokeVia(handle.url, fixture.keys.memberA, `${fixture.keys.adminA}.wrong`)).status).toBe(401);
    expect(hippoDbState(root, fixture.keys.memberA)).toEqual(before);
  });

  it('revokes through the store that has keyAudit, and the revoked key is refused at once', async () => {
    const root = copyOf();
    const before = hippoDbState(root, fixture.keys.memberA);
    const memory = inMemoryKeyAuditStore(root);
    handle = await serve({ hippoRoot: root, port: 0, store: memory.store });
    // An unported route still verifies the key first, which puts it in the verified-key cache.
    expect((await fetch(`${handle.url}/v1/graph`, { headers: bearer(fixture.tokens.memberA) })).status).toBe(501);
    const res = await revokeVia(handle.url, fixture.keys.memberA, fixture.tokens.adminA);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, revokedAt: expect.any(String) });
    expect((await fetch(`${handle.url}/v1/graph`, { headers: bearer(fixture.tokens.memberA) })).status).toBe(401);
    expect(memory.auditRows().at(-1)).toMatchObject({ actor: `api_key:${fixture.keys.adminA}`, op: 'auth_revoke', targetId: fixture.keys.memberA });
    expect(hippoDbState(root, fixture.keys.memberA)).toEqual(before);
  });
});
