// The dashboard's static files: the built app, read once at listener start into one map from URL path to the bytes it
// sends, and the reply that serves one with its validators. A path the map does not hold is never read from disk.
import { createHash } from 'crypto';
import * as fs from 'fs';
import type * as http from 'http';
import * as path from 'path';
import { gzipSync } from 'zlib';
import { PACKAGE_ROOT } from '../../base/config/package-root.js';
import { HttpError } from '../../base/util/http-util.js';
import { errorCode, errorFields, errorMessage, log } from '../../base/util/log.js';

/** Where the build puts the React app. */
export const DASHBOARD_STATIC_ROOT = path.join(PACKAGE_ROOT, 'dist-ui');

/** The app's folder when its index.html is built, else null. */
export function builtStaticRoot(root: string = DASHBOARD_STATIC_ROOT): string | null {
  return fs.existsSync(path.join(root, 'index.html')) ? root : null;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
} as const;

type StaticFileExtension = keyof typeof MIME_TYPES;

function isStaticFileExtension(ext: string): ext is StaticFileExtension {
  return Object.hasOwn(MIME_TYPES, ext);
}

/** One encoding of a file, with the strong validator of exactly these bytes. */
interface Encoded {
  readonly body: Buffer;
  readonly etag: string;
}

/** One built file as it is sent. */
export interface StaticAsset {
  readonly type: string;
  readonly cacheControl: string;
  readonly plain: Encoded;
  /** Null when gzip would not make the file smaller. */
  readonly gzip: Encoded | null;
}

/** The built app by URL path, such as `/assets/index-3f2a9c1b.js`. */
export type StaticFiles = ReadonlyMap<string, StaticAsset>;

// Vite names each bundle after a hash of its content, so a changed bundle comes at a new URL.
const HASHED = /^\/assets\/.+-[\w-]{8}\.\w+$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

function assetOf(urlPath: string, body: Buffer, type: string): StaticAsset {
  const hash = createHash('sha256').update(body).digest('base64url');
  const gzip = gzipSync(body, { level: 9 });
  return {
    type,
    cacheControl: HASHED.test(urlPath) ? IMMUTABLE : 'no-cache',
    plain: { body, etag: `"${hash}"` },
    gzip: gzip.length < body.length ? { body: gzip, etag: `"${hash}-gzip"` } : null,
  };
}

// Real folders only: a link is never followed, so no file outside the root can enter the map.
function* filesUnder(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(full);
    else if (entry.isFile()) yield full;
  }
}

function readAsset(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    log.error(
      `dashboard: reading ${file} failed (${errorCode(err) || errorMessage(err)}); it will not be served`,
      errorFields(err),
    );
    return null;
  }
}

/** Every file under `root` with a type the dashboard serves, read once; null when the app is not built. */
export function loadStaticFiles(root: string = DASHBOARD_STATIC_ROOT): StaticFiles | null {
  if (builtStaticRoot(root) === null) return null;
  const files = new Map<string, StaticAsset>();
  for (const file of filesUnder(root)) {
    const ext = path.extname(file).toLowerCase();
    if (!isStaticFileExtension(ext)) continue;
    const body = readAsset(file);
    const urlPath = `/${path.relative(root, file).split(path.sep).join('/')}`;
    if (body !== null) files.set(urlPath, assetOf(urlPath, body, MIME_TYPES[ext]));
  }
  return files;
}

/** The file a URL path names, else index.html, since the app routes in the browser; undefined when neither is held. */
export function assetFor(files: StaticFiles, urlPath: string): StaticAsset | undefined {
  let name: string;
  try {
    name = decodeURIComponent(urlPath);
  } catch (err) {
    if (err instanceof URIError) throw new HttpError(400, 'Malformed URL path');
    throw err;
  }
  return files.get(name) ?? files.get('/index.html');
}

// A q of 0 refuses a coding.
function takesGzip(header: string | undefined): boolean {
  return (header ?? '').split(',').some((part) => {
    const [coding, ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    const q = params.find((p) => p.startsWith('q='));
    return coding === 'gzip' && (q === undefined || Number(q.slice(2)) > 0);
  });
}

// If-None-Match compares weakly, so W/"x" names the same bytes as "x".
function holdsVersion(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(',').some((tag) => {
    const t = tag.trim();
    return t === '*' || t.replace(/^W\//, '') === etag;
  });
}

/** Sends `asset` gzipped when the client takes gzip, or a 304 when the client already holds those bytes. */
export function sendAsset(req: http.IncomingMessage, res: http.ServerResponse, asset: StaticAsset): void {
  const sent = asset.gzip !== null && takesGzip(req.headers['accept-encoding']) ? asset.gzip : asset.plain;
  const validators = { ETag: sent.etag, 'Cache-Control': asset.cacheControl, Vary: 'Accept-Encoding' };
  if (holdsVersion(req.headers['if-none-match'], sent.etag)) {
    res.writeHead(304, validators);
    res.end();
    return;
  }
  const encoding = sent === asset.gzip ? { 'Content-Encoding': 'gzip' } : {};
  res.writeHead(200, { ...validators, ...encoding, 'Content-Type': asset.type, 'Content-Length': sent.body.length });
  res.end(sent.body);
}
