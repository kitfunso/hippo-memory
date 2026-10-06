// MCP rebuilds the actor from McpContext, so the owner must ride every hop or MCP task state keys on the key id.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey, type CreateApiKeyResult } from '../src/auth.js';
import { ownerOrSubject } from '../src/api.js';
import { mcpActor, type McpContext, type ToolCall } from '../src/mcp/protocol.js';
import { serve, type ServerHandle } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';

// The tool sees only what the transport hands it, so the spy stands in for hippo_remember and records the ctx.
const seen = vi.hoisted(() => ({ calls: [] as Array<McpContext | undefined> }));
vi.mock('../src/mcp/memory-tools.js', async (importOriginal) => ({
  // SAFETY: importOriginal returns this same module; the spread keeps every other export real.
  ...(await importOriginal<typeof import('../src/mcp/memory-tools.js')>()),
  runRememberTool: (call: ToolCall): string => {
    seen.calls.push(call.ctx);
    return 'Remembered';
  },
}));

let home: string;
let handle: ServerHandle | undefined;

function mint(ownerSubject?: string): CreateApiKeyResult {
  const db = openHippoDb(home);
  try {
    return createApiKey(db, { tenantId: 'default', label: 'mcp-owner-test', role: 'member', ownerSubject });
  } finally {
    closeHippoDb(db);
  }
}

async function rememberOverHttp(token: string): Promise<McpContext> {
  handle = await serve({ hippoRoot: home, host: '127.0.0.1', port: 0 });
  const res = await fetch(`${handle.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_remember', arguments: { text: 'the build cache lives on the second disk' } } }),
  });
  expect(res.status).toBe(200);
  expect(seen.calls).toHaveLength(1);
  const ctx = seen.calls[0];
  expect(ctx).toBeDefined();
  return ctx!;
}

beforeEach(() => {
  home = makeRoot('mcp-actor-owner');
  seen.calls.length = 0;
});

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe('owner across the MCP hops', () => {
  it('mcpActor copies owner', () => {
    const base: McpContext = { hippoRoot: home, tenantId: 'default', actor: 'api_key:hk_x', role: 'member' };
    expect(mcpActor({ ...base, owner: 'alice@corp.example' }).owner).toBe('alice@corp.example');
    expect('owner' in mcpActor(base)).toBe(false);
    expect('owner' in mcpActor(undefined)).toBe(false);
  });

  it('MCP over HTTP with an owned key: the tool sees owner', async () => {
    const key = mint('alice@corp.example');
    const ctx = await rememberOverHttp(key.plaintext);
    expect(ctx.owner).toBe('alice@corp.example');
    const actor = mcpActor(ctx);
    expect(actor).toMatchObject({ subject: `api_key:${key.keyId}`, role: 'member', owner: 'alice@corp.example' });
    expect(ownerOrSubject(actor)).toBe('alice@corp.example');
  });

  it('unowned key over MCP: ownerOrSubject is the key id', async () => {
    const key = mint();
    const ctx = await rememberOverHttp(key.plaintext);
    expect(ctx.owner).toBeUndefined();
    expect(ownerOrSubject(mcpActor(ctx))).toBe(`api_key:${key.keyId}`);
  });
});
