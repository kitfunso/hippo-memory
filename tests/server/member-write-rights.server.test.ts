// A member key forgets, archives, supersedes or resolves away a team memory only when the row's owner is its own, else
// 403 naming the key that can; an admin key and the CLI operator keep every right. Real server, over HTTP and MCP.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createApiKey } from '../../src/store/sqlite/auth.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { runCli } from '../../src/cli.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { makeStore } from '../_helpers/make-root.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { listMemoryConflicts, readEntry, replaceDetectedConflicts } from '../_helpers/root-forms.js';

const BOB = 'oid-bob';
const CAROL = 'oid-carol';

let base: string;
let root: string;
let handle: ServerHandle;
let stopped: boolean;

/** The plaintext keys: two member keys with owners, and an admin key with none. */
interface Keys {
  readonly bob: string;
  readonly carol: string;
  readonly admin: string;
}
let keys: Keys;

function mint(role: 'admin' | 'member', ownerSubject?: string): string {
  const db = openHippoDb(root);
  try {
    return createApiKey(db, { tenantId: 'default', role, ownerSubject }).plaintext;
  } finally {
    closeHippoDb(db);
  }
}

beforeEach(async () => {
  ({ base, root } = makeStore('member-write-rights', { config: { embeddings: { enabled: false } } }));
  keys = { bob: mint('member', BOB), carol: mint('member', CAROL), admin: mint('admin') };
  handle = await serve({ hippoRoot: root, port: 0 });
  stopped = false;
});

afterEach(async () => {
  if (!stopped) await handle.stop();
});

async function call(key: string, method: string, path: string, body?: JsonValue): Promise<[number, JsonValue]> {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // SAFETY: every route this file calls answers JSON.
  return [res.status, (await res.json()) as JsonValue];
}

/** A team write by `key`; `owner` records the person behind it, which a member key may set only to its own. */
async function writes(key: string, content: string, extra: { [k: string]: JsonValue } = {}): Promise<string> {
  const [status, reply] = await call(key, 'POST', '/v1/memories', { content, force: true, ...extra });
  expect(status).toBe(200);
  // SAFETY: a 200 from POST /v1/memories is a RememberResult, which carries the new row's id.
  return (reply as { id: string }).id;
}

const missing = (id: string): [number, JsonValue] => [404, { error: `memory not found: ${id}` }];
const notTheirs = (id: string): [number, JsonValue] => [
  403,
  { error: `memory ${id} was written by someone else: change it with the key that wrote it or an admin key` },
];
const noWriter = (id: string): [number, JsonValue] => [
  403,
  { error: `memory ${id} records no writer: change it with an admin key` },
];

describe('write rights on a team memory over HTTP', () => {
  it("answers a member key 403 on another person's row and on a row with no owner, and changes nothing", async () => {
    const owned = await writes(keys.bob, 'the staging cluster restarts at noon', { owner: BOB });
    const ownedRaw = await writes(keys.bob, 'raw standup note about the staging cluster', { owner: BOB, kind: 'raw' });
    const unowned = await writes(keys.bob, 'the release train leaves on thursdays');
    const supersede = { content: 'it restarts at one' };

    expect(await call(keys.carol, 'DELETE', `/v1/memories/${owned}`)).toEqual(notTheirs(owned));
    expect(await call(keys.carol, 'POST', `/v1/memories/${ownedRaw}/archive`, { reason: 'r' })).toEqual(
      notTheirs(ownedRaw),
    );
    expect(await call(keys.carol, 'POST', `/v1/memories/${owned}/supersede`, supersede)).toEqual(notTheirs(owned));
    // Bob wrote it, but nothing on the row records him.
    expect(await call(keys.bob, 'DELETE', `/v1/memories/${unowned}`)).toEqual(noWriter(unowned));
    expect(await call(keys.carol, 'DELETE', '/v1/memories/mem_missing')).toEqual(missing('mem_missing'));
    for (const id of [owned, ownedRaw, unowned]) expect(readEntry(root, id)?.supersededBy).toBeNull();
  });

  it('lets the owner archive, supersede and forget, keeps the successor theirs, and lets an admin act', async () => {
    const owned = await writes(keys.bob, 'the staging cluster restarts at noon', { owner: BOB });
    const ownedRaw = await writes(keys.bob, 'raw standup note about the staging cluster', { owner: BOB, kind: 'raw' });
    const unowned = await writes(keys.carol, 'the release train leaves on thursdays');

    expect((await call(keys.bob, 'POST', `/v1/memories/${ownedRaw}/archive`, { reason: 'r' }))[0]).toBe(200);
    const [status, reply] = await call(keys.bob, 'POST', `/v1/memories/${owned}/supersede`, { content: 'one pm now' });
    expect(status).toBe(200);
    // SAFETY: a 200 from the supersede route is a SupersedeResult.
    const { newId } = reply as { newId: string };
    expect(readEntry(root, newId)?.owner).toBe(BOB);
    expect(await call(keys.carol, 'DELETE', `/v1/memories/${newId}`)).toEqual(notTheirs(newId));
    expect(await call(keys.bob, 'DELETE', `/v1/memories/${newId}`)).toEqual([200, { ok: true, id: newId }]);
    expect(await call(keys.admin, 'DELETE', `/v1/memories/${unowned}`)).toEqual([200, { ok: true, id: unowned }]);
    expect([readEntry(root, ownedRaw), readEntry(root, newId), readEntry(root, unowned)]).toEqual([null, null, null]);
  });

  it('leaves the CLI operator every right on its own store', async () => {
    const owned = await writes(keys.bob, 'the staging cluster restarts at noon', { owner: BOB });
    const unowned = await writes(keys.carol, 'the release train leaves on thursdays');
    // The CLI hands a write to a running server, so it runs as the operator only with the server down.
    await handle.stop();
    stopped = true;
    const saved = process.cwd();
    process.chdir(base);
    try {
      for (const id of [owned, unowned]) {
        const run = await runInProcess(() => runCli(['node', 'hippo', 'forget', id]));
        expect(run.status, run.stdout + run.stderr).toBe(0);
      }
    } finally {
      process.chdir(saved);
    }
    expect([readEntry(root, owned), readEntry(root, unowned)]).toEqual([null, null]);
  });
});

describe('write rights on a team memory over MCP', () => {
  async function resolve(key: string, args: { [k: string]: JsonValue }): Promise<string> {
    const params = { name: 'hippo_resolve', arguments: args };
    const res = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
    });
    return res.text();
  }

  it("refuses hippo_resolve forget of another person's loser with the 403 text, and lets a member forget its own", async () => {
    const bobs = await writes(keys.bob, 'deploys run from the main branch', { owner: BOB });
    const carols = await writes(keys.carol, 'deploys never run from the main branch', { owner: CAROL });
    replaceDetectedConflicts(root, [{ memoryAId: bobs, memoryBId: carols, reason: 'deploy advice', score: 0.9 }]);
    const [conflict] = await listMemoryConflicts(root, 'open', 'default');
    const conflictId = conflict!.id;

    expect(await resolve(keys.carol, { conflict_id: conflictId, keep: carols, forget: true })).toContain(
      `memory ${bobs} was written by someone else: change it with the key that wrote it or an admin key`,
    );
    expect(readEntry(root, bobs)?.content).toBe('deploys run from the main branch');
    expect(await resolve(keys.carol, { conflict_id: conflictId, keep: bobs, forget: true })).toContain(
      `Resolved conflict ${conflictId}: kept ${bobs}, deleted ${carols}`,
    );
    expect(readEntry(root, carols)).toBeNull();
  });
});
