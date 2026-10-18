// A row's owner is the caller's own; only an admin may write one for someone else.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createApiKey } from '../../src/store/auth.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';

let root: string;
let handle: ServerHandle;
let member: string;
let admin: string;

function post(key: string, owner: string): Promise<Response> {
  return fetch(`${handle.url}/v1/memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ content: `note by ${owner}`, owner }),
  });
}

beforeEach(async () => {
  root = makeRoot('remember-owner', { config: { embeddings: { enabled: false } } });
  const db = openHippoDb(root);
  try {
    member = createApiKey(db, { tenantId: 'default', role: 'member', ownerSubject: 'alice@corp.example' }).plaintext;
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

describe('POST /v1/memories owner', () => {
  it('refuses a member naming another owner, and writes nothing', async () => {
    expect((await post(member, 'bob@corp.example')).status).toBe(403);
    expect(loadAllEntries(root, 'default')).toHaveLength(0);
  });

  it('accepts a member naming its own owner', async () => {
    expect((await post(member, 'alice@corp.example')).status).toBe(200);
    expect(loadAllEntries(root, 'default').map((e) => e.owner)).toEqual(['alice@corp.example']);
  });

  it('accepts an admin naming any owner', async () => {
    expect((await post(admin, 'bob@corp.example')).status).toBe(200);
  });
});
