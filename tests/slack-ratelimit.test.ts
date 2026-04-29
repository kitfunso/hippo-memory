import { describe, it, expect, vi } from 'vitest';
import { fetchWithRetry } from '../src/connectors/slack/ratelimit.js';

describe('fetchWithRetry', () => {
  it('retries once after 429 with Retry-After honoured', async () => {
    const sleeps: number[] = [];
    const sleep = (ms: number) => { sleeps.push(ms); return Promise.resolve(); };
    const calls = [
      { status: 429, headers: { get: (h: string) => h === 'retry-after' ? '0.05' : null }, json: async () => ({}) },
      { status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) },
    ];
    let i = 0;
    const fakeFetch = vi.fn(async () => calls[i++] as Response);
    const r = await fetchWithRetry({ url: 'http://x', fetchImpl: fakeFetch as typeof fetch, sleep, maxRetries: 3 });
    expect(r.status).toBe(200);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(sleeps[0]).toBe(50); // 0.05s in ms
  });

  it('gives up after maxRetries and throws', async () => {
    const fakeFetch = vi.fn(async () => ({ status: 429, headers: { get: () => '0.01' }, json: async () => ({}) }) as Response);
    await expect(fetchWithRetry({ url: 'http://x', fetchImpl: fakeFetch as typeof fetch, sleep: () => Promise.resolve(), maxRetries: 2 })).rejects.toThrow(/rate.?limited/i);
    expect(fakeFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
