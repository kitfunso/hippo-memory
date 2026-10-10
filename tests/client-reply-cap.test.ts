// The thin client reads every server reply under a cap: the port its pidfile names may now belong to another process.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promote, remember, HttpResponseError } from '../src/cli/client.js';

const OVER_CAP = 'x'.repeat(1024 * 1024 + 1);

let server: Server | undefined;

/** A server that answers every request with `status` and `body`. */
async function startFake(status: number, body: string): Promise<string> {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  // SAFETY: a TCP listen always yields AddressInfo.
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe('thin client reply cap', () => {
  it('returns a normal reply', async () => {
    const url = await startFake(200, JSON.stringify({ ok: true, sourceId: 'a', globalId: 'b' }));
    await expect(promote(url, undefined, 'a')).resolves.toEqual({ ok: true, sourceId: 'a', globalId: 'b' });
  });

  it('refuses a 2xx reply past the cap', async () => {
    const url = await startFake(200, JSON.stringify({ id: OVER_CAP }));
    await expect(remember(url, undefined, { content: 'a fact' })).rejects.toThrow('reply over 1048576 bytes');
  });

  it("keeps the server's error message and falls back to the status line past the cap", async () => {
    const small = await startFake(404, JSON.stringify({ error: 'memory not found' }));
    await expect(promote(small, undefined, 'a')).rejects.toMatchObject({ status: 404, message: 'memory not found' });
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    const big = await startFake(500, JSON.stringify({ error: OVER_CAP }));
    const err = await promote(big, undefined, 'a').catch((e: Error) => e);
    expect(err).toBeInstanceOf(HttpResponseError);
    expect(err).toMatchObject({ status: 500, message: '500 Internal Server Error' });
  });
});
