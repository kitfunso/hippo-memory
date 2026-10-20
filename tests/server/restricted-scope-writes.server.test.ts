// A member key reaches a restricted scope's rows by id only with a grant, as recall reads them: without one, DELETE and
// archive answer 404 exactly as for a missing id and the row stays; with one, or as an admin, both succeed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import { createApiKey, grantScope } from '../../src/store/sqlite/auth.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadEntriesByIds, writeEntry } from '../_helpers/root-forms.js';

const OPS = 'slack:private:Cops';

let root: string;
let handle: ServerHandle;
let note: MemoryEntry;
let raw: MemoryEntry;
const keys = { member: '', granted: '', admin: '' };

function mint(role: 'admin' | 'member', grant?: string): string {
  const db = openHippoDb(root);
  try {
    const key = createApiKey(db, { tenantId: 'default', role });
    if (grant) grantScope(db, key.keyId, grant);
    return key.plaintext;
  } finally {
    closeHippoDb(db);
  }
}

interface Reply {
  status: number;
  /** The body with the id it names replaced, so a refusal compares with a missing id's. */
  body: string;
}

async function send(key: string, method: 'DELETE' | 'POST', id: string, action = ''): Promise<Reply> {
  const res = await fetch(`${handle.url}/v1/memories/${id}${action}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify({ reason: 'source deleted' }) : undefined,
  });
  return { status: res.status, body: (await res.text()).replaceAll(id, '<id>') };
}

const forget = (key: string, id: string): Promise<Reply> => send(key, 'DELETE', id);
const archive = (key: string, id: string): Promise<Reply> => send(key, 'POST', id, '/archive');
const kept = (): string[] => loadEntriesByIds(root, [note.id, raw.id], 'default').map((e) => e.id);

beforeEach(async () => {
  root = makeRoot('restricted-writes', { config: { embeddings: { enabled: false } } });
  note = createMemory('the ops rota sits in the locked channel', { tenantId: 'default', scope: OPS });
  raw = createMemory('raw ops channel message about the rota', { tenantId: 'default', scope: OPS, kind: 'raw' });
  for (const entry of [note, raw]) writeEntry(root, entry, { actor: 'cli' });
  keys.member = mint('member', 'slack:private:Cother');
  keys.granted = mint('member', OPS);
  keys.admin = mint('admin');
  handle = await serve({ hippoRoot: root, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('DELETE /v1/memories/:id and POST /v1/memories/:id/archive on a restricted scope', () => {
  it('answer a member without the grant 404, word for word as a missing id, and keep both rows', async () => {
    const missing = await forget(keys.member, 'mem_missing');
    expect(missing.status).toBe(404);
    expect([await forget(keys.member, note.id), await archive(keys.member, raw.id)]).toEqual([missing, missing]);
    expect(kept()).toEqual(expect.arrayContaining([note.id, raw.id]));
    // The same member's recall of that scope is refused too, so writes and reads share one rule.
    const recall = await fetch(`${handle.url}/v1/memories?q=rota&scope=${encodeURIComponent(OPS)}`, {
      headers: { authorization: `Bearer ${keys.member}` },
    });
    expect(recall.status).toBe(403);
  });

  it.each(['granted', 'admin'] as const)('let a %s key delete and archive both rows', async (who) => {
    const [deleted, archived] = [await forget(keys[who], note.id), await archive(keys[who], raw.id)];
    expect([deleted.status, archived.status]).toEqual([200, 200]);
    expect(JSON.parse(deleted.body)).toEqual({ ok: true, id: '<id>' });
    expect(kept()).toEqual([]);
  });
});
