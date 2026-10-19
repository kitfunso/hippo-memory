import type { Route, RouteRequest } from './types.js';
import { tryDecodeUri } from '../util/expected-errors.js';

/** What the lookup reads of a row: its method, and an exact path when it has one. The /v1 and dashboard tables both
 * fit. */
type LookupRow = { readonly method: string } & (
  | { readonly path: string }
  | { readonly pattern: string }
  | { readonly regex: RegExp }
);

/** A route's run for one request, bound to the path's params, or null when method or path differ. */
export type RouteMatcher<T = Route, Q = RouteRequest> = (
  route: T,
  method: string,
  path: string,
) => ((r: Q) => Promise<void>) | null;

/** A route chosen for one request, with its run bound to the path's params. */
export interface RouteMatch<T = Route, Q = RouteRequest> {
  readonly route: T;
  readonly run: (r: Q) => Promise<void>;
}

/** Finds the first row whose method and path match a request. */
export type RouteLookup<T = Route, Q = RouteRequest> = (method: string, path: string) => RouteMatch<T, Q> | null;

function exactPath(row: LookupRow): string | undefined {
  return 'path' in row ? row.path : undefined;
}

function firstMatch<T, Q>(
  rows: readonly T[],
  matches: RouteMatcher<T, Q>,
  method: string,
  path: string,
): RouteMatch<T, Q> | null {
  for (const route of rows) {
    const run = matches(route, method, path);
    if (run !== null) return { route, run };
  }
  return null;
}

/** Whether a `%` escape in the path fails to decode, which is what makes a pattern row's path matcher throw. */
function hasMalformedEscape(path: string): boolean {
  if (!path.includes('%')) return false;
  return tryDecodeUri(path) === undefined;
}

/** First-match lookup: a literal path is one Map read, any other tests only its own method's pattern and regex rows in
 * table order; a malformed escape keeps the walk over every method, since the matcher throws on any of them. */
export function routeLookup<T extends LookupRow = Route, Q = RouteRequest>(
  rows: readonly T[],
  matches: RouteMatcher<T, Q>,
): RouteLookup<T, Q> {
  // A literal key holds the row the whole-table walk picks, so a pattern row above a literal one still wins.
  const literal: ReadonlyMap<string, T> = new Map(
    rows.flatMap((row): [string, T][] => {
      const path = exactPath(row);
      if (path === undefined) return [];
      return [[`${row.method} ${path}`, firstMatch(rows, matches, row.method, path)!.route]];
    }),
  );
  const walked = rows.filter((row) => exactPath(row) === undefined);
  const walkedByMethod = new Map<string, T[]>();
  for (const row of walked) walkedByMethod.set(row.method, [...(walkedByMethod.get(row.method) ?? []), row]);
  return (method, path) => {
    const route = literal.get(`${method} ${path}`);
    if (route !== undefined) return { route, run: matches(route, method, path)! };
    return firstMatch(hasMalformedEscape(path) ? walked : (walkedByMethod.get(method) ?? []), matches, method, path);
  };
}
