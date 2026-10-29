// WORKER_OPS comes from the effect tables beside the port's signatures, and names exactly what hippo.db's store sets.
import { describe, expect, it } from 'vitest';
import { STORE_EFFECTS } from '../../src/base/ports/store.js';
import { HIPPO_DB_OPS, WORKER_OPS } from '../../src/store/sqlite/runtime/worker-ops.js';
import { HIPPO_DB_EFFECTS } from '../../src/store/sqlite/hippo-db.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';

const placesOf = (table: Readonly<Record<string, string>>): [string, string][] =>
  Object.entries(table).sort(([a], [b]) => a.localeCompare(b));

describe('WORKER_OPS', () => {
  it('has the groups and methods of the effect tables, a write on the writer and a read on a reader', () => {
    expect(Object.keys(WORKER_OPS).sort()).toEqual(Object.keys(STORE_EFFECTS).sort());
    const moved: string[] = [];
    for (const [group, effects] of Object.entries(STORE_EFFECTS)) {
      const places = new Map(placesOf(new Map(Object.entries(WORKER_OPS)).get(group) ?? {}));
      expect([...places.keys()]).toEqual(placesOf(effects).map(([method]) => method));
      for (const [method, effect] of placesOf(effects)) {
        const place = places.get(method);
        if (place !== effect) moved.push(`${group}.${method}: ${effect} -> ${place}`);
      }
    }
    // The adapter's own placements, each with its reason in worker-ops.ts.
    expect(moved.sort()).toEqual(['embeddingIndex.open: read -> write', 'vectors.nearestEntries: read -> pinned-read']);
  });

  it("names, group by group, exactly the methods hippo.db's store sets", () => {
    const store = new Map(Object.entries(sqliteStore(makeRoot('worker-ops', { init: false }))));
    for (const [group, places] of Object.entries(WORKER_OPS)) {
      if (group === 'base') continue;
      expect([group, Object.keys(store.get(group) ?? {}).sort()]).toEqual([group, Object.keys(places).sort()]);
    }
  });

  it("places each method of hippo.db's local tier by its effect, repository by repository", () => {
    const local = sqliteStore(makeRoot('worker-ops', { init: false })).hippoDb;
    const methods = (repos: typeof HIPPO_DB_OPS | typeof local) =>
      Object.entries(repos).map(([repo, group]) => [repo, Object.keys(group).sort()]);
    expect(methods(HIPPO_DB_OPS)).toEqual(methods(local));
    const moved = Object.entries(HIPPO_DB_EFFECTS).flatMap(([repo, effects]) => {
      const places = new Map(placesOf(new Map(Object.entries(HIPPO_DB_OPS)).get(repo) ?? {}));
      return placesOf(effects)
        .filter(([method, effect]) => places.get(method) !== effect)
        .map(([method, effect]) => `hippoDb.${repo}.${method}: ${effect} -> ${places.get(method)}`);
    });
    // The adapter's own placement, with its reason in worker-ops.ts.
    expect(moved).toEqual(['hippoDb.sessions.loadSnapshot: read -> write']);
  });
});
