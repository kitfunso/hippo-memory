// The dashboard's static files: the one rule that maps a URL path into the built app's folder, and the asset reply.
import * as fs from 'fs';
import type * as http from 'http';
import * as path from 'path';
import { PACKAGE_ROOT } from '../../base/config/package-root.js';
import { HttpError, sendJson } from '../../base/util/http-util.js';
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

// A relative path, not a prefix test: a sibling folder whose name starts with the root's is outside it.
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

const OUTSIDE = 'path is outside the dashboard files';
// EINVAL is a name the file system cannot hold, such as a drive letter mid-path on Windows.
const NO_SUCH_FILE = new Set(['ENOENT', 'ENOTDIR', 'EINVAL']);

/** The file a URL path names under `root`, or null when there is none; a path that leaves `root`, by `..`, an encoded
 * `..` or a link, is a 403. */
export function staticFileUnder(root: string, urlPath: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(urlPath);
  } catch (err) {
    if (err instanceof URIError) throw new HttpError(400, 'Malformed URL path');
    throw err;
  }
  if (name.includes('\0')) throw new HttpError(400, 'Malformed URL path');
  const target = path.join(root, name);
  if (!isInside(root, target)) throw new HttpError(403, OUTSIDE);
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch (err) {
    if (NO_SUCH_FILE.has(errorCode(err))) return null;
    throw err;
  }
  if (!isInside(fs.realpathSync(root), real)) throw new HttpError(403, OUTSIDE);
  return fs.statSync(real).isFile() ? real : null;
}

/** True once the reply is sent, the file or a 500 for one that exists but will not read; false when there is no such
 * asset, so the next route answers. */
export function serveStaticFile(res: http.ServerResponse, filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (!isStaticFileExtension(ext)) return false;
  let content: Buffer;
  try {
    content = fs.readFileSync(filePath);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    log.error(`dashboard: reading ${filePath} failed (${errorCode(err) || errorMessage(err)})`, errorFields(err));
    sendJson(res, 500, { error: 'Internal error' });
    return true;
  }
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] });
  res.end(content);
  return true;
}
