// serve's keyQuota hook is asked once per admitted request, answers a refusal with 429, and fails open on any fault.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createApiKey, type CreateApiKeyOptions } from '../../src/store/sqlite/keys/auth.js';
import type { AddonRoute, KeyQuota, KeyQuotaCall, KeyQuotaRefusal, ServeOptions } from '../../src/server.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { makeRoot } from '../_helpers/make-root.js';
import { readLocalKey } from '../../src/surface/server/local-key.js';
import { needsHippoDb, serve } from '../_helpers/store-switch.js';

const ENV_KEYS = [
  'HIPPO_V1_RPS',
  'HIPPO_CALLER_RPS',
  'HIPPO_CLIENT_IP_HEADER',
  'HIPPO_TRUSTED_PROXIES',
  'MCP_SSE_HEARTBEAT_MS',
  'MCP_SSE_MAX_STREAMS',
] as const;

const WIDE = { ratePerSec: 1000, burst: 1000 };
// A slow refill, so a test that takes a while still sees the bucket it drained.
const SLOW = { ratePerSec: 0.1, burst: 2 };
const JSON_BODY = { 'content-type': 'application/json' };
const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
const REFUSAL = { retryAfterSec: 7, message: 'quota test' };
const FAULT_LINE = /^\[hippo\] error: key quota: /;

let root: string;
let url = '';
let stop: (() => Promise<void>) | undefined;

beforeEach(() => {
  for (const k of ENV_KEYS) vi.stubEnv(k, undefined);
  root = makeRoot('key-quota');
});

