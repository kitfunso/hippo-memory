// authRevoke with a store revokes through its keyAudit group and never opens hippo.db, and DELETE /v1/auth/keys/:keyId
// runs under another store only when that store has the group.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authRevoke, ForbiddenError, NotFoundError, serve, type Actor, type ServerHandle } from '../../src/server.js';
import { OTHER_STORE_MARKER } from '../../src/entry/store-kit.js';
import { seedTwoTenants, TENANT_A, type TwoTenantFixture } from '../_helpers/store-conformance.js';
import { DEFAULT_CONFIG } from '../../src/base/config/config.js';
import { loadConfig } from '../../src/host/config-file.js';
import { portOnlySide } from '../_helpers/port-only-store.js';

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
  writeFileSync(join(root, OTHER_STORE_MARKER), 'port-only\n');
  return root;
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
    const side = portOnlySide(copyOf());
    const { memberA } = fixture.keys;
    expect(
      await authRevoke({ tenantId: TENANT_A, actor: admin, store: side.store, config: loadConfig(hippoRoot) }, memberA),
    ).toEqual({ ok: true, revokedAt: NOW });
    expect(readdirSync(hippoRoot)).toEqual([OTHER_STORE_MARKER]);
    expect((await side.store.findApiKey(memberA))?.revokedAt).toBe(NOW);
    expect(side.auditRows().at(-1)).toMatchObject({
      tenantId: TENANT_A,
      actor: 'cli',
      op: 'auth_revoke',
      targetId: memberA,
    });
  });

  it("keeps hippo.db's checks: a member key revokes only itself, a foreign key is unknown", async () => {
    const side = portOnlySide(copyOf());
    const { adminA, memberA, memberB } = fixture.keys;
    const member = {
      hippoRoot: markedFolder(),
      tenantId: TENANT_A,
      actor: { subject: `api_key:${memberA}`, role: 'member' as const },
      store: side.store,
      config: DEFAULT_CONFIG,
    };
    await expect(authRevoke(member, adminA)).rejects.toThrow(ForbiddenError);
    await expect(authRevoke({ ...member, actor: admin }, memberB)).rejects.toThrow(NotFoundError);
    expect(await authRevoke(member, memberA)).toEqual({ ok: true, revokedAt: NOW });
  });
});

describe('DELETE /v1/auth/keys/:keyId under another store', () => {
  let handle: ServerHandle | undefined;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const revokeVia = (url: string, keyId: string, token: string): Promise<Response> =>
    fetch(`${url}/v1/auth/keys/${keyId}`, { method: 'DELETE', headers: bearer(token) });

  beforeEach(() => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    vi.unstubAllEnvs();
  });

  it('revokes through the store that has keyAudit, and the revoked key is refused at once', async () => {
    const root = copyOf();
    const side = portOnlySide(root);
    handle = await serve({ hippoRoot: root, port: 0, store: side.store });
    // The audit read verifies the key before its admin check refuses a member, which puts the key in the verified-key cache.
    const { url } = handle;
    const auditAs = async (token: string): Promise<number> =>
      (await fetch(`${url}/v1/audit`, { headers: bearer(token) })).status;
    expect(await auditAs(fixture.tokens.memberA)).toBe(403);
    const res = await revokeVia(handle.url, fixture.keys.memberA, fixture.tokens.adminA);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, revokedAt: expect.any(String) });
    expect(await auditAs(fixture.tokens.memberA)).toBe(401);
    expect(side.auditRows().at(-1)).toMatchObject({
      actor: `api_key:${fixture.keys.adminA}`,
      op: 'auth_revoke',
      targetId: fixture.keys.memberA,
    });
  });
});
