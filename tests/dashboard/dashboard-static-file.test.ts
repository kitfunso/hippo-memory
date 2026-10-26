// The built app is read once into a map, so a path the map does not hold is never read from disk; each file goes out
// gzipped when the client takes it, with a strong ETag that a second request turns into a 304.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, get as httpGet, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { assetFor, loadStaticFiles, sendAsset, type StaticFiles } from '../../src/surface/dashboard/static-file.js';
import { boundPort } from '../_helpers/listen.js';

const INDEX = '<!doctype html><title>hippo</title>'.repeat(20);
const BUNDLE = 'console.log("the app");\n'.repeat(200);

let dir: string;
let root: string;
let server: Server | undefined;
let stderr: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hippo-static-'));
  root = join(dir, 'app');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), INDEX);
  writeFileSync(join(root, 'assets', 'index-B3x_k9Q-.js'), BUNDLE);
  writeFileSync(join(root, 'assets', 'logo-AbCd1234.png'), randomBytes(512));
  writeFileSync(join(root, 'notes.txt'), 'not a type the dashboard serves');
  mkdirSync(join(dir, 'outside'));
  writeFileSync(join(dir, 'outside', 'x.js'), 'outside');
  writeFileSync(join(dir, 'secret.js'), 'outside');
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

function load(): StaticFiles {
  const files = loadStaticFiles(root);
  if (files === null) throw new Error('the app should load');
  return files;
}

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** GETs `urlPath` from a server that answers with sendAsset, with exactly `headers`; fetch would add its own. */
async function request(files: StaticFiles, urlPath: string, headers: Record<string, string> = {}): Promise<Reply> {
  server ??= createServer((req, res) => {
    const asset = assetFor(files, req.url ?? '/');
    if (asset === undefined) res.writeHead(404).end();
    else sendAsset(req, res, asset);
  }).listen(0, '127.0.0.1');
  const port = await boundPort(server);
  return new Promise((resolve, reject) => {
    httpGet({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

describe('loadStaticFiles', () => {
  it('is null while the app has no index.html', () => {
    rmSync(join(root, 'index.html'));
    expect(loadStaticFiles(root)).toBeNull();
  });

  it('holds each file of a served type by URL path, and nothing behind a link out of the root', () => {
    // A junction needs no privilege on Windows; elsewhere the type is ignored and this is a plain link.
    symlinkSync(join(dir, 'outside'), join(root, 'linked'), 'junction');
    expect([...load().keys()].sort()).toEqual([
      '/assets/index-B3x_k9Q-.js',
      '/assets/logo-AbCd1234.png',
      '/index.html',
    ]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'logs a file that will not read and leaves it out (chmod cannot block a read on Windows or as root)',
    () => {
      const file = join(root, 'assets', 'index-B3x_k9Q-.js');
      chmodSync(file, 0o000);
      try {
        expect(load().has('/assets/index-B3x_k9Q-.js')).toBe(false);
      } finally {
        chmodSync(file, 0o600);
      }
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(
        /reading .*index-B3x_k9Q-\.js failed \(EACCES\)/,
      );
    },
  );
});

describe('assetFor', () => {
  it('finds a file by its path, escaped or not, and answers index.html for any other path', () => {
    const files = load();
    const bundle = files.get('/assets/index-B3x_k9Q-.js');
    const index = files.get('/index.html');
    expect(assetFor(files, '/assets/index-B3x_k9Q-.js')).toBe(bundle);
    expect(assetFor(files, '/assets/%69ndex-B3x_k9Q-.js')).toBe(bundle);
    const elsewhere = ['/', '/projects/p:alpha', '/notes.txt', '/../secret.js', '/..%2Fsecret.js', '/linked/x.js'];
    for (const urlPath of [...elsewhere, '//etc/passwd', `/${join(dir, 'secret.js')}`, '/app.js%00.html']) {
      expect(assetFor(files, urlPath), urlPath).toBe(index);
    }
  });

  it('answers 400 for a malformed escape', () => {
    expect(() => assetFor(load(), '/%E0%A4%A')).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('sendAsset', () => {
  it('sends gzip to a client that takes it, then a 304 for the ETag it got', async () => {
    const files = load();
    const first = await request(files, '/assets/index-B3x_k9Q-.js', { 'accept-encoding': 'br, gzip;q=0.8' });
    expect(first.status).toBe(200);
    expect(first.headers).toMatchObject({
      'content-type': 'application/javascript; charset=utf-8',
      'content-encoding': 'gzip',
      'cache-control': 'public, max-age=31536000, immutable',
      vary: 'Accept-Encoding',
    });
    expect(gunzipSync(first.body).toString()).toBe(BUNDLE);
    expect(first.body.length).toBeLessThan(BUNDLE.length);
    expect(first.headers['content-length']).toBe(String(first.body.length));

    const etag = first.headers.etag ?? '';
    const second = await request(files, '/assets/index-B3x_k9Q-.js', {
      'accept-encoding': 'gzip',
      'if-none-match': etag,
    });
    expect(second.status).toBe(304);
    expect(second.body.length).toBe(0);
    expect(second.headers).toMatchObject({ etag, 'cache-control': 'public, max-age=31536000, immutable' });
    expect(second.headers['content-encoding']).toBeUndefined();
  });

  it('sends the plain bytes, with their own ETag, to a client that refuses gzip or names none', async () => {
    const files = load();
    const gzipped = await request(files, '/index.html', { 'accept-encoding': 'gzip' });
    const asks: Array<Record<string, string>> = [{}, { 'accept-encoding': 'gzip;q=0, deflate' }];
    for (const headers of asks) {
      const plain = await request(files, '/index.html', headers);
      expect(plain.status).toBe(200);
      expect(plain.body.toString()).toBe(INDEX);
      expect(plain.headers).toMatchObject({ 'cache-control': 'no-cache', vary: 'Accept-Encoding' });
      expect(plain.headers['content-encoding']).toBeUndefined();
      expect(plain.headers.etag).not.toBe(gzipped.headers.etag);
    }
  });

  it('answers 304 to a weak or listed tag, and 200 to a tag for other bytes', async () => {
    const files = load();
    const { etag } = (await request(files, '/index.html')).headers;
    expect((await request(files, '/index.html', { 'if-none-match': `W/${etag}` })).status).toBe(304);
    expect((await request(files, '/index.html', { 'if-none-match': `"other", ${etag}` })).status).toBe(304);
    expect((await request(files, '/index.html', { 'if-none-match': '"other"' })).status).toBe(200);
  });

  it('sends a file gzip would not shrink as it is, even to a client that takes gzip', async () => {
    const png = await request(load(), '/assets/logo-AbCd1234.png', { 'accept-encoding': 'gzip' });
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-encoding']).toBeUndefined();
    expect(png.body.length).toBe(512);
    expect(png.headers['content-length']).toBe('512');
  });
});
