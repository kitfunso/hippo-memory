// The thin client rides out a busy-store 503 on its routed writes, then surfaces it once the ~5 s budget is spent.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { forget, remember, HttpResponseError } from '../src/cli/client.js';

let server: Server | undefined;

function sendBusy(res: ServerResponse): void {
  res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
  res.end(JSON.stringify({ error: 'store busy: another process holds the write lock; retry shortly' }));
}

/** A server that answers the first `busyCount` requests with a busy 503, then 200; returns its URL and a request counter. */
async function startFake(busyCount: number): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits++;
      if (hits <= busyCount) return sendBusy(res);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.method === 'DELETE' ? { ok: true, id: 'm1' } : { id: 'm1', kind: 'distilled', tenantId: 'default' }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  // SAFETY: a TCP listen always yields AddressInfo.
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits: () => hits };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe('thin client under a busy store', () => {
  it('remember retries two busy 503s and returns the 200', async () => {
    const fake = await startFake(2);
    const result = await remember(fake.url, undefined, { content: 'held lock clears' });
    expect(result.id).toBe('m1');
    expect(fake.hits()).toBe(3);
  }, 15_000);

  it('remember gives up with the 503 inside the ~5 s budget when the lock never clears', async () => {
    const fake = await startFake(Number.POSITIVE_INFINITY);
    const realSetTimeout = globalThis.setTimeout;
    // The pauses the client asks for are the budget, so each is recorded and then skipped, not waited out.
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      // SAFETY: the client's pause passes a callback and a delay, the one overload this stands in for.
      ((handler: () => void, ms?: number) => realSetTimeout(handler, ms === 1_000 ? 0 : ms)) as typeof setTimeout,
    );
    const err = await remember(fake.url, undefined, { content: 'lock never clears' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(HttpResponseError);
    expect(err).toMatchObject({ status: 503, message: expect.stringMatching(/store busy/) });
    expect(fake.hits()).toBe(5);
    // Four pauses, each the one second the server named, and none after the last try: that sum is the budget.
    expect(timers.mock.calls.filter(([, ms]) => ms === 1_000)).toHaveLength(4);
  }, 15_000);

  it('forget retries a busy 503 too, since a routed write commits nothing before it answers busy', async () => {
    const fake = await startFake(1);
    await expect(forget(fake.url, undefined, 'm1')).resolves.toEqual({ ok: true, id: 'm1' });
    expect(fake.hits()).toBe(2);
  }, 15_000);
});
