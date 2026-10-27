// WORKER_OPS comes from the effect tables beside the port's signatures, and names exactly what hippo.db's store sets.
import { describe, expect, it } from 'vitest';
import { STORE_EFFECTS } from '../../src/base/ports/store.js';
import { WORKER_OPS } from '../../src/store/sqlite/worker-ops.js';
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
    expect(moved.sort()).toEqual([
      'embeddingIndex.open: read -> write',
      'sessions.loadSnapshot: read -> write',
      'vectors.nearestEntries: read -> pinned-read',
    ]);
  });

  it("names, group by group, exactly the methods hippo.db's store sets", () => {
    const store = new Map(Object.entries(sqliteStore(makeRoot('worker-ops', { init: false }))));
    for (const [group, places] of Object.entries(WORKER_OPS)) {
      if (group === 'base') continue;
      expect([group, Object.keys(store.get(group) ?? {}).sort()]).toEqual([group, Object.keys(places).sort()]);
    }
  });
});
