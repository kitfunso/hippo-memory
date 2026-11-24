import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createApiKey } from '../../src/store/sqlite/keys/auth.js';
import { handleAuth } from '../../src/surface/cli/auth.js';
import { makeRoot } from '../_helpers/make-root.js';
import { runInProcess } from '../_helpers/run-in-process.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hippo auth list scopes column', () => {
  let home: string;
  let granted: string;
  let plain: string;

  const auth = (args: string[], flags: Record<string, string | boolean> = {}): Promise<{ stdout: string }> =>
    runInProcess(() => handleAuth({ hippoRoot: home, tenantId: 'default', args, flags }));

  beforeEach(async () => {
    home = makeRoot('auth-list-scopes');
    const db = openHippoDb(home);
    try {
      granted = createApiKey(db, { tenantId: 'default', label: 'granted', role: 'member' }).keyId;
      plain = createApiKey(db, { tenantId: 'default', label: 'plain', role: 'member' }).keyId;
    } finally {
      closeHippoDb(db);
    }
    await auth(['grant', granted, 'slack:private:c1']);
    await auth(['grant', granted, 'slack:private:c2']);
  });

  it('ends a granted key row with its scopes, joined by commas, and a key with none with a dash', async () => {
    const { stdout } = await auth(['list']);
    const lines = stdout.split('\n');
    expect(lines).toContain('key_id  tenant  role  label  created  expires  revoked  scopes');
    const row = (keyId: string): string => lines.find((l) => l.startsWith(keyId)) ?? '';
    expect(row(granted).endsWith('  -  slack:private:c1,slack:private:c2')).toBe(true);
    expect(row(plain).endsWith('  -  -')).toBe(true);
  });

  it('leaves --json as the raw list, scopes included', async () => {
    const items: Array<{ keyId: string; scopes: string[] }> = JSON.parse((await auth(['list'], { json: true })).stdout);
    expect(items.find((i) => i.keyId === granted)?.scopes.sort()).toEqual(['slack:private:c1', 'slack:private:c2']);
    expect(items.find((i) => i.keyId === plain)?.scopes).toEqual([]);
  });
});
