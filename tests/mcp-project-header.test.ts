// HTTP MCP on a shared store reads the caller's project from two percent-encoded headers and answers a bad one 400 before any JSON-RPC.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { _resetSharedStoreCacheForTests } from '../src/core/config.js';
import { MAX_PROJECT_ALIASES, MCP_PROJECT_SCOPED_HEADER } from '../src/entry/project-identity.js';
import { lastRecalledIds } from '../src/mcp/session-state.js';
import { clearProjectIdentityCache } from '../src/core/project-identity.js';
import { serve, type ServerHandle } from '../src/server.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { initStore } from '../src/store/open.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

interface Reply { readonly status: number; readonly text: string; readonly scoped: string | string[] | undefined }

let tmp: string;
let handle: ServerHandle | null = null;
const origHome = process.env.HIPPO_HOME;

function makeStore(shared: boolean): string {
  const store = path.join(tmp, 'srv', shared ? 'hippo-team' : 'hippo-solo');
  fs.mkdirSync(store, { recursive: true });
  initStore(store);
  if (shared) fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify({ sharedStore: true }));
  return store;
}

function toolCall(name: string, args: Record<string, string>): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

const REMEMBER = toolCall('hippo_remember', { text: 'the header test row about blue green deploys' });

/** POST /mcp through node:http, which sends a header given as an array once per value, as a proxy that repeats one would. */
function post(headers: http.OutgoingHttpHeaders, body: string = REMEMBER): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${handle!.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, scoped: res.headers['x-hippo-project-scoped'] }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mcp-header-'));
  process.env.HIPPO_HOME = path.join(tmp, 'global');
  clearProjectIdentityCache();
  _resetSharedStoreCacheForTests();
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  if (origHome === undefined) delete process.env.HIPPO_HOME;
  else process.env.HIPPO_HOME = origHome;
  _resetSharedStoreCacheForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('X-Hippo-Project on a shared store', () => {
  it('stamps hippo_remember with the decoded name, and an encoded comma in an alias widens recall to it', async () => {
    const store = makeStore(true);
    handle = await serve({ hippoRoot: store, port: 0 });
    const headers = {
      'x-hippo-project': encodeURIComponent('acme/café'),
      'x-hippo-project-aliases': [encodeURIComponent('old,name'), 'legacy'].join(','),
    };
    const r = await post(headers);
    expect(r.status, r.text).toBe(200);
    expect(r.text).toContain('Remembered');
    expect(loadAllEntries(store).map((e) => e.origin_project)).toEqual(['acme/café']);

    const aliased = { ...createMemory('the aliasmark row from before the rename'), origin_project: 'old,name' };
    writeEntry(store, aliased);
    lastRecalledIds.clear();
    const recalled = await post(headers, toolCall('hippo_recall', { query: 'aliasmark' }));
    expect(recalled.status, recalled.text).toBe(200);
    expect([...lastRecalledIds.values()].flat()).toContain(aliased.id);
  });

  it('reads an empty aliases header as no aliases', async () => {
    const store = makeStore(true);
    handle = await serve({ hippoRoot: store, port: 0 });
    const r = await post({ 'x-hippo-project': 'acme', 'x-hippo-project-aliases': '' });
    expect(r.status, r.text).toBe(200);
    expect(loadAllEntries(store).map((e) => e.origin_project)).toEqual(['acme']);
  });

  it('answers 400 with no JSON-RPC body for each bad header, and stores nothing', async () => {
    const store = makeStore(true);
    handle = await serve({ hippoRoot: store, port: 0 });
    const withName = (aliases: string): http.OutgoingHttpHeaders => ({ 'x-hippo-project': 'acme', 'x-hippo-project-aliases': aliases });
    const bad: ReadonlyArray<readonly [string, http.OutgoingHttpHeaders]> = [
      ['a bad escape', { 'x-hippo-project': '%E0%A4%A' }],
      ['a raw space', { 'x-hippo-project': 'acme app' }],
      ['a raw comma in the name', { 'x-hippo-project': 'acme,app' }],
      ['the name sent twice', { 'x-hippo-project': ['acme', 'acme'] }],
      ['the aliases sent twice', { 'x-hippo-project': 'acme', 'x-hippo-project-aliases': ['old', 'old'] }],
      ['aliases without a name', { 'x-hippo-project-aliases': 'old' }],
      ['a trailing empty alias', withName('a,')],
      ['a leading empty alias', withName(',a')],
      ['an empty alias between two', withName('a,,b')],
      ['a blank name', { 'x-hippo-project': '%20%20' }],
      ['capitals', { 'x-hippo-project': 'Acme' }],
      ['a colon', { 'x-hippo-project': 'acme%3Aapp' }],
      ['eleven aliases', withName(Array.from({ length: 11 }, (_, i) => `a${i}`).join(','))],
      ['257 characters', { 'x-hippo-project': 'x'.repeat(257) }],
    ];
    for (const [label, headers] of bad) {
      const r = await post(headers);
      expect(r.status, `${label}: ${r.text}`).toBe(400);
      expect(r.text, label).not.toContain('jsonrpc');
    }
    expect(loadAllEntries(store)).toEqual([]);
  });

  it('answers 401 for a bad key before it looks at the header', async () => {
    handle = await serve({ hippoRoot: makeStore(true), port: 0 });
    const r = await post({ authorization: 'Bearer hk_bogus', 'x-hippo-project': 'Acme' });
    expect(r.status).toBe(401);
  });

  it("answers 431 for a 20 KB header, Node's own cap, and the next request still gets 200", async () => {
    handle = await serve({ hippoRoot: makeStore(true), port: 0 });
    expect((await post({ 'x-hippo-project': 'a'.repeat(20 * 1024) })).status).toBe(431);
    expect((await post({ 'x-hippo-project': 'acme' })).status).toBe(200);
  });
});

