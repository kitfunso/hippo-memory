// One IPv6 subscriber holds a whole /64, so every per-address limit and per-client map counts the /64, not the address.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
import { serve, type ServerHandle } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';

const ENV_KEYS = ['HIPPO_V1_RPS', 'HIPPO_CLIENT_IP_HEADER', 'HIPPO_TRUSTED_PROXIES', 'HIPPO_REQUIRE_AUTH', 'MCP_SSE_MAX_STREAMS'] as const;
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

// The refill is far slower than any test run, so a drained bucket stays drained.
const TWO_THEN_REFUSE = { ratePerSec: 0.001, burst: 2 };
// A proxy header the keyless local fallback does not refuse, so these tests need no API key.
const CLIENT_HEADER = 'fly-client-ip';

let root: string;
let handle: ServerHandle | undefined;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HIPPO_CLIENT_IP_HEADER = CLIENT_HEADER;
  root = makeRoot('v6-limit-key');
});

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

async function recallFrom(address: string): Promise<number> {
  const res = await fetch(`${handle!.url}/v1/memories?q=x`, { headers: { [CLIENT_HEADER]: address } });
  await res.arrayBuffer();
  return res.status;
}

describe('the per-address rate limit', () => {
  beforeEach(async () => {
    handle = await serve({ hippoRoot: root, port: 0, rateLimits: { perAddress: TWO_THEN_REFUSE } });
  });

  it('gives every address inside one IPv6 /64 the same bucket', async () => {
    expect(await recallFrom('2001:db8:1:2::1')).toBe(200);
    expect(await recallFrom('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(200);
    expect(await recallFrom('2001:db8:1:2::3')).toBe(429);
    expect(await recallFrom('2001:DB8:1:2:ffff::9')).toBe(429);
  });

  it('gives another /64 its own bucket', async () => {
    expect(await recallFrom('2001:db8:1:2::1')).toBe(200);
    expect(await recallFrom('2001:db8:1:2::2')).toBe(200);
    expect(await recallFrom('2001:db8:1:2::3')).toBe(429);
    expect(await recallFrom('2001:db8:1:3::1')).toBe(200);
  });

  it('still gives each IPv4 address its own bucket', async () => {
    expect(await recallFrom('198.51.100.1')).toBe(200);
    expect(await recallFrom('198.51.100.1')).toBe(200);
    expect(await recallFrom('198.51.100.1')).toBe(429);
    expect(await recallFrom('198.51.100.2')).toBe(200);
  });

  it('keys an IPv4-mapped IPv6 address on its IPv4 address, never on a shared /64', async () => {
    expect(await recallFrom('::ffff:198.51.100.1')).toBe(200);
    expect(await recallFrom('::ffff:198.51.100.1')).toBe(200);
    expect(await recallFrom('::ffff:198.51.100.1')).toBe(429);
    expect(await recallFrom('::ffff:198.51.100.2')).toBe(200);
    // The bare and the mapped form are one host, so they share the drained bucket.
    expect(await recallFrom('198.51.100.1')).toBe(429);
  });
});

describe('the open-stream cap for keyless clients', () => {
  it('counts two addresses in one /64 as one client', async () => {
    process.env.MCP_SSE_MAX_STREAMS = '1';
    handle = await serve({ hippoRoot: root, port: 0, rateLimits: { perAddress: 'off' } });
    const ac = new AbortController();
    const open = (address: string): Promise<Response> =>
      fetch(`${handle!.url}/mcp/stream`, { headers: { accept: 'text/event-stream', [CLIENT_HEADER]: address }, signal: ac.signal });
    try {
      const first = await open('2001:db8:1:2::1');
      expect(first.status).toBe(200);
      await first.body!.getReader().read();
      const sameSubnet = await open('2001:db8:1:2::2');
      expect(sameSubnet.status).toBe(429);
      await sameSubnet.arrayBuffer();
      expect((await open('2001:db8:1:3::1')).status).toBe(200);
    } finally {
      ac.abort();
    }
  });
});

describe('the MCP per-client recall state', () => {
  interface ToolReply { result?: { content?: Array<{ text?: string }> } }

  it('follows one key across addresses inside a /64 and stays apart in another /64', async () => {
    handle = await serve({ hippoRoot: root, port: 0, rateLimits: { perAddress: 'off' } });
    // Read per request, so each call can arrive from the address the test names.
    let peer = '2001:db8:1:2::1';
    handle.server!.prependListener('connection', (socket) => {
      Object.defineProperty(socket, 'remoteAddress', { get: () => peer, configurable: true });
    });
    const db = openHippoDb(root);
    let key: string;
    try {
      key = createApiKey(db, { tenantId: 'default', role: 'member' }).plaintext;
    } finally {
      closeHippoDb(db);
    }
    const callTool = async (from: string, name: string, args: Record<string, string | number | boolean>): Promise<string> => {
      peer = from;
      const res = await fetch(`${handle!.url}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      expect(res.status).toBe(200);
      // SAFETY: /mcp answers a tools/call with this JSON-RPC shape; the assertions below read the text.
      const reply = (await res.json()) as ToolReply;
      return reply.result?.content?.[0]?.text ?? '';
    };

    expect(await callTool('2001:db8:1:2::1', 'hippo_remember', { text: 'subnet-key-canary rotates its address inside one subscriber prefix' })).toMatch(/Remembered/);
    expect(await callTool('2001:db8:1:2::1', 'hippo_recall', { query: 'subnet-key-canary', budget: 1500 })).toContain('subnet-key-canary');
    expect(await callTool('2001:db8:1:3::1', 'hippo_outcome', { good: true })).toBe('No recent recalls to apply outcome to.');
    expect(await callTool('2001:db8:1:2:aaaa::7', 'hippo_outcome', { good: true })).toBe('Applied positive outcome to 1 memories');
  });
});
