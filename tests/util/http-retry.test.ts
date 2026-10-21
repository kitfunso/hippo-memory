// Every outbound call goes through fetchWithRetry, so a stalled peer or a rate limit must end bounded and predictable.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  fetchWithRetry,
  isRetryableStatus,
  llmTimeoutMs,
  llmTotalMs,
  parseRetryAfterMs,
} from '../../src/infra/http-retry.js';
import { envLlmTimeoutMs } from '../../src/base/util/env.js';
import { classifyTransportFailure } from '../../src/surface/cli/client.js';
import { waitFor } from '../_helpers/wait-for.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

let server: http.Server | null = null;
const stalled: http.ServerResponse[] = [];

/** Serves `replies` in order (the last one repeats); a null reply never answers and 'reset' drops the socket unanswered. */
async function startServer(replies: readonly (Reply | 'reset' | null)[]): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  server = http.createServer((req, res) => {
    const reply = replies[Math.min(hits, replies.length - 1)];
    hits++;
    if (reply === null) {
      stalled.push(res);
      return;
    }
    if (reply === 'reset') {
      req.socket.destroy();
      return;
    }
    res.writeHead(reply.status, reply.headers ?? {});
    res.end(reply.body ?? '');
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name or null.
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, hits: () => hits };
}

afterEach(async () => {
  for (const res of stalled.splice(0)) res.destroy();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  server = null;
  vi.stubEnv('HIPPO_LLM_TIMEOUT_MS', undefined);
  vi.restoreAllMocks();
});

const noSleep = { sleep: async () => undefined };