describe('X-Hippo-Project-Scoped on every /mcp reply', () => {
  it('marks a 200, 202, 400 and 401 from a shared store', async () => {
    handle = await serve({ hippoRoot: makeStore(true), port: 0 });
    const replies: ReadonlyArray<readonly [number, Reply]> = [
      [200, await post({ 'x-hippo-project': 'acme' })],
      [202, await post({}, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))],
      [400, await post({ 'x-hippo-project': 'Acme' })],
      [400, await post({ 'x-hippo-project': 'acme' }, 'not json')],
      [401, await post({ authorization: 'Bearer hk_bogus' })],
    ];
    for (const [status, r] of replies) {
      expect(r.status, r.text).toBe(status);
      expect(r.scoped, `${status}: ${r.text}`).toBe('1');
    }
  });

  it('marks a 200 and a 429 from a store that is not shared', async () => {
    handle = await serve({ hippoRoot: makeStore(false), port: 0, rateLimits: { perAddress: { ratePerSec: 0.001, burst: 1 } } });
    const replies = [await post({}), await post({})];
    expect(replies.map((r) => r.status)).toEqual([200, 429]);
    expect(replies.map((r) => r.scoped)).toEqual(['1', '1']);
  });

  it('exports the header name, and the alias cap the server holds a caller to', async () => {
    expect(MCP_PROJECT_SCOPED_HEADER).toBe('X-Hippo-Project-Scoped');
    handle = await serve({ hippoRoot: makeStore(true), port: 0 });
    const aliases = (n: number): string => Array.from({ length: n }, (_, i) => `a${i}`).join(',');
    expect((await post({ 'x-hippo-project': 'acme', 'x-hippo-project-aliases': aliases(MAX_PROJECT_ALIASES) })).status).toBe(200);
    expect((await post({ 'x-hippo-project': 'acme', 'x-hippo-project-aliases': aliases(MAX_PROJECT_ALIASES + 1) })).status).toBe(400);
  });
});

describe('X-Hippo-Project on a store that is not shared', () => {
  it('ignores the headers, valid or not', async () => {
    const store = makeStore(false);
    handle = await serve({ hippoRoot: store, port: 0 });
    for (const name of ['acme', 'Acme App']) {
      const r = await post({ 'x-hippo-project': name }, toolCall('hippo_remember', { text: `the solo store row sent as ${name}` }));
      expect(r.status, `${name}: ${r.text}`).toBe(200);
      expect(r.text).toContain('Remembered');
    }
    const rows = loadAllEntries(store);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.origin_project).not.toBe('acme');
  });
});
