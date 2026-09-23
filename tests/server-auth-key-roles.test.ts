import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey, listApiKeys } from '../src/auth.js';
import { serve, type ServerHandle } from '../src/server.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-key-roles-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

describe('/v1/auth/keys role rules', () => {
  let home: string;
  let globalHome: string;
  let origHippoHome: string | undefined;
  let handle: ServerHandle;

  function mint(role: 'admin' | 'member'): { keyId: string; plaintext: string } {
    const db = openHippoDb(home);
    try {
      return createApiKey(db, { tenantId: 'default', label: `${role}-test`, role });
    } finally {
      closeHippoDb(db);
    }
  }

  function isActive(keyId: string): boolean {
    const db = openHippoDb(home);
    try {
      return listApiKeys(db, { active: true }).some((k) => k.keyId === keyId);
    } finally {
      closeHippoDb(db);
    }
  }

  function post(bearer: string, body: object): Promise<Response> {
    return fetch(`${handle.url}/v1/auth/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
  }

  function revoke(bearer: string, keyId: string): Promise<Response> {
    return fetch(`${handle.url}/v1/auth/keys/${keyId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${bearer}` },
    });
  }

  beforeEach(async () => {
    home = makeRoot();
    globalHome = makeRoot();
    origHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    if (origHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = origHippoHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('a member key cannot mint a key of either role', async () => {
    const member = mint('member');
    for (const body of [{ role: 'admin' }, { role: 'member' }, {}]) {
      const res = await post(member.plaintext, body);
      expect(res.status).toBe(403);
      // SAFETY: mapApiError sends { error: string } for every 403.
      expect(((await res.json()) as { error: string }).error).toContain('Only an admin key');
    }
  });

  it('an admin key mints either role', async () => {
    const admin = mint('admin');
    for (const role of ['admin', 'member'] as const) {
      const res = await post(admin.plaintext, { role });
      expect(res.status).toBe(200);
      // SAFETY: the mint route returns AuthCreateResult as JSON.
      expect(((await res.json()) as { role: string }).role).toBe(role);
    }
  });

  it('a member key cannot revoke another key, or probe a missing one', async () => {
    const member = mint('member');
    const other = mint('member');
    expect((await revoke(member.plaintext, other.keyId)).status).toBe(403);
    expect(isActive(other.keyId)).toBe(true);
    expect((await revoke(member.plaintext, 'hk_does_not_exist')).status).toBe(403);
  });

  it('a member key can revoke itself, and an admin key can revoke any key', async () => {
    const member = mint('member');
    expect((await revoke(member.plaintext, member.keyId)).status).toBe(200);
    expect(isActive(member.keyId)).toBe(false);

    const admin = mint('admin');
    const target = mint('member');
    expect((await revoke(admin.plaintext, target.keyId)).status).toBe(200);
    expect(isActive(target.keyId)).toBe(false);
  });
});