afterEach(async () => {
  await stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function start(rateLimits?: ServeOptions['rateLimits'], extra: Partial<ServeOptions> = {}): Promise<void> {
  const handle = await serve({ hippoRoot: root, port: 0, rateLimits, ...extra });
  url = handle.url;
  stop = handle.stop;
}

function mint(opts: Partial<CreateApiKeyOptions> = {}): string {
  const db = openHippoDb(root);
  try {
    return createApiKey(db, { tenantId: 'default', role: 'member', ...opts }).plaintext;
  } finally {
    closeHippoDb(db);
  }
}

const keyIdOf = (token: string): string => token.slice(0, token.indexOf('.'));

interface Reply {
  status: number;
  retryAfter: string | null;
  requestId: string | null;
  contentType: string | null;
  body: string;
}

async function send(path: string, init: RequestInit = {}): Promise<Reply> {
  const res = await fetch(`${url}${path}`, init);
  const contentType = res.headers.get('content-type');
  // An open stream never ends, so its text is never awaited: cancel it and fail on the status.
  const isStream = contentType?.includes('text/event-stream') === true;
  if (isStream) await res.body?.cancel();
  return {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    requestId: res.headers.get('x-request-id'),
    contentType,
    body: isStream ? '' : await res.text(),
  };
}

const bearer = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
/** The local key the running server wrote, as the CLI on this machine sends it. */
const localKey = (): Record<string, string> => bearer(readLocalKey(root)!);
const recall = (headers: Record<string, string>): Promise<Reply> => send('/v1/memories?q=x', { headers });
const mcpList = (token: string): Promise<Reply> =>
  send('/mcp', { method: 'POST', headers: bearer(token, JSON_BODY), body: TOOLS_LIST });
const mcpStream = (token: string): Promise<Reply> =>
  send('/mcp/stream', { headers: { accept: 'text/event-stream', ...bearer(token) } });
const addonRoute = (onRun: () => void): AddonRoute => ({
  path: '/v1/x-addon',
  handler: async () => {
    onRun();
    return {};
  },
});

interface Spy {
  quota: KeyQuota;
  calls: KeyQuotaCall[];
}

/** A hook that records each call and answers with what `answer` returns, or throws what it throws. */
function spy(answer: () => JsonValue | Promise<never> | undefined): Spy {
  const calls: KeyQuotaCall[] = [];
  const quota = (call: KeyQuotaCall): KeyQuotaRefusal | null => {
    calls.push(call);
    // SAFETY: a JS hook may return any value, and the malformed answers here are what core must survive.
    return answer() as KeyQuotaRefusal | null;
  };
  return { quota, calls };
}

/** Each test sets its own hour: the fault line is throttled for the whole process, so two tests at one clock would share it. */
function setClock(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

function captureStderr(): () => string[] {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return () => stderr.mock.calls.map(([chunk]) => String(chunk)).filter((line) => FAULT_LINE.test(line));
}

function expectRefused(reply: Reply): void {
  expect(reply.status).toBe(429);
  expect(reply.retryAfter).toBe('7');
  expect(JSON.parse(reply.body)).toEqual({ error: 'quota test' });
}

describe('a refusing hook', () => {
  it('C1: answers a /v1 row with 429, Retry-After and the hook text', async () => {
    const k = mint({ ownerSubject: 'oid-a' });
    const { quota, calls } = spy(() => REFUSAL);
    await start({ perCaller: WIDE, perAddress: WIDE }, { keyQuota: quota });
    expectRefused(await recall(bearer(k)));
    expect(calls).toHaveLength(1);
  });

  it('C2: answers POST /mcp with the same 429', async () => {
    const k = mint({ ownerSubject: 'oid-a' });
    await start({ perCaller: WIDE, perAddress: WIDE }, { keyQuota: spy(() => REFUSAL).quota });
    expectRefused(await mcpList(k));
  });

  it('C3: answers GET /mcp/stream with the same 429 and opens no stream', async () => {
    const k = mint({ ownerSubject: 'oid-a' });
    await start({ perCaller: WIDE, perAddress: WIDE }, { keyQuota: spy(() => REFUSAL).quota });
    const reply = await mcpStream(k);
    expectRefused(reply);
    expect(reply.contentType).not.toContain('text/event-stream');
  });

  it.skipIf(needsHippoDb('addon'))(
    'C4: answers an add-on route call with the same 429 before its handler runs',
    async () => {
      let runs = 0;
      const k = mint({ ownerSubject: 'oid-a' });
      const routes = [
        addonRoute(() => {
          runs += 1;
        }),
      ];
      await start({ perCaller: WIDE, perAddress: WIDE }, { keyQuota: spy(() => REFUSAL).quota, routes });
      expectRefused(await send('/v1/x-addon', { method: 'POST', headers: bearer(k, JSON_BODY), body: '{}' }));
      expect(runs).toBe(0);
    },
  );

  it('C11: answers 429 from the hook when the per-caller bucket is off', async () => {
    const k = mint({ ownerSubject: 'oid-a' });
    await start({ perCaller: 'off', perAddress: WIDE }, { keyQuota: spy(() => REFUSAL).quota });
    expectRefused(await recall(bearer(k)));
  });

  it('C14: caps Retry-After at one day, so a huge wait stays valid delta-seconds', async () => {
    const k = mint({ ownerSubject: 'oid-a' });
    await start(
      { perCaller: WIDE, perAddress: WIDE },
      { keyQuota: spy(() => ({ retryAfterSec: 1e21, message: 'x' })).quota },
    );
    const reply = await recall(bearer(k));
    expect(reply.status).toBe(429);
    expect(reply.retryAfter).toBe('86400');
  });
});

describe('what the hook is asked', () => {
  it('C5: is asked once per request with the tenant, route, request id and a frozen actor', async () => {
    const k = mint({ ownerSubject: 'oid-a' });
    const { quota, calls } = spy(() => null);
    await start({ perCaller: WIDE, perAddress: WIDE }, { keyQuota: quota });
    const reply = await recall(bearer(k));
    expect(reply.status).toBe(200);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call).toMatchObject({
      tenantId: 'default',
      method: 'GET',
      path: '/v1/memories',
      requestId: reply.requestId,
    });
    expect(call!.actor.subject).toBe(`api_key:${keyIdOf(k)}`);
    expect(call!.actor.owner).toBe('oid-a');
    expect(Object.isFrozen(call!.actor)).toBe(true);
    if (call!.actor.scopes) expect(Object.isFrozen(call!.actor.scopes)).toBe(true);
  });

  it('C6: is never asked about the local CLI key', async () => {
    const { quota, calls } = spy(() => REFUSAL);
    await start({ perCaller: WIDE, perAddress: WIDE }, { keyQuota: quota });
    expect((await recall(localKey())).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('C7: changes nothing when serve has no hook', async () => {
    const k = mint({ ownerSubject: 'oid-a' });
    await start({ perCaller: WIDE, perAddress: WIDE });
    expect([await recall(bearer(k)), await recall(bearer(k)), await recall(bearer(k))].map((r) => r.status)).toEqual([
      200, 200, 200,
    ]);
  });

  it('C10: is not asked about a request the per-caller bucket refused', async () => {
    const k = mint({ ownerSubject: 'oid-a' });
    const { quota, calls } = spy(() => null);
    await start({ perCaller: SLOW, perAddress: WIDE }, { keyQuota: quota });
    const replies = [await recall(bearer(k)), await recall(bearer(k)), await recall(bearer(k))];
    expect(replies.map((r) => r.status)).toEqual([200, 200, 429]);
    expect(JSON.parse(replies[2]!.body)).toEqual({ error: 'rate limit exceeded for this caller' });
    expect(calls).toHaveLength(2);
  });
});

describe('a faulty hook', () => {
  it('C8: admits the request when the hook throws, and logs one error line with the request id', async () => {
    setClock('2026-11-21T09:00:00Z');
    const lines = captureStderr();
    const k = mint({ ownerSubject: 'oid-a' });
    const { quota, calls } = spy(() => {
      throw new Error('meter broke');
    });
    await start({ perCaller: WIDE, perAddress: WIDE }, { keyQuota: quota });
    const reply = await recall(bearer(k));
    expect(reply.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(lines()).toEqual([
      expect.stringMatching(/^\[hippo\] error: key quota: the hook threw; the request is admitted/),
    ]);
    expect(lines()[0]).toContain(`requestId=${reply.requestId}`);
  });

  it.each([
    ['10:00', 'undefined', undefined],
    ['11:00', 'a string', 'no'],
    ['12:00', 'no message', { retryAfterSec: 5 }],
    ['13:00', 'no wait', { retryAfterSec: 0, message: 'x' }],
    ['14:00', 'an empty message', { retryAfterSec: 5, message: '' }],
    ['15:00', 'a wait of NaN', { retryAfterSec: Number.NaN, message: 'x' }],
    ['15:20', 'a wait of Infinity', { retryAfterSec: Number.POSITIVE_INFINITY, message: 'x' }],
    ['15:40', 'a negative wait', { retryAfterSec: -1, message: 'x' }],
  ])('C9: at %s admits the request when the hook answers %s, and logs one line', async (time, _label, answer) => {
    setClock(`2026-11-21T${time}:00Z`);
    const lines = captureStderr();
    const k = mint({ ownerSubject: 'oid-a' });
    await start({ perCaller: WIDE, perAddress: WIDE }, { keyQuota: spy(() => answer).quota });
    expect((await recall(bearer(k))).status).toBe(200);
    expect(lines()).toEqual([expect.stringContaining('the hook answered neither null nor a refusal')]);
  });

  it('C12: logs the fault at most once a minute for the whole process', async () => {
    setClock('2026-11-21T16:00:00Z');
    const lines = captureStderr();
    const k = mint({ ownerSubject: 'oid-a' });
    const { quota } = spy(() => {
      throw new Error('meter broke');
    });
    await start({ perCaller: WIDE, perAddress: WIDE }, { keyQuota: quota });
    expect([await recall(bearer(k)), await recall(bearer(k)), await recall(bearer(k))].map((r) => r.status)).toEqual([
      200, 200, 200,
    ]);
    expect(lines()).toHaveLength(1);
    setClock('2026-11-21T16:01:01Z');
    expect((await recall(bearer(k))).status).toBe(200);
    expect(lines()).toHaveLength(2);
  });

  it('C13: admits the request when reading the answer throws', async () => {
    setClock('2026-11-21T17:00:00Z');
    const lines = captureStderr();
    const k = mint({ ownerSubject: 'oid-a' });
    const answer = {
      retryAfterSec: 5,
      get message(): string {
        throw new Error('getter broke');
      },
    };
    await start({ perCaller: WIDE, perAddress: WIDE }, { keyQuota: spy(() => answer).quota });
    expect((await recall(bearer(k))).status).toBe(200);
    expect(lines()).toEqual([expect.stringContaining('the hook threw')]);
  });

  it('C13: admits the request when the hook returns a rejecting promise, with no unhandled rejection', async () => {
    setClock('2026-11-21T18:00:00Z');
    const lines = captureStderr();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const k = mint({ ownerSubject: 'oid-a' });
      await start(
        { perCaller: WIDE, perAddress: WIDE },
        { keyQuota: spy(() => Promise.reject(new Error('late'))).quota },
      );
      expect((await recall(bearer(k))).status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(lines()).toEqual([expect.stringContaining('the hook answered neither null nor a refusal')]);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
