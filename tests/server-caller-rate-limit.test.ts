// Each person gets one bucket across their keys, an address's scrypt runs are capped, and every 429 says when to come back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { apiKeyVerifyStats, createApiKey, revokeApiKey, VERIFIED_KEY_TTL_MS, type CreateApiKeyOpts } from '../src/auth.js';
import { log } from '../src/log.js';
import { serve, sqliteStore, StoreBusyError, type AddonRoute, type HippoStore, type ServeOpts } from '../src/server.js';
import { subscriberKey } from '../src/server/client-ip.js';
import { makeRoot } from './_helpers/make-root.js';

const ENV_KEYS = ['HIPPO_V1_RPS', 'HIPPO_CLIENT_IP_HEADER', 'HIPPO_TRUSTED_PROXIES', 'HIPPO_REQUIRE_AUTH', 'MCP_SSE_HEARTBEAT_MS', 'MCP_SSE_MAX_STREAMS'] as const;
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

const WIDE = { ratePerSec: 1000, burst: 1000 };
// A slow refill, so a test that takes a while still sees the bucket it drained.
const SLOW = { ratePerSec: 0.1, burst: 2 };
const JSON_BODY = { 'content-type': 'application/json' };
const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

let root: string;
let url = '';
let stop: (() => Promise<void>) | undefined;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  root = makeRoot('caller-rate');
});

