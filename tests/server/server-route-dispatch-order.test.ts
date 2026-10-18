import { describe, expect, it } from 'vitest';
import { routeLookup } from '../../src/server/route-lookup.js';
import { routeLabel, routeMatches, V1_ROUTES } from '../../src/server/route-table.js';
import type { Route } from '../../src/server/types.js';

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

/** What a lookup or a walk answers for a request: the row it picks, or the error it throws. */
function outcome(find: () => Route | null): Route | null | string {
  try {
    return find();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('V1 route lookup by method', () => {
  /** A lookup over the live table that records every row the matcher is asked about. */
  function recordingLookup() {
    const tested: Route[] = [];
    const find = routeLookup(V1_ROUTES, (route, method, path) => {
      tested.push(route);
      return routeMatches(route, method, path);
    });
    tested.length = 0;
    return { find, tested };
  }

  it('tests only the rows of the request method, for every row and every method', () => {
    const { find, tested } = recordingLookup();
    for (const route of V1_ROUTES) {
      for (const method of METHODS) {
        tested.length = 0;
        find(method, samplePath(route));
        expect(
          tested.filter((row) => row.method !== method),
          `${method} ${samplePath(route)}`,
        ).toEqual([]);
      }
    }
  });

  // A miss tests every row of the method, so a POST row in the record would be one tested for a GET.
  it('tests no POST row for a GET that no row serves, and fewer rows than the table holds', () => {
    const { find, tested } = recordingLookup();
    expect(find('GET', '/v1/nope/42')).toBeNull();
    expect(tested.length).toBeGreaterThan(0);
    expect(tested.some((row) => row.method === 'POST')).toBe(false);
    expect(tested.length).toBeLessThan(V1_ROUTES.length);
  });

  it('picks the first pattern row of the method for a GET on a pattern path', () => {
    const { find, tested } = recordingLookup();
    expect(find('GET', '/v1/recall/drill/42')?.route).toBe(
      V1_ROUTES.find((row) => routeLabel(row) === '/v1/recall/drill/:id'),
    );
    expect(tested.some((row) => row.method === 'POST')).toBe(false);
  });

  it('tests no row at all for a method the table has none of', () => {
    const { find, tested } = recordingLookup();
    expect(find('BREW', '/v1/recall/drill/42')).toBeNull();
    expect(tested).toEqual([]);
  });

  it('answers a malformed escape as the walk does, under every method', () => {
    const paths = [
      '/v1/recall/drill/%E0%A4%A', // a pattern row's param: 400
      '/v1/memories/%E0%A4%A/archive',
      '/v1/nope/%E0%A4%A', // no row has this shape: 404
      '/v1/memories%E0',
      '/v1/recall/drill/a%20b', // a well-formed escape decodes and matches
    ];
    for (const path of paths) {
      for (const method of [...METHODS, 'BREW']) {
        const looked = outcome(() => findV1Route(method, path)?.route ?? null);
        expect(looked, `${method} ${path}`).toEqual(outcome(() => walkAllRows(method, path)));
      }
    }
    expect(outcome(() => findV1Route('DELETE', '/v1/memories/%E0%A4%A/archive')?.route ?? null)).toMatch(/URI/);
    expect(outcome(() => findV1Route('GET', '/v1/nope/%E0%A4%A')?.route ?? null)).toBeNull();
  });
});
