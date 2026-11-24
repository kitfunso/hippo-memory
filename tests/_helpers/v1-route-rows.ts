import { routeLabel, V1_ROUTES } from '../../src/surface/server/route-table.js';

/** Every live V1_ROUTES row as `METHOD label` (a pattern row reads without its param types), in dispatch order. */
export const V1_ROWS = V1_ROUTES.map((route) => ({ key: `${route.method} ${routeLabel(route)}`, route }));

/** A row key under one of the seven typed-object kinds' paths. */
export const OBJECT_ROW =
  /^\S+ \/v1\/(decisions|incidents|processes|policies|skills|project-briefs|customer-notes)(\/|$)/;

/** POST rows that only read, so they stay at the viewer level. */
export const READ_POSTS: ReadonlySet<string> = new Set(['POST /v1/vectors/nearest']);

/** Writes a viewer may make because they only lower access: a resolver caller revokes only the keys it minted. */
export const VIEWER_WRITES: ReadonlySet<string> = new Set(['DELETE /v1/auth/keys/:keyId']);

/** The keys of viewer-level rows that write: not a GET, not a known read POST, not a known lowering write. */
export function viewerWriteRows(rows: readonly { key: string; route: { method: string; auth: string } }[]): string[] {
  return rows
    .filter(
      ({ key, route }) =>
        route.auth === 'viewer' && route.method !== 'GET' && !READ_POSTS.has(key) && !VIEWER_WRITES.has(key),
    )
    .map(({ key }) => key);
}

export const ADMIN_LEVEL = new Map([
  ['POST /v1/sleep', 'host-admin-local'],
  ['POST /v1/auth/keys', 'admin'],
  ['POST /v1/auth/keys/:keyId/grants', 'admin'],
  ['DELETE /v1/auth/keys/:keyId/grants', 'admin'],
  ['GET /v1/quarantine', 'admin'],
  ['POST /v1/quarantine/:id/approve', 'admin'],
  ['POST /v1/quarantine/:id/reject', 'admin'],
  ['POST /v1/quarantine/:id/edit', 'admin'],
  ['GET /v1/audit', 'admin'],
]);
