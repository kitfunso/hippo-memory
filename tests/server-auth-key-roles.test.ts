import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey, listApiKeys } from '../src/store/auth.js';
import { log } from '../src/log.js';
import { serve, type ServerHandle } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';

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
    return listApiKeys(home, { active: true }).some((k) => k.keyId === keyId);
  }

  function post(bearer: string, body: { role?: string }): Promise<Response> {
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
    home = makeRoot('key-roles');
    globalHome = makeRoot('key-roles');
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

  it('logs once that a mint with no role made an admin key with no expiry, naming the key id and never the key', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const admin = mint('admin');
      // SAFETY: the mint route returns AuthCreateResult as JSON.
      const made = (await (await post(admin.plaintext, {})).json()) as { keyId: string; plaintext: string; role: string };
      expect((await post(admin.plaintext, { role: 'admin' })).status).toBe(200);
      const notices = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('admin key, and it never expires'));
      expect(made.role).toBe('admin');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(made.keyId);
      expect(notices[0]).not.toContain(made.plaintext);
    } finally {
      warn.mockRestore();
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
