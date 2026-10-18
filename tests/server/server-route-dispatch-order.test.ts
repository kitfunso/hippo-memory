import { describe, expect, it } from 'vitest';
import { routeLookup } from '../../src/server/route-lookup.js';
import { routeLabel, routeMatches, V1_ROUTES } from '../../src/server/route-table.js';

const METHODS = ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'] as const;
const findV1Route = routeLookup(V1_ROUTES, routeMatches);

/** The dispatch before the literal-path Map: every row in table order, first match wins. */
function walkAllRows(method: string, path: string) {
  return V1_ROUTES.find((route) => routeMatches(route, method, path) !== null) ?? null;
}

/** A path the row serves, with each param or numeric id filled in. */
function samplePath(route: (typeof V1_ROUTES)[number]): string {
  return routeLabel(route).replace(/:[A-Za-z]+/g, '42');
}

describe('V1 route lookup', () => {
  it('picks the same row as the whole-table walk for every row, under every method', () => {
    for (const route of V1_ROUTES) {
      const path = samplePath(route);
      expect(findV1Route(route.method, path)?.route, `${route.method} ${path}`).toBe(route);
      for (const method of METHODS) {
        expect(findV1Route(method, path)?.route ?? null, `${method} ${path}`).toBe(walkAllRows(method, path));
      }
    }
  });

  it('lets a pattern row above a literal one keep the literal path, as the walk does', () => {
    const literal = V1_ROUTES.find((route) => 'path' in route && route.path === '/v1/predictions/stats')!;
    const pattern = {
      ...V1_ROUTES.find((route) => 'pattern' in route)!,
      method: 'GET',
      pattern: '/v1/predictions/:id',
    };
    const rows = [pattern, literal];
    expect(routeLookup(rows, routeMatches)('GET', '/v1/predictions/stats')?.route).toBe(pattern);
  });

  it('misses a path no row serves, as the walk does', () => {
    expect(findV1Route('GET', '/v1/nope')).toBeNull();
    expect(walkAllRows('GET', '/v1/nope')).toBeNull();
  });

  it('still throws 400 on a malformed escape in a pattern row, as the walk did', () => {
    expect(() => findV1Route('GET', '/v1/recall/drill/%E0%A4%A')).toThrow(/URI/);
    expect(() => walkAllRows('GET', '/v1/recall/drill/%E0%A4%A')).toThrow(/URI/);
  });
});
