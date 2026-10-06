// Recall's continuity block on a shared store is the caller's own task state, keyed by owner and project, or empty.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
import { recall, type Context } from '../src/api.js';
import { _resetSharedStoreCacheForTests } from '../src/config.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { saveActiveTaskSnapshot } from '../src/store/sessions.js';
import { saveSessionHandoff } from '../src/store/handoffs.js';
import { serve, type ServerHandle } from '../src/server.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { makeRoot } from './_helpers/make-root.js';

const P = { name: 'p', legacyName: 'p' } as const;
const EMPTY = { activeSnapshot: null, sessionHandoff: null, recentSessionEvents: [] };

let home: string;
let handle: ServerHandle | undefined;

const ctx = (owner: string): Context => ({ hippoRoot: home, tenantId: 'default', actor: { subject: `api_key:hk_${owner}`, role: 'member', owner } });

function snap(task: string, session: string) {
  return { task, summary: `${task} summary`, next_step: `${task} next`, session_id: session };
}

beforeEach(() => {
  _resetSharedStoreCacheForTests();
});

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  _resetSharedStoreCacheForTests();
  rmSync(home, { recursive: true, force: true });
});

describe('continuity on a shared store', () => {
  beforeEach(() => {
    home = makeRoot('recall-continuity-owner', { config: { sharedStore: true } });
  });

  it('A and B recall with a project each see only their own continuity', () => {
    const a = saveActiveTaskSnapshot(home, 'default', snap('alice task', 'sa'), { owner: 'alice', project: ['p'] });
    saveSessionHandoff(home, 'default', { version: 1, sessionId: 'sa', summary: 'alice handoff' }, { owner: 'alice', project: ['p'] });
    const b = saveActiveTaskSnapshot(home, 'default', snap('bob task', 'sb'), { owner: 'bob', project: ['p'] });
    const forA = recall(ctx('alice'), { query: 'anything', includeContinuity: true, project: P }).continuity;
    const forB = recall(ctx('bob'), { query: 'anything', includeContinuity: true, project: P }).continuity;
    expect(forA?.activeSnapshot?.id).toBe(a.id);
    expect(forA?.sessionHandoff?.summary).toBe('alice handoff');
    expect(forB?.activeSnapshot?.id).toBe(b.id);
    expect(forB?.sessionHandoff).toBeNull();
  });

  it('no project: empty block on REST recall and MCP hippo_recall', async () => {
    // Ownerless rows and other people's rows are what an unkeyed read would hand to anyone.
    saveActiveTaskSnapshot(home, 'default', snap('legacy task', 'sl'));
    const a = saveActiveTaskSnapshot(home, 'default', snap('alice task', 'sa'), { owner: 'alice', project: ['p'] });
    writeEntry(home, createMemory('the deploy script lives in ops/deploy.sh'));
    expect(recall(ctx('alice'), { query: 'deploy', includeContinuity: true, project: P }).continuity?.activeSnapshot?.id).toBe(a.id);
    expect(recall(ctx('alice'), { query: 'deploy', includeContinuity: true }).continuity).toEqual(EMPTY);

    const db = openHippoDb(home);
    const key = (() => { try { return createApiKey(db, { tenantId: 'default', role: 'member', ownerSubject: 'alice' }); } finally { closeHippoDb(db); } })();
    handle = await serve({ hippoRoot: home, host: '127.0.0.1', port: 0 });
    const auth = { authorization: `Bearer ${key.plaintext}` };
    const rest = await fetch(`${handle.url}/v1/memories?q=deploy&include_continuity=1`, { headers: auth });
    expect(rest.status).toBe(200);
    // SAFETY: the route sends the whole RecallResult; only continuity is read.
    expect(((await rest.json()) as { continuity: unknown }).continuity).toEqual(EMPTY);

    const mcp = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_recall', arguments: { query: 'deploy', include_continuity: true } } }),
    });
    expect(mcp.status).toBe(200);
    // SAFETY: a tools/call reply carries one text content item.
    const text = ((await mcp.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    expect(text).toContain('ops/deploy.sh');
    expect(text).not.toContain('alice task');
    expect(text).not.toContain('legacy task');
  });
});

describe('continuity on a local store', () => {
  beforeEach(() => {
    home = makeRoot('recall-continuity-local');
  });

  it('local store: continuity unchanged', () => {
    saveActiveTaskSnapshot(home, 'default', snap('older task', 's0'));
    const newest = saveActiveTaskSnapshot(home, 'default', snap('local task', 's1'));
    saveSessionHandoff(home, 'default', { version: 1, sessionId: 's1', summary: 'local handoff' });
    const block = recall(ctx('alice'), { query: 'anything', includeContinuity: true }).continuity;
    expect(block?.activeSnapshot?.id).toBe(newest.id);
    expect(block?.sessionHandoff?.summary).toBe('local handoff');
  });
});
