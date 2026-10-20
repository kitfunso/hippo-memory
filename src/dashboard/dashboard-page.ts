// The dashboard's pages: the React app and its assets, the not-built page, and the step off the token URL.
import { createHash } from 'crypto';
import type * as http from 'http';
import * as path from 'path';
import type { DashboardRouteRequest } from '../server/dashboard-types.js';
import { serveStaticFile, staticFileUnder } from './static-file.js';

// One style block, not style attributes, so the policy below can name its hash and allow no other inline style.
const NOT_BUILT_CSS =
  "body{font-family:Georgia,'Palatino Linotype',serif;max-width:640px;margin:60px auto;padding:24px;line-height:1.6;" +
  'background:#f4efe6;color:#3a3228}' +
  'h1{color:#c45c3c}' +
  'pre{background:#faf7f2;padding:16px;border:1px solid #c4b9a8;border-radius:3px;font-family:Consolas,monospace}';

// Memory text is written by other tools and people, so every reply tells the browser to load code only from this server
// and never to frame, sniff or name the page elsewhere.
export const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'sha256-${createHash('sha256').update(NOT_BUILT_CSS).digest('base64')}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
} as const;

function notBuilt(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html lang="en"><head><title>Hippo Dashboard</title><meta charset="utf-8"><style>${NOT_BUILT_CSS}</style></head>
<body>
<h1>Hippo Dashboard</h1>
<p>The React UI bundle is not built yet. Run:</p>
<pre>cd ui && npm install && npm run build</pre>
<p>Then refresh this page. The dashboard server will serve <code>dist-ui/index.html</code> automatically once
present.</p>
</body></html>`);
}

/**
 * Moves the browser off the URL that carries the token, so the token stays out of history, bookmarks and copied links.
 */
function leaveTokenUrl(res: http.ServerResponse, pathname: string, query: URLSearchParams): void {
  const rest = new URLSearchParams(query);
  rest.delete('token');
  const text = rest.toString();
  // One leading slash only: `//host` would send the browser to another site.
  res.writeHead(303, { Location: `${pathname.replace(/^\/+/, '/')}${text ? `?${text}` : ''}` });
  res.end();
}

/** Any path outside the JSON API: an asset, else index.html, since the app routes in the browser. */
export async function pageRoute(r: DashboardRouteRequest, match: RegExpMatchArray): Promise<void> {
  const pathname = match[0];
  if (r.session === 'token') return leaveTokenUrl(r.res, pathname, r.query);
  const root = r.staticRoot;
  if (root === null) return notBuilt(r.res);
  const file = staticFileUnder(root, pathname);
  if (file !== null && serveStaticFile(r.res, file)) return;
  if (serveStaticFile(r.res, path.join(root, 'index.html'))) return;
  notBuilt(r.res);
}
