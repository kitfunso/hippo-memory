import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { rmSync } from 'node:fs';
import {
  authCreateSelf,
  VIEWER_REFUSAL,
  type AddonRoute,
  type AuthResolver,
  type JsonValue,
  type ResolvedBearer,
  type ServerHandle,
} from '../../src/server.js';
import { ROUTE_GROUPS, serve } from '../_helpers/store-switch.js';
import { makeRoot } from '../_helpers/make-root.js';
import { initTestStore } from '../_helpers/store-template.js';
import { ADMIN_LEVEL, READ_POSTS, V1_ROWS, VIEWER_WRITES } from '../_helpers/v1-route-rows.js';
import { routeLabel } from '../../src/surface/server/route-table.js';

const TENANT = 't-roles';
const OUTSIDE_LADDER = ['ext.owner', 'ext.cased', 'ext.editor-name', 'ext.none'];
const TOKENS = new Map<string, string | undefined>([
  ['ext.viewer', 'viewer'],
  ['ext.editor', 'member'],
  ['ext.admin', 'admin'],
  ['ext.owner', 'owner'],
  ['ext.cased', 'Viewer'],
  ['ext.editor-name', 'editor'],
  ['ext.none', undefined],
]);

const resolver: AuthResolver = (token) => {
  if (!TOKENS.has(token)) return null;
  // SAFETY: a role outside the ladder, or none, is the case under test, and the type would refuse it.
  return { tenantId: TENANT, subject: `user-${token}`, role: TOKENS.get(token), scopes: [] } as ResolvedBearer;
};

function addon(path: string, level?: AddonRoute['level']): AddonRoute {
  const handler = async (): Promise<JsonValue> => ({ ok: true });
  return level === undefined ? { path, handler } : { path, handler, level };
}

const MINT_OWN: AddonRoute = {
  path: '/v1/x-mint',
  level: 'viewer',
  handler: async ({ ctx }) => ({ keyId: (await authCreateSelf(ctx, { ttlDays: 1, perSubject: 1 })).keyId }),
};
const ROUTES = [addon('/v1/x-write'), addon('/v1/x-read', 'viewer'), addon('/v1/x-admin', 'admin'), MINT_OWN];

const SERVE_OPTIONS = {
  host: '127.0.0.1',
  port: 0,
  authResolver: resolver,
  routes: ROUTES,
  keep: ROUTE_GROUPS,
  rateLimits: { perCaller: 'off', perAddress: 'off' },
} as const;

let root: string;
let handle: ServerHandle;

