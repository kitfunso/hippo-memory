// A static asset that is missing falls through to the next route; one that exists but will not read is a logged 500.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { serveStaticFile } from '../src/dashboard/static-file.js';
import { boundPort } from './_helpers/listen.js';

let dir: string;
let server: Server;
let stderr: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hippo-static-'));
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** A server that serves `name` under dir, and answers 'fell through' when serveStaticFile declines. */
async function get(name: string): Promise<{ status: number; type: string | null; body: string }> {
  server = createServer((_req, res) => {
    if (!serveStaticFile(res, join(dir, name))) res.end('fell through');
  });
  server.listen(0, '127.0.0.1');
  const res = await fetch(`http://127.0.0.1:${await boundPort(server)}/`);
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
}

describe('serveStaticFile', () => {
  it('sends a readable asset with its type', async () => {
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    expect(await get('app.js')).toEqual({
      status: 200,
      type: 'application/javascript; charset=utf-8',
      body: 'console.log(1)',
    });
  });

  it('declines a missing asset so the next route answers, without logging', async () => {
    expect(await get('gone.js')).toMatchObject({ status: 200, body: 'fell through' });
    expect(stderr).not.toHaveBeenCalled();
  });

  it('answers 500 and logs the error code for an asset that exists but cannot be read', async () => {
    mkdirSync(join(dir, 'broken.js'));
    const res = await get('broken.js');
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Internal error' });
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(
      /error: dashboard: reading .*broken\.js failed \(EISDIR\)/,
    );
  });
});
