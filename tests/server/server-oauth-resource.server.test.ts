import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
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
const NO_RESOLVER = 'oauth needs an authResolver to check the tokens its authorization servers issue';
const NO_OBJECT = 'oauth must be an object with resource and authorizationServers';
const ISSUER_CHARS = (i: number): string =>
  `oauth.authorizationServers[${i}] must be printable ASCII only, with no space or control character`;
const ISSUER_FORM = (i: number, expected: string): string =>
  `oauth.authorizationServers[${i}] must be written as ${expected}, in normal URL form`;
const NOT_SERVERS_ARRAY = 'oauth.authorizationServers must be an array of strings';
const NOT_SCOPES_ARRAY = 'oauth.scopes must be an array of strings';
// SAFETY: an embedder that skips our types can pass any value; boot must refuse each of these.
const UNTYPED = { nothing: null as never, object: {} as never, text: 'hippo.memory' as never };
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

async function bootError(
  oauth: OAuthResource | undefined,
  extra: Overrides = { authResolver: resolver },
): Promise<Error | null> {
  return serve({
    hippoRoot: root,
    host: '127.0.0.1',
    port: 0,
    ...(oauth !== undefined && { oauth }),
    ...extra,
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

  it('derives the document path and the challenge from a prefixed resource', async () => {
    const resource = 'https://memory.example.com/prefix/mcp';
    const prefixed = '/.well-known/oauth-protected-resource/prefix/mcp';
    await boot({ resource, authorizationServers: AS, scopes: SCOPES });
    const doc = await send('GET', prefixed);
    expect(doc.status).toBe(200);
    expect(jsonOf(doc.text).resource).toBe(resource);
    const challenge = `Bearer resource_metadata="https://memory.example.com${prefixed}", scope="hippo.memory"`;
    expect((await callMcp()).challenge).toBe(challenge);
    expect((await send('GET', META)).status).toBe(404);
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
    ['server with a leading space', { authorizationServers: [' https://login.example.com'] }, ISSUER_CHARS(0)],
    ['server with a trailing newline', { authorizationServers: ['https://login.example.com\n'] }, ISSUER_CHARS(0)],
    ['server with an inner tab', { authorizationServers: ['https://login.exa\tmple.com'] }, ISSUER_CHARS(0)],
    [
      'second server with a space',
      { authorizationServers: [AS[0]!, 'https://login.example.com/a b'] },
      ISSUER_CHARS(1),
    ],
    [
      'server with an upper-case host',
      { authorizationServers: ['https://Login.example.com/'] },
      ISSUER_FORM(0, 'https://login.example.com/'),
    ],
    [
      'server with a default port',
      { authorizationServers: ['https://login.example.com:443/t'] },
      ISSUER_FORM(0, 'https://login.example.com/t'),
    ],
    [
      'server with a default port and no path',
      { authorizationServers: ['https://login.example.com:443'] },
      ISSUER_FORM(0, 'https://login.example.com'),
    ],
    [
      'server with an upper-case scheme',
      { authorizationServers: ['HTTPS://login.example.com'] },
      ISSUER_FORM(0, 'https://login.example.com'),
    ],
    [
      'server with a dot segment',
      { authorizationServers: ['https://login.example.com/a/../b'] },
      ISSUER_FORM(0, 'https://login.example.com/b'),
    ],
    [
      'server with a backslash',
      { authorizationServers: ['https://login.example.com\\t'] },
      ISSUER_FORM(0, 'https://login.example.com/t'),
    ],
    [
      'server with a hex IP host',
      { authorizationServers: ['https://0x08080808/t'] },
      ISSUER_FORM(0, 'https://8.8.8.8/t'),
    ],
    ['server with an IDN host', { authorizationServers: ['https://bücher.example'] }, ISSUER_CHARS(0)],
    ['server with a non-ASCII path', { authorizationServers: ['https://login.example.com/münchen'] }, ISSUER_CHARS(0)],
  ];

  it.each(refused)('refuses %s at boot with its fixed message and leaves no pidfile', async (_name, patch, message) => {
    const error = await bootError({ ...GOOD, ...patch });
    expect(error?.message).toBe(message);
    expect(existsSync(join(root, 'server.pid'))).toBe(false);
  });

  it('refuses oauth with no authResolver', async () => {
    const error = await bootError(GOOD, {});
    expect(error?.message).toBe(NO_RESOLVER);
    expect(existsSync(join(root, 'server.pid'))).toBe(false);
  });

  it.each([
    ['null authResolver', GOOD, { authResolver: UNTYPED.nothing }, NO_RESOLVER],
    ['authResolver that is no function', GOOD, { authResolver: UNTYPED.object }, NO_RESOLVER],
    ['null oauth', UNTYPED.nothing, { authResolver: resolver }, NO_OBJECT],
    ['string scopes', { ...GOOD, scopes: UNTYPED.text }, { authResolver: resolver }, NOT_SCOPES_ARRAY],
    [
      'string authorizationServers',
      { ...GOOD, authorizationServers: UNTYPED.text },
      { authResolver: resolver },
      NOT_SERVERS_ARRAY,
    ],
  ])('refuses a %s with its fixed message', async (_name, oauth, extra, message) => {
    expect((await bootError(oauth, extra))?.message).toBe(message);
  });

  describe('a setting from outside this realm or prototype chain', () => {
    // SAFETY: Object.create(null) and runInNewContext answer `any`; both hold exactly the GOOD fields.
    const bare: OAuthResource = Object.assign(Object.create(null), GOOD);
    const foreign: OAuthResource = runInNewContext(
      `({ resource: ${JSON.stringify(RESOURCE)}, authorizationServers: ${JSON.stringify(AS)}, scopes: ${JSON.stringify(SCOPES)} })`,
    );

    async function publishedDocument(oauth: OAuthResource): Promise<string> {
      await startOAuth(oauth);
      const text = (await send('GET', META)).text;
      await handle?.stop();
      handle = null;
      return text;
    }

    it.each([
      ['a null-prototype object', bare],
      ['an object made in another realm', foreign],
    ])('boots %s and publishes the document a plain object does', async (_name, oauth) => {
      expect(await publishedDocument(oauth)).toBe(await publishedDocument(GOOD));
    });

    it('accepts an authResolver made in another realm', async () => {
      // SAFETY: runInNewContext answers `any`; the function takes no argument and resolves to nothing.
      const authResolver: Overrides['authResolver'] = runInNewContext('(async () => undefined)');
      expect(await bootError(GOOD, { authResolver })).toBeNull();
    });
  });

  it('checks the setting before it claims the pidfile', async () => {
    await boot(GOOD);
    const error = await bootError({ ...GOOD, authorizationServers: [] });
    expect(error?.message).toBe('oauth.authorizationServers must list at least one authorization server');
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