function call(token: string, method: string, path: string, body: JsonValue = {}): Promise<Response> {
  return fetch(`${handle.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}

async function statusAndText(res: Response): Promise<{ status: number; text: string }> {
  return { status: res.status, text: await res.text() };
}

const pathOf = (label: string): string => label.replace(/:\w+/g, '1');
const rowCall = (token: string, key: string): Promise<Response> => {
  const [method = '', label = ''] = key.split(' ');
  return call(token, method, pathOf(label));
};

const ADMIN_ROWS = V1_ROWS.filter(({ key }) => ADMIN_LEVEL.has(key));
const isWebhook = (auth: string): boolean => auth === 'webhook-signature';
const EDITOR_ROWS = V1_ROWS.filter(
  ({ key, route }) =>
    !ADMIN_LEVEL.has(key) &&
    !isWebhook(route.auth) &&
    route.method !== 'GET' &&
    !READ_POSTS.has(key) &&
    !VIEWER_WRITES.has(key),
);

interface McpReply {
  result: { isError?: boolean; content: { text: string }[] };
}

async function mcpRemember(token: string): Promise<{ isError?: boolean; text: string }> {
  const res = await call(token, 'POST', '/mcp', {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'hippo_remember', arguments: { text: 'a note from the role test' } },
  });
  const reply: McpReply = await res.json();
  return { isError: reply.result.isError, text: reply.result.content[0]?.text ?? '' };
}

beforeAll(async () => {
  vi.stubEnv('HIPPO_V1_RPS', '0');
  root = makeRoot('route-roles');
  initTestStore(root);
  handle = await serve({ hippoRoot: root, ...SERVE_OPTIONS });
});

afterAll(async () => {
  await handle.stop();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('a viewer signed in through an auth resolver', () => {
  it('is refused on every editor row with the viewer text', async () => {
    expect(EDITOR_ROWS).toHaveLength(30);
    const seen: Record<string, { status: number; text: string }> = {};
    for (const { key } of EDITOR_ROWS) seen[key] = await statusAndText(await rowCall('ext.viewer', key));
    const wanted = Object.fromEntries(
      EDITOR_ROWS.map(({ key }) => [key, { status: 403, text: expect.stringContaining(VIEWER_REFUSAL) }]),
    );
    expect(seen).toEqual(wanted);
  });

  it('is refused on every admin-level row with the admin text of that row', async () => {
    expect(ADMIN_ROWS).toHaveLength(9);
    for (const { key, route } of ADMIN_ROWS) {
      const { status, text } = await statusAndText(await rowCall('ext.viewer', key));
      expect({ key, status }).toEqual({ key, status: 403 });
      expect(text).toContain(`${routeLabel(route)} requires admin role`);
    }
  });

  it('reads, but is refused on an add-on route with no level and on an admin one', async () => {
    expect((await call('ext.viewer', 'GET', '/v1/memories?q=x')).status).toBe(200);
    const write = await statusAndText(await call('ext.viewer', 'POST', '/v1/x-write'));
    expect(write.status).toBe(403);
    expect(write.text).toContain(VIEWER_REFUSAL);
    expect((await call('ext.viewer', 'POST', '/v1/x-read')).status).toBe(200);
    expect((await call('ext.viewer', 'POST', '/v1/x-admin')).status).toBe(403);
  });

  it('is refused the MCP write tools', async () => {
    expect(await mcpRemember('ext.viewer')).toEqual({ isError: true, text: VIEWER_REFUSAL });
  });
});

describe('an editor and an admin', () => {
  it('lets an editor write but not reach an admin row or an admin add-on route', async () => {
    for (const { key, route } of ADMIN_ROWS) {
      const { status, text } = await statusAndText(await rowCall('ext.editor', key));
      expect({ key, status }).toEqual({ key, status: 403 });
      expect(text).toContain(`${routeLabel(route)} requires admin role`);
    }
    expect((await call('ext.editor', 'POST', '/v1/memories', { content: 'an editor note' })).status).toBe(200);
    expect((await call('ext.editor', 'POST', '/v1/x-admin')).status).toBe(403);
    expect((await call('ext.editor', 'POST', '/v1/x-write')).status).toBe(200);
  });

  it('lets an admin reach an admin add-on route', async () => {
    expect((await call('ext.admin', 'POST', '/v1/x-admin')).status).toBe(200);
  });

  it('refuses to boot an add-on route with a level outside the ladder', async () => {
    // SAFETY: a level outside the ladder is the case under test, and the type would refuse it.
    const bad = { path: '/v1/x-bad', level: 'owner', handler: async () => ({}) } as never;
    await expect(serve({ hippoRoot: root, ...SERVE_OPTIONS, routes: [bad] })).rejects.toThrow(
      "add-on route '/v1/x-bad' has an unknown level; use viewer, editor or admin",
    );
  });
});

describe('a resolver role outside the ladder, or none', () => {
  it.each(OUTSIDE_LADDER)('reads as a viewer for %s: refused every write, still reads', async (token) => {
    const writes = [
      await statusAndText(await call(token, 'POST', '/v1/memories', { content: 'an odd-role note' })),
      await statusAndText(await call(token, 'POST', '/v1/outcome', { good: true })),
      await statusAndText(await call(token, 'POST', '/v1/x-mint')),
    ];
    const refused = { status: 403, text: expect.stringContaining(VIEWER_REFUSAL) };
    expect(writes).toEqual([refused, refused, refused]);
    expect((await call(token, 'GET', '/v1/memories?q=x')).status).toBe(200);
  });

  it('lets an editor mint its own key, so the refusals above come from the role', async () => {
    expect((await call('ext.editor', 'POST', '/v1/x-mint')).status).toBe(200);
  });
});

describe('the request trail', () => {
  let trailRoot: string;
  let trailHandle: ServerHandle;
  let stderr: MockInstance<typeof process.stderr.write>;
  const lines = (): string[] => stderr.mock.calls.map((c) => String(c[0]));

  const leaky: AuthResolver = (token) => {
    if (token !== 'ext.leaky') return null;
    // SAFETY: a resolver that also returns a groups claim, to prove core never logs one.
    return { tenantId: TENANT, subject: 'user-leaky', role: 'viewer', groups: ['g-secret-7f3a'] } as ResolvedBearer;
  };

  beforeAll(async () => {
    vi.stubEnv('HIPPO_LOG', 'info');
    vi.stubEnv('HIPPO_LOG_FORMAT', 'json');
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    trailRoot = makeRoot('route-roles-trail');
    initTestStore(trailRoot);
    trailHandle = await serve({ hippoRoot: trailRoot, ...SERVE_OPTIONS, authResolver: leaky, routes: [] });
  });

  afterAll(async () => {
    await trailHandle.stop();
    stderr.mockRestore();
    vi.unstubAllEnvs();
    rmSync(trailRoot, { recursive: true, force: true });
  });

  const send = (method: string, path: string, id: string): Promise<Response> =>
    fetch(`${trailHandle.url}${path}`, {
      method,
      headers: { authorization: 'Bearer ext.leaky', 'content-type': 'application/json', 'x-request-id': id },
      body: method === 'GET' ? undefined : '{}',
    });

  it('names the role of a viewer on its line', async () => {
    await (await send('GET', '/v1/memories?q=x', 'role-1')).arrayBuffer();
    await vi.waitFor(() =>
      expect(lines().some((l) => l.includes('role-1') && l.includes('"role":"viewer"'))).toBe(true),
    );
  });

  it('never writes the groups claim to the log, on a 200 or a 403', async () => {
    expect((await send('GET', '/v1/memories?q=x', 'role-2')).status).toBe(200);
    expect((await send('POST', '/v1/memories', 'role-3')).status).toBe(403);
    await vi.waitFor(() => expect(lines().some((l) => l.includes('role-3'))).toBe(true));
    expect(lines().join('')).not.toContain('g-secret-7f3a');
  });
});
