// hippo_remember with personal: true over real HTTP MCP and real keys, so a transport that drops the key's owner fails here.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { createApiKey } from '../src/store/auth.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { serve, type ServerHandle } from '../src/server.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { makeRoot } from './_helpers/make-root.js';

const NO_OWNER_TEXT = 'personal memories need a key its owner minted, or a sign-in; owner ids over 239 characters or with control characters cannot hold them';
const NOTE = 'quartzlamp: my own shell alias for the deploy script';

interface RpcReply {
  result?: { content: Array<{ text: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

let root: string;
let handle: ServerHandle;
let keyA: string;
let keyB: string;
let keyAdmin: string;

function mint(role: 'admin' | 'member', ownerSubject?: string): string {
  const db = openHippoDb(root);
  try {
    return createApiKey(db, { tenantId: 'default', role, ownerSubject }).plaintext;
  } finally {
    closeHippoDb(db);
  }
}

async function callTool(key: string, name: string, args: Record<string, string | boolean>): Promise<RpcReply> {
  const res = await fetch(`${handle.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  // SAFETY: handleMcpPost answers a JSON-RPC envelope; the test reads only result and error.
  return (await res.json()) as RpcReply;
}

beforeEach(async () => {
  root = makeRoot('mcp-personal-remember', { config: { embeddings: { enabled: false }, autoSleep: { enabled: false } } });
  keyA = mint('member', 'oid-a');
  keyB = mint('member', 'oid-b');
  keyAdmin = mint('admin');
  handle = await serve({ hippoRoot: root, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('hippo_remember personal over HTTP MCP', () => {
  it('an owned key stores the row in its owner\'s scope with origin \'\'', async () => {
    const reply = await callTool(keyA, 'hippo_remember', { text: NOTE, personal: true });
    expect(reply.error).toBeUndefined();
    expect(reply.result?.content[0]?.text).toMatch(/^Remembered \[/);
    const rows = loadAllEntries(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scope).toBe('personal:private:oid-a');
    expect(rows[0]?.origin_project).toBe('');
    expect(rows[0]?.content).toBe(NOTE);
  });

  it('an unowned admin key gets the 400 text and stores nothing, while the same key still writes a team row', async () => {
    const refused = await callTool(keyAdmin, 'hippo_remember', { text: NOTE, personal: true });
    expect(refused.result).toBeUndefined();
    expect(refused.error?.message).toBe(NO_OWNER_TEXT);
    expect(loadAllEntries(root)).toHaveLength(0);

    const team = await callTool(keyAdmin, 'hippo_remember', { text: 'team note from the admin key' });
    expect(team.error).toBeUndefined();
    expect(loadAllEntries(root).map((e) => e.scope)).toEqual([null]);
  });

  // Needs lane A's read sites (the owner's own scope admitted on recall); red on lane B alone.
  it('hippo_recall by the same key finds it, and another owner\'s key finds only the team row', async () => {
    await callTool(keyA, 'hippo_remember', { text: NOTE, personal: true });
    await callTool(keyB, 'hippo_remember', { text: 'quartzlamp: the team deploy script lives in ops' });
    const own = await callTool(keyA, 'hippo_recall', { query: 'quartzlamp shell alias deploy' });
    expect(own.result?.content[0]?.text).toContain('my own shell alias');
    for (const key of [keyB, keyAdmin]) {
      const other = await callTool(key, 'hippo_recall', { query: 'quartzlamp shell alias deploy' });
      expect(other.result?.content[0]?.text).toContain('the team deploy script');
      expect(JSON.stringify(other)).not.toContain('my own shell alias');
    }
  });
});
