// The dashboard's static asset reply: the types it serves, and a read that fails for any reason but a missing file.
import * as fs from 'fs';
import type * as http from 'http';
import * as path from 'path';
import { sendJson } from '../util/http-util.js';
import { errorCode, errorFields, errorMessage, log } from '../util/log.js';

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