describe('fetchWithRetry against a local server', () => {
  it('ends a stalled write with a TimeoutError instead of hanging, and never sends it twice', async () => {
    const { url, hits } = await startServer([null]);
    const deadlines = vi.spyOn(AbortSignal, 'timeout');
    const err = await fetchWithRetry(url, { method: 'POST', body: '{}' }, { timeoutMs: 200 }).then(
      () => {
        throw new Error('the stalled write resolved');
      },
      (e: Error) => e,
    );
    expect(err.name).toBe('TimeoutError');
    // The one attempt ran under the caller's limit, so the wait is that limit and no more.
    expect(deadlines.mock.calls).toEqual([[200]]);
    expect(hits()).toBe(1);
    // A timed-out write to `hippo serve` may have landed, so the CLI must not replay it locally.
    expect(classifyTransportFailure(err)).toBe('delivery-unknown');
  });

  it('retries a GET whose connection the server dropped, and returns the answer that follows', async () => {
    const { url, hits } = await startServer(['reset', 'reset', { status: 200, body: 'ok' }]);
    const sleeps: number[] = [];
    const res = await fetchWithRetry(
      url,
      {},
      {
        timeoutMs: 2000,
        random: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(await res.text()).toBe('ok');
    expect(hits()).toBe(3);
    // The same backoff a 5xx gets.
    expect(sleeps).toEqual([125, 250]);
  });

  it('retries a GET attempt that timed out', async () => {
    const { url, hits } = await startServer([null, { status: 200, body: 'ok' }]);
    const res = await fetchWithRetry(url, { method: 'get' }, { timeoutMs: 200, ...noSleep });
    expect(await res.text()).toBe('ok');
    expect(hits()).toBe(2);
  });

  it('gives up on a dropped connection after the attempt cap and throws the transport error', async () => {
    const { url, hits } = await startServer(['reset']);
    const err = await fetchWithRetry(url, { method: 'HEAD' }, { timeoutMs: 2000, ...noSleep }).then(
      () => {
        throw new Error('the dropped HEAD resolved');
      },
      (e: Error) => e,
    );
    expect(classifyTransportFailure(err)).toBe('delivery-unknown');
    expect(hits()).toBe(3);
  });

  it('replays a dropped POST for a caller that says a replay is safe', async () => {
    const { url, hits } = await startServer(['reset', { status: 200, body: 'ok' }]);
    const res = await fetchWithRetry(
      url,
      { method: 'POST', body: '{}' },
      { timeoutMs: 2000, retryTransport: true, ...noSleep },
    );
    expect(await res.text()).toBe('ok');
    expect(hits()).toBe(2);
  });

  it('does not retry a refused connection, so a caller with a local fallback takes it at once', async () => {
    const { url } = await startServer([{ status: 200 }]);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    const sleeps: number[] = [];
    await expect(
      fetchWithRetry(
        url,
        {},
        {
          timeoutMs: 2000,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toThrow();
    expect(sleeps).toEqual([]);
  });

  it('retries a 503 and returns the 200 that follows', async () => {
    const { url, hits } = await startServer([{ status: 503 }, { status: 200, body: 'ok' }]);
    const res = await fetchWithRetry(url, {}, { timeoutMs: 2000, ...noSleep });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(hits()).toBe(2);
  });

  it('waits the Retry-After seconds on a 429, then retries', async () => {
    const { url, hits } = await startServer([{ status: 429, headers: { 'retry-after': '2' } }, { status: 200 }]);
    const sleeps: number[] = [];
    const res = await fetchWithRetry(
      url,
      {},
      {
        timeoutMs: 2000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(res.status).toBe(200);
    expect(hits()).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it('never retries a 400', async () => {
    const { url, hits } = await startServer([{ status: 400, body: 'bad request' }, { status: 200 }]);
    const res = await fetchWithRetry(url, {}, { timeoutMs: 2000, ...noSleep });
    expect(res.status).toBe(400);
    expect(hits()).toBe(1);
  });

  it('stops after three attempts and hands back the last 5xx', async () => {
    const { url, hits } = await startServer([{ status: 502 }]);
    const sleeps: number[] = [];
    const res = await fetchWithRetry(
      url,
      {},
      {
        timeoutMs: 2000,
        random: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(res.status).toBe(502);
    expect(hits()).toBe(3);
    // random() = 0 gives the floor of each jitter window: half of 250, then half of 500.
    expect(sleeps).toEqual([125, 250]);
  });

  describe('with a total budget', () => {
    // The clock moves only by the waits, so the budget is measured on them alone. What is left of it is
    // also each attempt's real timeout, so every budget here leaves the last attempt hundreds of ms.
    function fakeClock() {
      let clock = 0;
      const sleeps: number[] = [];
      return {
        sleeps,
        policy: {
          random: () => 0,
          now: () => clock,
          sleep: async (ms: number) => {
            sleeps.push(ms);
            clock += ms;
          },
        },
      };
    }

    it('hands back the last 5xx once the next wait would pass totalMs, before the attempt cap', async () => {
      const { url, hits } = await startServer([{ status: 503 }]);
      const { sleeps, policy } = fakeClock();
      const res = await fetchWithRetry(url, {}, { timeoutMs: 2000, attempts: 10, totalMs: 1800, ...policy });
      expect(res.status).toBe(503);
      // Waits of 125, 250 and 500 end at 875; the next one, 1000, would end at 1875, past the budget.
      expect(sleeps).toEqual([125, 250, 500]);
      expect(hits()).toBe(4);
    });

    it('throws the transport error once the next wait would pass totalMs', async () => {
      const { url, hits } = await startServer(['reset']);
      const { sleeps, policy } = fakeClock();
      await expect(fetchWithRetry(url, {}, { timeoutMs: 2000, attempts: 10, totalMs: 850, ...policy })).rejects.toThrow(
        /fetch failed|socket/i,
      );
      // Waits of 125 and 250 end at 375; the next one, 500, would end at 875, past the budget.
      expect(sleeps).toEqual([125, 250]);
      expect(hits()).toBe(3);
    });

    it('cuts a stalled attempt short at the budget rather than at its own timeout', async () => {
      const { url } = await startServer([null]);
      const pending = fetchWithRetry(url, { method: 'POST' }, { timeoutMs: 60_000, totalMs: 200 });
      await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    });
  });

  it('returns a 429 whose Retry-After exceeds the cap, so the caller can run its own longer pause', async () => {
    const { url, hits } = await startServer([{ status: 429, headers: { 'retry-after': '60' } }, { status: 200 }]);
    const res = await fetchWithRetry(url, {}, { timeoutMs: 2000, ...noSleep });
    expect(res.status).toBe(429);
    expect(hits()).toBe(1);
  });

  it('still honours a caller abort signal alongside its own timeout', async () => {
    const { url, hits } = await startServer([null]);
    const controller = new AbortController();
    const sleeps: number[] = [];
    const pending = fetchWithRetry(
      url,
      { signal: controller.signal },
      {
        timeoutMs: 60_000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    // The abort lands once the server holds the request, so it ends an attempt in flight rather than one not yet sent.
    await waitFor(() => hits() === 1, { what: 'the request to reach the server' });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // The caller gave up, so no second attempt is queued.
    expect(sleeps).toEqual([]);
  });
});

describe('the wait between attempts under a caller signal', () => {
  const neverWakes = (): Promise<void> => new Promise(() => undefined);
  /** `fetch`, counting the attempts that were started. */
  function countedFetch() {
    let calls = 0;
    const fetchFn: typeof fetch = (input, init) => {
      calls++;
      return fetch(input, init);
    };
    return { fetchFn, calls: () => calls };
  }

  it('ends when the signal aborts during the wait a 503 asked for, with the abort reason and no further attempt', async () => {
    const { url, hits } = await startServer([{ status: 503, headers: { 'retry-after': '2' } }, { status: 200 }]);
    const controller = new AbortController();
    const { fetchFn, calls } = countedFetch();
    const reason = new Error('caller gave up');
    // The two-second timer is the wait the 503 asked for, so the abort lands while the client is known to be in it.
    const realSetTimeout = globalThis.setTimeout;
    let waitTimer: NodeJS.Timeout | undefined;
    const waiting = new Promise<void>((resolve) => {
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
        const timer = realSetTimeout(fn, ms, ...rest);
        if (ms === 2000) {
          waitTimer = timer;
          resolve();
        }
        return timer;
      });
    });
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    const pending = fetchWithRetry(url, { signal: controller.signal }, { timeoutMs: 60_000, fetchFn });
    await waiting;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect([calls(), hits()]).toEqual([1, 1]);
    // A wait the caller left must not keep the process alive for its two seconds.
    expect(cleared).toHaveBeenCalledWith(waitTimer);
  });

  it('ends an injected sleep the same way after a dropped connection', async () => {
    const { url, hits } = await startServer(['reset', { status: 200 }]);
    const controller = new AbortController();
    const { fetchFn, calls } = countedFetch();
    const sleeps: number[] = [];
    // Aborts from inside the wait, once the client has begun it, so the abort cannot land during the attempt instead.
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      queueMicrotask(() => controller.abort(new Error('caller gave up')));
      return neverWakes();
    };
    const pending = fetchWithRetry(
      url,
      { signal: controller.signal },
      { timeoutMs: 60_000, fetchFn, sleep, random: () => 0 },
    );
    await expect(pending).rejects.toThrow('caller gave up');
    expect(sleeps).toEqual([125]);
    expect([calls(), hits()]).toEqual([1, 1]);
  });

  it('starts no wait when the signal aborted while the reply was read', async () => {
    const { url } = await startServer([{ status: 503 }, { status: 200 }]);
    const controller = new AbortController();
    const sleeps: number[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      controller.abort(new Error('caller gave up'));
      return res;
    };
    const pending = fetchWithRetry(
      url,
      { signal: controller.signal },
      {
        timeoutMs: 60_000,
        fetchFn,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    await expect(pending).rejects.toThrow('caller gave up');
    expect(sleeps).toEqual([]);
  });

  it('waits in full and retries when the signal never aborts, and when there is none', async () => {
    for (const signal of [new AbortController().signal, undefined]) {
      const { url, hits } = await startServer([{ status: 503 }, { status: 200 }]);
      const sleeps: number[] = [];
      const sleep = async (ms: number): Promise<void> => {
        sleeps.push(ms);
      };
      const res = await fetchWithRetry(
        url,
        { signal },
        { timeoutMs: 60_000, baseDelayMs: 200, random: () => 1, sleep },
      );
      expect(res.status).toBe(200);
      expect(hits()).toBe(2);
      // Attempt 1 waits ceiling/2 + random * ceiling/2 = 200 ms at random 1.
      expect(sleeps).toEqual([200]);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  });
});

describe('the pooled-socket release between attempts', () => {
  it('still retries when cancelling the failed reply body rejects', async () => {
    const bad = new Response('x', { status: 503 });
    Object.defineProperty(bad, 'body', { value: { cancel: () => Promise.reject(new TypeError('cancel failed')) } });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(bad)
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await fetchWithRetry(
      'http://127.0.0.1:1/',
      {},
      { timeoutMs: 60_000, fetchFn, ...noSleep, random: () => 0 },
    );
    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('retry helpers', () => {
  it('treats only 429 and 5xx as retryable', () => {
    expect([429, 500, 503, 529, 599].every(isRetryableStatus)).toBe(true);
    expect([200, 301, 400, 401, 403, 404, 600].some(isRetryableStatus)).toBe(false);
  });

  it('reads Retry-After as seconds or as an HTTP date', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfterMs('0.05', now)).toBe(50);
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:03 GMT', now)).toBe(3000);
    expect(parseRetryAfterMs('Wed, 31 Dec 2025 23:59:00 GMT', now)).toBe(0);
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs('soon', now)).toBeNull();
  });

  it('takes the LLM timeout the caller read from HIPPO_LLM_TIMEOUT_MS, and 60 s for junk or none', () => {
    expect(llmTimeoutMs()).toBe(60_000);
    vi.stubEnv('HIPPO_LLM_TIMEOUT_MS', '1500');
    expect(llmTimeoutMs(envLlmTimeoutMs())).toBe(1500);
    vi.stubEnv('HIPPO_LLM_TIMEOUT_MS', 'zero');
    expect(llmTimeoutMs(envLlmTimeoutMs())).toBe(60_000);
  });

  it('gives one LLM call, retries included, two attempts and the longest wait', () => {
    expect(llmTotalMs()).toBe(128_000);
    expect(llmTotalMs(llmTimeoutMs(1500))).toBe(11_000);
  });
});