afterEach(async () => {
  await stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

async function start(rateLimits?: ServeOpts['rateLimits'], extra: Partial<ServeOpts> = {}): Promise<void> {
  const handle = await serve({ hippoRoot: root, port: 0, rateLimits, ...extra });
  url = handle.url;
  stop = handle.stop;
}

function mint(opts: Partial<CreateApiKeyOpts> = {}): string {
  const db = openHippoDb(root);
  try {
    return createApiKey(db, { tenantId: 'default', role: 'member', ...opts }).plaintext;
  } finally {
    closeHippoDb(db);
  }
}

interface Reply {
  status: number;
  retryAfter: string | null;
}

async function send(path: string, init: RequestInit = {}): Promise<Reply> {
  const res = await fetch(`${url}${path}`, init);
  await res.arrayBuffer();
  return { status: res.status, retryAfter: res.headers.get('retry-after') };
}

const bearer = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const recall = (headers: Record<string, string> = {}): Promise<Reply> => send('/v1/memories?q=x', { headers });
const addonRoute = (onRun: () => void): AddonRoute => ({ path: '/v1/x-addon', handler: async () => { onRun(); return {}; } });

async function replies(call: () => Promise<Reply>, n: number): Promise<Reply[]> {
  const out: Reply[] = [];
  for (let i = 0; i < n; i++) out.push(await call());
  return out;
}

async function statuses(call: () => Promise<Reply>, n: number): Promise<number[]> {
  return (await replies(call, n)).map((r) => r.status);
}

const OK = { status: 200, retryAfter: null };
const UNAUTHORISED = { status: 401, retryAfter: null };

/** Stops the clock so no bucket refills while a test counts tokens; timers still run. */
function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T09:00:00Z'));
}

describe('per-caller buckets', () => {
  it('gives two owners behind one proxy address their own buckets, though they share its address bucket', async () => {
    process.env.HIPPO_CLIENT_IP_HEADER = 'x-forwarded-for';
    process.env.HIPPO_TRUSTED_PROXIES = '127.0.0.1';
    freezeClock();
    const a = mint({ ownerSubject: 'oid-a' });
    const b = mint({ ownerSubject: 'oid-b' });
    await start({ perCaller: { ratePerSec: 1, burst: 2 }, perAddress: { ratePerSec: 0.1, burst: 4 } });
    const via = (token: string, address: string): Promise<Reply> => recall(bearer(token, { 'x-forwarded-for': address }));
    expect(await replies(() => via(a, '203.0.113.7'), 3)).toEqual([OK, OK, { status: 429, retryAfter: '1' }]);
    expect(await via(b, '203.0.113.7')).toEqual(OK);
    // A and B together spent the office address's four tokens; another address still has its own.
    expect(await via(b, '203.0.113.7')).toEqual({ status: 429, retryAfter: '10' });
    expect(await via(b, '203.0.113.8')).toEqual(OK);
  });

  it('shares one bucket between two keys of one owner', async () => {
    const a1 = mint({ ownerSubject: 'oid-a' });
    const a2 = mint({ ownerSubject: 'oid-a' });
    await start({ perCaller: SLOW, perAddress: WIDE });
    expect([(await recall(bearer(a1))).status, (await recall(bearer(a2))).status]).toEqual([200, 200]);
    expect(await recall(bearer(a1))).toEqual({ status: 429, retryAfter: '10' });
    expect((await recall(bearer(a2))).status).toBe(429);
  });

  it('gives an unowned key its own bucket by key id', async () => {
    const u1 = mint();
    const u2 = mint();
    await start({ perCaller: SLOW, perAddress: WIDE });
    expect(await statuses(() => recall(bearer(u1)), 3)).toEqual([200, 200, 429]);
    expect((await recall(bearer(u2))).status).toBe(200);
  });

  it('gives one subject in two tenants two buckets', async () => {
    const home = mint({ ownerSubject: 'oid-t' });
    const away = mint({ ownerSubject: 'oid-t', tenantId: 'acme' });
    await start({ perCaller: SLOW, perAddress: WIDE });
    expect(await statuses(() => recall(bearer(home)), 3)).toEqual([200, 200, 429]);
    expect((await recall(bearer(away))).status).toBe(200);
  });

  it('never charges the loopback fallback or /health', async () => {
    const a = mint({ ownerSubject: 'oid-health' });
    await start({ perCaller: { ratePerSec: 0.1, burst: 1 }, perAddress: WIDE });
    expect(await statuses(() => recall(), 3)).toEqual([200, 200, 200]);
    expect(await statuses(() => send('/health', { headers: bearer(a) }), 5)).toEqual([200, 200, 200, 200, 200]);
    expect((await recall(bearer(a))).status).toBe(200);
  });

  it('keeps /health out of the per-address bucket too', async () => {
    await start({ perAddress: { ratePerSec: 0.1, burst: 1 } });
    expect(await statuses(() => send('/health'), 5)).toEqual([200, 200, 200, 200, 200]);
    expect((await recall()).status).toBe(200);
  });

  it('answers 429 before the body is read, so a broken body gets 429, not 400', async () => {
    const a = mint({ ownerSubject: 'oid-body' });
    await start({ perCaller: SLOW, perAddress: WIDE });
    const broken = (): Promise<Reply> => send('/v1/memories', { method: 'POST', headers: bearer(a, JSON_BODY), body: '{not json' });
    expect((await broken()).status).toBe(400);
    expect((await recall(bearer(a))).status).toBe(200);
    expect(await broken()).toEqual({ status: 429, retryAfter: '10' });
  });

  it('charges an add-on route call and a POST /mcp call once each', async () => {
    let runs = 0;
    const a = mint({ ownerSubject: 'oid-addon' });
    const m = mint({ ownerSubject: 'oid-mcp' });
    await start({ perCaller: SLOW, perAddress: WIDE }, { routes: [addonRoute(() => { runs += 1; })] });
    const addon = (): Promise<Reply> => send('/v1/x-addon', { method: 'POST', headers: bearer(a, JSON_BODY), body: '{}' });
    const mcp = (): Promise<Reply> => send('/mcp', { method: 'POST', headers: bearer(m, JSON_BODY), body: TOOLS_LIST });
    expect(await replies(addon, 3)).toEqual([OK, OK, { status: 429, retryAfter: '10' }]);
    expect(runs).toBe(2);
    expect(await replies(mcp, 3)).toEqual([OK, OK, { status: 429, retryAfter: '10' }]);
  });
});

describe('per-caller buckets under a store that is not hippo.db', () => {
  it('charges a V1 route and an add-on route once each, though both answer 501', async () => {
    const key = mint({ ownerSubject: 'oid-stub' });
    const record = await sqliteStore(root).findApiKey(key.slice(0, key.indexOf('.')));
    // Stands in for a store method that still opens hippo.db, so the V1 route's 501 is the blocked open, not an accident.
    const unported = async (): Promise<never> => {
      closeHippoDb(openHippoDb(root));
      throw new Error('the stub store does not serve recall');
    };
    const store: HippoStore = {
      kind: 'stub',
      findApiKey: async () => record,
      searchRecallEntries: unported,
      entriesByIds: unported,
      activeGoals: unported,
      freshRawEntries: unported,
      continuity: unported,
      planningFallacyEvidence: unported,
      appendAuditEvents: unported,
      finishRecall: unported,
      bumpRecallStats: unported,
      recordTokens: unported,
      async close(): Promise<void> {},
    };
    let runs = 0;
    await start({ perCaller: SLOW, perAddress: WIDE }, { store, routes: [addonRoute(() => { runs += 1; })] });
    const v1 = (): Promise<Reply> => recall(bearer(key));
    const addon = (): Promise<Reply> => send('/v1/x-addon', { method: 'POST', headers: bearer(key, JSON_BODY), body: '{}' });
    const notHippoDb = { status: 501, retryAfter: null };
    expect([await v1(), await addon(), await v1()]).toEqual([notHippoDb, notHippoDb, { status: 429, retryAfter: '10' }]);
    expect(runs).toBe(0);
  });
});

describe('the MCP stream heartbeat', () => {
  it('never charges, so a quiet stream outlives its burst and a POST afterwards still passes', async () => {
    process.env.MCP_SSE_HEARTBEAT_MS = '50';
    const a = mint({ ownerSubject: 'oid-stream' });
    await start({ perCaller: SLOW, perAddress: WIDE });
    const ac = new AbortController();
    const deadline = setTimeout(() => ac.abort(), 5000);
    try {
      const res = await fetch(`${url}/mcp/stream`, { headers: { accept: 'text/event-stream', ...bearer(a) }, signal: ac.signal });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      // The first ping is the open; ten more are ten heartbeats.
      while (text.split(': ping').length - 1 < 11 && !text.includes('event: closed')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      expect(text).not.toContain('event: closed');
      expect(text.split(': ping').length - 1).toBeGreaterThanOrEqual(11);
      expect((await send('/mcp', { method: 'POST', headers: bearer(a, JSON_BODY), body: TOOLS_LIST })).status).toBe(200);
    } finally {
      clearTimeout(deadline);
      ac.abort();
    }
  });

  it('answers the stream past the slot cap with 429 and Retry-After: 60', async () => {
    process.env.MCP_SSE_MAX_STREAMS = '1';
    await start({ perAddress: WIDE });
    const ac = new AbortController();
    try {
      const first = await fetch(`${url}/mcp/stream`, { headers: { accept: 'text/event-stream' }, signal: ac.signal });
      expect(first.status).toBe(200);
      await first.body!.getReader().read();
      expect(await send('/mcp/stream', { headers: { accept: 'text/event-stream' } })).toEqual({ status: 429, retryAfter: '60' });
    } finally {
      ac.abort();
    }
  });
});

const wrongSecretOf = (key: string): string => `${key.slice(0, key.indexOf('.'))}.${'a'.repeat(32)}`;
const scryptRunsSince = (before: number): number => apiKeyVerifyStats().scryptRuns - before;

describe('the per-address scrypt bucket', () => {
  it('caps scrypt runs for bad secrets on a known key id, then answers 429 before scrypt; a cached key still passes', async () => {
    freezeClock();
    const good = mint({ ownerSubject: 'oid-f4' });
    const uncached = mint({ ownerSubject: 'oid-f4-other' });
    await start({ perAddress: WIDE, failedAuthPerAddress: { ratePerSec: 0.05, burst: 5 } });
    // The good key's first check runs scrypt, so it spends one of the five tokens.
    expect(await recall(bearer(good))).toEqual(OK);
    const before = apiKeyVerifyStats().scryptRuns;
    const flood = await replies(() => recall(bearer(wrongSecretOf(good))), 100);
    expect(scryptRunsSince(before)).toBe(4);
    expect(flood.slice(0, 4)).toEqual(Array(4).fill(UNAUTHORISED));
    expect(flood.slice(4).filter((r) => r.status !== 429 || r.retryAfter !== '20')).toEqual([]);
    expect(await recall(bearer(good))).toEqual(OK);
    const runs = apiKeyVerifyStats().scryptRuns;
    expect(await recall(bearer(uncached))).toEqual({ status: 429, retryAfter: '20' });
    expect(apiKeyVerifyStats().scryptRuns).toBe(runs);
  });

  it('by default allows 40 scrypt runs from an address, then answers 429 with Retry-After: 1', async () => {
    process.env.HIPPO_V1_RPS = '0';
    freezeClock();
    const key = mint({ ownerSubject: 'oid-default' });
    await start();
    const before = apiKeyVerifyStats().scryptRuns;
    const flood = await replies(() => recall(bearer(wrongSecretOf(key))), 41);
    expect(flood.slice(0, 40)).toEqual(Array(40).fill(UNAUTHORISED));
    expect(flood[40]).toEqual({ status: 429, retryAfter: '1' });
    expect(scryptRunsSince(before)).toBe(40);
  }, 60_000);

  it('never charges a token that ran no scrypt, so a colleague behind the same address re-checks a lapsed key while junk floods it', async () => {
    process.env.HIPPO_CLIENT_IP_HEADER = 'x-forwarded-for';
    process.env.HIPPO_TRUSTED_PROXIES = '127.0.0.1';
    freezeClock();
    const dev = mint({ ownerSubject: 'oid-dev' });
    const revoked = mint({ ownerSubject: 'oid-gone' });
    const expired = mint({ ownerSubject: 'oid-old', expiresAt: '2026-10-01T00:00:00.000Z' });
    const db = openHippoDb(root);
    try {
      revokeApiKey(db, revoked.slice(0, revoked.indexOf('.')));
    } finally {
      closeHippoDb(db);
    }
    // Burst 40 as the default, but a refill slow enough that a TTL's wait adds under one token.
    await start({ perAddress: 'off', failedAuthPerAddress: { ratePerSec: 0.005, burst: 40 } }, { authResolver: () => null });
    const office = (token: string): Promise<Reply> => recall(bearer(token, { 'x-forwarded-for': '203.0.113.50' }));
    const start0 = Date.now();
    expect(await office(dev)).toEqual(OK);
    const before = apiKeyVerifyStats().scryptRuns;
    // Junk shape, a resolver refusal, an unknown id, a revoked key and an expired key: 63 in all, past the burst.
    const junk = ['hk_junk', 'not-a-key-$HIPPO_KEY', `hk_${'a'.repeat(24)}.${'b'.repeat(32)}`, revoked, expired];
    for (let i = 0; i < 63; i++) expect(await office(junk[i % junk.length]!)).toEqual(UNAUTHORISED);
    expect(scryptRunsSince(before)).toBe(0);
    // Real-shaped wrong secrets run scrypt, so they spend all 39 tokens the developer's first check left, then meet 429.
    vi.setSystemTime(start0 + VERIFIED_KEY_TTL_MS / 2);
    const flood = await replies(() => office(wrongSecretOf(dev)), 40);
    expect(flood.slice(0, 39)).toEqual(Array(39).fill(UNAUTHORISED));
    expect(flood[39]).toEqual({ status: 429, retryAfter: '200' });
    expect(scryptRunsSince(before)).toBe(39);
    // The bucket is still empty when the developer's entry lapses, yet the key re-checks, because its secret is already proved.
    vi.setSystemTime(start0 + VERIFIED_KEY_TTL_MS);
    expect(await office(dev)).toEqual(OK);
    expect(scryptRunsSince(before)).toBe(39);
  }, 60_000);

  it('keys an IPv6 address on its /64, so rotating inside one /64 buys no fresh scrypt budget', async () => {
    process.env.HIPPO_CLIENT_IP_HEADER = 'x-forwarded-for';
    process.env.HIPPO_TRUSTED_PROXIES = '127.0.0.1';
    freezeClock();
    const key = mint({ ownerSubject: 'oid-v6' });
    await start({ perAddress: 'off', failedAuthPerAddress: { ratePerSec: 0.1, burst: 2 } });
    const from = (address: string): Promise<Reply> => recall(bearer(wrongSecretOf(key), { 'x-forwarded-for': address }));
    expect([await from('2001:db8:1:2::a'), await from('2001:db8:1:2:ffff:1:2:3')]).toEqual([UNAUTHORISED, UNAUTHORISED]);
    expect(await from('2001:0db8:0001:0002::b')).toEqual({ status: 429, retryAfter: '10' });
    expect(await from('2001:db8:1:3::a')).toEqual(UNAUTHORISED);
  });
});

describe('subscriberKey', () => {
  it.each([
    ['2001:db8:1:2::a', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['64:ff9b::192.0.2.1', '64:ff9b:0:0::/64'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['203.0.113.9', '203.0.113.9'],
    ['unknown', 'unknown'],
  ])('%s keys as %s', (ip, key) => {
    expect(subscriberKey(ip)).toBe(key);
  });
});

describe('the per-address bucket', () => {
  it("turns off with perAddress 'off' and never reads HIPPO_V1_RPS", async () => {
    process.env.HIPPO_V1_RPS = '1';
    await start({ perAddress: 'off' });
    expect(await statuses(() => recall(), 5)).toEqual([200, 200, 200, 200, 200]);
  });

  it('keeps HIPPO_V1_RPS when perAddress is unset, and its 429 carries Retry-After', async () => {
    process.env.HIPPO_V1_RPS = '1';
    await start();
    expect(await statuses(() => recall(), 2)).toEqual([200, 200]);
    expect(await recall()).toEqual({ status: 429, retryAfter: '1' });
  });

  it('takes a set perAddress over HIPPO_V1_RPS, looser or stricter', async () => {
    process.env.HIPPO_V1_RPS = '1';
    await start({ perAddress: WIDE });
    expect(await statuses(() => recall(), 5)).toEqual([200, 200, 200, 200, 200]);
    await stop?.();
    process.env.HIPPO_V1_RPS = '1000';
    await start({ perAddress: { ratePerSec: 0.5, burst: 1 } });
    expect((await recall()).status).toBe(200);
    expect(await recall()).toEqual({ status: 429, retryAfter: '2' });
  });
});

describe('boot and the other Retry-After replies', () => {
  const BAD: Array<[ServeOpts['rateLimits'], RegExp]> = [
    [{ perCaller: { ratePerSec: 0, burst: 1 } }, /rateLimits\.perCaller\.ratePerSec/],
    [{ perCaller: { ratePerSec: -1, burst: 2 } }, /rateLimits\.perCaller\.ratePerSec/],
    [{ perCaller: { ratePerSec: 1, burst: Number.POSITIVE_INFINITY } }, /rateLimits\.perCaller\.burst/],
    [{ perAddress: { ratePerSec: Number.NaN, burst: 2 } }, /rateLimits\.perAddress\.ratePerSec/],
    [{ perAddress: { ratePerSec: Number.POSITIVE_INFINITY, burst: 2 } }, /rateLimits\.perAddress\.ratePerSec/],
    [{ failedAuthPerAddress: { ratePerSec: 1, burst: 0.5 } }, /rateLimits\.failedAuthPerAddress\.burst/],
  ];

  it.each(BAD)('refuses %o at boot', async (rateLimits, message) => {
    await expect(serve({ hippoRoot: root, port: 0, rateLimits })).rejects.toThrow(message);
    expect(existsSync(join(root, 'server.pid'))).toBe(false);
  });

  it('keeps Retry-After: 1 on the store-busy 503', async () => {
    const busy: HippoStore = { ...sqliteStore(root), findApiKey: async () => { throw new StoreBusyError(); } };
    await start({ perAddress: WIDE }, { store: busy });
    expect(await recall(bearer(mint()))).toEqual({ status: 503, retryAfter: '1' });
  });

  it('logs one warn line for two 429s in a minute, naming tenant, person and request id but never the token', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const a = mint({ ownerSubject: 'oid-log' });
    await start({ perCaller: { ratePerSec: 0.1, burst: 1 }, perAddress: WIDE });
    expect((await recall(bearer(a, { 'x-request-id': 'req-one' }))).status).toBe(200);
    expect((await recall(bearer(a, { 'x-request-id': 'req-two' }))).status).toBe(429);
    expect((await recall(bearer(a, { 'x-request-id': 'req-three' }))).status).toBe(429);
    const lines = warn.mock.calls.filter(([message]) => message.includes('rate limit'));
    expect(lines).toEqual([[expect.stringContaining('caller over its rate limit'), { tenant: 'default', person: 'oid-log', requestId: 'req-two' }]]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(a.slice(a.indexOf('.') + 1));
  });
});
