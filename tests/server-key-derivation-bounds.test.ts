// A bearer key check derives on the thread pool, two at a time, and one address gets five tries at one key id.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHook } from 'node:async_hooks';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { apiKeyVerifyStats, createApiKey } from '../src/auth.js';
import { serve, sqliteStore, type HippoStore, type ServeOpts } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';

/** Node's own record of scrypt jobs. One that hands its result to a callback ran on the thread pool; `scryptSync` never does, so it stays in `running`. */
const pool = { running: new Set<number>(), peak: 0, delivered: 0 };
const scryptJobs = createHook({
  init(id, type) {
    if (type !== 'SCRYPTREQUEST') return;
    pool.running.add(id);
    pool.peak = Math.max(pool.peak, pool.running.size);
  },
  before(id) {
    if (pool.running.delete(id)) pool.delivered++;
  },
});

/** Starts counting scrypt jobs; called after the keys are minted, since minting hashes with `scryptSync`. */
function watchPool(): void {
  pool.running.clear();
  pool.peak = 0;
  pool.delivered = 0;
  scryptJobs.enable();
}

const ENV_KEYS = ['HIPPO_CLIENT_IP_HEADER', 'HIPPO_TRUSTED_PROXIES', 'HIPPO_REQUIRE_AUTH'] as const;
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

let root: string;
let url = '';
let stop: (() => Promise<void>) | undefined;

beforeEach(() => {
  delete process.env.HIPPO_REQUIRE_AUTH;
  process.env.HIPPO_CLIENT_IP_HEADER = 'x-forwarded-for';
  process.env.HIPPO_TRUSTED_PROXIES = '127.0.0.1';
  root = makeRoot('key-bounds');
});

afterEach(async () => {
  scryptJobs.disable();
  await stop?.();
  stop = undefined;
  vi.useRealTimers();
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

async function start(extra: Partial<ServeOpts> = {}): Promise<void> {
  const handle = await serve({ hippoRoot: root, port: 0, rateLimits: { perAddress: 'off' }, ...extra });
  url = handle.url;
  stop = handle.stop;
}

/** The real store, with each key-row read held until `count` requests wait on one and then answered in one turn, so they all reach the bounds before any derivation can end. */
function arrivingTogether(count: number): HippoStore {
  const inner = sqliteStore(root);
  const held: Array<() => void> = [];
  let open = false;
  return {
    ...inner,
    findApiKey: async (keyId) => {
      const record = await inner.findApiKey(keyId);
      if (open) return record;
      await new Promise<void>((resolve) => {
        held.push(resolve);
        if (held.length < count) return;
        open = true;
        for (const release of held.splice(0)) release();
      });
      return record;
    },
  };
}

function mint(): string {
  const db = openHippoDb(root);
  try {
    return createApiKey(db, { tenantId: 'default', role: 'member' }).plaintext;
  } finally {
    closeHippoDb(db);
  }
}

interface Reply {
  status: number;
  retryAfter: string | null;
  refusal: unknown;
}

async function recall(token: string, address?: string): Promise<Reply> {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (address) headers.set('x-forwarded-for', address);
  const res = await fetch(`${url}/v1/memories?q=x`, { headers });
  const body: unknown = await res.json();
  return { status: res.status, retryAfter: res.headers.get('retry-after'), refusal: res.ok ? null : body };
}

const OK: Reply = { status: 200, retryAfter: null, refusal: null };
const UNAUTHORISED: Reply = { status: 401, retryAfter: null, refusal: { error: 'invalid api key' } };
/** The `n`th well-formed wrong secret for `key`'s id. */
const wrongSecret = (key: string, n: number): string => `${key.slice(0, key.indexOf('.'))}.${'abcdefghijklmnopqrstuvwxyz'.charAt(n % 26).repeat(32)}`;
const scryptRuns = (): number => apiKeyVerifyStats().scryptRuns;

describe('key derivation bounds', () => {
  it('refuses one address its sixth wrong secret for a key id without deriving, while the right secret passes from another address', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T09:00:00Z'));
    const key = mint();
    await start();
    const before = scryptRuns();
    let sent = 0;
    const guess = (): Promise<Reply> => recall(wrongSecret(key, sent++), '203.0.113.66');
    const tried: Reply[] = [];
    for (let i = 0; i < 5; i++) tried.push(await guess());
    expect(tried).toEqual(Array(5).fill(UNAUTHORISED));
    expect(scryptRuns() - before).toBe(5);

    const refused: Reply[] = [];
    for (let i = 0; i < 20; i++) refused.push(await guess());
    expect(refused).toEqual(Array(20).fill({ status: 429, retryAfter: '12', refusal: { error: 'too many key checks from this address' } }));
    expect(scryptRuns() - before).toBe(5);

    expect(await recall(key, '203.0.113.77')).toEqual(OK);
    // Retry-After is the wait for one more try, not for a fresh five.
    vi.setSystemTime(Date.now() + 12_000);
    expect([await guess(), (await guess()).status]).toEqual([UNAUTHORISED, 429]);
  });

  it("ends a flood on one key id at that key's five tries, so a colleague behind the same address still has scrypt budget", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T09:00:00Z'));
    const target = mint();
    const colleague = mint();
    // Eight scrypt runs for the address: the flood's five tries take five, and its refusals must not take the other three.
    await start({ rateLimits: { perAddress: 'off', failedAuthPerAddress: { ratePerSec: 0.05, burst: 8 } } });
    const office = '203.0.113.90';
    for (let sent = 0; sent < 30; sent++) await recall(wrongSecret(target, sent), office);
    expect(await recall(colleague, office)).toEqual(OK);
  });

  it('derives once for twenty requests that arrive together with one unproved key, and refuses none of them', async () => {
    const key = mint();
    await start({ store: arrivingTogether(20) });
    const before = scryptRuns();
    const burst = await Promise.all(Array.from({ length: 20 }, () => recall(key, '203.0.113.80')));
    expect(burst).toEqual(Array(20).fill(OK));
    expect(scryptRuns() - before).toBe(1);
  });

  it('runs two derivations at once with eight waiting, and answers the three past that 429 without deriving', async () => {
    const keys = Array.from({ length: 13 }, () => mint());
    await start({ store: arrivingTogether(keys.length) });
    const before = scryptRuns();
    watchPool();
    const replies = await Promise.all(keys.map((key) => recall(key)));
    expect(replies.filter((r) => r.status === 200)).toHaveLength(10);
    expect(replies.filter((r) => r.status !== 200)).toEqual(Array(3).fill({ status: 429, retryAfter: '1', refusal: { error: 'rate limit exceeded' } }));
    expect({ derived: scryptRuns() - before, mostAtOnce: pool.peak }).toEqual({ derived: 10, mostAtOnce: 2 });
  });

  it("derives an unproved key's secret as a thread-pool job, so the event loop is free while it runs", async () => {
    const key = mint();
    await start();
    const before = scryptRuns();
    watchPool();
    expect(await recall(key)).toEqual(OK);
    // A derivation on the event loop would count as a run yet hand no result back from the pool.
    expect({ derived: scryptRuns() - before, fromThePool: pool.delivered }).toEqual({ derived: 1, fromThePool: 1 });
  });
});
