import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { postForget, postRemember, HttpResponseError } from '../../src/surface/cli/client.js';

let server: Server | undefined;

function sendBusy(res: ServerResponse): void {
  res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
  res.end(JSON.stringify({ error: 'store busy: another process holds the write lock; retry shortly' }));
}

async function startFake(busyCount: number): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits++;
      if (hits <= busyCount) return sendBusy(res);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          req.method === 'DELETE' ? { ok: true, id: 'm1' } : { id: 'm1', kind: 'distilled', tenantId: 'default' },
        ),
      );
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
    const result = await postRemember(fake.url, undefined, { content: 'held lock clears', force: true });
    expect(result.id).toBe('m1');
    expect(fake.hits()).toBe(3);
  }, 7_000);

  it('remember gives up with the 503 inside the ~5 s budget when the lock never clears', async () => {
    const fake = await startFake(Number.POSITIVE_INFINITY);
    const realSetTimeout = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      // SAFETY: the client's pause passes a callback and a delay, the one overload this stands in for.
      ((handler: () => void, ms?: number) => realSetTimeout(handler, ms === 1_000 ? 0 : ms)) as typeof setTimeout,
    );
    const err = await postRemember(fake.url, undefined, { content: 'lock never clears' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(HttpResponseError);
    expect(err).toMatchObject({ status: 503, message: expect.stringMatching(/store busy/) });
    expect(fake.hits()).toBe(5);
    expect(timers.mock.calls.filter(([, ms]) => ms === 1_000)).toHaveLength(4);
  });

  it('forget retries a busy 503 too, since a routed write commits nothing before it answers busy', async () => {
    const fake = await startFake(1);
    await expect(postForget(fake.url, undefined, 'm1')).resolves.toEqual({ ok: true, id: 'm1' });
    expect(fake.hits()).toBe(2);
  });
});
