// MCP rebuilds the actor from McpContext, so the owner must ride every hop or MCP task state keys on the key id.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey, type CreateApiKeyResult } from '../src/auth.js';
import { ownerOrSubject } from '../src/api.js';
import { mcpActor, type McpContext } from '../src/mcp/protocol.js';
import { buildContextWithAuth } from '../src/server/auth.js';
import { mcpContextFor } from '../src/server/mcp-http.js';
import { sqliteStore } from '../src/store-port.js';
import { makeRoot } from './_helpers/make-root.js';

let home: string;

function mint(ownerSubject?: string): CreateApiKeyResult {
  const db = openHippoDb(home);
  try {
    return createApiKey(db, { tenantId: 'default', label: 'mcp-owner-test', role: 'member', ownerSubject });
  } finally {
    closeHippoDb(db);
  }
}

/** The McpContext POST /mcp hands a tool for this bearer: the real auth and the real hop, minus the network. */
async function mcpContextForBearer(token: string): Promise<McpContext> {
  const req = new IncomingMessage(new Socket());
  req.headers.authorization = `Bearer ${token}`;
  const ctx = await buildContextWithAuth(req, { hippoRoot: home, store: sqliteStore(home) });
  return mcpContextFor(ctx, 'http:test', undefined);
}

beforeEach(() => {
  home = makeRoot('mcp-actor-owner');
});

afterEach(() => {
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
    const ctx = await mcpContextForBearer(key.plaintext);
    expect(ctx.owner).toBe('alice@corp.example');
    const actor = mcpActor(ctx);
    expect(actor).toMatchObject({ subject: `api_key:${key.keyId}`, role: 'member', owner: 'alice@corp.example' });
    expect(ownerOrSubject(actor)).toBe('alice@corp.example');
  });

  it('unowned key over MCP: ownerOrSubject is the key id', async () => {
    const key = mint();
    const ctx = await mcpContextForBearer(key.plaintext);
    expect(ctx.owner).toBeUndefined();
    expect(ownerOrSubject(mcpActor(ctx))).toBe(`api_key:${key.keyId}`);
  });
});
