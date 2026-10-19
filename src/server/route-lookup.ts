import type { Route, RouteRequest } from './types.js';
import { tryDecodeUri } from '../util/expected-errors.js';

/** A route's run for one request, bound to the path's params, or null when method or path differ. */
export type RouteMatcher = (route: Route, method: string, path: string) => ((r: RouteRequest) => Promise<void>) | null;

/** A route chosen for one request, with its run bound to the path's params. */
export interface RouteMatch {
  readonly route: Route;
  readonly run: (r: RouteRequest) => Promise<void>;
}

/** Finds the first row whose method and path match a request. */
export type RouteLookup = (method: string, path: string) => RouteMatch | null;

function firstMatch(rows: readonly Route[], matches: RouteMatcher, method: string, path: string): RouteMatch | null {
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
export function routeLookup(rows: readonly Route[], matches: RouteMatcher): RouteLookup {
  // A literal key holds the row the whole-table walk picks, so a pattern row above a literal one still wins.
  const literal: ReadonlyMap<string, Route> = new Map(
    rows.flatMap((row): [string, Route][] => {
      if (!('path' in row)) return [];
      return [[`${row.method} ${row.path}`, firstMatch(rows, matches, row.method, row.path)!.route]];
    }),
  );
  const walked = rows.filter((row) => !('path' in row));
  const walkedByMethod = new Map<string, Route[]>();
  for (const row of walked) walkedByMethod.set(row.method, [...(walkedByMethod.get(row.method) ?? []), row]);
  return (method, path) => {
    const route = literal.get(`${method} ${path}`);
    if (route !== undefined) return { route, run: matches(route, method, path)! };
    return firstMatch(hasMalformedEscape(path) ? walked : (walkedByMethod.get(method) ?? []), matches, method, path);
  };
}
