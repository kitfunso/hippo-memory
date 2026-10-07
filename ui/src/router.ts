import { useSyncExternalStore } from "react";

/** Parsed hash route: the Health view (overview, project, drawer) or the Board. */
export type Route =
  | { view: "board" }
  | { view: "health"; projectKey: string | null; memoryId: string | null };

const OVERVIEW: Route = { view: "health", projectKey: null, memoryId: null };

/** Parses `#/`, `#/p/<key>`, `#/p/<key>/m/<id>` and `#/board`; anything else is the overview. */
export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter((p) => p !== "");
  if (parts[0] === "board" && parts.length === 1) return { view: "board" };
  if (parts[0] !== "p" || parts.length < 2) return OVERVIEW;
  try {
    const projectKey = decodeURIComponent(parts[1]);
    if (parts.length === 2) return { view: "health", projectKey, memoryId: null };
    if (parts.length === 4 && parts[2] === "m") {
      return { view: "health", projectKey, memoryId: decodeURIComponent(parts[3]) };
    }
  } catch {
    return OVERVIEW;
  }
  return OVERVIEW;
}

/** Builds the hash for a route; project keys and ids are always encoded. */
export function routeHash(route: Route): string {
  if (route.view === "board") return "#/board";
  if (route.projectKey === null) return "#/";
  const base = `#/p/${encodeURIComponent(route.projectKey)}`;
  return route.memoryId === null ? base : `${base}/m/${encodeURIComponent(route.memoryId)}`;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("hashchange", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("hashchange", listener);
  };
}

/** Moves to `route`; `replace` swaps the history entry so Back skips it. */
export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const hash = routeHash(route);
  if (window.location.hash === hash || (hash === "#/" && window.location.hash === "")) return;
  if (opts.replace) {
    window.history.replaceState(null, "", hash);
    listeners.forEach((l) => l());
  } else {
    window.location.hash = hash;
  }
}

/** The overview route, for links and for the dead-link redirect. */
export const OVERVIEW_ROUTE: Route = OVERVIEW;

/** Re-renders on every hash change and returns the parsed route (stable between changes). */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => "");
  return parseHashCached(hash);
}

let cachedHash: string | null = null;
let cachedRoute: Route = OVERVIEW;

function parseHashCached(hash: string): Route {
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parseHash(hash);
  }
  return cachedRoute;
}
