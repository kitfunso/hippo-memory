// A static asset that is missing falls through to the next route; one that exists but will not read is a logged 500.
// Every URL path maps into the app's folder through one rule, which refuses any path that leaves it.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { serveStaticFile, staticFileUnder } from '../src/surface/dashboard/static-file.js';
import { boundPort } from './_helpers/listen.js';

let dir: string;
let server: Server | undefined;
let stderr: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hippo-static-'));
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((done) => server!.close(() => done()));
  }
  server = undefined;
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

describe('staticFileUnder', () => {
  let root: string;

  beforeEach(() => {
    root = join(dir, 'app');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
    mkdirSync(join(dir, 'app-sibling'));
    writeFileSync(join(dir, 'app-sibling', 'x.js'), 'outside');
    writeFileSync(join(dir, 'secret.js'), 'outside');
  });

  it('maps a path to the file under the root, and a folder or a missing file to null', () => {
    expect(staticFileUnder(root, '/assets/app.js')).toBe(realpathSync(join(root, 'assets', 'app.js')));
    expect(staticFileUnder(root, '/assets/%61pp.js')).toBe(realpathSync(join(root, 'assets', 'app.js')));
    expect(staticFileUnder(root, '/')).toBeNull();
    expect(staticFileUnder(root, '/assets')).toBeNull();
    expect(staticFileUnder(root, '/nope.js')).toBeNull();
  });

  it.each([
    '/../secret.js',
    '/..%2Fsecret.js',
    '/%2E%2E%2Fsecret.js',
    '/assets/..%2F..%2Fsecret.js',
    '/../app-sibling/x.js',
  ])('refuses %s, which leaves the root, with a 403', (urlPath) => {
    expect(() => staticFileUnder(root, urlPath)).toThrow(expect.objectContaining({ status: 403 }));
  });

  it('maps a path that starts with extra slashes under the root, so it never names a file elsewhere on disk', () => {
    for (const urlPath of ['//etc/passwd', '/%2Fetc%2Fpasswd', '/%2F%2Fetc%2Fpasswd']) {
      expect(staticFileUnder(root, urlPath)).toBeNull();
    }
  });

  it('refuses, or maps under the root, a path that names an absolute file', () => {
    const secret = join(dir, 'secret.js');
    for (const urlPath of [`/${secret}`, `/${encodeURIComponent(secret)}`]) {
      // A drive letter mid-path resolves outside the root on Windows; elsewhere the path joins under it.
      if (process.platform === 'win32') {
        expect(() => staticFileUnder(root, urlPath)).toThrow(expect.objectContaining({ status: 403 }));
      } else {
        expect(staticFileUnder(root, urlPath)).toBeNull();
      }
    }
  });

  it('refuses a link inside the root that points out of it', () => {
    // A junction needs no privilege on Windows; elsewhere the type is ignored and this is a plain link.
    symlinkSync(join(dir, 'app-sibling'), join(root, 'linked'), 'junction');
    expect(() => staticFileUnder(root, '/linked/x.js')).toThrow(expect.objectContaining({ status: 403 }));
  });

  it('answers 400 for a malformed escape or a NUL byte', () => {
    for (const urlPath of ['/%E0%A4%A', '/app.js%00.html']) {
      expect(() => staticFileUnder(root, urlPath)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});
