import { render } from "@testing-library/react";
import { vi } from "vitest";
import { App } from "../App";
import { type Handler, json } from "./fixtures";
import type { MemoryRow } from "../types";
import { hippoRoutes, makeRow } from "./memories";

/** `m1`..`mN` rows with strength falling by id. */
export function makeRows(n: number): MemoryRow[] {
  return Array.from({ length: n }, (_, i) => makeRow(`m${i + 1}`, { strength: 0.9 - i * 0.01 }));
}

/** Stubs fetch with the hippo routes, points the hash at the project (or a memory in it) and renders the app. */
export function openHippo(rows: readonly MemoryRow[], opts: { memoryId?: string; extra?: Record<string, Handler>; snapshot?: () => number } = {}) {
  const routes = hippoRoutes(rows, opts.extra, opts.snapshot);
  vi.stubGlobal("fetch", routes.stub);
  const suffix = opts.memoryId ? `/m/${opts.memoryId}` : "";
  window.history.replaceState(null, "", `#/p/p%3Ahippo${suffix}`);
  return { ...routes, ...render(<App />) };
}

/** A route answering 200 with `make()` that records each request body and keepalive flag. */
export function counted<B>(make: () => B) {
  const seen: { body: string; keepalive: boolean }[] = [];
  const handler: Handler = (_url, init) => {
    seen.push({ body: String(init?.body ?? ""), keepalive: init?.keepalive === true });
    return json(make());
  };
  return { handler, seen };
}
