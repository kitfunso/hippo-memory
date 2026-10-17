// A write into a restricted scope needs the grant a read of it needs; quarantine scopes are never client-writable.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createApiKey, grantScope } from '../../src/store/auth.js';
import { loadAllEntries } from '../../src/store/entry-reads.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';

const PRIVATE = 'slack:private:C1';

let root: string;
let handle: ServerHandle;
let member: string;
let granted: string;
let admin: string;

function post(key: string, scope: string): Promise<Response> {
  return fetch(`${handle.url}/v1/memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ content: `note for ${scope}`, scope }),
  });
}

beforeEach(async () => {
  root = makeRoot('remember-private-grant', { config: { embeddings: { enabled: false } } });
  const db = openHippoDb(root);
  try {
    member = createApiKey(db, { tenantId: 'default', role: 'member' }).plaintext;
    const g = createApiKey(db, { tenantId: 'default', role: 'member' });
    grantScope(db, g.keyId, PRIVATE);
    granted = g.plaintext;
    admin = createApiKey(db, { tenantId: 'default', role: 'admin' }).plaintext;
  } finally {
    closeHippoDb(db);
  }
  handle = await serve({ hippoRoot: root, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('POST /v1/memories into restricted scopes', () => {
  it('refuses a member key with no grant for a private scope', async () => {
    expect((await post(member, PRIVATE)).status).toBe(403);
    expect(loadAllEntries(root, 'default')).toHaveLength(0);
  });

  it('accepts the same write from a key granted that scope, and from an admin', async () => {
    expect((await post(granted, PRIVATE)).status).toBe(200);
    expect((await post(admin, PRIVATE)).status).toBe(200);
    expect(loadAllEntries(root, 'default').map((e) => e.scope)).toEqual([PRIVATE, PRIVATE]);
  });

  it('still lets a member write a public scope', async () => {
    expect((await post(member, 'team')).status).toBe(200);
  });

  it('refuses a quarantine scope for a granted member and for an admin', async () => {
    const q = 'quarantine:private:slack:private:C1';
    expect((await post(granted, q)).status).toBe(403);
    expect((await post(admin, q)).status).toBe(403);
    expect(loadAllEntries(root, 'default').filter((e) => e.scope === q)).toHaveLength(0);
  });
});
