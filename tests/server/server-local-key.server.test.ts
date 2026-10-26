// Every request but the public ones needs a key, from this machine too: a forwarded port (ssh -L, socat) looks local.
// The CLI here sends the key serve writes to server.key at each start, which only this user can read.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createApiKey } from '../../src/store/sqlite/auth.js';
import { listAuditEvents } from '../../src/store/sqlite/audit.js';
import type { ServerHandle } from '../../src/server.js';
import { localKeyPath } from '../../src/surface/server/local-key.js';
import { KEY_REQUIRED_MESSAGE } from '../_helpers/keyed-server.js';
import { presentConnectionsAsRemote } from '../_helpers/listen.js';
import { makeRoot } from '../_helpers/make-root.js';
import { needsHippoDb, serve } from '../_helpers/store-switch.js';

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
    const req = request(
      { host: '127.0.0.1', port: handle.port, method, path, headers: { ...headers } },
      (res) => {
        const status = res.statusCode ?? 0;
        // An accepted event stream never ends on its own, so its status line is the whole answer.
        if (String(res.headers['content-type']).startsWith('text/event-stream')) {
          res.destroy();
          resolve({ status, error: '', json: {} });
          return;
        }
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          const json = parsed(text);
          resolve({ status, error: json.error ?? '', json });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const recall = (headers: Readonly<Record<string, string>> = {}): Promise<Reply> =>
  call('/v1/memories?q=deploy', { headers });

function remember(content: string, headers: Readonly<Record<string, string>> = {}): Promise<Reply> {
  return call('/v1/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ content }),
  });
}

function rememberActors(): string[] {
  const db = openHippoDb(home);
  try {
    return listAuditEvents(db, { tenantId: 'default', op: 'remember' }).map((event) => event.actor);
  } finally {
    closeHippoDb(db);
  }
}

function withDb<T>(work: (db: ReturnType<typeof openHippoDb>) => T): T {
  const db = openHippoDb(home);
  try {
    return work(db);
  } finally {
    closeHippoDb(db);
  }
}

const start = (): Promise<ServerHandle> => serve({ hippoRoot: home, port: 0, host: '127.0.0.1' });
const localKey = (): string => readFileSync(localKeyPath(home), 'utf8').trim();
const asLocalKey = () => ({ authorization: `Bearer ${localKey()}` });

beforeEach(async () => {
  home = makeRoot('local-key');
  apiKey = withDb((db) => createApiKey(db, { tenantId: 'default', label: 'local-key' }).plaintext);
  handle = await start();
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

/** Requests that reach the loopback socket without being this machine's own user. */
const NOT_LOCAL: ReadonlyArray<readonly [string, () => Record<string, string>]> = [
  ['a proxied request', () => ({ 'x-forwarded-for': '203.0.113.7' })],
  ['a rebound Host', () => ({ host: `evil.example:${handle.port}` })],
  ['a cross-site page', () => ({ 'sec-fetch-site': 'cross-site' })],
  ['a page of another origin', () => ({ origin: 'http://evil.example' })],
];

describe('a request with no key', () => {
  it('is refused 401 with a message that says where the key is, and writes nothing', async () => {
    const reply = await remember('keyless-canary');
    expect(reply.status).toBe(401);
    expect(reply.error).toBe(KEY_REQUIRED_MESSAGE);
    expect(rememberActors()).toEqual([]);
  });

  it.each([
    ['a read', '/v1/memories?q=deploy', 'GET'],
    ['an admin route', '/v1/auth/keys', 'GET'],
    ['an MCP call', '/mcp', 'POST'],
    ['the MCP event stream', '/mcp/stream', 'GET'],
  ])('refuses %s', async (_name, path, method) => {
    const body =
      method === 'POST'
        ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        : undefined;
    const reply = await call(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(reply.status).toBe(401);
    expect(reply.error).toMatch(/^auth required: /);
  });

  it.skipIf(needsHippoDb('db'))('serves the same request once it carries a key', async () => {
    const reply = await remember('keyed-canary', { authorization: `Bearer ${apiKey}` });
    expect(reply.status).toBe(200);
    expect(rememberActors()).toEqual([expect.stringMatching(/^api_key:/)]);
  });

  it.each(NOT_LOCAL)('tells %s nothing about the key file', async (_name, headers) => {
    const reply = await recall(headers());
    expect(reply.status).toBe(401);
    expect(reply.error).toBe(PLAIN_REFUSAL);
  });

  it.each(NOT_LOCAL)('serves %s once it carries a key', async (_name, headers) => {
    const reply = await recall({ ...headers(), authorization: `Bearer ${apiKey}` });
    expect(reply.status).toBe(200);
  });

  it('tells a caller from another machine nothing about the key file', async () => {
    presentConnectionsAsRemote(handle.server!);
    const reply = await recall();
    expect(reply.status).toBe(401);
    expect(reply.error).toBe(PLAIN_REFUSAL);
  });
});

describe('the local key serve writes', () => {
  it.skipIf(process.platform === 'win32')('is readable by this user alone', () => {
    expect(statSync(localKeyPath(home)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(needsHippoDb('db'))(
    'signs a member of the server tenant, audited as localhost:cli',
    async () => {
      expect((await remember('local-key-canary', asLocalKey())).status).toBe(200);
      expect(rememberActors()).toEqual(['localhost:cli']);
      const sleep = await call('/v1/sleep', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...asLocalKey() },
        body: '{"dry_run":true}',
      });
      expect(sleep.status).toBe(403);
    },
  );

  it('is fresh at every start, so the key of an earlier run is refused', async () => {
    const before = localKey();
    await handle.stop();
    handle = await start();
    expect(localKey()).not.toBe(before);
    expect((await recall({ authorization: `Bearer ${before}` })).status).toBe(401);
    expect((await recall(asLocalKey())).status).toBe(200);
  });

  it('works for the server that wrote it alone', async () => {
    const other = makeRoot('local-key-other');
    const second = await serve({ hippoRoot: other, port: 0, host: '127.0.0.1' });
    try {
      expect(
        (
          await recall({
            authorization: `Bearer ${readFileSync(localKeyPath(other), 'utf8').trim()}`,
          })
        ).status,
      ).toBe(401);
    } finally {
      await second.stop();
    }
  });
});

describe('GET /health', () => {
  it('gives this machine its version and pid with no key', async () => {
    expect((await call('/health')).json).toMatchObject({
      ok: true,
      pid: process.pid,
      version: expect.any(String),
    });
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
