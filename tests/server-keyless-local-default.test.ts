// A request with no key is refused by default, on loopback too; HIPPO_ALLOW_KEYLESS_LOCAL=1 is the one switch that lets this machine's own user in.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey } from '../src/store/auth.js';
import { queryAuditEvents } from '../src/store/audit.js';
import { serve, type ServerHandle } from '../src/server.js';
import { presentConnectionsAsRemote } from './_helpers/listen.js';
import { makeRoot } from './_helpers/make-root.js';

const MODE_KEYS = ['HIPPO_ALLOW_KEYLESS_LOCAL', 'HIPPO_REQUIRE_AUTH'] as const;
const PLAIN_REFUSAL = 'auth required';

/** The fields these tests read: a refusal carries `error`, /health the rest. */
interface ReplyBody {
  readonly error?: string;
  readonly ok?: boolean;
  readonly pid?: number;
  readonly version?: string;
}

interface Reply {
  readonly status: number;
  /** The `error` field of a JSON reply, or '' when the reply has none. */
  readonly error: string;
  readonly json: ReplyBody;
}

interface Call {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

let home: string;
let handle: ServerHandle;
let apiKey: string;
const saved = new Map<string, string | undefined>();

function parsed(text: string): ReplyBody {
  try {
    // SAFETY: every route under test answers with a JSON object, and each test asserts the fields it reads.
    return JSON.parse(text) as ReplyBody;
  } catch {
    return {};
  }
}

function call(path: string, { method = 'GET', headers = {}, body }: Call = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: handle.port, method, path, headers: { ...headers } }, (res) => {
      const status = res.statusCode ?? 0;
      // An accepted event stream never ends on its own, so its status line is the whole answer.
      if (String(res.headers['content-type']).startsWith('text/event-stream')) {
        res.destroy();
        resolve({ status, error: '', json: {} });
        return;
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => {
        const json = parsed(text);
        resolve({ status, error: json.error ?? '', json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const recall = (headers: Readonly<Record<string, string>> = {}): Promise<Reply> => call('/v1/memories?q=deploy', { headers });

function remember(content: string, headers: Readonly<Record<string, string>> = {}): Promise<Reply> {
  return call('/v1/memories', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ content }) });
}

function rememberActors(): string[] {
  const db = openHippoDb(home);
  try {
    return queryAuditEvents(db, { tenantId: 'default', op: 'remember' }).map((event) => event.actor);
  } finally {
    closeHippoDb(db);
  }
}

beforeEach(async () => {
  for (const key of MODE_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  home = makeRoot('keyless-default');
  const db = openHippoDb(home);
  try {
    apiKey = createApiKey(db, { tenantId: 'default', label: 'keyless-default' }).plaintext;
  } finally {
    closeHippoDb(db);
  }
  handle = await serve({ hippoRoot: home, port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
  for (const key of MODE_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Requests that reach the loopback socket without being this machine's own user. */
const NOT_LOCAL: ReadonlyArray<readonly [string, () => Record<string, string>]> = [
  ['a proxied request', () => ({ 'x-forwarded-for': '203.0.113.7' })],
  ['a rebound Host', () => ({ host: `evil.example:${handle.port}` })],
  ['a cross-site page', () => ({ 'sec-fetch-site': 'cross-site' })],
  ['a page of another origin', () => ({ origin: 'http://evil.example' })],
];

describe('a request with no key, by default', () => {
  it('is refused 401 with a message that names both fixes, and writes nothing', async () => {
    const reply = await remember('keyless-default-canary');
    expect(reply.status).toBe(401);
    expect(reply.error).toBe(
      'auth required: this server takes no request without an API key. Mint one with `hippo auth create` and send it as ' +
        '"Authorization: Bearer <key>" (the hippo CLI reads HIPPO_API_KEY), or start the server with HIPPO_ALLOW_KEYLESS_LOCAL=1 ' +
        'to let requests from this machine in without a key.',
    );
    expect(rememberActors()).toEqual([]);
  });

  it.each([
    ['a read', '/v1/memories?q=deploy', 'GET'],
    ['an admin route', '/v1/auth/keys', 'GET'],
    ['an MCP call', '/mcp', 'POST'],
    ['the MCP event stream', '/mcp/stream', 'GET'],
  ])('refuses %s', async (_name, path, method) => {
    const body = method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) : undefined;
    const reply = await call(path, { method, headers: { 'content-type': 'application/json' }, body });
    expect(reply.status).toBe(401);
    expect(reply.error).toMatch(/^auth required: /);
  });

  it('serves the same request once it carries a key', async () => {
    const reply = await remember('keyed-default-canary', { authorization: `Bearer ${apiKey}` });
    expect(reply.status).toBe(200);
    expect(rememberActors()).toEqual([expect.stringMatching(/^api_key:/)]);
  });

  it.each(NOT_LOCAL)('tells %s nothing about the switch', async (_name, headers) => {
    const reply = await recall(headers());
    expect(reply.status).toBe(401);
    expect(reply.error).toBe(PLAIN_REFUSAL);
  });

  it('tells a caller from another machine nothing about the switch', async () => {
    presentConnectionsAsRemote(handle.server!);
    const reply = await recall();
    expect(reply.status).toBe(401);
    expect(reply.error).toBe(PLAIN_REFUSAL);
  });

  it.each(['0', 'true', 'yes', ''])('stays closed when HIPPO_ALLOW_KEYLESS_LOCAL is %j', async (value) => {
    process.env.HIPPO_ALLOW_KEYLESS_LOCAL = value;
    expect((await recall()).status).toBe(401);
  });
});

describe('a request with no key under HIPPO_ALLOW_KEYLESS_LOCAL=1', () => {
  beforeEach(() => {
    process.env.HIPPO_ALLOW_KEYLESS_LOCAL = '1';
  });

  it('is served as the local host admin', async () => {
    expect((await remember('keyless-opt-in-canary')).status).toBe(200);
    expect(rememberActors()).toEqual(['localhost:cli']);
    // Listing keys is admin-only, so a 200 here is the admin role and not just a way in.
    expect((await call('/v1/auth/keys')).status).toBe(200);
    expect((await call('/mcp/stream')).status).toBe(200);
  });

  it('still serves a keyed request as that key', async () => {
    expect((await remember('keyed-opt-in-canary', { authorization: `Bearer ${apiKey}` })).status).toBe(200);
    expect(rememberActors()).toEqual([expect.stringMatching(/^api_key:/)]);
  });

  it.each(NOT_LOCAL)('still refuses %s', async (_name, headers) => {
    const reply = await recall(headers());
    expect([401, 403]).toContain(reply.status);
    expect(reply.error).not.toContain('HIPPO_ALLOW_KEYLESS_LOCAL');
  });

  it('still refuses a caller from another machine', async () => {
    presentConnectionsAsRemote(handle.server!);
    expect(await recall()).toMatchObject({ status: 401, error: PLAIN_REFUSAL });
  });

  it('loses to HIPPO_REQUIRE_AUTH=1, which answers with the plain refusal', async () => {
    process.env.HIPPO_REQUIRE_AUTH = '1';
    expect(await recall()).toMatchObject({ status: 401, error: PLAIN_REFUSAL });
    expect((await recall({ authorization: `Bearer ${apiKey}` })).status).toBe(200);
  });
});

describe('GET /health', () => {
  it('gives this machine its version and pid with no key, in either mode', async () => {
    expect((await call('/health')).json).toMatchObject({ ok: true, pid: process.pid, version: expect.any(String) });
    process.env.HIPPO_ALLOW_KEYLESS_LOCAL = '1';
    expect((await call('/health')).json).toMatchObject({ ok: true, pid: process.pid, version: expect.any(String) });
  });

  it.each(NOT_LOCAL)('gives %s liveness only', async (_name, headers) => {
    const reply = await call('/health', { headers: headers() });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ ok: true });
  });

  it('gives a caller from another machine liveness only', async () => {
    presentConnectionsAsRemote(handle.server!);
    expect((await call('/health')).json).toEqual({ ok: true });
  });
});
