// serve({ oauth }): /mcp as an OAuth protected resource: the path-suffixed metadata and the POST /mcp 401 challenge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isJsonObject, parseJson, type JsonObject, type JsonValue } from '../../src/base/util/json.js';
import type { OAuthResource, ResolvedBearer, ServerHandle } from '../../src/server.js';
import { serve } from '../_helpers/store-switch.js';
import { mintAdminKey } from '../_helpers/admin-server.js';
import { makeRoot } from '../_helpers/make-root.js';

const RESOURCE = 'https://memory.example.com/mcp';
const AS = ['https://login.example.com/tenant-1', 'http://127.0.0.1:9999'];
const SCOPES = ['hippo.memory'];
const META = '/.well-known/oauth-protected-resource/mcp';
const METADATA_URL = `https://memory.example.com${META}`;
const CHALLENGE = `Bearer resource_metadata="${METADATA_URL}", scope="hippo.memory"`;
const INVALID = `${CHALLENGE}, error="invalid_token"`;
const GOOD: OAuthResource = { resource: RESOURCE, authorizationServers: AS, scopes: SCOPES };
const CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_status', arguments: {} } };
const MEMBER: ResolvedBearer = { tenantId: 'default', subject: 'user-1', role: 'member' };

function resolver(token: string): ResolvedBearer | null {
  if (token === 'ext.good') return MEMBER;
  if (token === 'ext.down') throw new Error('idp down');
  return null;
}

let root: string;
let handle: ServerHandle | null = null;

beforeEach(() => {
  vi.stubEnv('HIPPO_V1_RPS', '0');
  root = makeRoot('oauth-resource');
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  vi.unstubAllEnvs();
});

type Overrides = Partial<Parameters<typeof serve>[0]>;

async function boot(oauth: OAuthResource | undefined, extra: Overrides = {}): Promise<void> {
  // hippo_status needs the reports group, which the port-only store drops unless kept.
  handle = await serve({
    hippoRoot: root,
    host: '127.0.0.1',
    port: 0,
    keep: ['reports'],
    rateLimits: { perCaller: 'off' },
    authResolver: resolver,
    ...(oauth !== undefined && { oauth }),
    ...extra,
  });
}

async function startOAuth(oauth: OAuthResource = GOOD, extra: Overrides = {}): Promise<void> {
  await boot(oauth, extra);
  expect((await fetch(`${handle!.url}${META}`)).status).toBe(200);
}

interface Reply {
  status: number;
  challenge: string | null;
  text: string;
}

async function send(method: string, path: string, authorization?: string, body?: JsonValue): Promise<Reply> {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(`${handle!.url}${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, challenge: res.headers.get('www-authenticate'), text: await res.text() };
}

function jsonOf(text: string): JsonObject {
  const value = parseJson(text);
  if (!isJsonObject(value)) throw new Error(`not a JSON object: ${text}`);
  return value;
}

const callMcp = (authorization?: string): Promise<Reply> => send('POST', '/mcp', authorization, CALL);

/** The error serve() throws for this setting, or null when it started; a started server is stopped. */
async function bootError(oauth: OAuthResource | undefined, withResolver = true): Promise<Error | null> {
  return serve({
    hippoRoot: root,
    host: '127.0.0.1',
    port: 0,
    ...(withResolver && { authResolver: resolver }),
    ...(oauth !== undefined && { oauth }),
  }).then(
    async (h) => {
      await h.stop();
      return null;
    },
    (err: Error) => err,
  );
}

describe('the protected-resource metadata', () => {
  it('serves the document at the path-suffixed URL as JSON, and nothing at the root path', async () => {
    await startOAuth();
    const res = await fetch(`${handle!.url}${META}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: AS,
      bearer_methods_supported: ['header'],
      scopes_supported: SCOPES,
    });
    expect((await send('GET', '/.well-known/oauth-protected-resource')).status).toBe(404);
  });

  it('leaves scopes out of the document and the challenge when none are set', async () => {
    await startOAuth({ resource: RESOURCE, authorizationServers: AS });
    const doc = jsonOf((await send('GET', META)).text);
    expect(Object.keys(doc)).not.toContain('scopes_supported');
    expect((await callMcp()).challenge).toBe(`Bearer resource_metadata="${METADATA_URL}"`);
  });

  it('keeps the document and the challenge from the setting as it was at boot', async () => {
    const live = { resource: RESOURCE, authorizationServers: [...AS], scopes: [...SCOPES] };
    await startOAuth(live);
    live.resource = 'https://evil.example.com/other/mcp';
    live.scopes = ['evil.scope'];
    const doc = jsonOf((await send('GET', META)).text);
    expect(doc.resource).toBe(RESOURCE);
    expect(doc.scopes_supported).toEqual(SCOPES);
    expect((await callMcp()).challenge).toBe(CHALLENGE);
  });
});

