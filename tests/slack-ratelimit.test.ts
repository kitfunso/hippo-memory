import { describe, it, expect, vi } from 'vitest';
import { fetchWithRetry } from '../src/connectors/slack/ratelimit.js';

describe('fetchWithRetry', () => {
  it('retries once after 429 with Retry-After honoured', async () => {
    const sleeps: number[] = [];
    const sleep = (ms: number) => { sleeps.push(ms); return Promise.resolve(); };
    const calls: Response[] = [
      new Response(JSON.stringify({}), { status: 429, headers: { 'retry-after': '0.05' } }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ];
    let i = 0;
    const fakeFetch = vi.fn(async () => calls[i++]);
    const r = await fetchWithRetry({ url: 'http://x', fetchImpl: fakeFetch, sleep, maxRetries: 3 });
    expect(r.status).toBe(200);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(sleeps[0]).toBe(50); // 0.05s in ms
  });

  it('gives up after maxRetries and throws', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 429, headers: { 'retry-after': '0.01' } }),
    );
    await expect(fetchWithRetry({ url: 'http://x', fetchImpl: fakeFetch, sleep: () => Promise.resolve(), maxRetries: 2 })).rejects.toThrow(/rate.?limited/i);
    expect(fakeFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
