import type { JsonValue } from '../util/json.js';
import { PUBLIC_ROUTES, V1_ROUTES, routeMatches } from './route-table.js';
import type { AddonRoute } from './types.js';

const PLAIN_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;

function isPlainV1Path(path: string): boolean {
  return path.startsWith('/v1/') && new URL(path, 'http://h').pathname === path
    && path.slice('/v1/'.length).split('/').every((segment) => PLAIN_SEGMENT_RE.test(segment));
}

// A plain path never holds a `%`, so matchPath cannot throw here.
function isCorePath(method: string, path: string): boolean {
  return PUBLIC_ROUTES.has(`${method} ${path}`) || V1_ROUTES.some((route) => routeMatches(route, method, path) !== null);
}

/** Boot-time check: an add-on path must be plain, unique and not one core serves, so no add-on shadows a core route or hides from dispatch. */
export function assertAddonRoutes(routes: readonly AddonRoute[]): void {
  const seen = new Set<string>();
  for (const { path } of routes) {
    if (!isPlainV1Path(path)) throw new Error(`add-on route '${path}' is not a plain /v1/ path (segments use A-Z a-z 0-9 . _ ~ -)`);
    if (seen.has(path)) throw new Error(`add-on route '${path}' is registered twice`);
    if (isCorePath('POST', path)) throw new Error(`add-on route '${path}' is already served by core`);
    seen.add(path);
  }
}

const PUBLIC_JSON_MAX_BYTES = 64 * 1024;

/** Boot-time check and serialization: a public path that a core GET route serves would open that route to anyone. */
export function assertPublicJson(publicJson: Readonly<Record<string, JsonValue>>): ReadonlyMap<string, string> {
  const bodies = new Map<string, string>();
  for (const [path, value] of Object.entries(publicJson)) {
    if (!isPlainV1Path(path)) throw new Error(`public JSON path '${path}' is not a plain /v1/ path (segments use A-Z a-z 0-9 . _ ~ -)`);
    if (isCorePath('GET', path)) throw new Error(`public JSON path '${path}' is already served by core`);
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error(`public JSON at '${path}' is not JSON`);
    if (Buffer.byteLength(text) > PUBLIC_JSON_MAX_BYTES) throw new Error(`public JSON at '${path}' is over 64 KiB`);
    bodies.set(path, text);
  }
  return bodies;
}