describe('the /mcp challenge', () => {
  it('names the metadata on a POST /mcp 401 with no Authorization', async () => {
    await startOAuth();
    const reply = await callMcp();
    expect(reply.status).toBe(401);
    expect(reply.challenge).toBe(CHALLENGE);
  });

  it('leaves the /mcp/stream and /v1 401s bare, because the document names the /mcp resource', async () => {
    await startOAuth();
    for (const path of ['/mcp/stream', '/v1/memories']) {
      const reply = await send('GET', path);
      expect(reply.status).toBe(401);
      expect(reply.challenge ?? '').not.toContain('resource_metadata');
    }
  });

  it('lets a token the resolver vouches for through with no challenge', async () => {
    await startOAuth();
    const reply = await callMcp('Bearer ext.good');
    expect(reply.status).toBe(200);
    expect(jsonOf(reply.text).result).toBeDefined();
    expect(reply.challenge).toBeNull();
  });

  it('adds invalid_token to a 401 for a token the resolver refuses', async () => {
    await startOAuth();
    const reply = await callMcp('Bearer ext.bad');
    expect(reply.status).toBe(401);
    expect(reply.challenge).toBe(INVALID);
  });

  it('sends no challenge on a 503 from a resolver that threw', async () => {
    await startOAuth();
    const reply = await callMcp('Bearer ext.down');
    expect(reply.status).toBe(503);
    expect(reply.challenge).toBeNull();
  });

  it('sends no challenge on a 429 from inside the auth check', async () => {
    await startOAuth(GOOD, { keyQuota: () => ({ retryAfterSec: 1, message: 'slow down' }) });
    const reply = await callMcp('Bearer ext.good');
    expect(reply.status).toBe(429);
    expect(reply.challenge).toBeNull();
  });

  it('keeps hk_ keys working with no challenge', async () => {
    const key = mintAdminKey(root);
    await startOAuth();
    const reply = await callMcp(`Bearer ${key}`);
    expect(reply.status).toBe(200);
    expect(jsonOf(reply.text).result).toBeDefined();
    expect(reply.challenge).toBeNull();
  });
});

describe('a refused oauth setting', () => {
  const refused: ReadonlyArray<readonly [string, Partial<OAuthResource>, string]> = [
    [
      'http resource',
      { resource: 'http://memory.example.com/mcp' },
      'oauth.resource must use https unless it is on this machine',
    ],
    [
      'empty servers',
      { authorizationServers: [] },
      'oauth.authorizationServers must list at least one authorization server',
    ],
    [
      'root resource',
      { resource: 'https://memory.example.com/' },
      'oauth.resource must be the public URL of /mcp, so its path ends in /mcp',
    ],
    [
      'upper-case host',
      { resource: 'https://Memory.example.com/mcp' },
      'oauth.resource must be written as https://memory.example.com/mcp',
    ],
    [
      'default port',
      { resource: 'https://memory.example.com:443/mcp' },
      'oauth.resource must be written as https://memory.example.com/mcp',
    ],
    ['query', { resource: 'https://memory.example.com/mcp?x=1' }, 'oauth.resource must have no query or fragment'],
    ['fragment', { resource: 'https://memory.example.com/mcp#f' }, 'oauth.resource must have no query or fragment'],
    [
      'encoded slash',
      { resource: 'https://memory.example.com/a%2Fb/mcp' },
      'oauth.resource must not encode a slash in its path',
    ],
    [
      'lower-case encoded slash',
      { resource: 'https://memory.example.com/a%2fb/mcp' },
      'oauth.resource must not encode a slash in its path',
    ],
    ['no scopes listed', { scopes: [] }, 'oauth.scopes must list at least one scope when set'],
    [
      'scope with a space',
      { scopes: ['a b'] },
      'oauth.scopes[0] must be one scope token: no space, quote or backslash',
    ],
    ['offline_access', { scopes: ['offline_access'] }, 'oauth.scopes must not ask for offline_access'],
    [
      'http server',
      { authorizationServers: ['http://login.example.com/'] },
      'oauth.authorizationServers[0] must use https unless it is on this machine',
    ],
  ];

  it.each(refused)('refuses %s at boot with its fixed message and leaves no pidfile', async (_name, patch, message) => {
    const error = await bootError({ ...GOOD, ...patch });
    expect(error?.message).toBe(message);
    expect(existsSync(join(root, 'server.pid'))).toBe(false);
  });

  it('refuses oauth with no authResolver', async () => {
    const error = await bootError(GOOD, false);
    expect(error?.message).toBe('oauth needs an authResolver to check the tokens its authorization servers issue');
    expect(existsSync(join(root, 'server.pid'))).toBe(false);
  });

  it('boots a loopback http resource and serves its document', async () => {
    const resource = 'http://127.0.0.1:6789/mcp';
    await boot({ resource, authorizationServers: AS });
    const res = await fetch(`${handle!.url}${META}`);
    expect(res.status).toBe(200);
    expect(jsonOf(await res.text()).resource).toBe(resource);
  });
});

describe('with no oauth setting', () => {
  it('serves no document and sends no resource_metadata on a 401', async () => {
    await boot(undefined);
    const meta = await send('GET', META);
    expect(meta.status).toBe(404);
    expect(meta.text).toBe('{"error":"not found"}');
    const reply = await callMcp();
    expect(reply.status).toBe(401);
    expect(reply.challenge ?? '').not.toContain('resource_metadata');
  });
});
