// A viewer reads what a member with no grants reads: no restricted scope, and no one else's personal scope.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import * as api from '../../src/api/index.js';
import { canReadScope, scopeReaderOf } from '../../src/base/scope/recall-scope.js';
import { serve, type AuthResolver, type ResolvedBearer, type ServerHandle } from '../../src/server.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';

const TENANT = 'default';
const PRIVATE = 'slack:private:C1';
const PERSONAL = 'personal:private:oid-a';
const PRIVATE_TEXT = 'quartzlamp is the alias for the private channel runbook';
const PERSONAL_TEXT = 'quartzlamp is the alias for my own deploy script';

const PEOPLE = new Map<string, ResolvedBearer>([
  ['ext.viewer', { tenantId: TENANT, subject: 'viewer@corp.example', role: 'viewer' }],
  ['ext.member', { tenantId: TENANT, subject: 'member@corp.example', role: 'member' }],
  ['ext.admin', { tenantId: TENANT, subject: 'admin@corp.example', role: 'admin' }],
]);
const resolver: AuthResolver = (token) => PEOPLE.get(token) ?? null;

let root: string;
let handle: ServerHandle;

beforeAll(async () => {
  root = makeRoot('viewer-read-scope', { config: { embeddings: { enabled: false } } });
  await api.remember(apiCtx(root, TENANT, api.adminActor('cli')), { content: PRIVATE_TEXT, scope: PRIVATE });
  const owner: api.Actor = { subject: 'api_key:hk_a', role: 'member', owner: 'oid-a' };
  await api.remember(apiCtx(root, TENANT, owner), { content: PERSONAL_TEXT, personal: true });
  handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0, authResolver: resolver });
});

afterAll(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
});

interface Reply {
  status: number;
  text: string;
}

async function recall(token: string, scope?: string): Promise<Reply> {
  const query = scope === undefined ? '' : `&scope=${encodeURIComponent(scope)}`;
  const res = await fetch(`${handle.url}/v1/memories?q=quartzlamp${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, text: await res.text() };
}

async function mcpRecall(token: string, scope?: string): Promise<Reply> {
  const args = scope === undefined ? { query: 'quartzlamp' } : { query: 'quartzlamp', scope };
  const res = await fetch(`${handle.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'hippo_recall', arguments: args },
    }),
  });
  return { status: res.status, text: await res.text() };
}

describe.each([
  ['HTTP', recall],
  ['MCP', mcpRecall],
])('a viewer reading over %s', (_transport, read) => {
  it('is shown the restricted row by an admin, so the refusals below hide a real row', async () => {
    const reply = await read('ext.admin', PRIVATE);
    expect(reply.text).toContain(PRIVATE_TEXT);
  });

  it('is refused a restricted scope exactly as a member with no grants is', async () => {
    const viewer = await read('ext.viewer', PRIVATE);
    const member = await read('ext.member', PRIVATE);
    expect(viewer.text).not.toContain(PRIVATE_TEXT);
    expect(viewer).toEqual(member);
    expect(viewer.text).toContain('requires admin role');
  });

  it("is never shown another person's personal scope", async () => {
    const viewer = await read('ext.viewer', PERSONAL);
    const member = await read('ext.member', PERSONAL);
    expect(viewer.text).not.toContain(PERSONAL_TEXT);
    expect(viewer).toEqual(member);
    expect(viewer.text).toContain('requires admin role');
  });

  it('finds neither row in a recall that names no scope', async () => {
    const viewer = await read('ext.viewer');
    expect(viewer.status).toBe(200);
    expect(viewer.text).not.toContain(PRIVATE_TEXT);
    expect(viewer.text).not.toContain(PERSONAL_TEXT);
  });
});

describe('the scope rule a viewer reads under', () => {
  const viewer: api.Actor = { subject: 'viewer@corp.example', role: 'viewer', owner: 'oid-v', viaAuthResolver: true };
  const member: api.Actor = { ...viewer, role: 'member' };

  it('reaches what a member with no grants reaches, and nothing else', () => {
    for (const scope of [null, 'team:public', PRIVATE, PERSONAL, 'personal:private:oid-v']) {
      expect({ scope, reads: canReadScope(viewer, scope) }).toEqual({ scope, reads: canReadScope(member, scope) });
    }
    expect(canReadScope(viewer, PRIVATE)).toBe(false);
    expect(canReadScope(viewer, PERSONAL)).toBe(false);
  });

  it('reads as a member to the store, never as an admin', () => {
    expect(scopeReaderOf(viewer).role).toBe('member');
  });
});
